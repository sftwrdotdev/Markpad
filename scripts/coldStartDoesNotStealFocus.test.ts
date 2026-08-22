import assert from 'node:assert/strict';
import test from 'node:test';

import { readRustBackend, readSource } from './sourceTree.js';

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

test('the main window builder carries the Windows half of the fix', () => {
	const app = readSource('src-tauri/src/app.rs');

	// `show()` maps to `SW_SHOW` on Windows, which activates: skipping
	// `set_focus` does not by itself keep the first show quiet there.
	// `.focused(false)` sets tao's one-shot `MARKER_DONT_FOCUS` so that show
	// uses `SW_SHOWNOACTIVATE` instead.
	assert.match(app, /\.focused\(false\)/);

	// The comment on that line, and its no-op status on macOS and Linux, both
	// depend on the window still being built hidden.
	assert.match(app, /\.visible\(false\)/);

	// Detached tab windows are built hidden too, and they SHOULD activate when
	// revealed — the user just asked for them. Exactly one builder opts out.
	assert.equal(backend.match(/\.focused\(false\)/g)?.length, 1);
});
