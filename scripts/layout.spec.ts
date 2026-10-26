import assert from 'node:assert/strict';

import { flushSync, mount, unmount } from 'svelte';
import { afterAll, afterEach, beforeAll, describe, expect, onTestFinished, test, vi } from 'vitest';

import Toc from '../src/lib/components/Toc.svelte';
import { collapsedFoldsAround, type FoldHost, revealFold, toggleFold, toggleFoldFromClick } from '../src/lib/utils/foldState.js';
import { runeProps } from './runeProps.svelte.js';
import { observeFoldLayout, type FoldLayoutObservation } from '../src/lib/utils/foldLayout.js';
import { splitRatioAfterMove } from '../src/lib/utils/splitPanes.js';
import { previewLayout } from '../src/lib/utils/previewLayout.js';
import { dismissesToc, tocAutoCollapses } from '../src/lib/utils/tocOverlay.js';
import { followFoldLayout, previewPaneShown } from '../src/lib/utils/foldLayoutEffect.svelte.js';
import { runeEffect } from './runeEffect.svelte.js';
import { patchHost } from '../src/lib/utils/previewPatch.js';
import { followPreviewPatch } from '../src/lib/utils/previewPatchEffect.svelte.js';

describe('split scroll-sync preference', async () => {
	/*
	 * `editor.splitScrollSync` — the sticky "does a new split start scroll-locked"
	 * answer — was the last localStorage write outside `writeStoredSetting`. The
	 * tab store read it in its constructor and wrote it with a bare
	 * `localStorage.setItem`.
	 *
	 * That is the milder half of the defect #618 collected the other three writers
	 * for: one key and one write, so it could not clobber its neighbours the way a
	 * whole-snapshot write did. What it still had was the other half — no `storage`
	 * listener. Markpad opens several windows, each a separate webview over one
	 * shared localStorage, so flipping scroll sync in window A left window B
	 * seeding its next split from its own construction-time answer until it was
	 * restarted, while every preference beside it synced live.
	 *
	 * It is a preference, not tab state: `Tab.isScrollSynced` is the per-tab value
	 * (it lives in the window-state snapshot and is what the title bar toggles),
	 * and this is the one scalar every tab and every window seeds from. So it now
	 * lives in `SettingsStore` with the rest of them, and `TabManager` exposes it
	 * under its tab-side name.
	 *
	 * This runs under vitest so the runes are the compiler's: `$effect` really
	 * tracks, `flushSync()` really runs the write effects, and jsdom's
	 * `localStorage` and `window` are real. Only the Tauri backend is stubbed.
	 */
	(window as any).__TAURI_INTERNALS__ = {
		metadata: { currentWindow: { label: 'main' }, currentWebview: { windowLabel: 'main', label: 'main' } },
		invoke: (cmd: string) => Promise.resolve(cmd === 'get_os_type' ? 'macos' : null),
	};

	const { createSettingsPersistence, settings, writeStoredSetting } = await import('../src/lib/stores/settings.svelte.js');
	const { tabManager } = await import('../src/lib/stores/tabs.svelte.js');

	const KEY = 'editor.splitScrollSync';

	/** jsdom does not fire `storage` for writes made by this same document. */
	function dispatchStorage(key: string | null, newValue: string | null) {
		window.dispatchEvent(new StorageEvent('storage', { key, newValue, storageArea: localStorage }));
	}

	function reset() {
		tabManager.closeAll();
		settings.splitScrollSync = false;
		// The write effects and the `storage` listener are only live once flushed.
		flushSync();
	}

	/** A split tab, the way the app reaches one. */
	function splitTab(path: string) {
		tabManager.addTab(path, `# ${path}`);
		const id = tabManager.activeTabId!;
		tabManager.setSplitEnabled(id, true);
		return { id, tab: () => tabManager.tabs.find((candidate) => candidate.id === id)! };
	}

	test('the split scroll-sync preference is a persisted setting like every other one', () => {
		const entry = createSettingsPersistence().find((candidate) => candidate.key === KEY);
		assert.ok(entry, `${KEY} is not in createSettingsPersistence, so nothing syncs or validates it`);
	});

	test('a stored preference survives a restart and seeds the next split', () => {
		reset();
		localStorage.setItem(KEY, 'true');
		dispatchStorage(KEY, 'true');

		const { tab } = splitTab('/notes/restored.md');
		assert.equal(tab().isScrollSynced, true);
	});

	test('a sibling window flipping scroll sync arrives without a restart', () => {
		// THE BUG. Window B holds its own answer; window A flips the toggle and
		// publishes it. With no listener, B kept seeding splits from `false` until it
		// was restarted — the one behaviour the settings mechanism exists to give.
		reset();
		assert.equal(tabManager.splitScrollSyncPreference, false);

		localStorage.setItem(KEY, 'true');
		dispatchStorage(KEY, 'true');

		assert.equal(tabManager.splitScrollSyncPreference, true, 'the sibling window change never arrived');

		const { tab } = splitTab('/notes/sibling.md');
		assert.equal(tab().isScrollSynced, true, 'and the next split still started from the stale answer');
	});

	test('the arriving value is not echoed back at the window that sent it', () => {
		// Compare-and-set, not a flag: the write-back is dropped because the value is
		// already what is stored, so storage -> state -> effect -> write stops here.
		reset();
		localStorage.setItem(KEY, 'true');
		dispatchStorage(KEY, 'true');

		const entry = createSettingsPersistence().find((candidate) => candidate.key === KEY)!;
		assert.equal(writeStoredSetting(entry.key, entry.read(settings)), false);
	});

	test('toggling scroll sync on a tab publishes the preference for the other windows', () => {
		reset();
		const { id } = splitTab('/notes/toggled.md');

		tabManager.toggleScrollSync(id);
		assert.equal(tabManager.splitScrollSyncPreference, true);
		flushSync();
		assert.equal(localStorage.getItem(KEY), 'true');

		// Un-splitting keeps whatever the tab ended up with, as it always did.
		tabManager.setSplitEnabled(id, false);
		assert.equal(tabManager.splitScrollSyncPreference, true);
	});

	test('a splitter dragged past the end stops at the store bounds', () => {
		// The move is unclamped and the store holds 0.1-0.9, so the two cannot
		// disagree about where the bar stops.
		reset();
		const { id, tab } = splitTab('/notes/dragged.md');

		assert.equal(splitRatioAfterMove(0.9, 0.5, 'left'), 1.4);
		tabManager.setSplitRatio(id, splitRatioAfterMove(0.9, 0.5, 'left'));
		assert.equal(tab().splitRatio, 0.9);

		assert.equal(splitRatioAfterMove(0.1, -0.5, 'left'), -0.4);
		tabManager.setSplitRatio(id, splitRatioAfterMove(0.1, -0.5, 'right'));
		assert.equal(tab().splitRatio, 0.6);
		tabManager.setSplitRatio(id, splitRatioAfterMove(0.1, -0.5, 'left'));
		assert.equal(tab().splitRatio, 0.1);
	});
});

