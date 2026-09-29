import assert from 'node:assert/strict';

import { test } from 'vitest';

import { offsetOf, readSource, sliceBetween, sliceFrom } from './sourceTree.js';
import { sourceAtPoint } from '../src/lib/utils/previewCursor.js';
import ts from 'typescript';

// Issue #168, second report by @dayeggpi: "allow user to switch to rendered
// view without saving/creating file ... no way to see rendered view until file
// is saved".
//
// The cause was that reading mode was drawn from DISK: leaving the editor
// called `loadMarkdown(tab.path)`, so a dirty tab had to be flushed first —
// silently with auto-save on, through a modal otherwise — or the reader would
// have shown the pre-edit file. The modal was never protecting the buffer; the
// buffer survives a view toggle. It was protecting the screen from lying.
//
// These tests run the REAL `toggleEdit` / `toggleSplitView` / the real
// `renderTabPreviewFromRaw` out of MarkdownViewer.svelte against the real
// TabManager, with the disk, the renderer and the modal faked. `loadMarkdown`
// is faked to behave like the real one (dirty short-circuit included) and to
// serve a DIFFERENT text than the buffer, so any route that goes back to the
// file is visible in the rendered output rather than merely in the call log.
//
// The boundary tests at the bottom are the other half of the argument: closing
// a tab and closing the window still ask, because there the buffer really is
// about to disappear.

// ---------------------------------------------------------------- environment

// The runes are the compiler's, not ours: vitest builds `.svelte.ts` through the
// Svelte plugin, so the store and the session run under real reactivity, and jsdom
// supplies `window` and `localStorage`. Only the Tauri backend is stubbed.
(window as any).__TAURI_INTERNALS__ = {
	metadata: { currentWindow: { label: 'main' }, currentWebview: { windowLabel: 'main', label: 'main' } },
	invoke: () => Promise.reject(new Error('no invoke expected in these tests')),
};

const { tabManager } = await import('../src/lib/stores/tabs.svelte.js');
const { settings } = await import('../src/lib/stores/settings.svelte.js');
const { createDocumentSession } = await import('../src/lib/sessions/documentSession.svelte.js');

const viewer = readSource('src/lib/MarkdownViewer.svelte');

// ------------------------------------------------------------ source plucking

/**
 * Slice one `async function <name>(...) { ... }` out of the component.
 *
 * Brace counting, but string/template/comment aware — a naive count trips over
 * the first `{` inside a comment or a template literal and silently returns a
 * body that stops in the middle, which would make every assertion below
 * meaningless in exactly the direction that hides bugs.
 */
function pluck(name: string, required = true): string {
	const asyncStart = viewer.indexOf(`async function ${name}(`);
	const syncStart = viewer.indexOf(`\tfunction ${name}(`);
	const start = asyncStart !== -1 ? asyncStart : syncStart === -1 ? -1 : syncStart + 1;
	if (start === -1) {
		assert.ok(!required, `expected MarkdownViewer.svelte to define ${name}`);
		return '';
	}
	let i = offsetOf(viewer, '{', offsetOf(viewer, ')', start));
	let depth = 0;
	for (; i < viewer.length; i++) {
		const c = viewer[i];
		const next = viewer[i + 1];
		if (c === '/' && next === '/') {
			i = viewer.indexOf('\n', i);
			continue;
		}
		if (c === '/' && next === '*') {
			i = viewer.indexOf('*/', i) + 1;
			continue;
		}
		if (c === "'" || c === '"' || c === '`') {
			const quote = c;
			for (i++; i < viewer.length; i++) {
				if (viewer[i] === '\\') i++;
				else if (viewer[i] === quote) break;
			}
			continue;
		}
		if (c === '{') depth++;
		else if (c === '}' && --depth === 0) return viewer.slice(start, i + 1);
	}
	assert.fail(`unbalanced braces while slicing ${name}`);
}

type Harness = {
	toggleEdit: () => Promise<void>;
	toggleSplitView: (tabId: string) => Promise<void>;
};

