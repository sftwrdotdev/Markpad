import assert from 'node:assert/strict';
import test from 'node:test';

import { filesMatching, functionSource, readSource, readSourceFiles, sliceBetween } from './sourceTree.js';

// #549 put both DOM-selection copy routes — ⌘C in the preview, and Edit ▸ Copy
// in the menu bar, which is a `PredefinedMenuItem::copy` asking the webview to
// perform its own copy — on one handler that writes the clipboard itself.
//
// The reason it cancels the native copy has not changed. WebKit's own copy
// writes a WebArchive beside the text, and the only reason a shipped build has
// none is that `LegacyWebArchive` skips its subresource sweep for origins
// outside the http family — `tauri://localhost` is outside it. Measured, same
// selection, same binary:
//
//   tauri build --debug (tauri://localhost)   utf8 70
//   tauri dev           (http://localhost)    weba 19,081,919 + RTF + HTML
//
// Cancelling is checked first (`Editor::copy` → `tryDHTMLCopy`), before any of
// that is built, and whatever the origin. So the flavours on the clipboard are
// the ones this handler writes, and #674 answered the question #549 left open
// by adding exactly one more: `text/html`, built here rather than by the
// scheme. What must never come back is a route that lets the webview decide.

const viewer = readSource(new URL('../src/lib/MarkdownViewer.svelte', import.meta.url));
const handler = functionSource(viewer, 'handleCopy');

test('the document-level copy handler is attached', () => {
	// Document level rather than the preview's `<article>`: `styles.css` puts
	// `user-select: none` on the app root, so the only selectable surfaces are
	// the preview and the update dialog's release notes (#532) — and both take
	// the same native path.
	const svelteDocument = sliceBetween(viewer, '<svelte:document', '/>');
	assert.match(svelteDocument, /oncopy=\{handleCopy\}/);
});

test('the copy handler writes plain text and cancels the native copy', () => {
	assert.match(handler, /setData\(\s*'text\/plain'/);
	// Without this the native copy still runs and still builds the archive.
	assert.match(handler, /preventDefault\(\)/);
});

test('the rich flavour is the one this handler builds, and the only one', () => {
	// `text/html` is built here, from a fragment the app has already pruned,
	// rather than left to WebKit — which is what keeps the WebArchive out of
	// shipped builds while the paste keeps its formatting.
	assert.match(handler, /setData\(\s*'text\/html',\s*html\)/);
	// RTF is WebKit's own flavour and nothing here can produce a good one: it
	// would be the scheme deciding again, which is the defect #549 fixed.
	assert.doesNotMatch(handler, /text\/rtf/i);
});

test('both flavours come from one decision', () => {
	// Not two calls: the plain text depends on what the HTML pass found — a
	// selection containing math takes its text from the formula sources — and
	// splitting them is how the two come to describe different selections.
	assert.match(handler, /const \{ text, html \} = copyableFlavours\(selection, currentFile\)/);
});

test('nothing else installs a copy handler', () => {
	// `katex/contrib/copy-tex` did, firing only for selections with math and
	// rewriting both flavours from its own fragment — so it silently undid this
	// handler's work for exactly those selections (#674). Its behaviour lives in
	// utils/previewCopy.ts now; loading it again would restore the fight.
	const files = readSourceFiles('src');
	// Both matches are prose: the note at the load site saying why it is gone,
	// and the module that took its behaviour over.
	assert.deepEqual(filesMatching(files, /copy-tex/), ['src/lib/utils/previewCopy.ts', 'src/lib/utils/richContent.ts']);
	const richContent = readSource('src/lib/utils/richContent.ts');
	assert.doesNotMatch(richContent, /import\('katex\/dist\/contrib\/copy-tex/);
	assert.deepEqual(filesMatching(files, /addEventListener\(\s*'copy'/), []);
});

test('a selection inside a form control is left to the platform', () => {
	// Mirrors WebKit's own carve-out in `Editor::performCutOrCopy`: such a
	// selection already gets plain text and no archive, and `getSelection()`
	// cannot read it — cancelling here would copy an empty string. Monaco takes
	// input through a hidden textarea and is covered by the same test, which is
	// what keeps the editor on its own Rust path (#548).
	assert.match(handler, /document\.activeElement/);
	assert.match(handler, /HTMLInputElement/);
	assert.match(handler, /HTMLTextAreaElement/);
	const carveOut = handler.indexOf('HTMLTextAreaElement');
	const write = handler.indexOf('setData');
	assert.ok(carveOut !== -1 && write !== -1 && carveOut < write, 'the carve-out must return before the write');
});

test('a collapsed selection is not copied', () => {
	// Edit ▸ Copy is enabled with nothing selected; writing '' would clear the
	// clipboard instead of leaving it alone.
	assert.match(handler, /isCollapsed/);
});