/**
 * Folds belong to the document, not to the window — and every driver of a fold
 * writes them.
 *
 * The fold key `processMarkdownHtml` writes and reads is the heading's id —
 * comrak's slug — falling back to its text. That identifies a heading WITHIN a
 * document and nowhere else: every file with an `## Introduction` gets the key
 * `introduction`. While the viewer held one window-wide Set, folding that
 * section in one document folded it in every open document that had the same
 * heading, and the key outlived the document it was folded in, so the next file
 * to contain that heading opened with the section already shut and nothing on
 * screen to explain it.
 *
 * Per tab is not the same as per document. A tab can be repointed at another
 * file without a tab switch — following a link, and back/forward — and the set
 * used to travel with it, so the same collision reappeared one route over. The
 * second half of this file drives those three routes, and the routes that
 * change only the path and must leave the folds alone.
 *
 * The third section is a different failure with the same cause. A fold has
 * three drivers — the preview's own control, the outline's fold button, and
 * find opening whatever hides a match — and one of them used to skip the
 * bookkeeping entirely: a callout's title toggled `is-collapsed` on two
 * elements and wrote nothing down, so a folded callout sprang open on the next
 * render, which in split view is the next keystroke. Nothing keyed callouts at
 * all, so there was nowhere to write it down even in principle.
 *
 * These tests run the REAL `toggleFold`, `revealFold` and `toggleFoldFromClick`
 * out of `foldState.ts`, the REAL `visibleItems` out of a MOUNTED Toc.svelte,
 * and the REAL `processMarkdownHtml`, against the REAL TabManager, in a real
 * DOM. Nothing here asserts on the text of an implementation file: what is
 * checked is what a second render comes back as.
 *
 * WHAT IS NOT THE REAL THING, AND WHY. Two callers of the fold drivers live in
 * files this file cannot import a function out of, and both are named where
 * they are restated: `foldsForTab` (one line in documentSession.svelte.ts, not
 * exported) and `revealFoldsAround` (three lines inside FindBar.svelte, around
 * the REAL `collapsedFoldsAround`). Everything either of them is about — the
 * ancestor walk, the fold write, the render — is imported.
 */
