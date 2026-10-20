import assert from 'node:assert/strict';
import test from 'node:test';

import { readSource } from './sourceTree.js';

// `![](.res/pic.jpg)` rendered blank on Linux and macOS (#981). Tauri's fs
// scope defaults `requireLiteralLeadingDot` to true on Unix, so `**` does not
// match a path segment that starts with a dot and the `asset:` handler answers
// 403. Windows defaults to false, which is why it only showed up off Windows.
test('asset scope lets `**` match dot-directories on every platform', () => {
	const conf = JSON.parse(readSource('src-tauri/tauri.conf.json'));
	assert.deepEqual(conf.app.security.assetProtocol.scope, {
		allow: ['**'],
		requireLiteralLeadingDot: false,
	});
});