type Fakes = {
	disk: Map<string, string>;
	askCustomCalls: string[];
	saveCalls: string[];
	loadCalls: string[];
	renderedFrom: Array<{ raw: string; path: string }>;
	toasts: string[];
	saveFails: boolean;
	/** Text the "user" appends while `saveContent` is awaiting (TOCTOU). */
	typeDuringSave: string;
};

/** `renderMarkdownPreview`'s stand-in: the output names what it was given. */
const rendered = (raw: string, path: string) => `<html path="${path}">${raw}</html>`;

function buildHarness(fakes: Fakes, isEditing: boolean, panes: Record<string, unknown> = {}): Harness {
	const source = [
		pluck('renderTabPreviewFromRaw'),
		// Absent on the pre-fix baseline, where both toggles inline their own
		// save/modal flow. Optional so this file runs — and fails on behaviour
		// rather than on a missing symbol — against either version.
		pluck('flushBeforeLeavingEditableMode', false),
		pluck('renderPreviewLeavingEditableMode', false),
		pluck('toggleEdit'),
		pluck('toggleSplitView'),
	].join('\n\n');

	const js = ts.transpileModule(source, {
		compilerOptions: { target: ts.ScriptTarget.ES2022 },
	}).outputText;

	const factory = new Function(
		'deps',
		`"use strict";
		const {
			tabManager, settings, t, addToast, askCustom, saveSilently, externalChangeConflicts,
			cancelPendingAutoSave, renderMarkdownPreview, loadMarkdown,
			documentSession, invoke, isEditing, liveMode, toggleLiveMode,
			tick, renderRichContent, editorPane, markdownBody,
			getPreviewScrollSyncPosition, restoreAfterLeavingEditor,
		} = deps;
		let previewPlacing = false;
		${js}
		return { toggleEdit, toggleSplitView };`,
	);

	return factory({
		tabManager,
		settings,
		isEditing,
		externalChangeConflicts: {},
		t: (key: string) => key,
		addToast: (message: string) => fakes.toasts.push(message),
		askCustom: async (message: string) => {
			fakes.askCustomCalls.push(message);
			return 'save' as const;
		},
		// Mirrors documentSession.saveContent for a tab that has a path.
		saveSilently: async (tabId: string) => {
			fakes.saveCalls.push(tabId);
			const tab = tabManager.tabs.find((item) => item.id === tabId)!;
			if (fakes.saveFails) return false;
			const snapshot = tab.rawContent;
			await Promise.resolve();
			if (fakes.typeDuringSave) tab.rawContent = snapshot + fakes.typeDuringSave;
			fakes.disk.set(tab.path, snapshot);
			tab.originalContent = snapshot;
			return true;
		},
		cancelPendingAutoSave: () => {},
		renderMarkdownPreview: async (raw: string, path: string) => {
			fakes.renderedFrom.push({ raw, path });
			return rendered(raw, path);
		},
		// The disk route, with the real function's dirty short-circuit.
		loadMarkdown: async (path: string, options: any = {}) => {
			fakes.loadCalls.push(path);
			const activeId = tabManager.activeTabId!;
			const receiving = tabManager.tabs.find((item) => item.id === activeId)!;
			if (receiving.isDirty && receiving.path === path && !options.discardUnsavedBuffer) return;
			const content = fakes.disk.get(path) ?? '';
			fakes.renderedFrom.push({ raw: content, path });
			tabManager.updateTabContent(activeId, rendered(content, path));
			tabManager.setTabRawContent(activeId, content);
		},
		documentSession: { ensureFullContent: async () => true, isLossySaveRefused: () => false },
		invoke: async () => {
			throw new Error('no invoke expected while leaving an editable pane');
		},
		liveMode: false,
		toggleLiveMode: () => {},
		tick: async () => {},
		renderRichContent: () => {},
		// No panes unless a test asks: where the reader lands (#799) is not
		// what the rest of this file is about.
		editorPane: undefined,
		markdownBody: undefined,
		...panes,
	});
}

