import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import DOMPurify from 'dompurify';
import { renderRichContent } from '../src/lib/utils/richContent.ts';
import { fillDiagramTemplate, resetDiagramCache, templateDiagramSvg } from '../src/lib/utils/diagramCache.ts';
import { parseHtml, type ShimElement } from './renderProtocolDom.ts';
import { resetRichContentCache } from '../src/lib/utils/richContentCache.ts';
import { MERMAID_PRINT_THEME } from '../src/lib/utils/mermaidPrint.ts';
import { readSource } from './sourceTree.js';
import { useShimDom } from './preview.domShim.ts';

/**
 * The preview re-renders the whole article on a 16ms debounce — in split mode,
 * and in edit mode with the TOC open, that is about once per keystroke — and
 * `{@html sanitizedHtml}` swaps the entire block, which puts every
 * `<pre><code class="language-mermaid">` back. So every diagram was redrawn from
 * scratch on every keystroke. Measured in a headless browser on a document with
 * 44 diagrams and 132 code blocks, one pass cost 2.2–2.5s, of which
 * `mermaid.render` was all but ~30ms.
 *
 * These tests pin the two halves of the fix that can go wrong quietly:
 *
 *   - The *cache*: what must miss (a changed character, a changed theme) and
 *     what the bounds are. A memo that never misses is a correctness bug and a
 *     memo that never evicts is a leak; neither shows up as a failure on screen.
 *   - The *re-identification*: Mermaid bakes the id it is handed into the
 *     diagram's `<style>` selectors, its markers and the `url(#…)` that point at
 *     them, so a reused SVG has to be stamped with a fresh id. Two copies of one
 *     diagram sharing an id is the failure mode that looks fine on screen right
 *     up until a marker or a style rule resolves against the wrong diagram.
 *
 * Mermaid itself is stood in for at the library boundary — the same seam the
 * export tests use — because the real one needs layout to size a node. What the
 * fake reproduces is the id scheme, which is the part this code depends on, and
 * which was read off real Mermaid 11 output: every id and every `url(#…)`
 * carries the svg id, *except* sequence diagrams, whose actor groups are
 * numbered from a module counter (`actor44`, `root-44`) and are referenced by
 * nothing.
 */
