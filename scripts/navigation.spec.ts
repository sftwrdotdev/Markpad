import assert from 'node:assert/strict';
import { afterAll, beforeAll, describe, test } from 'vitest';

import { anchorScrollTop, previewZoomFactor, PREVIEW_ANCHOR_OFFSET } from '../src/lib/utils/previewAnchor.js';

// Importing the store boots the settings singleton, which asks for the OS type,
// so a backend answering it has to be in place before the imports below. Each
// describe installs its own backend in `beforeAll`.
(window as any).__TAURI_INTERNALS__ = {
	metadata: { currentWindow: { label: 'main' }, currentWebview: { windowLabel: 'main', label: 'main' } },
	invoke: (cmd: string) => Promise.resolve(cmd === 'get_os_type' ? 'macos' : null),
};

const { tabManager } = await import('../src/lib/stores/tabs.svelte.js');
const { createDocumentSession } = await import('../src/lib/sessions/documentSession.svelte.js');
const { snapshotTab, buildTransferredTab, validateTransferPayload } = await import('../src/lib/utils/tabTransfer.js');
const { processMarkdownHtml } = await import('../src/lib/utils/markdown.js');
const {
	findAnchorElement,
	parseSourceposLineRange,
	restorePreviewReadingPosition,
	getAnchorScrollTop,
	getSourceLineAtPreviewOffset,
} = await import('../src/lib/utils/previewAnchor.js');
const {
	asRendererLine,
	lineCoordinates,
	asBufferLine,
	editorTopLineForTabAnchor,
	tabAnchorForEditorTopLine,
	EDITOR_ANCHOR_LINE_OFFSET,
} = await import('../src/lib/utils/lineCoordinates.js');

describe('anchor jump under zoom', () => {
	/*
	 * #621: "Custom viewport zoom bogusly offsets anchor jumps (in preview mode)".
	 * At 150% a link scrolled past its heading, at 50% it stopped short, and at
	 * 100% it was right.
	 *
	 * The preview sets CSS `zoom` on `.markdown-container`, an ANCESTOR of the
	 * scrolling element. `getBoundingClientRect()` reports viewport pixels, which
	 * carry that zoom; `scrollTop` counts the scroller's own pixels, which do not.
	 * Both call sites added one straight to the other, so the error was exactly the
	 * zoom factor — invisible at 100%, and the wrong sign on either side of it.
	 *
	 * jsdom has no layout, so the elements here are stand-ins that report the
	 * geometry a browser would at a given zoom: a rect scaled by the factor, and an
	 * `offsetWidth` that is not. That is the whole relationship under test.
	 */

	/** An element whose rect is `zoom`× its layout box, as a zoomed ancestor makes it. */
	function zoomedElement(layoutTop: number, layoutWidth: number, zoom: number) {
		return {
			offsetWidth: layoutWidth,
			getBoundingClientRect: () => ({ top: layoutTop * zoom, width: layoutWidth * zoom }),
		} as unknown as HTMLElement;
	}

	function scroller(zoom: number, scrollTop: number) {
		const el = zoomedElement(0, 800, zoom) as unknown as { scrollTop: number };
		el.scrollTop = scrollTop;
		return el as unknown as HTMLElement;
	}

	test('the zoom factor is measured off the container, not read from settings', () => {
		assert.equal(previewZoomFactor(scroller(1, 0)), 1);
		assert.equal(previewZoomFactor(scroller(1.5, 0)), 1.5);
		assert.equal(previewZoomFactor(scroller(0.5, 0)), 0.5);
	});

	test('a container with no layout reports 1 rather than a division by zero', () => {
		const detached = {
			offsetWidth: 0,
			scrollTop: 0,
			getBoundingClientRect: () => ({ top: 0, width: 0 }),
		} as unknown as HTMLElement;
		assert.equal(previewZoomFactor(detached), 1);
		assert.ok(Number.isFinite(anchorScrollTop(detached, detached)));
	});

	test('an anchor lands the same distance down the document at every zoom', () => {
		// The heading sits 1000 layout pixels below the top of the scroller, which
		// is already scrolled to 200. Wherever the zoom is, the answer is the same
		// number of the scroller's own pixels.
		const expected = 200 + 1000 - PREVIEW_ANCHOR_OFFSET;

		for (const zoom of [0.5, 1, 1.5, 2]) {
			const container = scroller(zoom, 200);
			const heading = zoomedElement(1000, 400, zoom);
			assert.equal(
				anchorScrollTop(container, heading),
				expected,
				`zoom ${zoom} must land at ${expected}`,
			);
		}
	});

	test('the pre-fix arithmetic is what overshot, and by exactly the zoom factor', () => {
		// Kept as the shape of the defect: rect delta added straight to scrollTop.
		// It is only correct at 100%, which is why the bug went unseen — and the
		// error is the factor itself, matching the report's "way past" at 150% and
		// "way before" at 50%.
		const preFix = (container: HTMLElement, el: HTMLElement) =>
			el.getBoundingClientRect().top -
			container.getBoundingClientRect().top +
			container.scrollTop -
			PREVIEW_ANCHOR_OFFSET;

		const correct = 200 + 1000 - PREVIEW_ANCHOR_OFFSET;

		for (const [zoom, sign] of [
			[1.5, 'past'],
			[0.5, 'short'],
		] as const) {
			const container = scroller(zoom, 200);
			const heading = zoomedElement(1000, 400, zoom);
			const old = preFix(container, heading);
			assert.notEqual(old, correct, `at zoom ${zoom} the old form must be wrong (${sign})`);
			// The whole error is the un-divided delta.
			assert.equal(old - correct, 1000 * zoom - 1000);
			assert.equal(anchorScrollTop(container, heading), correct);
		}

		// …and identical at 100%, which is why nobody saw it.
		const container = scroller(1, 200);
		const heading = zoomedElement(1000, 400, 1);
		assert.equal(preFix(container, heading), anchorScrollTop(container, heading));
	});
});

