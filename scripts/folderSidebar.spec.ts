import assert from 'node:assert/strict';

import { test } from 'vitest';

/*
 * The folder sidebar's store against a fake disk. Runs under vitest because
 * `folder.svelte.ts` is a runes module. The Tauri bridge is stubbed: `invoke`
 * answers from `disk` and records every watch, and `listen` hands back the
 * callback so a test can fire `folder-changed` itself.
 */
type Entry = { name: string; path: string; isDir: boolean };
let disk: Record<string, Entry[]> = {};
const watched = new Set<string>();
let folderChanged: ((event: { payload: string }) => void) | null = null;

function dir(path: string, ...children: string[]): void {
	disk[path] = children.map((child) => ({
		name: child.replace(/\/$/, ''),
		path: `${path}/${child.replace(/\/$/, '')}`,
		isDir: child.endsWith('/'),
	}));
}

function handleInvoke(command: string, args: Record<string, any>): unknown {
	switch (command) {
		case 'read_folder_entries':
			if (!(args.path in disk)) throw new Error('Not a directory');
			return disk[args.path];
		case 'watch_folder':
			watched.add(args.path);
			return null;
		case 'unwatch_folder':
			watched.delete(args.path);
			return null;
		case 'unwatch_all_folders':
			watched.clear();
			return null;
		case 'listen':
			folderChanged = args.handler;
			return 1;
		default:
			return null;
	}
}

(window as any).__TAURI_INTERNALS__ = {
	metadata: { currentWindow: { label: 'main' }, currentWebview: { windowLabel: 'main', label: 'main' } },
	invoke: async (command: string, args: Record<string, unknown>) => handleInvoke(command.replace(/^plugin:[^|]*\|/, ''), args ?? {}),
	transformCallback: (fn: unknown) => fn,
};

const { FolderManager, LAST_FOLDER_KEY, folderName, isInside } = await import('../src/lib/stores/folder.svelte.js');

function freshDisk() {
	disk = {};
	watched.clear();
	localStorage.clear();
	dir('/notes', 'drafts/', 'a.md', 'b.txt');
	dir('/notes/drafts', 'old/', 'c.md');
	dir('/notes/drafts/old', 'd.md');
}

test('opening a folder reads and watches only its top level', async () => {
	freshDisk();
	const folder = new FolderManager();
	await folder.open('/notes');
	assert.deepEqual(Object.keys(folder.entries), ['/notes']);
	assert.deepEqual([...watched], ['/notes']);
	assert.equal(folder.rootName, 'notes');
	assert.equal(localStorage.getItem(LAST_FOLDER_KEY), '/notes');
});

test('collapsing a folder stops watching it and everything expanded under it', async () => {
	freshDisk();
	const folder = new FolderManager();
	await folder.open('/notes');
	await folder.toggle('/notes/drafts');
	await folder.toggle('/notes/drafts/old');
	assert.deepEqual([...watched].sort(), ['/notes', '/notes/drafts', '/notes/drafts/old']);

	await folder.toggle('/notes/drafts');
	assert.deepEqual([...watched], ['/notes']);
	assert.deepEqual(folder.expanded, []);
	assert.deepEqual(Object.keys(folder.entries), ['/notes']);
});

test('a folder-changed event re-reads that one listing', async () => {
	freshDisk();
	const folder = new FolderManager();
	await folder.open('/notes');
	dir('/notes', 'drafts/', 'a.md', 'b.txt', 'new.md');
	folderChanged?.({ payload: '/notes' });
	await new Promise((resolve) => setTimeout(resolve, 0));
	assert.deepEqual(
		folder.entries['/notes'].map((e) => e.name),
		['drafts', 'a.md', 'b.txt', 'new.md'],
	);
});

test('a subfolder that vanished collapses with everything under it', async () => {
	freshDisk();
	const folder = new FolderManager();
	await folder.open('/notes');
	await folder.toggle('/notes/drafts');
	await folder.toggle('/notes/drafts/old');
	delete disk['/notes/drafts'];
	delete disk['/notes/drafts/old'];

	await folder.refresh();
	assert.deepEqual(folder.expanded, []);
	assert.deepEqual(Object.keys(folder.entries), ['/notes']);
	assert.deepEqual([...watched], ['/notes']);
});

test('closing forgets the folder, its watches and the saved root', async () => {
	freshDisk();
	const folder = new FolderManager();
	await folder.open('/notes');
	await folder.close();
	assert.equal(folder.root, null);
	assert.equal(watched.size, 0);
	assert.equal(localStorage.getItem(LAST_FOLDER_KEY), null);
});

test('a saved folder that no longer exists is dropped on restore, not shown as an error', async () => {
	freshDisk();
	localStorage.setItem(LAST_FOLDER_KEY, '/gone');
	const folder = new FolderManager();
	await folder.restore();
	assert.equal(folder.root, null);
	assert.equal(folder.error, null);
	assert.equal(localStorage.getItem(LAST_FOLDER_KEY), null);
});

test('path helpers work on both separators', () => {
	assert.equal(folderName('/home/me/notes/'), 'notes');
	assert.equal(folderName('C:\\Users\\me\\notes'), 'notes');
	assert.ok(isInside('/a/b/c', '/a/b'));
	assert.ok(isInside('C:\\a\\b\\c', 'C:\\a\\b'));
	assert.ok(!isInside('/a/bc', '/a/b'), 'a sibling with a longer name is not inside');
	assert.ok(!isInside('/a/b', '/a/b'));
});
