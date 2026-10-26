import assert from 'node:assert/strict';

import { afterAll, beforeAll, describe, test } from 'vitest';

// Each describe installs its own Tauri stub in `beforeAll`. This one only
// answers the settings store, which boots when the modules below are imported.
(window as any).__TAURI_INTERNALS__ = {
	metadata: { currentWindow: { label: 'main' }, currentWebview: { windowLabel: 'main', label: 'main' } },
	invoke: (cmd: string) => Promise.resolve(cmd === 'get_os_type' ? 'macos' : null),
};

const { tabManager } = await import('../src/lib/stores/tabs.svelte.js');
const { settings } = await import('../src/lib/stores/settings.svelte.js');
const { createDocumentSession } = await import('../src/lib/sessions/documentSession.svelte.js');
const { createExternalChange } = await import('../src/lib/sessions/externalChange.svelte.js');
const { buildTransferredTab, snapshotTab, validateTransferPayload } = await import(
	'../src/lib/utils/tabTransfer.js'
);

// An explicit save and the 1.5s auto-save debounce can both be aimed at one
// tab. The debounce is armed on the last keystroke and disarmed by the
// auto-save effect only once `isDirty` goes false — which happens *after* the
// write resolves. So a timer that expires while an explicit save is still in
// flight starts a SECOND write of the same file, and the two race to the
// rename:
//
//   manual save   takes snapshot A ──┐
//   user types (buffer becomes B)    ├── both in flight, order undefined
//   timer fires   takes snapshot B ──┘
//
//   if A lands last: disk holds A, the tab recorded B as saved, isDirty is
//   false. The buffer reads clean while the file is a revision behind, and it
//   stays that way until the next keystroke.
//
// `atomic_write` was hardened separately so two concurrent writers cannot
// corrupt the file or fail each other — but that is a safety property, not an
// ordering one, and it cannot fix a stale winner. The ordering fix is simply
// not to start the second write: whoever is about to save disarms the timer.
//
// The point of these tests is the *placement* of that duty. It used to sit at
// the call sites, where three of six explicit-save entry points remembered it
// and three did not; it now sits inside `saveContent`, so no entry point has
// to know. These assert the duty is discharged there, and that no call site
// has quietly taken it back.
describe('explicit save cancels auto-save', () => {
	// The runes are the compiler's, not ours: vitest builds `.svelte.ts` through the
	// Svelte plugin, so the store and the session run under real reactivity, and jsdom
	// supplies `window` and `localStorage`. Only the Tauri backend is stubbed.

	const disk = new Map<string, string>();
	/**
	 * Cancels and writes in the order they happened. One list on purpose: the
	 * question is not whether both occurred but which came first, and two counters
	 * cannot answer that.
	 */
	const events: string[] = [];
	/** What the Save As dialog returns next. `null` is the user pressing Cancel. */
	let nextSaveTarget: string | null = null;

	beforeAll(() => {
		(window as any).__TAURI_INTERNALS__ = {
			metadata: { currentWindow: { label: 'main' }, currentWebview: { windowLabel: 'main', label: 'main' } },
			invoke: (cmd: string, args: any) => {
				if (cmd === 'canonicalize_path') return Promise.resolve(args.path);
				if (cmd === 'read_file_content_checked') return Promise.resolve([disk.get(args.path) ?? '', false]);
				if (cmd === 'open_markdown_preview') return Promise.resolve([disk.get(args.path) ?? '', true, false]);
				if (cmd === 'save_file_content') {
					events.push(`write:${args.path}`);
					disk.set(args.path, args.content);
					return Promise.resolve(null);
				}
				if (cmd === 'plugin:dialog|save') return Promise.resolve(nextSaveTarget);
				if (cmd === 'get_os_type') return Promise.resolve('macos');
				return Promise.resolve(null);
			},
		};
	});

	function makeSession() {
		return createDocumentSession({
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
			onDiskChangedUnderSave: () => {},
			cancelPendingAutoSave: (tabId: string) => void events.push(`cancel:${tabId}`),
			askClose: async () => 'discard' as const,
			onCloseSaveNewerEdits: () => {},
			onCloseAutoSaveFailed: () => {},
			onPartialCopySaved: () => {},
		});
	}

	function reset() {
		tabManager.closeAll();
		tabManager.recentlyClosed.length = 0;
		localStorage.clear();
		disk.clear();
		events.length = 0;
		nextSaveTarget = null;
	}

	test('an explicit save disarms the debounce before it issues the write', async () => {
		// Order is the whole assertion. Cancelling *after* the write would leave
		// the timer free to fire during the very await this is meant to protect —
		// which is the race, not the fix.
		reset();
		const session = makeSession();
		disk.set('/notes/a.md', 'original');

		await session.loadMarkdown('/notes/a.md');
		const tabId = tabManager.activeTabId!;
		tabManager.updateTabRawContent(tabId, 'edited');

		assert.equal(await session.saveContent(tabId), true);
		assert.deepEqual(events, [`cancel:${tabId}`, 'write:/notes/a.md']);
	});

	test('a save reached without naming a tab disarms that tab too', async () => {
		// Cmd+S and the toolbar button call `saveContent()` with no argument and
		// let it find the active tab. That is one of the three entry points that
		// never cancelled, so it is the one most worth pinning.
		reset();
		const session = makeSession();
		disk.set('/notes/b.md', 'original');

		await session.loadMarkdown('/notes/b.md');
		const tabId = tabManager.activeTabId!;
		tabManager.updateTabRawContent(tabId, 'edited');

		assert.equal(await session.saveContent(), true);
		assert.deepEqual(events, [`cancel:${tabId}`, 'write:/notes/b.md']);
	});

	test('Save As disarms the debounce before it issues the write', async () => {
		// Left armed, the timer fires after the tab has moved and puts a second
		// write on the copy for no reason.
		reset();
		const session = makeSession();
		disk.set('/notes/c.md', 'original');

		await session.loadMarkdown('/notes/c.md');
		const tabId = tabManager.activeTabId!;
		tabManager.updateTabRawContent(tabId, 'edited');

		nextSaveTarget = '/notes/c-copy.md';
		assert.equal(await session.saveContentAs(), true);
		assert.deepEqual(events, [`cancel:${tabId}`, 'write:/notes/c-copy.md']);
	});

	test('a Save dialog the user cancels leaves the timer armed', async () => {
		// The standing rule for `cancelPendingAutoSave`: never disarm on a path the
		// user can still back out of. Cancelling the dialog is exactly that — the
		// tab keeps its edits, so it must keep the writer that will flush them.
		// (An untitled tab has no timer of its own, since the auto-save effect only
		// arms tabs that already have a path; what this really pins is that the
		// cancel sits after the dialog, not before it.)
		reset();
		const session = makeSession();
		tabManager.addTab('');
		const tabId = tabManager.activeTabId!;
		tabManager.updateTabRawContent(tabId, 'unsaved draft');

		nextSaveTarget = null;
		assert.equal(await session.saveContent(tabId), false);
		assert.deepEqual(events, [], 'no cancel, and nothing written');
	});
});