describe('fold state per document', async () => {
	// ---------------------------------------------------------------- environment
	//
	// The runes are the compiler's, not ours: vitest builds `.svelte` and
	// `.svelte.ts` through the Svelte plugin, so `$state`/`$derived`/`$effect`
	// behave here exactly as they do in the app. Only the things jsdom genuinely
	// does not have are stubbed.

	/**
	 * Svelte's `slide` transition, which the outline uses, drives the Web
	 * Animations API. jsdom does not implement it, and nothing here is about the
	 * animation, so it is given something that finishes immediately.
	 */
	beforeAll(() => {
		(Element.prototype as any).animate = () => ({
			cancel() {},
			pause() {},
			play() {},
			finish() {},
			onfinish: null,
			oncancel: null,
			currentTime: 0,
			startTime: 0,
			playbackRate: 1,
			playState: 'finished',
			finished: Promise.resolve(),
			effect: { getComputedTiming: () => ({ delay: 0, duration: 0, endTime: 0 }) },
		});
	});

	afterAll(() => {
		delete (Element.prototype as any).animate;
	});

	(window as any).__TAURI_INTERNALS__ = {
		metadata: { currentWindow: { label: 'main' }, currentWebview: { windowLabel: 'main', label: 'main' } },
		invoke: (cmd: string) => Promise.resolve(cmd === 'get_os_type' ? 'macos' : null),
	};

	const { tabManager } = await import('../src/lib/stores/tabs.svelte.js');
	const { processMarkdownHtml } = await import('../src/lib/utils/markdown.js');

	// -------------------------------------------------------------- the fixtures
	//
	// comrak's shape for two DIFFERENT documents that share a heading — the id is
	// the slug, so both call it `introduction`, which is the collision the fix is
	// about. Bodies differ so a mix-up is visible in the output rather than only in
	// a flag. The `### Details` under it is what the outline hides when the section
	// above it is folded.

	const docHtml = (body: string) =>
		'<h2 data-sourcepos="1:1-1:15"><a href="#introduction" aria-hidden="true" class="anchor" id="introduction"></a>Introduction</h2>\n' +
		`<p data-sourcepos="3:1-3:11">${body}</p>\n` +
		'<h3 data-sourcepos="5:1-5:11"><a href="#details" aria-hidden="true" class="anchor" id="details"></a>Details</h3>\n';

	const DOC_A = docHtml('Alpha body.');
	const DOC_B = docHtml('Beta body.');

	const FOLD_KEY = 'introduction';

	/**
	 * A callout the reader can fold, inside the section above it. comrak renders
	 * `> [!tip]+ Hint` as a blockquote whose first line carries the marker; `+`
	 * means "foldable, and open to begin with", so anything folded about it
	 * afterwards is the reader's doing and nobody else's.
	 */
	const DOC_WITH_CALLOUT =
		docHtml('Alpha body.') +
		'<blockquote data-sourcepos="7:1-8:12"><p>[!tip]+ Hint<br>the hidden text</p></blockquote>\n';

	const CALLOUT_KEY = 'callout:Hint';

	function render(html: string, path: string, folds: Set<string>): HTMLElement {
		const body = document.createElement('div');
		body.innerHTML = processMarkdownHtml(html, path, folds);
		return body;
	}

	function isSectionCollapsed(body: HTMLElement): boolean {
		return body.querySelector('.foldable-header.is-collapsed') !== null;
	}

	// ---------------------------------------------------------------- the drivers

	/**
	 * The three fold drivers, wired the way MarkdownViewer.svelte wires them.
	 *
	 * `root` is its `bind:this` on the preview article, `folds` is its `$derived`
	 * read of the active tab, and `setFolds` is the write back to that tab. What
	 * runs on top of them — flip, apply, the reveal condition, the control
	 * selector — is imported out of `foldState.ts`, which is where all of it now
	 * lives.
	 */
	type Viewer = {
		/** The table of contents' fold button, and the keyboard route. */
		toggleFold: (key: string) => void;
		/** What find asks for on its way to a match it cannot show. */
		revealFold: (key: string) => void;
		/** The preview's own fold control: a heading chevron, or a callout title. */
		clickChevron: (control: Element) => boolean;
		/** The set the viewer would hand `processMarkdownHtml` right now. */
		foldsOnScreen: () => Set<string>;
		/** Point the viewer at a rendered document, as `bind:this={markdownBody}` does. */
		showDocument: (body: HTMLElement) => void;
	};

	function buildViewer(): Viewer {
		let markdownBody: HTMLElement | null = null;

		const foldsOnScreen = () => tabManager.activeTab?.foldOverrides ?? new Set<string>();
		const host: FoldHost = {
			get root() {
				return markdownBody;
			},
			get folds() {
				return foldsOnScreen();
			},
			setFolds(next) {
				if (tabManager.activeTabId) tabManager.setTabFoldOverrides(tabManager.activeTabId, next);
			},
		};

		return {
			toggleFold: (key) => toggleFold(host, key),
			revealFold: (key) => revealFold(host, key),
			clickChevron: (control) => toggleFoldFromClick(host, control),
			foldsOnScreen,
			showDocument: (body) => {
				markdownBody = body;
			},
		};
	}

	/**
	 * The outline, mounted, over the document on screen and a caller-supplied fold
	 * set — so the filtering is Toc.svelte's own `visibleItems` and the fold keys
	 * are the ones it reads off the rendered headings.
	 */
	function tocEntries(body: HTMLElement, folds: Set<string>): string[] {
		const target = document.createElement('div');
		document.body.replaceChildren(body, target);

		const component = mount(Toc, {
			target,
			props: { markdownBody: body, contentRoot: body, previewRevision: 1, foldOverrides: new Set(folds) },
		});
		flushSync();
		const entries = Array.from(target.querySelectorAll('.toc-link')).map((el) => el.textContent!.trim());
		unmount(component);
		return entries;
	}

	/**
	 * The set the LOAD path hands the renderer, looked up at render time — one line
	 * of documentSession.svelte.ts, which does not export it.
	 *
	 * The viewer's `foldOverrides` derived (above) is what the outline and the live
	 * preview DOM read; this is what decides which sections the incoming HTML is
	 * built with `is-collapsed` already on. They are different readers of the same
	 * field and both are exercised below, because a fold leak shows up in each of
	 * them separately.
	 */
	const foldsForTab = (tabId: string): Set<string> =>
		tabManager.tabs.find((item) => item.id === tabId)?.foldOverrides ?? new Set<string>();

	// ------------------------------------------------------------------ the tests

	function reset() {
		tabManager.closeAll();
		tabManager.recentlyClosed.length = 0;
	}

	/** Open two documents that share a heading, fold it in the first, land on the second. */
	function foldInAThenSwitchToB() {
		reset();
		const app = buildViewer();

		tabManager.addTab('/notes/a.md', DOC_A);
		const a = tabManager.activeTabId!;
		tabManager.addTab('/notes/b.md', DOC_B);
		const b = tabManager.activeTabId!;

		tabManager.setActive(a);
		app.showDocument(render(DOC_A, '/notes/a.md', app.foldsOnScreen()));
		app.toggleFold(FOLD_KEY);

		tabManager.setActive(b);
		return { app, a, b };
	}

	test('folding a heading in one document does not fold the same heading in another', () => {
		const { app } = foldInAThenSwitchToB();

		const onScreen = render(DOC_B, '/notes/b.md', app.foldsOnScreen());
		assert.equal(
			isSectionCollapsed(onScreen),
			false,
			'the second document must render with its own fold state, which is none',
		);
		assert.match(onScreen.textContent!, /Beta body\./);
	});

	test('the fold is still there when the user comes back to the document they folded', () => {
		const { app, a } = foldInAThenSwitchToB();

		tabManager.setActive(a);
		assert.equal(isSectionCollapsed(render(DOC_A, '/notes/a.md', app.foldsOnScreen())), true);
	});

	test('a document opened after the fold does not open pre-folded', () => {
		// The worst version of the leak: the tab that was folded is gone, so there
		// is nothing on screen that could explain the missing section.
		const { app, a } = foldInAThenSwitchToB();
		tabManager.closeTab(a);

		tabManager.addTab('/notes/c.md', DOC_A);
		assert.equal(isSectionCollapsed(render(DOC_A, '/notes/c.md', app.foldsOnScreen())), false);
	});

	test('the table of contents hides the folded children only in the document they are folded in', () => {
		const { app, a, b } = foldInAThenSwitchToB();

		assert.deepEqual(
			tocEntries(render(DOC_B, '/notes/b.md', app.foldsOnScreen()), app.foldsOnScreen()),
			['Introduction', 'Details'],
			"the second document's table of contents must show its own children",
		);

		tabManager.setActive(a);
		assert.deepEqual(
			tocEntries(render(DOC_A, '/notes/a.md', app.foldsOnScreen()), app.foldsOnScreen()),
			['Introduction'],
			'the folded document still hides them',
		);

		tabManager.setActive(b);
		assert.equal(tocEntries(render(DOC_B, '/notes/b.md', app.foldsOnScreen()), app.foldsOnScreen()).length, 2);
	});

	test('the preview chevron folds the document on screen and no other', () => {
		// The route FindBar drives to reveal a match: it asks the fold's owner to
		// open it rather than stripping the class, so this is also what re-opens a
		// fold that is hiding a search hit.
		reset();
		const app = buildViewer();

		tabManager.addTab('/notes/a.md', DOC_A);
		const a = tabManager.activeTabId!;
		tabManager.addTab('/notes/b.md', DOC_B);
		const b = tabManager.activeTabId!;

		tabManager.setActive(a);
		const body = render(DOC_A, '/notes/a.md', app.foldsOnScreen());
		app.showDocument(body);

		const chevron = body.querySelector('.foldable-header .header-fold-icon')!;
		assert.equal(app.clickChevron(chevron), true, 'the chevron is a fold control');
		assert.equal(isSectionCollapsed(body), true, 'the click collapses the section it was in');
		assert.equal(app.foldsOnScreen().has(FOLD_KEY), true);

		tabManager.setActive(b);
		assert.equal(app.foldsOnScreen().has(FOLD_KEY), false);
		assert.equal(isSectionCollapsed(render(DOC_B, '/notes/b.md', app.foldsOnScreen())), false);

		// And back: the same chevron re-opens it, which is what reveals a find
		// match, rather than leaving a second fold state behind.
		tabManager.setActive(a);
		app.clickChevron(chevron);
		assert.equal(isSectionCollapsed(body), false);
		assert.equal(app.foldsOnScreen().has(FOLD_KEY), false);
	});

	test('a click on the heading itself is not a fold', () => {
		// `foldRegionAt` reads up to `.foldable-header`, which is the whole heading.
		// Only the chevron and a callout's title bar drive a fold; the words of a
		// heading are text the reader is allowed to select.
		reset();
		const app = buildViewer();

		tabManager.addTab('/notes/a.md', DOC_A);
		const body = render(DOC_A, '/notes/a.md', app.foldsOnScreen());
		app.showDocument(body);

		assert.equal(app.clickChevron(body.querySelector('.foldable-header')!), false);
		assert.equal(isSectionCollapsed(body), false);
		assert.equal(app.foldsOnScreen().size, 0);
	});

	test('an untitled buffer gets fold state of its own', () => {
		// Untitled tabs have no path, so nothing keyed by file could hold their
		// folds. They are also the tabs most likely to share a heading with each
		// other — every new note starts the same way.
		reset();
		const app = buildViewer();

		tabManager.addNewTab();
		const first = tabManager.activeTabId!;
		tabManager.addNewTab();
		const second = tabManager.activeTabId!;

		tabManager.setActive(first);
		app.showDocument(render(DOC_A, '', app.foldsOnScreen()));
		app.toggleFold(FOLD_KEY);

		tabManager.setActive(second);
		assert.equal(isSectionCollapsed(render(DOC_B, '', app.foldsOnScreen())), false);

		tabManager.setActive(first);
		assert.equal(isSectionCollapsed(render(DOC_A, '', app.foldsOnScreen())), true);
	});

	test('closing a tab takes its fold state with it', () => {
		reset();
		const app = buildViewer();

		tabManager.addTab('/notes/a.md', DOC_A);
		const a = tabManager.activeTabId!;
		app.showDocument(render(DOC_A, '/notes/a.md', app.foldsOnScreen()));
		app.toggleFold(FOLD_KEY);
		assert.equal(app.foldsOnScreen().has(FOLD_KEY), true);

		tabManager.closeTab(a);
		tabManager.addTab('/notes/a.md', DOC_A);
		assert.equal(app.foldsOnScreen().has(FOLD_KEY), false, 'reopening the file starts fresh');
	});

	// ------------------------------------------- the routes that swap the document
	//
	// A tab does not only change document when the user switches to another tab.
	// Three routes keep the tab and point it at a DIFFERENT file: `navigate`
	// (following a Markdown link), `goBack` and `goForward`. `loadMarkdown` then
	// renders the incoming file with `foldsForTab(activeId)` on the very next line
	// (`documentSession.svelte.ts`), so the fold keys of the document the reader
	// just LEFT decide which sections of the new one arrive shut.
	//
	// Nothing is deferred here: the HTML that first appears already carries
	// `is-collapsed`, and the outline hides the same section's children on the same
	// render. #425 gave the set a per-tab home, which fixed the tab-switch route;
	// this is the same key collision reached through the navigation route. #447
	// clears the reading position at these three sites for the same reason and
	// scoped folds out of it — a position moves the viewport, a fold hides text.

	/** Fold a heading in a.md, then follow a link to b.md, which shares the heading. */
	function foldInAThenFollowLinkTo(path: string) {
		reset();
		const app = buildViewer();

		tabManager.addTab('/notes/a.md', DOC_A);
		const id = tabManager.activeTabId!;
		app.showDocument(render(DOC_A, '/notes/a.md', app.foldsOnScreen()));
		app.toggleFold(FOLD_KEY);
		assert.equal(app.foldsOnScreen().has(FOLD_KEY), true, 'precondition: a.md has the section folded');

		tabManager.navigate(id, path);
		return { app, id };
	}

	test('following a link renders the new document with its own fold state', () => {
		const { app, id } = foldInAThenFollowLinkTo('/notes/b.md');

		const onScreen = render(DOC_B, '/notes/b.md', foldsForTab(id));
		assert.equal(
			isSectionCollapsed(onScreen),
			false,
			'the document the link led to must render with its own fold state, which is none',
		);
		assert.match(onScreen.textContent!, /Beta body\./);
		assert.equal(app.foldsOnScreen().has(FOLD_KEY), false);
	});

	test("the table of contents shows the linked document's children", () => {
		// The outline reads the same field through the viewer's derived, so it hides
		// the section's children in a document the user never folded anything in.
		const { app, id } = foldInAThenFollowLinkTo('/notes/b.md');

		assert.deepEqual(
			tocEntries(render(DOC_B, '/notes/b.md', foldsForTab(id)), app.foldsOnScreen()),
			['Introduction', 'Details'],
			'the outline must list the linked document’s own headings',
		);
	});

	/**
	 * Land on `path` with the section folded in the document currently on screen —
	 * and nothing folded before that, so the assertion cannot be satisfied by
	 * `toggleFold` merely undoing a fold that was carried in.
	 */
	function foldHereThen(app: Viewer, id: string, html: string, path: string) {
		app.showDocument(render(html, path, foldsForTab(id)));
		app.toggleFold(FOLD_KEY);
		assert.equal(app.foldsOnScreen().has(FOLD_KEY), true, `precondition: ${path} has the section folded`);
	}

	test('going back renders the previous document with its own fold state', () => {
		reset();
		const app = buildViewer();
		tabManager.addTab('/notes/a.md', DOC_A);
		const id = tabManager.activeTabId!;
		tabManager.navigate(id, '/notes/b.md');
		foldHereThen(app, id, DOC_B, '/notes/b.md');

		assert.equal(tabManager.goBack(id), '/notes/a.md');
		assert.equal(isSectionCollapsed(render(DOC_A, '/notes/a.md', foldsForTab(id))), false);
	});

	test('going forward renders that document with its own fold state', () => {
		reset();
		const app = buildViewer();
		tabManager.addTab('/notes/a.md', DOC_A);
		const id = tabManager.activeTabId!;
		tabManager.navigate(id, '/notes/b.md');
		tabManager.goBack(id);
		foldHereThen(app, id, DOC_A, '/notes/a.md');

		assert.equal(tabManager.goForward(id), '/notes/b.md');
		assert.equal(isSectionCollapsed(render(DOC_B, '/notes/b.md', foldsForTab(id))), false);
	});

	test('the tab gets a new set rather than the old one emptied', () => {
		// `Tab.foldOverrides` is replaced, never mutated: the viewer's derived
		// holds the Set itself, and Svelte cannot see a `.clear()` of a Set it is
		// already holding — the outline would keep hiding the section.
		reset();
		tabManager.addTab('/notes/a.md', DOC_A);
		const id = tabManager.activeTabId!;
		const before = foldsForTab(id);

		tabManager.navigate(id, '/notes/b.md');

		assert.notEqual(foldsForTab(id), before, 'the navigation must install a different Set');
	});

	// ------------------------------------ the routes that change only the path
	//
	// The text on screen does not change in any of these, so the folds the reader
	// put there still describe it. This is the half of the rule a blanket "clear on
	// every path write" would break — the same guard #447 keeps for the position.

	test('Save As keeps the folds, because the document on screen has not changed', () => {
		reset();
		const app = buildViewer();
		tabManager.addTab('/notes/a.md', DOC_A);
		const id = tabManager.activeTabId!;
		app.showDocument(render(DOC_A, '/notes/a.md', app.foldsOnScreen()));
		app.toggleFold(FOLD_KEY);

		tabManager.updateTabPath(id, '/notes/copy.md');

		assert.equal(tabManager.tabs.find((tab) => tab.id === id)!.path, '/notes/copy.md');
		assert.equal(isSectionCollapsed(render(DOC_A, '/notes/copy.md', foldsForTab(id))), true);
	});

	test('a link that resolves to the file already open is not a navigation', () => {
		reset();
		const app = buildViewer();
		tabManager.addTab('/notes/a.md', DOC_A);
		const id = tabManager.activeTabId!;
		app.showDocument(render(DOC_A, '/notes/a.md', app.foldsOnScreen()));
		app.toggleFold(FOLD_KEY);

		tabManager.navigate(id, '/notes/a.md');

		assert.equal(isSectionCollapsed(render(DOC_A, '/notes/a.md', foldsForTab(id))), true);
	});

	// ------------------------------------------------- the drivers of a fold
	//
	// Three affordances fold things, and until now only one of them wrote anything
	// down. The heading chevron updated the tab; the callout title toggled two
	// classes; find fired a synthetic click at the chevron and hoped the viewer's
	// delegated handler would treat it as a user. The tests below drive all three
	// against the same tab and re-render after each, because "it looked folded" is
	// exactly what the broken version also achieved.

	/** The callout title bar, which is the whole control for a foldable callout. */
	function calloutToggle(body: HTMLElement): Element {
		const toggle = body.querySelector('.callout-toggle');
		assert.ok(toggle, 'the rendered callout must have a control to click');
		return toggle;
	}

	function isCalloutCollapsed(body: HTMLElement): boolean {
		return body.querySelector('.callout-foldable.is-collapsed') !== null;
	}

	/** Open a document with a foldable callout in it and fold the callout by hand. */
	function foldTheCallout() {
		reset();
		const app = buildViewer();

		tabManager.addTab('/notes/a.md', DOC_WITH_CALLOUT);
		const id = tabManager.activeTabId!;
		const body = render(DOC_WITH_CALLOUT, '/notes/a.md', app.foldsOnScreen());
		app.showDocument(body);
		assert.equal(isCalloutCollapsed(body), false, 'precondition: `[!tip]+` opens open');

		app.clickChevron(calloutToggle(body));
		return { app, id, body };
	}

	test('a callout the reader folds is still folded after the next render', () => {
		// The defect. Split view re-renders the preview on every keystroke, so a
		// fold that lives only in the DOM lasts until the next character typed —
		// and the reader has no way to tell that the callout they closed is the
		// one that keeps coming back.
		const { app, id, body } = foldTheCallout();

		assert.equal(isCalloutCollapsed(body), true, 'the click closes it on screen');
		assert.equal(
			isCalloutCollapsed(render(DOC_WITH_CALLOUT, '/notes/a.md', foldsForTab(id))),
			true,
			'and the document re-renders with it still closed',
		);
		assert.equal(app.foldsOnScreen().has(CALLOUT_KEY), true, 'because the tab was told');
	});

	test('a callout folded in one document is not folded in another that has the same one', () => {
		// The heading half of this file, one element type over: the key is the
		// callout's title, which is unique within a document and nowhere else.
		const { app } = foldTheCallout();

		tabManager.addTab('/notes/b.md', DOC_WITH_CALLOUT);
		assert.equal(isCalloutCollapsed(render(DOC_WITH_CALLOUT, '/notes/b.md', app.foldsOnScreen())), false);
	});

	test('opening a callout the source folds shut stays open across a render', () => {
		// The mirror image, and the reason the tab stores deviations rather than
		// closures: `> [!tip]-` renders folded, so a set of "what is closed" cannot
		// tell a callout the reader OPENED from one they never touched, and the
		// next render shuts it again.
		reset();
		const app = buildViewer();
		const source = DOC_WITH_CALLOUT.replace('[!tip]+', '[!tip]-');

		tabManager.addTab('/notes/a.md', source);
		const id = tabManager.activeTabId!;
		const body = render(source, '/notes/a.md', app.foldsOnScreen());
		app.showDocument(body);
		assert.equal(isCalloutCollapsed(body), true, 'precondition: `[!tip]-` opens folded');

		app.clickChevron(calloutToggle(body));

		assert.equal(isCalloutCollapsed(body), false, 'the click opens it on screen');
		assert.equal(
			isCalloutCollapsed(render(source, '/notes/a.md', foldsForTab(id))),
			false,
			'and it is still open after a re-render',
		);
	});

	/**
	 * What FindBar.svelte does with a match it cannot show.
	 *
	 * `revealFoldsAround` is these three lines around the REAL
	 * `collapsedFoldsAround`, inside a component, so it is restated rather than
	 * imported. It used to say the same thing by building a `MouseEvent` and firing
	 * it at the fold's control — three modules coupled through a class name and a
	 * synthetic event, and a coupling no test could drive. The fold key is a string
	 * now, and `onunfold` is a function, so the two halves can be run against each
	 * other: the find bar's ancestor walk, and the viewer's write path.
	 */
	function buildFindReveal(app: Viewer, body: HTMLElement) {
		const opened: string[] = [];
		const reveal = (mark: Element) => {
			// Outermost first, so a nested fold is already on screen by the time its
			// own height is measured.
			const folds = collapsedFoldsAround(mark, body);
			for (const fold of folds) {
				opened.push(fold.key);
				app.revealFold(fold.key);
			}
			return folds.length > 0;
		};
		return { reveal, opened };
	}

	test('find opens every fold hiding a match, and the tab keeps them open', () => {
		// A match inside a collapsed callout inside a collapsed section: the text is
		// in the DOM behind `height: 0`, so find counts it and has to reveal it.
		reset();
		const app = buildViewer();

		tabManager.addTab('/notes/a.md', DOC_WITH_CALLOUT);
		const id = tabManager.activeTabId!;
		const body = render(DOC_WITH_CALLOUT, '/notes/a.md', app.foldsOnScreen());
		app.showDocument(body);

		app.clickChevron(calloutToggle(body));
		app.toggleFold(FOLD_KEY);
		assert.equal(isCalloutCollapsed(body), true);
		assert.equal(isSectionCollapsed(body), true);

		// Whatever wraps the buried text is what a find mark would sit inside.
		const buried = body.querySelector('.markdown-alert-content .content-inner');
		assert.ok(buried, 'the callout body survives folding — it is hidden, not removed');

		const { reveal, opened } = buildFindReveal(app, body);
		assert.equal(reveal(buried), true, 'find reports that it had folds to open');
		assert.deepEqual(opened, [FOLD_KEY, CALLOUT_KEY], 'outermost first');

		assert.equal(isCalloutCollapsed(body), false);
		assert.equal(isSectionCollapsed(body), false);
		assert.equal(
			isCalloutCollapsed(render(DOC_WITH_CALLOUT, '/notes/a.md', foldsForTab(id))),
			false,
			'and the next render agrees, rather than hiding the match again',
		);
	});

	test('opening a fold that is already open is not a fold', () => {
		// `revealFold` is the only driver that is not a toggle: find asks for a fold
		// to be OPEN, and asks it of every fold around a match without knowing which
		// of them were shut. Without the "only if it is collapsed" guard it would
		// fold the section it was sent to reveal — and this file drove `revealFold`
		// only through `collapsedFoldsAround`, which by construction hands it folds
		// that are already closed, so nothing here ever asked it the other question.
		reset();
		const app = buildViewer();

		tabManager.addTab('/notes/a.md', DOC_A);
		const body = render(DOC_A, '/notes/a.md', app.foldsOnScreen());
		app.showDocument(body);

		app.revealFold(FOLD_KEY);
		assert.equal(isSectionCollapsed(body), false, 'the section was open and must stay open');

		// And a key that names nothing on screen is not a fold to open either.
		app.revealFold('no-such-heading');
		assert.equal(app.foldsOnScreen().size, 0);
	});

	test('find leaves a match that is not folded away alone', () => {
		reset();
		const app = buildViewer();
		tabManager.addTab('/notes/a.md', DOC_WITH_CALLOUT);
		const body = render(DOC_WITH_CALLOUT, '/notes/a.md', app.foldsOnScreen());
		app.showDocument(body);

		const { reveal, opened } = buildFindReveal(app, body);
		assert.equal(reveal(body.querySelector('.markdown-alert-content .content-inner')!), false);
		assert.deepEqual(opened, []);
		assert.equal(app.foldsOnScreen().size, 0, 'and nothing is written down about a fold nobody touched');
	});
});

