/**
 * The HTML export has to contain rendered rich content, not the source of it.
 *
 * Before this, `exportAsHtml` ran `render_markdown → sanitize →
 * processMarkdownHtml` and stopped. `renderRichContent` — highlight.js, KaTeX,
 * Mermaid — was a function inside `MarkdownViewer.svelte` that only the preview
 * could reach. So an exported file, the artefact whose entire purpose is being
 * read by someone without Markpad, arrived with
 * `<p data-math="display" data-math-source="E = mc^2">E = mc^2</p>`,
 * `<pre><code class="language-mermaid">` and code blocks with no highlight
 * classes at all.
 *
 * These tests run the real `exportAsHtml` and assert on the bytes it hands to
 * `save_file_content`. Two things are stood in for, both at a library boundary
 * rather than at one of ours:
 *
 *   - highlight.js, KaTeX and Mermaid. All three need a real browser DOM
 *     (measured against the shim: `hljs.highlightElement` and `katex.render`
 *     both throw on it, and Mermaid needs layout to size a node). They are
 *     injected through the same `libraries` field the app fills from the
 *     preview's own instances, so what is exercised here is Markpad's pipeline
 *     — which elements get handed to which library, and where the results end
 *     up — and not the libraries' own output.
 *   - `DOMPurify.sanitize`, which is a no-op object without a real DOM. It is
 *     replaced by the identity function. What the filter does and where it sits
 *     in the pipeline is pinned by `exportSanitize.test.ts`; the relevant fact
 *     here is only that the diagram filter and the document filter are separate
 *     calls, which the diagram test below covers from the other side.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { installShimDom } from './renderProtocolDom.ts';
import { readSource } from './sourceTree.js';

installShimDom();
(globalThis as any).window = globalThis;
// The app resolves the bundled font assets against its own origin.
(globalThis as any).location = { href: 'http://tauri.localhost/' };

const DOMPurify = (await import('dompurify')).default as any;
DOMPurify.sanitize = (html: string) => html;

const {
	absolutizeKatexFontUrls,
	collectUsedKatexFamilies,
	findKatexFontFaces,
	inlineKatexFontFaces,
	katexFontUrlsToEmbed,
} = await import('../src/lib/utils/exportFonts.ts');
const { exportAsHtml } = await import('../src/lib/utils/export.ts');
const { DEFAULT_PREVIEW_MAX_WIDTH } = await import('../src/lib/utils/previewWidth.ts');
const { renderRichContent } = await import('../src/lib/utils/richContent.ts');

// ---------------------------------------------------------------- fixtures

/** The shape comrak emits for the document below, after `processMarkdownHtml`. */
const RENDERED = [
	'<h1>Notes</h1>',
	'<p data-math="display" data-math-source="E = mc^2">E = mc^2</p>',
	'<p>and inline \\(a_i\\) too</p>',
	'<pre><code class="language-js">const answer = 42;</code></pre>',
	'<pre><code class="language-mermaid">graph TD; A--&gt;B;</code></pre>',
].join('\n');

/**
 * A slice of `katex.min.css` in the shape `CSSRule.cssText` produces, with the
 * hashed, *stylesheet-relative* asset URLs the real build emits (verified
 * against `build/_app/immutable/assets/*.css`: `url(./KaTeX_Main-Regular.
 * B22Nviop.woff2)`). Three families are declared; only the ones the article
 * references should survive into the export.
 */
const SHEET_HREF = 'http://tauri.localhost/_app/immutable/assets/2.C6eSkZFI.css';
const KATEX_CSS = `
.katex { font: normal 1.21em KaTeX_Main,Times New Roman,serif; }
.katex .mathnormal { font-family: KaTeX_Math; font-style: italic; }
.katex .mathcal { font-family: KaTeX_Caligraphic; }
@font-face { font-family: KaTeX_Main; src: url("./KaTeX_Main-Regular.B22Nviop.woff2") format("woff2"), url("./KaTeX_Main-Regular.Dr94JaBh.woff") format("woff"); font-weight: normal; font-style: normal; }
@font-face { font-family: KaTeX_Math; src: url("./KaTeX_Math-Italic.woff2") format("woff2"); font-weight: normal; font-style: italic; }
@font-face { font-family: KaTeX_Caligraphic; src: url("./KaTeX_Caligraphic-Regular.woff2") format("woff2"); font-weight: normal; font-style: normal; }
`;