function freshFakes(): Fakes {
	return {
		disk: new Map(),
		askCustomCalls: [],
		saveCalls: [],
		loadCalls: [],
		renderedFrom: [],
		toasts: [],
		saveFails: false,
		typeDuringSave: '',
	};
}

const ON_DISK = '# saved heading\n';
const IN_BUFFER = '# saved heading\n\nan edit that was never written to disk\n';

/**
 * A tab holding unsaved edits to a real file, in whichever editable pane the
 * caller names, with the file on disk still carrying the pre-edit text.
 */
function dirtyTab(mode: 'edit' | 'split', path = '/notes/note.md') {
	tabManager.closeAll();
	const fakes = freshFakes();
	fakes.disk.set(path, ON_DISK);
	tabManager.addTab(path);
	const tab = tabManager.activeTab!;
	tabManager.setTabRawContent(tab.id, ON_DISK);
	tab.isEditing = mode === 'edit';
	tabManager.setSplitEnabled(tab.id, mode === 'split');
	tabManager.updateTabRawContent(tab.id, IN_BUFFER);
	assert.equal(tab.isDirty, true, 'precondition: the tab is dirty');
	return { tab, fakes, harness: buildHarness(fakes, mode === 'edit') };
}

/**
 * `autoSave` used to be half of a pair — the other, `confirmBeforeSave`, could
 * veto it, and every decision in the app read `autoSave && !confirmBeforeSave`.
 * The pair is now the one switch that expression always described, so the two
 * old combinations that meant "do not write silently" are the single `false`
 * here.
 */
function setSettings(autoSave: boolean) {
	settings.autoSave = autoSave;
}

// ------------------------------------------------------- leaving edit mode

test('a dirty file switches to reading mode without a modal and without writing', async () => {
	setSettings(false);
	const { tab, fakes, harness } = dirtyTab('edit');

	await harness.toggleEdit();

	assert.deepEqual(fakes.askCustomCalls, [], 'no unsaved-changes modal on a view toggle');
	assert.deepEqual(fakes.saveCalls, [], 'nothing is written to disk');
	assert.equal(fakes.disk.get(tab.path), ON_DISK, 'the file is untouched');
	assert.equal(tab.isEditing, false, 'the user actually reaches reading mode');
	assert.equal(tab.isDirty, true, 'the edits are still unsaved, and still flagged as such');
	assert.equal(tab.rawContent, IN_BUFFER, 'the buffer is intact');
});

test('reading mode shows the buffer, not the file', async () => {
	setSettings(false);
	const { tab, harness, fakes } = dirtyTab('edit');

	await harness.toggleEdit();

	// The whole point of the bug: with a disk read here, this is `ON_DISK`.
	assert.equal(tab.content, rendered(IN_BUFFER, tab.path));
	assert.deepEqual(
		fakes.renderedFrom,
		[{ raw: IN_BUFFER, path: tab.path }],
		'the preview is rendered once, from the buffer, under the tab\'s own path',
	);
	assert.deepEqual(fakes.loadCalls, [], 'the file is not re-read to leave the editor');
});

test('an untitled buffer never reaches the Save dialog on a view toggle', async () => {
	setSettings(true);
	tabManager.closeAll();
	const fakes = freshFakes();
	tabManager.addTab('');
	const tab = tabManager.activeTab!;
	tab.isEditing = true;
	tabManager.updateTabRawContent(tab.id, '# untitled\n');
	const harness = buildHarness(fakes, true);

	await harness.toggleEdit();

	assert.deepEqual(fakes.saveCalls, [], 'saveContent would open the Save dialog for a pathless tab');
	assert.equal(tab.isEditing, false);
	assert.equal(tab.content, rendered('# untitled\n', ''));
});

