import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { duplicateNameSuffixes } from '../src/lib/utils/duplicateTabNames.js';
import { HOME_TAB_PATH } from '../src/lib/utils/homeTab.js';
import { getTabFileActions, hasRealFilePath } from '../src/lib/utils/tabFileActions.js';
import { closestSlotIndex, dragDistance } from '../src/lib/utils/tabReorder.js';
import type { Tab } from '../src/lib/stores/tabs.svelte.js';
import { asBufferLine, asRendererLine, EDITOR_ANCHOR_LINE_OFFSET } from '../src/lib/utils/lineCoordinates.js';
import {
	buildTransferredTab,
	snapshotTab,
	transferredTabTitle,
	validateTransferPayload,
	type TransferableTab,
} from '../src/lib/utils/tabTransfer.js';
import { nextUntitledTitle } from '../src/lib/utils/untitledTitle.js';
import { outgoingTabAnchorLine, type StoredTabPosition, editorReadingPosition } from '../src/lib/utils/editorPosition.js';
import { EditorJumps, type JumpEditor } from '../src/lib/utils/editorJumps.js';
import type { ScrollSyncPosition } from '../src/lib/utils/scrollSync.js';

describe('duplicate tab names', () => {
	function suffixes(...paths: string[]): (string | undefined)[] {
		const tabs = paths.map((path, i) => ({ id: String(i), path }));
		const map = duplicateNameSuffixes(tabs);
		return tabs.map((tab) => map.get(tab.id));
	}

	test('a name nothing else shares gets no suffix', () => {
		assert.deepEqual(suffixes('/a/README.md', '/b/NOTES.md'), [undefined, undefined]);
	});

	test('same name in different folders gets the containing folder (#727)', () => {
		assert.deepEqual(suffixes('/x/.claude/skills/alpha/SKILL.md', '/x/.claude/skills/beta/SKILL.md'), [
			'alpha',
			'beta',
		]);
	});

	test('a suffix that is itself shared grows by one more folder', () => {
		assert.deepEqual(suffixes('/w/docs/api/README.md', '/w/packages/api/README.md'), [
			'docs/api',
			'packages/api',
		]);
	});

	test('only the tabs that still collide grow; a sibling keeps one folder', () => {
		assert.deepEqual(suffixes('/w/docs/api/README.md', '/w/packages/api/README.md', '/w/guide/README.md'), [
			'docs/api',
			'packages/api',
			'guide',
		]);
	});

	test('a windows path is shown with the separator it is spelled in', () => {
		assert.deepEqual(suffixes('C:\\w\\docs\\api\\README.md', 'C:\\w\\pkg\\api\\README.md'), [
			'docs\\api',
			'pkg\\api',
		]);
	});

	test('a file with no folder left to name is left alone rather than looping', () => {
		assert.deepEqual(suffixes('/README.md', '/w/README.md'), [undefined, 'w']);
	});

	test('untitled buffers and the home tab are not files and take no suffix', () => {
		assert.deepEqual(suffixes('', '', HOME_TAB_PATH), [undefined, undefined, undefined]);
	});
});

describe('tab file actions', () => {
	test('tab file actions are enabled for saved files', () => {
		const actions = getTabFileActions('/tmp/notes/example.md');

		assert.equal(hasRealFilePath('/tmp/notes/example.md'), true);
		assert.deepEqual(
			actions.map((action) => [action.id, action.labelKey, action.disabled]),
			[
				['copy-path', 'menu.copyFullPath', false],
				['open-location', 'menu.openFileLocation', false],
			]
		);
	});

	test('tab file actions are disabled for tabs without a real file path', () => {
		for (const path of ['', 'HOME']) {
			assert.equal(hasRealFilePath(path), false);
			assert.deepEqual(
				getTabFileActions(path).map((action) => [action.id, action.disabled]),
				[
					['copy-path', true],
					['open-location', true],
				]
			);
		}
	});
});

