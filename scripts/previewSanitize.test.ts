import assert from 'node:assert/strict';
import test from 'node:test';

import { MARKDOWN_SANITIZE_CONFIG, ALLOWED_MARKDOWN_URI_REGEXP } from '../src/lib/utils/sanitize.js';
import { SANITIZER_FILES, callSiteOffsets, enclosingFunctionName, filesMatching, readSource, readSourceFiles, sliceBetween } from './sourceTree.js';

// The preview is the path the `<style>` clause in the shared policy was written
// for, and it was the one path not using it. `tab.content` (the rendered,
// processed document) is injected into the *application's own* document by
// `{@html sanitizedHtml}`, so an author stylesheet is not scoped to the article.
// The viewer used to call DOMPurify itself with a hand-copied duplicate of the
// URI pattern and nothing else, and `<style>` is on DOMPurify's default
// allowlist with its CSS unfiltered.
//
// DOMPurify needs a real DOM, which the Node test runner does not have, so the
// behavioural half was measured against the pinned build (dompurify 3.4.12,
// `dist/purify.js`) in a real browser, with the payload below injected exactly
// the way `{@html}` injects it, into a document that also contained a
// `.titlebar` element:
//
//   config                                     output          .titlebar        body background-image
//   {ALLOWED_URI_REGEXP}        (before)        <style> kept    display: none    url("https://attacker.example/beacon")
//   MARKDOWN_SANITIZE_CONFIG    (after)         <style> gone    display: flex    none
//
// The beacon was not hypothetical: `performance.getEntriesByType('resource')`
// listed `https://attacker.example/beacon` after the injection. In the app both
// halves are permitted by the shipped CSP — `style-src 'self' 'unsafe-inline' …`
// and `img-src 'self' asset: https: …` (src-tauri/tauri.conf.json).
//
// The payload was, verbatim:
//
//   <style>.titlebar{display:none} body{background-image:url("https://attacker.example/beacon")}</style>
//
// It used to be a `POC_STYLE` constant with an `assert.match(POC_STYLE,
// /^<style>/)` under it. That assertion read as part of the chain below but had
// no end in `src/`: both sides were this file, one line apart, so no change to
// the application could ever fail it. The payload is documentation, so it is
// documentation now.
//
// What is checkable here is the wiring that decides which config the preview
// gets, and that is what these tests pin.

const SOURCES = readSourceFiles('src');
const viewerSource = readSource('src/lib/MarkdownViewer.svelte');
const sanitizeSource = readSource('src/lib/utils/sanitize.ts');
const richContentSource = readSource('src/lib/utils/richContent.ts');

/**
 * The identifier the preview injects with `{@html}`, proved to be the shared
 * sanitizer's output.
 *
 * The chain is what matters — something is declared from
 * `sanitizeMarkdownHtml(...)` and *that* something is what reaches `{@html}` —
 * so this reads the name out of the source instead of pinning it. The previous
 * form spelled the whole declaration out (`let sanitizedHtml = $derived(...)`),
 * which made the private binding name, the `let`, and the `$derived` wrapper
 * into contract; renaming the variable or switching how it is computed would
 * have failed the suite while the security property held.
 */