// A tab's `history` is a list of PATHS: `goBack` and `goForward` hand an entry
// back to the caller, which re-opens the file it names. An untitled buffer has
// no path and no file, so it is not a place the reader can return to — by the
// time Back could run, `forgetPreviousDocument` and the load that follows have
// already replaced the text that was in it.
//
// It used to get an entry regardless, from two directions: `addNewTab` seeded
// the history with the new tab's (empty) CONTENT, and `navigateFileHistory`
// synthesised `[currentPath]` for a tab whose history was empty. Either way the
// tab ended up at index 1 of `['', '/some/file.md']`, `canGoBack` reported true
// and lit the button, and `goBack` then rejected the `''` it got as falsy and
// returned null without even moving the index — a Back button that stayed
// enabled and did nothing for the rest of the tab's life.
//
// These tests drive the real TabManager: they assert behaviour, not wording.
describe('tab file history', () => {
	beforeAll(() => {
		// The runes are the compiler's, not ours: vitest builds `.svelte.ts` through the
		// Svelte plugin. Only the things jsdom genuinely does not have are stubbed.
		(window as any).__TAURI_INTERNALS__ = {
			metadata: { currentWindow: { label: 'main' }, currentWebview: { windowLabel: 'main', label: 'main' } },
			invoke: (cmd: string) => Promise.resolve(cmd === 'get_os_type' ? 'macos' : null),
		};
	});

	afterAll(() => {
		// One store for the whole file: leave it empty for the next describe.
		tabManager.closeAll();
		tabManager.recentlyClosed.length = 0;
		localStorage.clear();
	});

	function reset() {
		tabManager.closeAll();
		tabManager.recentlyClosed.length = 0;
		localStorage.clear();
	}

	function tabWith(id: string) {
		return tabManager.tabs.find((tab) => tab.id === id)!;
	}

	test('a new tab carries no history entry until it points at a file', () => {
		reset();
		tabManager.addNewTab();

		assert.deepEqual(tabWith(tabManager.activeTabId!).history, []);
	});

	test('following a link out of an untitled tab does not light a Back button that cannot work', () => {
		reset();
		tabManager.addNewTab();
		const id = tabManager.activeTabId!;

		tabManager.navigate(id, '/notes/a.md');

		assert.deepEqual(tabWith(id).history, ['/notes/a.md']);
		assert.equal(tabManager.canGoBack(id), false);
		assert.equal(tabManager.goBack(id), null);
	});

	test('a tab that gave up its path to another does not keep a dead entry either', () => {
		reset();
		tabManager.addTab('/notes/target.md', 'target text');
		const resident = tabManager.activeTabId!;
		// Only a DIRTY tab survives losing its path — a clean one is closed.
		tabManager.updateTabRawContent(resident, 'work in progress');
		tabManager.addTab('/notes/from.md', 'from text');
		tabManager.navigate(tabManager.activeTabId!, '/notes/target.md');
		assert.equal(tabWith(resident).path, '', 'the dirty loser is now untitled');

		tabManager.navigate(resident, '/notes/b.md');

		assert.deepEqual(tabWith(resident).history, ['/notes/b.md']);
		assert.equal(tabManager.canGoBack(resident), false);
	});

	test('back and forward still walk a tab that has actually been somewhere', () => {
		reset();
		tabManager.addTab('/notes/a.md', 'a');
		const id = tabManager.activeTabId!;

		tabManager.navigate(id, '/notes/b.md');

		assert.deepEqual(tabWith(id).history, ['/notes/a.md', '/notes/b.md']);
		assert.equal(tabManager.canGoBack(id), true);
		assert.equal(tabManager.goBack(id), '/notes/a.md');
		assert.equal(tabManager.canGoForward(id), true);
		assert.equal(tabManager.goForward(id), '/notes/b.md');
	});

	// Save As is the other way an untitled tab acquires a path, and it must not
	// leave a second entry behind either: the buffer did not move to another
	// document, it just gained a name for the one it already held.
	test('naming an untitled buffer replaces its entry rather than appending one', () => {
		reset();
		tabManager.addNewTab();
		const id = tabManager.activeTabId!;

		tabManager.updateTabPath(id, '/notes/saved.md');

		assert.deepEqual(tabWith(id).history, ['/notes/saved.md']);
		assert.equal(tabManager.canGoBack(id), false);
	});
});

// A link opened in a new tab leaves the tab it was clicked in as it was. #1007
// routed it through `loadMarkdown`'s ordinary open path, which clears the
// in-page jump stacks of the ACTIVE tab before picking a tab, and at that point
// the active tab is still the one the user is leaving.
describe('a new-tab link keeps scroll history', () => {
	beforeAll(() => {
		(window as any).__TAURI_INTERNALS__ = {
			metadata: { currentWindow: { label: 'main' }, currentWebview: { windowLabel: 'main', label: 'main' } },
			invoke: (cmd: string) => {
				if (cmd === 'open_markdown_preview') return Promise.resolve(['# B\n', true, false]);
				if (cmd === 'read_file_content_checked') return Promise.resolve(['# B\n', false]);
				if (cmd === 'get_os_type') return Promise.resolve('macos');
				return Promise.resolve(null);
			},
		};
	});

	afterAll(() => {
		// One store for the whole file: leave it empty for the next describe.
		tabManager.closeAll();
		tabManager.recentlyClosed.length = 0;
		localStorage.clear();
	});

	// What openMarkdownTargetInNewTab passes (pinned in reopenDirtyDocument.spec.ts).
	const newTabOptions = { inNewTab: true };

	function makeSession() {
		return createDocumentSession({
			setShowHome: () => {},
			currentFile: () => tabManager.activeTab?.path ?? '',
			// As MarkdownViewer wires it.
			resetScrollHistory: () => {
				if (tabManager.activeTabId) tabManager.clearScrollHistory(tabManager.activeTabId);
			},
			renderMarkdown: async (raw: string) => raw,
			afterLoad: async () => {},
			saveRecentFile: () => {},
			deleteRecentFile: () => {},
			setLoadingTabs: () => {},
			measureInitialViewport: () => {},
			isScrolling: () => false,
			onError: () => {},
			onDiskChangedUnderSave: () => {},
			cancelPendingAutoSave: () => {},
			askClose: async () => 'discard' as const,
			onCloseSaveNewerEdits: () => {},
			onCloseAutoSaveFailed: () => {},
			onPartialCopySaved: () => {},
		});
	}

	const stackOf = (id: string) => tabManager.tabs.find((t) => t.id === id)!.scrollHistory;

	test('a link opened in a new tab keeps the source tab in-page back history', async () => {
		tabManager.closeAll();
		tabManager.addTab('/notes/a.md', '# A\n');
		const a = tabManager.activeTabId!;
		tabManager.pushScrollHistory(a, 1200);
		tabManager.pushScrollHistory(a, 3400);

		await makeSession().loadMarkdown('/notes/b.md', newTabOptions);

		assert.notEqual(tabManager.activeTabId, a, 'b.md opened in its own tab');
		assert.deepEqual(stackOf(a), [1200, 3400]);
	});

	test('a link to a file already open in another tab still activates that tab', async () => {
		tabManager.closeAll();
		tabManager.addTab('/notes/b.md', '# B\n');
		const b = tabManager.activeTabId!;
		tabManager.addTab('/notes/a.md', '# A\n');
		const a = tabManager.activeTabId!;
		tabManager.pushScrollHistory(a, 1200);

		await makeSession().loadMarkdown('/notes/b.md', newTabOptions);

		assert.equal(tabManager.activeTabId, b);
		assert.equal(tabManager.tabs.length, 2);
		assert.deepEqual(stackOf(a), [1200]);
	});
});

/**
 * The preview's in-page back/forward stacks belong to the document they were
 * measured in.
 *
 * They hold raw `markdownBody.scrollTop` pixels — where the reader was standing
 * before each anchor jump — and the viewer held ONE pair for the whole window.
 * Nothing emptied it on a tab switch, and a tab switch reloads nothing, so a
 * jump in a long document left an offset behind that the next mouse-back in
 * whatever tab the reader landed on would scroll to. A long document followed
 * by a short one is the visible case: the short one has no such offset to be
 * at, so it goes as far as it can and stops somewhere the reader has never
 * been. The only reset was `resetScrollHistory`, an option of `loadMarkdown`,
 * which fires for a document LOAD and not for a switch.
 *
 * These stacks are not `Tab.history`/`historyIndex`, which is the FILE the tab
 * points at and is what the mouse falls through to when there is no jump left
 * to undo. Both are exercised below, because the fall-through is the half a
 * per-tab stack changes: a tab with a stale offset never reached it.
 *
 * Everything here runs the REAL `TabManager` — the same `pushScrollHistory`,
 * `popScrollHistoryBack` and `popScrollHistoryForward` the viewer calls, the
 * real `navigate`/`goBack`/`goForward`, the real serialization and the real
 * cross-window snapshot. Nothing asserts on the text of an implementation file.
 *
 * WHAT IS NOT THE REAL THING, AND WHY. `handleMouseUp` lives in
 * MarkdownViewer.svelte and is not exported; `mouseButton` below is its three
 * lines, restated. What it stands in for is one `markdownBody.scrollTop` read —
 * jsdom has no layout, so the offsets here are supplied rather than measured,
 * which is also why this file asks "which offset comes back" and never "where
 * does the preview end up".
 */