describe('tab reorder', () => {
	// Three 100x30 tabs, laid out across the strip and then down the column (#884).
	const row = [0, 1, 2].map((i) => ({ left: i * 104, top: 0, width: 100, height: 30 }));
	const column = [0, 1, 2].map((i) => ({ left: 0, top: i * 32, width: 180, height: 30 }));

	test('the strip picks the slot nearest the pointer horizontally', () => {
		assert.equal(closestSlotIndex(row, { x: 10, y: 500 }, 'x'), 0);
		assert.equal(closestSlotIndex(row, { x: 160, y: 500 }, 'x'), 1);
		assert.equal(closestSlotIndex(row, { x: 999, y: 0 }, 'x'), 2);
	});

	test('the column picks the slot nearest the pointer vertically, whatever its x', () => {
		assert.equal(closestSlotIndex(column, { x: 500, y: 5 }, 'y'), 0);
		assert.equal(closestSlotIndex(column, { x: -40, y: 40 }, 'y'), 1);
		assert.equal(closestSlotIndex(column, { x: 90, y: 400 }, 'y'), 2);
	});

	test('non-tab children are skipped and an empty list has no slot', () => {
		assert.equal(closestSlotIndex([null, column[1], null], { x: 0, y: 0 }, 'y'), 1);
		assert.equal(closestSlotIndex([], { x: 0, y: 0 }, 'x'), -1);
	});

	test('a drag starts on travel along the layout axis only', () => {
		const start = { x: 100, y: 100 };
		assert.equal(dragDistance(start, { x: 108, y: 100 }, 'x'), 8);
		assert.equal(dragDistance(start, { x: 108, y: 100 }, 'y'), 0);
		assert.equal(dragDistance(start, { x: 100, y: 93 }, 'y'), 7);
	});
});