function sanitizedSinkName(): string {
	const declaration = viewerSource.match(/(?:let|const)\s+([A-Za-z_$][\w$]*)\s*=\s*[^;\n]*\bsanitizeMarkdownHtml\(/);
	assert.ok(declaration, 'the preview must derive what it injects from sanitizeMarkdownHtml');
	return declaration![1];
}

test('the preview sanitizes through the shared policy, not a local config', () => {
	assert.match(
		viewerSource,
		/import\s*\{[^}]*\bsanitizeMarkdownHtml\b[^}]*\}\s*from\s*'[^']*\/sanitize\.js'/,
		'the viewer must import the shared sanitizer',
	);

	// The sinks: every `{@html …}` in the viewer, whatever the expression looks
	// like. Stated over *all* of them rather than over one known-good spelling,
	// so adding an injection point of the raw document is a failure instead of
	// an unnoticed addition.
	//
	// The capture used to be `([A-Za-z_$][\w$]*)`, bare identifiers only, which
	// made the claim unfalsifiable in exactly the direction it is about. The
	// list it compared was `[sanitizedSinkName()]` by construction: the second
	// sink already in the file, `{@html tooltip.html}`, was invisible to it, and
	// a planted `{@html unsafe.rawHtml}` beside the sanitized one — the raw
	// rendered document, injected — left the whole suite green.
	//
	// So the set is an allowlist now, and `tooltip.html` is on it with a reason
	// rather than by accident: the footnote tooltip is a clone of a subtree of
	// `markdownBody`, i.e. of the DOM the sanitized sink already injected. It is
	// not a second policy, it is the same bytes read back out of the document —
	// which is what the next two assertions pin.
	//
	// The document's own sink is no longer one of them. `{@html sanitizedHtml}`
	// rebuilt the whole article per keystroke, so the preview now patches in only
	// the blocks that changed (see utils/blockPatch.ts) — which means the string
	// becomes nodes inside that module instead of inside the compiler's `@html`.
	// The security property is unchanged and the chain is the same length: the
	// sanitizer's output, and nothing else, is what is parsed. The two
	// assertions after this one are that chain.
	//
	// Matched at the start of a line so that a comment *about* `{@html}` — this
	// file's subject, and the viewer is full of them now — cannot stand in for a
	// sink and quietly satisfy the check.
	const injected = [
		...new Set([...viewerSource.matchAll(/^[^\S\n]*\{@html\s+([^}]+?)\s*\}/gm)].map((m) => m[1])),
	].sort();
	assert.deepEqual(
		injected,
		['tooltip.html'],
		'unexpected {@html} sink — what the preview injects is the shared sanitizer output',
	);

	// The document sink, in the form it takes now: one call, and what it is
	// handed is the sanitized string. `patchPreviewBlocks` is the only way into
	// the preview's article, so pinning its argument pins the whole path.
	const patchArguments = [...viewerSource.matchAll(/patchPreviewBlocks\(\s*[\w.]+\s*,\s*([\w.]+)\s*\)/g)].map(
		(match) => match[1],
	);
	assert.deepEqual(
		patchArguments,
		[sanitizedSinkName()],
		'the preview must patch in the shared sanitizer output, once, and nothing else',
	);

	// And that the module it is handed to has no other way of making nodes out
	// of a string: one `innerHTML`, assigned from the parameter above.
	const blockPatchSource = readSource('src/lib/utils/blockPatch.ts');
	const parses = [...blockPatchSource.matchAll(/\.(?:innerHTML|outerHTML|insertAdjacentHTML)\s*=\s*([^;]+);/g)].map(
		(m) => m[1].trim(),
	);
	assert.deepEqual(
		parses,
		['sanitizedHtml'],
		'blockPatch.ts must parse the sanitized string and never assemble markup of its own',
	);

	// Why the footnote sink is allowed, pinned as a direction rather than as a
	// spelling: the tooltip body is read out of the rendered document, never
	// built from a string the sanitizer has not seen.
	const footnote = sliceBetween(viewerSource, "anchor.hasAttribute('data-footnote-ref')", 'isFootnote: true');
	assert.match(footnote, /markdownBody\?\.querySelector/, 'the footnote body is found in the rendered document');
	assert.match(footnote, /\.innerHTML/, 'and taken from the DOM the shared sanitizer already filtered');
	assert.doesNotMatch(footnote, /rawContent/, 'never from the unrendered buffer');

	// The regression itself — a DOMPurify call with a config assembled at the
	// call site — is caught for the whole tree by the call-site allowlist below;
	// the viewer is not on it. What stays here is the other half of that
	// regression, which the allowlist cannot see: the viewer hand-copied the URI
	// pattern out of the shared policy.
	assert.doesNotMatch(
		viewerSource,
		/ALLOWED_URI_REGEXP/,
		'the viewer must not carry its own copy of the URI policy',
	);
});

test('the shared policy the preview now gets is the one that forbids author stylesheets', () => {
	// Read as one chain: the preview calls sanitizeMarkdownHtml (test above),
	// sanitizeMarkdownHtml passes MARKDOWN_SANITIZE_CONFIG, and that config
	// forbids the tag the payload needs.
	assert.match(sanitizeSource, /return DOMPurify\.sanitize\(html, MARKDOWN_SANITIZE_CONFIG\)/);
	assert.deepEqual(Object.keys(MARKDOWN_SANITIZE_CONFIG).sort(), ['ALLOWED_URI_REGEXP', 'FORBID_TAGS']);
	assert.deepEqual(MARKDOWN_SANITIZE_CONFIG.FORBID_TAGS, ['style']);
	// Identity, not equality: the regression this file exists for is a *copy* of
	// the URI pattern, and a copy that happens to be spelled the same today is
	// the thing that drifts tomorrow. Measured — rebuilding the config's regexp
	// from the exported one's source and flags fails here.
	assert.equal(MARKDOWN_SANITIZE_CONFIG.ALLOWED_URI_REGEXP, ALLOWED_MARKDOWN_URI_REGEXP);
});

