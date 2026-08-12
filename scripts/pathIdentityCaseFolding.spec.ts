import assert from 'node:assert/strict';

import { test } from 'vitest';

// On macOS and Windows the filesystem folds case: `/notes/A.md` and
// `/notes/a.md` are ONE file. (APFS folds Unicode normalization too, so the
// NFC and NFD spellings of `café.md` are one file as well — which no amount of
// case folding in the frontend could ever reach.) Markpad compared paths with
// exact string equality in three places, and each of them broke differently
// when the same file arrived under two spellings:
//
//   1. the lossy-decode save guard let a Save As typed `/notes/Legacy.md`
//      overwrite the non-UTF-8 file the tab had opened as `/notes/legacy.md`,
//      destroying it — the one thing that guard exists to prevent;
//   2. one-tab-per-file gave two tabs on one file, i.e. two buffers with two
//      auto-save timers taking turns overwriting each other;
//   3. the reopen guard did not recognise its own file, so opening it again
//      read disk content over a buffer full of unsaved edits.
//
// All three now ask the filesystem what file a path names (the Rust
// `canonicalize_path`), once, when the path enters the app, and compare that.
//
// These tests drive the real TabManager and the real documentSession against a
// backend stubbed to behave like a case-insensitive volume. They assert
// behaviour — buffers kept, files not written, tab counts — never wording.

// The runes are the compiler's, not ours: vitest builds `.svelte.ts` through the
// Svelte plugin, so the store and the session run under real reactivity, and
// jsdom supplies `window` and `localStorage`. Only the Tauri backend is stubbed.

/** Files by their on-disk name, and whether each decoded lossily. */
const disk = new Map<string, { body: string; lossy: boolean }>();
/** Every write the session actually performed, in order. */
const writes: { path: string; content: string }[] = [];

/**
 * A case-insensitive volume, modelled the way a real one behaves: a lookup
 * matches any spelling, and what comes back is the name the DIRECTORY holds —
 * which is exactly what `realpath` reports and what `canonicalize_path`
 * returns. Nothing here lowercases a path; the on-disk name is the answer.
 */
function lookup(path: string): string | null {
	const wanted = path.toLowerCase();
	for (const name of disk.keys()) {
		if (name.toLowerCase() === wanted) return name;
	}
	return null;
}

/** What the dialog will return next. */
let nextSaveTarget: string | null = null;

(window as any).__TAURI_INTERNALS__ = {
	metadata: { currentWindow: { label: 'main' }, currentWebview: { windowLabel: 'main', label: 'main' } },
	invoke: (cmd: string, args: any) => {
		if (cmd === 'canonicalize_path') {
			const resolved = lookup(args.path);
			// A name nothing answers to is still a legal target (Save As to a
			// new file); the backend resolves its directory and keeps the name.
			return Promise.resolve(resolved ?? args.path);
		}
		if (cmd === 'read_file_content_checked') {
			const file = disk.get(lookup(args.path) ?? args.path);
			return Promise.resolve([file?.body ?? '', file?.lossy ?? false]);
		}
		if (cmd === 'open_markdown_preview') {
			const file = disk.get(lookup(args.path) ?? args.path);
			return Promise.resolve(['', file?.body ?? '', true, file?.lossy ?? false]);
		}
		if (cmd === 'save_file_content') {
			writes.push({ path: args.path, content: args.content });
			disk.set(lookup(args.path) ?? args.path, { body: args.content, lossy: false });
			return Promise.resolve(null);
		}
		// The Save As dialog. `@tauri-apps/plugin-dialog`'s `save()` is a thin
		// wrapper over this command, so stubbing it here needs no module
		// patching and exercises the real wrapper.
		if (cmd === 'plugin:dialog|save') return Promise.resolve(nextSaveTarget);
		if (cmd === 'get_os_type') return Promise.resolve('macos');
		return Promise.resolve(null);
	},
};

const { tabManager } = await import('../src/lib/stores/tabs.svelte.js');
const { createDocumentSession } = await import('../src/lib/sessions/documentSession.svelte.js');