test('auto-save still flushes on the way out, because the debounce is about to be dropped', async () => {
	// The auto-save effect requires `isEditing || isSplit`, so this is the last
	// chance to honour "save automatically" for these edits.
	setSettings(true);
	const { tab, fakes, harness } = dirtyTab('edit');

	await harness.toggleEdit();

	assert.deepEqual(fakes.saveCalls, [tab.id]);
	assert.equal(fakes.disk.get(tab.path), IN_BUFFER, 'the flush actually wrote the buffer');
	assert.deepEqual(fakes.askCustomCalls, [], 'the flush is silent — it is the user\'s own setting');
	assert.equal(tab.isDirty, false);
	assert.equal(tab.isEditing, false);
	assert.equal(tab.content, rendered(IN_BUFFER, tab.path));
});

test('a file that cannot be written no longer traps the user in the editor', async () => {
	// Read-only path, or a buffer the lossy-decode guard refuses: saveContent
	// returns false forever, and the old code returned early on that, so
	// reading mode was unreachable for the life of the tab.
	setSettings(true);
	const { tab, fakes, harness } = dirtyTab('edit');
	fakes.saveFails = true;

	await harness.toggleEdit();

	assert.deepEqual(fakes.saveCalls, [tab.id], 'the flush was attempted');
	assert.ok(fakes.toasts.includes('toast.autoSaveFailed'), 'and the failure was reported');
	assert.equal(tab.isEditing, false, 'but the view still switches');
	assert.equal(tab.content, rendered(IN_BUFFER, tab.path));
	assert.equal(tab.isDirty, true, 'the buffer is still there to be rescued');
});

test('edits typed during the flush are shown, and reported as not yet on disk', async () => {
	setSettings(true);
	const { tab, fakes, harness } = dirtyTab('edit');
	fakes.typeDuringSave = 'typed while saving\n';

	await harness.toggleEdit();

	assert.equal(tab.isDirty, true);
	assert.ok(fakes.toasts.includes('toast.savedNewerEdits'), 'the disk is one revision behind');
	assert.equal(tab.isEditing, false, 'the TOCTOU case is no longer a reason to stay in the editor');
	assert.equal(
		tab.content,
		rendered(IN_BUFFER + 'typed while saving\n', tab.path),
		'the preview shows the newest text, which is exactly what is NOT on disk',
	);
});

// --------------------------------------------------- closing the split view

test('closing split view on a dirty file neither asks nor writes', async () => {
	setSettings(false);
	const { tab, fakes, harness } = dirtyTab('split');

	await harness.toggleSplitView(tab.id);

	assert.deepEqual(fakes.askCustomCalls, []);
	assert.deepEqual(fakes.saveCalls, []);
	assert.deepEqual(fakes.loadCalls, []);
	assert.equal(fakes.disk.get(tab.path), ON_DISK, 'the file is untouched');
	assert.equal(tab.isSplit, false);
	assert.equal(tab.isDirty, true);
	assert.equal(tab.content, rendered(IN_BUFFER, tab.path), 'the surviving pane keeps showing the buffer');
});

test('closing split view honours auto-save the same way leaving edit mode does', async () => {
	setSettings(true);
	const { tab, fakes, harness } = dirtyTab('split');

	await harness.toggleSplitView(tab.id);

	assert.deepEqual(fakes.saveCalls, [tab.id]);
	assert.deepEqual(fakes.askCustomCalls, []);
	assert.equal(tab.isSplit, false);
	assert.equal(tab.content, rendered(IN_BUFFER, tab.path));
});

// ------------------------------------------------------------- the boundary
//
// A view toggle keeps the buffer, so it may stay quiet. These two do not: the
// buffer is about to be destroyed, and that is the difference the fix rests
// on. They pass before and after — they are the fence, not the repro.

