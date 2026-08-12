import assert from 'node:assert/strict';
import test from 'node:test';

import { offsetOf, readSource, sliceBetween } from './sourceTree.js';

const viewer = readSource(new URL('../src/lib/MarkdownViewer.svelte', import.meta.url));

// The guard gained `!e.shiftKey` when Save As was finally bound to Mod+Shift+S:
// the branch used to match on the modifier and the letter alone, so the chord
// the app menu advertised for Save As fell through to a plain Save. It later
// gained `!e.altKey` too, and both now come from `mod` — the handler's name for
// "the platform modifier and nothing else". The Save As branch (`modShift`)
// sits above this one, so slicing from here still captures exactly the
// plain-save body every assertion below is about.
function keydownSaveBranch(): string {
	return sliceBetween(viewer, "if (mod && key === 's') {", "if (modShift && key === 't')");
}

// Reported in #168 by @dayeggpi: with a document that was never saved,
// Ctrl+S in reading mode did nothing at all. `toggleEdit` only runs its
// save/confirm flow for tabs that already have a path, so an untitled buffer
// switches to reading mode still dirty — and then the one shortcut that could
// rescue it was suppressed.
test('Ctrl+S is not gated on the editor being visible', () => {
	const branch = keydownSaveBranch();
	assert.doesNotMatch(branch, /if \(isEditing \|\| isSplit\)/);
	assert.match(branch, /saveContent\(\)/);
});

test('an untitled buffer can be saved from reading mode', () => {
	const branch = keydownSaveBranch();
	// `path === ''` is the untitled case; documentSession.saveContent opens
	// the Save dialog for it, so no extra plumbing is needed here.
	assert.match(branch, /saveTarget\.path === ''/);
});

test('a saved, unmodified document does not write on Ctrl+S', () => {
	// Writing unconditionally would touch mtime and wake the file watcher,
	// which in live mode reloads the tab -- a keystroke that reads as a no-op
	// to the user should not move the document underneath them.
	const branch = keydownSaveBranch();
	assert.match(branch, /saveTarget\.isDirty \|\| saveTarget\.path === ''/);
});

test('the browser save dialog is always suppressed', () => {
	// preventDefault has to run for every mode, including the no-op case,
	// or reading mode would surface the webview's own Save Page dialog.
	const branch = keydownSaveBranch();
	const beforeGuard = branch.slice(0, offsetOf(branch, 'const saveTarget'));
	assert.match(beforeGuard, /e\.preventDefault\(\);/);
});

test('the HOME tab is not savable', () => {
	// HOME carries the sentinel path 'HOME' and is never dirty, so the guard
	// excludes it without naming it. This pins that reasoning: if the guard
	// ever becomes unconditional, HOME would start opening a Save dialog.
	const branch = keydownSaveBranch();
	assert.doesNotMatch(branch, /^\s*saveContent\(\);\s*$/m);
});
