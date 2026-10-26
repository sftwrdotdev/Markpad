import assert from 'node:assert/strict';

import { beforeAll, describe, test } from 'vitest';

// This stub only answers the settings store, which boots when the modules
// below are imported. The describe installs the one the tests use.
(window as any).__TAURI_INTERNALS__ = {
	metadata: { currentWindow: { label: 'main' }, currentWebview: { windowLabel: 'main', label: 'main' } },
	invoke: (cmd: string) => Promise.resolve(cmd === 'get_os_type' ? 'macos' : null),
};

const { tabManager } = await import('../src/lib/stores/tabs.svelte.js');
const { createDocumentSession } = await import('../src/lib/sessions/documentSession.svelte.js');
const { createWindowExit } = await import('../src/lib/sessions/windowExit.js');
const { createExternalChange } = await import('../src/lib/sessions/externalChange.svelte.js');
const { HOME_TAB_PATH } = await import('../src/lib/utils/homeTab.js');

// An unanswered external-change conflict is a question only the user can
// answer. The viewer's saves that nobody asked for — leaving the editor or
// split view, and the exit's auto-save — used to go through the same wrapper as
// Cmd+S, which authorises the overwrite whenever the bar is up. So Ctrl+E or
// quitting wrote the buffer over the other program's change and took the bar
// down without asking.
//
// Everything below runs the viewer's real save and conflict module against the
// real document session, so what is asserted is what reaches the disk.
describe('external change conflicts', () => {
	const disk = new Map<string, string>();

	beforeAll(() => {
		(window as any).__TAURI_INTERNALS__ = {
			metadata: { currentWindow: { label: 'main' }, currentWebview: { windowLabel: 'main', label: 'main' } },
			invoke: (cmd: string, args: any) => {
				if (cmd === 'canonicalize_path') return Promise.resolve(args.path);
				if (cmd === 'read_file_content_checked') return Promise.resolve([disk.get(args.path) ?? '', false, 'UTF-8']);
				if (cmd === 'open_markdown_preview') return Promise.resolve([disk.get(args.path) ?? '', true, false, 'UTF-8']);
				if (cmd === 'save_file_content') {
					disk.set(args.path, args.content);
					return Promise.resolve(null);
				}
				if (cmd === 'get_os_type') return Promise.resolve('macos');
				return Promise.resolve(null);
			},
		};
	});

	function makeViewer(overrides: { canCloseTab?: (id: string) => Promise<boolean> } = {}) {
		const closeQuestions: boolean[] = [];
		const toasts: string[] = [];
		const session = createDocumentSession({
			setShowHome: () => {},
			currentFile: () => tabManager.activeTab?.path ?? '',
			resetScrollHistory: () => {},
			renderMarkdown: async (raw: string) => raw,
			afterLoad: async () => {},
			saveRecentFile: () => {},
			deleteRecentFile: () => {},
			setLoadingTabs: () => {},
			measureInitialViewport: () => {},
			isScrolling: () => false,
			onError: () => {},
			onDiskChangedUnderSave: (id: string) => conflicts.noteExternalChangeConflict(id),
			cancelPendingAutoSave: () => {},
			askClose: async (_title: string, diskMoved: boolean) => {
				closeQuestions.push(diskMoved);
				return 'cancel' as const;
			},
			onCloseSaveNewerEdits: () => {},
			onCloseAutoSaveFailed: () => {},
			onPartialCopySaved: () => {},
		});
		const conflicts = createExternalChange({
			tabManager,
			settings: { autoSave: true, language: 'en' },
			documentSession: session,
			loadMarkdown: (path, options) => session.loadMarkdown(path, options),
			canCloseTab: overrides.canCloseTab ?? ((id) => session.canCloseTab(id)),
			readFile: async (path) => [disk.get(path) ?? '', false, 'UTF-8'],
			editorLanguageFor: () => 'markdown',
			addToast: (message) => void toasts.push(message),
			t: (key) => key,
		});
		const exit = createWindowExit({
			tabManager,
			settings: { autoSave: true, restoreStateOnReopen: false, closeWindowWithLastTab: true, persistOpenEditors: false },
			appWindow: { label: 'main', close: async () => {}, destroy: async () => {} },
			allWindows: async () => [],
			recovery: { isReady: () => false, keep: async () => true, drop: async () => true },
			persistWindowState: async () => {},
			canCloseTab: (id) => session.canCloseTab(id),
			saveSilently: conflicts.saveSilently,
			hasExternalChangeConflict: conflicts.hasExternalChangeConflict,
			onAutoSaveFailed: () => void toasts.push('toast.autoSaveFailed'),
			settle: async () => {},
			loadMarkdown: async () => {},
			setShowHome: () => {},
			moveTabToWindow: async () => {},
		});
		const settleForExit = () => exit.settleForExit(async () => true);
		return { conflicts, session, settleForExit, closeQuestions, toasts };
	}

	/** a.md was saved, another program then changed it, and the user typed once more. */
	function conflicted(viewer: ReturnType<typeof makeViewer>) {
		tabManager.closeAll();
		disk.clear();
		disk.set('/notes/a.md', 'saved');
		tabManager.addTab('/notes/a.md', 'saved');
		const tab = tabManager.activeTab!;
		tab.originalContent = 'saved';
		tab.isEditing = true;
		disk.set('/notes/a.md', 'theirs');
		tabManager.updateTabRawContent(tab.id, 'saved!');
		viewer.conflicts.noteExternalChangeConflict(tab.id);
		return tab;
	}

	test('leaving the editor keeps the edit in the buffer and the bar up', async () => {
		const viewer = makeViewer();
		const tab = conflicted(viewer);

		await viewer.conflicts.flushBeforeLeavingEditableMode(tab);

		assert.equal(disk.get('/notes/a.md'), 'theirs', 'the other program\'s change was overwritten');
		assert.equal(tab.rawContent, 'saved!');
		assert.equal(viewer.conflicts.hasExternalChangeConflict(tab.id), true, 'the bar came down');
		assert.deepEqual(viewer.toasts, [], 'the bar already says why nothing was written');
	});

	test('closing the window asks about a conflicted tab instead of saving it', async () => {
		const viewer = makeViewer();
		const tab = conflicted(viewer);

		assert.equal(await viewer.settleForExit(), false);

		assert.equal(disk.get('/notes/a.md'), 'theirs', 'the other program\'s change was overwritten');
		assert.equal(tab.rawContent, 'saved!');
		assert.deepEqual(viewer.closeQuestions, [true], 'the walk asked the changed-on-disk question');
	});

	test('the exit still auto-saves the other dirty tabs', async () => {
		const viewer = makeViewer();
		conflicted(viewer);
		disk.set('/notes/b.md', 'b');
		tabManager.addTab('/notes/b.md', 'b');
		const b = tabManager.activeTab!;
		b.originalContent = 'b';
		tabManager.updateTabRawContent(b.id, 'b edited');

		await viewer.settleForExit();

		assert.equal(disk.get('/notes/b.md'), 'b edited');
		assert.equal(disk.get('/notes/a.md'), 'theirs');
	});

	// Pressing Cmd+S is a decision. Leaving the bar up afterwards would ask a
	// question the user already answered.
	test('Cmd+S on a conflicted tab is still the answer "keep mine"', async () => {
		const viewer = makeViewer();
		const tab = conflicted(viewer);

		assert.equal(await viewer.conflicts.saveContent(tab.id), true);

		assert.equal(disk.get('/notes/a.md'), 'saved!');
		assert.equal(viewer.conflicts.hasExternalChangeConflict(tab.id), false);

		// The answered question stays answered when the file comes back to the
		// text it was raised against.
		tabManager.updateTabRawContent(tab.id, 'saved');
		assert.equal(await viewer.conflicts.saveContent(tab.id), true);
		assert.equal(viewer.conflicts.hasExternalChangeConflict(tab.id), false);
	});

	test('"Keep mine" from the comparison answers for the tab it was opened on', async () => {
		const viewer = makeViewer();
		const a = conflicted(viewer);
		// The user switched tabs with the comparison open: b.md is in front, edited,
		// and another program has just written it too.
		disk.set('/notes/b.md', 'b');
		tabManager.addTab('/notes/b.md', 'b');
		const b = tabManager.activeTab!;
		b.originalContent = 'b';
		tabManager.updateTabRawContent(b.id, 'b edited');
		disk.set('/notes/b.md', 'b theirs');

		// What the overlay's button passes: the tab the comparison was opened on.
		viewer.conflicts.resolveExternalChangeByKeepingBuffer(a.id);
		await viewer.conflicts.saveSilently(b.id);

		assert.equal(disk.get('/notes/b.md'), 'b theirs', 'b.md was overwritten on an answer given about a.md');
		assert.equal(await viewer.conflicts.saveSilently(a.id), true, 'a.md did not get the answer');
	});

	test('a conflict does not follow its tab onto another file', async () => {
		const viewer = makeViewer();
		const tab = conflicted(viewer);
		// A link in a.md: the close dialog is answered Don't Save, and b.md loads
		// into the same tab. It holds the same text a.md was saved with, so only
		// the path tells the two questions apart.
		disk.set('/notes/b.md', 'saved');
		tab.rawContent = tab.originalContent;
		await viewer.session.loadMarkdown('/notes/b.md', { navigate: true });
		assert.equal(tab.path, '/notes/b.md');

		// b.md is edited, and changed by another program before the watcher says so.
		tabManager.updateTabRawContent(tab.id, 'b edited');
		disk.set('/notes/b.md', 'b theirs');

		assert.equal(await viewer.conflicts.saveContent(tab.id), false);
		assert.equal(disk.get('/notes/b.md'), 'b theirs', 'Cmd+S used the answer about a.md to overwrite b.md');
	});

	// The bar can stand for a while. What the user needs to see is the file as
	// it is when they are actually answering.
	test('Compare reads the file at the moment it is asked, not when the bar went up', async () => {
		const viewer = makeViewer();
		const tab = conflicted(viewer);
		disk.set('/notes/a.md', 'theirs, edited again');

		await viewer.conflicts.compareExternalChange();

		assert.deepEqual(viewer.conflicts.comparison, {
			tabId: tab.id,
			onDisk: 'theirs, edited again',
			mine: 'saved!',
			language: 'markdown',
		});
	});

	// Otherwise the overlay outlives the question and shows a diff against a
	// version that is no longer either side of anything.
	test('answering the bar closes the comparison with it', async () => {
		const viewer = makeViewer();
		const tab = conflicted(viewer);
		await viewer.conflicts.compareExternalChange();
		viewer.conflicts.resolveExternalChangeByKeepingBuffer(tab.id);
		assert.equal(viewer.conflicts.comparison, null, 'Keep mine left the comparison open');

		viewer.conflicts.noteExternalChangeConflict(tab.id);
		await viewer.conflicts.compareExternalChange();
		assert.notEqual(viewer.conflicts.comparison, null);
		await viewer.conflicts.resolveExternalChangeByReloading(tab.id);
		assert.equal(viewer.conflicts.comparison, null, 'Reload left the comparison open');
	});

	// --- reverting is still possible, and only by saying so ---
	//
	// Every other caller of loadMarkdown is an open, and an open leaves an
	// edited buffer alone. The two revert commands replace it.

	test('Reload on the conflict bar replaces the unsaved edits with the file', async () => {
		const viewer = makeViewer();
		const tab = conflicted(viewer);

		await viewer.conflicts.resolveExternalChangeByReloading(tab.id);

		assert.equal(tab.rawContent, 'theirs');
		assert.equal(tab.isDirty, false);
		assert.equal(viewer.conflicts.hasExternalChangeConflict(tab.id), false);
	});

	test('Reload from disk replaces edits typed while the close question was out', async () => {
		let tab!: ReturnType<typeof conflicted>;
		// canCloseTab has resolved the buffer, and the user typed during its await.
		const viewer = makeViewer({
			canCloseTab: async (id) => {
				tabManager.updateTabRawContent(id, 'typed during the question');
				return true;
			},
		});
		tab = conflicted(viewer);

		await viewer.conflicts.reloadFromDisk();

		assert.equal(tab.rawContent, 'theirs');
		assert.deepEqual(viewer.toasts, ['toast.reloadedFromDisk']);
	});

	// --- the watcher's `file-changed` event ---

	/** a.md in the background, b.md on screen, both saved and clean. */
	function twoSavedTabs() {
		tabManager.closeAll();
		disk.clear();
		for (const path of ['/notes/a.md', '/notes/b.md']) {
			disk.set(path, `saved ${path}`);
			tabManager.addTab(path, `saved ${path}`);
			tabManager.activeTab!.originalContent = `saved ${path}`;
		}
		return tabManager.tabs;
	}

	test('a watcher notification is routed to its watched path', async () => {
		const viewer = makeViewer();
		const [a, b] = twoSavedTabs();
		disk.set('/notes/b.md', 'changed by another program');

		await viewer.conflicts.handleFileChanged('/notes/b.md', false);
		await new Promise((resolve) => setTimeout(resolve, 0));
		assert.equal(b.rawContent, 'saved /notes/b.md', 'Live Mode off: the change is not loaded');

		await viewer.conflicts.handleFileChanged('/notes/b.md', true);
		await new Promise((resolve) => setTimeout(resolve, 0));
		assert.equal(b.rawContent, 'changed by another program');
		assert.equal(a.rawContent, 'saved /notes/a.md', 'only the tab that owns the path is touched');

		// An event for the background file does not reload the one on screen.
		disk.set('/notes/a.md', 'a changed');
		disk.set('/notes/b.md', 'b changed again');
		await viewer.conflicts.handleFileChanged('/notes/a.md', true);
		await new Promise((resolve) => setTimeout(resolve, 0));
		assert.equal(b.rawContent, 'changed by another program');
	});

	test('the watcher listener routes every event through the guarded resolution', async () => {
		// A watcher event never reloads over unsaved edits, Live Mode or not: the
		// tab is marked conflicted instead.
		const viewer = makeViewer();
		const [, b] = twoSavedTabs();
		tabManager.updateTabRawContent(b.id, 'typed here');
		disk.set('/notes/b.md', 'changed by another program');

		await viewer.conflicts.handleFileChanged('/notes/b.md', true);
		await new Promise((resolve) => setTimeout(resolve, 0));

		assert.equal(b.rawContent, 'typed here');
		assert.equal(viewer.conflicts.hasExternalChangeConflict(b.id), true);
	});
});

