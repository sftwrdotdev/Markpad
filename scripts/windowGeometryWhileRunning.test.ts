import assert from 'node:assert/strict';
import test from 'node:test';

import { readRustBackend, sliceBetween } from './sourceTree.js';

// The window-state plugin saves only on a clean exit, so after a crash every
// window came back at its default size. Moving or resizing a window has to
// reach the plugin's save while the app runs. Needs a live window to execute;
// the 500 ms bound is `coalesced`, tested in Rust.
const rust = readRustBackend();

test('a move or resize schedules a geometry save', () => {
	const handler = sliceBetween(rust, 'pub fn handle_window_event', 'tauri::WindowEvent::Focused(true)');
	assert.match(handler, /WindowEvent::Moved\(_\) \| tauri::WindowEvent::Resized\(_\)/);
	assert.match(handler, /try_state::<GeometrySaver>\(\)/);
	assert.match(rust, /app\.manage\(window_runtime::GeometrySaver::new\(/);
});

test('the running save and the plugin keep the same fields', () => {
	assert.match(rust, /\.with_state_flags\(window_runtime::geometry_flags\(\)\)/);
	assert.match(rust, /app\.save_window_state\(geometry_flags\(\)\)/);
});
