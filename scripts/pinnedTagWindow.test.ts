import assert from 'node:assert/strict';
import { test } from 'node:test';

import { pinnedTagFromWindowLabel, pinnedWindowToken } from '../src/lib/utils/pinnedTagWindow.js';

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
