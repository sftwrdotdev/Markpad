import DOMPurify from 'dompurify';
import {
	fillDiagramTemplate,
	lookupDiagramTemplate,
	storeDiagramTemplate,
	templateDiagramSvg,
} from './diagramCache.js';
import {
	mermaidConfig,
	readDiagramSource,
	readDiagramTheme,
	rememberDiagramSource,
} from './mermaidPrint.js';
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

/**
 * One library, imported the first time a document needs it and kept for the
 * window. `loaded` is the synchronous answer once it has landed, so a pass
 * over a document that needs nothing new does not yield to the event loop.
 * A failed import is not cached: the next render asks again.
 */
function lazyLibrary<T>(load: () => Promise<T>) {
	let promise: Promise<T> | null = null;
	const library = {
		loaded: null as T | null,
		load(): Promise<T> {
			promise ??= load().then(
				(value) => (library.loaded = value),
				(error) => {
					promise = null;
					throw error;
				},
			);
			return promise;
		},
	};
	return library;
}

/**
 * Each library is loaded only when the document holds something it renders,
 * and separately, so a plain-text document loads none of them and code is
 * highlighted without waiting for Mermaid. The preview and the export share
 * these instances, so an export cannot end up with a differently configured
 * KaTeX or a different highlight.js language registry than the preview.
 *
 * highlight.js is its `common` build (~36 languages); any other fenced
 * language is fetched by `loadLanguages` when a block names it.
 */
const highlighter = lazyLibrary(async () => {
	const [hljsModule, svelteModule] = await Promise.all([
		import('highlight.js/lib/common'),
		import('highlightjs-svelte'),
	]);
	const hljs = (hljsModule as any).default;
	try {
		(svelteModule as any).default(hljs);
	} catch (e) {
		console.error('svelte hljs error', e);
	}
	return hljs;
});

const mathLibraries = lazyLibrary(async () => {
	const katex = ((await import('katex')) as any).default;
	// `copy-tex` used to be loaded here too. It installs its own document
	// `copy` listener, which fires only when the selection contains math and
	// rewrites both clipboard flavours from a fragment of its own — undoing
	// the preview's own copy handling for exactly those selections (#674).
	// Its two worthwhile behaviours, whole-formula expansion and TeX as the
	// plain text, are implemented in `utils/previewCopy.ts` instead, where
	// they apply to one copy path rather than a second one.
	// The bare `katex/contrib/…` subpaths, not `katex/dist/contrib/….js`:
	// KaTeX publishes every file twice, `.mjs` behind the `import` condition
	// and `.js` (CommonJS, `require("katex")`) behind `require`. Ask for the
	// `.js` and the bundler hands it the CommonJS copy of KaTeX — a second
	// parser with its own macro table — so mhchem registered `\ce` on a
	// KaTeX the preview never calls, and `$$\ce{…}$$` came out as a parse
	// error (#745). The subpath resolves to the `.mjs`, which imports
	// `../katex.mjs`: the same module `import('katex')` above returned.
	const [autoRenderModule] = await Promise.all([
		import('katex/contrib/auto-render'),
		import('katex/contrib/mhchem'),
	]);
	return { katex, renderMathInElement: (autoRenderModule as any).default };
});

const diagrams = lazyLibrary(async () => ((await import('mermaid')) as any).default);

const LANGUAGE_DIR = '/node_modules/highlight.js/es/languages/';

/**
 * Every highlight.js grammar, as a lazy import per file. A function so the
 * `import.meta.glob` — which only Vite understands — is never evaluated when a
 * test injects its own libraries under `node --test`.
 */
function languageFiles(): Record<string, () => Promise<unknown>> {
	return import.meta.glob(['/node_modules/highlight.js/es/languages/*.js', '!**/*.js.js'], {
		import: 'default',
	});
}

const requestedLanguages = new Set<string>();
let everyLanguage: Promise<unknown> | null = null;

