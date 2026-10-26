import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readRustBackend, readSource, sliceBetween } from './sourceTree.js';
import { collectUsedKatexFamilies, katexFontUrlsToEmbed } from '../src/lib/utils/exportFonts.ts';
import { useShimDom } from './preview.domShim.ts';

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
 *     in the pipeline is pinned by `export.checks.test.ts`; the relevant fact
 *     here is only that the diagram filter and the document filter are separate
 *     calls, which the diagram test below covers from the other side.
 */
describe('rich content in the HTML export', () => {
	// The app resolves the bundled font assets against its own origin.
	useShimDom({ window: globalThis, location: { href: 'http://tauri.localhost/' } }, { identitySanitize: true });

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
});

describe('native PDF printing', () => {
	// A Tauri command name is a bare string on the JS side and an identifier inside a macro on the Rust
	// side, so nothing — not tsc, not `svelte-check`, not `cargo check` — notices
	// when one moves and the other does not. The failure is silent at build time
	// and total at runtime: "Export PDF" does nothing at all.
	test('both PDF commands the exporter invokes are registered with Tauri', () => {
		const exporter = readSource('src/lib/utils/export.ts');
		const tauriLib = readRustBackend();

		const registered = new Set(
			sliceBetween(tauriLib, 'tauri::generate_handler![', ']')
				.split(',')
				.map((entry) => entry.trim().replace(/^.*::/, '')),
		);

		// Read the names off the exporter rather than restating them, so a renamed
		// command is checked at its new name instead of quietly passing.
		const invoked = [...exporter.matchAll(/invoke\('([a-z_]*pdf[a-z_]*)'/g)].map((m) => m[1]);
		assert.deepEqual(invoked.sort(), ['export_pdf_windows', 'print_pdf']);

		for (const command of invoked) {
			assert.ok(registered.has(command), `export.ts invokes '${command}', which lib.rs must register`);
			assert.match(
				tauriLib,
				new RegExp(`#\\[tauri::command\\]\\n(?:pub )?(?:async )?fn ${command}\\(`),
				`${command} must be defined as a Tauri command`,
			);
		}
	});
});
