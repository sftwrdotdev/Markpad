import assert from 'node:assert/strict';

import { test } from 'vitest';

import { readSource, sliceBetween } from './sourceTree.js';

// Live Mode watches the open file and reloads it when something else writes
// it — git checkout, a cloud sync, a second Markpad window. The reload path
// replaces rawContent AND originalContent, so a buffer with unsaved edits is
// not just overwritten, it stops looking dirty afterwards: the user cannot
// even tell what they lost. Turning Live Mode ON must likewise never pull
// disk content over the buffer; it only installs the watcher.
//
// Whether an event is somebody else's write used to be guessed from the clock:
// each of our own writes opened a 400ms window in which events for that path
// were discarded. Both directions of that guess were wrong and both are tested
// below — a foreign write inside the window was DROPPED and then overwritten by
// the next auto-save, and a late event about our own write raised a conflict
// bar about nothing. `originalContent` answers the question exactly, and the
// same answer now also guards the write itself, which is the half that works
// when the watcher does not.

// The runes are the compiler's, not ours: vitest builds `.svelte.ts` through the
// Svelte plugin, so the store and the session run under real reactivity, and jsdom
// supplies `window` and `localStorage`. Only the Tauri backend is stubbed.

/**
 * The filesystem, as far as these tests are concerned. Real enough for the
 * question every test here asks — "what does the file say right now?" — and the
 * reason the suite no longer needs to fake a clock.
 */
const disk = new Map<string, string>();

let handleInvoke: (cmd: string, args: any) => unknown = (cmd, args) => {
	if (cmd === 'canonicalize_path') return args.path;
	if (cmd === 'read_file_content_checked') {
		if (!disk.has(args.path)) throw new Error(`no such file: ${args.path}`);
		return [disk.get(args.path), false, 'UTF-8'];
	}
	if (cmd === 'save_file_content') {
		disk.set(args.path, args.content);
		return null;
	}
	throw new Error(`unexpected invoke: ${cmd}`);
};
(window as any).__TAURI_INTERNALS__ = {
	metadata: { currentWindow: { label: 'main' }, currentWebview: { windowLabel: 'main', label: 'main' } },
	invoke: (cmd: string, args: any) => Promise.resolve(handleInvoke(cmd, args)),
};

const { tabManager } = await import('../src/lib/stores/tabs.svelte.js');
const { createDocumentSession } = await import('../src/lib/sessions/documentSession.svelte.js');

const viewer = readSource('src/lib/MarkdownViewer.svelte');

let refusedSaves: string[] = [];

function makeSession(overrides: Record<string, unknown> = {}) {
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
		renderRichContent: () => {},
		onError: () => {},
		onDiskChangedUnderSave: (tabId: string) => refusedSaves.push(tabId),
		cancelPendingAutoSave: () => {},
		askClose: async () => 'discard' as const,
		onCloseSaveNewerEdits: () => {},
		onCloseAutoSaveFailed: () => {},
		onPartialCopySaved: () => {},
		...overrides,
	});
}

/** A file on disk, open in a tab whose buffer matches it. */
function open(path: string, content: string) {
	disk.set(path, content);
	tabManager.addTab(path, content);
	const tab = tabManager.activeTab!;
	tab.originalContent = content;
	return tab;
}

function reset() {
	tabManager.closeAll();
	disk.clear();
	refusedSaves = [];
}

test('a clean tab that owns the changed file is reloaded', async () => {
	reset();
	const session = makeSession();
	const tab = open('/notes/a.md', 'on disk');
	disk.set('/notes/a.md', 'somebody else wrote this');

	assert.deepEqual(await session.resolveExternalChange('/notes/a.md'), {
		action: 'reload',
		tabId: tab.id,
		path: '/notes/a.md',
	});
});

test('a tab with unsaved edits is never reloaded behind the user', async () => {
	reset();
	const session = makeSession();
	const tab = open('/notes/a.md', 'on disk');
	tabManager.updateTabRawContent(tab.id, 'my unsaved paragraph');
	disk.set('/notes/a.md', 'somebody else wrote this');

	const outcome = await session.resolveExternalChange('/notes/a.md');

	assert.equal(outcome.action, 'conflict');
	assert.equal((outcome as { tabId: string }).tabId, tab.id);
	// The buffer and its dirty marker must both survive: overwriting
	// originalContent is what made the loss invisible after the fact.
	assert.equal(tab.rawContent, 'my unsaved paragraph');
	assert.equal(tab.originalContent, 'on disk');
	assert.equal(tab.isDirty, true);
});