describe('outline document passes', () => {
	/**
	 * What the outline costs per render, and that the cheaper scan still reads the
	 * document the same way.
	 *
	 * `<Toc>` is handed the whole `sanitizedHtml` string, which changes on every
	 * keystroke, and it does not parse it — it uses it as the signal that the
	 * preview has been rendered and then reads the live DOM. So the cost is not a
	 * second parse of the document. It is `querySelectorAll` over the whole
	 * article, and it used to be three of those per render (headings, block
	 * anchors, and `[id]` — every element in the document that has one) plus a
	 * sort, and SIX whenever the outline actually changed, because the effect read
	 * the `items` it writes and so scheduled itself again.
	 *
	 * A render is a keystroke, and #632 brought the rest of the render down to
	 * one changed block. Counting the walks is the only way to keep this from
	 * quietly growing back, so the count is the assertion.
	 */

	/**
	 * Svelte's `slide` transition drives the Web Animations API, which jsdom does
	 * not implement. Nothing here is about the animation, so it is given something
	 * that finishes immediately.
	 */
	beforeAll(() => {
		(Element.prototype as any).animate = () => ({
			cancel() {},
			pause() {},
			play() {},
			finish() {},
			onfinish: null,
			oncancel: null,
			currentTime: 0,
			startTime: 0,
			playbackRate: 1,
			playState: 'finished',
			finished: Promise.resolve(),
			effect: { getComputedTiming: () => ({ delay: 0, duration: 0, endTime: 0 }) },
		});
	});

	afterAll(() => {
		delete (Element.prototype as any).animate;
	});

	interface Harness {
		body: HTMLElement;
		props: { markdownBody: HTMLElement; previewRevision: number };
		/** Selectors the outline ran over the whole article since the last reset. */
		passes: string[];
		render(html: string): void;
		entries(): string[];
		stop(): void;
	}

	let running: Harness | null = null;

	afterEach(() => {
		running?.stop();
		running = null;
	});

	function harness(html: string): Harness {
		const body = document.createElement('div');
		body.innerHTML = html;
		const target = document.createElement('div');
		document.body.replaceChildren(body, target);

		const passes: string[] = [];
		const queryAll = body.querySelectorAll.bind(body);
		(body as any).querySelectorAll = (selector: string) => {
			passes.push(selector);
			return queryAll(selector);
		};

		const props = runeProps({ markdownBody: body, contentRoot: body, previewRevision: 1 });
		const component = mount(Toc, { target, props });
		flushSync();

		const instance: Harness = {
			body,
			props,
			passes,
			render(next: string) {
				// The order the app does it in: the patch writes the DOM, and only
				// then does the revision say so. Bumping first would model the bug
				// this signal replaced.
				body.innerHTML = next;
				props.previewRevision += 1;
				passes.length = 0;
				flushSync();
			},
			entries: () => Array.from(target.querySelectorAll('.toc-link')).map((el) => el.textContent!.trim()),
			stop: () => unmount(component),
		};
		running = instance;
		return instance;
	}

	const heading = (level: number, id: string, text: string, line: number) =>
		`<h${level} id="${id}" data-fold-key="${id}" data-sourcepos="${line}:1-${line}:9">${text}</h${level}>`;

	const anchor = (id: string, line: number) =>
		`<a id="${id}" class="block-id-anchor" data-label="${id}" data-sourcepos="${line}:1-${line}:9"></a>`;

	/** A paragraph carrying an id, which is what made the `[id]` walk expensive. */
	const para = (id: string, text: string) => `<p id="${id}">${text}</p>`;

	describe('what one render costs the outline', () => {
		test('walks the article once when nothing about the outline changed', () => {
			const toc = harness(heading(1, 'a', 'Alpha', 1) + para('p1', 'x'));

			toc.render(heading(1, 'a', 'Alpha', 1) + para('p1', 'xy'));

			expect(toc.passes).toEqual(['h1, h2, h3, h4, h5, h6, a[id].block-id-anchor, span[id].block-id-anchor']);
		});

		test('walks it once when the outline DID change, not twice', () => {
			const toc = harness(heading(1, 'a', 'Alpha', 1) + para('p1', 'x'));

			// Renaming a heading is the edit that changes the outline, and it is also
			// the edit that changes the most blocks — the one render that could least
			// afford to scan the document a second time is the one that did.
			toc.render(heading(1, 'a', 'Alphas', 1) + para('p1', 'x'));

			expect(toc.passes.length).toBe(1);
			expect(toc.entries()).toEqual(['Alphas']);
		});
	});

	describe('the entries that one walk produces', () => {
		test('interleaves headings and block anchors in document order', () => {
			const toc = harness(
				heading(1, 'title', 'Title', 1) +
					para('p1', 'intro') +
					anchor('note', 3) +
					heading(2, 'first', 'First', 5) +
					anchor('mark', 7) +
					heading(2, 'second', 'Second', 9),
			);

			expect(toc.entries()).toEqual(['Title', 'note', 'First', 'mark', 'Second']);
		});

		test('keeps an anchor that sits inside a heading after the heading', () => {
			const toc = harness(
				`<h2 id="section" data-fold-key="section" data-sourcepos="1:1-1:9">Section${anchor('inline', 1)}</h2>`,
			);

			expect(toc.entries()).toEqual(['Section', 'inline']);
		});

		test('reads a heading the way the preview does, caret and all', () => {
			// `# E = mc^2` has no block id — the renderer requires whitespace before
			// the caret — so the outline must not strip one either.
			const toc = harness(heading(1, 'e--mc2', 'E = mc^2', 1));
			expect(toc.entries()).toEqual(['E = mc^2']);
		});

		test('drops a heading the renderer gave no id, and empties out with the document', () => {
			const toc = harness('<h2 data-sourcepos="1:1-1:9">Nameless</h2>' + heading(2, 'named', 'Named', 3));
			expect(toc.entries()).toEqual(['Named']);

			toc.render('<p>no headings at all</p>');
			expect(toc.entries()).toEqual([]);
		});
	});
});