describe('scroll history per tab', () => {
	beforeAll(() => {
		// The runes are the compiler's, not ours: vitest builds `.svelte.ts` through the
		// Svelte plugin. Only the Tauri backend is stubbed — importing the store boots
		// the settings singleton, which asks for the OS type.
		(window as any).__TAURI_INTERNALS__ = {
			metadata: { currentWindow: { label: 'main' }, currentWebview: { windowLabel: 'main', label: 'main' } },
			invoke: (cmd: string) => Promise.resolve(cmd === 'get_os_type' ? 'macos' : null),
		};
	});

	afterAll(() => {
		// One store for the whole file: leave it empty for the next describe.
		tabManager.closeAll();
		tabManager.recentlyClosed.length = 0;
		localStorage.clear();
	});

	// ------------------------------------------------------------------ the wiring

	type Direction = 'back' | 'forward';

	/**
	 * What the mouse's back and forward buttons do, as `handleMouseUp` wires them:
	 * pop the tab's in-page stack first, and move to another DOCUMENT only when
	 * that tab has no jump left to walk. `at` is where the reader is standing,
	 * which the viewer reads off the preview container.
	 */
	function mouseButton(direction: Direction, at: number): { scrolledTo: number } | { openedFile: string | null } {
		const id = tabManager.activeTabId!;
		const pos =
			direction === 'back'
				? tabManager.popScrollHistoryBack(id, at)
				: tabManager.popScrollHistoryForward(id, at);
		if (pos !== null) return { scrolledTo: pos };
		return { openedFile: direction === 'back' ? tabManager.goBack(id) : tabManager.goForward(id) };
	}

	/** An anchor jump: the reader was at `at`, and is about to be somewhere else. */
	function jumpFrom(at: number) {
		tabManager.pushScrollHistory(tabManager.activeTabId!, at);
	}

	function reset() {
		tabManager.closeAll();
		tabManager.recentlyClosed.length = 0;
	}

	const stackOf = (id: string) => tabManager.tabs.find((t) => t.id === id)!.scrollHistory;
	const futureOf = (id: string) => tabManager.tabs.find((t) => t.id === id)!.scrollFuture;

	/** A long document and a short one, a jump made in the long one, landing on the short. */
	function jumpInLongThenSwitchToShort() {
		reset();
		tabManager.addTab('/notes/long.md', '# Long\n');
		const long = tabManager.activeTabId!;
		tabManager.addTab('/notes/short.md', '# Short\n');
		const short = tabManager.activeTabId!;

		tabManager.setActive(long);
		jumpFrom(8400);

		tabManager.setActive(short);
		return { long, short };
	}

	// ------------------------------------------------- the switch the bug was about

	test('a back click in one document does not scroll to an offset measured in another', () => {
		const { short } = jumpInLongThenSwitchToShort();

		const result = mouseButton('back', 0);

		assert.deepEqual(stackOf(short), []);
		assert.ok(!('scrolledTo' in result), 'the short document has no jump of its own to go back to');
	});

	test('with no jump of its own, back moves the tab to the previous FILE instead', () => {
		reset();
		tabManager.addTab('/notes/long.md', '# Long\n');
		const long = tabManager.activeTabId!;
		jumpFrom(8400);

		tabManager.addTab('/notes/short.md', '# Short\n');
		const short = tabManager.activeTabId!;
		tabManager.navigate(short, '/notes/other.md');

		assert.deepEqual(mouseButton('back', 0), { openedFile: '/notes/short.md' });
		// ...and the tab that DID jump still has its own offset waiting.
		assert.deepEqual(stackOf(long), [8400]);
	});

	test('the offset is still there when the reader comes back to the document they jumped in', () => {
		const { long } = jumpInLongThenSwitchToShort();

		tabManager.setActive(long);

		assert.deepEqual(mouseButton('back', 200), { scrolledTo: 8400 });
	});

	test('forward is per tab too', () => {
		const { long, short } = jumpInLongThenSwitchToShort();

		tabManager.setActive(long);
		mouseButton('back', 200);
		assert.deepEqual(futureOf(long), [200]);

		tabManager.setActive(short);
		assert.deepEqual(futureOf(short), []);
		assert.ok(!('scrolledTo' in mouseButton('forward', 0)));
	});

	test('two tabs jumped in keep their own offsets, in their own order', () => {
		reset();
		tabManager.addTab('/notes/a.md', '# A\n');
		const a = tabManager.activeTabId!;
		jumpFrom(100);
		jumpFrom(200);

		tabManager.addTab('/notes/b.md', '# B\n');
		const b = tabManager.activeTabId!;
		jumpFrom(900);

		tabManager.setActive(a);
		assert.deepEqual(mouseButton('back', 250), { scrolledTo: 200 });
		assert.deepEqual(mouseButton('back', 200), { scrolledTo: 100 });

		tabManager.setActive(b);
		assert.deepEqual(mouseButton('back', 950), { scrolledTo: 900 });
	});

	test('an untitled buffer has a stack of its own', () => {
		reset();
		tabManager.addNewTab();
		const untitled = tabManager.activeTabId!;
		jumpFrom(300);

		tabManager.addTab('/notes/a.md', '# A\n');
		assert.deepEqual(stackOf(tabManager.activeTabId!), []);

		tabManager.setActive(untitled);
		assert.deepEqual(mouseButton('back', 400), { scrolledTo: 300 });
	});

	test('closing a tab takes its offsets with it', () => {
		reset();
		tabManager.addTab('/notes/a.md', '# A\n');
		const a = tabManager.activeTabId!;
		jumpFrom(500);
		tabManager.addTab('/notes/b.md', '# B\n');

		tabManager.closeTab(a);
		tabManager.addTab('/notes/a.md', '# A\n');

		assert.deepEqual(stackOf(tabManager.activeTabId!), []);
	});

	// ------------------------------------- repointing the tab at another document

	test('following a link drops the offsets of the document left behind', () => {
		reset();
		tabManager.addTab('/notes/a.md', '# A\n');
		const a = tabManager.activeTabId!;
		jumpFrom(4000);

		tabManager.navigate(a, '/notes/b.md');

		assert.deepEqual(stackOf(a), []);
		assert.ok(!('scrolledTo' in mouseButton('back', 0)));
	});

	test('going back to the previous file drops them', () => {
		reset();
		tabManager.addTab('/notes/a.md', '# A\n');
		const a = tabManager.activeTabId!;
		tabManager.navigate(a, '/notes/b.md');
		jumpFrom(4000);

		assert.equal(tabManager.goBack(a), '/notes/a.md');
		assert.deepEqual(stackOf(a), []);
	});

	test('going forward again drops them', () => {
		reset();
		tabManager.addTab('/notes/a.md', '# A\n');
		const a = tabManager.activeTabId!;
		tabManager.navigate(a, '/notes/b.md');
		tabManager.goBack(a);
		jumpFrom(4000);

		assert.equal(tabManager.goForward(a), '/notes/b.md');
		assert.deepEqual(stackOf(a), []);
	});

	test('the forward stack goes with them', () => {
		reset();
		tabManager.addTab('/notes/a.md', '# A\n');
		const a = tabManager.activeTabId!;
		jumpFrom(4000);
		mouseButton('back', 4200);
		assert.deepEqual(futureOf(a), [4200]);

		tabManager.navigate(a, '/notes/b.md');

		assert.deepEqual(futureOf(a), []);
	});

	test('Save As keeps them, because the document on screen has not changed', () => {
		reset();
		tabManager.addTab('/notes/a.md', '# A\n');
		const a = tabManager.activeTabId!;
		jumpFrom(4000);

		tabManager.updateTabPath(a, '/notes/copy.md');

		assert.deepEqual(mouseButton('back', 4200), { scrolledTo: 4000 });
	});

	test('a reload in place drops them, because the text they were measured in is gone', () => {
		reset();
		tabManager.addTab('/notes/a.md', '# A\n');
		const a = tabManager.activeTabId!;
		jumpFrom(4000);

		tabManager.clearScrollHistory(a);

		assert.deepEqual(stackOf(a), []);
		assert.deepEqual(futureOf(a), []);
	});

	// -------------------------------------------------------------- the stack itself

	test('a new jump abandons the forward stack, as every history does', () => {
		reset();
		tabManager.addTab('/notes/a.md', '# A\n');
		const a = tabManager.activeTabId!;
		jumpFrom(100);
		mouseButton('back', 500);
		assert.deepEqual(futureOf(a), [500]);

		jumpFrom(700);

		assert.deepEqual(futureOf(a), []);
	});

	test('back and forward walk the same offsets in both directions', () => {
		reset();
		tabManager.addTab('/notes/a.md', '# A\n');
		jumpFrom(100);
		jumpFrom(400);

		assert.deepEqual(mouseButton('back', 900), { scrolledTo: 400 });
		assert.deepEqual(mouseButton('back', 400), { scrolledTo: 100 });
		assert.deepEqual(mouseButton('forward', 100), { scrolledTo: 400 });
		assert.deepEqual(mouseButton('forward', 400), { scrolledTo: 900 });
	});

	test('a tab remembers the last fifty jumps and drops the oldest', () => {
		reset();
		tabManager.addTab('/notes/a.md', '# A\n');
		const a = tabManager.activeTabId!;
		for (let i = 1; i <= 55; i += 1) jumpFrom(i);

		assert.equal(stackOf(a).length, 50);
		assert.equal(stackOf(a)[0], 6);
		assert.equal(stackOf(a)[49], 55);
	});

	// ------------------------------------------------ what deliberately does not travel

	test('a restored window opens with no offsets to walk', () => {
		reset();
		tabManager.addTab('/notes/a.md', '# A\n');
		jumpFrom(4000);
		const saved = tabManager.serializeState();

		reset();
		tabManager.restoreState(saved);

		const restored = tabManager.tabs.find((t) => t.path === '/notes/a.md')!;
		assert.deepEqual(restored.scrollHistory, []);
		assert.deepEqual(restored.scrollFuture, []);
	});

	test('a tab moved to another window arrives with none either', () => {
		reset();
		tabManager.addTab('/notes/a.md', '# A\n');
		const a = tabManager.activeTabId!;
		jumpFrom(4000);

		const arrived = buildTransferredTab(
			snapshotTab(tabManager.tabs.find((t) => t.id === a)!),
			[],
			'Untitled',
		);

		assert.deepEqual(arrived.scrollHistory, []);
		assert.deepEqual(arrived.scrollFuture, []);
	});
});

