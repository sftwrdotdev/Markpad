import assert from 'node:assert/strict';
import test from 'node:test';

import ts from 'typescript';

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

test('a second dialog settles the first instead of orphaning it', async () => {
	// One `modalState`, one `resolve`. A second `askCustom` used to overwrite the
	// first caller's resolver, so that caller awaited forever — when it was the
	// close walk, the window could not be closed again. The component's own
	// functions run here over a stand-in `modalState`; types erased, nothing else.
	const lifted = ['askCustom', 'handleModalConfirm'].map((name) => functionSource(viewer, name)).join('\n');
	const js = ts.transpileModule(
		`const __component = () => {
			let modalState = { show: false, resolve: null };
			${lifted}
			return { askCustom, handleModalConfirm };
		};`,
		{ compilerOptions: { target: ts.ScriptTarget.ES2022 } },
	).outputText;
	const component = new Function(`${js}\nreturn __component();`)() as {
		askCustom: (message: string, options: { title: string; kind: 'warning' }) => Promise<string>;
		handleModalConfirm: () => void;
	};

	const first = component.askCustom('first', { title: 'Unsaved', kind: 'warning' });
	const second = component.askCustom('second', { title: 'Unsaved', kind: 'warning' });
	component.handleModalConfirm();

	assert.equal(await Promise.race([first, Promise.resolve('never settled')]), 'cancel');
	assert.equal(await second, 'discard');
});
