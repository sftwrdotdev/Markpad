// These run over the shim DOM from renderProtocolDom.ts, which is installed on
// `globalThis` for the whole process, so they live apart from navigation.test.ts.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
	installShimDom,
	parseHtml,
	NODE_ELEMENT,
	type ShimElement,
	NODE_TEXT,
	type ShimNode,
} from './renderProtocolDom.ts';

installShimDom();

// `processMarkdownHtml` resolves every local image through Tauri's
// `convertFileSrc`, which reads `window.__TAURI_INTERNALS__`. Without it the
// resolution throws, the app catches it, and the `<img>` is left alone — which
// is exactly the branch the "does the range survive the rewrite" test must NOT
// be allowed to take.
(globalThis as unknown as Record<string, unknown>).window = {
	__TAURI_INTERNALS__: {
		convertFileSrc: (path: string, protocol: string) => `${protocol}://localhost/${path}`,
	},
};

const { processMarkdownHtml } = await import('../src/lib/utils/markdown.ts');
const {
	findAnchorElement,
	getAnchorScrollTop,
	parseSourceposLineRange,
	findSourceLineRange,
	mergeSourceLineRanges,
} = await import('../src/lib/utils/previewAnchor.ts');
const { frontMatterLineOffset } = await import('../src/lib/utils/frontMatter.js');
const { asBufferLine, asRendererLine, lineCoordinates } = await import('../src/lib/utils/lineCoordinates.js');

/**
 * Preview scroll restore: does an anchor line actually resolve to an element?
 *
 * The restore path in `MarkdownViewer.svelte` takes the saved `tab.anchorLine`
 * and looks for the rendered element whose `data-sourcepos` range contains that
 * line. Before this fix it only walked `body.children`, but `processMarkdownHtml`
 * moves everything after a heading into a JS-created `.foldable-content-wrapper`
 * that carries no `data-sourcepos` — so the only top-level elements left with a
 * source range are the *shallowest* headings. An anchor resolved only when it
 * happened to land exactly on one of those heading lines.
 *
 * This file measures that as a rate rather than asserting "it runs":
 *
 *   - `legacyTopLevelMatch` is the pre-fix algorithm, restated verbatim over
 *     the same DOM. It is kept here as the control; if the fix ever regresses
 *     into a top-level-only scan the two rates collapse into each other.
 *   - `findAnchorElement` is the shipped implementation.
 *
 * Both run over real `processMarkdownHtml` output (via the `renderProtocolDom`
 * shim, same as `renderProtocol.test.ts`). The input HTML is generated in the
 * shape comrak emits — the tag/attribute shape is taken from the recorded
 * `convert_markdown` output in `renderProtocolFixtures.ts`.
 */