/**
 * A tab that is pointed at a different document must forget where the reader
 * was in the old one.
 *
 * `Tab` records the reading position four times, and both restore paths are
 * fallback cascades that stop at the first entry that resolves: the preview
 * tries `anchorLine`, then `scrollPercentage`, then `scrollTop`
 * (`MarkdownViewer.svelte:1133-1162`), and the editor tries `editorViewState`,
 * then `anchorLine`, then `scrollPercentage` (`components/Editor.svelte:290-311`).
 *
 * `navigate()` used to end with `tab.scrollTop = 0` and nothing else, which is
 * the entry each cascade consults LAST. For any tab that had actually been
 * scrolled, that reset was unreachable, and the next activation of the tab
 * restored the previous document's position into the new document. `goBack` and
 * `goForward` repoint a tab the same way and cleared nothing at all.
 *
 * Two things are checked here, and neither reads an implementation file as text:
 *
 *   - the REAL `TabManager`, driven through every route that changes which
 *     document a tab shows and every route that changes only its path;
 *   - the REAL `findAnchorElement` over the REAL `processMarkdownHtml` output of
 *     two DIFFERENT documents, which is what turns "the field is stale" into a
 *     rate: how often a line number carried over from document A resolves to
 *     some unrelated block of document B, so the cascade stops there and the
 *     later entries are never consulted.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS A `.spec.ts`
 *
 * It used to call `installShimDom()` from `renderProtocolDom.ts` and hand-write
 * the runes onto `globalThis`. Both are stand-ins, and under vitest both are
 * worse than what the environment already has: the shim ASSIGNS
 * `globalThis.document`, so it would replace jsdom's, and a hand-written
 * `$state` is not the compiler's — no deep proxying, and `$effect` never
 * re-runs. Every one of them is gone. `TabManager` is built by the Svelte
 * compiler and the document is jsdom's, so `DOMParser`, the HTML parser it
 * feeds, and `processMarkdownHtml`'s own DOM surgery are all the real ones.
 *
 * WHAT THE REAL DOM DOES AND DOES NOT SETTLE
 *
 * `findAnchorElement` is a walk over `data-sourcepos` ranges, `classList` and
 * `childNodes` — structure and attributes, every one of which jsdom answers
 * for real. It never measures anything, so nothing below needs a layout.
 *
 * jsdom has no layout: `offsetTop`, `offsetHeight` and every rect are 0. So the
 * question of WHERE a resolved anchor lands — `getAnchorScrollTop`, the
 * offset->line mapping, a collapsed fold's zero height — cannot be asked here
 * and is not asked here. Those tests supply their own geometry on purpose
 * (`scrollSyncAcrossFolds.test.ts` lays the document out with folds in it,
 * `anchorJumpUnderZoom.spec.ts` builds elements whose rects carry a zoom
 * factor). "It resolves" is a real answer; "it lands at 1420px" would not be.
 */
