/**
 * A memo for the two halves of `renderRichContent` that are pure functions of
 * their input: a KaTeX formula and a highlighted code block.
 *
 * Why this exists is the same reason `diagramCache.ts` exists, and the numbers
 * are the ones the debounce could not hide. The preview re-renders the whole
 * article on every keystroke — in split mode, and in edit mode with the TOC
 * open — and `{@html sanitizedHtml}` puts every formula and every code block
 * back as source, so both libraries ran over the whole document again for one
 * typed character. Measured in Chromium on `samples/katex-stress.md` (21
 * display formulas, 31 inline), one pass through `renderRichContent` was
 * 32–45ms, of which the `[data-math]` loop alone was ~20ms. `diagramCache.ts`
 * had already taken Mermaid out of that figure; it does nothing for a document
 * whose maths is the expensive part.
 *
 * ## Why this is the easy version of `diagramCache.ts`
 *
 * That module cannot hand back the bytes it stored: Mermaid bakes the render id
 * it was given into the SVG's `<style>` selectors and markers, so a reused
 * diagram has to be re-identified, and most of that file is about proving when
 * that is safe. Neither library here has anything of the kind.
 * `katex.renderToString(source, { displayMode })` and
 * `hljs.highlight(code, { language })` are functions of their arguments and
 * nothing else — no ids, no counters, no document — so the cached string is
 * simply the answer, and the key is simply the arguments.
 *
 * That is also why the render sites moved to the string-returning entry points.
 * `katex.render(source, el)` and `hljs.highlightElement(el)` take an element
 * and there is no result to keep; `renderToString` / `highlight` return exactly
 * what the cache stores, and the call site assigns it.
 *
 * ## What is deliberately not in here
 *
 * Inline maths (`$x$`, which `markdown.ts` mints as `\(x\)`) is rendered by
 * KaTeX's own `renderMathInElement`, which walks the tree and calls its own
 * bundled KaTeX. There is no seam to memoise without either re-implementing its
 * delimiter scanner — the thing `mathDelimiterContract.test.ts` exists to keep
 * honest — or monkey-patching a library's method. So inline maths still costs
 * what it always did; on the stress document that is ~11ms of the pass.
 */

/**
 * Upper bounds, in the spirit of `diagramCache.ts`: the memo outlives a
 * document and a tab, because the preview keeps rendering into the same window
 * as the user switches files, so it needs a ceiling that does not depend on
 * anyone remembering to clear it.
 *
 * 2M characters is roughly 4MB of UTF-16, the same budget the diagram cache
 * carries. Rendered KaTeX is verbose — a display formula from
 * `samples/katex-stress.md` comes out at 2–8k characters — so the character
 * bound is the one that usually bites, and 512 entries is there for the
 * documents made of hundreds of tiny `$a_i$`-sized fragments, where the entry
 * count runs out first. Between them they hold a stress document and the one
 * the user was looking at before it.
 */
const MAX_ENTRIES = 512;
const MAX_CHARS = 2_000_000;

/**
 * Insertion order is the eviction order, and a hit re-inserts, which makes this
 * an LRU without a second data structure.
 */
const rendered = new Map<string, string>();
let cachedChars = 0;

function memo(key: string, render: () => string): string {
	const hit = rendered.get(key);
	if (hit !== undefined) {
		rendered.delete(key);
		rendered.set(key, hit);
		return hit;
	}

	// A throw propagates to the caller's own try/catch and nothing is stored: a
	// formula that failed to render must be retried, not remembered as an error.
	const html = render();

	// A single entry that would evict everything else is not worth caching.
	if (html.length > MAX_CHARS / 4) return html;

	rendered.set(key, html);
	cachedChars += html.length;

	for (const [oldest, value] of rendered) {
		if (rendered.size <= MAX_ENTRIES && cachedChars <= MAX_CHARS) break;
		if (oldest === key) break; // never evict what was just asked for
		rendered.delete(oldest);
		cachedChars -= value.length;
	}

	return html;
}

/**
 * KaTeX output for one formula. `displayMode` is the only other input KaTeX is
 * given at the call site, and the same source typeset both ways is two
 * different drawings, so it is part of the key.
 */
export function renderedMath(source: string, displayMode: boolean, render: () => string): string {
	return memo(`math:${displayMode ? 'd' : 'i'}:${source}`, render);
}

/**
 * Highlighted markup for one code block. The language is length-prefixed so a
 * language name that happens to be a prefix of the code cannot collide with a
 * shorter name followed by different code — the same trick `diagramCache.ts`
 * uses for the theme. The two families are separated by their own prefixes,
 * which are the same length, so no `math:` key can spell a `code:` one.
 */
export function highlightedCode(language: string, code: string, render: () => string): string {
	return memo(`code:${language.length}:${language}${code}`, render);
}

/**
 * Test seam, like `resetDiagramCache`: the memo is module-level and therefore
 * process-wide, while a test wants to start from empty.
 */
export function resetRichContentCache(): void {
	rendered.clear();
	cachedChars = 0;
}
