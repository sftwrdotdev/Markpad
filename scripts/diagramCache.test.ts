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

import assert from 'node:assert/strict';
import test from 'node:test';

import { installShimDom } from './renderProtocolDom.ts';

installShimDom();
(globalThis as any).window = globalThis;

const DOMPurify = (await import('dompurify')).default as any;
DOMPurify.sanitize = (html: string) => html;

const { renderRichContent } = await import('../src/lib/utils/richContent.ts');
const { resetDiagramCache, templateDiagramSvg, fillDiagramTemplate } = await import(
	'../src/lib/utils/diagramCache.ts'
);

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
		root,
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