describe('tab reading position', () => {
	beforeAll(() => {
		// The runes are the compiler's, not ours: vitest builds `.svelte.ts` through the
		// Svelte plugin. Only the Tauri backend, which jsdom cannot provide, is stubbed
		// — `get_os_type` because importing the store boots the settings singleton, and
		// a `null` answer to that one leaves the font defaults it indexes undefined.
		(window as any).__TAURI_INTERNALS__ = {
			metadata: { currentWindow: { label: 'main' }, currentWebview: { windowLabel: 'main', label: 'main' } },
			invoke: (cmd: string) => Promise.resolve(cmd === 'get_os_type' ? 'macos' : null),
		};
	});

	afterAll(() => {
		// One store for the whole file: leave it empty for the next describe.
		tabManager.closeAll();
		tabManager.recentlyClosed.length = 0;
		localStorage.clear();
	});

	type AnchorNode = Parameters<typeof findAnchorElement>[0];
	type AnchorBox = ReturnType<Parameters<typeof restorePreviewReadingPosition>[3]>;

	type Tab = (typeof tabManager.tabs)[number];

	function reset() {
		tabManager.closeAll();
		tabManager.recentlyClosed.length = 0;
		localStorage.clear();
	}

	/** A tab whose reader is a long way down a document, all four fields written. */
	function openScrolledTab(path: string): Tab {
		tabManager.addTab(path, '# doc\n');
		const tab = tabManager.tabs.find((item) => item.path === path)!;
		tab.scrollTop = 4820;
		tab.scrollPercentage = 0.73;
		tab.anchorLine = asRendererLine(812);
		tab.editorViewState = { cursorState: 'monaco-live-object' };
		return tab;
	}

	/** Every field either restore cascade reads, in the order it reads them. */
	function readingPosition(tab: Tab) {
		return {
			editorViewState: tab.editorViewState,
			anchorLine: tab.anchorLine,
			scrollPercentage: tab.scrollPercentage,
			scrollTop: tab.scrollTop,
		};
	}

	const AT_TOP = { editorViewState: null, anchorLine: 0, scrollPercentage: 0, scrollTop: 0 };

	// --------------------------------------------- the routes that change document

	test('following a link to another file leaves the tab at the top of it', () => {
		reset();
		const tab = openScrolledTab('/notes/a.md');

		tabManager.navigate(tab.id, '/notes/b.md');

		assert.equal(tab.path, '/notes/b.md');
		assert.deepEqual(readingPosition(tab), AT_TOP);
	});

	test('going back to the previous file leaves the tab at the top of it', () => {
		reset();
		const tab = openScrolledTab('/notes/a.md');
		tabManager.navigate(tab.id, '/notes/b.md');
		tab.anchorLine = asRendererLine(44);
		tab.scrollPercentage = 0.2;
		tab.scrollTop = 900;
		tab.editorViewState = { cursorState: 'monaco-live-object' };

		const back = tabManager.goBack(tab.id);

		assert.equal(back, '/notes/a.md');
		assert.equal(tab.path, '/notes/a.md');
		assert.deepEqual(readingPosition(tab), AT_TOP);
	});

	test('going forward again leaves the tab at the top of that file', () => {
		reset();
		const tab = openScrolledTab('/notes/a.md');
		tabManager.navigate(tab.id, '/notes/b.md');
		tabManager.goBack(tab.id);
		tab.anchorLine = asRendererLine(300);
		tab.scrollPercentage = 0.5;
		tab.scrollTop = 2000;
		tab.editorViewState = { cursorState: 'monaco-live-object' };

		const forward = tabManager.goForward(tab.id);

		assert.equal(forward, '/notes/b.md');
		assert.equal(tab.path, '/notes/b.md');
		assert.deepEqual(readingPosition(tab), AT_TOP);
	});

	// ------------------------------------- the routes that change only the path
	//
	// The document on screen does not change in either of these, so the reader has
	// not moved and the position must survive. This is the half of the rule a
	// blanket "clear on every path write" would break.

	test('Save As renames the tab without moving the reader', () => {
		reset();
		const tab = openScrolledTab('/notes/a.md');
		const before = readingPosition(tab);

		tabManager.updateTabPath(tab.id, '/notes/copy.md');

		assert.equal(tab.path, '/notes/copy.md');
		assert.deepEqual(readingPosition(tab), before);
	});

	test('a link that resolves to the file already open is not a navigation', () => {
		reset();
		const tab = openScrolledTab('/notes/a.md');
		const before = readingPosition(tab);

		tabManager.navigate(tab.id, '/notes/a.md');

		assert.deepEqual(readingPosition(tab), before);
	});

	/* ------------------------------------------------------------------ */
	/* what a carried-over anchor line does to the next document           */
	/* ------------------------------------------------------------------ */

	// comrak's shape, as recorded in renderProtocolFixtures.ts: every block carries
	// a `data-sourcepos` line range, and `processMarkdownHtml` then re-parents
	// everything after a heading into a wrapper that carries none.

	class DocumentBuilder {
		private line = 1;
		private readonly parts: string[] = [];
		readonly lines: number[] = [];

		heading(text: string, slug: string) {
			const line = this.line;
			this.line += 2;
			this.lines.push(line);
			this.parts.push(
				`<h2 data-sourcepos="${line}:1-${line}:${text.length + 3}">` +
					`<a href="#${slug}" aria-hidden="true" class="anchor" id="${slug}"></a>${text}</h2>`,
			);
		}

		paragraph(text: string) {
			const line = this.line;
			this.line += 2;
			this.lines.push(line);
			this.parts.push(`<p data-sourcepos="${line}:1-${line}:${text.length}">${text}</p>`);
		}

		html() {
			return this.parts.join('\n') + '\n';
		}
	}

	/**
	 * Two different documents. `paragraphsPerSection` is what makes them different
	 * documents rather than two renders of one: the same source line lands in a
	 * different section of each.
	 */
	function buildDocument(name: string, sections: number, paragraphsPerSection: number) {
		const doc = new DocumentBuilder();
		for (let s = 1; s <= sections; s += 1) {
			doc.heading(`${name} section ${s}`, `${name}-section-${s}`);
			for (let p = 1; p <= paragraphsPerSection; p += 1) {
				doc.paragraph(`${name} section ${s} paragraph ${p}, a sentence of prose.`);
			}
		}
		return doc;
	}

	const DOC_A = buildDocument('alpha', 60, 6);
	const DOC_B = buildDocument('beta', 40, 11);

	/**
	 * The rendered article, in the element the restore actually walks: the preview
	 * hands `findAnchorElement` its `.markdown-body` container
	 * (`MarkdownViewer.svelte:1223`), which is the element the sanitized string was
	 * parsed into.
	 */
	function render(doc: DocumentBuilder, path: string): HTMLElement {
		const body = document.createElement('div');
		body.className = 'markdown-body';
		body.innerHTML = processMarkdownHtml(doc.html(), path, new Set<string>());
		return body;
	}

	const BODY_B = render(DOC_B, '/notes/b.md');

	test('a line number carried over from the previous document resolves into this one', () => {
		// The fixture is the real pipeline's output, so say what it produced: a
		// document of nothing but headings and paragraphs is one where every block
		// after the first heading is inside a `.foldable-content-wrapper` that
		// carries no source range of its own, which is the shape the descent exists
		// for.
		const blocks = BODY_B.querySelectorAll('[data-sourcepos]').length;
		assert.equal(blocks, 40 + 40 * 11, 'every block of document B is annotated');
		assert.ok(
			BODY_B.querySelectorAll('.foldable-content-wrapper:not([data-sourcepos])').length > 0,
			'and the sections are wrapped in containers that are not',
		);

		// Every source line the reader could have been parked on in document A.
		const carried = DOC_A.lines;

		let resolved = 0;
		for (const line of carried) {
			if (findAnchorElement(BODY_B, line)) resolved += 1;
		}
		const percent = Math.round((resolved / carried.length) * 1000) / 10;

		// This is the mechanism, not a property of these two fixtures: while the
		// carried line is inside the other document's range it resolves, the first
		// cascade entry reports success, and `scrollPercentage` and `scrollTop` —
		// the field the old `navigate()` reset — are never consulted.
		assert.ok(
			percent > 50,
			`a stale anchor line is expected to resolve in a document of similar length, ` +
				`got ${resolved}/${carried.length} (${percent}%) over ${blocks} annotated blocks`,
		);

		// And it resolves to the wrong text: the block at that line in B, which
		// says `beta`, has nothing to do with the block the reader left in A.
		const sample = DOC_A.lines[Math.floor(DOC_A.lines.length / 2)];
		const match = findAnchorElement(BODY_B, sample);
		assert.ok(match, `expected line ${sample} to resolve inside document B`);
		assert.match(
			(match.element as Element).textContent ?? '',
			/beta/,
			`line ${sample} of document A resolves to a block of document B`,
		);
	});

	test('a cleared reading position resolves to nothing, so the cascade falls through to the top', () => {
		reset();
		const tab = openScrolledTab('/notes/a.md');
		tabManager.navigate(tab.id, '/notes/b.md');

		// Stage 1 of the preview cascade is guarded on `anchorLine > 0`, and
		// `findAnchorElement` refuses a non-positive line outright. Asserted as a
		// boolean: a returned match holds a live DOM node whose parent chain the
		// assertion printer would try to serialize.
		assert.ok(
			findAnchorElement(BODY_B, tab.anchorLine) === null,
			'a cleared anchorLine must not resolve to an element in the new document',
		);
		// Stage 2 is guarded on `scrollPercentage > 0`, so the cascade reaches
		// stage 3 — and stage 3 is the top of the document.
		assert.equal(tab.scrollPercentage, 0);
		assert.equal(tab.scrollTop, 0);
	});

	/* ------------------------------------------------------------------ */
	/* which numbering the anchor is in                                    */
	/* ------------------------------------------------------------------ */
	//
	// `anchorLine` is a RENDERER line. `getPreviewScrollAnchor` writes it off
	// `data-sourcepos` and the restore above reads it back with
	// `findAnchorElement` against the same attributes, and both of those count
	// from the first line of the BODY — while the editor's own line numbers count
	// from the first line of the FILE. In a document with front matter the two
	// differ by its height, and #607 made that difference a TYPE so that a
	// crossing which forgets to convert cannot compile.
	//
	// The brand has no run-time representation, so the assertion cannot be an
	// `assert`. It is the `@ts-expect-error` comments below, which invert into
	// exactly the failure wanted: if the brand is ever dropped, those lines start
	// compiling, and `npm run check` fails them as unused directives.

	/** Six buffer lines of YAML above the body, so the two numberings differ by 6. */
	const WITH_FRONT_MATTER = ['---', 'title: "T"', 'tags:', '  - a', '---', '', '# Title'].join('\n') + '\n';

	test('the tab anchor is a renderer line, and only converts one way round', () => {
		reset();
		const tab = openScrolledTab('/notes/a.md');
		const coords = lineCoordinates(WITH_FRONT_MATTER);

		// What the brand permits, and the conversion any caller aiming the EDITOR
		// with this field owes: line 812 of the body is line 818 of the buffer.
		assert.equal(coords.toBufferLine(tab.anchorLine), 818);
		assert.equal(coords.toRendererLine(coords.toBufferLine(tab.anchorLine)), 812);

		// What it forbids. First the crossing read backwards — treating the anchor
		// as if it were already on the editor's numbering, which is the shape a
		// caller reaches for when it does not know which side of the shift it is
		// on.
		// @ts-expect-error `Tab.anchorLine` is a RendererLine; `toRendererLine` wants a BufferLine
		coords.toRendererLine(tab.anchorLine);

		// Then the write. This one is last because it does go through at run time:
		// a Monaco line stored as the reading position, which is what sends the
		// preview restore the height of the front matter too far down the
		// document. Before the brand it compiled.
		// @ts-expect-error a BufferLine is not assignable to `Tab.anchorLine`
		tab.anchorLine = coords.toBufferLine(tab.anchorLine);
	});

	test('branding both sides of a snapshot changes none of its bytes', () => {
		reset();
		const tab = openScrolledTab('/notes/a.md');

		// The brand is phantom, so it cannot survive JSON and nothing on the wire
		// should have moved. Both persisted forms are checked, because both were
		// re-declared on the way back in: the cross-window transfer payload, and
		// the window-state snapshot in localStorage.
		const wire = JSON.stringify(snapshotTab(tab));
		assert.equal(JSON.parse(wire).anchorLine, 812);

		const arrived = validateTransferPayload(wire);
		assert.ok(arrived, 'a snapshot of a real tab must validate');
		assert.equal(arrived.anchorLine, 812);

		tabManager.restoreState(tabManager.serializeState());
		assert.equal(tabManager.tabs.find((item) => item.path === '/notes/a.md')?.anchorLine, 812);
	});

	/* ------------------------------------------------------------------ */
	/* the arrival of a tab from another window                            */
	/* ------------------------------------------------------------------ */
	//
	// The transfer payload carries all three fields (`tabTransfer.ts`), so the
	// destination has everything it needs — and used to open the document at the
	// top anyway, because of WHEN it asked.
	//
	// `insertTransferredTab` pushes the tab and activates it synchronously, while
	// its rendered `content` is still the `''` every construction site seeds. The
	// preview's restore effect runs on that activation, against a host holding no
	// document; `acceptTransferredTab` only awaits `renderTabPreviewFromRaw`
	// afterwards, and nothing re-triggers the effect when that document lands (it
	// depends on the tab id, the article and the path — deliberately not on the
	// render, which also fires on every debounced re-render while the reader is
	// typing in split view).
	//
	// The two tests below are the two moments, run against the REAL cascade over
	// the REAL `processMarkdownHtml` output of the document being transferred.
	// What they cannot be is a live drag: two windows and a Rust broker are not
	// reachable from here, so the sequence is replayed rather than performed, and
	// the wiring that performs it is asserted in `tabTransferHandoff.test.ts`.

	/**
	 * A layout in which every source line is `LINE_HEIGHT` tall.
	 *
	 * jsdom reports 0 for every offset, so the geometry is the fixture — as in
	 * `scrollSyncAcrossFolds.test.ts` and `anchorJumpUnderZoom.spec.ts`. Deriving
	 * it from the element's own `data-sourcepos` is what makes the expected
	 * scrollTop below a number this file can state rather than read back.
	 */
	const LINE_HEIGHT = 24;

	function measureBySourcepos(node: AnchorNode): AnchorBox {
		const range = parseSourceposLineRange(node.getAttribute?.('data-sourcepos'));
		if (!range) return { top: Number.NaN, height: Number.NaN };
		return {
			top: (range.startLine - 1) * LINE_HEIGHT,
			height: (range.endLine - range.startLine + 1) * LINE_HEIGHT,
		};
	}

	/**
	 * The article the preview scrolls. Its scroll range is passed to the restore
	 * rather than read off it, so it is stated here: nothing to scroll while the
	 * host is empty, a tall document once one has been patched in.
	 */
	function emptyPreview(): HTMLElement {
		const host = document.createElement('div');
		host.className = 'markdown-body';
		return host;
	}

	function scrollMaxOf(host: HTMLElement): number {
		return host.innerHTML === '' ? 0 : 40_000 - 900;
	}

	/** A tab that left another window with its reader parked on `anchorLine`. */
	function arriveFromAnotherWindow(anchorLine: number): Tab {
		tabManager.addTab('/notes/b.md', DOC_B.html());
		const source = tabManager.tabs.find((item) => item.path === '/notes/b.md')!;
		source.scrollTop = 4820;
		source.scrollPercentage = 0.73;
		source.anchorLine = asRendererLine(anchorLine);

		const payload = validateTransferPayload(JSON.stringify(snapshotTab(source)));
		assert.ok(payload, 'a snapshot of a real tab must validate');

		// The destination window, which has never seen this document.
		tabManager.closeAll();
		const id = tabManager.insertTransferredTab(payload);
		return tabManager.tabs.find((item) => item.id === id)!;
	}

	/** A heading line, so the block spans one line and the interpolation is exact. */
	const ARRIVAL_LINE = DOC_B.lines[Math.floor(DOC_B.lines.length / 2)];

	test('a transferred tab is activated before its document exists, so the restore then has nothing to work with', () => {
		reset();
		const arrived = arriveFromAnotherWindow(ARRIVAL_LINE);

		// The three fields survived the wire, and the tab is already the active one.
		assert.equal(arrived.anchorLine, ARRIVAL_LINE);
		assert.equal(arrived.scrollPercentage, 0.73);
		assert.equal(arrived.scrollTop, 4820);
		assert.equal(tabManager.activeTabId, arrived.id);
		assert.equal(arrived.content, '', 'the rendered document has not been built yet');

		const host = emptyPreview();

		// Every entry of the cascade in turn: no block owns the line because there
		// are no blocks, there is no scroll range for the percentage, and the pixel
		// offset has nowhere to go. Asserted on the returned entry rather than on
		// `host.scrollTop`, because jsdom stores whatever is assigned to `scrollTop`
		// while a real container clamps it to a range that here is empty.
		assert.equal(restorePreviewReadingPosition(host, arrived, scrollMaxOf(host), measureBySourcepos), 'nothing');
		assert.equal(findAnchorElement(host, arrived.anchorLine), null);
	});

	test('the same cascade, run once the arriving document is in, puts the reader back', () => {
		reset();
		const arrived = arriveFromAnotherWindow(ARRIVAL_LINE);
		const host = emptyPreview();

		// What `renderTabPreviewFromRaw` leaves behind: the tab's own buffer through
		// the real pipeline, patched into the host it just awaited a flush for.
		host.innerHTML = processMarkdownHtml(DOC_B.html(), arrived.path, new Set<string>());

		assert.equal(restorePreviewReadingPosition(host, arrived, scrollMaxOf(host), measureBySourcepos), 'anchor');
		// The first entry of the cascade answered, so the answer is the anchor's:
		// the line's own box, pinned `PREVIEW_ANCHOR_OFFSET` below the top.
		assert.equal(host.scrollTop, (ARRIVAL_LINE - 1) * LINE_HEIGHT - PREVIEW_ANCHOR_OFFSET);
		assert.notEqual(host.scrollTop, 0);
	});

	// ------------------------------------------ one article, a host for every tab

	/**
	 * The article as the viewer builds it: one `.markdown-blocks` host per open
	 * tab, every one of them filled, and only the active one displayed. Each host
	 * here holds the same file, so every source line exists in all three.
	 */
	function articleWithHosts(activeIndex: number): { article: HTMLElement; hosts: HTMLElement[] } {
		const article = emptyPreview();
		const hosts = [0, 1, 2].map((index) => {
			const host = document.createElement('div');
			host.className = 'markdown-blocks';
			host.innerHTML = processMarkdownHtml(DOC_B.html(), '/notes/b.md', new Set<string>());
			if (index !== activeIndex) host.style.display = 'none';
			article.appendChild(host);
			return host;
		});
		return { article, hosts };
	}

	/**
	 * What the browser reports inside a `display: none` host: no box at all, so
	 * `measureAnchorBox` puts it at the top of the article.
	 */
	function measureDisplayedOnly(node: AnchorNode): AnchorBox {
		const hidden = (node as unknown as HTMLElement).closest('.markdown-blocks[style*="none"]');
		return hidden ? { top: 0, height: 0 } : measureBySourcepos(node);
	}

	test('a tab switched back to restores in its own host, not in a hidden tab showing the same file', () => {
		reset();
		const { article } = articleWithHosts(1);
		const position = { anchorLine: ARRIVAL_LINE, scrollPercentage: 0.5, scrollTop: 4820 };

		assert.equal(restorePreviewReadingPosition(article, position, 40_000 - 900, measureDisplayedOnly), 'anchor');
		assert.equal(article.scrollTop, (ARRIVAL_LINE - 1) * LINE_HEIGHT - PREVIEW_ANCHOR_OFFSET);
	});

	test('the line saved while scrolling comes from the displayed host, not from a hidden one after it', () => {
		const { article } = articleWithHosts(0);
		const coords = lineCoordinates(DOC_B.html());

		// The top of a heading's box is that heading's own line, exactly.
		const offset = (ARRIVAL_LINE - 1) * LINE_HEIGHT;
		assert.equal(coords.bufferLineAtPreviewOffset(article, offset, measureDisplayedOnly), ARRIVAL_LINE);
	});
});