// #436 closed one direction of the save race: `saveContent` now disarms the
// auto-save debounce itself, so an *armed* timer can no longer fire during an
// explicit save.
//
// The other direction stays open. The timer callback deletes itself from
// `autoSaveTimers` as its FIRST statement and only then calls `saveContent`, so
// once the timer has fired there is nothing left for `cancelPendingAutoSave` to
// cancel — and `saveContent` has no in-flight guard. A Cmd+S landing while the
// auto-save write is still awaiting `invoke('save_file_content')` starts a
// second concurrent write:
//
//   auto-save    snapshot A ──┐
//   user types (buffer is B)  ├── both in flight, both racing to the rename
//   Cmd+S        snapshot B ──┘
//
// `atomic_write` (also #436) makes that safe — neither writer can corrupt the
// file or fail the other — but safety is not ordering. If A's rename lands
// last the disk holds A while the user's buffer holds B.
//
// These tests pin the ordering property `atomic_write` cannot supply: at most
// one write per tab is ever in flight. Not "one write" — the second caller
// still writes, because it is saving edits the first one never saw — but it
// writes *after*, from a snapshot taken *after*, so the last rename is the
// newest text.
describe('one write per tab in flight', () => {
	// The runes are the compiler's, not ours: vitest builds `.svelte.ts` through the
	// Svelte plugin, so the store and the session run under real reactivity, and
	// jsdom supplies `window` and `localStorage`. Only the Tauri backend is stubbed.

	const disk = new Map<string, string>();
	/** Writes that have started but not yet reached their rename. */
	let unsettledWrites = 0;
	/**
	 * Set the moment a write starts while another is still unsettled. That is the
	 * whole defect: two renames aimed at one file with no ordering between them.
	 */
	let sawOverlap = false;
	/**
	 * How long each successive write takes to reach its rename, in ms, in call
	 * order. Giving the FIRST write the longer delay is what makes the race
	 * observable rather than merely possible: unguarded, the second write renames
	 * first and the first write's older snapshot lands on top of it.
	 */
	let writeDurationsMs: number[] = [];
	let writeCount = 0;
	/** What the Save/Save As dialog returns next. `null` is the user cancelling. */
	let nextSaveTarget: string | null = null;
	/** Times a save was refused as "changed on disk". */
	let conflicts = 0;

	beforeAll(() => {
		(window as any).__TAURI_INTERNALS__ = {
			metadata: { currentWindow: { label: 'main' }, currentWebview: { windowLabel: 'main', label: 'main' } },
			invoke: (cmd: string, args: any) => {
				if (cmd === 'canonicalize_path') return Promise.resolve(args.path);
				if (cmd === 'read_file_content_checked') return Promise.resolve([disk.get(args.path) ?? '', false]);
				if (cmd === 'open_markdown_preview') return Promise.resolve([disk.get(args.path) ?? '', true, false]);
				if (cmd === 'save_file_content') {
					const duration = writeDurationsMs[writeCount] ?? 0;
					writeCount += 1;
					if (unsettledWrites > 0) sawOverlap = true;
					unsettledWrites += 1;
					return new Promise((resolve) => {
						setTimeout(() => {
							// The rename. `invoke` resolves after it, which is why
							// resolution order tracks rename order.
							disk.set(args.path, args.content);
							unsettledWrites -= 1;
							resolve(null);
						}, duration);
					});
				}
				if (cmd === 'plugin:dialog|save') return Promise.resolve(nextSaveTarget);
				if (cmd === 'get_os_type') return Promise.resolve('macos');
				return Promise.resolve(null);
			},
		};
	});

	// `settings` is one store for the whole file: put back what this block changes.
	let settingsBefore: { autoSave: typeof settings.autoSave };
	beforeAll(() => {
		settingsBefore = { autoSave: settings.autoSave };
	});
	afterAll(() => {
		Object.assign(settings, settingsBefore);
	});

	function makeSession() {
		return createDocumentSession({
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
			onDiskChangedUnderSave: () => void (conflicts += 1),
			cancelPendingAutoSave: () => {},
			askClose: async () => 'discard' as const,
			onCloseSaveNewerEdits: () => {},
			onCloseAutoSaveFailed: () => {},
			onPartialCopySaved: () => {},
		});
	}

	function reset() {
		tabManager.closeAll();
		tabManager.recentlyClosed.length = 0;
		localStorage.clear();
		disk.clear();
		unsettledWrites = 0;
		sawOverlap = false;
		writeDurationsMs = [];
		writeCount = 0;
		nextSaveTarget = null;
		conflicts = 0;
	}

	/** Open `path` in a tab and leave the buffer holding `edited`. */
	async function openDirtyTab(session: ReturnType<typeof makeSession>, path: string, edited: string) {
		disk.set(path, 'original');
		await session.loadMarkdown(path);
		const tabId = tabManager.activeTabId!;
		tabManager.updateTabRawContent(tabId, edited);
		return tabId;
	}

	test('a second save waits for the write already in flight on that tab', async () => {
		reset();
		const session = makeSession();
		const tabId = await openDirtyTab(session, '/notes/a.md', 'A');

		// The first write is the slow one. Unguarded, the second overtakes it and
		// the first lands last, publishing 'A' over 'B'.
		writeDurationsMs = [30, 5];

		// The auto-save timer has already fired, so its `saveContent` is running
		// and there is no timer left to cancel. `saveContent` reaches its `invoke`
		// synchronously for a tab that already has a path, so this write is in
		// flight by the time the call returns its promise.
		const autoSave = session.saveContent(tabId);
		// The user types on.
		tabManager.updateTabRawContent(tabId, 'B');
		// The user presses Cmd+S.
		const explicit = session.saveContent(tabId);

		assert.deepEqual(await Promise.all([autoSave, explicit]), [true, true]);

		assert.equal(sawOverlap, false, 'two writes to one file were in flight at once');
		assert.equal(disk.get('/notes/a.md'), 'B', 'the newest text must be what survives on disk');
		const tab = tabManager.tabs.find((item) => item.id === tabId)!;
		assert.equal(tab.isDirty, false, 'the buffer matches the disk, so the tab must read clean');
	});

	test('the waiting save writes the buffer as it is after the wait, not before', async () => {
		// Waiting is only half of it. A guard that returned the in-flight promise
		// instead would report success for a write that predates the keystrokes the
		// user pressed Cmd+S to protect. The snapshot has to be taken on the far
		// side of the wait.
		reset();
		const session = makeSession();
		const tabId = await openDirtyTab(session, '/notes/b.md', 'A');
		writeDurationsMs = [30, 5];

		const autoSave = session.saveContent(tabId);
		tabManager.updateTabRawContent(tabId, 'B');
		const explicit = session.saveContent(tabId);
		// Still typing while the first write drains — this is the text the second
		// save must publish.
		tabManager.updateTabRawContent(tabId, 'C');

		await Promise.all([autoSave, explicit]);

		assert.equal(sawOverlap, false);
		assert.equal(disk.get('/notes/b.md'), 'C');
		assert.equal(tabManager.tabs.find((item) => item.id === tabId)!.isDirty, false);
	});

	test('three saves stacked on one tab still produce one write at a time', async () => {
		// The reason the guard is a chain and not a bare `await inFlight`: several
		// callers awaiting the same promise all wake together and then all write
		// concurrently, which is the bug again with extra steps.
		reset();
		const session = makeSession();
		const tabId = await openDirtyTab(session, '/notes/c.md', 'A');
		writeDurationsMs = [30, 20, 10];

		const first = session.saveContent(tabId);
		tabManager.updateTabRawContent(tabId, 'B');
		const second = session.saveContent(tabId);
		tabManager.updateTabRawContent(tabId, 'C');
		const third = session.saveContent(tabId);

		await Promise.all([first, second, third]);

		assert.equal(sawOverlap, false);
		assert.equal(writeCount, 3, 'each caller still writes; they are ordered, not dropped');
		assert.equal(disk.get('/notes/c.md'), 'C');
	});

	test('saveContentAs waits behind the same tab guard', async () => {
		// `saveContentAs` writes too, and it mutates the same per-tab bookkeeping
		// (`originalContent`, `isDirty`, and the tab's path). Its target is usually
		// a different file, so the renames do not collide — but the two
		// continuations still race for the tab's dirty flag, and picking the tab's
		// own file in the dialog is an allowed overwrite that collides outright.
		reset();
		const session = makeSession();
		const tabId = await openDirtyTab(session, '/notes/d.md', 'A');
		writeDurationsMs = [30, 5];

		const autoSave = session.saveContent(tabId);
		tabManager.updateTabRawContent(tabId, 'B');
		nextSaveTarget = '/notes/copy.md';
		const saveAs = session.saveContentAs();

		assert.deepEqual(await Promise.all([autoSave, saveAs]), [true, true]);

		assert.equal(sawOverlap, false);
		assert.equal(disk.get('/notes/copy.md'), 'B', 'the copy must hold the newest text');
		const tab = tabManager.tabs.find((item) => item.id === tabId)!;
		assert.equal(tab.path, '/notes/copy.md');
		assert.equal(tab.isDirty, false, 'the older write must not leave the moved tab reading dirty');
	});

	test('an auto-save queued behind Save As writes the new file, not a false conflict', async () => {
		// The debounce fires while the Save As write is still in flight, so its
		// save waits behind it on the tab guard. By the time it runs the tab points
		// at the copy and its baseline is the copy's text. Taking the path before
		// the wait compared the OLD file against that baseline, and the copy the
		// user just made came up "changed on disk".
		reset();
		const session = makeSession();
		const tabId = await openDirtyTab(session, '/notes/h.md', 'A');
		writeDurationsMs = [30, 5];
		nextSaveTarget = '/notes/h-copy.md';

		const saveAs = session.saveContentAs();
		// Past the dialog, inside the copy's write.
		await new Promise((resolve) => setTimeout(resolve, 5));
		tabManager.updateTabRawContent(tabId, 'AB');
		const autoSave = session.saveContent(tabId);

		assert.deepEqual(await Promise.all([saveAs, autoSave]), [true, true]);
		assert.equal(conflicts, 0, 'the save reported a conflict nobody caused');
		assert.equal(disk.get('/notes/h-copy.md'), 'AB', 'the queued save must write the file the tab now points at');
		assert.equal(disk.get('/notes/h.md'), 'original', 'the file the tab moved away from must be left alone');
	});

	test('closing a tab mid-write does not leave the older snapshot on disk', async () => {
		// The one path on which this race is SILENT, and the reason it is worth
		// fixing at all.
		//
		// Everywhere else the tab survives to tell the user: the older write's
		// continuation runs last and sets `originalContent` to the older snapshot,
		// so `isDirty` goes true and the dirty dot honestly reports that the buffer
		// and the disk disagree. Here the tab is gone before that can happen.
		// `canCloseTab` saves, sees `isDirty` false, and closes; the older write
		// then renames on top, and there is no longer a tab to raise a flag on.
		reset();
		settings.autoSave = true;
		const session = makeSession();
		const tabId = await openDirtyTab(session, '/notes/e.md', 'A');
		writeDurationsMs = [30, 5];

		// The auto-save timer has fired; its write is in flight and past cancelling.
		const autoSave = session.saveContent(tabId);
		// The user types, then closes the tab. With auto-save on and no confirm
		// prompt, `canCloseTab` saves silently and reports the tab closable.
		tabManager.updateTabRawContent(tabId, 'B');
		assert.equal(await session.canCloseTab(tabId), true);
		tabManager.closeTab(tabId);

		// The close already looked clean to the user. What matters is what the
		// still-draining write does after the tab is gone.
		await autoSave;

		assert.equal(sawOverlap, false);
		assert.equal(disk.get('/notes/e.md'), 'B', 'the closed tab’s newest text must be what is left on disk');
	});

	// ------------------------------------------ what "saved" means for the buffer
	//
	// `isDirty` is `rawContent !== originalContent` read off the tab, so the only
	// way a save can report itself is by moving `originalContent` to the text it
	// actually wrote. These two used to be assertions about the *shape* of that
	// code — that `documentSession` still contained a particular assignment — which
	// stopped being expressible once the flag became a getter nobody assigns. They
	// run here instead, where a live session already writes to a fake disk.

	test('a keystroke that misses the Save As write is still unsaved when it returns', async () => {
		// The baseline is the snapshot that reached the file, never the buffer as it
		// stands afterwards: the write is awaited, and anything typed while it
		// drains is not in the file. Marking the tab clean there is silent data
		// loss with a clean dirty dot on top of it.
		reset();
		const session = makeSession();
		const tabId = await openDirtyTab(session, '/notes/f.md', 'A');
		writeDurationsMs = [30];
		nextSaveTarget = '/notes/copy-f.md';

		const saveAs = session.saveContentAs();
		// Past the dialog and the snapshot, still inside the write.
		await new Promise((resolve) => setTimeout(resolve, 5));
		tabManager.updateTabRawContent(tabId, 'AB');

		assert.equal(await saveAs, true);
		assert.equal(disk.get('/notes/copy-f.md'), 'A', 'the copy holds the snapshot the save took');
		const tab = tabManager.tabs.find((item) => item.id === tabId)!;
		assert.equal(tab.isDirty, true, 'the keystroke the copy does not contain was reported as saved');
	});

	test('discarding at the close prompt puts the last saved text back', async () => {
		reset();
		settings.autoSave = false;
		const session = makeSession();
		const tabId = await openDirtyTab(session, '/notes/g.md', 'edited');

		// `askClose` answers 'discard'.
		assert.equal(await session.canCloseTab(tabId), true);

		const tab = tabManager.tabs.find((item) => item.id === tabId)!;
		assert.equal(tab.rawContent, 'original', 'the buffer kept the edits the user chose to discard');
		assert.equal(tab.isDirty, false, 'the discarded tab still reads dirty, so closing it asks again');
		assert.equal(disk.get('/notes/g.md'), 'original', 'discarding wrote to the file');
	});
});

