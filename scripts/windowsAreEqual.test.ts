import assert from 'node:assert/strict';
import test from 'node:test';

import { filesMatching, readSource, readSourceFiles } from './sourceTree.js';

// Windows are equal views of one session. "main" is only the name Tauri gives
// the window it builds at launch, and only startup tells that window apart:
// adoption, the launch's files and the quiet first show, all in Rust behind
// `LAUNCH_LABEL`. A frontend branch on the label is a second, unequal kind of
// window, and executing the one code path that exists cannot see it.

test('no frontend code tells the launch window apart', () => {
	const sources = readSourceFiles('src');
	assert.deepEqual(filesMatching(sources, /['"`]main['"`]/), []);
	assert.deepEqual(filesMatching(sources, /isMain(Window)?\b/), []);
});

test('Rust names the launch window once', () => {
	const runtime = readSource('src-tauri/src/window_runtime.rs');
	const code = runtime.slice(0, runtime.indexOf('#[cfg(test)]'));
	assert.deepEqual(code.match(/"main"/g), ['"main"']);
	assert.match(code, /pub const LAUNCH_LABEL: &str = "main";/);
});
