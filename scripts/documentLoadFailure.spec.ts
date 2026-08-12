import assert from 'node:assert/strict';

import { test } from 'vitest';

// A read can fail on a file that is perfectly fine a moment later: a watcher
// fires while another process is replacing the file, a network volume blinks,
// a sync client swaps the inode. Closing the tab on that error throws away the
// buffer the user could still have saved somewhere else, and dropping the
// recent-file entry throws away the way back to it.
//
// This was asserted by matching documentSession for `/tabManager\.closeTab/`
// and for the exact `options.onError('Error loading file', error);` call. The
// first is satisfied by any file that happens not to contain those characters
// — including one that closes the tab through a differently spelled route —
// and the second pins a string literal. `createDocumentSession` takes its
// collaborators as plain callbacks, and eleven other files in this suite
// already build one, so the failure can be run instead of described.

// The runes are the compiler's, not ours: vitest builds `.svelte.ts` through the
// Svelte plugin, so the store and the session run under real reactivity. Only
// the Tauri backend, which jsdom cannot provide, is stubbed.
let handleInvoke: (cmd: string, args: any) => unknown = (cmd) => {
	throw new Error(`unexpected invoke: ${cmd}`);
};
(window as any).__TAURI_INTERNALS__ = {
	metadata: { currentWindow: { label: 'main' }, currentWebview: { windowLabel: 'main', label: 'main' } },
	invoke: (cmd: string, args: any) => Promise.resolve(handleInvoke(cmd, args)),
};

const { tabManager } = await import('../src/lib/stores/tabs.svelte.js');
const { createDocumentSession } = await import('../src/lib/sessions/documentSession.svelte.js');

const errors: { message: string; error: unknown }[] = [];
const deletedRecents: string[] = [];

function makeSession(overrides: Record<string, unknown> = {}) {
	return createDocumentSession({
		setShowHome: () => {},
		currentFile: () => tabManager.activeTab?.path ?? '',
		resetScrollHistory: () => {},
		renderMarkdown: async () => '',
		afterLoad: async () => {},
		saveRecentFile: () => {},
		deleteRecentFile: (path: string) => void deletedRecents.push(path),
		setLoadingTabs: () => {},
		measureInitialViewport: () => {},
		isScrolling: () => false,
		renderRichContent: () => {},
		onError: (message: string, error: unknown) => void errors.push({ message, error }),
		selfWriteGraceMs: 400,
		cancelPendingAutoSave: () => {},
		askClose: async () => 'discard' as const,
		onCloseSaveNewerEdits: () => {},
		onCloseAutoSaveFailed: () => {},
		onPartialCopySaved: () => {},
		...overrides,
	});
}

/** Every read of `path` fails; anything else the load path asks for is absent too. */
function readsFail() {
	handleInvoke = () => {
		throw new Error('No such file or directory (os error 2)');
	};
}

test('a read that fails keeps the open tab, its buffer and its recent entry', async () => {
	tabManager.closeAll();
	errors.length = 0;
	deletedRecents.length = 0;

	const session = makeSession();
	tabManager.addTab('/notes/a.md', 'the text the reader can still rescue');
	const before = tabManager.activeTab!;
	readsFail();

	await session.loadMarkdown('/notes/a.md');

	assert.equal(tabManager.tabs.length, 1, 'the tab is not closed');
	assert.equal(tabManager.tabs[0].id, before.id, 'and it is the same tab, not a replacement');
	assert.equal(
		tabManager.tabs[0].rawContent,
		'the text the reader can still rescue',
		'the buffer is not replaced by the failed read',
	);
	assert.deepEqual(deletedRecents, [], 'the recent-file entry survives, so the file can be reopened');
});

test('the failure is reported rather than swallowed', async () => {
	tabManager.closeAll();
	errors.length = 0;

	const session = makeSession();
	tabManager.addTab('/notes/a.md', 'buffer');
	readsFail();

	await session.loadMarkdown('/notes/a.md');

	assert.equal(errors.length, 1, 'exactly one error reaches the caller');
	assert.equal(errors[0].message, 'Error loading file');
	assert.ok(errors[0].error instanceof Error, 'the cause is passed on, not flattened to a string');
});
