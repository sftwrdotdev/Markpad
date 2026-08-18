import assert from 'node:assert/strict';

import { test } from 'vitest';

import { copyableFlavours, copyableHtml } from '../src/lib/utils/previewCopy.js';

// #674: what a preview selection looks like once it leaves the app. The
// clipboard carries no stylesheet, so anything the preview only renders
// correctly *because* of one has to be resolved here or it arrives wrong.

const DOC = '/Users/me/notes/report.md';

/** The fragment a `Range.cloneContents()` would hand over, spelled as HTML. */
function fragmentOf(html: string): DocumentFragment {
	const template = document.createElement('template');
	template.innerHTML = html;
	return template.content;
}

test('structure survives untouched', () => {
	const html = copyableHtml(
		fragmentOf('<h2>Heading</h2><p><strong>bold</strong> and <em>italic</em> and <a href="https://example.com">a link</a></p><ul><li>one</li></ul>'),
		DOC,
	);
	assert.match(html, /<h2>Heading<\/h2>/);
	assert.match(html, /<strong>bold<\/strong>/);
	assert.match(html, /<em>italic<\/em>/);
	assert.match(html, /<a href="https:\/\/example\.com">a link<\/a>/);
	assert.match(html, /<li>one<\/li>/);
});

test('a formula is carried once, not twice', () => {
	// KaTeX renders both halves and hides the MathML in CSS. Pasted into a
	// document with no KaTeX stylesheet, both are visible — the formula reads
	// twice, once as MathML text and once as the glyphs.
	const katex =
		'<span class="katex">' +
		'<span class="katex-mathml"><math><semantics><mrow><mi>E</mi></mrow><annotation encoding="application/x-tex">E=mc^2</annotation></semantics></math></span>' +
		'<span class="katex-html" aria-hidden="true"><span class="base">E=mc2</span></span>' +
		'</span>';
	const html = copyableHtml(fragmentOf(katex), DOC);
	assert.doesNotMatch(html, /katex-mathml/);
	assert.doesNotMatch(html, /annotation/);
	// The half that stays is the one the user was looking at, and the one
	// `selection.toString()` already puts in the plain-text flavour.
	assert.match(html, /katex-html/);
	assert.match(html, /E=mc2/);
});

test('the fold chevrons do not travel', () => {
	const html = copyableHtml(
		fragmentOf('<h2>Section<span class="header-fold-icon">▾</span></h2><div class="markdown-alert"><span class="callout-fold-icon">▾</span>Note</div>'),
		DOC,
	);
	assert.doesNotMatch(html, /fold-icon/);
	assert.match(html, /Section/);
	assert.match(html, /Note/);
});

test('a local image becomes a URL the receiving app can open', () => {
	// `asset://` (and `http://asset.localhost` on Windows) is this app's own
	// scheme; anything else pasting it shows a broken image.
	const posix = copyableHtml(fragmentOf('<img src="asset://localhost/Users/me/notes/img/shot.png">'), DOC);
	assert.match(posix, /src="file:\/\/\/Users\/me\/notes\/img\/shot\.png"/);

	const windows = copyableHtml(fragmentOf('<img src="http://asset.localhost/C:/notes/img/shot.png">'), DOC);
	assert.match(windows, /src="file:\/\/\/C:\/notes\/img\/shot\.png"/);
});

test('a document-relative image is resolved against the document', () => {
	const html = copyableHtml(fragmentOf('<img src="img/diagram.png">'), DOC);
	assert.match(html, /src="file:\/\/\/Users\/me\/notes\/img\/diagram\.png"/);
});

test('a path with a space or a hash survives as a URL', () => {
	// Both end a URL where they sit, so `notes #2.png` would otherwise resolve
	// to `notes ` and the image would be missing rather than broken.
	const html = copyableHtml(fragmentOf('<img src="asset://localhost/Users/me/my%20notes/shot%20%232.png">'), DOC);
	assert.match(html, /src="file:\/\/\/Users\/me\/my%20notes\/shot%20%232\.png"/);
});

test('a remote image and a data URI are left alone', () => {
	const remote = copyableHtml(fragmentOf('<img src="https://example.com/a.png">'), DOC);
	assert.match(remote, /src="https:\/\/example\.com\/a\.png"/);

	const inline = copyableHtml(fragmentOf('<img src="data:image/png;base64,AAAA">'), DOC);
	assert.match(inline, /src="data:image\/png;base64,AAAA"/);
});

// ---------------------------------------------------------------- both flavours

/** A selection over `html`, as the preview would hand one to the handler. */
function selectionOver(html: string): Selection {
	document.body.innerHTML = `<div id="preview">${html}</div>`;
	const range = document.createRange();
	range.selectNodeContents(document.getElementById('preview') as HTMLElement);
	const selection = window.getSelection() as Selection;
	selection.removeAllRanges();
	selection.addRange(range);
	return selection;
}

const KATEX_INLINE =
	'<span class="katex">' +
	'<span class="katex-mathml"><math><semantics><mrow><mi>E</mi></mrow><annotation encoding="application/x-tex">E=mc^2</annotation></semantics></math></span>' +
	'<span class="katex-html" aria-hidden="true"><span class="base">E=mc2</span></span>' +
	'</span>';

test('a formula copies as its source, not as the glyphs', () => {
	// What `katex/contrib/copy-tex` did before this module took the copy over.
	// The rendered spans read `E=mc2`, which is not the formula and cannot be
	// pasted back into a Markdown document.
	const { text } = copyableFlavours(selectionOver(`<p>Einstein: ${KATEX_INLINE}</p>`), '');
	assert.match(text, /\$E=mc\^2\$/);
	assert.doesNotMatch(text, /E=mc2/);
});

test('a display formula keeps its display delimiters', () => {
	const { text } = copyableFlavours(selectionOver(`<p class="katex-display">${KATEX_INLINE}</p>`), '');
	assert.match(text, /\$\$E=mc\^2\$\$/);
});

test('a selection with no math takes its plain text from the selection itself', () => {
	// `Selection.toString()` is the only source that knows what is rendered —
	// `textContent` of the fragment would pick up hidden nodes and lose the line
	// breaks between blocks.
	const { text } = copyableFlavours(selectionOver('<p>one</p><p>two</p>'), '');
	assert.match(text, /one/);
	assert.match(text, /two/);
});

test('both flavours come back from one call', () => {
	const { text, html } = copyableFlavours(selectionOver('<p><strong>bold</strong></p>'), '');
	assert.match(html, /<strong>bold<\/strong>/);
	assert.match(text, /bold/);
});