// Rename from the tab menu is the same repoint as Save As and has to keep the
// same two guarantees: the tab learns the new path's canonical key, and the
// move is ordered against the tab's own writes. Only the Tauri backend is
// stubbed; the store and the session run under the real compiler.
describe('rename file session', () => {
	const disk = new Map<string, string>();
	const events: string[] = [];
	/** Commands held until the test releases them, to widen a race on purpose. */
	const gates = new Map<string, Promise<void>>();

	function hold(cmd: string): () => void {
		let release!: () => void;
		gates.set(cmd, new Promise<void>((resolve) => (release = resolve)));
		return release;
	}

	async function waitFor(cmd: string) {
		const gate = gates.get(cmd);
		if (gate) {
			gates.delete(cmd);
			await gate;
		}
	}

	beforeAll(() => {
		(window as any).__TAURI_INTERNALS__ = {
			metadata: { currentWindow: { label: 'main' }, currentWebview: { windowLabel: 'main', label: 'main' } },
			invoke: async (cmd: string, args: any) => {
				// A case-insensitive volume: every spelling resolves to the lower-case one.
				if (cmd === 'canonicalize_path') return args.path.toLowerCase();
				if (cmd === 'read_file_content_checked') {
					if (!disk.has(args.path)) throw new Error('No such file');
					return [disk.get(args.path), false, 'UTF-8'];
				}
				if (cmd === 'open_markdown_preview') return [disk.get(args.path) ?? '', true, false];
				if (cmd === 'save_file_content') {
					events.push(`write-start:${args.path}`);
					await waitFor(cmd);
					disk.set(args.path, args.content);
					events.push(`write:${args.path}`);
					return null;
				}
				if (cmd === 'rename_file') {
					events.push(`rename-start:${args.oldPath}`);
					await waitFor(cmd);
					disk.set(args.newPath, disk.get(args.oldPath)!);
					disk.delete(args.oldPath);
					events.push(`rename:${args.newPath}`);
					return null;
				}
				if (cmd === 'get_os_type') return 'macos';
				return null;
			},
		};
	});

	const conflicts: string[] = [];

	function makeSession() {
		return createDocumentSession({
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
			onDiskChangedUnderSave: (tabId: string) => void conflicts.push(tabId),
			cancelPendingAutoSave: () => {},
			askClose: async () => 'discard' as const,
			onCloseSaveNewerEdits: () => {},
			onCloseAutoSaveFailed: () => {},
			onPartialCopySaved: () => {},
		});
	}

	function reset() {
		tabManager.closeAll();
		tabManager.recentlyClosed.length = 0;
		localStorage.clear();
		disk.clear();
		events.length = 0;
		conflicts.length = 0;
		gates.clear();
	}

	test('a renamed tab is found again when the file is opened under another spelling', async () => {
		reset();
		const session = makeSession();
		disk.set('/notes/a.md', 'text');
		await session.loadMarkdown('/notes/a.md');
		const tabId = tabManager.activeTabId!;

		await session.renameFile(tabId, '/notes/B.md');
		assert.equal(tabManager.activeTab?.path, '/notes/B.md');

		await session.loadMarkdown('/notes/b.md');
		assert.equal(tabManager.tabs.length, 1, 'the renamed file opened in a second tab');
		assert.equal(tabManager.activeTabId, tabId);
	});

	test('a rename waits for a save already writing the old name', async () => {
		reset();
		const session = makeSession();
		disk.set('/notes/a.md', 'text');
		await session.loadMarkdown('/notes/a.md');
		const tabId = tabManager.activeTabId!;
		tabManager.updateTabRawContent(tabId, 'edited');

		const release = hold('save_file_content');
		const saving = session.saveContent(tabId);
		await new Promise((resolve) => setTimeout(resolve, 0));
		const renaming = session.renameFile(tabId, '/notes/b.md');
		await new Promise((resolve) => setTimeout(resolve, 0));
		release();
		await Promise.all([saving, renaming]);

		assert.deepEqual(events, ['write-start:/notes/a.md', 'write:/notes/a.md', 'rename-start:/notes/a.md', 'rename:/notes/b.md']);
		assert.equal(disk.has('/notes/a.md'), false, 'the old file came back');
		assert.equal(disk.get('/notes/b.md'), 'edited');
	});

	test('a save made while the rename is in flight writes the new name', async () => {
		reset();
		const session = makeSession();
		disk.set('/notes/a.md', 'text');
		await session.loadMarkdown('/notes/a.md');
		const tabId = tabManager.activeTabId!;

		const release = hold('rename_file');
		const renaming = session.renameFile(tabId, '/notes/b.md');
		await new Promise((resolve) => setTimeout(resolve, 0));
		tabManager.updateTabRawContent(tabId, 'edited');
		const saving = session.saveContent(tabId);
		release();
		assert.equal(await saving, true, 'the save was refused');
		await renaming;

		assert.deepEqual(conflicts, [], 'the save reported its own rename as a change on disk');
		assert.equal(disk.has('/notes/a.md'), false, 'the old file came back');
		assert.equal(disk.get('/notes/b.md'), 'edited');
	});
});