describe('cross-window tab transfer payload', () => {
	// Cross-window tab transfer: snapshot in the source window → JSON through
	// the Rust broker → strict validation → rebuild in the destination. The
	// snapshot is independent of serializeState (window shape only, no content):
	// a transferred tab MUST carry its unsaved buffer. Validation is strict and
	// rejecting — a past bug built tabs with undefined rawContent, the editor
	// attributed a stale buffer to them, and auto-save destroyed real files.

	function makeTab(overrides: Partial<Tab> = {}): Tab {
		return {
			id: 'source-id',
			path: '/notes/todo.md',
			title: 'todo.md',
			content: '<p>rendered</p>',
			rawContent: '# unsaved edits',
			originalContent: '# saved on disk',
			scrollTop: 120,
			isDirty: true,
			isEditing: true,
			history: ['/notes/readme.md', '/notes/todo.md'],
			historyIndex: 1,
			editorViewState: { cursorState: 'monaco-live-object' },
			scrollPercentage: 0.42,
			anchorLine: asRendererLine(7),
			isSplit: true,
			splitRatio: 0.3,
			isScrollSynced: true,
			hasReplacementChars: false,
			encoding: 'UTF-8',
			scrollHistory: [],
			scrollFuture: [],
			foldOverrides: new Set<string>(),
			...overrides,
		};
	}

	/**
	 * The snapshot as a mutable bag, for the tests that corrupt one field and
	 * re-serialize. A copy, so the `TransferableTab` contract stays intact for
	 * every other caller.
	 */
	function snapshotBag(tab: Tab): Record<string, unknown> {
		return { ...snapshotTab(tab) };
	}

	function roundTrip(tab: Tab): TransferableTab {
		const snap = snapshotTab(tab);
		const validated = validateTransferPayload(JSON.stringify(snap));
		assert.ok(validated, 'a snapshot of a real tab must validate');
		return validated;
	}

	test('snapshot → JSON → validate → insert preserves the tab, including unsaved content', () => {
		const source = makeTab();
		const arrived = buildTransferredTab(roundTrip(source), [], 'Untitled');

		assert.equal(arrived.path, source.path);
		assert.equal(arrived.title, source.title);
		assert.equal(arrived.rawContent, source.rawContent);
		assert.equal(arrived.originalContent, source.originalContent);
		assert.equal(arrived.isDirty, true);
		assert.equal(arrived.isEditing, true);
		assert.equal(arrived.isSplit, true);
		assert.equal(arrived.splitRatio, source.splitRatio);
		assert.equal(arrived.isScrollSynced, true);
		assert.equal(arrived.scrollTop, source.scrollTop);
		assert.equal(arrived.scrollPercentage, source.scrollPercentage);
		assert.equal(arrived.anchorLine, source.anchorLine);
		assert.deepEqual(arrived.history, source.history);
		assert.equal(arrived.historyIndex, source.historyIndex);

		// regenerated / non-serializable state starts fresh at the destination
		assert.equal(arrived.content, '');
		assert.equal(arrived.editorViewState, null);
		assert.notEqual(arrived.id, source.id);
	});

	test('each insert gets a fresh id', () => {
		const snap = snapshotTab(makeTab());
		const a = buildTransferredTab(snap, [], 'Untitled');
		const b = buildTransferredTab(snap, [], 'Untitled');
		assert.notEqual(a.id, b.id);
	});

	test('snapshot never mutates the source tab', () => {
		const source = makeTab();
		const snap = snapshotTab(source);

		snap.history.push('/injected.md');
		snap.rawContent = 'clobbered';
		snap.title = 'clobbered';

		assert.deepEqual(source.history, ['/notes/readme.md', '/notes/todo.md']);
		assert.equal(source.rawContent, '# unsaved edits');
		assert.equal(source.title, 'todo.md');
		assert.equal(source.editorViewState.cursorState, 'monaco-live-object');
	});

	test('the snapshot excludes rendered content and editorViewState', () => {
		const snap = snapshotBag(makeTab());
		assert.ok(!('content' in snap));
		assert.ok(!('editorViewState' in snap));
		assert.ok(!('id' in snap));
	});

	test('validation rejects invalid JSON', () => {
		assert.equal(validateTransferPayload('not json {'), null);
		assert.equal(validateTransferPayload(''), null);
	});

	test('validation rejects non-object payloads', () => {
		assert.equal(validateTransferPayload('null'), null);
		assert.equal(validateTransferPayload('[]'), null);
		assert.equal(validateTransferPayload('"a tab"'), null);
	});

	test('validation rejects a missing rawContent — no default, no coercion', () => {
		const snap = snapshotBag(makeTab());
		delete snap.rawContent;
		assert.equal(validateTransferPayload(JSON.stringify(snap)), null);
	});

	test('validation rejects a non-string rawContent', () => {
		const snap = snapshotBag(makeTab());
		snap.rawContent = 5;
		assert.equal(validateTransferPayload(JSON.stringify(snap)), null);
	});

	test('validation rejects a history that is not an array', () => {
		const snap = snapshotBag(makeTab());
		snap.history = 'nope';
		assert.equal(validateTransferPayload(JSON.stringify(snap)), null);
	});

	test('validation rejects history entries that are not strings', () => {
		const snap = snapshotBag(makeTab());
		snap.history = [1, 2];
		assert.equal(validateTransferPayload(JSON.stringify(snap)), null);
	});

	test('validation is strict for every field — even cosmetic numerics get no default', () => {
		for (const field of [
			'path',
			'title',
			'originalContent',
			'isDirty',
			'isEditing',
			'isSplit',
			'isScrollSynced',
			'splitRatio',
			'scrollTop',
			'scrollPercentage',
			'anchorLine',
			'historyIndex',
		]) {
			const snap = snapshotBag(makeTab());
			delete snap[field];
			assert.equal(validateTransferPayload(JSON.stringify(snap)), null, `missing ${field}`);
		}
	});

	test('validation rejects non-finite numbers (NaN serializes to null)', () => {
		const snap = snapshotBag(makeTab());
		snap.scrollTop = NaN; // JSON.stringify turns this into null
		assert.equal(validateTransferPayload(JSON.stringify(snap)), null);
	});

	test('untitled arrivals keep their title unless the destination has taken it', () => {
		const source = makeTab({ path: '', title: 'Untitled 2' });
		const snap = roundTrip(source);

		// The title is the document's identity: a fresh detach window (or any
		// destination without a clash) never renames.
		assert.equal(transferredTabTitle(snap, [], 'Untitled'), 'Untitled 2');
		assert.equal(transferredTabTitle(snap, ['Untitled 1'], 'Untitled'), 'Untitled 2');
		assert.equal(transferredTabTitle(snap, ['notes.md'], 'Untitled'), 'Untitled 2');

		// Only an exact clash re-numbers, to the destination's smallest free
		// number per untitledTitle semantics.
		assert.equal(
			transferredTabTitle(snap, ['Untitled 1', 'Untitled 2'], 'Untitled'),
			'Untitled 3',
		);
		assert.equal(transferredTabTitle(snap, ['Untitled 2'], 'Untitled'), 'Untitled 1');

		const arrived = buildTransferredTab(snap, ['Untitled 1', 'Untitled 2'], 'Untitled');
		assert.equal(arrived.title, 'Untitled 3');
		// the buffer still travels even when the title changed
		assert.equal(arrived.rawContent, source.rawContent);
	});

	test('file-backed arrivals keep their title', () => {
		const snap = roundTrip(makeTab());
		assert.equal(transferredTabTitle(snap, ['todo.md'], 'Untitled'), 'todo.md');
	});
});

