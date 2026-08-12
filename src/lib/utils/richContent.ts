import DOMPurify from 'dompurify';
import {
	fillDiagramTemplate,
	lookupDiagramTemplate,
	storeDiagramTemplate,
	templateDiagramSvg,
} from './diagramCache.js';
import { rememberDiagramSource } from './mermaidPrint.js';
import { highlightedCode, renderedMath } from './richContentCache.js';

/**
 * The one implementation of "turn rendered Markdown into the thing the user
 * actually wants to look at": syntax highlighting, KaTeX, Mermaid diagrams.
 *
 * It used to live inside `MarkdownViewer.svelte`, closed over the component's
 * lazily imported libraries and the live preview element, and could therefore
 * only ever run on screen. The HTML export ran the same
 * `render_markdown → sanitize → processMarkdownHtml` pipeline and then stopped,
 * so an exported document arrived with `E = mc^2` as literal LaTeX, code blocks
 * with no highlighting, and diagrams as `<pre><code class="language-mermaid">`
 * source. The thing the export exists for — handing the document to somebody
 * who does not have Markpad — was exactly the case that got the raw text.
 *
 * There was a second copy of this in `markdown.ts` once. It drifted (it had
 * lost `rememberDiagramSource`, which the PDF path needs) and was deleted in
 * #397. So the fix is not another copy: it is this module, which the preview and
 * the export both call, on a live element and on a detached one respectively.
 * Nothing here reaches for a global element or a global document — everything
 * comes from `root` — because a detached `<div>` is a first-class caller.
 */

/**
 * The delimiters KaTeX's auto-renderer is allowed to look for.
 *
 * Every one of them is a spelling CommonMark cannot produce. That is the whole
 * specification: this scanner runs over comrak's *output*, where an explicitly
 * escaped `\$\$x\$\$` and a real `$$x$$` are the same eight bytes, so any
 * `$`-based entry here silently overrules the reader. `$$` used to be in this
 * list, and a `\$\$…\$\$` written to mean "I want literal dollar signs" came
 * out typeset.
 *
 * `\(` and `\[` reach this point only because `processMarkdownHtml` mints
 * them — comrak eats a user-typed `\(` long before the preview exists. So the
 * set rendered here is exactly the set `src/lib/utils/markdown.ts` decided on,
 * and that set is what scripts/mathDelimiterContract.test.ts holds against the
 * backend's. Adding a delimiter Markdown *can* spell reopens the gap.
 */
export const MATH_DELIMITERS = [
	{ left: '\\(', right: '\\)', display: false },
	{ left: '\\[', right: '\\]', display: true },
];

export interface RichContentLibraries {
	hljs: any;
	katex: any;
	renderMathInElement: any;
	mermaid: any;
}

let librariesPromise: Promise<RichContentLibraries> | null = null;

/**
 * Loads highlight.js, KaTeX and Mermaid once per window.
 *
 * The preview kicks this off on mount; the export awaits the same promise, so
 * an export never pays for a second copy and — more to the point — cannot end
 * up with a differently configured KaTeX or a different highlight.js language
 * registry than the preview the user was just looking at.
 */
export function loadRichContentLibraries(): Promise<RichContentLibraries> {
	if (librariesPromise) return librariesPromise;
	librariesPromise = (async () => {
		const [hljsModule, svelteModule, katexMainModule, mermaidModule] = await Promise.all([
			import('highlight.js'),
			import('highlightjs-svelte'),
			import('katex'),
			import('mermaid'),
		]);

		const hljs = (hljsModule as any).default;
		try {
			(svelteModule as any).default(hljs);
		} catch (e) {
			console.error('svelte hljs error', e);
		}

		const katex = (katexMainModule as any).default;
		// mhchem and copy-tex are KaTeX extensions that bind to the global.
		(window as any).katex = katex;

		const [autoRenderModule] = await Promise.all([
			import('katex/dist/contrib/auto-render.js'),
			import('katex/dist/contrib/mhchem.js'),
			import('katex/dist/contrib/copy-tex.js'),
		]);

		return {
			hljs,
			katex,
			renderMathInElement: (autoRenderModule as any).default,
			mermaid: (mermaidModule as any).default,
		};
	})().catch((error) => {
		// A failed load must not be cached as a permanent failure: the preview
		// retries on the next render, and the export falls back to shipping the
		// unrendered block rather than nothing at all.
		librariesPromise = null;
		throw error;
	});
	return librariesPromise;
}

