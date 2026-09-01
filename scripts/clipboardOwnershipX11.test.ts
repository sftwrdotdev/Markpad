import assert from 'node:assert/strict';
import test from 'node:test';

import { readSource, sliceBetween } from './sourceTree.js';

// #729: on Debian XFCE, everything copied out of Markpad reached an empty
// clipboard, while pasting into it worked. X11 has no clipboard store — the
// copying process owns the CLIPBOARD selection and serves the bytes on
// request — and arboard tears that ownership down when the last `Clipboard`
// handle drops, which was the moment `clipboard_write_text` returned.
//
// A source-shape assertion because the proposition cannot be run: the failure
// needs an X server and a desktop without a clipboard manager, and CI has
// neither. It names the helper on purpose; nothing but the call connects the
// two, and the function exists for no other reason.
test('the copy command keeps X11 clipboard ownership past its own return', () => {
	const body = sliceBetween(
		readSource('src-tauri/src/commands.rs'),
		'pub fn clipboard_write_text',
		'\n}',
	);
	assert.match(body, /retain_clipboard_ownership\(\)/);
});

test('the retained handle is never dropped', () => {
	// `retain_clipboard_ownership` holding a `Clipboard` in a local would be a
	// no-op: the point is that the handle outlives the call, so the invisible
	// window arboard serves selection requests from is never destroyed.
	const helper = sliceBetween(
		readSource('src-tauri/src/commands.rs'),
		'fn retain_clipboard_ownership',
		'\n}',
	);
	assert.match(helper, /std::mem::forget\(/);
});
