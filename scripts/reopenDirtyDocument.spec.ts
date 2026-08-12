import assert from 'node:assert/strict';
import { test } from 'vitest';

import { readSource, sliceBetween } from './sourceTree.js';

// Opening a file that is ALREADY open in a tab with unsaved edits must not
// re-read it from disk. `setTabRawContent` replaces rawContent AND
// originalContent, so the edits would not merely be overwritten — the tab
// would look clean afterwards and the user could not tell what was lost.
//
// This is the same loss `resolveExternalChange` already refuses for a watcher
// event (#374), reached through the ordinary open path instead: recent files,
// drag-and-drop, the OS handing us a path, or a link opened in a new tab.
// Discarding a buffer stays what it is everywhere else — an explicit command
// ("Reload from disk", the external-change "Reload"), never a side effect of
// asking to see a file.

// The runes are the compiler's, not ours: vitest builds `.svelte.ts` through the
// Svelte plugin, so the store and the session run under real reactivity. Only
// the Tauri backend, which jsdom cannot provide, is stubbed.

// What the file says right now, and every read the session performed.
const disk = new Map<string, string>();
const reads: string[] = [];

(window as any).__TAURI_INTERNALS__ = {
	metadata: { currentWindow: { label: 'main' }, currentWebview: { windowLabel: 'main', label: 'main' } },
	invoke: (cmd: string, args: any) => {
		if (cmd === 'read_file_content_checked') {
			reads.push(args.path);
			return Promise.resolve([disk.get(args.path) ?? '', false]);
		}
		if (cmd === 'open_markdown_preview') {
			reads.push(args.path);
			return Promise.resolve(['', disk.get(args.path) ?? '', true, false]);
		}
		if (cmd === 'get_os_type') return Promise.resolve('macos');
		return Promise.resolve(null);
	},
};

const { tabManager } = await import('../src/lib/stores/tabs.svelte.js');
const { createDocumentSession } = await import('../src/lib/sessions/documentSession.svelte.js');

// Cwd-relative, not `import.meta.url`: see the note on `readSource`.
const viewer = readSource('src/lib/MarkdownViewer.svelte');

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
	localStorage.clear();
	disk.clear();
	reads.length = 0;
}

/** A tab holding `path`, edited but not saved. */
function openEdited(path: string, onDisk: string, edits: string) {
	disk.set(path, onDisk);
	tabManager.addTab(path, onDisk);
	const id = tabManager.activeTabId!;
	tabManager.updateTabRawContent(id, edits);
	return tabManager.tabs.find((tab) => tab.id === id)!;
}

// --- opening a file must never cost a buffer ---

// `openMarkdownTargetInNewTab` calls `addTab` and then loads with
// `skipTabManagement`, so whatever tab `addTab` leaves active is the one the
// disk content lands in. Today that is always a fresh tab, so this passes
// without the guard — it is pinned here because it is the invariant, and any
// future change to how an already-open path is resolved has to keep it.
//
// It asserts ONLY that the edits survive: no tab counts, no active-tab
// identity, nothing about how the request was routed. A failure here means
// work was destroyed, and nothing else.
test('following a link into a new tab never costs the target tab its unsaved edits', async () => {
	reset();
	const session = makeSession();
	const edited = openEdited('/notes/target.md', 'on disk', 'my unsaved paragraph');
	tabManager.addTab('/notes/from.md', 'from text');

	// Exactly what openMarkdownTargetInNewTab does.
	tabManager.addTab('/notes/target.md');
	await session.loadMarkdown('/notes/target.md', { skipTabManagement: true, resetScrollHistory: true });

	assert.equal(edited.rawContent, 'my unsaved paragraph');
	assert.equal(edited.originalContent, 'on disk', 'the saved baseline is intact, so the tab can still tell you what changed');
	assert.equal(edited.isDirty, true, 'the tab still knows it has something to save');
});

// One tab per path makes `addTab` resolve the click to the tab that already
// holds the file instead of building a second one — which is what hands that
// edited buffer to the loader in the first place. The test above is what makes
// that safe; this one is what makes it useful.
test('following a link into a new tab shows the tab that already holds the file', async () => {
	reset();
	const session = makeSession();
	const edited = openEdited('/notes/target.md', 'on disk', 'my unsaved paragraph');
	tabManager.addTab('/notes/from.md', 'from text');

	tabManager.addTab('/notes/target.md');
	await session.loadMarkdown('/notes/target.md', { skipTabManagement: true, resetScrollHistory: true });

	assert.equal(tabManager.tabs.filter((tab) => tab.path === '/notes/target.md').length, 1);
	assert.equal(tabManager.activeTabId, edited.id);
	assert.deepEqual(reads, [], 'the file is not even read');
});