// The first save of an untitled buffer writes a file that does not exist yet.
// The external-change guard (#692) asks the disk "has this file changed since
// I last saw it?" before every overwrite, and answers "changed" when the read
// fails — correct for a file the tab has written before, and the wrong
// question entirely for a path the Save dialog has only just named. The read
// failed because nothing was there, the write was refused, and the conflict
// bar went up on a tab whose Reload has no file to reload. Every retry, under
// any name, was refused the same way: a new document could not be saved at all.
//
// The stub is what let that ship. It answered a read of an unknown path with
// `''` instead of rejecting, so under test the missing file looked like an
// empty one and the guard compared two empty strings. Reads here reject the
// way `read_file_content_checked` does.
describe('untitled first save writes', () => {
	const disk = new Map<string, string>();
	const writes: string[] = [];
	/** What the Save dialog returns next. `null` is the user pressing Cancel. */
	let nextSaveTarget: string | null = null;
	/** Tabs the session raised the conflict bar for. */
	const conflicts: string[] = [];

	beforeAll(() => {
		(window as any).__TAURI_INTERNALS__ = {
			metadata: { currentWindow: { label: 'main' }, currentWebview: { windowLabel: 'main', label: 'main' } },
			invoke: (cmd: string, args: any) => {
				if (cmd === 'canonicalize_path') return Promise.resolve(args.path);
				if (cmd === 'read_file_content_checked') {
					const content = disk.get(args.path);
					return content === undefined
						? Promise.reject(new Error('No such file or directory (os error 2)'))
						: Promise.resolve([content, false, 'UTF-8']);
				}
				if (cmd === 'save_file_content') {
					writes.push(args.path);
					disk.set(args.path, args.content);
					return Promise.resolve(null);
				}
				if (cmd === 'plugin:dialog|save') return Promise.resolve(nextSaveTarget);
				if (cmd === 'get_os_type') return Promise.resolve('macos');
				return Promise.resolve(null);
			},
		};
	});

	function makeSession() {
		return createDocumentSession({
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
			onDiskChangedUnderSave: (tabId: string) => void conflicts.push(tabId),
			cancelPendingAutoSave: () => {},
			askClose: async () => 'discard' as const,
			onCloseSaveNewerEdits: () => {},
			onCloseAutoSaveFailed: () => {},
			onPartialCopySaved: () => {},
		});
	}

	function reset() {
		tabManager.closeAll();
		tabManager.recentlyClosed.length = 0;
		localStorage.clear();
		disk.clear();
		writes.length = 0;
		conflicts.length = 0;
		nextSaveTarget = null;
	}

	test('the first save of an untitled buffer writes the file the dialog named', async () => {
		reset();
		const session = makeSession();
		tabManager.addTab('');
		const tabId = tabManager.activeTabId!;
		tabManager.updateTabRawContent(tabId, 'draft');

		nextSaveTarget = '/notes/Untitled 1.md';
		assert.equal(await session.saveContent(tabId), true);
		assert.deepEqual(writes, ['/notes/Untitled 1.md']);
		assert.deepEqual(conflicts, [], 'a file that never existed cannot have changed under the save');

		const tab = tabManager.tabs.find((item) => item.id === tabId)!;
		assert.equal(tab.path, '/notes/Untitled 1.md');
		assert.equal(tab.isDirty, false, 'the buffer is on disk, so nothing is unsaved');
	});

	test('saving an untitled buffer onto a file that already exists is the dialog’s question, not ours', async () => {
		// The Save dialog asked "replace?" and the user answered it. A second
		// refusal here, from a baseline this tab never had, would make an untitled
		// buffer unable to land on any path the user actually wanted.
		reset();
		const session = makeSession();
		disk.set('/notes/existing.md', 'somebody else');
		tabManager.addTab('');
		const tabId = tabManager.activeTabId!;
		tabManager.updateTabRawContent(tabId, 'draft');

		nextSaveTarget = '/notes/existing.md';
		assert.equal(await session.saveContent(tabId), true);
		assert.equal(disk.get('/notes/existing.md'), 'draft');
		assert.deepEqual(conflicts, []);
	});

	test('a tab that has a file still refuses to overwrite a changed one', async () => {
		// The guard the fix narrows, still doing its job: the exemption is for a
		// tab with no file, not for a save with no check.
		reset();
		const session = makeSession();
		disk.set('/notes/a.md', 'original');

		await session.loadMarkdown('/notes/a.md');
		const tabId = tabManager.activeTabId!;
		tabManager.updateTabRawContent(tabId, 'mine');
		disk.set('/notes/a.md', 'theirs');

		assert.equal(await session.saveContent(tabId), false);
		assert.deepEqual(conflicts, [tabId]);
		assert.equal(disk.get('/notes/a.md'), 'theirs', 'their text is still there');
	});
});