function fakeLibraries(record: { mermaidThemes: string[]; mathCalls: string[] }) {
	return {
		hljs: {
			getLanguage: (name: string) => (name === 'js' ? { name } : null),
			highlight(code: string, options: { language: string }) {
				return { value: `<span class="hljs-keyword">${code}</span>`, language: options.language };
			},
		},
		katex: {
			renderToString(source: string, options: any) {
				record.mathCalls.push(`${options.displayMode ? 'display' : 'inline'}:${source}`);
				return `<span class="katex"><span class="mord mathnormal">${source}</span></span>`;
			},
		},
		renderMathInElement(root: any) {
			// Stands in for KaTeX's auto-render over `\(…\)`, which the renderer
			// runs after the `[data-math]` pass.
			for (const paragraph of root.querySelectorAll('p')) {
				const html = paragraph.innerHTML;
				if (!html.includes('\\(')) continue;
				record.mathCalls.push(`inline:${html.replace(/^[\s\S]*\\\((.*?)\\\)[\s\S]*$/, '$1')}`);
				paragraph.innerHTML = html.replace(
					/\\\((.*?)\\\)/g,
					'<span class="katex"><span class="mord mathnormal">$1</span></span>',
				);
			}
		},
		mermaid: {
			initialize(config: { theme: string }) {
				record.mermaidThemes.push(config.theme);
			},
			async render(id: string, source: string) {
				return {
					svg:
						`<svg id="${id}" role="graphics-document">` +
						`<style>#${id} .node rect{fill:#eee;}</style>` +
						`<foreignObject><div>${source.trim()}</div></foreignObject>` +
						`</svg>`,
				};
			},
		},
	};
}

interface ExportRun {
	document: string;
	savedTo: string | null;
	mermaidThemes: string[];
	mathCalls: string[];
	fetched: string[];
}

async function runExport(
	options: { css?: string; theme?: string; mermaidTheme?: string } = {},
): Promise<ExportRun> {
	const record = { mermaidThemes: [] as string[], mathCalls: [] as string[] };
	const fetched: string[] = [];
	let saved: { path: string; content: string } | null = null;

	(globalThis as any).window.__TAURI_INTERNALS__ = {
		convertFileSrc: (path: string) => `asset://localhost/${path}`,
		invoke: async (command: string, args: any) => {
			switch (command) {
				case 'plugin:dialog|save':
					return '/tmp/notes.html';
				case 'render_markdown':
					return RENDERED;
				case 'save_file_content':
					saved = { path: args.path, content: args.content };
					return null;
				default:
					throw new Error(`unexpected command ${command}`);
			}
		},
	};

	(globalThis as any).fetch = async (url: string) => {
		fetched.push(url);
		return {
			ok: true,
			// Deterministic bytes so the base64 in the assertions is stable.
			arrayBuffer: async () => new Uint8Array([119, 79, 70, 50]).buffer,
		};
	};

	// CSSOM hands out one rule at a time, each with the sheet that owns it —
	// which is the only place the base for a relative font URL exists.
	(globalThis as any).document.styleSheets = [
		{
			href: SHEET_HREF,
			cssRules: (options.css ?? KATEX_CSS)
				.trim()
				.split('\n')
				.map((cssText) => ({ cssText })),
		},
	];
	if (options.theme) (globalThis as any).document.documentElement.setAttribute('data-theme', options.theme);
	else (globalThis as any).document.documentElement.removeAttribute('data-theme');

	await exportAsHtml({
		rawContent: '# Notes\n',
		tabTitle: 'Notes',
		tabPath: '/documents/notes.md',
		mermaidTheme: options.mermaidTheme ?? 'neutral',
		libraries: fakeLibraries(record) as any,
		// The width the preview was reading at, which the export follows (#467).
		// Irrelevant to what this file asserts; `exportContentWidth.test.ts` owns it.
		contentWidth: DEFAULT_PREVIEW_MAX_WIDTH,
	});

	return {
		document: saved ? (saved as any).content : '',
		savedTo: saved ? (saved as any).path : null,
		mermaidThemes: record.mermaidThemes,
		mathCalls: record.mathCalls,
		fetched,
	};
}

