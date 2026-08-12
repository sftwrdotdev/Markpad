import assert from 'node:assert/strict';
import test from 'node:test';

import { readRustBackend, readSource } from './sourceTree.js';

const backend = readRustBackend();

test('startup reuses the window handle returned by the builder', () => {
	// Not vacuous: the build call the rule below is about still exists, so
	// "nobody re-finds the window" cannot pass by the builder having gone away.
	assert.match(backend, /window_builder\s*\.\s*build\(\)/);

	// The defect (#318): building the window, then throwing the handle away and
	// looking it back up by label — an `Option` that startup unwrapped, which is
	// a panic on the one path where the lookup misses.
	//
	// The binding's spelling is deliberately NOT pinned. This used to also
	// assert `/let window = window_builder\.build\(\)\?;/`, which is a claim
	// about what the local is CALLED: renaming it to `win`, or letting rustfmt
	// wrap the line, turned this red with the behaviour untouched. The pattern
	// below is widened for the same reason — it no longer requires the receiver
	// to be spelled `app`, so the lookup cannot come back through an alias.
	assert.doesNotMatch(backend, /get_webview_window\([^)]*\)\s*\.\s*unwrap\(\)/);
});
