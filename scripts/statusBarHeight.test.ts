import assert from 'node:assert/strict';
import test from 'node:test';

import { readSource, sliceBetween } from './sourceTree.js';

// The status bar sits directly above the editor, and Monaco cancels an
// in-progress drag-selection whenever the editor's height changes
// (`MouseHandler.onConfigurationChanged` -> `stopMonitoring`). So anything that
// lets this bar's height follow its content ends a drag the user is still
// making: in a narrow window the items wrapped their text the moment a
// selection added the "N selected" item, and the selection froze two lines in
// (#762). A rule about a height nothing computes is not a type; this is the
// only thing that fails when someone drops `nowrap` again.
const statusBar = sliceBetween(readSource('src/lib/components/Editor.svelte'), '\t.status-bar {', '\t}');

test('the status bar keeps its items on one line', () => {
	assert.match(statusBar, /white-space:\s*nowrap;/);
});

test('the status bar clips what does not fit rather than growing', () => {
	assert.match(statusBar, /overflow:\s*hidden;/);
});
