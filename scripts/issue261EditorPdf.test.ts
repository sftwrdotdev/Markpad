import assert from 'node:assert/strict';
import test from 'node:test';

import { functionSource, offsetOf, readRustBackend, readSource, sliceBetween, sliceFrom } from './sourceTree.js';

const viewer = readSource('src/lib/MarkdownViewer.svelte');

test('a right-click in the editor gets the editor menu, before any other rule claims it', () => {
	// #261/#266 was the document menu swallowing this event: it called
	// `preventDefault()` before checking where the click was, and its
	// full-viewport overlay then covered Monaco's menu, so Paste hit the
	// overlay. The fix then was to hand the event to Monaco.
	//
	// Markpad draws this menu itself now (#207), because Monaco's Paste reads
	// the clipboard through the webview and cannot work here. So the invariant
	// is no longer "Monaco gets the event first" — it is that the editor's own
	// branch runs before every other rule in the handler.
	//
	// The ordering matters for a reason that is easy to miss: Monaco takes
	// input through a hidden `<textarea>`, so the carve-out that leaves real
	// text fields their native menu would claim every right-click in the
	// editor if it came first.
	const handler = sliceBetween(viewer, 'function handleContextMenu(e: MouseEvent)', '\n\tfunction handleMouseOver');
	const editorBranch = offsetOf(handler, "closest('.editor-container')");
	const textFieldCarveOut = offsetOf(handler, "closest('input, textarea,");
	const documentMenu = offsetOf(handler, 'e.preventDefault();');

	assert.ok(editorBranch < textFieldCarveOut, "the hidden textarea must not claim the editor's right-click");
	assert.ok(editorBranch < documentMenu, 'the editor branch runs before the document menu');
	assert.match(handler, /showEditorContextMenu\(e\);\s*\n\s*return;/, 'and it shows a menu rather than bailing out');
});

test('the editor menu runs the same three functions the keyboard runs', () => {
	// One implementation per operation is the whole point: six entry points
	// (three keys, three menu items) and three functions. A menu item wired to
	// its own inline implementation would drift from the shortcut silently.
	const menu = functionSource(viewer, 'showEditorContextMenu');

	for (const fn of ['cutToClipboard', 'copyToClipboard', 'pasteFromClipboard']) {
		assert.match(menu, new RegExp(`editorPane\\?\\.${fn}\\(\\)`), `${fn} is what the menu item runs`);
	}
});

test('the two Monaco entries this app can use survive drawing our own menu', () => {
	// Drawing the menu ourselves means every item Monaco used to contribute is
	// gone unless it is put back, and two of them work without a language
	// provider — so they were there, and vanished, and were noticed only
	// because someone went looking for them.
	//
	// The rest (Go to Symbol, Quick Fix, Refactor, Format, Rename) are gated on
	// providers Markdown has none of and never appeared in this app.
	const menu = functionSource(viewer, 'showEditorContextMenu');

	assert.match(menu, /editor\.action\.quickCommand/, 'Command Palette');
	assert.match(menu, /editor\.action\.changeAll/, 'Change All Occurrences');

	// Through the app's own translations, which is a gain rather than parity:
	// Monaco's menu is English whatever language the app is in.
	assert.match(menu, /t\('menu\.commandPalette', settings\.language\)/);
	assert.match(menu, /t\('menu\.changeAllOccurrences', settings\.language\)/);
});

test('every label the editor menu asks for exists in every language', () => {
	// A missing key does not throw — `t()` falls back to English and then to
	// the key itself, so a forgotten locale ships the string
	// "menu.changeAllOccurrences" to the user.
	const i18n = readSource('src/lib/utils/i18n.ts');
	const locales = (i18n.match(/\n\s+menu: \{/g) ?? []).length;
	assert.ok(locales >= 6, `expected at least six locales, found ${locales}`);

	const menu = functionSource(viewer, 'showEditorContextMenu');
	for (const key of [...menu.matchAll(/t\('menu\.(\w+)', settings\.language\)/g)].map((m) => m[1])) {
		assert.equal(
			(i18n.match(new RegExp(`\\b${key}:`, 'g')) ?? []).length >= locales,
			true,
			`menu.${key} is missing from at least one language`,
		);
	}
});