/*
 * `isLossySaveRefused` is read by the auto-save timer's FAILURE handler:
 *
 *     if (documentSession.isLossySaveRefused(s.id)) return;   // no toast
 *     addToast(t('toast.autoSaveFailed'), 'error');
 *
 * The intent is right — a refused save already explained itself, naming the
 * file and the way out, so "auto-save failed" on top says nothing new. But the
 * predicate was `lossySaveWarnedTabs.has(tabId)`, membership in a set that is
 * only ever cleared by `loadMarkdown` and `saveContentAs`. The tab's decode
 * fidelity is re-decided by four other sites — `ensureFullContent`, entering
 * the editor, entering split view, a cross-window arrival — every one of which
 * can clear `hasReplacementChars` for a file converted to UTF-8 since the load,
 * and none of which touches the set.
 *
 * So a tab could stop decoding lossily, start auto-saving again (the
 * eligibility gate is `decodedLossily && isLossySaveRefused`, which correctly
 * re-opens), and then have every subsequent auto-save failure — disk full,
 * permission denied, a network volume that went away — silently swallow its
 * toast, for the rest of that tab's life.
 *
 * The condition the name promises is "this tab's saves are being refused for
 * the lossy-decode reason, right now", and "right now" is a property of the
 * tab, not a memory of what was once said about it.
 */
describe('lossy save refusal scope', () => {
	// The runes are the compiler's, not ours: vitest builds `.svelte.ts` through the
	// Svelte plugin, so the store and the session run under real reactivity. Only
	// the Tauri backend, which jsdom cannot provide, is stubbed.

	/** Whether `save_file_content` succeeds. Set per test. */
	let writeFails = false;
	/** Every `save_file_content` that reached the backend. */
	let writes = 0;
	const LOSSY = 'text with � in it';
	/** What the Save As dialog returns next. */
	let nextSaveTarget: string | null = null;

	beforeAll(() => {
		(window as any).__TAURI_INTERNALS__ = {
			metadata: { currentWindow: { label: 'main' }, currentWebview: { windowLabel: 'main', label: 'main' } },
			invoke: (command: string, args: Record<string, unknown>) => {
				const cmd = command.replace(/^plugin:[^|]*\|/, '');
				if (cmd === 'get_os_type') return Promise.resolve('macos');
				if (cmd === 'canonicalize_path') return Promise.resolve(args.path);
				if (cmd === 'open_markdown_preview') return Promise.resolve([LOSSY, true, true]);
				if (cmd === 'read_file_content_checked') return Promise.resolve([LOSSY, true]);
				if (cmd === 'save') return Promise.resolve(nextSaveTarget);
				if (cmd === 'save_file_content') {
					writes++;
					return writeFails ? Promise.reject(new Error('Os { code: 28, kind: StorageFull }')) : Promise.resolve(null);
				}
				return Promise.resolve(null);
			},
		};
	});

	/** Every message the user would actually see, in order. */
	let toasts: string[] = [];

	function makeSession() {
		return createDocumentSession({
			setShowHome: () => {},
			currentFile: () => tabManager.activeTab?.path ?? '',
			resetScrollHistory: () => {},
			renderMarkdown: async () => '',
			afterLoad: async () => {},
			saveRecentFile: () => {},
			deleteRecentFile: () => {},
			setLoadingTabs: () => {},
			measureInitialViewport: () => {},
			isScrolling: () => false,
			onError: (message) => void toasts.push(message),
			onDiskChangedUnderSave: () => {},
			cancelPendingAutoSave: () => {},
			askClose: async () => 'discard' as const,
			onCloseSaveNewerEdits: () => {},
			onCloseAutoSaveFailed: () => {},
			onPartialCopySaved: () => {},
		});
	}

	/**
	 * A tab holding a buffer that came out of a lossy decode, edited, and refused
	 * once — which is the state the refusal set records.
	 */
	async function refusedTab() {
		tabManager.closeAll();
		toasts = [];
		writeFails = false;
		const session = makeSession();
		await session.loadMarkdown('/notes/legacy.md');
		const tab = tabManager.activeTab!;
		assert.equal(tab.hasReplacementChars, true, 'precondition: the decode was lossy');

		tabManager.updateTabRawContent(tab.id, 'edited');
		assert.equal(await session.saveContent(tab.id), false, 'the guard must refuse this write');
		assert.equal(toasts.length, 1, 'and explain itself exactly once');
		assert.equal(session.isLossySaveRefused(tab.id), true);
		return { session, tab };
	}

	test('a refusal still speaks once, and stays quiet afterwards', async () => {
		// The behaviour that must survive: while the tab still decodes lossily,
		// every further attempt is the same standing condition, already explained.
		const { session, tab } = await refusedTab();

		tabManager.updateTabRawContent(tab.id, 'edited again');
		assert.equal(await session.saveContent(tab.id), false);
		tabManager.updateTabRawContent(tab.id, 'and again');
		assert.equal(await session.saveContent(tab.id), false);

		assert.equal(toasts.length, 1, 'a standing condition is not re-reported');
		assert.equal(session.isLossySaveRefused(tab.id), true, 'and the timer keeps its toast suppressed');
	});

	test('a tab that no longer decodes lossily is no longer being refused', async () => {
		// The file was converted to UTF-8 and the tab re-read it. This is what
		// `ensureFullContent`, `toggleEdit`, split view and a cross-window arrival
		// all do — none of them goes through `loadMarkdown`, so none of them
		// clears the set.
		const { session, tab } = await refusedTab();
		tabManager.setTabDecodedLossy(tab.id, false);

		assert.equal(session.isLossySaveRefused(tab.id), false, 'nothing is being refused any more');
	});

	test('a real auto-save failure on that tab is still reportable', async () => {
		// End to end, in the shape the auto-save timer sees it: `saveContent`
		// returns false, and the predicate the timer consults before deciding
		// whether to raise `toast.autoSaveFailed` must not claim this was a
		// refusal. Under the stale-set predicate it did, and the user was left
		// believing a full disk had saved their work.
		const { session, tab } = await refusedTab();
		tabManager.setTabDecodedLossy(tab.id, false);
		writeFails = true;

		tabManager.updateTabRawContent(tab.id, 'work the user expects to be saved');
		assert.equal(await session.saveContent(tab.id), false, 'the write really did fail');
		assert.equal(
			session.isLossySaveRefused(tab.id),
			false,
			'a failure is not a refusal, so the timer must be free to report it',
		);
	});

	test('the flag goes back up if the file is lossy again', async () => {
		// Symmetry: the predicate answers about the tab as it is now, in both
		// directions. A tab that was converted back (or a second file opened into
		// the same tab that is lossy) is refused again — and having already been
		// told once, it is not told twice.
		const { session, tab } = await refusedTab();
		tabManager.setTabDecodedLossy(tab.id, false);
		tabManager.setTabDecodedLossy(tab.id, true);

		assert.equal(session.isLossySaveRefused(tab.id), true);
		assert.equal(await session.saveContent(tab.id), false);
		assert.equal(toasts.length, 1, 'still only the one explanation');
	});

	test('Save As forgets that the refusal was said', async () => {
		// Save As gives the tab a UTF-8 file it matches, so a later lossy load into
		// the same tab is a new condition and is explained again.
		const { session, tab } = await refusedTab();
		nextSaveTarget = '/notes/copy.md';
		assert.equal(await session.saveContentAs(), true);
		assert.equal(tab.path, '/notes/copy.md');

		tabManager.setTabDecodedLossy(tab.id, true);
		tabManager.updateTabRawContent(tab.id, 'edited after the copy');
		assert.equal(await session.saveContent(tab.id), false);
		assert.equal(toasts.length, 2, 'the new refusal is explained');
	});

	test('saveContent is the choke point auto-save and the close dialogs share', async () => {
		// Auto-save (saveSilently, the debounce's writer) and the close dialog's
		// Save both reach saveContent, so the lossy guard covers them without
		// either repeating it.
		const { tab } = await refusedTab();
		writes = 0;
		const autoSave = settings.autoSave;
		settings.autoSave = true;
		try {
			const session = createDocumentSession({
				setShowHome: () => {},
				currentFile: () => tabManager.activeTab?.path ?? '',
				resetScrollHistory: () => {},
				renderMarkdown: async () => '',
				afterLoad: async () => {},
				saveRecentFile: () => {},
				deleteRecentFile: () => {},
				setLoadingTabs: () => {},
				measureInitialViewport: () => {},
				isScrolling: () => false,
				onError: () => {},
				onDiskChangedUnderSave: () => {},
				cancelPendingAutoSave: () => {},
				askClose: async () => 'save' as const,
				onCloseSaveNewerEdits: () => {},
				onCloseAutoSaveFailed: () => {},
				onPartialCopySaved: () => {},
			});
			const silent = createExternalChange({
				tabManager,
				settings: { autoSave: true, language: 'en' },
				documentSession: session,
				loadMarkdown: async () => {},
				canCloseTab: async () => true,
				readFile: async () => [LOSSY, true, 'UTF-8'],
				editorLanguageFor: () => 'markdown',
				addToast: () => {},
				t: (key) => key,
			});

			assert.equal(await silent.saveSilently(tab.id), false, 'auto-save is refused');
			assert.equal(await session.canCloseTab(tab.id), false, 'Save in the close dialog is refused');
			assert.equal(writes, 0);
			assert.equal(tab.rawContent, 'edited');
		} finally {
			settings.autoSave = autoSave;
		}
	});

	test('a closed tab is not remembered as refused', async () => {
		// `closeTab` splices the tab out with no dispose hook, so the set keeps
		// the id forever. Ids are `crypto.randomUUID()` and never reused, so this
		// is a bounded leak rather than a correctness problem — but the predicate
		// must not answer "yes" about a tab that no longer exists.
		const { session, tab } = await refusedTab();
		const id = tab.id;
		tabManager.closeTab(id);

		assert.equal(session.isLossySaveRefused(id), false);
	});
});