describe('preview anchor restore', () => {
	const FILE_PATH = '/documents/notes.md';

	/* ------------------------------------------------------------------ */
	/* comrak-shaped document generator                                    */
	/* ------------------------------------------------------------------ */

	type Block = { startLine: number; endLine: number };

	class DocumentBuilder {
		private line = 1;
		private readonly parts: string[] = [];
		readonly blocks: Block[] = [];

		blank() {
			this.line += 1;
		}

		heading(level: number, text: string, slug: string) {
			const line = this.line;
			this.line += 1;
			this.blocks.push({ startLine: line, endLine: line });
			this.parts.push(
				`<h${level} data-sourcepos="${line}:1-${line}:${level + 1 + text.length}">` +
					`<a href="#${slug}" aria-hidden="true" class="anchor" id="${slug}"></a>${text}</h${level}>`,
			);
		}

		paragraph(text: string) {
			const line = this.line;
			this.line += 1;
			this.blocks.push({ startLine: line, endLine: line });
			this.parts.push(`<p data-sourcepos="${line}:1-${line}:${text.length}">${text}</p>`);
		}

		list(items: string[]) {
			const start = this.line;
			const end = start + items.length - 1;
			const itemHtml = items.map((item, index) => {
				const itemLine = start + index;
				return `<li data-sourcepos="${itemLine}:1-${itemLine}:${item.length + 2}">${item}</li>`;
			});
			this.blocks.push({ startLine: start, endLine: end });
			this.parts.push(`<ul data-sourcepos="${start}:1-${end}:${items[items.length - 1].length + 2}">\n${itemHtml.join('\n')}\n</ul>`);
			this.line = end + 1;
		}

		/**
		 * A paragraph the author soft-wrapped over several source lines.
		 * `convert_markdown` sets `render.hardbreaks`, so comrak ends every line but
		 * the last with `<br data-sourcepos="…" />` — the exact shape recorded in
		 * `renderProtocolFixtures.ts`. Every one of those `br`s is a `[data-sourcepos]`
		 * element that `findAnchorElement` can descend into and that reports
		 * `offsetTop === 0, offsetHeight === 0` to the restore.
		 */
		wrappedParagraph(lines: string[]) {
			const start = this.line;
			const end = start + lines.length - 1;
			const html = lines
				.map((text, index) =>
					index === lines.length - 1
						? text
						: `${text}<br data-sourcepos="${start + index}:${text.length + 1}-${start + index}:${text.length + 1}" />\n`,
				)
				.join('');
			this.blocks.push({ startLine: start, endLine: end });
			this.parts.push(`<p data-sourcepos="${start}:1-${end}:${lines[lines.length - 1].length}">${html}</p>`);
			this.line = end + 1;
		}

		code(lines: string[]) {
			const start = this.line;
			const end = start + lines.length + 1;
			this.blocks.push({ startLine: start, endLine: end });
			this.parts.push(
				`<pre data-sourcepos="${start}:1-${end}:3"><code class="language-sh">${lines.join('\n')}\n</code></pre>`,
			);
			this.line = end + 1;
		}

		get lineCount() {
			return this.line - 1;
		}

		html() {
			return this.parts.join('\n') + '\n';
		}
	}

	/**
	 * One section body: the block mix a real document repeats between headings.
	 * Sized at 20 source lines so a 477-heading document lands near the 10k lines
	 * the audit measured.
	 */
	function sectionBody(doc: DocumentBuilder, seed: number) {
		doc.blank();
		doc.paragraph(`Prose paragraph ${seed} explaining the section in a sentence.`);
		doc.blank();
		doc.list([`item ${seed} alpha`, `item ${seed} beta`, `item ${seed} gamma`]);
		doc.blank();
		doc.paragraph(`Second prose paragraph ${seed} with a little more detail.`);
		doc.blank();
		doc.code([`echo section-${seed}`, `run --flag ${seed}`]);
		doc.blank();
		doc.paragraph(`Third prose paragraph ${seed}, the one after the code block.`);
		doc.blank();
		doc.list([`follow-up ${seed} one`, `follow-up ${seed} two`, `follow-up ${seed} three`]);
		doc.blank();
	}

	/** A flat document: every heading is an `h2`, so all of them stay top level. */
	function buildFlatDocument(sections: number) {
		const doc = new DocumentBuilder();
		doc.paragraph('Intro paragraph before the first heading.');
		doc.blank();
		for (let i = 1; i <= sections; i += 1) {
			doc.heading(2, `Section ${i}`, `section-${i}`);
			sectionBody(doc, i);
		}
		return doc;
	}

	/** A nested document: `h1 > h2 > h3`, so only the `h1`s stay top level. */
	function buildNestedDocument(chapters: number) {
		const doc = new DocumentBuilder();
		doc.paragraph('Intro paragraph before the first heading.');
		doc.blank();
		for (let c = 1; c <= chapters; c += 1) {
			doc.heading(1, `Chapter ${c}`, `chapter-${c}`);
			sectionBody(doc, c * 100);
			doc.heading(2, `Chapter ${c} Section`, `chapter-${c}-section`);
			sectionBody(doc, c * 100 + 1);
			doc.heading(3, `Chapter ${c} Unit`, `chapter-${c}-unit`);
			sectionBody(doc, c * 100 + 2);
		}
		return doc;
	}

	/* ------------------------------------------------------------------ */
	/* measurement                                                         */
	/* ------------------------------------------------------------------ */

	function elementChildren(node: ShimElement): ShimElement[] {
		return node.childNodes.filter((child): child is ShimElement => child.nodeType === NODE_ELEMENT);
	}

	/**
	 * The pre-fix restore loop, restated: scan `body.children` only, take the first
	 * child whose own `data-sourcepos` range contains the line.
	 */
	function legacyTopLevelMatch(body: ShimElement, line: number) {
		for (const el of elementChildren(body)) {
			const sourcepos = el.getAttribute('data-sourcepos');
			if (!sourcepos) continue;
			const [start, end] = sourcepos.split('-');
			const startLine = parseInt(start.split(':')[0], 10);
			const endLine = parseInt(end.split(':')[0], 10);
			if (Number.isNaN(startLine) || Number.isNaN(endLine)) continue;
			if (line >= startLine && line <= endLine) return { startLine, endLine };
		}
		return null;
	}

	/** Every source line the renderer attributed to some block, sampled evenly. */
	function sampleAnchorLines(blocks: Block[], count: number): number[] {
		const lines = new Set<number>();
		for (const block of blocks) {
			for (let line = block.startLine; line <= block.endLine; line += 1) lines.add(line);
		}
		const all = [...lines].sort((a, b) => a - b);
		const step = all.length / count;
		const sampled: number[] = [];
		for (let i = 0; i < count; i += 1) sampled.push(all[Math.floor(i * step)]);
		return sampled;
	}

	type Rate = { hits: number; total: number; percent: number };

	function rate(hits: number, total: number): Rate {
		return { hits, total, percent: Math.round((hits / total) * 1000) / 10 };
	}

	function measure(doc: DocumentBuilder, sampleSize: number) {
		const body = parseHtml(processMarkdownHtml(doc.html(), FILE_PATH, new Set())).body;
		const anchors = sampleAnchorLines(doc.blocks, sampleSize);

		let legacyHits = 0;
		let fixedHits = 0;
		for (const line of anchors) {
			const legacy = legacyTopLevelMatch(body, line);
			if (legacy && line >= legacy.startLine && line <= legacy.endLine) legacyHits += 1;

			const fixed = findAnchorElement(body, line);
			if (fixed && line >= fixed.startLine && line <= fixed.endLine) fixedHits += 1;
		}

		const topLevel = elementChildren(body);
		return {
			body,
			anchors,
			annotatedElements: body.querySelectorAll('[data-sourcepos]').length,
			topLevelChildren: topLevel.length,
			topLevelWithSourcepos: topLevel.filter((el) => el.getAttribute('data-sourcepos') !== null).length,
			legacy: rate(legacyHits, anchors.length),
			fixed: rate(fixedHits, anchors.length),
		};
	}

	/* ------------------------------------------------------------------ */
	/* tests                                                               */
	/* ------------------------------------------------------------------ */

	test('flat h2 document: anchor lines resolve to an element', (t) => {
		const doc = buildFlatDocument(477);
		const result = measure(doc, 300);

		t.diagnostic(`flat: ${doc.lineCount} source lines, ${result.annotatedElements} elements with data-sourcepos`);
		t.diagnostic(`flat: ${result.topLevelChildren} top-level children, ` +
			`${result.topLevelWithSourcepos} of them with data-sourcepos`);
		t.diagnostic(`flat: legacy top-level scan ${result.legacy.hits}/${result.legacy.total} (${result.legacy.percent}%)`);
		t.diagnostic(`flat: findAnchorElement ${result.fixed.hits}/${result.fixed.total} (${result.fixed.percent}%)`);

		// The control: the pre-fix scan only ever matched a top-level heading line.
		assert.ok(
			result.legacy.percent < 15,
			`the pre-fix top-level scan is expected to miss almost everything, got ${result.legacy.percent}%`,
		);
		// The fix: every sampled anchor line resolves.
		assert.equal(result.fixed.hits, result.fixed.total);
	});

	test('nested h1/h2/h3 document: anchor lines resolve to an element', (t) => {
		const doc = buildNestedDocument(159);
		const result = measure(doc, 300);

		t.diagnostic(`nested: ${doc.lineCount} source lines, ${result.annotatedElements} elements with data-sourcepos`);
		t.diagnostic(`nested: ${result.topLevelChildren} top-level children, ` +
			`${result.topLevelWithSourcepos} of them with data-sourcepos`);
		t.diagnostic(`nested: legacy top-level scan ${result.legacy.hits}/${result.legacy.total} (${result.legacy.percent}%)`);
		t.diagnostic(`nested: findAnchorElement ${result.fixed.hits}/${result.fixed.total} (${result.fixed.percent}%)`);

		assert.ok(
			result.legacy.percent < 15,
			`the pre-fix top-level scan is expected to miss almost everything, got ${result.legacy.percent}%`,
		);
		assert.equal(result.fixed.hits, result.fixed.total);
	});

	test('the resolved element is the narrowest block containing the line', () => {
		const doc = new DocumentBuilder();
		doc.heading(2, 'Heading', 'heading');
		doc.blank();
		doc.list(['first', 'second', 'third']);
		const body = parseHtml(processMarkdownHtml(doc.html(), FILE_PATH, new Set())).body;

		// The list occupies lines 3-5; the anchor for line 4 must be that `li`,
		// not the enclosing `ul` and not the heading's fold wrapper.
		const match = findAnchorElement(body, 4);
		assert.ok(match);
		assert.equal((match.element as ShimElement).tagName, 'LI');
		assert.deepEqual({ startLine: match.startLine, endLine: match.endLine }, { startLine: 4, endLine: 4 });
	});

	test('a collapsed fold resolves to the collapsed wrapper, not to its hidden contents', () => {
		const doc = new DocumentBuilder();
		doc.heading(2, 'Heading', 'heading');
		doc.blank();
		doc.paragraph('Hidden body text.');
		const body = parseHtml(processMarkdownHtml(doc.html(), FILE_PATH, new Set(['heading']))).body;

		// Line 3 is the paragraph inside the collapsed section. Its geometry is
		// meaningless while the wrapper is `height: 0; overflow: hidden`, so the
		// wrapper itself — which sits at the right scroll offset — is the answer.
		const match = findAnchorElement(body, 3);
		assert.ok(match);
		const element = match.element as ShimElement;
		assert.ok(element.classList.contains('foldable-content-wrapper'));
		assert.ok(element.classList.contains('is-collapsed'));
	});

	/**
	 * A document with no headings at all: `processMarkdownHtml` creates no fold
	 * wrappers, so every rendered block stays a top-level child. Issue #153's
	 * follow-up report is about exactly this shape.
	 */
	function buildTextOnlyDocument(paragraphs: number) {
		const doc = new DocumentBuilder();
		for (let i = 1; i <= paragraphs; i += 1) {
			doc.wrappedParagraph([
				`Paragraph ${i} first line of prose the author soft-wrapped.`,
				`Paragraph ${i} second line, still the same markdown block.`,
				`Paragraph ${i} third and final line of the block.`,
			]);
			doc.blank();
		}
		return doc;
	}

	/**
	 * The resolver may only return an element that can tell the restore where it
	 * is. `getAnchorScrollTop` is handed `offsetTop` and `offsetHeight`, and a `br`
	 * reports `0` for both in every browser — so resolving to one is not a near
	 * miss, it is `scrollTop = 0`: the reader is thrown to the top of the document.
	 *
	 * Measured in Chrome over this pipeline's own output: an anchor resolved to a
	 * `br` restored to 0 from scroll offsets of 219, 328, 438, 547, 657 and 766 px.
	 * The shim has no layout, so this is asserted structurally instead — that is
	 * also why the rates above could read 100% while the round trip was broken.
	 */
	test('a soft-wrapped paragraph resolves to the paragraph, never to its <br>', () => {
		const doc = new DocumentBuilder();
		doc.wrappedParagraph(['first line', 'second line', 'third line']);
		const body = parseHtml(processMarkdownHtml(doc.html(), FILE_PATH, new Set())).body;

		assert.ok(body.querySelectorAll('br[data-sourcepos]').length > 0, 'fixture must contain annotated hard breaks');

		for (const line of [1, 2, 3]) {
			const match = findAnchorElement(body, line);
			assert.ok(match, `line ${line} must resolve`);

			const element = match.element as ShimElement;
			assert.notEqual(element.tagName, 'BR', `line ${line} resolved to a boxless element`);

			// Lines after the first now resolve to the soft-line anchor that
			// `processSoftLineAnchors` puts beside each break — a narrower answer
			// than the paragraph, and a better one: it reports the position of that
			// line rather than the top of the block containing it. The anchor is an
			// empty inline-block, so unlike the `<br>` it has a box to measure,
			// which is the property this test exists to protect.
			if (element.getAttribute('class') === 'source-line-anchor') {
				assert.deepEqual(
					{ startLine: match.startLine, endLine: match.endLine },
					{ startLine: line, endLine: line },
					`the anchor for line ${line} must name that line`,
				);
				continue;
			}

			assert.equal(element.tagName, 'P', `line ${line} resolved to ${element.tagName}`);
			assert.deepEqual({ startLine: match.startLine, endLine: match.endLine }, { startLine: 1, endLine: 3 });
		}
	});

	test('heading-less document: every anchor line resolves to an element with a box', (t) => {
		const doc = buildTextOnlyDocument(150);
		const result = measure(doc, 300);

		t.diagnostic(`text-only: ${doc.lineCount} source lines, ${result.annotatedElements} elements with data-sourcepos`);
		t.diagnostic(`text-only: ${result.topLevelChildren} top-level children, ` +
			`${result.topLevelWithSourcepos} of them with data-sourcepos`);
		t.diagnostic(`text-only: findAnchorElement ${result.fixed.hits}/${result.fixed.total} (${result.fixed.percent}%)`);

		assert.equal(result.fixed.hits, result.fixed.total);

		// Every source line the renderer attributed to a block, not just the sample:
		// the failure is per-line, and two of every three lines of a soft-wrapped
		// paragraph are `br` lines.
		let boxless = 0;
		let total = 0;
		for (const block of doc.blocks) {
			for (let line = block.startLine; line <= block.endLine; line += 1) {
				total += 1;
				const match = findAnchorElement(result.body, line);
				if (match && ['BR', 'WBR'].includes((match.element as ShimElement).tagName)) boxless += 1;
			}
		}
		t.diagnostic(`text-only: ${boxless}/${total} anchor lines resolved to a boxless element`);
		assert.equal(boxless, 0, `${boxless}/${total} anchor lines resolved to an element with no box`);
	});

	test('an anchor line past the end of the document does not resolve', () => {
		const doc = buildFlatDocument(3);
		const body = parseHtml(processMarkdownHtml(doc.html(), FILE_PATH, new Set())).body;
		assert.equal(findAnchorElement(body, doc.lineCount + 500), null);
	});

	test('scroll target interpolates inside the resolved element', () => {
		const range = { startLine: 10, endLine: 20 };
		assert.equal(getAnchorScrollTop(1000, 200, range, 10, 60), 940);
		assert.equal(getAnchorScrollTop(1000, 200, range, 15, 60), 1040);
		assert.equal(getAnchorScrollTop(1000, 200, range, 20, 60), 1140);
		// Single-line blocks have no interior to interpolate over.
		assert.equal(getAnchorScrollTop(1000, 200, { startLine: 7, endLine: 7 }, 7, 60), 940);
		// Never scrolls above the top of the document.
		assert.equal(getAnchorScrollTop(10, 20, { startLine: 1, endLine: 1 }, 1, 60), 0);
	});

	test('source position ranges parse the way comrak writes them', () => {
		assert.deepEqual(parseSourceposLineRange('12:1-14:9'), { startLine: 12, endLine: 14 });
		assert.equal(parseSourceposLineRange(''), null);
		assert.equal(parseSourceposLineRange(null), null);
		assert.equal(parseSourceposLineRange('nonsense'), null);
	});
});

