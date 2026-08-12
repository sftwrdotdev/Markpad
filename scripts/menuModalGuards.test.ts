import assert from 'node:assert/strict';
import test from 'node:test';

import { functionSource, readSource, sliceBetween } from './sourceTree.js';

const viewer = readSource(new URL('../src/lib/MarkdownViewer.svelte', import.meta.url));
const titleBar = readSource(new URL('../src/lib/components/TitleBar.svelte', import.meta.url));
const modal = readSource(new URL('../src/lib/components/Modal.svelte', import.meta.url));

// Three of the four assertions below used to spell `\n\t\t` and `\n\t\t\t` into
// the pattern, so they pinned the indentation of the code as much as its order.
// A single `prettier` run — or wrapping one condition across two lines — turned
// all three red without changing a thing the user can see. What actually has to
// hold is which function the statement lives in and what it comes BEFORE, so
// that is what is asserted now: the scope comes from `functionSource`, and the
// ordering from offsets within that scope.

/** The document-level right-click handler, braces included. */
const contextMenuHandler = functionSource(viewer, 'handleContextMenu');

/** Where `needle` sits inside `scope`, asserted to be present at all. */
function offsetIn(scope: string, needle: string, what: string): number {
	const at = scope.indexOf(needle);
	assert.notEqual(at, -1, `${what} is gone from the handler`);
	return at;
}

test('document context menus do not open while a modal is active', () => {
	// First statement, not merely present: every branch below it either opens a
	// menu or returns, so a modal guard placed after any of them is not a guard.
	assert.match(contextMenuHandler, /^function handleContextMenu\([^)]*\)\s*\{\s*if \(modalState\.show\)\s*return;/);
});

test('titlebar menus close before a document context menu opens', () => {
	assert.match(titleBar, /window\.addEventListener\('contextmenu', handleGlobalDismiss\)/);
	assert.match(titleBar, /window\.addEventListener\('blur', handleGlobalDismiss\)/);
});

test('modal backdrop consumes context-menu events outside text fields', () => {
	// Scoped to the backdrop's own `oncontextmenu`, so a `preventDefault` that
	// belongs to some other handler in this component cannot satisfy it.
	const backdrop = sliceBetween(modal, 'oncontextmenu={', 'role="presentation"');
	const carveOut = offsetIn(backdrop, "closest('input, textarea')", 'the text-field carve-out');
	const prevent = offsetIn(backdrop, 'e.preventDefault();', 'the native-menu suppression');
	const stop = offsetIn(backdrop, 'e.stopPropagation();', 'the propagation guard');

	// The carve-out returns, so anything that suppresses the native menu has to
	// come after it or the prompt input loses Cut/Copy/Paste.
	assert.ok(prevent > carveOut && stop > carveOut, 'the backdrop suppresses the menu before letting text fields out');
});

test('text fields keep the webview edit menu so paste stays reachable', () => {
	const carveOut = offsetIn(
		contextMenuHandler,
		'closest(\'input, textarea, [contenteditable="true"]\')',
		'the text-field carve-out',
	);
	const prevent = offsetIn(contextMenuHandler, 'e.preventDefault();', 'the native-menu suppression');

	assert.ok(prevent > carveOut, 'preventDefault runs before the text-field carve-out, so paste is unreachable');
});