const errors: string[] = [];

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
		onError: (message: string) => void errors.push(message),
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
	localStorage.clear();
	disk.clear();
	writes.length = 0;
	errors.length = 0;
	nextSaveTarget = null;
}

// --- gap 1: the lossy-decode save guard -----------------------------------

test('Save As in a different case is still an overwrite of the source file', async () => {
	// The file is GBK, so its buffer is U+FFFD mojibake and writing it back
	// destroys the document — that is what `refuseIfLossilyDecoded` stops. The
	// user opened it as `/notes/legacy.md`; the Save As dialog comes back with
	// `/notes/Legacy.md`. On this volume that is the SAME FILE, so the refusal
	// has to hold, or the guard is one autocomplete away from being bypassed.
	reset();
	const session = makeSession();
	disk.set('/notes/legacy.md', { body: '# �� mojibake', lossy: true });

	await session.loadMarkdown('/notes/legacy.md');
	assert.equal(tabManager.activeTab?.hasReplacementChars, true, 'precondition: the buffer is known lossy');

	nextSaveTarget = '/notes/Legacy.md';
	const saved = await session.saveContentAs();

	assert.equal(saved, false, 'the refusal must hold');
	assert.deepEqual(writes, [], 'nothing may be written over the source file');
	assert.equal(disk.get('/notes/legacy.md')?.body, '# �� mojibake', 'the document is intact');
});

test('Save As to a genuinely different file stays open as the escape hatch', async () => {
	// The other direction, and the one that must not regress: the whole point
	// of refusing is that the user can still write a UTF-8 copy somewhere else.
	reset();
	const session = makeSession();
	disk.set('/notes/legacy.md', { body: '# �� mojibake', lossy: true });

	await session.loadMarkdown('/notes/legacy.md');
	nextSaveTarget = '/notes/legacy-utf8.md';
	const saved = await session.saveContentAs();

	assert.equal(saved, true);
	assert.equal(writes.length, 1);
	assert.equal(writes[0].path, '/notes/legacy-utf8.md');
	assert.equal(tabManager.activeTab?.hasReplacementChars, false, 'the copy is UTF-8, so the tab is savable again');
});

// --- gap 2: one tab per file ----------------------------------------------

test('opening one file under two spellings leaves one tab, not two', async () => {
	// Two tabs on one file are two buffers with two dirty flags and two
	// auto-save timers writing the same file in turn; whichever lands last
	// silently overwrites the other's work.
	reset();
	const session = makeSession();
	disk.set('/notes/A.md', { body: 'shared body', lossy: false });

	await session.loadMarkdown('/notes/A.md');
	const first = tabManager.activeTabId;
	await session.loadMarkdown('/notes/a.md');

	assert.equal(tabManager.tabs.length, 1, 'one file, one tab');
	assert.equal(tabManager.activeTabId, first, 'the request resolved to the tab that already held it');
});

test('two genuinely different files still get their own tabs', async () => {
	// The guard against over-merging: nothing above may collapse files that
	// differ by more than spelling.
	reset();
	const session = makeSession();
	disk.set('/notes/a.md', { body: 'a', lossy: false });
	disk.set('/notes/b.md', { body: 'b', lossy: false });

	await session.loadMarkdown('/notes/a.md');
	await session.loadMarkdown('/notes/b.md');

	assert.equal(tabManager.tabs.length, 2);
});

test('Save As onto a file already open under another spelling does not leave two tabs on it', async () => {
	// Reached through `updateTabPath` rather than `addTab`, and the file is
	// already written by the time the store hears about it — so the loser's
	// buffer is stale no matter which way the name was spelled.
	reset();
	const session = makeSession();
	disk.set('/notes/A.md', { body: 'original', lossy: false });
	await session.loadMarkdown('/notes/A.md');

	tabManager.addNewTab();
	const draft = tabManager.activeTabId!;
	tabManager.updateTabRawContent(draft, 'replacement');

	nextSaveTarget = '/notes/a.md';
	assert.equal(await session.saveContentAs(), true);

	assert.equal(
		tabManager.tabs.filter((tab) => tab.path !== '').length,
		1,
		'exactly one tab may claim the file',
	);
	assert.equal(tabManager.activeTabId, draft, 'the tab that owns the bytes on disk keeps it');
});

