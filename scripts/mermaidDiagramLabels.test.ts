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
 * (`exportRichContent.test.ts` says the same). The table below is real mermaid
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
 * `exportRichContent.test.ts` does it. The last test below asserts that state
 * rather than assuming it, so nobody reads the middle test as "the filter kept
 * the labels". The property that makes the filter harmless is upstream of it and
 * *is* checked here, by parsing what the pipeline produced: there is no HTML
 * inside the SVG for the namespace rule to reach, and every label sits in an SVG
 * `<text>`. Making that half executable needs a DOM faithful enough to reproduce
 * HTML5 foreign-content parsing — which is the very rule under test — so a shim
 * written here would be marking its own homework.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { installShimDom, parseHtml, type ShimElement } from './renderProtocolDom.ts';
import { readSource } from './sourceTree.js';

installShimDom();
(globalThis as any).window = globalThis;

const DOMPurify = (await import('dompurify')).default as any;
/** What the real module offers under the Node runner, read before it is replaced. */
const WITHOUT_A_DOM = { isSupported: DOMPurify.isSupported, sanitize: typeof DOMPurify.sanitize };
DOMPurify.sanitize = (html: string) => html;

const { renderRichContent } = await import('../src/lib/utils/richContent.ts');
const { renderDiagramsForPrint } = await import('../src/lib/utils/mermaidPrint.ts');
const { resetDiagramCache } = await import('../src/lib/utils/diagramCache.ts');

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
async function renderDiagrams(): Promise<RenderedDiagrams> {
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
		mermaidTheme: 'neutral',
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
test('the PDF re-render keeps the labels the preview asked for', async () => {
	const { diagrams, root, mermaid } = await renderDiagrams();

	const restore = await renderDiagramsForPrint({
		root: root as any,
		mermaid: mermaid as any,
		sanitizeSvg: (svg: string) => svg,
		screenTheme: 'dark',
		idFactory: (index: number) => `print-${index}`,
		onError: (error) => assert.fail(`renderDiagramsForPrint reported: ${error}`),
	});

	for (const name of Object.keys(CORPUS.diagrams)) {
		assertLabelsSurvived(name, diagrams.get(name)!, 'the diagram re-rendered for print');
	}

	// The restore puts the screen rendering back, and leaves the singleton
	// configured for the screen — the next preview pass must not inherit the
	// print config either.
	restore();
	for (const name of Object.keys(CORPUS.diagrams)) {
		assertLabelsSurvived(name, diagrams.get(name)!, 'the diagram restored after print');
	}
	assert.equal((mermaid.config as Record<string, unknown>).htmlLabels, false, 'the restore must leave the screen config in place');
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
