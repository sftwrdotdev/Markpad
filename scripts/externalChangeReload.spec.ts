import assert from 'node:assert/strict';

import { test } from 'vitest';

import { readSource, sliceBetween } from './sourceTree.js';

// Live Mode watches the open file and reloads it when something else writes
// it — git checkout, a cloud sync, a second Markpad window. The reload path
// replaces rawContent AND originalContent, so a buffer with unsaved edits is
// not just overwritten, it stops looking dirty afterwards: the user cannot
// even tell what they lost. Turning Live Mode ON must likewise never pull
// disk content over the buffer; it only installs the watcher.

// The runes are the compiler's, not ours: vitest builds `.svelte.ts` through the
// Svelte plugin, so the store and the session run under real reactivity, and jsdom
// supplies `window` and `localStorage`. Only the Tauri backend is stubbed.
let handleInvoke: (cmd: string, args: any) => unknown = (cmd) => {
	throw new Error(`unexpected invoke: ${cmd}`);
};
(window as any).__TAURI_INTERNALS__ = {
	metadata: { currentWindow: { label: 'main' }, currentWebview: { windowLabel: 'main', label: 'main' } },
	invoke: (cmd: string, args: any) => Promise.resolve(handleInvoke(cmd, args)),
};

const { tabManager } = await import('../src/lib/stores/tabs.svelte.js');
const { createDocumentSession } = await import('../src/lib/sessions/documentSession.svelte.js');

const viewer = readSource('src/lib/MarkdownViewer.svelte');

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
		selfWriteGraceMs: 400,
		cancelPendingAutoSave: () => {},
		askClose: async () => 'discard' as const,
		onCloseSaveNewerEdits: () => {},
		onCloseAutoSaveFailed: () => {},
		onPartialCopySaved: () => {},
		...overrides,
	});
}

function open(path: string, content: string) {
	tabManager.addTab(path, content);
	return tabManager.activeTab!;
}

test('a clean tab that owns the changed file is reloaded', () => {
	tabManager.closeAll();
	const session = makeSession();
	const tab = open('/notes/a.md', 'on disk');

	assert.deepEqual(session.resolveExternalChange('/notes/a.md'), {
		action: 'reload',
		tabId: tab.id,
		path: '/notes/a.md',
	});
});

test('a tab with unsaved edits is never reloaded behind the user', () => {
	tabManager.closeAll();
	const session = makeSession();
	const tab = open('/notes/a.md', 'on disk');
	tabManager.updateTabRawContent(tab.id, 'my unsaved paragraph');

	const outcome = session.resolveExternalChange('/notes/a.md');

	assert.equal(outcome.action, 'conflict');
	assert.equal((outcome as { tabId: string }).tabId, tab.id);
	// The buffer and its dirty marker must both survive: overwriting
	// originalContent is what made the loss invisible after the fact.
	assert.equal(tab.rawContent, 'my unsaved paragraph');
	assert.equal(tab.originalContent, 'on disk');
	assert.equal(tab.isDirty, true);
});

test('the changed path decides which tab is affected, not whichever tab is active', () => {
	tabManager.closeAll();
	const session = makeSession();
	const a = open('/notes/a.md', 'a on disk');
	const b = open('/notes/b.md', 'b on disk');
	tabManager.setActive(b.id);
	tabManager.updateTabRawContent(b.id, 'b unsaved');

	const outcome = session.resolveExternalChange('/notes/a.md');

	// Reloading here would pull b.md's disk content over b's unsaved buffer
	// because a.md changed. Whatever the outcome, it must not name tab b.
	assert.notEqual((outcome as { tabId?: string }).tabId, b.id);
	assert.equal(b.rawContent, 'b unsaved');
	assert.notEqual(a.id, b.id);
});

test('a change to a file no tab holds is ignored', () => {
	tabManager.closeAll();
	const session = makeSession();
	open('/notes/a.md', 'a on disk');

	assert.deepEqual(session.resolveExternalChange('/notes/elsewhere.md'), { action: 'ignore' });
	assert.deepEqual(session.resolveExternalChange(''), { action: 'ignore' });
});

test('our own writes still suppress the reload', async () => {
	// Saving fires the watcher too. Reloading on that event would clobber any
	// keystroke that landed between the write and the notification.
	tabManager.closeAll();
	const session = makeSession();
	const tab = open('/notes/a.md', 'on disk');
	tabManager.updateTabRawContent(tab.id, 'my edit');
	handleInvoke = (cmd) => {
		if (cmd === 'save_file_content') return null;
		throw new Error(`unexpected invoke: ${cmd}`);
	};

	assert.equal(await session.saveContent(tab.id), true);

	assert.deepEqual(session.resolveExternalChange('/notes/a.md'), { action: 'ignore' });
});

test('the suppression expires, and does not outlive its own grace period', async () => {
	// The other half of the same guard, and the one with teeth: a suppression
	// that never lifts turns Live Mode off for that file for the rest of the
	// session, silently. Grace 0 makes the window already over by the time the
	// event arrives, which is what a real event a second later looks like.
	tabManager.closeAll();
	const session = makeSession({ selfWriteGraceMs: 0 });
	const tab = open('/notes/a.md', 'on disk');
	tabManager.updateTabRawContent(tab.id, 'my edit');
	handleInvoke = (cmd) => {
		if (cmd === 'save_file_content') return null;
		throw new Error(`unexpected invoke: ${cmd}`);
	};
	assert.equal(await session.saveContent(tab.id), true);

	assert.equal(session.shouldReloadExternalChange('/notes/a.md'), true, 'a later change is not suppressed');
	assert.equal(
		session.shouldReloadExternalChange('/notes/a.md'),
		true,
		'and the expired entry is dropped rather than re-consulted',
	);
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
