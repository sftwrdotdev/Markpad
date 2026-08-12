import assert from 'node:assert/strict';
import test from 'node:test';

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

const g = globalThis as any;
const runeEffect = (fn: () => void) => {
	void fn;
};
runeEffect.root = (fn: () => unknown) => fn();
g.$state = (value: unknown) => value;
g.$state.raw = (value: unknown) => value;
g.$state.snapshot = (value: unknown) => value;
g.$derived = (value: unknown) => value;
g.$derived.by = (fn: () => unknown) => fn();
g.$effect = runeEffect;
g.window = g.window ?? {};

const localStore = new Map<string, string>();
g.localStorage = {
	getItem: (key: string) => (localStore.has(key) ? localStore.get(key)! : null),
	setItem: (key: string, value: string) => void localStore.set(key, String(value)),
	removeItem: (key: string) => void localStore.delete(key),
	clear: () => localStore.clear(),
};

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

g.window.__TAURI_INTERNALS__ = {
	metadata: { currentWindow: { label: 'main' }, currentWebview: { windowLabel: 'main', label: 'main' } },
	invoke: (cmd: string, args: any) => {
		if (cmd === 'canonicalize_path') return Promise.resolve(args.path);
		if (cmd === 'read_file_content_checked') return Promise.resolve([disk.get(args.path) ?? '', false]);
		if (cmd === 'open_markdown_preview') return Promise.resolve(['', disk.get(args.path) ?? '', true, false]);
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

const { tabManager } = await import('../src/lib/stores/tabs.svelte.js');
const { settings } = await import('../src/lib/stores/settings.svelte.js');
const { createDocumentSession } = await import('../src/lib/sessions/documentSession.svelte.js');

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
		renderRichContent: () => {},
		onError: () => {},
		selfWriteGraceMs: 400,
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
	localStore.clear();
	disk.clear();
	unsettledWrites = 0;
	sawOverlap = false;
	writeDurationsMs = [];
	writeCount = 0;
	nextSaveTarget = null;
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
