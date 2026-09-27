import assert from 'node:assert/strict';
import test from 'node:test';

import { runEditorHandler } from './keymapHarness.js';
import { enclosingFunctionName, readSource } from './sourceTree.js';

/*
 * Every edit the app makes on the user's behalf is its own undo step.
 *
 * `editor.executeEdits` does not close the undo element that typing left open:
 * it goes straight to `model.pushEditOperations`, which appends to it. Typing
 * `hello`, pasting `world` and pressing Cmd+Z therefore took both away. That was
 * checked against the installed Monaco (0.55.1) in jsdom before this was
 * written: without a stop the second undo emptied the buffer, with one it left
 * `hello`. Monaco's own paste and cut push the stop themselves; these are the
 * app's replacements for them, and for the format tools, so they have to as
 * well. The stop goes BEFORE the edit: what is typed after it opens a new
 * element on its own, which the same probe showed.
 */

const EDITOR = 'src/lib/components/Editor.svelte';

test('the format tools each push an undo stop before they edit', () => {
	for (const name of ['insertTextAtCursor', 'wrapAsCodeBlock', 'insertLink']) {
		const run = runEditorHandler([name], { lines: ['hello'], selections: [[1, 1, 1, 6]] });
		assert.equal(run.edits.length, 1, name);
		assert.equal(run.undoStops, 1, `${name} edits inside the undo step typing left open`);
	}
});

test('no executeEdits in the editor runs without an undo stop ahead of it in its function', () => {
	// Paste, cut and the drop handler read the clipboard or the disk through
	// Tauri first, so they cannot be run here; what is pinned for them, and for
	// every site added later, is that the stop comes before the edit.
	const source = readSource(EDITOR);
	const missing: string[] = [];
	let at = -1;
	while ((at = source.indexOf('editor.executeEdits(', at + 1)) !== -1) {
		const name = enclosingFunctionName(source, at);
		assert.ok(name, `an executeEdits outside any named function at offset ${at}`);
		const start = source.lastIndexOf(name, at);
		if (!source.slice(start, at).includes('editor.pushUndoStop()')) {
			missing.push(`${name} (line ${source.slice(0, at).split('\n').length})`);
		}
	}
	assert.deepEqual(missing, []);
});