describe('outline render signal', () => {
	/**
	 * The outline reads the preview's DOM, so it has to be told when that DOM holds
	 * the document — not when the document was rendered.
	 *
	 * Those are one step apart on a mount, and the step is not a race that usually
	 * lands the right way round: Svelte runs a child component's effects BEFORE its
	 * parent's, so `<Toc>` always scanned the article before the parent effect that
	 * fills it. Keyed on the rendered string, the outline came up empty and nothing
	 * changed that string again, so it stayed empty for the life of the component.
	 *
	 * A floating outline hid it by closing itself whenever it covered the text: the
	 * next open built a new component against a DOM that was complete by then. A
	 * pinned one never gets that remount, so it showed "no headings found" over a
	 * document full of them until it was collapsed and expanded by hand.
	 */

	const DOCUMENT = '<h1 id="one">One</h1><h2 id="two">Two</h2>';

	function harness() {
		const body = document.createElement('div');
		const target = document.createElement('div');
		document.body.replaceChildren(body, target);

		// Mount time: the article exists and is still empty, which is exactly what
		// the component sees in the flush the preview is first patched in.
		const props = runeProps({ markdownBody: body, contentRoot: body, previewRevision: 0 });
		const component = mount(Toc, { target, props });
		flushSync();

		return {
			props,
			entries: () => Array.from(target.querySelectorAll('.toc-link')).map((el) => el.textContent!.trim()),
			stop: () => unmount(component),
		};
	}

	test('a document that reaches the article after the first scan still reaches the outline', () => {
		const toc = harness();
		expect(toc.entries()).toEqual([]);

		// What the patch effect does, in its order: DOM first, then say so.
		toc.props.markdownBody!.innerHTML = DOCUMENT;
		toc.props.previewRevision = 1;
		flushSync();

		expect(toc.entries()).toEqual(['One', 'Two']);
		toc.stop();
	});
});