/**
 * Registers the grammars `names` need that the `common` build lacks, or
 * returns null when there are none, so the caller only awaits a real load.
 *
 * A name is first tried as a file name (`dockerfile`). One that is not a file
 * is an alias (`docker`, `ps1`) or no language at all, and only the grammars
 * themselves know their aliases, so every grammar is registered once.
 * ponytail: the alias case loads all ~190 grammars once per window; a static
 * alias table is the upgrade if that shows up. A grammar's `subLanguage` that
 * is not loaded renders as plain text inside it.
 */
function loadLanguages(hljs: any, names: Iterable<string>): Promise<unknown> | null {
	const files = languageFiles();
	const register = async (name: string, load: () => Promise<unknown>) => {
		if (!hljs.getLanguage(name)) hljs.registerLanguage(name, await load());
	};
	const missing = [...names]
		.map((name) => name.toLowerCase())
		.filter((name) => !hljs.getLanguage(name) && !requestedLanguages.has(name));
	if (missing.length === 0) return null;
	for (const name of missing) requestedLanguages.add(name);
	const direct = missing.filter((name) => files[`${LANGUAGE_DIR}${name}.js`]);
	return Promise.all(direct.map((name) => register(name, files[`${LANGUAGE_DIR}${name}.js`]))).then(() => {
		if (missing.every((name) => hljs.getLanguage(name))) return;
		everyLanguage ??= Promise.all(
			Object.entries(files).map(([path, load]) => register(path.slice(LANGUAGE_DIR.length, -3), load)),
		);
		return everyLanguage;
	});
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
	/**
	 * The elements holding processed Markdown. Live or detached, both work.
	 *
	 * A list, not one element, because the preview no longer rebuilds its
	 * article: `blockPatch.ts` replaces the blocks that changed and hands their
	 * new nodes here, so a keystroke typesets one paragraph instead of the
	 * document. The export passes the single detached element it is building.
	 * The roots must not contain one another — each is visited on its own, so a
	 * nested pair would be highlighted, typeset and wrapped twice.
	 */
	roots: HTMLElement[];
	/**
	 * Stand-ins for the real libraries, for tests. Omitted, each library is
	 * imported the first time the roots hold something it renders.
	 */
	libraries?: RichContentLibraries;
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

/**
 * Everything in `root`'s subtree matching `selector`, and `root` itself if it
 * matches.
 *
 * `querySelectorAll` alone was right while the root was the whole article,
 * because a block is never the article. It is wrong for a root that IS a block:
 * a patched-in `<p data-math="display">` would be skipped by its own typesetting
 * pass.
 */
function selfAndDescendants(root: HTMLElement, selector: string): Element[] {
	const matches: Element[] = root.matches(selector) ? [root] : [];
	matches.push(...root.querySelectorAll(selector));
	return matches;
}

export async function renderRichContent(options: RenderRichContentOptions): Promise<void> {
	const { roots, libraries } = options;
	if (roots.length === 0) return;

	const doc = roots[0].ownerDocument ?? document;
	const idFactory = options.idFactory ?? defaultIdFactory;

	const codeBlocks = roots.flatMap((root) => selfAndDescendants(root, 'pre code'));
	const isDiagram = (block: Element) => block.classList.contains('language-mermaid');
	const languageOf = (block: Element) =>
		Array.from(block.classList).find((c) => c.startsWith('language-'))?.replace('language-', '') ?? '';

	/**
	 * Diagrams already on screen that were drawn for a different theme.
	 *
	 * Mermaid bakes its colours into the SVG, so a theme change has to draw them
	 * again — and until this existed, nothing did. The loop below finds diagrams
	 * by `pre code`, and a diagram that has been drawn once has no `<pre>` left:
	 * this function replaced it with the `.mermaid-diagram` container. While the
	 * preview was `{@html sanitizedHtml}` that was invisible, because every
	 * render put the whole document back as source; `blockPatch.ts` keeps the
	 * enriched nodes instead, so from #632 on a theme change reached no diagram
	 * at all, in any mode. The source is on the container already —
	 * `mermaidPrint.ts` keeps it there so the PDF path can rebuild the diagram
	 * with a light theme — and the theme it was drawn for is kept beside it.
	 *
	 * Collected BEFORE the loop, so the containers the loop is about to build
	 * are not scanned as if they were stale. On the keystroke path the roots are
	 * the blocks the patch just inserted, which are freshly parsed markup with
	 * no rendered diagram in them, so this is one selector that matches nothing.
	 *
	 * What a theme change costs, measured in Chromium over the real pipeline
	 * (comrak -> `processMarkdownHtml` -> `sanitizeMarkdownHtml` -> `blockPatch`
	 * -> here) in a 1000x800 preview box, as one whole-article
	 * `renderRichContent` with highlight.js and the display-maths memo already
	 * warm, two runs:
	 *
	 *                                 diagrams   theme moved   theme unchanged
	 *     samples/katex-stress.md            0    8.6-10.6ms       11.9-12.2ms
	 *     samples/markdown-syntax.md         4   61.2-76.1ms         2.6-3.0ms
	 *     samples/stress-test.md             3  107.5-121.2ms      12.5-12.8ms
	 *
	 * So the diagrams are the whole of it: katex-stress has none and its two
	 * columns are the same number, which is `renderMathInElement` scanning a
	 * document with no memo behind it. Toggling back to a theme the diagram
	 * cache has already seen costs 9.8-30.1ms rather than the figures above.
	 * The right-hand column is what a mode toggle used to pay for nothing —
	 * the theme effect re-ran on every one of them, drawing no diagram because
	 * it could not find any.
	 */
	const staleDiagrams = roots
		.flatMap((root) => selfAndDescendants(root, '.mermaid-diagram'))
		.filter(
			(container) =>
				readDiagramSource(container) !== null &&
				readDiagramTheme(container) !== options.mermaidTheme,
		);

	// Highlighting first: it is the lightest library and the most common need,
	// so code is coloured without waiting for KaTeX or Mermaid to load.
	const languages = new Set(codeBlocks.filter((block) => !isDiagram(block)).map(languageOf).filter(Boolean));
	let hljs = libraries ? libraries.hljs : highlighter.loaded;
	if (!libraries && languages.size > 0) {
		try {
			hljs ??= await highlighter.load();
			const pending = loadLanguages(hljs, languages);
			if (pending) await pending;
		} catch (error) {
			options.onError?.(error);
			console.error('Failed to load highlight.js:', error);
		}
	}
	for (const block of codeBlocks) {
		if (isDiagram(block)) continue;
		const codeEl = block as HTMLElement;
		const preEl = codeEl.parentElement as HTMLPreElement;
		const language = languageOf(codeEl);

		// Only highlight if explicit language is specified, and only if it names a
		// grammar highlight.js has. `highlightElement` used to decide that itself:
		// for an unknown language its `blockLanguage` falls back to "no-highlight"
		// and it returns having touched nothing. `hljs.highlight` instead throws,
		// so the same question has to be asked out here — and asking it is also
		// what keeps a fenced `admonition` block from throwing an exception on
		// every keystroke, since a throw is the one result the memo cannot store.
		if (language && hljs?.getLanguage(language)) {
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

			if (language) {
				label.textContent = language;
			} else {
				label.innerHTML = COPY_ICON_SVG;
			}
			wrapper.appendChild(label);
		}
	}

	// KaTeX only when there is math: a `data-math` block, or the `\(`/`\[`
	// delimiters `processMarkdownHtml` mints (MATH_DELIMITERS). `textContent`
	// also sees code, so a regex in a code block loads KaTeX for nothing — the
	// auto-renderer skips `<pre>`/`<code>` either way.
	const mathElements = roots.flatMap((root) => selfAndDescendants(root, '[data-math]'));
	const hasDelimiters = roots.some((root) => /\\[([]/.test(root.textContent ?? ''));
	let math = libraries ?? mathLibraries.loaded;
	if (!libraries && !math && (mathElements.length > 0 || hasDelimiters)) {
		try {
			math = await mathLibraries.load();
		} catch (error) {
			options.onError?.(error);
			console.error('Failed to load KaTeX:', error);
		}
	}
	const katex = math?.katex;
	const renderMathInElement = math?.renderMathInElement;

	if (katex) {
		for (const el of mathElements) {
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

	// The one pass with no memo behind it (see #614: there is no seam to
	// memoise without re-implementing KaTeX's delimiter scanner), so it is also
	// the one that gains most from being handed a paragraph instead of a
	// document. Per root, because the scanner walks a subtree.
	if (renderMathInElement && hasDelimiters) {
		for (const root of roots) {
			renderMathInElement(root, {
				delimiters: MATH_DELIMITERS,
				throwOnError: false,
			});
		}
	}

	// The config itself lives in `mermaidPrint.ts` — `initialize` replaces the
	// site config rather than merging into it, so the two callers that write to
	// this singleton have to send the same keys or the last one wins. See
	// `mermaidConfig` for what `htmlLabels: false` is buying.
	//
	// Only when there is something to draw: `initialize` builds and installs
	// a site config, which measures at ~2.5ms in Chromium, and this function runs
	// once per keystroke. A document with no diagram in it was paying that on
	// every character. Asking first is one selector over a list already in hand.
	// Configuring per pass, rather than remembering the last theme, is
	// deliberate — `mermaidPrint.ts` reconfigures the same singleton to print a
	// diagram on paper and configures it back, so a remembered theme here would
	// be a claim about a global another module also writes to.
	const diagramBlocks = codeBlocks.filter(isDiagram);
	if (diagramBlocks.length === 0 && staleDiagrams.length === 0) return;
	let mermaid = libraries ? libraries.mermaid : diagrams.loaded;
	try {
		mermaid ??= await diagrams.load();
	} catch (error) {
		// The blocks stay as source; the next render asks again.
		options.onError?.(error);
		console.error('Failed to load Mermaid:', error);
		return;
	}
	mermaid.initialize(mermaidConfig(options.mermaidTheme));

	let diagramIndex = 0;

	/**
	 * The drawing itself, shared by the two callers below so a re-coloured
	 * diagram is memoised, sanitized and identified exactly like a fresh one.
	 *
	 * The cache holds a *template* rather than the SVG: the id is stamped into
	 * it, so a reused diagram is as uniquely identified as a fresh one. See
	 * `diagramCache.ts` for why that is the whole difficulty.
	 */
	const drawDiagram = async (source: string, svgId: string): Promise<string> => {
		const cached = lookupDiagramTemplate(source, options.mermaidTheme);
		if (cached !== null) return fillDiagramTemplate(cached, svgId);
		const { svg } = await mermaid.render(svgId, source);
		// A source that contains the render id would have its own text rewritten
		// by the substitution, so that one is left uncached.
		if (!source.includes(svgId)) {
			const template = templateDiagramSvg(svg, svgId);
			if (template !== null) storeDiagramTemplate(source, options.mermaidTheme, template);
		}
		return svg;
	};

	for (const container of staleDiagrams) {
		const source = readDiagramSource(container) as string;
		try {
			container.innerHTML = sanitizeDiagramSvg(await drawDiagram(source, idFactory(diagramIndex++)));
			rememberDiagramSource(container, source, options.mermaidTheme);
		} catch (error) {
			// A diagram that fails to draw keeps the rendering it has. A diagram
			// in the previous theme's colours still beats an empty box, which is
			// the same call `renderDiagramsForPrint` makes.
			options.onError?.(error);
			console.error('Failed to re-render Mermaid diagram for the new theme:', error);
		}
	}
	for (const block of diagramBlocks) {
		const codeEl = block as HTMLElement;
		const preEl = codeEl.parentElement as HTMLPreElement;
		const mermaidCode = codeEl.textContent || '';
		try {
			const svg = await drawDiagram(mermaidCode, idFactory(diagramIndex++));

			const container = doc.createElement('div');
			container.className = 'mermaid-diagram';
			carrySourcepos(preEl, container);
			// Kept so the PDF path can rebuild the diagram with a light theme
			// instead of recolouring Mermaid's output.
			rememberDiagramSource(container, mermaidCode, options.mermaidTheme);
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
	}
}