/**
 * One tab, two panes, one anchor line — and a document with front matter, which
 * is the only kind of document that can tell whether the two panes agree about
 * what a line number means.
 *
 * `tab.anchorLine` is where the reader was. The preview writes it off
 * `data-sourcepos`, which counts from the first line of the BODY; the editor
 * writes it off Monaco, which counts from the first line of the FILE. Each pane
 * read its own writes back the way it made them, so each looked correct on its
 * own, and every switch between them landed the height of the front matter
 * away. Without front matter the two numberings coincide and the defect is
 * invisible — which is what every earlier fixture was, and why this one is not.
 *
 * So both directions are driven end to end here, and what is asserted is where
 * the READER ends up, not the number in the field:
 *
 *   preview scroll offset -> anchor -> editor's reveal line -> the text there
 *   editor top line       -> anchor -> preview's anchor element -> its text
 *
 * The pieces are the real ones on both sides — `processMarkdownHtml`'s output,
 * `getSourceLineAtPreviewOffset`, `findAnchorElement`, `getAnchorScrollTop`,
 * the real `TabManager` — and the crossing itself is imported rather than
 * re-implemented, because a test that re-derives the shift cannot notice the
 * component forgetting it.
 *
 * What is injected is layout: jsdom has none, and `measure` is a parameter of
 * the mapping for exactly this reason. The numbers below are not a claim about
 * how a browser lays a paragraph out; the property under test only needs blocks
 * to be somewhere, in order.
 */
