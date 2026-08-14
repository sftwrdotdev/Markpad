import assert from 'node:assert/strict';
import test from 'node:test';

import { functionSource, readSource } from './sourceTree.js';

/*
 * Issue #97: in split view the two context menus are different lists.
 *
 * Some of that is the panes being different — Cut and Paste need somewhere to
 * type, the two Monaco entries need Monaco, and the viewer's own entries each
 * need a rendered element to have been clicked. What is not is the three
 * actions that have nothing to do with where the click landed: Select All acts
 * on the text either pane is showing, and the two file actions act on the
 * document that both of them are. Those were in the viewer's menu only.
 *
 * The maintainer's note on the issue — that the editor menu is Monaco's
 * built-in and therefore different — was true when it was written and is not
 * now: #207 replaced it with one this app draws, because Monaco's Paste reads
 * the clipboard through the webview and cannot work here. Parity is reachable
 * because both menus are ours.
 *
 * Both menus are built inside a 4,700-line component, so this asserts against
 * the source. What it establishes is that each shared label appears in both
 * builders — not what happens when it is clicked.
 */

const viewer = readSource('src/lib/MarkdownViewer.svelte');
const editorMenu = functionSource(viewer, 'showEditorContextMenu');
const documentMenu = functionSource(viewer, 'handleContextMenu');

test('the actions that are about the document are in both menus', () => {
	for (const key of ['menu.selectAll', 'menu.openLocation', 'menu.closeFile']) {
		assert.match(editorMenu, new RegExp(key.replace('.', '\\.')), `${key} is missing from the editor menu`);
		assert.match(documentMenu, new RegExp(key.replace('.', '\\.')), `${key} is missing from the viewer menu`);
	}
});

test('the actions that are about the pane stay in one menu', () => {
	// Asserted so that "make them consistent" does not turn into "make them
	// identical" later: an editor entry in the viewer would be dead, and the
	// viewer's entries need a rendered element that the editor does not have.
	for (const key of ['menu.cut', 'menu.paste', 'menu.commandPalette', 'menu.changeAllOccurrences']) {
		assert.doesNotMatch(documentMenu, new RegExp(key.replace('.', '\\.')), `${key} reached the viewer menu`);
	}
	for (const key of ['menu.openInNewTab', 'menu.copyReference', 'menu.saveImageAs', 'menu.edit']) {
		assert.doesNotMatch(editorMenu, new RegExp(key.replace('.', '\\.')), `${key} reached the editor menu`);
	}
});

test('Select All does not go through the id resolver that would drop it', () => {
	// `runEditorAction` resolves with `editor.getAction(id)?.run()`, and
	// `editor.action.selectAll` is registered by `registerCommand` as a
	// MultiCommand — it is not in the map `getAction` reads
	// (`codeEditorWidget.js`: `getAction(id) { return this._actions.get(id) }`,
	// filled only from the editor-action registry). The optional call would have
	// made the menu entry appear and silently do nothing.
	assert.doesNotMatch(
		editorMenu,
		/runEditorAction\(['"]editor\.action\.selectAll['"]\)/,
		'Select All was sent through getAction, which cannot resolve a command',
	);
	assert.match(editorMenu, /editorPane\?\.selectAll\(\)/);

	const editor = readSource('src/lib/components/Editor.svelte');
	assert.match(
		functionSource(editor, 'selectAll'),
		/setSelection\(model\.getFullModelRange\(\)\)/,
		'selectAll selects the whole model',
	);
});