/**
 * Mermaid ships the diagram's colours as a `<style>` element inside the SVG, so
 * diagrams need a different filter from the document-level
 * `MARKDOWN_SANITIZE_CONFIG` (which forbids `<style>` outright). Keeping the two
 * policies distinct — and this one in one place — is what stops a document
 * author's `<style>` from being let through by the back door: this filter is
 * only ever applied to a string Mermaid produced, never to the document.
 *
 * `foreignObject` used to be on this allowlist as well, on the theory that
 * Mermaid needs it for labels. It never worked. The tag was allowed, but the
 * label lives in the *HTML* inside it, and DOMPurify removes every HTML child of
 * an SVG element whose tag is not an HTML integration point — `annotation-xml`
 * is the only one on its list, so `foreignObject`'s children are deleted no
 * matter what `ADD_TAGS` says. Allowing the tag could therefore only ever
 * produce an empty box. Worse, Mermaid's `<switch>`-based renderers (the user
 * journey, and anything configured with `textPlacement: 'fo'`) pair the
 * `foreignObject` with an SVG `<text>` fallback: an empty-but-present
 * `foreignObject` is what the browser picks, so keeping it *hid* a label that
 * had survived intact. `renderRichContent` now asks Mermaid for SVG-native
 * labels, and this filter no longer names the tag. See
 * scripts/mermaidDiagramLabels.test.ts.
 *
 * On why that `<style>` is acceptable inside an exported file, see
 * `renderExportRichContent` in `export.ts`.
 */
export function sanitizeDiagramSvg(svg: string): string {
	return DOMPurify.sanitize(svg, {
		ADD_ATTR: ['dominant-baseline', 'text-anchor'],
	});
}

export interface RenderRichContentOptions {
	/** The element holding processed Markdown. Live or detached, both work. */
	root: HTMLElement;
	libraries: RichContentLibraries;
	/** Mermaid's own theme name, from `resolveMermaidTheme`. */
	mermaidTheme: string;
	/**
	 * Wires the language label up as a copy button. Omitted by the export: an
	 * exported file cannot run script at all (its policy grants no script
	 * privilege), so a handler there would be a button that does nothing.
	 */
	onCopyCode?: (code: string, label: HTMLElement) => void;
	/** Injected so diagram ids are deterministic under test. */
	idFactory?: (index: number) => string;
	onError?: (error: unknown) => void;
}

function defaultIdFactory(index: number): string {
	return `mermaid-${Date.now()}-${index}-${Math.floor(Math.random() * 10000)}`;
}

/**
 * A rendered diagram stands in for the `<pre>` it replaced, so it has to
 * inherit that block's source range.
 *
 * Without it a diagram is the one thing in the preview that maps to no source
 * line at all — not even through a descendant, because the whole subtree is
 * replaced by Mermaid's SVG. Both halves of scroll sync then treat several
 * hundred pixels of preview as belonging to whatever block is nearest, and the
 * panes disagree by the height of the diagram for as long as it is on screen.
 *
 * Exported because `processMarkdownHtml` replaces elements the same way — an
 * `<img>` whose src is a video or audio file becomes a fresh `<video>` /
 * `<audio>`, a YouTube `<img>`/`<a>` becomes a thumbnail link — and the same
 * gap costs the same thing there.
 */
export function carrySourcepos(from: Element, to: Element) {
	const sourcepos = from.getAttribute('data-sourcepos');
	if (sourcepos) to.setAttribute('data-sourcepos', sourcepos);
}

