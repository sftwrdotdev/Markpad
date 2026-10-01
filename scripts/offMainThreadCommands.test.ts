import assert from 'node:assert/strict';
import test from 'node:test';

import { readRustBackend } from './sourceTree.js';

// Tauri runs a sync `#[tauri::command]` on the main thread, so its work freezes
// every window until it returns. These do enough of it to be seen.
const rust = readRustBackend();

for (const name of ['clipboard_read_image', 'save_window_state']) {
	test(`${name} runs off the main thread`, () => {
		assert.match(rust, new RegExp(`#\\[tauri::command\\]\\n(?:pub )?async fn ${name}\\(`));
	});
}
