import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { callSiteOffsets, enclosingFunctionName, filesMatching, offsetOf, readSource, readSourceFiles, SANITIZER_FILES, sliceBetween } from './sourceTree.js';
import { ALLOWED_MARKDOWN_URI_REGEXP, MARKDOWN_SANITIZE_CONFIG } from '../src/lib/utils/sanitize.js';
import { getStoredPreviewFullWidth } from '../src/lib/utils/previewWidth.js';

describe('inline code in headings', () => {
	// #681: inline code in a heading rendered small and floating above the words
	// around it. Two independent causes, one in each stylesheet, and neither is
	// reachable by a test that runs code — this is CSS the browser resolves.

	const styles = readSource('src/styles.css');

	const viewer = readSource('src/lib/MarkdownViewer.svelte');

	test('a heading lays its content out as one line of text', () => {
		// A flex heading makes every text run, `<em>`, `<code>` and image its own
		// flex item: #681 floated inline code above the words, #791 ate the spaces
		// around `*not*` and broke it into `n`/`o`/`t` on a narrow pane. The fold
		// chevron is absolutely positioned, so inline layout costs it nothing.
		const rule = styles.match(/\.foldable-header \{[^}]*\}/);
		assert.ok(rule, 'styles.css must still define .foldable-header');
		assert.doesNotMatch(rule[0], /display:\s*(inline-)?(flex|grid)/);
	});

	test('inline code in a heading scales with the heading', () => {
		// The Code Font Size setting is an absolute px — right for code in prose,
		// wrong for code in a heading, where 14px inside a 24px `##` reads as a
		// footnote. GitHub sizes inline code relative to what contains it.
		assert.match(
			viewer,
			/:global\(\.markdown-body :is\(h1, h2, h3, h4, h5, h6\) code\) \{\s*\n\s*font-size: 0\.85em !important;/,
		);
	});

	test('the setting still governs code everywhere else', () => {
		// The fix is scoped to headings; body text and code blocks keep answering to
		// `--code-font-size`, which is what the setting promises.
		assert.match(viewer, /:global\(\.markdown-body code\) \{[\s\S]*?font-size: var\(--code-font-size, 14px\) !important;/);
	});
});

/**
 * KaTeX publishes every contrib file twice: `contrib/*.mjs` behind the
 * `import` condition, `contrib/*.js` (CommonJS, `require("katex")`) behind
 * `require`. Only the `.mjs` shares the preview's KaTeX instance; the `.js`
 * gets the bundler's CommonJS copy, and a macro mhchem registers there never
 * reaches `renderToString` (#745). vitest and node both dedupe the two, so the
 * only runtime that shows the split is a production build — which is why this
 * is asserted on the source: the loader may not name the CommonJS flavour.
 */
describe('KaTeX contrib flavour', () => {
	test('the rich-content loader imports KaTeX contribs through the exports map', () => {
		const source = readSource('src/lib/utils/richContent.ts');
		assert.doesNotMatch(source, /import\('katex\/dist\/contrib\//);
		assert.match(source, /import\('katex\/contrib\/mhchem'\)/);
	});
});

describe('local file links', () => {
	test('the capability still grants the command this depends on', () => {
		// `open_path` needs both the command grant and a path scope. Granting the
		// command alone leaves the plugin resolving
		// `fs_scope.is_allowed(path) && allowed.any(matches_path_program)` against
		// URL-only scope entries, which answer false to the second — that is how
		// `openPath` came to be refused with ForbiddenPath everywhere, including in
		// `askToOpenExportedFile` (#399, fixed in #403). Asserted here so the grant
		// cannot quietly disappear; the scope's shape is deliberately not asserted,
		// so narrowing it later is not a test failure.
		const capability = readSource('src-tauri/capabilities/default.json');
		assert.match(capability, /opener:allow-open-path/);
	});
});

describe('preview copy handler', () => {
	// #549 put both DOM-selection copy routes — ⌘C in the preview, and Edit ▸ Copy
	// in the menu bar, which is a predefined Copy item asking the webview to
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

	test('the document-level copy handler is attached', () => {
		// Document level rather than the preview's `<article>`: `styles.css` puts
		// `user-select: none` on the app root, so the only selectable surfaces are
		// the preview and the update dialog's release notes (#532) — and both take
		// the same native path.
		const svelteDocument = sliceBetween(viewer, '<svelte:document', '/>');
		assert.match(svelteDocument, /oncopy=\{handleCopy\}/);
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
});

describe('preview sanitizing', () => {
	// The preview is the path the `<style>` clause in the shared policy was written
	// for, and it was the one path not using it. `tab.content` (the rendered,
	// processed document) is injected into the *application's own* document by
	// `{@html sanitizedHtml}`, so an author stylesheet is not scoped to the article.
	// The viewer used to call DOMPurify itself with a hand-copied duplicate of the
	// URI pattern and nothing else, and `<style>` is on DOMPurify's default
	// allowlist with its CSS unfiltered.
	//
	// DOMPurify needs a real DOM, which the Node test runner does not have, so the
	// behavioural half of this file was for a while a table of numbers measured by
	// hand in a browser and pasted into this comment — the payload injected the way
	// `{@html}` injects it, the `<style>` surviving the old config and hiding the
	// app's `.titlebar`, the beacon showing up in
	// `performance.getEntriesByType('resource')`. All true when it was written, and
	// unfalsifiable ever after: no change to `src/` could disagree with a comment.
	//
	// It runs now. `previewSanitize.spec.ts` is the same payload against the same
	// two configs under jsdom, which has a real DOM and a real cascade, asserting
	// what `getComputedStyle` says about the application's own chrome afterwards.
	// (The one thing it cannot observe is the request for the beacon URL, which
	// jsdom does not issue; the computed value that names it is asserted instead.
	// In the app both halves are permitted by the shipped CSP — `style-src 'self'
	// 'unsafe-inline' …` and `img-src 'self' asset: https: …`, in
	// src-tauri/tauri.conf.json.)
	//
	// What is checkable HERE is the wiring that decides which config the preview
	// gets, and that is what these tests pin. It is the half a runtime test cannot
	// reach: which call sites exist, and which of them build a policy of their own.

	const SOURCES = readSourceFiles('src');

	const viewerSource = readSource('src/lib/MarkdownViewer.svelte');

	const sanitizeSource = readSource('src/lib/utils/sanitize.ts');

	const richContentSource = readSource('src/lib/utils/richContent.ts');

	const previewPatchSource = readSource('src/lib/utils/previewPatch.ts');

	test('the preview sanitizes through the shared policy, not a local config', () => {
		assert.match(
			previewPatchSource,
			/import\s*\{[^}]*\bsanitizeMarkdownFragment\b[^}]*\}\s*from\s*'[^']*\/sanitize\.js'/,
			'the preview patch must import the shared sanitizer',
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
		// the blocks that changed (see utils/previewPatch.ts) — which means the string
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

		// The document sink, in the form it takes now: one call, handed the
		// renderer's output. `patchPreview` is the only way into the preview's
		// article, so what it does with that string is the whole path.
		assert.equal(
			[...viewerSource.matchAll(/\bpatchPreview\(\s*host\s*,\s*htmlContent\s*,/g)].length,
			1,
			'the preview must reach the article through patchPreview, once',
		);

		// Inside it: the one place markup is parsed is a block of the renderer's
		// output, into a detached document of its own, before the filter — and what
		// a block puts into the article is the filter's own nodes. Nothing is
		// parsed after `sanitizeMarkdownFragment`, and no markup is assembled.
		const parses = [...previewPatchSource.matchAll(/(\w+)\.(?:innerHTML|outerHTML|insertAdjacentHTML)\s*=\s*([^;]+);/g)].map(
			(m) => `${m[1]} = ${m[2].trim()}`,
		);
		assert.deepEqual(parses, ['box = markup'], 'previewPatch.ts parses only the renderer output, before the filter');
		assert.match(previewPatchSource, /const box = scratch\.createElement\('div'\);/, 'into the detached scratch document');
		const processAndSanitize = sliceBetween(previewPatchSource, 'function processAndSanitize(', '\n}\n');
		assert.match(processAndSanitize, /return sanitizeMarkdownFragment\(box\.innerHTML\);$/, 'and the filter has the last word');
		// What a block is inserted as is always the filter's own nodes.
		const renderBlocks = sliceBetween(previewPatchSource, 'function renderBlocks(', '\n}\n');
		assert.deepEqual(
			[...renderBlocks.matchAll(/Array\.from\((\w+)\.children\)/g)].map((m) => m[1]),
			['clean', 'lone', 'mark'],
		);
		assert.match(renderBlocks, /const clean = processAndSanitize\(/);
		assert.match(renderBlocks, /const lone = processAndSanitize\(/);
		assert.match(renderBlocks, /const marks = Array\.from\(clean\.children\);/);
		assert.match(renderBlocks, /return marks\.map\(\(mark\) =>/);
		assert.doesNotMatch(previewPatchSource, /insertAdjacentHTML|outerHTML|createContextualFragment/);

		// Why the footnote sink is allowed, pinned as a direction rather than as a
		// spelling: the tooltip body is read out of the rendered document, never
		// built from a string the sanitizer has not seen.
		//
		// `previewBlocks` and not `markdownBody`, and the difference is the whole
		// point of the assertion rather than a rename. The article now holds one
		// host per open tab, and `previewBlocks` is the one `patchPreview` was
		// handed above — so this pins the tooltip to the exact element the sanitized
		// string was parsed into, where the previous spelling only reached the box
		// containing it.
		const footnote = sliceBetween(viewerSource, "anchor.hasAttribute('data-footnote-ref')", 'isFootnote: true');
		assert.match(footnote, /previewBlocks\?\.querySelector/, 'the footnote body is found in the rendered document');
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
		// Read as one chain: the preview patch calls sanitizeMarkdownFragment (test
		// above), which passes MARKDOWN_SANITIZE_CONFIG and only asks for nodes
		// back, as the export's sanitizeMarkdownHtml passes it, and that config
		// forbids the tag the payload needs.
		assert.match(sanitizeSource, /return DOMPurify\.sanitize\(html, MARKDOWN_SANITIZE_CONFIG\)/);
		assert.match(
			sanitizeSource,
			/return DOMPurify\.sanitize\(html, \{ \.\.\.MARKDOWN_SANITIZE_CONFIG, RETURN_DOM_FRAGMENT: true \}\)/,
		);
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
		// and sanitizes at the sink, so what reaches the article is exactly the
		// sanitizer's output — there is no parse/serialize round trip after the
		// filter has run. Pin the order so the difference cannot be "tidied up"
		// into a weaker one without reading why.
		//
		// The order is what is asserted, by naming the function each half runs in.
		// The previous form searched for the two statements verbatim — down to the
		// argument list `(html, filePath, collapsedHeaders)` and the trailing
		// semicolon — which pinned three private parameter names and a formatting
		// choice as the price of checking which call happens where.
		// The preview processes the blocks it inserts in `processAndSanitize`, and
		// nowhere else; the viewer hands the renderer's output straight to the patch.
		assert.deepEqual(callSiteOffsets(viewerSource, 'processMarkdownHtml'), [], 'the viewer processes nothing itself');
		assert.deepEqual(
			callSiteOffsets(previewPatchSource, 'processBlockMarkup').map((offset) => enclosingFunctionName(previewPatchSource, offset)),
			['processAndSanitize'],
			'processAndSanitize must be the one place that processes the renderer output',
		);
		const processAndSanitize = sliceBetween(previewPatchSource, 'function processAndSanitize(', '\n}\n');
		assert.ok(
			processAndSanitize.indexOf('processBlockMarkup(') < processAndSanitize.indexOf('sanitizeMarkdownFragment('),
			'the preview must not move the filter ahead of processing without revisiting the note above',
		);
		// The sink half — that what `{@html}` injects is the sanitizer's output — is
		// asserted over every injection point in the first test above.
	});
});

describe('preview width', () => {
	const settingsSource = readSource(new URL('../src/lib/stores/settings.svelte.ts', import.meta.url));

	const viewerSource = readSource(new URL('../src/lib/MarkdownViewer.svelte', import.meta.url));

	const settingsComponentSource = readSource(new URL('../src/lib/components/Settings.svelte', import.meta.url));

	const tocOverlaySource = readSource(new URL('../src/lib/utils/tocOverlay.ts', import.meta.url));

	test('settings load, persist, and reset the preview width through one normalizer', () => {
		assert.match(settingsSource, /previewMaxWidth = \$state\(DEFAULT_PREVIEW_MAX_WIDTH\)/);
		// Persistence moved from one all-fields effect to one entry per localStorage
		// key (so that a change in one window stops rewriting every other key from a
		// stale snapshot). The preview width still round-trips under the same key and
		// through the same normalizer; only the plumbing that reads and writes it is
		// now shared. See scripts/settingsPersistence.spec.ts.
		assert.match(settingsSource, /key: 'preview\.maxWidth'/);
		assert.match(settingsSource, /read: \(s\) => String\(s\.previewMaxWidth\)/);
		assert.match(settingsSource, /normalizePreviewMaxWidth\(savedPreviewMaxWidth\)/);
		assert.match(settingsSource, /resetPreviewMaxWidth\(\)[\s\S]*this\.previewMaxWidth = DEFAULT_PREVIEW_MAX_WIDTH/);
	});

	test('preview layout derives width and ToC geometry from the same preference', () => {
		assert.match(viewerSource, /getPreviewContentWidth\(settings\.previewMaxWidth, settings\.previewFullWidth\)/);
		// The gutter arithmetic moved to `tocOverlay.ts` with #176, which added the
		// question the inline expression could not answer: whether the pane under
		// the outline is the preview at all. Both halves still feed on this same
		// preference — see scripts/tocOverlay.test.ts for the geometry itself.
		assert.match(viewerSource, /isTocOverhanging\(\{[\s\S]*?previewContentWidth,[\s\S]*?\}\)/);
		assert.match(tocOverlaySource, /input\.viewerWidth - input\.previewContentWidth/);
		assert.match(viewerSource, /--preview-max-width:/);
		assert.match(viewerSource, /--measure: min\(100cqi, var\(--preview-max-width, 880px\)\)/);
	});

	test('Settings exposes a bounded preview-width input and reset action', () => {
		assert.match(settingsComponentSource, /id="preview-max-width"/);
		assert.match(settingsComponentSource, /min=\{MIN_PREVIEW_MAX_WIDTH\}/);
		assert.match(settingsComponentSource, /max=\{MAX_PREVIEW_MAX_WIDTH\}/);
		assert.match(settingsComponentSource, /bind:value=\{settings\.previewMaxWidth\}/);
		assert.match(settingsComponentSource, /settings\.resetPreviewMaxWidth\(\)/);
	});

	test('preview full-width state migrates from the legacy localStorage key', () => {
		// The pair the migration is made of, asserted on the function rather than on
		// its call site: `??` is what makes the new key win once it exists.
		assert.equal(getStoredPreviewFullWidth('true', null), true);
		assert.equal(getStoredPreviewFullWidth(null, 'true'), true, 'the legacy key still decides while the new one is absent');
		assert.equal(getStoredPreviewFullWidth('false', 'true'), false, 'the new key wins outright, it is not OR-ed with the old one');
		assert.equal(getStoredPreviewFullWidth(null, null), false);

		// It is a persisted setting like every other one now, which is what gets it
		// cross-window sync — the viewer used to read and write `preview.fullWidth`
		// with bare localStorage calls and no `storage` listener, so a second window
		// only noticed after a restart. See scripts/settingsPersistence.spec.ts.
		assert.match(settingsSource, /key: 'preview\.fullWidth'/);
		assert.match(settingsSource, /read: \(s\) => String\(s\.previewFullWidth\)/);
		assert.match(settingsSource, /getStoredPreviewFullWidth\(raw, readStoredKey\(LEGACY_PREVIEW_FULL_WIDTH_KEY\)\)/);
		assert.match(settingsSource, /const LEGACY_PREVIEW_FULL_WIDTH_KEY = 'isFullWidth';/);
	});
});

describe('render pipeline convention', () => {
	// Every preview render must go through renderMarkdownPreview, which strips
	// YAML front matter before invoking the Rust renderer. Calling the raw
	// `invoke('render_markdown')` command anywhere else silently bypasses that
	// step — the compiler cannot catch it because the command name is a string.
	//
	// Which *files* may name the raw command is a single-implementation question and
	// is pinned by the RULES table in singleImplementationConvention.test.ts. What is
	// left here is the half that table cannot express: inside the viewer, the raw
	// command must sit in renderMarkdownPreview and nowhere else.
	//
	// If you add a new render call site, use renderMarkdownPreview (or
	// renderTabPreviewFromRaw for the full render-and-apply sequence) instead
	// of widening the allowlist.

	const VIEWER = 'src/lib/MarkdownViewer.svelte';

	const WRAPPER = 'renderMarkdownPreview';

	test('every raw render_markdown call in the viewer sits inside renderMarkdownPreview', () => {
		const viewer = readSource(VIEWER);
		const offsets = callSiteOffsets(viewer, 'invoke').filter((offset) =>
			/^invoke\(\s*'render_markdown'/.test(viewer.slice(offset)),
		);

		// Not "there is exactly one occurrence, and something matching the wrapper
		// name appears within 400 characters of it". That form passed as soon as a
		// single call was wrapped and stopped guarding the moment the function grew
		// past the window; this one names the enclosing function of *each* call, so a
		// second bypassing call site inside the same file is a failure rather than an
		// off-by-one in a character budget.
		assert.ok(offsets.length > 0, `${VIEWER} no longer invokes render_markdown — has the render path moved?`);
		assert.deepEqual(
			offsets.map((offset) => enclosingFunctionName(viewer, offset)),
			offsets.map(() => WRAPPER),
			`the raw render_markdown command must be invoked from ${WRAPPER}, which strips front matter first`,
		);
	});
});

describe('save image as', () => {
	/*
	 * "Save image as" could never save a remote image, and on Windows it could not
	 * save a LOCAL one either.
	 *
	 * The branch it took was `src.startsWith('http')` -> `fetch(src)`. Two things
	 * are wrong with that:
	 *
	 * - The app's CSP is `connect-src 'self'`, so a cross-origin `fetch` from the
	 *   webview is refused before a request is made. (`img-src ... https:` is a
	 *   different directive: it governs what an `<img>` may DISPLAY.) The remote
	 *   case was therefore unreachable on every platform.
	 * - `convertFileSrc` spells a local file's asset URL
	 *   `http://asset.localhost/<encoded path>` on Windows and
	 *   `asset://localhost/<encoded path>` everywhere else. The `asset:` test
	 *   above it only recognised the second, so on Windows every local image fell
	 *   into that unreachable remote branch.
	 *
	 * The shape-recognition half is `normalizeAssetPath` (#363), which already had
	 * tests for both spellings and for lookalike hosts. This file asserts that the
	 * viewer now uses it — reuse is the fix, so the assertions are about the call
	 * site — plus the two properties the reuse buys, run against the real function.
	 */

	const viewer = readSource('src/lib/MarkdownViewer.svelte');

	const body = sliceBetween(viewer, 'async function saveImageAs', 'async function saveDiagramAs');

	test('the viewer recognises an asset URL with the shared helper', () => {
		assert.match(body, /normalizeAssetPath\(src\)/);
		// The two hand-rolled tests this replaces. Either one coming back means the
		// Windows spelling is unhandled again.
		assert.doesNotMatch(body, /startsWith\('asset:'\)/);
		assert.doesNotMatch(body, /startsWith\('http'\)/);
	});

	test('nothing tries to fetch image bytes from the webview any more', () => {
		// Dead code that reads like a working feature: it opened no dialog, wrote
		// no file, and reported a network failure that never happened.
		assert.doesNotMatch(body, /fetch\(/);
		assert.doesNotMatch(body, /arrayBuffer\(/);
		assert.doesNotMatch(body, /save_file_binary/);
	});

	test('a local image is copied on the Rust side', () => {
		assert.match(body, /invoke\('copy_file', \{ src: realPath, dest \}\)/);
		// And the save dialog is only offered for a file that can actually be
		// written; the remote case bails out before it.
		const bail = offsetOf(body, "t('toast.remoteImageNotSupported'");
		const dialog = offsetOf(body, 'await save(');
		assert.ok(bail < dialog, 'do not ask for a destination that cannot be written');
	});

	test('the preview offers Save Image As only for a local image', () => {
		// A remote or data: image cannot be saved, so the item is not shown for one
		// rather than shown and answered with an error toast.
		const menu = sliceBetween(viewer, "const img = (e.target as HTMLElement).closest('img');", "t('menu.saveImageAs'");
		assert.match(menu, /if \(img && normalizeAssetPath\(img\.src\)\)/);
	});

	test('the CSP that makes the remote case impossible is still the one described', () => {
		// If `connect-src` is ever widened, the comment above stops being true and
		// a JS download becomes possible again. Fail here rather than leave a
		// stale explanation in the source.
		const conf = readSource('src-tauri/tauri.conf.json');
		assert.match(conf, /"connect-src":\s*"'self'"/);
	});
});

describe('YouTube external fallback', () => {
	const tauriConfig = readSource('src-tauri/tauri.conf.json');

	// --- the halves that are not this module's output ---

	test('the app no longer permits YouTube frames', () => {
		// A contract with the packaged app rather than with a function: the CSP
		// lives in tauri.conf.json, nothing type-checks it, and a `frame-src` that
		// outlived the iframe is permission granted for no feature.
		assert.doesNotMatch(tauriConfig, /frame-src/);
	});
});
