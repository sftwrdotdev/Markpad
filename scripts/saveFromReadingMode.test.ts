import assert from 'node:assert/strict';
import test from 'node:test';

import { viewerCommandFor, type KeyContext } from '../src/lib/utils/viewerKeymap.js';
import { viewerCommandTable } from './keymapHarness.js';
import { functionSource, readSource } from './sourceTree.js';

/*
 * #168, reported by @dayeggpi: with a document that was never saved, Ctrl+S in
 * reading mode did nothing at all. `toggleEdit` only runs its save/confirm flow
 * for tabs that already have a path, so an untitled buffer switches to reading
 * mode still dirty — and then the one shortcut that could rescue it was
 * suppressed.
 *
 * Every assertion here used to read the component's source through
 * `sliceBetween(viewer, "if (mod && key === 's') {", "if (modShift && key ===
 * 't')")` — a slice whose start anchor was the branch condition itself and
 * whose end anchor was the NEXT branch, so it moved when either was rewritten
 * and said nothing about what Ctrl+S does. Lifting the dispatcher out split the
 * two halves apart, and each is now checked where it lives: which chord means
 * `'save'` is a function call, and what `'save'` does is the component's, read
 * from its command table.
 */

/** Reading a saved document, the state the report was made in. */
const READING: KeyContext = {
	mode: 'app',
	osType: 'windows',
	isSplit: false,
	overlayOpen: false,
	isEditing: false,
	editorHasFocus: false,
};

/** Mod+S, with no other modifier. */
const MOD_S = { key: 's', code: 'KeyS', ctrlKey: true, metaKey: false, shiftKey: false, altKey: false };

test('Ctrl+S is not gated on the editor being visible', () => {
	// The defect was a `if (isEditing || isSplit)` around the branch. Asked as a
	// question rather than matched as text: all four combinations of the two
	// flags must answer `'save'`, so no guard over either of them can come back
	// without failing here.
	for (const isEditing of [false, true]) {
		for (const isSplit of [false, true]) {
			assert.equal(
				viewerCommandFor(MOD_S, { ...READING, isEditing, isSplit }),
				'save',
				`isEditing=${isEditing} isSplit=${isSplit}`,
			);
		}
	}
});

test('the browser save dialog is always suppressed', () => {
	// preventDefault has to run for every mode, including the no-op case, or
	// reading mode would surface the webview's own Save Page dialog. It is one
	// unconditional call on the command rather than one per branch now, so this
	// reads the six-line handler rather than the branch it used to sit in — and
	// covers all twenty-two commands instead of Save alone.
	const handler = functionSource(readSource('src/lib/MarkdownViewer.svelte'), 'handleKeyDown');
	assert.match(
		handler,
		/if \(!command\) return;\s*\n\s*e\.preventDefault\(\);/,
		'a command that runs must have had the keystroke prevented first',
	);
});

/*
 * The three below are the residue of this seam, and they say so.
 *
 * What Ctrl+S DOES is a closure over `tabManager.activeTab` inside the
 * component, which is the one thing that could not move: see the note on
 * `viewerCommandTable` in `keymapHarness.ts`. They are still text assertions —
 * but text anchored on a `case 'save':` label rather than on a chord condition,
 * so the rename that reddened five of these in #647 no longer reaches them.
 */
const saveCommand = () => viewerCommandTable()['save'];

test('an untitled buffer can be saved from reading mode', () => {
	// `path === ''` is the untitled case; documentSession.saveContent opens
	// the Save dialog for it, so no extra plumbing is needed here.
	assert.match(saveCommand(), /saveTarget\.path === ''/);
});

test('a saved, unmodified document does not write on Ctrl+S', () => {
	// Writing unconditionally would touch mtime and wake the file watcher,
	// which in live mode reloads the tab -- a keystroke that reads as a no-op
	// to the user should not move the document underneath them.
	assert.match(saveCommand(), /saveTarget\.isDirty \|\| saveTarget\.path === ''/);
});

test('the HOME tab is not savable', () => {
	// HOME carries the sentinel path 'HOME' and is never dirty, so the guard
	// excludes it without naming it. This pins that reasoning: if the guard
	// ever becomes unconditional, HOME would start opening a Save dialog.
	assert.doesNotMatch(saveCommand(), /^\s*saveContent\(\);\s*$/m);
});
