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

import assert from 'node:assert/strict';

import { flushSync, mount, unmount } from 'svelte';
import { beforeAll, test } from 'vitest';

import Toc from '../src/lib/components/Toc.svelte';
import {
	collapsedFoldsAround,
	revealFold,
	toggleFold,
	toggleFoldFromClick,
	type FoldHost,
} from '../src/lib/utils/foldState.js';

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

test('renaming the file on disk keeps the folds', () => {
	reset();
	const app = buildViewer();
	tabManager.addTab('/notes/a.md', DOC_A);
	const id = tabManager.activeTabId!;
	app.showDocument(render(DOC_A, '/notes/a.md', app.foldsOnScreen()));
	app.toggleFold(FOLD_KEY);

	tabManager.renameTab(id, '/notes/renamed.md');

	assert.equal(tabManager.tabs.find((tab) => tab.id === id)!.path, '/notes/renamed.md');
	assert.equal(isSectionCollapsed(render(DOC_A, '/notes/renamed.md', foldsForTab(id))), true);
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