function makeSession(askClose: (title: string) => Promise<'save' | 'discard' | 'cancel'>) {
	return createDocumentSession({
		setShowHome: () => {},
		currentFile: () => tabManager.activeTab?.path ?? '',
		resetScrollHistory: () => {},
		renderMarkdown: async (raw: string) => `<p>${raw.length}</p>`,
		afterLoad: async () => {},
		saveRecentFile: () => {},
		deleteRecentFile: () => {},
		setLoadingTabs: () => {},
		measureInitialViewport: () => {},
		isScrolling: () => false,
		renderRichContent: () => {},
		onError: () => {},
		onDiskChangedUnderSave: () => {},
		cancelPendingAutoSave: () => {},
		askClose,
		onCloseSaveNewerEdits: () => {},
		onCloseAutoSaveFailed: () => {},
		onPartialCopySaved: () => {},
	});
}

test('closing a tab with unsaved edits still asks, and Cancel still keeps it open', async () => {
	setSettings(false);
	tabManager.closeAll();
	tabManager.addTab('/notes/note.md');
	const tab = tabManager.activeTab!;
	tabManager.setTabRawContent(tab.id, ON_DISK);
	tabManager.updateTabRawContent(tab.id, IN_BUFFER);

	const asked: string[] = [];
	const session = makeSession(async (title) => {
		asked.push(title);
		return 'cancel';
	});

	assert.equal(await session.canCloseTab(tab.id), false);
	assert.equal(asked.length, 1, 'the close dialog is where the buffer is really at stake');
	assert.equal(tab.rawContent, IN_BUFFER);
});

test('closing the window still reviews unsaved tabs', () => {
	// The close handler is where the buffer is really at stake: it dies with
	// the window. Source-level, because it is wired to a Tauri window event.
	// Quit goes through the same handler now — `appExit` closes windows and
	// decides nothing about their buffers (#390).
	const exit = pluck('appExit');
	assert.doesNotMatch(exit, /askCustom/, 'quit asks nothing of its own; the close handler does the asking');

	const closeHandler = sliceBetween(viewer, 'appWindow.onCloseRequested', 'onDragDropEvent');
	assert.match(closeHandler, /await settleForExit\(\)/, 'the close still runs the review');
	assert.match(pluck('settleForExit'), /canCloseTab,\n/, 'the walk still runs the per-tab dialog');
});

test('the view toggles no longer re-read the file to leave an editable pane', () => {
	// Belt and braces for the behaviour above: neither toggle may reach for
	// the disk again. `renderTabPreviewFromRaw` is the shared "render THIS
	// tab's buffer under its own path" helper (it also serves the PDF export).
	const toggleEdit = pluck('toggleEdit');
	const leaveEditMode = toggleEdit.slice(0, offsetOf(toggleEdit, '// Switch to edit'));
	assert.doesNotMatch(leaveEditMode, /loadMarkdown/);
	assert.doesNotMatch(leaveEditMode, /askCustom/);

	const toggleSplit = pluck('toggleSplitView');
	const closeSplit = sliceFrom(toggleSplit, 'setSplitEnabled(tab.id, false)');
	assert.doesNotMatch(closeSplit, /loadMarkdown/);
	assert.doesNotMatch(toggleSplit, /askCustom/);
});

// ------------------------------------------------ where the reader lands (#799)

test('Ctrl+E hands each pane the line the other one was showing', async () => {
	setSettings(false);
	const { tab, fakes } = dirtyTab('edit');
	const fromEditor = { section: 'body', ratio: 0.4, line: 120 };
	const fromPreview = { section: 'body', ratio: 0.7, line: 300 };
	const synced: unknown[] = [];
	const restored: unknown[] = [];
	const panes = {
		editorPane: {
			scrollSyncPosition: () => fromEditor,
			syncScrollToPosition: (position: unknown) => synced.push(position),
		},
		markdownBody: {},
		getPreviewScrollSyncPosition: () => fromPreview,
		restoreAfterLeavingEditor: (_id: string, position: unknown) => restored.push(position),
	};

	await buildHarness(fakes, true, panes).toggleEdit();
	assert.equal(tab.isEditing, false);
	assert.deepEqual(restored, [fromEditor], 'the preview was not sent to the editor\'s line');

	await buildHarness(fakes, false, panes).toggleEdit();
	assert.equal(tab.isEditing, true);
	assert.deepEqual(synced, [fromPreview], 'the editor was not sent to the preview\'s line');
});