describe('tab anchor across panes', () => {
	beforeAll(() => {
		(window as any).__TAURI_INTERNALS__ = {
			metadata: { currentWindow: { label: 'main' }, currentWebview: { windowLabel: 'main', label: 'main' } },
			invoke: (cmd: string) => Promise.resolve(cmd === 'get_os_type' ? 'macos' : null),
		};
	});

	afterAll(() => {
		// One store for the whole file: leave it empty for the next describe.
		tabManager.closeAll();
		tabManager.recentlyClosed.length = 0;
		localStorage.clear();
	});

	/* ------------------------------------------------------------------ */
	/* one document, written twice: as a file and as its render            */
	/* ------------------------------------------------------------------ */

	/**
	 * comrak's shape, as the render-protocol fixtures record it: a `data-sourcepos`
	 * range on every block, counted from the first line of the BODY. The file the
	 * user edits is built line for line beside it, front matter included, so the
	 * two differ by exactly the thing under test.
	 */
	class Fixture {
		readonly bodyLines: string[] = [];
		private readonly parts: string[] = [];
		private readonly lines = new Map<string, number>();

		private push(source: string, html: (line: number) => string) {
			this.bodyLines.push(source, '');
			const line = this.bodyLines.length - 1;
			this.lines.set(source, line);
			this.parts.push(html(line));
		}

		heading(text: string, slug: string) {
			this.push(
				`## ${text}`,
				(line) =>
					`<h2 data-sourcepos="${line}:1-${line}:${text.length + 3}">` +
					`<a href="#${slug}" aria-hidden="true" class="anchor" id="${slug}"></a>${text}</h2>`,
			);
		}

		paragraph(text: string) {
			this.push(text, (line) => `<p data-sourcepos="${line}:1-${line}:${text.length}">${text}</p>`);
		}

		html() {
			return this.parts.join('\n') + '\n';
		}
	}

	/** Five lines of YAML and the blank line after it: the body starts at file line 7. */
	const FRONT_MATTER = ['---', 'title: Anchored', 'tags:', '  - front matter', '---', ''];

	const DOC = new Fixture();
	for (const section of ['alpha', 'beta', 'gamma', 'delta']) {
		DOC.heading(`${section} section`, `${section}-section`);
		for (let p = 1; p <= 4; p += 1) {
			DOC.paragraph(`${section} paragraph ${p}, a sentence of prose.`);
		}
	}

	const FILE_LINES = [...FRONT_MATTER, ...DOC.bodyLines];
	const RAW = FILE_LINES.join('\n');
	const COORDS = lineCoordinates(RAW);
	const PATH = '/notes/anchored.md';

	/** The line of the FILE a block sits on: 1-based, front matter counted. */
	function fileLine(text: string): number {
		const index = FILE_LINES.indexOf(text);
		assert.notEqual(index, -1, `${text} is not a line of the fixture`);
		return index + 1;
	}

	/** The document the preview walks: `.markdown-body`, holding the real pipeline's output. */
	const BODY = (() => {
		const body = document.createElement('div');
		body.className = 'markdown-body';
		body.innerHTML = processMarkdownHtml(DOC.html(), PATH, new Set<string>());
		return body;
	})();

	/* ------------------------------------------------------------------ */
	/* the layout jsdom does not have                                      */
	/* ------------------------------------------------------------------ */

	const BLOCK_HEIGHT = 100;

	/** Does anything in here carry a source range? Anything else gets no box. */
	function isAnnotated(element: Element): boolean {
		return element.hasAttribute('data-sourcepos') || Array.from(element.children).some(isAnnotated);
	}

	/**
	 * Every annotated block gets a top and a height, children stacked inside their
	 * parent in document order — bottom-up, so a container's box really does
	 * contain its children's, which is the one property the descent relies on.
	 */
	const BOXES = (() => {
		const boxes = new Map<Element, { top: number; height: number }>();

		const place = (element: Element, top: number): number => {
			const children = Array.from(element.children).filter(isAnnotated);
			if (children.length === 0) {
				boxes.set(element, { top, height: BLOCK_HEIGHT });
				return BLOCK_HEIGHT;
			}

			let cursor = top;
			for (const child of children) cursor += place(child, cursor);
			boxes.set(element, { top, height: cursor - top });
			return cursor - top;
		};

		place(BODY, 0);
		return boxes;
	})();

	const measure = (node: unknown) => BOXES.get(node as Element) ?? { top: 0, height: 0 };

	function blockAt(text: string): Element {
		const element = Array.from(BODY.querySelectorAll('[data-sourcepos]')).find((node) => node.textContent === text);
		assert.ok(element, `${text} was not rendered as a block of its own`);
		return element;
	}

	function openTab() {
		tabManager.closeAll();
		localStorage.clear();
		tabManager.addTab(PATH, RAW);
		return tabManager.tabs.find((item) => item.path === PATH)!;
	}

	/** Not the first paragraph of its section, so the two lines above it are prose. */
	const READING = 'gamma paragraph 3, a sentence of prose.';

	test('the fixture is a document whose two numberings differ', () => {
		assert.equal(COORDS.frontMatterLines, FRONT_MATTER.length);
		assert.equal(fileLine(READING), COORDS.toBufferLine(asRendererLine(fileLine(READING) - FRONT_MATTER.length)));
	});

	/* ------------------------------------------------------------------ */
	/* preview -> editor                                                   */
	/* ------------------------------------------------------------------ */

	test('a tab scrolled in the preview opens the editor on the line the reader was reading', () => {
		const tab = openTab();

		// What the reader did: scrolled the preview until READING sat at the offset
		// the anchor is measured at. `getPreviewScrollAnchor` rounds what the
		// mapping answers and hands it straight over.
		const anchor = getSourceLineAtPreviewOffset(BODY, measure(blockAt(READING)).top, measure);
		assert.ok(anchor !== null, 'the preview must resolve a source line for a block it laid out');
		tabManager.updateTabAnchorLine(tab.id, asRendererLine(Math.round(anchor)));

		// What the editor does with it: reveals a line near the top of its viewport.
		const top = editorTopLineForTabAnchor(COORDS, tab.anchorLine);

		assert.equal(
			FILE_LINES[top - 1],
			'gamma paragraph 2, a sentence of prose.',
			'the editor opens with the paragraph before the reader at the top of the viewport',
		);
		assert.equal(
			FILE_LINES[top - 1 + EDITOR_ANCHOR_LINE_OFFSET],
			READING,
			'and the paragraph the reader was on where the anchor puts it',
		);
	});

	/* ------------------------------------------------------------------ */
	/* editor -> preview                                                   */
	/* ------------------------------------------------------------------ */

	test('a tab scrolled in the editor opens the preview on the block the reader was reading', () => {
		const tab = openTab();

		// What Monaco reports on the way out: the buffer line at the top of the
		// viewport, with READING the anchor's distance below it.
		const topLine = asBufferLine(fileLine(READING) - EDITOR_ANCHOR_LINE_OFFSET);
		tabManager.updateTabAnchorLine(tab.id, tabAnchorForEditorTopLine(COORDS, topLine));

		const match = findAnchorElement(BODY, tab.anchorLine);
		assert.ok(match, 'the recorded anchor must resolve to a rendered block');
		assert.equal(
			(match.element as unknown as Element).textContent,
			READING,
			'the preview restores to the block the reader left the editor on',
		);

		// And it puts that block where the capture side measures from, so a reader
		// bouncing between the panes stays put rather than creeping down the page.
		const box = measure(match.element);
		assert.equal(
			getAnchorScrollTop(box.top, box.height, match, tab.anchorLine, PREVIEW_ANCHOR_OFFSET),
			Math.max(0, box.top - PREVIEW_ANCHOR_OFFSET),
		);
	});

	/* ------------------------------------------------------------------ */
	/* that the brand is still there                                       */
	/* ------------------------------------------------------------------ */
	//
	// The brand has no run-time representation, so this cannot be an `assert`. It
	// is the `@ts-expect-error` directives below, which invert into the failure
	// wanted: if `updateTabAnchorLine` ever goes back to taking a plain `number`,
	// these lines compile and `npm run check` fails them as UNUSED directives.

	test('the anchor cannot be written in the editor’s numbering by accident', () => {
		const tab = openTab();
		tabManager.updateTabAnchorLine(tab.id, asRendererLine(12));

		// A Monaco line, which is what this call used to be handed.
		// @ts-expect-error `updateTabAnchorLine` takes a RendererLine; this is a BufferLine
		tabManager.updateTabAnchorLine(tab.id, COORDS.toBufferLine(tab.anchorLine));

		// And a bare number, which does not say which of the two it is.
		// @ts-expect-error a plain `number` no longer claims a numbering
		tabManager.updateTabAnchorLine(tab.id, 812);
	});
});