// Every `DOMPurify.sanitize` in `src/` is a decision about what a piece of
// untrusted input is allowed to be, and the compiler cannot tell that a new one
// silently reintroduces a private policy — this file exists because that is
// precisely what happened. Pin the set of call sites: a document that reaches
// the DOM must go through `sanitizeMarkdownHtml`, and anything else has to
// justify itself.
//
// The allowlist itself (`sanitize.ts`, which owns the document policy, and
// `richContent.ts`, which sanitizes Mermaid's own SVG under a deliberately
// different config — it needs `foreignObject` and the inline `<style>` the
// document policy forbids, verified in a browser against the pinned DOMPurify)
// lives in scripts/sourceTree.ts, because singleImplementationConvention.test.ts
// pins the *import* sites against the same two files. It used to be written out
// in both places, so widening one and forgetting the other was a silent way to
// end up with one scan guarding a set the other had already given up on.
test('DOMPurify call sites in src are the allowlisted ones', () => {
	// A per-file occurrence count used to be asserted here as well. It is dropped
	// on purpose: what a reviewer has to approve is *which files* may configure a
	// sanitizer, and "richContent.ts calls it once, not twice" made every
	// refactor inside an already-approved file a test failure. A second config in
	// an allowlisted file is still visible — the two tests below pin what each of
	// the two configs must contain.
	assert.deepEqual(
		filesMatching(SOURCES, /DOMPurify\.sanitize\(/),
		SANITIZER_FILES,
		'unexpected DOMPurify.sanitize call site — rendered markdown goes through sanitizeMarkdownHtml',
	);
});

test('the diagram sanitizer stays separate from the document policy', () => {
	// Both halves of the split are asserted so a later "let us unify these"
	// change has to confront the reason: the diagram config must permit the
	// `<style>` element the document config forbids outright.
	//
	// `assert.match(richContentSource, /ADD_TAGS: \['foreignObject'\]/)` stood
	// here as the second reason. It went with the allowance itself: DOMPurify
	// deletes the HTML inside a `foreignObject` whatever `ADD_TAGS` says, so the
	// tag could only ever come through empty, and an empty one *hid* the SVG
	// `<text>` fallback Mermaid pairs it with. scripts/mermaidDiagramLabels.test.ts
	// replaces it by running the render pipeline and checking the labels end up
	// somewhere no filter can reach.
	// The import, not the name: the comment above `sanitizeDiagramSvg` explains
	// the split and therefore spells `MARKDOWN_SANITIZE_CONFIG` out, so matching
	// the identifier would fail on prose.
	assert.doesNotMatch(
		richContentSource,
		/import\s*\{[^}]*\}\s*from\s*'[^']*\/sanitize\.js'/,
		'the diagram filter must not adopt the document policy',
	);
	assert.ok(MARKDOWN_SANITIZE_CONFIG.FORBID_TAGS.includes('style'));
});

test('the two paths keep their opposite orders on purpose', () => {
	// The export sanitizes the renderer output and processes afterwards
	// (scripts/exportSanitize.test.ts pins that). The preview processes first
	// and sanitizes at the sink, so the string that reaches `{@html}` is exactly
	// the sanitizer's output — there is no parse/serialize round trip after the
	// filter has run. Pin the order so the difference cannot be "tidied up"
	// into a weaker one without reading why.
	//
	// The order is what is asserted, by naming the function each half runs in.
	// The previous form searched for the two statements verbatim — down to the
	// argument list `(html, filePath, collapsedHeaders)` and the trailing
	// semicolon — which pinned three private parameter names and a formatting
	// choice as the price of checking which call happens where.
	assert.deepEqual(
		callSiteOffsets(viewerSource, 'processMarkdownHtml').map((offset) => enclosingFunctionName(viewerSource, offset)),
		['renderMarkdownPreview'],
		'renderMarkdownPreview must be the one place that processes the renderer output',
	);
	assert.doesNotMatch(
		viewerSource,
		/processMarkdownHtml\(\s*sanitizeMarkdownHtml/,
		'the preview must not move the filter ahead of processing without revisiting the note above',
	);
	// The sink half — that what `{@html}` injects is the sanitizer's output — is
	// asserted over every injection point in the first test above.
});