test('the changed path decides which tab is affected, not whichever tab is active', async () => {
	reset();
	const session = makeSession();
	const a = open('/notes/a.md', 'a on disk');
	const b = open('/notes/b.md', 'b on disk');
	tabManager.setActive(b.id);
	tabManager.updateTabRawContent(b.id, 'b unsaved');
	disk.set('/notes/a.md', 'a changed');

	const outcome = await session.resolveExternalChange('/notes/a.md');

	// Reloading here would pull b.md's disk content over b's unsaved buffer
	// because a.md changed. Whatever the outcome, it must not name tab b.
	assert.notEqual((outcome as { tabId?: string }).tabId, b.id);
	assert.equal(b.rawContent, 'b unsaved');
	assert.notEqual(a.id, b.id);
});

test('a change to a file no tab holds is ignored', async () => {
	reset();
	const session = makeSession();
	open('/notes/a.md', 'a on disk');

	assert.deepEqual(await session.resolveExternalChange('/notes/elsewhere.md'), { action: 'ignore' });
	assert.deepEqual(await session.resolveExternalChange(''), { action: 'ignore' });
});

test('our own write is not an external change, however late the event arrives', async () => {
	reset();
	const session = makeSession();
	const tab = open('/notes/a.md', 'on disk');
	tabManager.updateTabRawContent(tab.id, 'my edit');
	assert.equal(await session.saveContent(tab.id), true);

	// No clock is consulted, so there is no window to be outside of. The old
	// guard answered this correctly for 400ms and then started answering it
	// wrong; a slow watcher, a network share or a synced folder is all it took.
	assert.deepEqual(await session.resolveExternalChange('/notes/a.md'), { action: 'ignore' });
	assert.deepEqual(await session.resolveExternalChange('/notes/a.md'), { action: 'ignore' });
});

test('a late event about our own save is not raised as a conflict', async () => {
	// The second failure of the clock, and the one that costs trust rather than
	// data: with the user typing again after a save, an event that arrived after
	// the window found a dirty tab and asked "this file changed on disk" about
	// their own keystrokes. Zed is disliked for exactly this
	// (zed-industries/zed#42108) — a question that is sometimes false gets
	// dismissed the times it is true.
	reset();
	const session = makeSession();
	const tab = open('/notes/a.md', 'on disk');
	tabManager.updateTabRawContent(tab.id, 'my edit');
	assert.equal(await session.saveContent(tab.id), true);
	tabManager.updateTabRawContent(tab.id, 'my edit, and more');

	assert.deepEqual(await session.resolveExternalChange('/notes/a.md'), { action: 'ignore' });
	assert.equal(tab.isDirty, true, 'and the later typing is still unsaved');
});

test('a foreign write moments after our own is still reported', async () => {
	// The direction that lost data. Inside the old 400ms window this event was
	// DISCARDED with nothing re-queued: the buffer held our text, the disk held
	// theirs, the tab looked clean, and the next keystroke's auto-save put ours
	// back over theirs. Nothing anywhere said so.
	reset();
	const session = makeSession();
	const tab = open('/notes/a.md', 'on disk');
	tabManager.updateTabRawContent(tab.id, 'my edit');
	assert.equal(await session.saveContent(tab.id), true);

	disk.set('/notes/a.md', 'their edit, one moment later');

	assert.deepEqual(await session.resolveExternalChange('/notes/a.md'), {
		action: 'reload',
		tabId: tab.id,
		path: '/notes/a.md',
	});
});

// --- the guard that does not depend on the watcher ---

test('a save is refused when the disk moved under it', async () => {
	// Live Mode is off by default and its events can be missed, so this is the
	// check every editor that does not lose work has: VS Code refuses the save
	// ("The content of the file is newer"), Vim re-stats before each write, and
	// Vim has no watcher at all.
	reset();
	const session = makeSession();
	const tab = open('/notes/a.md', 'on disk');
	tabManager.updateTabRawContent(tab.id, 'my edit');
	disk.set('/notes/a.md', 'their edit');

	assert.equal(await session.saveContent(tab.id), false);
	assert.equal(disk.get('/notes/a.md'), 'their edit', 'their work was overwritten anyway');
	assert.deepEqual(refusedSaves, [tab.id], 'the refusal was not reported, so nothing asked the user');
	assert.equal(tab.rawContent, 'my edit', 'and the refusal must not cost the user their buffer');
	assert.equal(tab.isDirty, true);
});

test('answering "keep mine" authorises the next save, and only the next one', async () => {
	reset();
	const session = makeSession();
	const tab = open('/notes/a.md', 'on disk');
	tabManager.updateTabRawContent(tab.id, 'my edit');
	disk.set('/notes/a.md', 'their edit');
	assert.equal(await session.saveContent(tab.id), false);

	session.allowOverwriteOnce(tab.id);
	assert.equal(await session.saveContent(tab.id), true);
	assert.equal(disk.get('/notes/a.md'), 'my edit');

	// A third program writing a minute later is a new question the user has not
	// answered, so the authorisation must not still be lying around.
	tabManager.updateTabRawContent(tab.id, 'my later edit');
	disk.set('/notes/a.md', 'somebody else again');
	assert.equal(await session.saveContent(tab.id), false);
	assert.equal(disk.get('/notes/a.md'), 'somebody else again');
});

