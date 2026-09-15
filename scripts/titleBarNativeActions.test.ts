import assert from 'node:assert/strict';
import test from 'node:test';

import { readSource, sliceBetween } from './sourceTree.js';

/*
 * #776: on Windows the title bar's minimize and maximize buttons post the
 * WM_SYSCOMMAND the taskbar sends, instead of calling Tauri's window API, which
 * goes through tao's own ShowWindow calls. The action names cross from
 * TypeScript into a serde enum, and nothing but their spelling connects the
 * two, so they are pinned here as text.
 */
const titleBar = readSource('src/lib/components/TitleBar.svelte');
const commands = readSource('src-tauri/src/commands.rs');
const controls = sliceBetween(titleBar, '<div class="window-controls-right"', '</div>');

test('the Windows and Linux buttons go through title_bar_action, not the Tauri window API', () => {
	assert.doesNotMatch(controls, /appWindow\.(minimize|toggleMaximize)\(/);
	assert.match(controls, /invoke\('title_bar_action', \{ action: 'minimize' \}\)/);
	assert.match(controls, /invoke\('title_bar_action', \{ action: 'toggle_maximize' \}\)/);
});

test('the actions the buttons send are the ones the command accepts', () => {
	assert.match(
		commands,
		/#\[serde\(rename_all = "snake_case"\)\]\s*pub enum TitleBarAction \{\s*Minimize,\s*ToggleMaximize,\s*\}/,
	);
});

test('on Windows the command posts WM_SYSCOMMAND', () => {
	const body = sliceBetween(commands, 'pub fn title_bar_action', '#[cfg(not(windows))]');
	assert.match(body, /PostMessageW\(\s*Some\(hwnd\),\s*WM_SYSCOMMAND,/);
});
