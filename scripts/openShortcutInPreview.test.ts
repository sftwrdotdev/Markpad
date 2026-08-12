/**
 * #153: "While in Preview Mode - Ctrl+O doesn't work on windows."
 *
 * It works now — the branch is in the document-level dispatcher, which is
 * attached to `<svelte:document>` rather than to the editor, and it carries no
 * editing condition. What it never had is anything holding it there. The comment on
 * the fix cited a test file that does not exist, and grepping the suite for
 * `selectFile` returned nothing, so the report's own scenario was resting on
 * the absence of a guard nobody had written down.
 *
 * That is the failure mode this file exists for: a shortcut that lives in two
 * layers. `Ctrl+T` already went wrong that way (#392) — Monaco answered it
 * inside the editor and the document handler answered it outside, and the two
 * meant different things. Ctrl+O is answered by both layers as well; what
 * makes it correct rather than a second #392 is that both call the same
 * function, and that is what the second test holds.
 *
 * `documentKeymap` fires real chords at the real imported dispatcher with
 * `isEditing: false` — the reporter's preview mode — and reports what each one
 * means.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { documentKeymap, editorKeymap, PLATFORMS } from './keymapHarness.js';
import { readSource } from './sourceTree.js';

const editorSource = readSource(new URL('../src/lib/components/Editor.svelte', import.meta.url));
const viewerSource = readSource(new URL('../src/lib/MarkdownViewer.svelte', import.meta.url));

test('Ctrl/Cmd+O opens the file dialog while reading, on every platform', () => {
	for (const platform of PLATFORMS) {
		const chord = platform.mac ? 'Meta+O' : 'Ctrl+O';
		assert.equal(
			documentKeymap(platform.osType).get(chord),
			'open-file',
			`${platform.name}: ${chord} must open a file from preview mode`,
		);
	}
});

test('the editor claims it too, and both layers do the same thing', () => {
	// Monaco calls `stopPropagation()` on a keystroke it consumes, so inside
	// the editor its own `file-open` answers and the document handler never
	// runs. That is fine — and is the shape #392 got WRONG — only because the
	// two answers are the same function: `file-open` runs `onopen`, and the
	// viewer passes `selectFile` to it, which is what the document branch calls.
	for (const platform of PLATFORMS) {
		const chord = platform.mac ? 'Meta+O' : 'Ctrl+O';
		const claimed = [...editorKeymap(platform.mac, platform.os)]
			.filter(([, chords]) => chords.includes(chord))
			.map(([actionId]) => actionId);

		assert.deepEqual(claimed, ['file-open'], `${platform.name}: ${chord}`);
	}

	assert.match(editorSource, /id: "file-open",[\s\S]{0,200}?run: \(\) => onopen\?\.\(\)/);
	assert.match(viewerSource, /onopen=\{selectFile\}/);
});

test('Shift and Alt do not reach it', () => {
	// The branch tests `!e.shiftKey && !e.altKey`. Without that, chords the app
	// has not defined would silently open a file dialog on top of whatever the
	// user was actually doing.
	for (const chord of ['Ctrl+Shift+O', 'Alt+Ctrl+O']) {
		assert.equal(documentKeymap('windows').get(chord), undefined, chord);
	}
});