test('an ordinary save of an untouched file still just saves', async () => {
	// The guard has to be invisible in the common case, which is every save.
	reset();
	const session = makeSession();
	const tab = open('/notes/a.md', 'on disk');
	tabManager.updateTabRawContent(tab.id, 'my edit');

	assert.equal(await session.saveContent(tab.id), true);
	assert.equal(disk.get('/notes/a.md'), 'my edit');
	assert.deepEqual(refusedSaves, []);
	assert.equal(tab.isDirty, false);
});

// --- wiring that cannot be executed outside a Svelte runtime ---

test('the watcher listener routes every event through the guarded resolution', () => {
	const body = sliceBetween(viewer, "listen('file-changed'", '}),');
	assert.match(body, /resolveExternalChange/);
	// The old body called loadMarkdown(currentFile) directly.
	assert.doesNotMatch(body, /loadMarkdown\(currentFile\)/);
});

test('a conflict is surfaced with both choices instead of resolving itself', () => {
	assert.match(viewer, /externalChangeConflicts/);
	assert.match(viewer, /t\('externalChange\.reload'/);
	assert.match(viewer, /t\('externalChange\.keepMine'/);
});

test('the debounced auto-save is held back while a conflict is unanswered', () => {
	// Otherwise the 1.5s timer fires while the bar is still asking "reload or
	// keep mine": the user's edits survive, but the external change is gone
	// from disk before either answer can be given.
	const body = sliceBetween(viewer, 'Auto-save effect.', 'for (const id of [');
	assert.match(body, /hasPendingConflict: externalChangeConflicts\[tab\.id\] === true/);
	assert.match(body, /const eligible = [^;]*!s\.hasPendingConflict/);
});

test('an explicit save answers the conflict and takes the bar down', () => {
	// Pressing Cmd+S is a decision. Leaving the bar up afterwards would ask a
	// question the user already answered.
	const body = sliceBetween(viewer, 'async function saveContent(tabId?: string)', 'async function saveContentAs');
	assert.match(body, /clearExternalChangeConflict/);
});

test('turning Live Mode on installs the watcher without reloading', () => {
	// Enabling a watcher is not a request to discard the buffer, and this was
	// the one loadMarkdown call in the app with no canCloseTab in front of it.
	const body = sliceBetween(viewer, 'function toggleLiveMode', '\n\t}');
	assert.doesNotMatch(body, /loadMarkdown/);
});

// --- #692: the editor is where the reload has to land ---

test('reloading a clean tab does not throw the user out of the editor', async () => {
	// The gate on the Auto-Reload button used to hide it in edit mode, so this
	// path was reachable only by enabling Live Mode in the preview and then
	// pressing Edit. Now that editing is the case the button is FOR, a reload
	// that dropped the tab back to preview would be the visible bug.
	//
	// `loadMarkdown(path)` with no options is exactly the call the
	// `file-changed` listener makes for a `reload` outcome.
	const session = makeSession();
	const tab = open('/notes/live.md', 'before');
	tab.isEditing = true;

	handleInvoke = (cmd) => {
		if (cmd === 'canonicalize_path') return '/notes/live.md';
		// An editing pane always gets the whole file, never the 5MB preview
		// slice — an editor bound to a partial buffer auto-saves it back over
		// the document's tail.
		if (cmd === 'read_file_content_checked') return ['after', false, 'UTF-8'];
		throw new Error(`unexpected invoke: ${cmd}`);
	};

	await session.loadMarkdown('/notes/live.md');

	assert.equal(tabManager.activeTab?.rawContent, 'after', 'the disk version did not arrive');
	assert.equal(tabManager.activeTab?.isEditing, true, 'the reload left the editor');
	assert.equal(tabManager.activeTab?.isDirty, false, 'the reloaded buffer is not an edit');
});

test('entering split view no longer turns Live Mode off behind the user', () => {
	// #692. Split used to kill live mode on the way in, with no comment and no
	// way back — the setting was silently dropped and stayed dropped after
	// leaving. That line arrived with the original split-view commit and reads
	// as a consequence of the Auto-Reload button being hidden there (nothing
	// left to turn it off with) rather than a decision that a split pane should
	// not follow the file. The button and the chord are now offered in all
	// three modes; a kill here would take the state straight back off.
	//
	// An absence claim about a component that cannot be imported, so it is
	// matched as source text — the same reason as the four assertions above.
	const body = sliceBetween(viewer, 'async function toggleSplitView', '\n\t}');
	assert.doesNotMatch(body, /toggleLiveMode|liveMode\s*=/);
});