describe('numbered untitled titles', () => {
	// Untitled tabs get distinct numbered titles ("Untitled 1", "Untitled 2", …)
	// so the tab strip — and the per-tab close dialogs — can name exactly which
	// tab they are talking about. Two dirty untitled tabs used to both be called
	// "Untitled", making the close dialog ambiguous.

	test('the first untitled tab is number 1', () => {
		assert.equal(nextUntitledTitle([], 'Untitled'), 'Untitled 1');
	});

	test('numbers increment past the ones in use', () => {
		assert.equal(nextUntitledTitle(['Untitled 1', 'Untitled 2'], 'Untitled'), 'Untitled 3');
	});

	test('freed numbers are reused (smallest available wins)', () => {
		assert.equal(nextUntitledTitle(['Untitled 1', 'Untitled 3'], 'Untitled'), 'Untitled 2');
	});

	test('a legacy unnumbered title occupies slot 1', () => {
		assert.equal(nextUntitledTitle(['Untitled'], 'Untitled'), 'Untitled 2');
	});

	test('titled tabs and lookalike names are ignored', () => {
		assert.equal(
			nextUntitledTitle(['notes.md', 'Untitled draft', 'Untitled 1x'], 'Untitled'),
			'Untitled 1',
		);
	});

	test('works with localized bases', () => {
		assert.equal(nextUntitledTitle(['无标题 1'], '无标题'), '无标题 2');
	});
});

describe('background edit-only tab position', () => {
	// A tab left in EDIT-ONLY mode in the background is the one population neither
	// writer of `Tab.anchorLine` covers: the preview writes only the active tab and
	// is not on screen for this one, and the single editor has moved on to another
	// model. What covers it in memory is `editorViewState`, which survives neither
	// the window-state snapshot nor the cross-window payload -- so the anchor is
	// recovered from it at those two gates. Everything below is about which tabs
	// that applies to, because the tabs it must NOT apply to already have a better
	// record than the view state.

	/** A view state as Monaco writes one, cut down to the field the derivation reads. */
	function viewStateAtLine(lineNumber: number) {
		return { viewState: { firstPosition: { lineNumber, column: 1 }, firstPositionDeltaTop: 0 } };
	}

	function tab(over: Partial<StoredTabPosition> = {}): StoredTabPosition {
		return {
			id: 'background',
			isEditing: true,
			isSplit: false,
			editorViewState: viewStateAtLine(40),
			rawContent: 'body\n'.repeat(200),
			anchorLine: asRendererLine(0),
			...over,
		};
	}

	test('a background edit-only tab is recorded where its view state says it was', () => {
		// This is the defect: nothing wrote `anchorLine` for this tab, so `0` is
		// what would be persisted -- the top of the document.
		assert.equal(
			outgoingTabAnchorLine(tab(), 'some-other-tab'),
			40 + EDITOR_ANCHOR_LINE_OFFSET,
		);
	});

	test('the recovered anchor crosses out of the editor numbering, front matter and all', () => {
		// `firstPosition.lineNumber` is a BUFFER line and the tab's anchor is a
		// RENDERER line. The crossing has one home and this reuses it rather than
		// making its own -- the defect shape `lineCoordinates.ts` exists to prevent.
		const rawContent = '---\ntitle: t\n---\n\n' + 'body\n'.repeat(200);
		assert.equal(
			outgoingTabAnchorLine(tab({ rawContent, editorViewState: viewStateAtLine(40) }), null),
			40 + EDITOR_ANCHOR_LINE_OFFSET - 4,
		);
	});

	test('a tab that left edit mode keeps the position its preview wrote', () => {
		// THE regression this change could introduce. Nothing clears
		// `editorViewState` when a tab leaves edit mode, so a tab the reader edited,
		// switched to reading mode and then scrolled carries a stale view state
		// under a fresh `anchorLine`. Deriving there would replace a correct record
		// with an older one, on the commoner path.
		const stale = tab({ isEditing: false, anchorLine: asRendererLine(120) });
		assert.equal(outgoingTabAnchorLine(stale, 'some-other-tab'), 120);
	});

	test('a split tab keeps the position its preview wrote', () => {
		// A split tab has its preview on screen writing `anchorLine` on every scroll
		// event, and the editor beside it is scrolled independently unless
		// `isScrollSynced`. Its record is a real reading position; the view state is
		// a second opinion about a different pane.
		const split = tab({ isSplit: true, anchorLine: asRendererLine(120) });
		assert.equal(outgoingTabAnchorLine(split, 'some-other-tab'), 120);
	});

	test('the active tab keeps what the live editor just flushed onto it', () => {
		// #735 flushes the active tab from the live editor immediately before both
		// gates, and that reading is the better one AND a different one: Monaco's
		// `saveViewState` records the first PARTIALLY visible line, while
		// `getVisibleRanges()` -- what the flush reads -- starts at the first
		// completely visible one. Deriving over the flush would move the active tab
		// by a line at most scroll positions.
		const active = tab({ id: 'live', anchorLine: asRendererLine(120) });
		assert.equal(outgoingTabAnchorLine(active, 'live'), 120);
	});

	test('a tab with no saved view state is left exactly as it is', () => {
		// Restored from disk, or transferred in: `editorViewState` starts null on
		// both routes and there is nothing to recover from.
		const fresh = tab({ editorViewState: null, anchorLine: asRendererLine(7) });
		assert.equal(outgoingTabAnchorLine(fresh, null), 7);
	});

	test('a view state written by an older Monaco is left exactly as it is', () => {
		// `firstPosition` is what `reduceRestoreState` falls back from when it is
		// missing, so the shape is real and reachable rather than defensive.
		const legacy = tab({ editorViewState: { scrollTop: 900 }, anchorLine: asRendererLine(7) });
		assert.equal(outgoingTabAnchorLine(legacy, null), 7);
	});
});