test('Ctrl+E brings the cursor on screen only when the outline follows it', async () => {
	// An outline marking the cursor's heading while the editor shows another
	// one reads as wrong, so with 'cursor' the handoff moves a cursor left off
	// screen. With 'scroll' the outline never looks at the cursor, and moving
	// it would only lose the reader's place.
	const asked: unknown[] = [];
	for (const follows of ['cursor', 'scroll'] as const) {
		settings.tocFollows = follows;
		const { tab, fakes } = dirtyTab('edit');
		tab.isEditing = false;
		await buildHarness(fakes, false, {
			editorPane: { syncScrollToPosition: (_position: unknown, options: unknown) => asked.push(options) },
			markdownBody: {},
			getPreviewScrollSyncPosition: () => ({ section: 'body', ratio: 0.5, line: 40 }),
		}).toggleEdit();
	}
	settings.tocFollows = 'scroll';
	assert.deepEqual(asked, [{ cursorIntoView: true }, { cursorIntoView: false }]);
});

// Scroll sync is split view's. The tab keeps `isScrollSynced` after the split
// closes, and out of split the other pane is still mounted at zero width, so
// syncing through it dragged the visible pane off its line on every Ctrl+E.
function buildSyncHarness(panes: Record<string, unknown>) {
	const source = [
		pluck('handleEditorScrollSync'),
		pluck('splitScrollSyncOn', false),
		pluck('syncEditorToPreviewScroll'),
		pluck('restoreAfterLeavingEditor'),
		pluck('followToc'),
		pluck('handleEditorCursor'),
		pluck('placePreviewCursor'),
	].join('\n\n');
	const js = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
	const factory = new Function(
		'deps',
		`"use strict";
		const {
			tabManager, tick, viewerPaneEl, markdownBody, editorPane, lineCoords,
			tabAnchorForEditorTopLine, asBufferLine, scrollPreviewToSyncPosition,
			getPreviewScrollSyncPosition, getPreviewScrollAnchor, settings, hasEditorPane, hasPreviewPane, isEditing, isSplit,
			previewBlocks, sourceAtPoint, readRendererLine,
		} = deps;
		let tocActiveLine = null;
		let previewPlacing = false;
		const cursorByTab = {};
		const activeCursor = deps.activeCursor ?? null;
		${js}
		return {
			handleEditorScrollSync, syncEditorToPreviewScroll, restoreAfterLeavingEditor, handleEditorCursor, followToc, placePreviewCursor,
			toc: () => tocActiveLine,
			cursors: () => cursorByTab,
			startPlacing: () => { previewPlacing = true; },
		};`,
	);
	return factory({
		tabManager,
		tick: async () => {},
		viewerPaneEl: undefined,
		markdownBody: {},
		lineCoords: { toRendererLine: (line: number) => line - 3, toBufferLine: (line: number) => line + 3 },
		settings,
		hasEditorPane: false,
		hasPreviewPane: true,
		isEditing: false,
		isSplit: false,
		tabAnchorForEditorTopLine: (_coords: unknown, line: number) => line,
		asBufferLine: (line: number) => line,
		getPreviewScrollSyncPosition: () => ({ section: 'body', ratio: 0.5, line: 40 }),
		...panes,
	});
}