describe('fold layout', () => {
	afterEach(() => {
		vi.unstubAllGlobals();
		document.body.innerHTML = '';
	});

	test('fold layout observes rendered content and publishes its measured height', () => {
		// The wrapper animates `height: var(--fold-content-height)`, so it opens to
		// the height its content measures, and re-measures when that content
		// changes size (an image loading, a diagram drawing, the window narrowing).
		const frames: FrameRequestCallback[] = [];
		const observers: ResizeObserverCallback[] = [];
		vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => frames.push(callback));
		vi.stubGlobal('cancelAnimationFrame', () => {});
		vi.stubGlobal(
			'ResizeObserver',
			class {
				constructor(callback: ResizeObserverCallback) {
					observers.push(callback);
				}
				observe() {}
				disconnect() {}
			},
		);
		const runFrames = () => frames.splice(0).forEach((frame) => frame(0));

		document.body.innerHTML =
			'<div class="markdown-body"><div class="foldable-content-wrapper"><div class="content-inner"><p>x</p></div></div></div>';
		const root = document.querySelector<HTMLElement>('.markdown-body')!;
		const wrapper = root.querySelector<HTMLElement>('.foldable-content-wrapper')!;
		let height = 120;
		root.querySelector<HTMLElement>('.content-inner')!.getBoundingClientRect = () => ({ height }) as DOMRect;

		const layout = observeFoldLayout(root);
		runFrames();
		assert.equal(wrapper.style.getPropertyValue('--fold-content-height'), '120px');

		height = 200;
		for (const callback of observers) callback([], {} as ResizeObserver);
		runFrames();
		assert.equal(wrapper.style.getPropertyValue('--fold-content-height'), '200px');
		layout.stop();
	});
});