// Ctrl+S from any mode, on the tab in front.
describe('save from reading mode', () => {
	function makeSaves() {
		const saved: string[] = [];
		const conflicts = createExternalChange({
			tabManager,
			settings: { autoSave: false, language: 'en' },
			documentSession: {
				saveContent: async (id) => {
					saved.push(tabManager.tabs.find((tab) => tab.id === id)!.path);
					return true;
				},
				allowOverwriteOnce: () => {},
			},
			loadMarkdown: async () => {},
			canCloseTab: async () => true,
			readFile: async () => ['', false, 'UTF-8'],
			editorLanguageFor: () => 'markdown',
			addToast: () => {},
			t: (key) => key,
		});
		return { conflicts, saved };
	}

	test('an untitled buffer can be saved from reading mode', async () => {
		// The session opens the Save dialog for `path === ''`.
		const { conflicts, saved } = makeSaves();
		tabManager.closeAll();
		tabManager.addTab('', '');

		await conflicts.saveActiveTab();

		assert.deepEqual(saved, ['']);
	});

	test('a saved, unmodified document does not write on Ctrl+S', async () => {
		// Writing unconditionally would touch mtime and wake the file watcher,
		// which in live mode reloads the tab -- a keystroke that reads as a no-op
		// to the user should not move the document underneath them.
		const { conflicts, saved } = makeSaves();
		tabManager.closeAll();
		tabManager.addTab('/notes/a.md', 'saved');
		const tab = tabManager.activeTab!;
		tab.originalContent = 'saved';

		await conflicts.saveActiveTab();
		assert.deepEqual(saved, []);

		tabManager.updateTabRawContent(tab.id, 'saved!');
		await conflicts.saveActiveTab();
		assert.deepEqual(saved, ['/notes/a.md']);
	});

	test('the HOME tab is not savable', async () => {
		// HOME carries the sentinel path and is never dirty, so the guard excludes
		// it without naming it. Saving it would open a Save dialog.
		const { conflicts, saved } = makeSaves();
		tabManager.closeAll();
		tabManager.addHomeTab();
		assert.equal(tabManager.activeTab?.path, HOME_TAB_PATH);

		await conflicts.saveActiveTab();

		assert.deepEqual(saved, []);
	});
});