describe('editor reading position flush', () => {
	// A tab records where its reader was, and two panes write those fields. The
	// preview writes them on every scroll event; the editor writes them when it
	// comes down. Everything below is about the second one being asked at the
	// moments something reads a tab's position while the editor is still up.

	test('the percentage is where the reading puts the reader back', () => {
		const { scrollPercentage } = editorReadingPosition({
			scrollTop: 300,
			contentHeight: 1600,
			viewportHeight: 1000,
			topLine: null,
			text: '',
		});
		assert.equal(scrollPercentage, 0.5);
	});

	test('a document that fits the viewport has no percentage rather than zero', () => {
		// Zero is a position — the top of the document — and writing it would move
		// a reader who had not scrolled anywhere.
		const { scrollPercentage } = editorReadingPosition({
			scrollTop: 0,
			contentHeight: 400,
			viewportHeight: 1000,
			topLine: null,
			text: 'short',
		});
		assert.equal(scrollPercentage, null);
	});

	test('the anchor crosses out of the editor numbering, front matter and all', () => {
		// Monaco counts from the first line of the FILE; the tab's anchor counts
		// from the first line of the BODY. Both shifts apply: the four lines of
		// front matter, and the offset that anchors the reader on the line they
		// were reading rather than the one the viewport cut in half.
		const text = '---\ntitle: t\n---\n\nbody line one\nbody line two\nbody line three\n';
		const { anchorLine } = editorReadingPosition({
			scrollTop: 0,
			contentHeight: 2000,
			viewportHeight: 1000,
			topLine: 5,
			text,
		});
		assert.equal(anchorLine, 5 + EDITOR_ANCHOR_LINE_OFFSET - 4);
	});

	test('an editor with nothing laid out yet reports no anchor', () => {
		const { anchorLine } = editorReadingPosition({
			scrollTop: 0,
			contentHeight: 2000,
			viewportHeight: 1000,
			topLine: null,
			text: 'body',
		});
		assert.equal(anchorLine, null);
	});

	test('a sync asked for while Monaco is loading is kept, and spent after the restore', () => {
		// #799: Ctrl+E from the preview asks before the editor exists. Dropping the
		// request left the editor wherever its old view state put it. The editor
		// spends it after its view-state restore, and before a queued "edit this
		// fragment", which has to win over both.
		const log: unknown[] = [];
		const model = { getLineCount: () => 3, getLineMaxColumn: () => 5 };
		const editor = {
			getModel: () => model,
			revealLineNearTop: () => {},
			revealLineInCenterIfOutsideViewport: (line: number) => log.push(['reveal', line]),
			setSelection: () => {},
			focus: () => {},
		} as unknown as JumpEditor;
		const state = { ready: false };
		const jumps = new EditorJumps({
			monaco: () => ({ editor: { ScrollType: { Smooth: 0, Immediate: 1 } } }) as never,
			editor: () => editor,
			ready: () => state.ready,
			scrollTo: (position, options) => log.push(['scroll', position, options]),
		});
		const position: ScrollSyncPosition = { section: 'body', ratio: 0.4, line: asBufferLine(12) };

		jumps.syncScrollToPosition(position, { cursorIntoView: true });
		jumps.revealSourceRange(2, 2);
		assert.deepEqual(log, []);

		state.ready = true;
		jumps.spendPending();
		assert.deepEqual(log, [
			['scroll', position, { cursorIntoView: true }],
			['reveal', 2],
		]);

		jumps.syncScrollToPosition(position);
		assert.deepEqual(log.at(-1), ['scroll', position, { cursorIntoView: false }], 'once ready, a sync is not queued');
	});
});
