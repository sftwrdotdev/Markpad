import assert from 'node:assert/strict';
import test from 'node:test';

import { functionSource, readSource } from './sourceTree.js';

// #559: Cmd/Ctrl+F in the preview only ever set `findOpen = true`. Once the bar
// was open, clicking into the document moved focus out of the input and the
// shortcut became inert — the assignment writes the value the state already
// has, so the `$effect` that focuses on open never re-runs. The fix is an
// explicit focus call on the component, so the second press behaves like the
// first in every browser find bar: caret back in the field, previous query
// selected so typing replaces it.

const viewer = readSource('src/lib/MarkdownViewer.svelte');
const findBar = readSource('src/lib/components/FindBar.svelte');

test('the preview find shortcut focuses the bar rather than only opening it', () => {
	const trigger = functionSource(viewer, 'triggerFindAction');
	assert.match(trigger, /findBar\?\.focusInput\(\)/);
});

test('focusInput selects the previous query instead of clearing it', () => {
	const focusInput = functionSource(findBar, 'focusInput');
	assert.match(focusInput, /inputEl\?\.focus\(\)/);
	assert.match(focusInput, /inputEl\?\.select\(\)/);
	// Clearing here would defeat the point: the issue asks for the previous
	// search to come back lit, not for an empty field.
	assert.doesNotMatch(focusInput, /query\s*=/);
});

test('opening the bar and re-focusing it share one implementation', () => {
	// Two copies would drift; the one that stopped selecting would be the one
	// nobody re-reads.
	assert.equal(findBar.match(/inputEl\?\.focus\(\)/g)?.length, 1);
});
