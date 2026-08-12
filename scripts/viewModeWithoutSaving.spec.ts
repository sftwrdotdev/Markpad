import assert from 'node:assert/strict';

import { test } from 'vitest';

import { offsetOf, readSource, sliceBetween, sliceFrom } from './sourceTree.js';
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
	const marker = `async function ${name}(`;
	const start = viewer.indexOf(marker);
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

function buildHarness(fakes: Fakes, isEditing: boolean): Harness {
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
			tabManager, settings, t, addToast, askCustom, saveContent,
			cancelPendingAutoSave, renderMarkdownPreview, loadMarkdown,
			documentSession, invoke, isEditing, liveMode, toggleLiveMode,
			tick, renderRichContent,
		} = deps;
		${js}
		return { toggleEdit, toggleSplitView };`,
	);

	return factory({
		tabManager,
		settings,
		isEditing,
		t: (key: string) => key,
		addToast: (message: string) => fakes.toasts.push(message),
		askCustom: async (message: string) => {
			fakes.askCustomCalls.push(message);
			return 'save' as const;
		},
		// Mirrors documentSession.saveContent for a tab that has a path.
		saveContent: async (tabId: string) => {
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
		selfWriteGraceMs: 400,
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
	// `appExit` and the window close handler are untouched by this change; the
	// confirmation there is load-bearing because the buffer dies with the
	// window. Source-level, because they are wired to Tauri window events.
	//
	// `pluck` rather than an anchor pair: the previous end anchor was
	// `'async function toggleEdit'`, which is 969 lines below a 16-line
	// function, so both assertions below were satisfied by anything anywhere in
	// that span. Measured — the review moved verbatim into a helper 20 lines
	// down that nobody calls, `appExit` reduced to `appWindow.close()`, whole
	// suite green.
	const exit = pluck('appExit');
	assert.match(exit, /tabManager\.tabs\.some\(\(t\) => t\.isDirty \|\| \(t\.path === '' && t\.rawContent\.trim\(\) !== ''\)\)/);
	assert.match(exit, /modal\.areYouSureYouWantToExit/);
	// And the answer has to be acted on. Asking and then closing anyway loses
	// the same buffer the dialog exists to protect; the identifier is left
	// unpinned because which local holds the answer is not the contract.
	assert.match(exit, /if \(\w+ !== 'discard'\) return;/, "an answer other than 'discard' stops the exit");

	const closeHandler = sliceBetween(viewer, 'appWindow.onCloseRequested', 'onDragDropEvent');
	assert.match(closeHandler, /canCloseTab,\n/, 'the walk still runs the per-tab dialog');
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