/**
 * #90: "Edit" in the preview's context menu opens the editor ON the fragment
 * that was right-clicked, and highlights it.
 *
 * The mapping this needs already exists. comrak runs with
 * `options.render.sourcepos = true` (`markdown_options` in
 * src-tauri/src/lib.rs), so every rendered element carries the source range it
 * came from, and `previewAnchor.ts` is the module that reads those ranges for
 * the tab's reading position and for split-view scroll sync. This feature is a
 * third consumer of the same attribute, not a third mapping: it resolves an
 * element to a `LineRange` with the parser those two already use, and hands it
 * to the one line-to-editor jump in `Editor.svelte` — the one the outline
 * already calls through `revealHeader`.
 *
 * Two facts about `data-sourcepos` that the tests below pin, because getting
 * either wrong is silent:
 *
 *   - INLINE nodes carry a range, not just blocks. Recorded from
 *     `convert_markdown` at comrak 0.54:
 *
 *       <p data-sourcepos="3:1-3:67">A paragraph with
 *         <strong data-sourcepos="3:18-3:30">bold text</strong> and an
 *         <img data-sourcepos="3:39-3:53" src="img.png" alt="alt" />
 *         inline image.</p>
 *
 *     which is what makes "jump to the selected image" land on the image's own
 *     line rather than on the whole paragraph.
 *
 *   - Only the LINE numbers are meaningful against the buffer the user edits.
 *     comrak parses the output of `convert_markdown`'s preprocessing, and that
 *     pipeline is line-preserving, not column-preserving. Recorded from the
 *     same renderer, for the raw line `Math $a+b$ then ![alt](img.png) here.`:
 *
 *       <p data-sourcepos="3:1-3:44">…<img data-sourcepos="3:24-3:38" …
 *
 *     The image really starts at raw column 18; the math mask substitutes a
 *     token longer than `$a+b$` and every column after it on the line is off
 *     by the difference. So the jump selects whole lines, and nothing here
 *     ever reads a column.
 */