test('the call shape this guards is still the one MarkdownViewer uses', () => {
	const fn = sliceBetween(viewer, 'async function openMarkdownTargetInNewTab', '\n\tasync function');
	assert.match(fn, /tabManager\.addTab\(/);
	assert.match(fn, /loadMarkdown\([^)]*\{[^}]*skipTabManagement: true/);
});

// --- the pre-existing loss, independent of one-tab-per-path ---

test('re-opening an edited file from recents activates its tab instead of reloading it', async () => {
	reset();
	const session = makeSession();
	const edited = openEdited('/notes/a.md', 'on disk', 'my unsaved paragraph');
	tabManager.addTab('/notes/b.md', 'b');

	await session.loadMarkdown('/notes/a.md');

	assert.equal(edited.rawContent, 'my unsaved paragraph');
	assert.equal(edited.originalContent, 'on disk');
	assert.equal(edited.isDirty, true);
	assert.equal(tabManager.activeTabId, edited.id);
	assert.deepEqual(reads, []);
});

test('re-opening the edited file already in front does not reload it either', async () => {
	reset();
	const session = makeSession();
	const edited = openEdited('/notes/a.md', 'on disk', 'my unsaved paragraph');

	// The Home screen is an overlay, not a tab switch: opening the file you are
	// already editing leaves activeTabId alone, so "did we switch tabs?" is not
	// a safe test for this.
	await session.loadMarkdown('/notes/a.md');

	assert.equal(edited.rawContent, 'my unsaved paragraph');
	assert.equal(edited.isDirty, true);
	assert.deepEqual(reads, []);
});

// --- the guard must not block the ordinary paths ---

test('a clean tab is reloaded from disk as before', async () => {
	reset();
	const session = makeSession();
	disk.set('/notes/a.md', 'first');
	tabManager.addTab('/notes/a.md', 'first');
	const id = tabManager.activeTabId!;

	disk.set('/notes/a.md', 'second');
	await session.loadMarkdown('/notes/a.md');

	const tab = tabManager.tabs.find((item) => item.id === id)!;
	assert.equal(tab.rawContent, 'second');
	assert.equal(tab.isDirty, false);
	assert.deepEqual(reads, ['/notes/a.md']);
});

test('an edited tab following a link to a DIFFERENT file still loads it', async () => {
	reset();
	const session = makeSession();
	disk.set('/notes/b.md', 'b on disk');
	const edited = openEdited('/notes/a.md', 'a on disk', 'edits');

	// `navigate` rewrites this tab's path; the caller has already dealt with the
	// buffer (canCloseTab) before getting here.
	await session.loadMarkdown('/notes/b.md', { navigate: true });

	assert.equal(edited.path, '/notes/b.md');
	assert.equal(edited.rawContent, 'b on disk');
	assert.deepEqual(reads, ['/notes/b.md']);
});

// --- reverting is still possible, and only by saying so ---
//
// Authorization is declared by the caller, never inferred by the session from
// nearby state. An earlier draft let an unanswered external-change conflict
// stand in for the user's "Reload" click; that is guessing intent from an
// adjacent flag, and two callers can be in that state for different reasons.

// The two revert commands, and only those two. Anything else that starts
// passing this flag is a caller claiming the user chose to lose work.
for (const name of ['resolveExternalChangeByReloading', 'reloadFromDisk']) {
	test(`${name} declares that it is discarding the buffer`, () => {
		const fn = sliceBetween(viewer, `async function ${name}`, '\n\t}');
		assert.match(fn, /loadMarkdown\(/);
		assert.match(fn, /discardUnsavedBuffer: true/);
	});
}

test('nothing else in the viewer asks to discard a buffer', () => {
	assert.equal(viewer.match(/discardUnsavedBuffer: true/g)?.length, 2);
});

test('a Reload of a file changed under unsaved edits replaces the buffer', async () => {
	reset();
	const session = makeSession();
	const edited = openEdited('/notes/a.md', 'on disk', 'my unsaved paragraph');

	disk.set('/notes/a.md', 'someone else wrote this');
	const outcome = session.resolveExternalChange('/notes/a.md');
	assert.equal(outcome.action, 'conflict', 'the watcher never reloads it on its own');

	// The options resolveExternalChangeByReloading passes, verbatim.
	await session.loadMarkdown('/notes/a.md', {
		preserveEditState: true,
		skipTabManagement: true,
		resetScrollHistory: true,
		discardUnsavedBuffer: true,
	});

	assert.equal(edited.rawContent, 'someone else wrote this');
	assert.equal(edited.isDirty, false);
	assert.deepEqual(reads, ['/notes/a.md']);
});

test('a conflict alone does not authorize the next open to discard the buffer', async () => {
	reset();
	const session = makeSession();
	const edited = openEdited('/notes/a.md', 'on disk', 'my unsaved paragraph');

	disk.set('/notes/a.md', 'someone else wrote this');
	session.resolveExternalChange('/notes/a.md');

	// Same tab, same path, conflict outstanding — but this is an open, and it
	// did not ask to discard anything.
	await session.loadMarkdown('/notes/a.md');

	assert.equal(edited.rawContent, 'my unsaved paragraph');
	assert.equal(edited.isDirty, true);
	assert.deepEqual(reads, []);
});