test('scroll sync left on in split view stays off once the split closes', async () => {
	tabManager.closeAll();
	tabManager.addTab('/notes/note.md');
	const tab = tabManager.activeTab!;
	tabManager.setSplitEnabled(tab.id, true);
	if (!tab.isScrollSynced) tabManager.toggleScrollSync(tab.id);
	const toPreview: unknown[] = [];
	const toEditor: unknown[] = [];
	const harness = buildSyncHarness({
		scrollPreviewToSyncPosition: (position: unknown) => toPreview.push(position),
		editorPane: { syncScrollToPosition: (position: unknown) => toEditor.push(position) },
	});
	const position = { section: 'body', ratio: 0.5, line: 40 };

	harness.handleEditorScrollSync(position);
	harness.syncEditorToPreviewScroll({});
	assert.equal(toPreview.length, 1, 'precondition: split view syncs the preview');
	assert.equal(toEditor.length, 1, 'precondition: split view syncs the editor');

	tabManager.setSplitEnabled(tab.id, false);
	tab.isEditing = true;
	assert.equal(tab.isScrollSynced, true, 'the tab still remembers the choice');

	harness.handleEditorScrollSync(position);
	harness.syncEditorToPreviewScroll({});
	assert.equal(toPreview.length, 1, 'the hidden preview was scrolled from the editor');
	assert.equal(toEditor.length, 1, 'the editor was scrolled from the hidden preview');
	assert.equal(harness.toc(), 40, 'the outline still follows the editor');
});

test('leaving the editor moves the outline to the line the preview lands on', async () => {
	tabManager.closeAll();
	tabManager.addTab('/notes/note.md');
	const tab = tabManager.activeTab!;
	tab.isEditing = false;
	const harness = buildSyncHarness({
		scrollPreviewToSyncPosition: () => {},
		getPreviewScrollAnchor: () => 57,
	});

	await harness.restoreAfterLeavingEditor(tab.id, { section: 'body', ratio: 0.5, line: 58 });

	assert.equal(tab.anchorLine, 57);
	assert.equal(harness.toc(), 57, 'the outline kept the entry from before the switch');
});

// #799: "the table of contents should follow the cursor". An editor setting,
// because only the editor has one: the preview alone always follows the scroll.
describeOutlineSource('cursor', true, (h) => {
	h.handleEditorCursor(20, 1);
	assert.equal(h.toc(), 17, 'the cursor line, in the outline\'s numbering');
	h.handleEditorScrollSync({ section: 'body', ratio: 0.5, line: 60 });
	assert.equal(h.toc(), 17, 'scrolling the editor left it on the cursor');
	h.handleEditorCursor(30, 1);
	assert.equal(h.toc(), 27);
});

describeOutlineSource('cursor', false, async (h) => {
	h.handleEditorCursor(20, 1);
	assert.equal(h.toc(), null, 'no editor on screen, so no cursor to follow');
	await h.restoreAfterLeavingEditor(tabManager.activeTab!.id, { section: 'body', ratio: 0.5, line: 58 });
	assert.equal(h.toc(), 57, 'the preview alone follows its scroll');
});

describeOutlineSource('scroll', true, (h) => {
	h.handleEditorCursor(20, 1);
	assert.equal(h.toc(), null, 'the default ignores the cursor');
	h.handleEditorScrollSync({ section: 'body', ratio: 0.5, line: 60 });
	assert.equal(h.toc(), 60);
	// The editor alone keeps the preview mounted at zero width, and its
	// scroll events put the outline on a heading from that layout.
	h.followToc('preview', 90);
	assert.equal(h.toc(), 60, 'the hidden preview moved the outline');
});

function describeOutlineSource(
	follows: 'cursor' | 'scroll',
	editorOnScreen: boolean,
	run: (harness: ReturnType<typeof buildSyncHarness>) => void | Promise<void>,
) {
	test(`the outline follows the ${follows} setting with the editor ${editorOnScreen ? 'on' : 'off'} screen`, async () => {
		tabManager.closeAll();
		tabManager.addTab('/notes/note.md');
		tabManager.activeTab!.isEditing = editorOnScreen;
		settings.tocFollows = follows;
		try {
			await run(buildSyncHarness({
				hasEditorPane: editorOnScreen,
				hasPreviewPane: !editorOnScreen,
				isEditing: editorOnScreen,
				scrollPreviewToSyncPosition: () => {},
				getPreviewScrollAnchor: () => 57,
			}));
		} finally {
			settings.tocFollows = 'scroll';
		}
	});
}

