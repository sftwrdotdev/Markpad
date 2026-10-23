import assert from 'node:assert/strict';

import { test } from 'vitest';

// Rename from the tab menu is the same repoint as Save As and has to keep the
// same two guarantees: the tab learns the new path's canonical key, and the
// move is ordered against the tab's own writes. Only the Tauri backend is
// stubbed; the store and the session run under the real compiler.

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

const { tabManager } = await import('../src/lib/stores/tabs.svelte.js');
const { createDocumentSession } = await import('../src/lib/sessions/documentSession.svelte.js');

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