// ------------------------------------------------------------------- tests

test('an exported file contains typeset math, not its LaTeX source', async () => {
	const run = await runExport();

	assert.equal(run.savedTo, '/tmp/notes.html');
	// The regression, stated as the reader sees it: where the formula belongs,
	// the exported page must hold the formula and not its source. (KaTeX renders
	// into the element and leaves `data-math-source` on it, which is why the
	// assertion is about what the element *contains*.)
	assert.match(
		run.document,
		/<p data-math="display" data-math-source="E = mc\^2"><span class="katex">/,
	);
	assert.doesNotMatch(run.document, /<p data-math="display"[^>]*>E = mc\^2<\/p>/);

	// Display and inline math both reach KaTeX, with the source the renderer
	// preserved rather than the text comrak happened to leave behind.
	assert.deepEqual(run.mathCalls, ['display:E = mc^2', 'inline:a_i']);
	assert.doesNotMatch(run.document, /\\\(/);
});

test('an exported file contains highlighted code', async () => {
	const run = await runExport();

	assert.match(run.document, /class="hljs-keyword"/);
	assert.match(run.document, /<code class="language-js hljs">/);
	// The shell the preview builds around a code block travels too, so the
	// exported page uses the same stylesheet rules the app does.
	assert.match(run.document, /class="code-block-shell"/);
	// The label is created for both paths but hidden in the export; it must not
	// arrive as a button that looks clickable and is not.
	assert.match(run.document, /\.lang-label \{\s*display: none !important;/);
});

test('an exported file contains drawn diagrams, not mermaid source', async () => {
	const run = await runExport({ mermaidTheme: 'dark' });

	assert.doesNotMatch(run.document, /language-mermaid/);
	// The diagram source travels on the container, which is what lets a later
	// PDF export re-render it in a light theme (#359).
	assert.match(run.document, /class="mermaid-diagram" data-mermaid-source="graph TD; A-->B;"/);
	assert.match(run.document, /<svg id="mermaid-/);
	// Mermaid's `<style>` is what carries a diagram's fills and strokes. It has
	// to survive into the export — the document-level policy forbids `<style>`
	// and would flatten every diagram, so the export must not re-run that filter
	// over the rendered output.
	assert.match(run.document, /<style>#mermaid-[^{]*\.node rect\{fill:#eee;\}<\/style>/);
	// The stand-in Mermaid above emits `foreignObject`; the real one no longer
	// does, and the diagram filter no longer allows it (see
	// scripts/mermaidDiagramLabels.test.ts). What is pinned here is unchanged by
	// that: the export must hand the *diagram* filter's output through, not the
	// document policy's. Case-insensitive because the shim lower-cases tag names
	// on serialisation where a real browser keeps `foreignObject`.
	assert.match(run.document, /<foreignobject>/i);

	// The exported page carries the theme it was made in, so the diagrams are
	// baked for that theme rather than for paper.
	assert.deepEqual(run.mermaidThemes, ['dark']);
});

test('the export still assembles the same document around the rendered article', async () => {
	const run = await runExport({ theme: 'dark' });

	assert.match(run.document, /^<!DOCTYPE html>\n<html lang="en" data-theme="dark">/);
	assert.match(run.document, /<meta http-equiv="Content-Security-Policy" content="default-src 'none';/);
	assert.match(run.document, /<article class="markdown-body">/);
	// The heading still goes through `processMarkdownHtml`'s fold wrapping —
	// rich rendering is added to that pipeline, not substituted for it.
	assert.match(run.document, /<h1 class="foldable-header"[^>]*>.*Notes<\/h1>/);
});

test('a document with math carries only the KaTeX fonts it uses', async () => {
	const run = await runExport();

	// `.katex` implies KaTeX_Main; the `mathnormal` span implies KaTeX_Math.
	// KaTeX_Caligraphic is declared in the stylesheet and referenced by nothing,
	// so it must not be paid for.
	//
	// The URLs are fetched absolute, resolved against the *stylesheet* rather
	// than the page. Resolving against `location.href` — the obvious thing, and
	// what the first draft did — silently produces
	// `http://tauri.localhost/KaTeX_Main-Regular…woff2`, which 404s, drops the
	// face and leaves the formula in Times without anything looking broken.
	assert.deepEqual(run.fetched, [
		'http://tauri.localhost/_app/immutable/assets/KaTeX_Main-Regular.B22Nviop.woff2',
		'http://tauri.localhost/_app/immutable/assets/KaTeX_Math-Italic.woff2',
	]);

	assert.match(run.document, /font-family: KaTeX_Main; src: url\(data:font\/woff2;base64,d09GMg==\) format\("woff2"\)/);
	assert.match(run.document, /font-family: KaTeX_Math; src: url\(data:font\/woff2;base64,d09GMg==\) format\("woff2"\)/);
	assert.doesNotMatch(run.document, /KaTeX_Caligraphic-Regular\.woff2/);
	// No app-internal URL survives into the file, absolute or relative.
	assert.doesNotMatch(run.document, /tauri\.localhost/);
	assert.doesNotMatch(run.document, /url\("\.\//);
});

test('a document with no math carries no KaTeX fonts at all', async () => {
	// The state #382 measured and decided was fine: nothing references the
	// families, so the rules were dead weight whose relative URLs 404 next to
	// the file. They now go, rather than travelling as a lie about what the
	// document needs.
	const cssOnly = KATEX_CSS;
	// Every face's bytes are in hand, so the family filter is the only thing
	// left that can drop them. Handing this an empty byte map — which is what
	// it used to do — deletes every face through the "bytes could not be read"
	// branch instead, and deleting the family filter outright stayed green.
	const bytes = new Map(
		findKatexFontFaces(cssOnly).map((face) => [face.woff2Url!, 'data:font/woff2;base64,d09GMg==']),
	);
	assert.equal(bytes.size, 3, 'the fixture stylesheet declares three faces, all with woff2 bytes');

	const document = inlineKatexFontFaces(cssOnly, new Set(), bytes);
	assert.doesNotMatch(document, /@font-face/);
	assert.match(document, /\.katex \{/);
});

// ------------------------------------------------- the pieces, on their own

test('the renderer works on a detached element', async () => {
	// The property that makes one implementation possible for both paths: the
	// export renders into a `<div>` that is in no document, so nothing in the
	// renderer may reach for a global element.
	const record = { mermaidThemes: [] as string[], mathCalls: [] as string[] };
	const root = (globalThis as any).document.createElement('div');
	root.innerHTML = RENDERED;
	assert.equal(root.parentNode, null);

	await renderRichContent({
		roots: [root],
		libraries: fakeLibraries(record) as any,
		mermaidTheme: 'neutral',
		idFactory: (index: number) => `diagram-${index}`,
	});

	assert.match(root.innerHTML, /<svg id="diagram-0"/);
	assert.match(root.innerHTML, /class="katex"/);
	assert.match(root.innerHTML, /class="hljs-keyword"/);
});

test('the font pass reads the stylesheet rather than a hard-coded family list', () => {
	const faces = findKatexFontFaces(KATEX_CSS);
	assert.deepEqual(
		faces.map((face) => [face.family, face.woff2Url]),
		[
			['KaTeX_Main', './KaTeX_Main-Regular.B22Nviop.woff2'],
			['KaTeX_Math', './KaTeX_Math-Italic.woff2'],
			['KaTeX_Caligraphic', './KaTeX_Caligraphic-Regular.woff2'],
		],
	);

	// Only KaTeX's own faces are made absolute, and only while the sheet that
	// owns them is still known.
	assert.equal(
		absolutizeKatexFontUrls(
			'@font-face { font-family: KaTeX_Main; src: url("./KaTeX_Main-Regular.B22Nviop.woff2") format("woff2"); }',
			SHEET_HREF,
		),
		'@font-face { font-family: KaTeX_Main; src: url("http://tauri.localhost/_app/immutable/assets/KaTeX_Main-Regular.B22Nviop.woff2") format("woff2"); }',
	);
	assert.equal(
		absolutizeKatexFontUrls('@font-face{font-family:codicon;src:url(./codicon.ttf)}', SHEET_HREF),
		'@font-face{font-family:codicon;src:url(./codicon.ttf)}',
	);

	const root = (globalThis as any).document.createElement('div');
	root.innerHTML = '<span class="katex"><span class="mord mathcal">L</span></span>';
	const families = collectUsedKatexFamilies(root, KATEX_CSS);
	// `.katex` alone pulls in KaTeX_Main; `mathcal` adds Caligraphic; nothing
	// asks for KaTeX_Math.
	assert.deepEqual([...families].sort(), ['KaTeX_Caligraphic', 'KaTeX_Main']);
	assert.deepEqual(katexFontUrlsToEmbed(KATEX_CSS, families), [
		'./KaTeX_Main-Regular.B22Nviop.woff2',
		'./KaTeX_Caligraphic-Regular.woff2',
	]);

	// A face whose bytes could not be read is deleted, not left pointing at a
	// URL that does not exist next to the exported file.
	const withoutBytes = inlineKatexFontFaces(KATEX_CSS, families, new Map());
	assert.doesNotMatch(withoutBytes, /@font-face/);
});

test('an element with no math needs no fonts', () => {
	const root = (globalThis as any).document.createElement('div');
	root.innerHTML = '<p>plain text</p>';
	assert.equal(collectUsedKatexFamilies(root, KATEX_CSS).size, 0);
});

test('the installed KaTeX still gives the exporter fonts it can find', async () => {
	// `KATEX_CSS` above is a slice of katex.min.css frozen at the version it was
	// written against, so it proves the logic and not the coupling. A KaTeX
	// upgrade that renamed `.katex` or the `KaTeX_` family prefix would leave it
	// green while PDF export shipped a document with no maths fonts in it — and
	// 0.18.0 renamed KaTeX's internal classes, so that upgrade is not
	// hypothetical.
	//
	// This asks the installed KaTeX to render, and the installed stylesheet what
	// that rendering needs. Nothing here is written down: rename anything and the
	// intersection empties.
	const katex = ((await import('katex')) as any).default;
	const css = readSource('node_modules/katex/dist/katex.min.css');

	const root = (globalThis as any).document.createElement('div');
	root.innerHTML = katex.renderToString('\\mathcal{L} = \\frac{1}{2}', { throwOnError: false });

	const families = collectUsedKatexFamilies(root, css);
	assert.ok(
		families.size > 0,
		'the installed KaTeX renders markup the installed stylesheet gives no font to; ' +
			'PDF export would embed nothing and the maths would fall back to a UI font',
	);
	assert.ok(
		families.has('KaTeX_Main'),
		`expected the base family among ${[...families].join(', ') || '(none)'}`,
	);
	assert.ok(
		katexFontUrlsToEmbed(css, families).length > 0,
		'families were found but no @font-face src to embed for them',
	);
});