test('the preview does not move the outline after Ctrl+E until it is placed', async () => {
	// Its scroll events before that report the old position, and the outline
	// flashed the first headings until the preview was placed.
	tabManager.closeAll();
	tabManager.addTab('/notes/note.md');
	const tab = tabManager.activeTab!;
	tab.isEditing = false;
	const harness = buildSyncHarness({ scrollPreviewToSyncPosition: () => {}, getPreviewScrollAnchor: () => 57 });

	harness.handleEditorScrollSync({ section: 'body', ratio: 0.5, line: 40 });
	harness.startPlacing();
	harness.followToc('preview', 2);
	assert.equal(harness.toc(), 40, 'an unplaced preview put the outline on its own line');

	await harness.restoreAfterLeavingEditor(tab.id, { section: 'body', ratio: 0.5, line: 58 });
	assert.equal(harness.toc(), 57, 'the placed preview decides');
	harness.followToc('preview', 60);
	assert.equal(harness.toc(), 60, 'and keeps deciding once placed');
});

test('reading with a cursor placed, the outline stays on it while the preview scrolls', () => {
	tabManager.closeAll();
	tabManager.addTab('/notes/note.md');
	tabManager.activeTab!.isEditing = false;
	settings.tocFollows = 'cursor';
	try {
		const withCursor = buildSyncHarness({ activeCursor: { line: 20, column: 3 }, hasEditorPane: false });
		withCursor.followToc('cursor', 17);
		withCursor.followToc('preview', 90);
		assert.equal(withCursor.toc(), 17, 'the preview scroll moved the outline off the cursor');

		const without = buildSyncHarness({ hasEditorPane: false });
		without.followToc('preview', 90);
		assert.equal(without.toc(), 90, 'with no cursor yet, the outline follows the scroll');
	} finally {
		settings.tocFollows = 'scroll';
	}
});

test('a click in the preview places the cursor only with its setting on, whatever the outline follows', () => {
	// #799: the shared cursor is an editing aid in its own right, so Ctrl+E
	// lands on the clicked character in either outline mode. The drawn caret
	// is visual noise to some readers, so the whole aid is off by default.
	const root = document.createElement('div');
	root.innerHTML = '<p data-sourcepos="2:1-2:11">hello world</p>';
	const text = root.querySelector('p')!.firstChild!;
	(document as any).caretRangeFromPoint = () => {
		const range = document.createRange();
		range.setStart(text, 6);
		return range;
	};
	tabManager.closeAll();
	tabManager.addTab('/notes/note.md');
	const tab = tabManager.activeTab!;
	tab.isEditing = false;
	const click = () => {
		const harness = buildSyncHarness({
			previewBlocks: root,
			sourceAtPoint,
			readRendererLine: (line: number) => (line === 2 ? 'hello world' : ''),
			activeCursor: { line: 5, column: 7 },
		});
		harness.placePreviewCursor({ detail: 1, clientX: 0, clientY: 0 } as MouseEvent);
		return harness;
	};
	try {
		settings.tocFollows = 'cursor';
		const off = click();
		assert.deepEqual(off.cursors(), {}, 'off by default: the click leaves the cursor alone');
		assert.equal(off.toc(), null);

		settings.previewCursor = true;
		for (const follows of ['scroll', 'cursor'] as const) {
			settings.tocFollows = follows;
			const harness = click();
			assert.deepEqual(harness.cursors()[tab.id], { line: 5, column: 7 }, `${follows}: the click placed the cursor on the "w"`);
			assert.equal(harness.toc(), follows === 'cursor' ? 2 : null, `${follows}: the outline`);
		}
	} finally {
		settings.tocFollows = 'scroll';
		settings.previewCursor = false;
		delete (document as any).caretRangeFromPoint;
	}
});
