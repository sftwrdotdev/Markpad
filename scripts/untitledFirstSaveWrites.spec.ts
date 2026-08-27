import assert from 'node:assert/strict';

import { test } from 'vitest';

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

const disk = new Map<string, string>();
const writes: string[] = [];
/** What the Save dialog returns next. `null` is the user pressing Cancel. */
let nextSaveTarget: string | null = null;
/** Tabs the session raised the conflict bar for. */
const conflicts: string[] = [];

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

const { tabManager } = await import('../src/lib/stores/tabs.svelte.js');
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