/*
 * #372: a document in a legacy encoding (GBK, Big5, Shift-JIS, CP-1252 …) is
 * detected and decoded on open, and a save writes it back as the SAME
 * encoding — the behaviour Notepad, VS Code and Typora all have, and the one
 * an app that calls itself "the Notepad equivalent for Markdown" is measured
 * against.
 *
 * The decoding and encoding themselves are Rust and are tested there
 * (`saving_an_unedited_legacy_document_reproduces_its_canonical_bytes` is the
 * one that matters). What has to hold on this side is the wiring, because it
 * is the wiring that decides which bytes reach the file:
 *
 *     read  →  tab.encoding  →  save
 *
 * A break anywhere in that chain does not fail loudly. It writes the user's
 * GBK document back as UTF-8, silently, on an auto-save 1.5s after the first
 * keystroke — no error, no toast, and every other tool that opens the file
 * afterwards sees mojibake. So the chain is driven here end to end rather
 * than read for.
 */
describe('document encoding round trip', () => {
	// The runes are the compiler's, not ours: vitest builds `.svelte.ts` through the
	// Svelte plugin, so the store and the session run under real reactivity, and jsdom
	// supplies `window` and `localStorage`. Only the Tauri backend is stubbed.

	/** What the backend reports for the next read. Set per test. */
	let fileEncoding = 'UTF-8';
	let fileLossy = false;
	const BODY = '# 中文标题';

	/** Every `save_file_content` the session issued, in order. */
	let writes: Array<{ path: string; content: string; encoding: string }> = [];

	beforeAll(() => {
		(window as any).__TAURI_INTERNALS__ = {
			metadata: { currentWindow: { label: 'main' }, currentWebview: { windowLabel: 'main', label: 'main' } },
			invoke: (command: string, args: Record<string, unknown>) => {
				const cmd = command.replace(/^plugin:[^|]*\|/, '');
				if (cmd === 'get_os_type') return Promise.resolve('macos');
				if (cmd === 'canonicalize_path') return Promise.resolve(args.path);
				if (cmd === 'open_markdown_preview') {
					return Promise.resolve([BODY, true, fileLossy, fileEncoding]);
				}
				if (cmd === 'read_file_content_checked') return Promise.resolve([BODY, fileLossy, fileEncoding]);
				if (cmd === 'save_file_content') {
					writes.push(args as unknown as { path: string; content: string; encoding: string });
					return Promise.resolve(null);
				}
				return Promise.resolve(null);
			},
		};
	});

	function makeSession() {
		return createDocumentSession({
			setShowHome: () => {},
			currentFile: () => tabManager.activeTab?.path ?? '',
			resetScrollHistory: () => {},
			renderMarkdown: async () => '',
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

	/** A tab opened from a file the backend reports as `encoding`. */
	async function openedAs(encoding: string, lossy = false) {
		tabManager.closeAll();
		writes = [];
		fileEncoding = encoding;
		fileLossy = lossy;
		const session = makeSession();
		await session.loadMarkdown('/notes/legacy.md');
		return { session, tab: tabManager.activeTab! };
	}

	test('opening a legacy document records the encoding it was read in', async () => {
		const { tab } = await openedAs('GBK');
		assert.equal(tab.encoding, 'GBK');
		assert.equal(tab.hasReplacementChars, false, 'a detected encoding decodes; it does not substitute');
	});

	test('saving that document writes it back as itself, not as UTF-8', async () => {
		// The whole issue in one assertion. Under the old behaviour this write
		// carried the buffer and nothing else, so the file became UTF-8 — or,
		// before the buffer was decoded at all, U+FFFD.
		const { session, tab } = await openedAs('GBK');

		tabManager.updateTabRawContent(tab.id, `${BODY}\n\nedited`);
		assert.equal(await session.saveContent(tab.id), true);

		assert.deepEqual(writes.map((write) => write.encoding), ['GBK']);
		assert.equal(writes[0].path, '/notes/legacy.md');
	});

	test('a UTF-8 document is still written as UTF-8', async () => {
		// The fence. Everything above passes for a build that writes some
		// arbitrary encoding to every file it touches.
		const { session, tab } = await openedAs('UTF-8');

		tabManager.updateTabRawContent(tab.id, 'edited');
		assert.equal(await session.saveContent(tab.id), true);

		assert.deepEqual(writes.map((write) => write.encoding), ['UTF-8']);
	});

	test('a byte order mark is a property of the file, so it is carried too', async () => {
		// Windows-authored Markdown, and the case a plain "is it UTF-8?" test
		// misses: the text decodes perfectly, and dropping the BOM on save still
		// changes the file for every tool that reads it.
		const { session, tab } = await openedAs('UTF-8-BOM');
		assert.equal(tab.encoding, 'UTF-8-BOM');

		tabManager.updateTabRawContent(tab.id, 'edited');
		assert.equal(await session.saveContent(tab.id), true);
		assert.deepEqual(writes.map((write) => write.encoding), ['UTF-8-BOM']);
	});

	test('a re-read repoints the save at what the file is NOW', async () => {
		// The user converted the file to UTF-8 in another program. The tab must
		// stop writing GBK, and it learns that from the read rather than from
		// remembering how it was first opened.
		const { session, tab } = await openedAs('GBK');

		fileEncoding = 'UTF-8';
		await session.loadMarkdown('/notes/legacy.md');
		assert.equal(tabManager.activeTab!.encoding, 'UTF-8');

		tabManager.updateTabRawContent(tab.id, 'edited');
		assert.equal(await session.saveContent(tab.id), true);
		assert.deepEqual(writes.map((write) => write.encoding), ['UTF-8']);
	});

	test('an untitled buffer has an encoding before anything has been read', async () => {
		// Required, not optional, on the Tab — so a buffer that never came from a
		// file still answers, and answers the only thing it could be.
		tabManager.closeAll();
		tabManager.addNewTab();
		assert.equal(tabManager.activeTab!.encoding, 'UTF-8');
	});

	test('a moved tab keeps its encoding across the window boundary', async () => {
		// The buffer is a decode of a file in this encoding; the destination
		// window auto-saves it. A payload that dropped the field would rewrite the
		// user's GBK document as UTF-8 the moment it landed.
		const { tab } = await openedAs('Shift_JIS');

		const payload = JSON.stringify(snapshotTab(tab));
		const validated = validateTransferPayload(payload);
		assert.notEqual(validated, null, 'precondition: the payload validates');
		assert.equal(buildTransferredTab(validated!, [], 'Untitled').encoding, 'Shift_JIS');
	});

	test('a payload without an encoding is rejected rather than defaulted', async () => {
		// Same rule as `hasReplacementChars`: a missing field must not be read as
		// "UTF-8, go ahead", because that is a write to the user's file.
		const { tab } = await openedAs('Big5');
		const { encoding, ...withoutEncoding } = snapshotTab(tab);
		void encoding;

		assert.equal(validateTransferPayload(JSON.stringify(withoutEncoding)), null);
	});
});

// Toggling a task checkbox in the preview finds the line to rewrite by counting
// `\n` up to the regex match. Three rounds of fixes for #148 were verified on
// macOS, i.e. on LF, and all three missed that the count is wrong on CRLF:
//
//   `\s` matches `\r` as well as `\n`, and JavaScript's `/m` `^` also matches
//   between a `\r` and its `\n`. With `\s*` greedy, every match began one
//   character early — on the previous line's `\n` — so the slice held one `\n`
//   too few and every task resolved to line N-1.
//
// On the LAST task that is a no-op: nothing matches `sourceLine`, `toggle`
// returns false, and the caller restores the control. The reporter reads that
// as "the checkbox does not work". Everywhere else the off-by-one lands on a
// *real* task line and silently rewrites the wrong one, which is worse and was
// never reported because nobody could see it happen.
//
// These tests drive the real document session over both line endings. The
// existing behavioural toggle test lives in `documents.load.spec.ts` and
// passes `sourceLine: 1` — the one line number the bug cannot reach, since at
// offset 0 there is no preceding terminator for `\s*` to eat.
describe('task toggle line endings', () => {
	// The runes are the compiler's, not ours: vitest builds `.svelte.ts` through the
	// Svelte plugin, so the store and the session run under real reactivity, and jsdom
	// supplies `window` and `localStorage`. Only the Tauri backend is stubbed.

	let invokeCalls: Array<{ cmd: string; args: any }> = [];
	let handleInvoke: (cmd: string, args: any) => unknown = () => {
		throw new Error('unexpected invoke');
	};

	beforeAll(() => {
		(window as any).__TAURI_INTERNALS__ = {
			metadata: { currentWindow: { label: 'main' }, currentWebview: { windowLabel: 'main', label: 'main' } },
			invoke: (cmd: string, args: any) => {
				invokeCalls.push({ cmd, args });
				return Promise.resolve(handleInvoke(cmd, args)).then((value) => value);
			},
		};
	});

	function makeSession() {
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
			onError: () => {},
			onDiskChangedUnderSave: () => {},
			cancelPendingAutoSave: () => {},
			askClose: async () => 'discard' as const,
			onCloseSaveNewerEdits: () => {},
			onCloseAutoSaveFailed: () => {},
			onPartialCopySaved: () => {},
		});
	}

	/**
	 * Opens `doc`, toggles the task on `sourceLine`, and returns what was written.
	 *
	 * Returns null when the toggle refused to write, which is the shape the last
	 * task in a CRLF document had before this fix.
	 */
	async function toggledContent(doc: string, sourceLine: number, nowChecked: boolean) {
		tabManager.closeAll();
		invokeCalls = [];
		handleInvoke = (cmd) => {
			if (cmd === 'open_markdown_preview') return [doc, false, false];
			if (cmd === 'read_file_content_checked') return [doc, false];
			if (cmd === 'save_file_content') return null;
			return null;
		};
		const session = makeSession();
		await session.loadMarkdown('/docs/tasks.md');
		await session.toggleTaskCheckbox(sourceLine, nowChecked);
		const write = invokeCalls.find((call) => call.cmd === 'save_file_content');
		return write ? (write.args.content as string) : null;
	}

	/**
	 * The same document in both line endings, so a case can be run over each.
	 *
	 * The blank line before the list is not decoration — it is the condition that
	 * makes this reachable on LF. `\s*` is greedy and `/m` `^` matches at the
	 * start of the blank line, so the match ate the blank line's terminator and
	 * `offset` landed one line early. Every list written the ordinary way, with a
	 * blank line above it, hit this on every platform; CRLF widened it from the
	 * first task of each block to all of them.
	 */
	function document(eol: string) {
		return ['intro', '', '- [ ] one', '- [ ] two', '- [ ] three'].join(eol) + eol;
	}

	/** A list that starts immediately after prose — the shape that always worked. */
	function documentWithoutBlankLine(eol: string) {
		return ['intro', '- [ ] one', '- [ ] two'].join(eol) + eol;
	}

	for (const [name, eol] of [
		['LF', '\n'],
		['CRLF', '\r\n'],
	] as const) {
		test(`${name}: the task the reader clicked is the task that changes`, async () => {
			// Line 3 is `- [ ] two`. Under the old pattern this resolved to line 2
			// and rewrote `one` instead — a silent, invisible wrong write.
			const written = await toggledContent(document(eol), 4, true);
			assert.ok(written, 'the toggle wrote');
			assert.equal(written, ['intro', '', '- [ ] one', '- [x] two', '- [ ] three'].join(eol) + eol);
		});

		test(`${name}: the last task toggles at all`, async () => {
			// Line 4 is the last task. Under the old pattern nothing matched line 4,
			// so the write was skipped entirely and the control snapped back. This
			// is the symptom #148 reports.
			const written = await toggledContent(document(eol), 5, true);
			assert.ok(written, 'the toggle wrote instead of silently refusing');
			assert.equal(written, ['intro', '', '- [ ] one', '- [ ] two', '- [x] three'].join(eol) + eol);
		});

		test(`${name}: unticking is the same arithmetic`, async () => {
			const doc = ['intro', '', '- [x] one', '- [x] two'].join(eol) + eol;
			const written = await toggledContent(doc, 4, false);
			assert.equal(written, ['intro', '', '- [x] one', '- [ ] two'].join(eol) + eol);
		});

		test(`${name}: only one line changes`, async () => {
			// The failure mode this guards is a match that spans the previous line's
			// terminator: the replacement then rewrites two lines at once.
			const before = document(eol);
			const written = await toggledContent(before, 4, true);
			assert.ok(written);
			const changed = written!
				.split(eol)
				.filter((line, index) => line !== before.split(eol)[index]);
			assert.deepEqual(changed, ['- [x] two'], 'exactly one line differs');
		});

		test(`${name}: the shapes the write-back claims to support`, async () => {
			// Ordered, parenthesised, quoted, nested and `*`/`+` bullets all go
			// through the same pattern; the CRLF bug hit every one of them.
			const doc = ['intro', '', '1. [ ] ordered', '2) [ ] paren', '> - [ ] quoted', '  * [ ] nested', '+ [ ] plus'].join(eol) + eol;
			for (const [line, expected] of [
				[3, '1. [x] ordered'],
				[4, '2) [x] paren'],
				[5, '> - [x] quoted'],
				[6, '  * [x] nested'],
				[7, '+ [x] plus'],
			] as const) {
				const written = await toggledContent(doc, line, true);
				assert.ok(written, `line ${line} wrote`);
				assert.equal(written!.split(eol)[line - 1], expected);
			}
		});
	}

	test('a tab-indented task keeps its indentation', async () => {
		// `[ \t]*` has to admit a tab, or a tab-indented task stops being found at
		// all — the failure the narrowing could plausibly have introduced.
		const doc = ['intro', '', '\t- [ ] tabbed'].join('\r\n') + '\r\n';
		const written = await toggledContent(doc, 3, true);
		assert.equal(written, ['intro', '', '\t- [x] tabbed'].join('\r\n') + '\r\n');
	});

	// The condition, isolated. A list that begins immediately after prose was
	// always correct on LF — which is why the first version of this file, whose
	// fixtures had no blank line, passed on LF and hid half the bug.
	for (const [name, eol] of [
		['LF', '\n'],
		['CRLF', '\r\n'],
	] as const) {
		test(`${name}: a list with no blank line above it`, async () => {
			const written = await toggledContent(documentWithoutBlankLine(eol), 3, true);
			assert.equal(written, ['intro', '- [ ] one', '- [x] two'].join(eol) + eol);
		});
	}

	test('LF: the first task after a blank line is the one that regressed', async () => {
		// On LF only the first task of each block was wrong: `\s*` could eat the
		// blank line's single `\n`, but not a task line above it. That is why
		// samples/stress-test.md — 44 tasks, LF — had exactly six wrong, one per
		// block. CRLF widened it to every task, because `^` also matches between
		// a `\r` and its `\n`.
		const doc = ['intro', '', '- [ ] one', '- [ ] two'].join('\n') + '\n';
		const written = await toggledContent(doc, 3, true);
		assert.equal(written, ['intro', '', '- [x] one', '- [ ] two'].join('\n') + '\n');
	});

	test('LF: two blank lines above the list', async () => {
		const doc = ['intro', '', '', '- [ ] one'].join('\n') + '\n';
		const written = await toggledContent(doc, 4, true);
		assert.equal(written, ['intro', '', '', '- [x] one'].join('\n') + '\n');
	});

	// ---------------------------------------------- the toggle does not re-render
	//
	// Ticking a checkbox writes the buffer, and MarkdownViewer's render effect
	// re-renders whenever the buffer stops matching `previewedRawContent`. It
	// would rebuild the whole article to arrive at the DOM already on screen — the
	// browser has drawn the native checkbox and the caller has added `task-done` —
	// and rebuilding drops the reader's scroll position, which in a long document
	// throws the view somewhere else entirely.

	test('a toggle tells the preview it is already up to date', async () => {
		const doc = ['intro', '', '- [ ] one', '- [ ] two'].join('\n') + '\n';
		tabManager.closeAll();
		invokeCalls = [];
		handleInvoke = (cmd) => {
			if (cmd === 'open_markdown_preview') return [doc, false, false];
			if (cmd === 'read_file_content_checked') return [doc, false];
			if (cmd === 'save_file_content') return null;
			return null;
		};
		const session = makeSession();
		await session.loadMarkdown('/docs/tasks.md');
		const tab = tabManager.activeTab!;

		await session.toggleTaskCheckbox(3, true);

		assert.equal(tab.previewedRawContent, tab.rawContent, 'the render effect has nothing to do');
	});

	// #804: with auto-save off the toggle is an unsaved edit like any other. It used
	// to save the whole buffer, taking the user's unsaved typing to disk with it.
	test('with auto-save off a toggle leaves the tab unsaved', async () => {
		const doc = ['- [ ] one'].join('\n') + '\n';
		tabManager.closeAll();
		invokeCalls = [];
		handleInvoke = (cmd) => {
			if (cmd === 'open_markdown_preview') return [doc, false, false];
			if (cmd === 'read_file_content_checked') return [doc, false];
			return null;
		};
		const session = makeSession();
		await session.loadMarkdown('/docs/tasks.md');
		const tab = tabManager.activeTab!;
		settings.autoSave = false;
		try {
			assert.equal(await session.toggleTaskCheckbox(1, true), true);
		} finally {
			settings.autoSave = true;
		}
		assert.equal(tab.rawContent, '- [x] one\n');
		assert.equal(tab.isDirty, true);
		assert.equal(invokeCalls.some((call) => call.cmd === 'save_file_content'), false);
	});

	test('a task in an untitled tab can be toggled', async () => {
		tabManager.closeAll();
		invokeCalls = [];
		handleInvoke = () => null;
		const session = makeSession();
		tabManager.addNewTab();
		const tab = tabManager.activeTab!;
		tabManager.updateTabRawContent(tab.id, '- [ ] one\n');

		assert.equal(await session.toggleTaskCheckbox(1, true), true);
		assert.equal(tab.rawContent, '- [x] one\n');
		assert.equal(invokeCalls.some((call) => call.cmd === 'save_file_content'), false);
	});
});

describe('view mode without saving', () => {
	// ---------------------------------------------------------------- environment

	// The runes are the compiler's, not ours: vitest builds `.svelte.ts` through the
	// Svelte plugin, so the store and the session run under real reactivity, and jsdom
	// supplies `window` and `localStorage`. Only the Tauri backend is stubbed.
	beforeAll(() => {
		(window as any).__TAURI_INTERNALS__ = {
			metadata: { currentWindow: { label: 'main' }, currentWebview: { windowLabel: 'main', label: 'main' } },
			invoke: () => Promise.reject(new Error('no invoke expected in these tests')),
		};
	});

	// `settings` is one store for the whole file: put back what this block changes.
	let settingsBefore: { autoSave: typeof settings.autoSave };
	beforeAll(() => {
		settingsBefore = { autoSave: settings.autoSave };
	});
	afterAll(() => {
		Object.assign(settings, settingsBefore);
	});

	const ON_DISK = '# saved heading\n';
	const IN_BUFFER = '# saved heading\n\nan edit that was never written to disk\n';

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
});