const COPY_ICON_SVG =
	'<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>';

export async function renderRichContent(options: RenderRichContentOptions): Promise<void> {
	const { root, libraries } = options;
	if (!root) return;

	const { hljs, katex, renderMathInElement, mermaid } = libraries;
	if (!hljs || !renderMathInElement || !mermaid) return;

	const doc = root.ownerDocument ?? document;
	const idFactory = options.idFactory ?? defaultIdFactory;

	const codeBlocks = Array.from(root.querySelectorAll('pre code'));

	// `htmlLabels: false` is what keeps a diagram's text in the picture. With
	// Mermaid's default (`true`) every label is an HTML `<div>`/`<span>` inside a
	// `<foreignObject>`, and `sanitizeDiagramSvg` — like any DOMPurify — deletes
	// HTML children of SVG elements outright, so the diagrams arrived as empty
	// shapes. Turning it off makes Mermaid emit SVG `<text>`, which no sanitizer
	// objects to. Measured against mermaid 11.16.0: this one root-level key is
	// enough for every diagram type it ships (the per-diagram `htmlLabels` keys
	// are deprecated in 11.x and the root one takes precedence over them).
	//
	// Only when there is something to draw: `initialize` deep-merges and installs
	// a site config, which measures at ~2.5ms in Chromium, and this function runs
	// once per keystroke. A document with no diagram in it was paying that on
	// every character. Asking first is one selector over a list already in hand.
	// Configuring per pass, rather than remembering the last theme, is
	// deliberate — `mermaidPrint.ts` reconfigures the same singleton to print a
	// diagram on paper and configures it back, so a remembered theme here would
	// be a claim about a global another module also writes to.
	const hasDiagram = codeBlocks.some((block) => block.classList.contains('language-mermaid'));
	if (hasDiagram) {
		mermaid.initialize({ startOnLoad: false, theme: options.mermaidTheme, htmlLabels: false });
	}

	let diagramIndex = 0;
	for (const block of codeBlocks) {
		const codeEl = block as HTMLElement;
		const preEl = codeEl.parentElement as HTMLPreElement;

		if (codeEl.classList.contains('language-mermaid')) {
			const mermaidCode = codeEl.textContent || '';
			try {
				// The preview re-renders the whole article roughly once per keystroke
				// and `{@html}` puts every diagram's source back, so drawing is the
				// one step worth remembering between passes. The cache holds a
				// *template* rather than the SVG: the id below is stamped into it, so
				// a reused diagram is as uniquely identified as a fresh one. See
				// `diagramCache.ts` for why that is the whole difficulty.
				const svgId = idFactory(diagramIndex++);
				const cached = lookupDiagramTemplate(mermaidCode, options.mermaidTheme);
				let svg: string;
				if (cached !== null) {
					svg = fillDiagramTemplate(cached, svgId);
				} else {
					svg = (await mermaid.render(svgId, mermaidCode)).svg;
					// A source that contains the render id would have its own text
					// rewritten by the substitution, so that one is left uncached.
					if (!mermaidCode.includes(svgId)) {
						const template = templateDiagramSvg(svg, svgId);
						if (template !== null) storeDiagramTemplate(mermaidCode, options.mermaidTheme, template);
					}
				}

				const container = doc.createElement('div');
				container.className = 'mermaid-diagram';
				carrySourcepos(preEl, container);
				// Kept so the PDF path can rebuild the diagram with a light theme
				// instead of recolouring Mermaid's output.
				rememberDiagramSource(container, mermaidCode);
				container.innerHTML = sanitizeDiagramSvg(svg);
				preEl.replaceWith(container);
			} catch (error) {
				options.onError?.(error);
				console.error('Failed to render Mermaid diagram:', error);
				const errorDiv = doc.createElement('div');
				errorDiv.className = 'mermaid-error';
				carrySourcepos(preEl, errorDiv);
				errorDiv.style.color = 'red';
				errorDiv.style.padding = '1em';
				errorDiv.textContent = `Error rendering Mermaid diagram: ${error}`;
				preEl.replaceWith(errorDiv);
			}
			continue; // Skip highlight.js for this block
		}

		// Check if language was explicitly specified BEFORE highlight.js runs
		const langClass = Array.from(codeEl.classList).find((c) => c.startsWith('language-'));
		const hasExplicitLang = langClass !== undefined;
		const language = langClass?.replace('language-', '') ?? '';

		// Only highlight if explicit language is specified, and only if it names a
		// grammar highlight.js has. `highlightElement` used to decide that itself:
		// for an unknown language its `blockLanguage` falls back to "no-highlight"
		// and it returns having touched nothing. `hljs.highlight` instead throws,
		// so the same question has to be asked out here — and asking it is also
		// what keeps a fenced `admonition` block from throwing an exception on
		// every keystroke, since a throw is the one result the memo cannot store.
		if (language && hljs.getLanguage(language)) {
			try {
				// `hljs.highlight(code, …)` rather than `hljs.highlightElement(el)`:
				// the element form has no result to keep, and this pass runs over
				// every block in the document on every keystroke. What the element
				// form did around the highlighting itself is done here — the `hljs`
				// class the stylesheet's rules hang off, and nothing else. It also
				// added the canonical `language-<name>` for an alias
				// (`language-js` → `language-javascript`); no stylesheet, export or
				// test reads that class, and the label below deliberately shows the
				// name the author wrote.
				const code = codeEl.textContent || '';
				codeEl.innerHTML = highlightedCode(language, code, () =>
					hljs.highlight(code, { language, ignoreIllegals: true }).value,
				);
				codeEl.classList.add('hljs');
			} catch (error) {
				options.onError?.(error);
				console.error('Failed to highlight code block:', error);
			}
		}

		if (preEl && preEl.tagName === 'PRE') {
			preEl.querySelectorAll('.lang-label').forEach((l) => l.remove());
			const codeContent = codeEl.textContent || '';
			const existingWrapper = preEl.parentElement?.classList.contains('code-block-shell')
				? (preEl.parentElement as HTMLDivElement)
				: null;
			existingWrapper?.querySelectorAll(':scope > .lang-label').forEach((l) => l.remove());

			const wrapper = existingWrapper ?? doc.createElement('div');
			if (!existingWrapper) {
				wrapper.className = 'code-block-shell';
				preEl.replaceWith(wrapper);
				wrapper.appendChild(preEl);
			}

			const label = doc.createElement('button');
			label.className = 'lang-label';
			label.title = 'Click to copy code';
			const onCopyCode = options.onCopyCode;
			if (onCopyCode) label.onclick = () => onCopyCode(codeContent, label);

			if (hasExplicitLang && langClass) {
				label.textContent = langClass.replace('language-', '');
			} else {
				label.innerHTML = COPY_ICON_SVG;
			}
			wrapper.appendChild(label);
		}
	}

	// KaTeX math rendering
	if (katex) {
		const mathElements = root.querySelectorAll('[data-math]');
		for (const el of Array.from(mathElements)) {
			const isDisplay = el.getAttribute('data-math') === 'display';
			const mathSource = el.getAttribute('data-math-source') || el.textContent || '';
			try {
				// `renderToString` rather than `render`, for the memo: the string is
				// the whole result, and typing a character somewhere else in the
				// document leaves every formula's source exactly as it was.
				el.innerHTML = renderedMath(mathSource, isDisplay, () =>
					katex.renderToString(mathSource, {
						displayMode: isDisplay,
						throwOnError: false,
					}),
				);
			} catch (e) {
				options.onError?.(e);
				console.error('KaTeX rendering error:', e);
			}
		}
	}

	if (renderMathInElement) {
		renderMathInElement(root, {
			delimiters: MATH_DELIMITERS,
			throwOnError: false,
		});
	}
}