describe('fold layout observation', () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	// The fold layout used to be re-measured from the whole article on every
	// patch, and `ResizeObserver.observe` on a target it already watches
	// re-registers it and delivers a fresh observation. So a keystroke must hand
	// the observer only what the patch inserted.
	test('only newly patched blocks are handed to the fold observer', () => {
		const observed: Element[] = [];
		vi.stubGlobal('requestAnimationFrame', () => 0);
		vi.stubGlobal(
			'ResizeObserver',
			class {
				observe(target: Element) {
					observed.push(target);
				}
				disconnect() {}
			},
		);
		const host = document.createElement('div');
		document.body.replaceChildren(host);
		const doc = (last: string) =>
			[
				'<h2 data-sourcepos="1:1-1:4">A</h2>',
				'<p data-sourcepos="3:1-3:1">a</p>',
				'<h2 data-sourcepos="5:1-5:4">B</h2>',
				`<p data-sourcepos="7:1-7:1">${last}</p>`,
			].join('\0\n');
		const tab = () => ({ filePath: '/docs/a.md', foldOverrides: new Set<string>() });
		const layout = observeFoldLayout(host);

		patchHost(host, doc('b'), tab, (scope) => layout.observe(scope));
		const folds = [...host.querySelectorAll('.foldable-content-wrapper > .content-inner')];
		assert.equal(folds.length, 2);
		assert.deepEqual(new Set(observed.splice(0)), new Set(folds), 'a first render observes every fold');

		patchHost(host, doc('b, edited'), tab, (scope) => layout.observe(scope));
		const edited = [...host.querySelectorAll('p')].find((p) => p.textContent === 'b, edited')!;
		assert.ok(observed.every((target) => edited.contains(target)), 'only the edited block is observed');
		layout.stop();
	});

	/** A host with one fold, a recording ResizeObserver, and the effect following it. */
	function follow(initial: { host: 'a' | 'b' | null; shown: boolean }) {
		const observed: Element[] = [];
		let disconnects = 0;
		vi.stubGlobal('requestAnimationFrame', () => 0);
		vi.stubGlobal(
			'ResizeObserver',
			class {
				observe(target: Element) {
					observed.push(target);
				}
				disconnect() {
					disconnects++;
				}
			},
		);
		const article = document.createElement('article');
		const fold = '<div class="foldable-content-wrapper"><div class="content-inner"><p>x</p></div></div>';
		article.innerHTML = `<div id="a">${fold}</div><div id="b" style="display: none">${fold}</div>`;
		document.body.replaceChildren(article);
		const hosts = { a: article.querySelector<HTMLElement>('#a')!, b: article.querySelector<HTMLElement>('#b')! };
		const state = runeProps(initial);
		const holder: { current: FoldLayoutObservation | null } = { current: null };
		const dispose = runeEffect(() =>
			followFoldLayout(holder, () => (state.host ? hosts[state.host] : null), () => state.shown),
		);
		flushSync();
		return { state, holder, hosts, observed, disconnects: () => disconnects, dispose };
	}

	test('preview lifecycle starts and cleans up fold observation', () => {
		const run = follow({ host: 'a', shown: true });
		assert.ok(run.holder.current, 'the observation is published for the patch');
		assert.deepEqual(run.observed, [run.hosts.a.querySelector('.content-inner')]);

		// Switching tabs moves the observation to the newly visible host.
		run.state.host = 'b';
		flushSync();
		assert.equal(run.disconnects(), 1);
		assert.equal(run.observed.at(-1), run.hosts.b.querySelector('.content-inner'));

		run.dispose();
		assert.equal(run.disconnects(), 2);
		assert.equal(run.holder.current, null);
	});

	test('fold measurement pauses while the preview pane is hidden by edit mode', () => {
		assert.equal(previewPaneShown(true, false), false, 'edit mode hides the preview');
		assert.equal(previewPaneShown(true, true), true, 'split keeps it');
		assert.equal(previewPaneShown(false, false), true);

		const run = follow({ host: 'a', shown: false });
		assert.equal(run.holder.current, null);
		assert.deepEqual(run.observed, []);

		run.state.shown = true;
		flushSync();
		assert.ok(run.holder.current);
		run.state.shown = false;
		flushSync();
		assert.equal(run.holder.current, null);
		assert.equal(run.disconnects(), 1);
		run.dispose();
	});
});

