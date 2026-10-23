import assert from 'node:assert/strict';
import { test } from 'node:test';

import { openPinnedTagWindow, pinnedTagFromWindowLabel, pinnedWindowToken } from '../src/lib/utils/pinnedTagWindow.js';
import { readSource } from './sourceTree.js';

test('a pinned group name survives the trip through a window label', () => {
	for (const name of ['work', '文献管理', 'a b/c:d-1', '🎬 movie']) {
		const label = `window-${pinnedWindowToken(name, 42)}`;
		assert.match(label, /^[A-Za-z0-9\-/:_]+$/, `Tauri label charset for ${name}`);
		assert.equal(pinnedTagFromWindowLabel(label), name);
	}
});

test('other windows are not read as pinned groups', () => {
	for (const label of ['main', 'window-3f2a9c', 'window-pinned--1', 'window-pinned-abc-1', 'window-pinned-6869']) {
		assert.equal(pinnedTagFromWindowLabel(label), null, label);
	}
});

test('a window opened for a pinned group is created as the group\'s holder', async () => {
	// The window reports its tag only once it has mounted and read the group.
	// Until then the registry knew nothing of it, so a second click on the same
	// group opened a second window. `tagName` has the backend record the holder
	// as it creates the window.
	const calls: { cmd: string; args: any }[] = [];
	(globalThis as any).window = {
		__TAURI_INTERNALS__: {
			invoke: async (cmd: string, args: any) => {
				calls.push({ cmd, args });
				return cmd === 'list_viewer_windows' ? [] : null;
			},
		},
	};
	try {
		await openPinnedTagWindow('Work');
	} finally {
		delete (globalThis as any).window;
	}
	const create = calls.find((call) => call.cmd === 'create_transfer_window');
	assert.equal(create?.args.tagName, 'Work');
	assert.equal(pinnedTagFromWindowLabel(`window-${create?.args.token}`), 'Work');

	// The other route that opens a pinned group in a new window says the same.
	const viewer = readSource('src/lib/MarkdownViewer.svelte');
	const pinnedCreates = viewer.match(/invoke\('create_transfer_window', \{[^}]*pinnedWindowToken[^}]*\}\)/g) ?? [];
	assert.ok(pinnedCreates.length > 0, 'MarkdownViewer no longer opens a pinned group in a new window');
	for (const call of pinnedCreates) {
		assert.match(call, /tagName:/, call);
	}
	// And the window does not report itself, clearing that name, before it has
	// adopted the group.
	assert.match(viewer, /\$effect\(\(\) => \{\n\t\tif \(!windowMetaReady\) return;\n\t\tinvoke\('set_window_meta'/);
});