// --- gap 3: the reopen guard ----------------------------------------------

// The guard runs on the tab the content is about to land in, so it only sees a
// mis-spelled path on the routes that pick the tab themselves and pass
// `navigate` / `skipTabManagement`: a link followed in place, and back/forward.
// A link written `./A.md` inside a document whose tab is open as `/notes/a.md`
// is that case exactly — and it is the ordinary way to reach it, since link
// text is typed by the document's author, not by the filesystem.
test('following a link that spells the current file differently does not overwrite its unsaved edits', async () => {
	// `setTabRawContent` replaces rawContent AND originalContent, so the reload
	// would not merely lose the edits — the tab would look clean afterwards and
	// the user could not tell what went missing.
	reset();
	const session = makeSession();
	disk.set('/notes/a.md', { body: 'on disk', lossy: false });

	await session.loadMarkdown('/notes/a.md');
	const id = tabManager.activeTabId!;
	tabManager.updateTabRawContent(id, 'my unsaved paragraph');

	await session.loadMarkdown('/notes/A.md', { navigate: true });

	const tab = tabManager.tabs.find((item) => item.id === id)!;
	assert.equal(tab.rawContent, 'my unsaved paragraph', 'the edits survive');
	assert.equal(tab.originalContent, 'on disk', 'the saved baseline is intact, so the tab can still say what changed');
	assert.equal(tab.isDirty, true, 'the tab still knows it has something to save');
});

test('an explicit revert still discards the buffer whatever the spelling', async () => {
	// "Reload from disk" and the external-change "Reload" pass
	// `discardUnsavedBuffer`; the identity fix must not make them unreachable.
	reset();
	const session = makeSession();
	disk.set('/notes/a.md', { body: 'on disk', lossy: false });

	await session.loadMarkdown('/notes/a.md');
	const id = tabManager.activeTabId!;
	tabManager.updateTabRawContent(id, 'my unsaved paragraph');

	await session.loadMarkdown('/notes/A.md', { navigate: true, discardUnsavedBuffer: true });

	const tab = tabManager.tabs.find((item) => item.id === id)!;
	assert.equal(tab.rawContent, 'on disk');
	assert.equal(tab.isDirty, false);
});

// --- the fallback ----------------------------------------------------------

test('a path the backend cannot resolve is compared exactly, as before', async () => {
	// An unreachable network volume, a deleted parent directory, or any route
	// that has not resolved a path yet must cost the improvement and nothing
	// more: the literal comparison is what every one of these sites did before.
	const { isSameFilePath } = await import('../src/lib/utils/pathIdentity.js');

	assert.equal(isSameFilePath({ path: '/notes/A.md' }, { path: '/notes/a.md' }), false);
	assert.equal(isSameFilePath({ path: '/notes/A.md' }, { path: '/notes/A.md' }), true);
	// A key is trusted only when BOTH sides have one: `/notes/today.md` may be
	// a symlink whose key is `/archive/2026-08-03.md`, so a bare path that
	// happens to equal someone else's key proves nothing.
	assert.equal(
		isSameFilePath({ path: '/notes/today.md', pathKey: '/archive/x.md' }, { path: '/archive/x.md' }),
		false,
	);
	assert.equal(
		isSameFilePath(
			{ path: '/notes/today.md', pathKey: '/archive/x.md' },
			{ path: '/archive/x.md', pathKey: '/archive/x.md' },
		),
		true,
	);
	// Untitled buffers and the home sentinel are not files and never collide.
	assert.equal(isSameFilePath({ path: '' }, { path: '' }), false);
	assert.equal(isSameFilePath({ path: 'HOME' }, { path: 'HOME' }), false);
});