describe('jump to the selected fragment', () => {
	const FILE_PATH = '/documents/notes.md';

	/**
	 * comrak-shaped output for
	 *
	 *   1  # Notes
	 *   2
	 *   3  A paragraph with **bold text** and an ![alt](img.png) inline image.
	 *   4
	 *   5  ![standalone](pic.png)
	 *   6
	 *   7  Trailing prose
	 *   8  over two lines.
	 *
	 * taken from `convert_markdown`, hardbreaks and heading anchor included, then
	 * put through the app's own `processMarkdownHtml` — which is where the fold
	 * wrapper that carries no source range of its own appears.
	 */
	const RENDERED = processMarkdownHtml(
		'<h1 id="notes" data-sourcepos="1:1-1:7">Notes<a href="#notes" aria-label="Link to heading \'Notes\'" data-heading-content="Notes" class="anchor"></a></h1>\n' +
			'<p data-sourcepos="3:1-3:67">A paragraph with <strong data-sourcepos="3:18-3:30">bold text</strong> and an <img data-sourcepos="3:39-3:53" src="img.png" alt="alt" /> inline image.</p>\n' +
			'<p data-sourcepos="5:1-5:22"><img data-sourcepos="5:1-5:22" src="pic.png" alt="standalone" /></p>\n' +
			'<p data-sourcepos="7:1-8:15">Trailing prose<br data-sourcepos="7:15-7:15" />\nover two lines.</p>\n',
		FILE_PATH,
		new Set<string>(),
	);

	const body = parseHtml(RENDERED).body;

	/** The first descendant of `root` the shim's `querySelector` can name. */
	function pick(selector: string): ShimElement {
		const found = body.querySelector(selector);
		assert.ok(found, `expected the rendered preview to contain ${selector}`);
		return found;
	}

	/**
	 * The first text node under `node` — where the end of a browser selection, and
	 * a `MouseEvent.target` inside prose, actually lands. Text nodes have no
	 * `closest` of their own, which is the case the lookup has to climb out of.
	 */
	function firstText(node: ShimNode): ShimNode {
		if (node.nodeType === NODE_TEXT) return node;
		for (const child of node.childNodes) {
			const found = firstText(child);
			if (found.nodeType === NODE_TEXT) return found;
		}
		return node;
	}

	/* ------------------------------------------------------------------ */
	/* what a click resolves to                                            */
	/* ------------------------------------------------------------------ */

	test('an image inside a paragraph resolves to the image, not to the paragraph', () => {
		// The whole point of #90 for the "or an image" half of the report. The
		// enclosing <p> spans line 3 too here, but the narrowest match is what
		// keeps a multi-line paragraph from selecting all of itself.
		assert.deepEqual(findSourceLineRange(pick('img[alt="alt"]')), {
			startLine: 3,
			endLine: 3,
		});
	});

	test('a caret inside a block resolves to the whole block', () => {
		// Text nodes have no `closest`; the lookup has to climb to the element.
		// A paragraph is the finest granularity available for plain prose, and it
		// is the right one: the reader asked to edit this paragraph.
		const paragraph = pick('p[data-sourcepos="7:1-8:15"]');
		assert.deepEqual(findSourceLineRange(firstText(paragraph)), { startLine: 7, endLine: 8 });
	});

	test('an inline node with its own range beats the block around it', () => {
		assert.deepEqual(findSourceLineRange(firstText(pick('strong'))), { startLine: 3, endLine: 3 });
	});

	test('the fold wrapper processMarkdownHtml inserts does not hide the range', () => {
		// `processMarkdownHtml` re-parents everything after a heading into a
		// `.foldable-content-wrapper` it creates, and that wrapper carries no
		// `data-sourcepos`. The climb has to pass straight through it — this is
		// the same shape of defect #420 fixed for the restore path.
		assert.ok(body.querySelector('.foldable-content-wrapper'), 'expected a fold wrapper');
		assert.deepEqual(findSourceLineRange(pick('img[alt="standalone"]')), {
			startLine: 5,
			endLine: 5,
		});
	});

	test('anything the app renders around the document resolves to nothing', () => {
		// The front matter panel, the outline, the window chrome. The context menu
		// leaves its "Edit" entry alone rather than jumping somewhere arbitrary.
		assert.equal(findSourceLineRange(null), null);
		assert.equal(findSourceLineRange(parseHtml('<div class="front-matter">x</div>').body), null);
	});

	/* ------------------------------------------------------------------ */
	/* what a selection resolves to                                        */
	/* ------------------------------------------------------------------ */

	test('a selection spanning several blocks covers all of them', () => {
		const first = findSourceLineRange(firstText(pick('h1')));
		const last = findSourceLineRange(firstText(pick('p[data-sourcepos="7:1-8:15"]')));

		assert.deepEqual(mergeSourceLineRanges(first, last), { startLine: 1, endLine: 8 });
	});

	test('a backwards selection covers the same lines as a forwards one', () => {
		const a = { startLine: 3, endLine: 3 };
		const b = { startLine: 7, endLine: 8 };

		assert.deepEqual(mergeSourceLineRanges(a, b), mergeSourceLineRanges(b, a));
		assert.deepEqual(mergeSourceLineRanges(b, a), { startLine: 3, endLine: 8 });
	});

	test('an end that resolves to nothing leaves the other end in charge', () => {
		// Dragging out of the document — into the front matter panel, past the
		// last block — must not throw the whole jump away.
		assert.deepEqual(mergeSourceLineRanges({ startLine: 4, endLine: 6 }, null), {
			startLine: 4,
			endLine: 6,
		});
		assert.deepEqual(mergeSourceLineRanges(null, { startLine: 4, endLine: 6 }), {
			startLine: 4,
			endLine: 6,
		});
		assert.equal(mergeSourceLineRanges(null, null), null);
	});

	test('a document without front matter needs no shift', () => {
		assert.equal(frontMatterLineOffset('# Title\n\nbody\n'), 0);
	});

	test('the shift is the number of buffer lines above the body', () => {
		const raw = ['---', 'title: "T"', 'tags:', '  - a', '---', '', '# Title'].join('\n') + '\n';
		// The heading is line 7 of the buffer and line 1 of the body.
		assert.equal(frontMatterLineOffset(raw), 6);
		assert.equal(raw.split('\n')[1 + frontMatterLineOffset(raw) - 1], '# Title');
	});

	test('the shift counts CRLF lines the same', () => {
		const raw = ['---', 'title: "T"', '---', '', '# Title'].join('\r\n') + '\r\n';
		assert.equal(frontMatterLineOffset(raw), 4);
		assert.equal(raw.split('\r\n')[1 + frontMatterLineOffset(raw) - 1], '# Title');
	});

	test('a --- that is not front matter shifts nothing', () => {
		// A horizontal rule as the first line is not front matter, and treating it
		// as such would push every jump down by the width of whatever followed.
		const raw = ['---', '', 'Just a rule above some prose.'].join('\n') + '\n';
		assert.equal(frontMatterLineOffset(raw), 0);
	});

	test('the shift is what the module applies, in both directions', () => {
		// The arithmetic itself, called rather than matched. A round trip through
		// the pair has to be the identity, or a position handed from one pane to the
		// other and back walks up the document by the height of the front matter
		// every time it crosses.
		const raw = ['---', 'title: "T"', 'tags:', '  - a', '---', '', '# Title'].join('\n') + '\n';
		const coords = lineCoordinates(raw);
		assert.equal(coords.frontMatterLines, 6);

		assert.equal(coords.toBufferLine(asRendererLine(1)), 7, 'the body starts on buffer line 7');
		assert.equal(coords.toRendererLine(asBufferLine(7)), 1);
		for (const line of [1, 2, 40, 137]) {
			assert.equal(coords.toRendererLine(coords.toBufferLine(asRendererLine(line))), line, `renderer line ${line}`);
			assert.equal(coords.toBufferLine(coords.toRendererLine(asBufferLine(line + 6))), line + 6, `buffer line ${line + 6}`);
		}

		// A range shifts by the same amount at both ends, so it still covers the
		// same text rather than growing or sliding.
		assert.deepEqual(coords.toBufferRange({ startLine: 3, endLine: 9 }), { startLine: 9, endLine: 15 });

		// And a document without front matter is left exactly where it is, which is
		// why the shift went unnoticed for as long as it did.
		const plain = lineCoordinates('# Title\n\nbody\n');
		assert.equal(plain.frontMatterLines, 0);
		assert.deepEqual(plain.toBufferRange({ startLine: 3, endLine: 9 }), { startLine: 3, endLine: 9 });
	});
});
