import assert from 'node:assert/strict';
import test from 'node:test';

import { readRustBackend } from './sourceTree.js';

const backend = readRustBackend();

function showWindowSource(): string {
	const match = /pub async fn show_window\([\s\S]*?\n\}/.exec(backend);
	assert.ok(match, 'show_window is gone: this file no longer states anything');
	return match[0];
}

test('the main window is shown without being activated on a cold start', () => {
	const showWindow = showWindowSource();

	// The defect (#702): the window is built hidden and revealed once the
	// frontend mounts, seconds after launch, and the reveal called `set_focus`
	// unconditionally — pulling the user out of whatever they had switched to.
	// The label and the one-shot flag together are what make it the FIRST show
	// of the MAIN window that stays quiet.
	assert.match(showWindow, /window\.label\(\)\s*==\s*"main"/);
	assert.match(showWindow, /MAIN_WINDOW_SHOWN\.swap\(true,/);

	// Not vacuous: the other callers — a detached tab window, the close walk
	// needing its dialog visible — still activate, so this cannot pass by
	// `set_focus` having been deleted outright.
	assert.match(showWindow, /set_focus\(\)/);

	// And the quiet path returns before reaching it.
	const guard = showWindow.indexOf('return;');
	const focus = showWindow.indexOf('set_focus()');
	assert.ok(guard > 0 && guard < focus, 'the cold-start path falls through to set_focus');
});

test('no window builder opts out of focus', () => {
	// `.focused(false)` on a window built hidden leaves WebView2 on Windows with
	// no drop target, so every file dragged onto the window is refused (#768,
	// tauri-apps/wry#1639). Comments are stripped first: the builder explains
	// why the call is absent by naming it.
	const code = backend.replace(/\/\/.*$/gm, '');
	const found = code.match(/\.focused\(false\)/g)?.length ?? 0;
	assert.equal(found, 0, `found ${found} .focused(false) in the Rust backend`);
});