describe('diagram cache', () => {
	useShimDom({ window: globalThis }, { identitySanitize: true });

	// ---------------------------------------------------------------- fixtures

	interface Recorder {
		renders: Array<{ id: string; source: string; theme: string }>;
		themes: string[];
	}

	/**
	 * The id scheme of real Mermaid output: the svg id prefixes the style block's
	 * selectors, the arrow marker and the reference to it.
	 */
	function svgFor(id: string, source: string, theme: string, extra = ''): string {
		return (
			`<svg id="${id}" role="graphics-document">` +
			`<style>#${id} .node rect{fill:${theme === 'dark' ? '#333' : '#eee'};}</style>` +
			`<defs><marker id="${id}_flowchart-pointEnd"></marker></defs>` +
			`<path marker-end="url(#${id}_flowchart-pointEnd)"></path>` +
			extra +
			`<foreignObject><div>${source.trim()}</div></foreignObject>` +
			`</svg>`
		);
	}

	function libraries(record: Recorder, extraFor: (source: string, id: string) => string = () => '') {
		let theme = 'neutral';
		return {
			hljs: { getLanguage: () => null },
			// The renderer refuses to run without these; the diagrams are what is
			// under test, so they do nothing.
			katex: { renderToString: () => '' },
			renderMathInElement() {},
			mermaid: {
				initialize(config: { theme: string }) {
					theme = config.theme;
					record.themes.push(config.theme);
				},
				async render(id: string, source: string) {
					record.renders.push({ id, source, theme });
					return { svg: svgFor(id, source, theme, extraFor(source, id)) };
				},
			},
		};
	}

	function articleWith(...sources: string[]): string {
		return sources
			.map((source) => `<pre><code class="language-mermaid">${source}</code></pre>`)
			.join('\n');
	}

	function newRecorder(): Recorder {
		return { renders: [], themes: [] };
	}

	let idCounter = 0;

	/** Unique per call, like the real one, and readable in a failure message. */
	function ids(): (index: number) => string {
		const run = idCounter++;
		return (index: number) => `mermaid-${run}-${index}`;
	}

	async function render(
		html: string,
		options: { record: Recorder; theme?: string; extraFor?: (source: string, id: string) => string },
	): Promise<any> {
		const root = (globalThis as any).document.createElement('div');
		root.innerHTML = html;
		await renderRichContent({
			roots: [root],
			libraries: libraries(options.record, options.extraFor) as any,
			mermaidTheme: options.theme ?? 'neutral',
			idFactory: ids(),
		});
		return root;
	}

	function idsIn(html: string): string[] {
		return [...html.matchAll(/\sid="([^"]*)"/g)].map((match) => match[1]);
	}

	// ------------------------------------------------------------------- tests

	test('a second pass over the same document draws nothing again', async () => {
		resetDiagramCache();
		const article = articleWith('graph TD; A-->B;', 'graph LR; C-->D;');

		const first = newRecorder();
		const before = await render(article, { record: first });
		assert.equal(first.renders.length, 2);

		const second = newRecorder();
		const after = await render(article, { record: second });
		assert.deepEqual(second.renders, [], 'the second pass must not call mermaid.render at all');

		// Same drawing, not just the same count: identifiers aside, the reused SVG
		// is what Mermaid produced.
		const normalise = (html: string) =>
			html
				.replace(/\sid="[^"]*"/g, ' id="X"')
				.replace(/url\(#[^)]*\)/g, 'url(#X)')
				.replace(/#mermaid-[\w-]*/g, '#X');
		assert.equal(normalise(after.innerHTML), normalise(before.innerHTML));
	});

	test('changing one character of a diagram redraws it', async () => {
		resetDiagramCache();
		const warm = newRecorder();
		await render(articleWith('graph TD; A-->B;'), { record: warm });

		const typed = newRecorder();
		await render(articleWith('graph TD; A-->Bc;'), { record: typed });
		assert.deepEqual(
			typed.renders.map((call) => call.source),
			['graph TD; A-->Bc;'],
		);
	});

	test('changing the theme redraws every diagram, and the old theme is still warm', async () => {
		resetDiagramCache();
		const source = 'graph TD; Theme-->Switch;';

		const light = newRecorder();
		const lightRoot = await render(articleWith(source), { record: light, theme: 'neutral' });
		assert.equal(light.renders.length, 1);
		assert.match(lightRoot.innerHTML, /fill:#eee/);

		const dark = newRecorder();
		const darkRoot = await render(articleWith(source), { record: dark, theme: 'dark' });
		assert.equal(dark.renders.length, 1, 'a theme switch must not reuse the other theme’s colours');
		assert.match(darkRoot.innerHTML, /fill:#333/);

		// Switching back is a hit: both themes live in the cache at once, so a user
		// toggling appearance does not pay twice.
		const back = newRecorder();
		const backRoot = await render(articleWith(source), { record: back, theme: 'neutral' });
		assert.deepEqual(back.renders, []);
		assert.match(backRoot.innerHTML, /fill:#eee/);
	});

	test('two copies of one diagram never share an id', async () => {
		resetDiagramCache();
		const source = 'graph TD; Same-->Twice;';
		const record = newRecorder();

		// Even on the very first pass the second copy is a cache hit, so this is the
		// case the cache creates and the case it has to get right.
		const root = await render(articleWith(source, source), { record });
		assert.equal(record.renders.length, 1);

		const all = idsIn(root.innerHTML);
		assert.equal(all.length, 4, 'two diagrams, each with an svg id and a marker id');
		assert.equal(new Set(all).size, 4, `duplicate ids in the document: ${all.join(', ')}`);

		// The re-identification has to be complete, not just applied to the `<svg>`:
		// each copy's style block and marker reference must point at its own id.
		const [firstSvg, secondSvg] = root.innerHTML.split('<svg ').slice(1);
		for (const [svgId, svg] of [
			[all[0], firstSvg],
			[all[2], secondSvg],
		] as const) {
			assert.ok(svg.includes(`<style>#${svgId} .node rect`), `style block not re-pointed for ${svgId}`);
			assert.ok(svg.includes(`url(#${svgId}_flowchart-pointEnd)`), `marker not re-pointed for ${svgId}`);
		}
	});

	test('a reused diagram still carries its source for the PDF re-render', async () => {
		resetDiagramCache();
		const source = 'graph TD; Print-->Me;';
		await render(articleWith(source), { record: newRecorder() });

		const reused = newRecorder();
		const root = await render(articleWith(source), { record: reused });
		assert.deepEqual(reused.renders, []);
		// `mermaidPrint` finds diagrams by this attribute; a cached container without
		// it would silently print dark diagrams on paper.
		assert.match(root.innerHTML, /class="mermaid-diagram" data-mermaid-source="graph TD; Print-->Me;"/);
	});

	test('ids Mermaid does not namespace are namespaced by the cache', async () => {
		resetDiagramCache();
		// A sequence diagram's actor ids come from a module counter, not from the
		// svg id — two copies of one diagram would otherwise both say `actor7`.
		const source = 'sequenceDiagram; A->>B: hi';
		const record = newRecorder();
		const root = await render(articleWith(source, source), {
			record,
			extraFor: () => '<g id="actor7"><g id="root-7"></g></g>',
		});

		assert.equal(record.renders.length, 1);
		const all = idsIn(root.innerHTML);
		assert.equal(new Set(all).size, all.length, `duplicate ids in the document: ${all.join(', ')}`);
		// The drawn copy keeps exactly what Mermaid emitted — the cache changes
		// nothing about a miss. The reused copy is the one that has to be moved out
		// of the way, and it lands under its own svg id.
		assert.equal(all.filter((id) => id === 'actor7').length, 1);
		assert.equal(all.filter((id) => id !== 'actor7' && id.endsWith('-actor7')).length, 1);
	});

	test('a diagram whose stray id is referenced is not cached at all', async () => {
		resetDiagramCache();
		// The cache renames stray declarations but does not rewrite references to
		// them. If a future Mermaid points at one, the honest answer is to redraw.
		const source = 'graph TD; Referenced-->Stray;';
		const record = newRecorder();
		await render(articleWith(source), {
			record,
			extraFor: () => '<clipPath id="halo"></clipPath><rect clip-path="url(#halo)"></rect>',
		});

		const again = newRecorder();
		await render(articleWith(source), {
			record: again,
			extraFor: () => '<clipPath id="halo"></clipPath><rect clip-path="url(#halo)"></rect>',
		});
		assert.equal(again.renders.length, 1, 'an un-templatable diagram must be redrawn, not reused');
	});

	test('the cache is bounded by entry count', async () => {
		resetDiagramCache();
		// 128 entries is the cap. Fill past it and the first one must be gone.
		const first = 'graph TD; N0-->X;';
		await render(articleWith(first), { record: newRecorder() });
		for (let i = 1; i <= 128; i++) {
			await render(articleWith(`graph TD; N${i}-->X;`), { record: newRecorder() });
		}

		const evicted = newRecorder();
		await render(articleWith(first), { record: evicted });
		assert.equal(evicted.renders.length, 1, 'the oldest entry must have been evicted');

		// …and the most recent one is still there.
		const kept = newRecorder();
		await render(articleWith('graph TD; N128-->X;'), { record: kept });
		assert.deepEqual(kept.renders, []);
	});

	test('the cache is bounded by size, not only by count', async () => {
		resetDiagramCache();
		// Eight ~400k-character diagrams are only eight entries but 3.2M characters,
		// which is over the budget: a handful of enormous diagrams must not sit in
		// memory forever just because they are few.
		const bulk = (n: number) => `graph TD; Big${n}["${'x'.repeat(400_000)}"];`;
		const first = bulk(0);
		await render(articleWith(first), { record: newRecorder() });
		for (let i = 1; i < 8; i++) await render(articleWith(bulk(i)), { record: newRecorder() });

		const evicted = newRecorder();
		await render(articleWith(first), { record: evicted });
		assert.equal(evicted.renders.length, 1);
	});

	test('a diagram is redrawn rather than reused when its own text spells out the slot', async () => {
		resetDiagramCache();
		// The template marks where the id goes with a literal token. A diagram whose
		// text contains that token cannot be templated without rewriting the user's
		// own text, so it is left uncached.
		const source = 'graph TD; A["{{markpad-diagram-id}}"];';
		await render(articleWith(source), { record: newRecorder() });
		const again = newRecorder();
		await render(articleWith(source), { record: again });
		assert.equal(again.renders.length, 1);
	});

	// ------------------------------------------------- the templating, on its own

	test('templating refuses anything it cannot re-identify', () => {
		// The id it was told about is not the one in the markup: nothing to lift out.
		assert.equal(templateDiagramSvg('<svg id="other"></svg>', 'mine'), null);
		// A referenced stray id.
		assert.equal(
			templateDiagramSvg('<svg id="mine"><clipPath id="halo"/><g clip-path="url(#halo)"/></svg>', 'mine'),
			null,
		);

		const template = templateDiagramSvg('<svg id="mine"><style>#mine{fill:red}</style></svg>', 'mine');
		assert.ok(template);
		assert.equal(
			fillDiagramTemplate(template as string, 'fresh'),
			'<svg id="fresh"><style>#fresh{fill:red}</style></svg>',
		);
	});
});

/**
 * The preview re-renders the whole article on every keystroke and `{@html}`
 * puts every formula and every code block back as source, so KaTeX and
 * highlight.js ran over the entire document for one typed character. Measured
 * in Chromium on `samples/katex-stress.md` (21 display formulas), the
 * `[data-math]` pass alone was ~17ms per keystroke; with the memo it is ~6ms
 * and calls KaTeX zero times.
 *
 * These tests pin what such a memo can get quietly wrong. It is the same list
 * `preview.richContent.test.ts` works from — a memo that never misses is a
 * correctness bug and a memo that never evicts is a leak, and neither shows up
 * as anything on screen — minus the re-identification half, because neither
 * `katex.renderToString` nor `hljs.highlight` bakes an id into its output.
 *
 * What is *not* stood in for is the shape of the call: the fakes here answer to
 * `renderToString` / `highlight` + `getLanguage`, which is exactly the boundary
 * the renderer now uses, so a return to the element-mutating entry points
 * (`katex.render`, `hljs.highlightElement`) fails here rather than silently
 * costing a render per keystroke again.
 */
describe('rich content cache', () => {
	useShimDom({ window: globalThis }, { identitySanitize: true });

	interface Recorder {
		math: string[];
		code: string[];
	}

	function newRecorder(): Recorder {
		return { math: [], code: [] };
	}

	const KNOWN_LANGUAGES = new Set(['js', 'rust', 'python']);

	function libraries(record: Recorder, mathOutput = (source: string) => `<span>${source}</span>`) {
		return {
			hljs: {
				getLanguage: (name: string) => (KNOWN_LANGUAGES.has(name) ? { name } : null),
				highlight(code: string, options: { language: string }) {
					record.code.push(`${options.language}:${code}`);
					return { value: `<b>${options.language}</b>${code}`, language: options.language };
				},
			},
			katex: {
				renderToString(source: string, options: { displayMode: boolean }) {
					record.math.push(`${options.displayMode ? 'display' : 'inline'}:${source}`);
					return mathOutput(source);
				},
			},
			renderMathInElement() {},
			mermaid: { initialize() {}, async render() { return { svg: '' }; } },
		};
	}

	function mathBlock(source: string, mode: 'display' | 'inline' = 'display'): string {
		return `<p data-math="${mode}" data-math-source="${source}">${source}</p>`;
	}

	function codeBlock(language: string, code: string): string {
		return `<pre><code class="language-${language}">${code}</code></pre>`;
	}

	async function render(html: string, record: Recorder, mathOutput?: (source: string) => string) {
		const root = (globalThis as any).document.createElement('div');
		root.innerHTML = html;
		await renderRichContent({
			roots: [root],
			libraries: libraries(record, mathOutput) as any,
			mermaidTheme: 'neutral',
		});
		return root;
	}

	// ------------------------------------------------------------------- tests

	test('a second pass over the same document renders nothing again', async () => {
		resetRichContentCache();
		const article = `${mathBlock('E = mc^2')}\n${codeBlock('js', 'const a = 1;')}`;

		const first = newRecorder();
		const before = await render(article, first);
		assert.deepEqual(first.math, ['display:E = mc^2']);
		assert.deepEqual(first.code, ['js:const a = 1;']);

		const second = newRecorder();
		const after = await render(article, second);
		assert.deepEqual(second.math, [], 'a repeat pass must not call KaTeX at all');
		assert.deepEqual(second.code, [], 'a repeat pass must not call highlight.js at all');
		// The same document, not merely the same call count.
		assert.equal(after.innerHTML, before.innerHTML);
	});

	test('typing in one formula re-renders that formula and nothing else', async () => {
		resetRichContentCache();
		const warm = newRecorder();
		await render(`${mathBlock('a + b')}\n${mathBlock('c + d')}`, warm);
		assert.equal(warm.math.length, 2);

		const typed = newRecorder();
		await render(`${mathBlock('a + bc')}\n${mathBlock('c + d')}`, typed);
		assert.deepEqual(typed.math, ['display:a + bc']);
	});

	test('the same source typeset both ways is two entries', async () => {
		resetRichContentCache();
		const record = newRecorder();
		await render(`${mathBlock('x^2', 'display')}\n${mathBlock('x^2', 'inline')}`, record);
		assert.deepEqual(record.math, ['display:x^2', 'inline:x^2']);
	});

	test('the same code under a different language is two entries', async () => {
		resetRichContentCache();
		const record = newRecorder();
		await render(`${codeBlock('js', 'let x = 1')}\n${codeBlock('rust', 'let x = 1')}`, record);
		assert.deepEqual(record.code, ['js:let x = 1', 'rust:let x = 1']);
	});

	test('a highlighted block carries the class the stylesheet hangs off', async () => {
		resetRichContentCache();
		const root = await render(codeBlock('js', 'const a = 1;'), newRecorder());
		const code = root.querySelector('code');
		assert.ok(code.classList.contains('hljs'), 'every hljs- rule in styles.css is scoped to .hljs');
		assert.equal(code.innerHTML, '<b>js</b>const a = 1;');
		// The shell and its label are what the copy button and the language caption
		// are built from, and they are unchanged by the memo.
		assert.ok(root.querySelector('.code-block-shell'), 'the code block still gets its shell');
		assert.equal(root.querySelector('.lang-label').textContent, 'js');
	});

	test('a language highlight.js does not know is left exactly as it was', async () => {
		resetRichContentCache();
		const record = newRecorder();
		// `hljs.highlightElement` used to answer this itself by falling back to
		// no-highlight; `hljs.highlight` throws instead, and a throw is the one
		// result the memo cannot store — so an unknown language must never reach it.
		const root = await render(codeBlock('admonition', 'note: hello'), record);
		assert.deepEqual(record.code, []);
		const code = root.querySelector('code');
		assert.ok(!code.classList.contains('hljs'));
		assert.equal(code.textContent, 'note: hello');
		// The caption still names what the author wrote.
		assert.equal(root.querySelector('.lang-label').textContent, 'admonition');
	});

	test('the memo is bounded by entry count', async () => {
		resetRichContentCache();
		// 512 entries is the cap. Fill past it and the first one must be gone.
		const first = mathBlock('n0');
		await render(first, newRecorder());
		for (let i = 1; i <= 512; i++) await render(mathBlock(`n${i}`), newRecorder());

		const evicted = newRecorder();
		await render(first, evicted);
		assert.deepEqual(evicted.math, ['display:n0'], 'the oldest entry must have been evicted');

		const kept = newRecorder();
		await render(mathBlock('n512'), kept);
		assert.deepEqual(kept.math, []);
	});

	test('the memo is bounded by size, not only by count', async () => {
		resetRichContentCache();
		// Six 400k-character outputs are six entries but 2.4M characters, which is
		// over the budget: a handful of enormous formulas must not sit in memory
		// forever just because they are few.
		const huge = () => 'x'.repeat(400_000);
		await render(mathBlock('big0'), newRecorder(), huge);
		for (let i = 1; i < 6; i++) await render(mathBlock(`big${i}`), newRecorder(), huge);

		const evicted = newRecorder();
		await render(mathBlock('big0'), evicted, huge);
		assert.deepEqual(evicted.math, ['display:big0']);
	});
});

/**
 * Every diagram whose labels Mermaid put in a `<foreignObject>` rendered as
 * empty shapes — in the preview and in the exported HTML alike, because both go
 * through `renderRichContent` → `sanitizeDiagramSvg`.
 *
 * ## The mechanism
 *
 * `sanitizeDiagramSvg` allowed the `foreignObject` *element* through
 * `ADD_TAGS`. The label is not the element; it is the HTML inside it
 * (`<div class="labelBkg">…<span class="nodeLabel">Alpha</span></div>`), and
 * DOMPurify removes HTML children of an SVG element unless the parent is an
 * HTML integration point:
 *
 *     // dompurify 3.4.12, dist/purify.es.mjs
 *     const HTML_INTEGRATION_POINTS = freeze(['annotation-xml']);
 *     _checkHtmlNamespace = function (tagName, parent, parentTagName) {
 *       if (parent.namespaceURI === SVG_NAMESPACE && !HTML_INTEGRATION_POINTS[parentTagName])
 *         return false;
 *
 * `foreignObject` is not on that list, so no `ADD_TAGS` entry can save its
 * children. `DOMPurify.removed` grew one entry per label and what survived was
 * literally `<foreignObject width="37.98" height="24"></foreignObject>`.
 *
 * ## What was measured, and where
 *
 * Mermaid needs layout to size a node, so it cannot be run by this suite
 * (`export.test.ts` says the same). The table below is real mermaid
 * 11.16.0 driven by real dompurify 3.4.12 in a browser, over every diagram type
 * 11.16.0 ships a renderer for:
 *
 *   with the config the app used to send (`{startOnLoad, theme}`)
 *     labels entirely deleted   flowchart, flowchart-v2, classDiagram,
 *                               stateDiagram, stateDiagram-v2, erDiagram,
 *                               requirementDiagram, mindmap, block, kanban
 *     labels hidden             journey (see the `<switch>` note below)
 *     unaffected                sequence, gantt, pie, quadrant, gitGraph, c4,
 *                               timeline, sankey, xychart, architecture, info,
 *                               ishikawa, wardley, treemap, packet, radar,
 *                               treeView — these use SVG `<text>` already
 *
 *   with `htmlLabels: false` added
 *     every one of the above keeps every label. One root-level key is enough:
 *     the per-diagram `flowchart.htmlLabels` / `class.htmlLabels` / … settings
 *     are deprecated in 11.x and the root one takes precedence over them.
 *
 * The `<switch>` note: the user journey renderer (and any renderer configured
 * `textPlacement: 'fo'`) emits `<switch><foreignObject>…</foreignObject><text>…`
 * — an SVG `<text>` fallback for browsers without `foreignObject`. A browser
 * picks the first child it supports, so an emptied-but-present `foreignObject`
 * *suppressed* a label that had survived the filter perfectly well. Measured:
 * the journey's task labels are 0×0 with `foreignObject` on the allowlist and
 * 37×20 with it removed. That is why the fix could make the filter stricter
 * rather than looser — see `sanitizeDiagramSvg`'s comment.
 *
 * ## What this file executes
 *
 * `scripts/mermaidDiagramCorpus.json` holds the bytes of that measurement: real
 * mermaid 11.16.0 output for two diagram families, rendered once with the old
 * config and once with the new one. The tests run the real `renderRichContent`
 * over a real code block, with Mermaid stood in for by a stand-in that answers
 * `render()` out of that corpus *keyed by the config the pipeline actually sent
 * it* — so what is under test is Markpad's configuration decision, and a config
 * we have no measurement for is an error rather than a pass.
 *
 * What this file cannot execute is DOMPurify itself. Without a DOM the library
 * returns a bare factory — `isSupported` false and no `sanitize` at all — so it
 * is stood in for by the identity function, the same way
 * `export.test.ts` does it. The last test below asserts that state
 * rather than assuming it, so nobody reads the middle test as "the filter kept
 * the labels". The property that makes the filter harmless is upstream of it and
 * *is* checked here, by parsing what the pipeline produced: there is no HTML
 * inside the SVG for the namespace rule to reach, and every label sits in an SVG
 * `<text>`. Making that half executable needs a DOM faithful enough to reproduce
 * HTML5 foreign-content parsing — which is the very rule under test — so a shim
 * written here would be marking its own homework.
 */
describe('mermaid diagram labels', () => {
	useShimDom({ window: globalThis }, { identitySanitize: true });

	/** What the real module offers under the Node runner, read before it is replaced. */
	const WITHOUT_A_DOM = { isSupported: DOMPurify.isSupported, sanitize: typeof DOMPurify.sanitize };

	interface Corpus {
		diagrams: Record<string, { source: string; labels: string[] }>;
		renders: Record<string, Record<string, string>>;
	}

	const CORPUS: Corpus = JSON.parse(readSource(new URL('./mermaidDiagramCorpus.json', import.meta.url)));

	const OLD_CONFIG = 'htmlLabels:default';

	const NEW_CONFIG = 'htmlLabels:false';

	/**
	 * Which captured render a given `mermaid.initialize` config corresponds to.
	 *
	 * Deliberately total over the two configs that were measured and an error for
	 * anything else: the corpus is evidence about specific configs, and silently
	 * reusing one config's bytes for another is how a fixture starts answering a
	 * question nobody asked it.
	 */
	function capturedRenderFor(config: Record<string, unknown>): string {
		if (config.htmlLabels === false) return NEW_CONFIG;
		if (config.htmlLabels === undefined) return OLD_CONFIG;
		throw new Error(
			`no captured mermaid 11.16.0 output for htmlLabels=${String(config.htmlLabels)} — render it in a browser and add it to mermaidDiagramCorpus.json`,
		);
	}

	function escapeHtml(value: string): string {
		return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
	}

	/** The libraries `renderRichContent` needs, with Mermaid backed by the corpus. */
	function libraries() {
		return {
			hljs: { getLanguage: () => null },
			katex: null,
			renderMathInElement() {},
			mermaid: {
				initialize(config: Record<string, unknown>) {
					this.config = config;
				},
				config: {} as Record<string, unknown>,
				async render(_id: string, source: string) {
					const name = Object.keys(CORPUS.diagrams).find(
						(key) => CORPUS.diagrams[key].source === source.trim(),
					);
					assert.ok(name, `no captured render for diagram source: ${source}`);
					return { svg: CORPUS.renders[capturedRenderFor(this.config)][name!] };
				},
			},
		};
	}

	/** What comrak stamps on the `<pre>` of the n-th fenced block in a document. */
	function sourceposOf(index: number): string {
		const start = index * 10 + 1;
		return `${start}:1-${start + 5}:3`;
	}

	interface RenderedDiagrams {
		diagrams: Map<string, ShimElement>;
		/** The article the diagrams live in, as the export hands it to the print pass. */
		root: ShimElement;
		/** The same Mermaid stand-in the preview configured, singleton like the real one. */
		mermaid: ReturnType<typeof libraries>['mermaid'];
	}

	/** Runs the real preview pipeline over one code block per captured diagram. */
	async function renderDiagrams(mermaidTheme = 'neutral'): Promise<RenderedDiagrams> {
		resetDiagramCache();
		const root = (globalThis as any).document.createElement('div');
		root.innerHTML = Object.values(CORPUS.diagrams)
			.map(
				(diagram, index) =>
					`<pre data-sourcepos="${sourceposOf(index)}"><code class="language-mermaid">${escapeHtml(diagram.source)}</code></pre>`,
			)
			.join('');

		const libs = libraries();
		await renderRichContent({
			roots: [root as any],
			libraries: libs as any,
			mermaidTheme,
			idFactory: (index: number) => `diagram-${index}`,
			onError: (error) => assert.fail(`renderRichContent reported: ${error}`),
		});

		const containers = root.querySelectorAll('.mermaid-diagram');
		assert.equal(containers.length, Object.keys(CORPUS.diagrams).length, 'every code block must become a diagram');
		return {
			diagrams: new Map(Object.keys(CORPUS.diagrams).map((name, index) => [name, containers[index]])),
			root,
			mermaid: libs.mermaid,
		};
	}

	/** Every captured label of `name`, present as SVG text under `container`. */
	function assertLabelsSurvived(name: string, container: ShimElement, what: string) {
		assert.equal(
			container.querySelectorAll('foreignObject').length,
			0,
			`${name}: ${what} carries its labels in foreignObject, whose HTML children DOMPurify removes regardless of ADD_TAGS — Mermaid must be initialized with htmlLabels: false`,
		);
		const labels = svgTextLabels(container);
		for (const label of CORPUS.diagrams[name].labels) {
			assert.ok(labels.some((text) => text.includes(label)), `${name}: "${label}" is missing from ${what}`);
		}
	}

	/** The text of every SVG-native `<text>` element, which no filter touches. */
	function svgTextLabels(element: ShimElement): string[] {
		return element
			.querySelectorAll('text')
			.map((node) => node.textContent.replace(/\s+/g, ' ').trim())
			.filter(Boolean);
	}

	test('the captured corpus is a real before/after pair', () => {
		// The corpus is the evidence the rest of this file rests on, so its two
		// halves are checked to differ in the way the bug report claims rather than
		// being taken on trust. Both are bytes mermaid 11.16.0 actually emitted.
		for (const [name, diagram] of Object.entries(CORPUS.diagrams)) {
			const before = parseHtml(CORPUS.renders[OLD_CONFIG][name]).body;
			const after = parseHtml(CORPUS.renders[NEW_CONFIG][name]).body;

			assert.ok(before.querySelectorAll('foreignObject').length > 0, `${name}: the old config must produce foreignObject`);
			assert.deepEqual(svgTextLabels(before), [], `${name}: the old config puts nothing in SVG text`);
			for (const label of diagram.labels) {
				const carriers = before.querySelectorAll('foreignObject').filter((node) => node.textContent.includes(label));
				assert.ok(carriers.length > 0, `${name}: "${label}" must sit inside a foreignObject before the fix`);
				// The label is HTML, which is what makes it unreachable: DOMPurify's
				// namespace rule deletes these children whatever ADD_TAGS says.
				assert.ok(
					carriers[0].querySelectorAll('div, span, p').length > 0,
					`${name}: "${label}" must be carried by HTML inside the foreignObject`,
				);
			}

			assert.equal(after.querySelectorAll('foreignObject').length, 0, `${name}: the new config must produce no foreignObject`);
			for (const label of diagram.labels) {
				assert.ok(svgTextLabels(after).some((text) => text.includes(label)), `${name}: "${label}" must be in an SVG text element after the fix`);
			}
		}
	});

	test('the preview asks Mermaid for labels a sanitizer cannot delete', async () => {
		const { diagrams } = await renderDiagrams();

		for (const name of Object.keys(CORPUS.diagrams)) {
			const container = diagrams.get(name)!;

			// The load-bearing assertion. `foreignObject` is the only route by which
			// Mermaid puts HTML inside the SVG, and HTML inside an SVG is exactly what
			// DOMPurify's HTML_INTEGRATION_POINTS check deletes — so a diagram with
			// none of it has nothing the diagram filter can take away.
			assertLabelsSurvived(name, container, 'the rendered diagram');

			// Mermaid's `<style>` carries the diagram's fills and strokes, and is the
			// reason the diagram filter cannot be the document policy.
			assert.equal(container.querySelectorAll('style').length, 1, `${name}: the diagram must keep its own stylesheet`);
		}
	});

	/**
	 * The export re-renders every diagram with a light theme before printing, and
	 * `mermaid.initialize` replaces the site config rather than merging into it —
	 * so the print pass sends its own config, and a key the preview set does not
	 * survive into it. Sending `{startOnLoad, theme}` there put the labels straight
	 * back into `foreignObject` for the render that becomes the PDF: on screen and
	 * in an exported HTML file the diagram was fine, and its text vanished the
	 * moment the print preview appeared (#717).
	 *
	 * The stand-in answers `render()` from the config it was last initialized with,
	 * so this fails on the real symptom rather than on the spelling of a call.
	 */
	test('the article a PDF is printed from keeps those labels too', async () => {
		// The print route renders its own copy of the document with the print
		// theme (see `exportAsPdf`), so the label question has to be answered for
		// that theme as well: `mermaidConfig` is the only place htmlLabels is set,
		// and every render goes through it.
		const { diagrams, mermaid } = await renderDiagrams(MERMAID_PRINT_THEME);

		for (const name of Object.keys(CORPUS.diagrams)) {
			assertLabelsSurvived(name, diagrams.get(name)!, 'the diagram rendered for print');
		}
		assert.equal((mermaid.config as Record<string, unknown>).htmlLabels, false);
		assert.equal((mermaid.config as Record<string, unknown>).theme, MERMAID_PRINT_THEME);
	});

	/**
	 * A diagram replaces its `<pre>` outright — Mermaid's SVG has nothing of the
	 * code block left in it — so unless the source range comes across with it, a
	 * diagram is the one block in the preview that maps to no source line at all.
	 * Scroll sync and the tab's reading position both resolve a position by
	 * descending to the annotated element that owns it, and several hundred
	 * unannotated pixels get attributed to whatever block is nearest instead.
	 */
	test('a rendered diagram answers for the source lines it replaced', async () => {
		const { diagrams } = await renderDiagrams();

		Object.keys(CORPUS.diagrams).forEach((name, index) => {
			assert.equal(
				diagrams.get(name)!.getAttribute('data-sourcepos'),
				sourceposOf(index),
				`${name}: the diagram container must carry the source range of the code block it replaced`,
			);
		});
	});

	test('the Node runner has no DOM, so the filter above was the identity function', () => {
		// Stated rather than assumed. Without `window.Element` DOMPurify returns a
		// factory and nothing else — not an inert sanitizer, no sanitizer — which is
		// why the stand-in exists and why the test above proves a property of what
		// Mermaid emitted rather than of what the filter kept. If this ever changes
		// (the suite gains a real DOM, or the shim grows one), the test above starts
		// covering the filter too and this assertion is the prompt to say so out loud
		// instead of letting the change pass unremarked.
		assert.deepEqual(
			WITHOUT_A_DOM,
			{ isSupported: false, sanitize: 'undefined' },
			'a DOM appeared under the test runner: re-read what the diagram tests above now cover',
		);
	});
});