describe('outline overlay placement', () => {
	test('the outline collapses itself only when it is in the way', () => {
		const settings = { previewMaxWidth: 880, previewFullWidth: false, tocSide: 'left' as const, splitEditorSide: 'left' as const, tocWidth: 240 };
		const wide = previewLayout(settings, { isEditing: false, isSplit: false, viewerWidth: 1400 });
		const narrow = previewLayout(settings, { isEditing: false, isSplit: false, viewerWidth: 1000 });
		// A window wide enough to hold the outline beside the text keeps it open.
		assert.equal(tocAutoCollapses(wide.isOverhanging, false), false);
		assert.equal(tocAutoCollapses(narrow.isOverhanging, false), true);
		// Pinned, it is a sidebar and stays.
		assert.equal(tocAutoCollapses(narrow.isOverhanging, true), false);

		// Click-outside must not fight the toggle button, which owns its own click.
		const panel = document.createElement('nav');
		const handle = panel.appendChild(document.createElement('div'));
		const toggle = document.createElement('button');
		const icon = toggle.appendChild(document.createElement('span'));
		const text = document.createElement('p');
		assert.equal(dismissesToc(icon, panel, toggle), false);
		assert.equal(dismissesToc(handle, panel, toggle), false);
		assert.equal(dismissesToc(text, panel, toggle), true);
		assert.equal(dismissesToc(null, panel, toggle), false);
	});
});

describe('outline render signal', () => {
	test('the revision is published by the patch, not by the render', () => {
		// A signal derived from the rendered string rather than from the write to
		// the DOM is the bug: on a mount the outline scanned an article the patch
		// had not filled yet, and the string never changed again to make it look.
		const state = runeProps({ host: null as HTMLElement | null, html: '<h1>One</h1>' });
		let published: { readonly revision: number } | null = null;
		const seen: string[] = [];
		const dispose = runeEffect(() => {
			published = followPreviewPatch(
				() => state.host,
				() => state.html,
				(host, html) => (host.innerHTML = html),
			);
		});
		flushSync();
		const revision = () => published!.revision;
		const watch = runeEffect(() => {
			void revision();
			seen.push(state.host?.textContent ?? '');
		});
		flushSync();
		onTestFinished(() => (watch(), dispose()));

		state.html = '<h1>Two</h1>';
		flushSync();
		assert.equal(revision(), 0, 'a render with nowhere to patch it publishes nothing');

		state.host = document.createElement('article');
		flushSync();
		assert.equal(revision(), 1);
		assert.equal(seen.at(-1), 'Two', 'once published, the article already holds the document');

		state.html = '<h1>Three</h1>';
		flushSync();
		assert.equal(revision(), 2);
		assert.equal(seen.at(-1), 'Three');
	});
});
