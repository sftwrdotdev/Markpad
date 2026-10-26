import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { installShimDom, NODE_ELEMENT, NODE_TEXT, parseHtml, type ShimElement, type ShimText } from './renderProtocolDom.ts';

/**
 * Split-view scroll sync with part of the preview folded away.
 *
 * A collapsed fold is `height: 0; overflow: hidden`. Its lines are still in the
 * editor — the editor folds nothing — so the two panes hold the same document
 * at wildly different heights: a section of two hundred source lines occupies
 * zero pixels of preview. `collectLineSamples` already refuses to descend into
 * one, which is what keeps the hidden blocks' offsets (they still report the
 * ones they would have if the fold were open) out of the table.
 *
 * What it did NOT do is say how many lines the fold covers. It contributed a
 * single sample, at the fold's first hidden line, and the next sample was the
 * next visible block at its own line — so the interval between the two spanned
 * the entire hidden range across a margin's worth of pixels, and both
 * directions interpolate across an interval:
 *
 *     preview  98px -> editor line 4.9      <- above the fold
 *     preview 102px -> editor line 13.8     <- hidden
 *     preview 110px -> editor line 22.5     <- hidden
 *     preview 114px -> editor line 31.3     <- hidden
 *     preview 118px -> editor line 40.0     <- the heading after the fold
 *
 * Sixteen pixels of preview scroll dragged the editor through the whole folded
 * section, and everything in between is text the reader cannot see. On a real
 * document that is hundreds of lines for one wheel notch, at every fold, which
 * is the report: "once a block is collapsed in the preview the sync is way
 * off". The other direction had the mirror of it — a hidden line resolved to a
 * pixel somewhere between the fold and the block after it rather than to the
 * fold.
 *
 * The fix is one more sample: a collapsed fold is flat, so it gets a sample at
 * each END of its hidden range, both on its own box. Every line in it then maps
 * to the fold's own position, and the interpolation after the fold runs from
 * its last hidden line to the next block's first — one line, not a section.
 *
 * ---------------------------------------------------------------------------
 * WHAT IS MODELLED HERE
 *
 * `renderProtocolDom.ts` has no layout, so `layOut` below assigns the boxes a
 * browser would — and, unlike the one in `scrollSyncBlockMapping.test.ts`, it
 * knows what a collapsed fold does to them: the wrapper contributes no height
 * to the flow, and its children keep the offsets they would have had inside it,
 * which is exactly what `height: 0; overflow: hidden` produces. The markup is
 * real `processMarkdownHtml` output, folds and all.
 */
describe('scroll sync across folds', async () => {
	installShimDom();

	const { processMarkdownHtml } = await import('../src/lib/utils/markdown.ts');
	const { getPreviewOffsetForSourceLine, getSourceLineAtPreviewOffset } = await import('../src/lib/utils/previewAnchor.ts');
	const { asRendererLine } = await import('../src/lib/utils/lineCoordinates.ts');

	type AnchorNode = Parameters<typeof getSourceLineAtPreviewOffset>[0];
	type Box = { top: number; height: number };

	/** Every line number in this file comes off `data-sourcepos`, so every one is a body line. */
	const bodyLine = asRendererLine;

	const FILE_PATH = '/documents/folded.md';
	const BOXLESS = new Set(['BR', 'WBR']);
	const BLOCK_GAP = 16;
	/** The two boxes `foldState.ts` puts `is-collapsed` on that actually clip content. */
	const COLLAPSIBLE = ['foldable-content-wrapper', 'markdown-alert-content'];

	/* ------------------------------------------------------------------ */
	/* the document                                                        */
	/* ------------------------------------------------------------------ */

	class DocumentBuilder {
		private line = 1;
		private readonly parts: string[] = [];

		blank() {
			this.line += 1;
		}

		heading(level: number, text: string, slug: string) {
			const line = this.line;
			this.parts.push(
				`<h${level} data-sourcepos="${line}:1-${line}:${text.length + level + 1}">` +
					`<a href="#${slug}" aria-hidden="true" class="anchor" id="${slug}"></a>${text}</h${level}>`,
			);
			this.line += 1;
		}

		paragraph(text: string) {
			const line = this.line;
			this.parts.push(`<p data-sourcepos="${line}:1-${line}:${text.length}">${text}</p>`);
			this.line += 1;
		}

		list(items: number) {
			const start = this.line;
			const end = start + items - 1;
			const html = Array.from(
				{ length: items },
				(_, index) => `<li data-sourcepos="${start + index}:1-${start + index}:12">item ${index}</li>`,
			).join('\n');
			this.parts.push(`<ul data-sourcepos="${start}:1-${end}:12">${html}</ul>`);
			this.line = end + 1;
		}

		code(lines: number) {
			const start = this.line;
			const end = start + lines + 1;
			this.parts.push(`<pre data-sourcepos="${start}:1-${end}:3"><code>${'step\n'.repeat(lines)}</code></pre>`);
			this.line = end + 1;
		}

		html() {
			return this.parts.join('\n') + '\n';
		}
	}

	/**
	 * Three chapters, each long enough that folding one is worth hundreds of pixels
	 * and dozens of source lines — the ratio the defect is about.
	 */
	function buildDocument() {
		const doc = new DocumentBuilder();
		doc.paragraph('An introduction, above every chapter.');
		doc.blank();

		for (const chapter of ['one', 'two', 'three']) {
			doc.heading(1, `Chapter ${chapter}`, `chapter-${chapter}`);
			doc.blank();
			for (let index = 0; index < 3; index += 1) {
				doc.paragraph(`Chapter ${chapter} paragraph ${index}, an ordinary sentence of prose.`);
				doc.blank();
			}
			doc.list(4);
			doc.blank();
			doc.heading(2, `Chapter ${chapter} details`, `chapter-${chapter}-details`);
			doc.blank();
			doc.code(6);
			doc.blank();
			doc.paragraph(`Chapter ${chapter} closing remark.`);
			doc.blank();
		}

		doc.paragraph('A closing paragraph, below every chapter.');
		return doc;
	}

	const DOC = buildDocument();

	/* ------------------------------------------------------------------ */
	/* the layout, with the folds in it                                    */
	/* ------------------------------------------------------------------ */

	function elementChildren(node: ShimElement): ShimElement[] {
		return node.childNodes.filter(
			(child): child is ShimElement =>
				child.nodeType === NODE_ELEMENT && !BOXLESS.has((child as ShimElement).tagName),
		);
	}

	function sourceposRange(element: ShimElement): { startLine: number; endLine: number } | null {
		const sourcepos = element.getAttribute('data-sourcepos');
		if (!sourcepos) return null;
		const [start, end] = sourcepos.split('-');
		const startLine = parseInt(start.split(':')[0], 10);
		const endLine = parseInt(end.split(':')[0], 10);
		return Number.isNaN(startLine) || Number.isNaN(endLine) ? null : { startLine, endLine };
	}

	function isAnnotated(element: ShimElement): boolean {
		return !!element.getAttribute('data-sourcepos') || elementChildren(element).some(isAnnotated);
	}

	function leafHeight(element: ShimElement): number {
		const range = sourceposRange(element);
		const lines = range ? Math.max(1, range.endLine - range.startLine + 1) : 1;
		switch (element.tagName) {
			case 'H1':
				return 44;
			case 'H2':
				return 38;
			case 'LI':
				return 26;
			case 'PRE':
				return 20 * lines;
			default:
				return 26 * lines;
		}
	}

	function isCollapsedFold(element: ShimElement): boolean {
		return element.classList.contains('is-collapsed') && COLLAPSIBLE.some((name) => element.classList.contains(name));
	}

	type Preview = {
		body: ShimElement;
		measure: (node: AnchorNode) => Box;
		/** The blocks a reader can actually see, with the box the browser gives them. */
		visible: { element: ShimElement; startLine: number; box: Box }[];
		/** Every collapsed fold: where it sits, and the source lines it swallowed. */
		folds: { element: ShimElement; top: number; startLine: number; endLine: number }[];
		contentHeight: number;
	};

	/**
	 * Lay the document out, then read the two things the assertions need off it.
	 *
	 * A collapsed wrapper takes no height in the flow — everything after it moves
	 * up — while its children are still placed from its top downwards, which is
	 * where a browser puts them and why they must not reach the sample table.
	 */
	function buildPreview(folded: string[]): Preview {
		const body = parseHtml(processMarkdownHtml(DOC.html(), FILE_PATH, new Set(folded))).body;

		const boxes = new Map<ShimElement, Box>();
		const hidden = new Set<ShimElement>();

		function place(element: ShimElement, top: number, insideFold: boolean): number {
			if (insideFold) hidden.add(element);

			const children = elementChildren(element).filter(isAnnotated);
			if (children.length === 0) {
				const height = leafHeight(element);
				boxes.set(element, { top, height });
				return height;
			}

			const collapsed = isCollapsedFold(element);
			let cursor = top;
			children.forEach((child, index) => {
				if (index > 0) cursor += BLOCK_GAP;
				cursor += place(child, cursor, insideFold || collapsed);
			});

			boxes.set(element, { top, height: collapsed ? 0 : cursor - top });
			return collapsed ? 0 : cursor - top;
		}

		let cursor = 0;
		for (const child of elementChildren(body)) {
			if (!isAnnotated(child)) continue;
			cursor += place(child, cursor, false) + BLOCK_GAP;
		}

		const NO_BOX = { top: Number.NaN, height: Number.NaN };
		const visible: Preview['visible'] = [];
		const folds: Preview['folds'] = [];

		const walk = (element: ShimElement) => {
			for (const child of elementChildren(element)) {
				const box = boxes.get(child);
				const range = sourceposRange(child);

				if (isCollapsedFold(child)) {
					const span = range ?? spanOfSubtree(child);
					if (span && box) folds.push({ element: child, top: box.top, ...span });
				} else if (range && box && !hidden.has(child)) {
					visible.push({ element: child, startLine: range.startLine, box });
				}

				walk(child);
			}
		};
		walk(body);

		let contentHeight = 0;
		for (const [element, box] of boxes) {
			if (hidden.has(element)) continue;
			contentHeight = Math.max(contentHeight, box.top + box.height);
		}

		return {
			body,
			measure: (node) => boxes.get(node as ShimElement) ?? NO_BOX,
			visible,
			folds,
			contentHeight,
		};
	}

	/** The lines a container covers, when the container itself carries no range. */
	function spanOfSubtree(element: ShimElement): { startLine: number; endLine: number } | null {
		let start: number | null = null;
		let end: number | null = null;

		const walk = (node: ShimElement) => {
			const range = sourceposRange(node);
			if (range) {
				start = start === null ? range.startLine : Math.min(start, range.startLine);
				end = end === null ? range.endLine : Math.max(end, range.endLine);
			}
			for (const child of elementChildren(node)) walk(child);
		};
		walk(element);

		return start === null || end === null ? null : { startLine: start, endLine: end };
	}

	const EXPANDED = buildPreview([]);
	const ONE_FOLD = buildPreview(['chapter-one']);
	const TWO_FOLDS = buildPreview(['chapter-one', 'chapter-three']);

	/* ------------------------------------------------------------------ */
	/* the fixture                                                         */
	/* ------------------------------------------------------------------ */

	test('folding a chapter costs the preview its height but not the editor its lines', (t) => {
		assert.equal(EXPANDED.folds.length, 0, 'the expanded document has no collapsed fold');
		assert.equal(ONE_FOLD.folds.length, 1);
		assert.equal(TWO_FOLDS.folds.length, 2);

		const [fold] = ONE_FOLD.folds;
		t.diagnostic(
			`one fold hides source lines ${fold.startLine}-${fold.endLine} and ` +
				`${Math.round(EXPANDED.contentHeight - ONE_FOLD.contentHeight)}px of preview`,
		);

		// The premise: many source lines, no pixels. A fixture where the fold hid a
		// line or two would pass every assertion below by accident.
		assert.ok(fold.endLine - fold.startLine > 20, 'the fold must hide a section, not a paragraph');
		assert.ok(EXPANDED.contentHeight - ONE_FOLD.contentHeight > 300, 'the fold must be worth real height');
		assert.equal(ONE_FOLD.measure(fold.element as AnchorNode).height, 0, 'a collapsed fold is zero pixels tall');
	});

	/* ------------------------------------------------------------------ */
	/* a line INSIDE a fold                                                */
	/* ------------------------------------------------------------------ */

	test('every line inside a collapsed fold maps to the fold, not past it', () => {
		for (const preview of [ONE_FOLD, TWO_FOLDS]) {
			for (const fold of preview.folds) {
				for (let line = fold.startLine; line <= fold.endLine; line += 1) {
					const offset = getPreviewOffsetForSourceLine(preview.body, bodyLine(line), preview.measure);
					assert.equal(
						offset,
						fold.top,
						`hidden line ${line} of ${fold.startLine}-${fold.endLine} resolved to ${offset}px, ` +
							`and the fold is at ${fold.top}px`,
					);
				}
			}
		}
	});

	test('the editor scrolling through a folded section leaves the preview on the fold', () => {
		// The whole of the hidden range is one position, so the preview must not
		// creep towards the next block as the editor works through it. Creeping is
		// what the single sample did: it interpolated the hidden lines across the
		// margin between the fold and the block after it.
		const [fold] = ONE_FOLD.folds;
		const offsets = new Set<number>();
		for (let line = fold.startLine; line <= fold.endLine; line += 1) {
			offsets.add(getPreviewOffsetForSourceLine(ONE_FOLD.body, bodyLine(line), ONE_FOLD.measure)!);
		}

		assert.deepEqual([...offsets], [fold.top], `the hidden lines resolved to ${offsets.size} different offsets`);
	});

	/* ------------------------------------------------------------------ */
	/* the preview crossing a fold                                         */
	/* ------------------------------------------------------------------ */

	test('scrolling the preview past a fold never sends the editor into it', () => {
		// The report, in the direction the reader notices it. Every pixel from well
		// above a fold to well below it: the editor may be sent to the lines either
		// side of the hidden range, and must never be sent into the middle of it —
		// that is text the preview is not showing at any of these offsets.
		for (const preview of [ONE_FOLD, TWO_FOLDS]) {
			for (const fold of preview.folds) {
				for (let offset = fold.top - 200; offset <= fold.top + 200; offset += 1) {
					if (offset < 0) continue;
					const line = getSourceLineAtPreviewOffset(preview.body, offset, preview.measure);
					assert.ok(line !== null, `offset ${offset} must resolve to a line`);
					assert.ok(
						line <= fold.startLine || line >= fold.endLine,
						`preview ${offset}px (the fold is at ${fold.top}px) resolved to line ${line.toFixed(1)}, ` +
							`which is inside the hidden range ${fold.startLine}-${fold.endLine}`,
					);
				}
			}
		}
	});

	/* ------------------------------------------------------------------ */
	/* a line BELOW a fold                                                 */
	/* ------------------------------------------------------------------ */

	test('a block below a fold is where the mapping says it is, in both directions', () => {
		for (const [name, preview] of [
			['expanded', EXPANDED],
			['one fold', ONE_FOLD],
			['two folds', TWO_FOLDS],
		] as const) {
			for (const block of preview.visible) {
				// Only the blocks that own their first line: a `<ul>` and its first
				// `<li>` share one, and the table keeps the inner of the two.
				if (preview.visible.filter((other) => other.startLine === block.startLine).length > 1) continue;

				const offset = getPreviewOffsetForSourceLine(preview.body, bodyLine(block.startLine), preview.measure);
				assert.equal(
					offset,
					block.box.top,
					`${name}: line ${block.startLine} is drawn at ${block.box.top}px and resolved to ${offset}px`,
				);

				const line = getSourceLineAtPreviewOffset(preview.body, block.box.top, preview.measure);
				assert.equal(
					line,
					block.startLine,
					`${name}: ${block.box.top}px is line ${block.startLine} and resolved to ${line}`,
				);
			}
		}
	});

	/* ------------------------------------------------------------------ */
	/* nothing about an unfolded document changes                          */
	/* ------------------------------------------------------------------ */

	test('with everything expanded the mapping is untouched', () => {
		// The guard on the fix: the extra sample exists only inside the collapsed
		// branch, so a document with nothing folded must round-trip exactly as it
		// did — no snapping, no quantisation, at any pixel.
		for (let offset = 0; offset <= EXPANDED.contentHeight; offset += 7) {
			const line = getSourceLineAtPreviewOffset(EXPANDED.body, offset, EXPANDED.measure);
			assert.ok(line !== null);

			const back = getPreviewOffsetForSourceLine(EXPANDED.body, bodyLine(line), EXPANDED.measure);
			assert.ok(back !== null);
			// Inside a block the round trip is exact; in the margin between two it
			// snaps to the nearer edge, which is the block mapping's own quantisation
			// and is asserted in `scrollSyncBlockMapping.test.ts`.
			assert.ok(
				Math.abs(back - offset) <= BLOCK_GAP,
				`expanded: ${offset}px -> line ${line.toFixed(2)} -> ${back}px`,
			);
		}
	});

	test('the mapping still only ever moves forwards, with folds in the document', () => {
		// #433's failure shape, re-asserted over a folded document: a fold must not
		// make a lower pixel report a higher line, or the paired pane jumps
		// backwards as the reader scrolls down.
		for (const preview of [ONE_FOLD, TWO_FOLDS]) {
			let previousLine = -Infinity;
			for (let offset = 0; offset <= preview.contentHeight; offset += 3) {
				const line = getSourceLineAtPreviewOffset(preview.body, offset, preview.measure);
				assert.ok(line !== null);
				assert.ok(line >= previousLine, `${offset}px reported line ${line}, after ${previousLine}`);
				previousLine = line;
			}
		}
	});
});

/**
 * Split-view scroll sync: does the pane the reader is not touching show the
 * same part of the document?
 *
 * The mapping used to be a ratio — the sending pane's share of its own scroll
 * range became the receiving pane's share of its. That cannot be right in
 * general. Forty source lines of table render as one tall block and forty of
 * prose as a short one, so equal progress through the source is not equal
 * progress through the rendered height, and the error accumulates towards the
 * end of the document. That is the surviving half of #205: the reporter sees
 * the panes "quite a few lines off" at the end of a document full of tables.
 *
 * So the unit of the measurement here is a SOURCE LINE, not a pixel. Every test
 * drives the real mapping in one direction and then asks the receiving pane
 * which source line it is now showing:
 *
 *   editor scrollTop -> line -> ScrollSyncPosition -> preview scrollTop -> line
 *
 * `ratioOnly` re-runs the same sweep with the `line` field stripped out of the
 * position, which is exactly the pre-fix mapping, and is kept as the control:
 * if the block mapping ever collapses back into a proportional one the two
 * drift figures collapse into each other.
 *
 * ---------------------------------------------------------------------------
 * WHAT THE DOM SHIM CANNOT MODEL, AND WHAT IS DONE ABOUT IT
 *
 * `renderProtocolDom.ts` has no layout whatsoever — `grep -rn offsetTop
 * scripts/` finds nothing — which is why #464's defect (anchors resolving to a
 * boxless `<br>`) survived a suite that scored 100%. A mapping from pixels to
 * lines is nothing BUT layout, so a test that only walked the shim would be
 * measuring the same nothing.
 *
 * The layout is therefore injected. `layOut` below assigns every rendered block
 * a top and a height, bottom-up, and `getSourceLineAtPreviewOffset` /
 * `getPreviewOffsetForSourceLine` take that as the `measure` callback — the
 * same parameter the browser fills with `offsetTop` / `offsetHeight`. What is
 * asserted is the mapping's arithmetic and its choice of element over real
 * `processMarkdownHtml` output; what is NOT asserted is that a browser lays a
 * table out the way `leafHeight` says. The property under test does not
 * depend on the specific numbers, only on rendered height not being
 * proportional to source lines, which is the premise of the bug.
 */
describe('scroll sync block mapping', async () => {
	installShimDom();

	const { processMarkdownHtml } = await import('../src/lib/utils/markdown.ts');
	const { getPreviewOffsetForSourceLine, getSourceLineAtPreviewOffset, measureAnchorBox } = await import(
		'../src/lib/utils/previewAnchor.ts'
	);
	type OffsetLayoutNode = Parameters<typeof measureAnchorBox>[0];
	const {
		getLineAtVerticalOffset,
		getScrollSyncPositionFromPixels,
		getScrollTopForSyncPosition,
		getVerticalOffsetForLine,
	} = await import('../src/lib/utils/scrollSync.ts');

	const { asBufferLine, asRendererLine, lineCoordinates } = await import('../src/lib/utils/lineCoordinates.ts');

	type AnchorNode = Parameters<typeof getSourceLineAtPreviewOffset>[0];
	type ScrollSyncPosition = Parameters<typeof getScrollTopForSyncPosition>[0];
	type LineCoordinates = ReturnType<typeof lineCoordinates>;

	/**
	 * A line written the way `data-sourcepos` writes it: counted from the first
	 * line of the body. Every literal line number in this file is one, because
	 * every fixture below is built out of that attribute.
	 */
	const bodyLine = asRendererLine;

	/** The coordinates of a document with no front matter, where the two numberings coincide. */
	const NO_FRONT_MATTER = lineCoordinates('# A document with no front matter\n');

	const FILE_PATH = '/documents/stress.md';

	/* ------------------------------------------------------------------ */
	/* a document whose rendered height is not proportional to its source  */
	/* ------------------------------------------------------------------ */

	class DocumentBuilder {
		private line = 1;
		private readonly parts: string[] = [];

		private push(html: string, lines: number) {
			this.parts.push(html);
			this.line += lines;
		}

		blank() {
			this.line += 1;
		}

		heading(level: number, text: string, slug: string) {
			const line = this.line;
			this.push(
				`<h${level} data-sourcepos="${line}:1-${line}:${text.length + level + 1}">` +
					`<a href="#${slug}" aria-hidden="true" class="anchor" id="${slug}"></a>${text}</h${level}>`,
				1,
			);
		}

		paragraph(text: string) {
			const line = this.line;
			this.push(`<p data-sourcepos="${line}:1-${line}:${text.length}">${text}</p>`, 1);
		}

		/**
		 * A pipe table: a header line, a separator line, then one source line per
		 * row. comrak stamps a source range on the table, on every row and on every
		 * cell — which is why the mapping descends inside a table at all, and why
		 * the offsets those elements report are the ones that matter (see
		 * `offsetParentOf`).
		 */
		table(rows: number, label: string) {
			const start = this.line;
			const end = start + rows + 1;
			const cell = (line: number, text: string, column: number, tag: 'td' | 'th') =>
				`<${tag} data-sourcepos="${line}:${column}-${line}:${column + text.length}">${text}</${tag}>`;
			const row = (line: number, cells: string, columns: number) =>
				`<tr data-sourcepos="${line}:1-${line}:${columns}">${cells}</tr>`;

			const body = Array.from({ length: rows }, (_, index) => {
				const line = start + 2 + index;
				return row(line, cell(line, `${label} ${index}`, 1, 'td') + cell(line, `value ${index}`, 11, 'td'), 20);
			}).join('');

			this.push(
				`<table data-sourcepos="${start}:1-${end}:20"><thead>` +
					row(start, cell(start, label, 1, 'th') + cell(start, 'value', 11, 'th'), 20) +
					`</thead><tbody>${body}</tbody></table>`,
				end - start + 1,
			);
		}

		/** One source line for a block that renders hundreds of pixels tall. */
		image(alt: string) {
			const line = this.line;
			// An absolute URL: `processMarkdownHtml` rewrites relative image paths
			// through Tauri's `convertFileSrc`, which needs a `window` the shim has no
			// reason to provide. The layout is what this fixture is about.
			this.push(`<p data-sourcepos="${line}:1-${line}:40"><img src="https://example.invalid/${alt}.png" alt="${alt}" /></p>`, 1);
		}

		code(lines: number, label: string) {
			const start = this.line;
			const end = start + lines + 1;
			const body = Array.from({ length: lines }, (_, index) => `${label} step ${index}`).join('\n');
			this.push(`<pre data-sourcepos="${start}:1-${end}:3"><code class="language-sh">${body}\n</code></pre>`, end - start + 1);
		}

		list(items: string[]) {
			const start = this.line;
			const end = start + items.length - 1;
			const html = items
				.map((item, index) => `<li data-sourcepos="${start + index}:1-${start + index}:${item.length + 2}">${item}</li>`)
				.join('\n');
			this.push(`<ul data-sourcepos="${start}:1-${end}:20">\n${html}\n</ul>`, items.length);
		}

		/** `render.hardbreaks` is on, so soft-wrapped prose ends every line but the last in a `<br>`. */
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
			this.push(`<p data-sourcepos="${start}:1-${end}:${lines[lines.length - 1].length}">${html}</p>`, lines.length);
		}

		get lineCount() {
			return this.line - 1;
		}

		html() {
			return this.parts.join('\n') + '\n';
		}
	}

	/**
	 * The reporter's shape: prose for most of the document, then a run of tables,
	 * figures and code listings — a great deal of rendered height for very few
	 * source lines — near the end. The proportional mapping spends the preview's
	 * last pixels on those blocks while the editor is still spending source lines
	 * at a steady rate, so the two disagree by more and more the further down the
	 * reader goes. That is why what gets noticed is the END of the document.
	 */
	function buildStressDocument() {
		const doc = new DocumentBuilder();
		doc.paragraph('An introduction before anything else.');
		doc.blank();

		for (let section = 1; section <= 30; section += 1) {
			doc.heading(2, `Prose section ${section}`, `prose-section-${section}`);
			doc.blank();
			doc.wrappedParagraph([
				`Prose ${section} first line, the kind of sentence an author soft-wraps.`,
				`Prose ${section} second line, still inside the same markdown block.`,
				`Prose ${section} third line, closing the paragraph off.`,
			]);
			doc.blank();
			doc.list([`point ${section} one`, `point ${section} two`, `point ${section} three`]);
			doc.blank();
			doc.paragraph(`Prose ${section} closing remark.`);
			doc.blank();
		}

		for (let section = 1; section <= 10; section += 1) {
			doc.heading(2, `Table section ${section}`, `table-section-${section}`);
			doc.blank();
			doc.paragraph(`Prose introducing table ${section}.`);
			doc.blank();
			doc.table(14, `row ${section}`);
			doc.blank();
			doc.image(`figure-${section}`);
			doc.blank();
			doc.code(6, `deploy-${section}`);
			doc.blank();
		}

		return doc;
	}

	/* ------------------------------------------------------------------ */
	/* the layout the shim does not have                                   */
	/* ------------------------------------------------------------------ */

	const BOXLESS = new Set(['BR', 'WBR']);
	const BLOCK_GAP = 16;
	const TABLE_INTERNALS = new Set(['TABLE', 'THEAD', 'TBODY']);

	/** Height of a block that has no laid-out children, in the units a browser would use. */
	function leafHeight(element: ShimElement, sourceLines: number): number {
		switch (element.tagName) {
			case 'H1':
				return 44;
			case 'H2':
				return 38;
			case 'H3':
				return 32;
			// A cell is a line of text and the padding around it, which is why a
			// table is taller than the same number of source lines of prose.
			case 'TD':
			case 'TH':
				return 34;
			case 'PRE':
				return 20 * sourceLines;
			case 'LI':
				return 26;
			default:
				// A paragraph holding nothing but an image is one source line and a
				// picture; ordinary prose is a line box per source line.
				return element.querySelectorAll('img').length > 0 ? 360 : 26 * sourceLines;
		}
	}

	function elementChildren(node: ShimElement): ShimElement[] {
		return node.childNodes.filter(
			(child): child is ShimElement => child.nodeType === NODE_ELEMENT && !BOXLESS.has((child as ShimElement).tagName),
		);
	}

	function sourceLineSpan(element: ShimElement): number {
		const sourcepos = element.getAttribute('data-sourcepos');
		if (!sourcepos) return 1;
		const [start, end] = sourcepos.split('-');
		const startLine = parseInt(start.split(':')[0], 10);
		const endLine = parseInt(end.split(':')[0], 10);
		return Number.isNaN(startLine) || Number.isNaN(endLine) ? 1 : Math.max(1, endLine - startLine + 1);
	}

	/** Does anything in here carry a source range? Non-participants get no box. */
	function startLineOf(element: ShimElement): number | null {
		const sourcepos = element.getAttribute('data-sourcepos');
		if (!sourcepos) return null;
		const line = parseInt(sourcepos.split('-')[0].split(':')[0], 10);
		return Number.isNaN(line) ? null : line;
	}

	function isLineAnchor(element: ShimElement): boolean {
		return element.getAttribute('class') === 'source-line-anchor';
	}

	function isAnnotated(element: ShimElement): boolean {
		if (element.getAttribute('data-sourcepos')) return true;
		return elementChildren(element).some(isAnnotated);
	}

	type Box = { top: number; height: number };

	/**
	 * Assign every annotated block a top and a height, laying children out in
	 * document order inside their parent. Bottom-up, so a container's box really
	 * does contain its children's — the one property a browser guarantees and the
	 * mapping's descent relies on.
	 */
	function layOut(root: ShimElement, startTop = 0, gap = BLOCK_GAP): Map<ShimElement, Box> {
		const boxes = new Map<ShimElement, Box>();

		function place(element: ShimElement, top: number): number {
			// Soft-line anchors sit inline with zero size, so a browser gives them
			// an `offsetTop` without letting them take any vertical space. They are
			// positioned by their owning block below, after its own height is
			// known — laying them out here instead would stack them like blocks and
			// stretch every wrapped paragraph by one per line.
			const children = elementChildren(element).filter(isAnnotated).filter((child) => !isLineAnchor(child));

			if (children.length === 0) {
				const height = leafHeight(element, sourceLineSpan(element));
				boxes.set(element, { top, height });
				return height;
			}

			// A row's cells sit side by side: they share its top, and it is as tall as
			// the tallest of them.
			if (element.tagName === 'TR') {
				let height = 0;
				for (const child of children) height = Math.max(height, place(child, top));
				boxes.set(element, { top, height });
				return height;
			}

			// Nothing inside a table is separated by a collapsing margin.
			const inner = TABLE_INTERNALS.has(element.tagName) ? 0 : gap;

			let cursor = top;
			children.forEach((child, index) => {
				if (index > 0) cursor += inner;
				cursor += place(child, cursor);
			});

			const height = cursor - top;
			boxes.set(element, { top, height });
			return height;
		}

		let cursor = startTop;
		for (const child of elementChildren(root)) {
			if (!isAnnotated(child)) continue;
			cursor += place(child, cursor) + gap;
		}

		// Now that every block has a box, give the anchors one. A browser puts each
		// on the rendered row its source line starts, and in THIS document every
		// source line of a paragraph is the same height — so that row is exactly
		// where the block-wide interpolation already points. The anchors therefore
		// change none of the numbers here, which is the point: this file's premise
		// is that rendered height is not proportional to SOURCE lines across block
		// types, not that a paragraph wraps unevenly.
		for (const [block, box] of Array.from(boxes)) {
			const span = sourceLineSpan(block);
			if (span < 2) continue;
			const start = startLineOf(block);
			if (start === null) continue;

			for (const anchor of block.querySelectorAll('.source-line-anchor')) {
				if (anchor.parentElement?.closest('[data-sourcepos]') !== block) continue;
				const line = startLineOf(anchor);
				if (line === null) continue;
				// A paragraph here is `26 * sourceLines` tall, so dividing by the
				// line count puts each anchor exactly on its own rendered row.
				boxes.set(anchor, {
					top: box.top + (box.height * (line - start)) / span,
					height: 0,
				});
			}
		}

		return boxes;
	}

	/* ------------------------------------------------------------------ */
	/* the two panes                                                       */
	/* ------------------------------------------------------------------ */

	const VIEWPORT = 800;
	const EDITOR_LINE_HEIGHT = 19;

	/* ------------------------------------------------------------------ */
	/* offset parents: the other thing the shim does not have              */
	/* ------------------------------------------------------------------ */

	/**
	 * `offsetTop` is not the distance to the top of the scroll content. It is the
	 * distance to the element's OFFSET PARENT, which CSSOM defines as the nearest
	 * positioned ancestor — OR the nearest `table`, `td` or `th`, positioned or
	 * not. Laying the document out as one stack of absolute tops, which is all the
	 * `measure` callback used to be handed, models a preview that contains neither.
	 * The real one contains both, and #205's remaining comments are what that costs.
	 *
	 * So the boxes below are converted into what a browser would actually report,
	 * and the production `measureAnchorBox` is what converts them back.
	 */
	function offsetParentOf(element: ShimElement, root: ShimElement): ShimElement {
		for (let parent = element.parentElement; parent && parent !== root; parent = parent.parentElement) {
			// A table is the offset parent of its own rows and cells...
			if (parent.tagName === 'TABLE' || parent.tagName === 'TD' || parent.tagName === 'TH') return parent;
			// ...and `.code-block-shell`, which `renderRichContent` wraps every code
			// block in for the copy button, is `position: relative`.
			if (parent.classList.contains('code-block-shell')) return parent;
		}
		return root;
	}

	type Preview = {
		body: ShimElement;
		/** What the app measures: `measureAnchorBox` over browser-shaped offsets. */
		measure: (node: AnchorNode) => Box;
		/** The control: `offsetTop` read raw, which is what the app used to do. */
		rawMeasure: (node: AnchorNode) => Box;
		contentHeight: number;
		scrollMax: number;
	};

	/**
	 * `frontMatterHeight` is the front-matter panel: the preview renders one above
	 * the document, it carries no source range, and every rendered block therefore
	 * starts that many pixels further down. Nothing else about the mapping changes,
	 * which is the property the front-matter test below is after.
	 */
	function buildPreview(doc: DocumentBuilder, gap = BLOCK_GAP, frontMatterHeight = 0): Preview {
		const body = parseHtml(processMarkdownHtml(doc.html(), FILE_PATH, new Set<string>())).body;
		wrapCodeBlocks(body);
		const boxes = layOut(body, frontMatterHeight, gap);

		let contentHeight = 0;
		for (const box of boxes.values()) contentHeight = Math.max(contentHeight, box.top + box.height);

		const NO_BOX = { top: Number.NaN, height: Number.NaN };
		const layouts = new Map<ShimElement, OffsetLayoutNode>();

		function layoutOf(element: ShimElement): OffsetLayoutNode {
			const existing = layouts.get(element);
			if (existing) return existing;

			if (element === body) {
				const root = { offsetTop: 0, offsetHeight: contentHeight, offsetParent: null };
				layouts.set(element, root);
				return root;
			}

			const parent = offsetParentOf(element, body);
			const parentTop = parent === body ? 0 : (boxes.get(parent) ?? NO_BOX).top;
			const box = boxes.get(element) ?? NO_BOX;
			const node = {
				offsetTop: box.top - parentTop,
				offsetHeight: box.height,
				offsetParent: layoutOf(parent),
			};
			layouts.set(element, node);
			return node;
		}

		return {
			body,
			measure: (node) => measureAnchorBox(layoutOf(node as ShimElement), layoutOf(body)),
			rawMeasure: (node) => {
				const layout = layoutOf(node as ShimElement);
				return { top: layout.offsetTop, height: layout.offsetHeight };
			},
			contentHeight,
			scrollMax: Math.max(0, contentHeight - VIEWPORT),
		};
	}

	/**
	 * What `renderRichContent` does to every code block on its way into the
	 * preview: a `position: relative` shell around the `<pre>`, so the copy button
	 * has something to sit in. `processMarkdownHtml` does not do it, so a fixture
	 * built from that alone has no positioned ancestor anywhere in it.
	 */
	function wrapCodeBlocks(body: ShimElement) {
		for (const pre of body.querySelectorAll('pre')) {
			const shell = body.ownerDocument!.createElement('div');
			shell.className = 'code-block-shell';
			pre.replaceWith(shell);
			shell.appendChild(pre);
		}
	}

	type Editor = {
		lineCount: number;
		topForLine: (line: number) => number;
		scrollMax: number;
	};

	/**
	 * `frontMatterLines` are buffer lines above the body: the editor holds them,
	 * the preview renders them as a panel with no source range of its own, and
	 * every line number the two panes exchange differs by exactly that many.
	 */
	function buildEditor(doc: DocumentBuilder, frontMatterLines = 0): Editor {
		const lineCount = doc.lineCount + frontMatterLines;
		return {
			lineCount,
			topForLine: (line) => (line - 1) * EDITOR_LINE_HEIGHT,
			scrollMax: Math.max(0, lineCount * EDITOR_LINE_HEIGHT - VIEWPORT),
		};
	}

	/* --------------------------------------------------- the shipped mapping */
	//
	// These four functions are the arithmetic of `getEditorScrollSyncPosition`,
	// `syncScrollToPosition`, `getPreviewScrollSyncPosition` and
	// `scrollPreviewToSyncPosition`, over injected measurements instead of Monaco
	// and the DOM. Everything they call is imported from `src/` — including the
	// front-matter shift, which the preview pair used to leave out entirely
	// because it re-implemented the viewer's glue rather than calling it.

	function editorPositionAt(editor: Editor, scrollTop: number, frontMatterEnd = 0): ScrollSyncPosition {
		const position = getScrollSyncPositionFromPixels(scrollTop, editor.scrollMax, frontMatterEnd);
		if (position.section !== 'body') return position;

		// Monaco counts from the first line of the file, so this is a buffer line.
		const line = asBufferLine(getLineAtVerticalOffset(scrollTop, editor.lineCount, editor.topForLine));
		return Number.isFinite(line) ? { ...position, line } : position;
	}

	/**
	 * `clamped` is the part of the answer the components throw away. A pane that
	 * has run out of scroll range cannot honour the position it was sent, and the
	 * two panes disagreeing there is not the mapping being wrong — every mapping
	 * ends up at the bottom of a pane that is already at the bottom. The drift
	 * measurements below therefore skip those, and assert the ends separately.
	 */
	function editorScrollTopFor(
		editor: Editor,
		position: ScrollSyncPosition,
		frontMatterEnd = 0,
	): { scrollTop: number; clamped: boolean } {
		let target: number | null = null;

		if (position.section === 'body' && position.line !== undefined) {
			const offset = getVerticalOffsetForLine(position.line, editor.lineCount, editor.topForLine);
			if (Number.isFinite(offset)) target = offset;
		}

		if (target === null) target = getScrollTopForSyncPosition(position, editor.scrollMax, frontMatterEnd);

		const scrollTop = Math.max(0, Math.min(editor.scrollMax, target));
		return { scrollTop, clamped: scrollTop !== target };
	}

	function previewPositionAt(
		preview: Preview,
		scrollTop: number,
		frontMatterEnd = 0,
		coords: LineCoordinates = NO_FRONT_MATTER,
	): ScrollSyncPosition {
		const position = getScrollSyncPositionFromPixels(scrollTop, preview.scrollMax, frontMatterEnd);
		if (position.section !== 'body') return position;

		const line = coords.bufferLineAtPreviewOffset(preview.body, scrollTop, preview.measure);
		return line === null ? position : { ...position, line };
	}

	function previewScrollTopFor(
		preview: Preview,
		position: ScrollSyncPosition,
		frontMatterEnd = 0,
		coords: LineCoordinates = NO_FRONT_MATTER,
	): { scrollTop: number; clamped: boolean } {
		let target: number | null = null;

		if (position.section === 'body' && position.line !== undefined) {
			const offset = coords.previewOffsetForBufferLine(preview.body, position.line, preview.measure);
			if (offset !== null) target = offset;
		}

		if (target === null) target = getScrollTopForSyncPosition(position, preview.scrollMax, frontMatterEnd);

		const scrollTop = Math.max(0, Math.min(preview.scrollMax, target));
		return { scrollTop, clamped: scrollTop !== target };
	}

	/** The pre-fix mapping: the same position with the source line taken away. */
	function ratioOnly(position: ScrollSyncPosition): ScrollSyncPosition {
		return { section: position.section, ratio: position.ratio };
	}

	/* ------------------------------------------------------------------ */
	/* fixtures                                                            */
	/* ------------------------------------------------------------------ */

	const DOC = buildStressDocument();
	const PREVIEW = buildPreview(DOC);
	const EDITOR = buildEditor(DOC);

	/** Which source line each pane is showing at the top of its viewport. */
	function editorLineAt(scrollTop: number): number {
		return getLineAtVerticalOffset(scrollTop, EDITOR.lineCount, EDITOR.topForLine);
	}

	function previewLineAt(scrollTop: number): number {
		const line = getSourceLineAtPreviewOffset(PREVIEW.body, scrollTop, PREVIEW.measure);
		assert.ok(line !== null, `the preview must resolve a source line at ${scrollTop}px`);
		return line;
	}

	function sweep(scrollMax: number, from: number, to: number, steps: number): number[] {
		const out: number[] = [];
		for (let index = 0; index <= steps; index += 1) {
			out.push(scrollMax * (from + ((to - from) * index) / steps));
		}
		return out;
	}

	/* ------------------------------------------------------------------ */
	/* the fixture itself                                                  */
	/* ------------------------------------------------------------------ */

	test('the fixture renders at a height the source lines do not predict', (t) => {
		t.diagnostic(`${DOC.lineCount} source lines, preview content ${Math.round(PREVIEW.contentHeight)}px`);

		// Where a ratio goes wrong: half the source is in the first 8 sections, but
		// those sections take far more than half the rendered height.
		const halfway = previewLineAt(PREVIEW.scrollMax / 2);
		const proportionalGuess = DOC.lineCount / 2;

		t.diagnostic(`preview halfway shows source line ${Math.round(halfway)}, a ratio would say ${Math.round(proportionalGuess)}`);
		assert.ok(
			Math.abs(halfway - proportionalGuess) > 25,
			'the fixture must not be one where rendered height happens to track source lines, ' +
				`got ${Math.round(halfway)} vs ${Math.round(proportionalGuess)}`,
		);
	});

	/* ------------------------------------------------------------------ */
	/* the complaint: the end of the document                              */
	/* ------------------------------------------------------------------ */

	/**
	 * Drive one pane, read the other, and report the disagreement in source lines.
	 * This is the reporter's measurement: "when reaching the end of the file it is
	 * quite a few lines off".
	 */
	function driftEditorToPreview(scrollTops: number[], strip: boolean) {
		let worst = 0;
		let worstAt = 0;

		for (const scrollTop of scrollTops) {
			const sent = editorPositionAt(EDITOR, scrollTop);
			const preview = previewScrollTopFor(PREVIEW, strip ? ratioOnly(sent) : sent);
			if (preview.clamped) continue;

			const drift = Math.abs(previewLineAt(preview.scrollTop) - editorLineAt(scrollTop));
			if (drift > worst) {
				worst = drift;
				worstAt = scrollTop;
			}
		}

		return { worst, worstAt };
	}

	// The editor's anchor lands part way down a source line and the preview's part
	// way down a rendered block, so the two can differ by the fraction of a line
	// their interpolations meet at.
	const LINE_SLACK = 1;

	test('the tail of the document stays on the same source line', (t) => {
		// The last part of the document that both panes can still scroll to. The
		// final screenful is asserted separately below, because there both mappings
		// simply run out of range.
		const tail = sweep(EDITOR.scrollMax, 0.6, 1, 60);

		const blockMapping = driftEditorToPreview(tail, false);
		const ratioMapping = driftEditorToPreview(tail, true);

		t.diagnostic(`ratio mapping: worst drift ${ratioMapping.worst.toFixed(1)} source lines`);
		t.diagnostic(`block mapping: worst drift ${blockMapping.worst.toFixed(1)} source lines`);

		// The control. If this ever falls to the block mapping's figure, the block
		// mapping has collapsed back into a proportional one and the assertion below
		// stopped meaning anything.
		assert.ok(
			ratioMapping.worst > 20,
			`the proportional mapping is expected to be far off near the end of this document, got ${ratioMapping.worst.toFixed(1)} lines`,
		);

		assert.ok(
			blockMapping.worst <= LINE_SLACK,
			`the preview drifted ${blockMapping.worst.toFixed(1)} source lines from the editor at ` +
				`scrollTop ${Math.round(blockMapping.worstAt)} (of ${Math.round(EDITOR.scrollMax)})`,
		);
	});

	test('every part of the document stays on the same source line, not only the tail', (t) => {
		const whole = sweep(EDITOR.scrollMax, 0, 1, 200);

		const blockMapping = driftEditorToPreview(whole, false);
		const ratioMapping = driftEditorToPreview(whole, true);

		t.diagnostic(`ratio mapping: worst drift ${ratioMapping.worst.toFixed(1)} source lines`);
		t.diagnostic(`block mapping: worst drift ${blockMapping.worst.toFixed(1)} source lines`);

		assert.ok(ratioMapping.worst > 20, `control: got ${ratioMapping.worst.toFixed(1)} lines`);
		assert.ok(
			blockMapping.worst <= LINE_SLACK,
			`the preview drifted ${blockMapping.worst.toFixed(1)} source lines at scrollTop ${Math.round(blockMapping.worstAt)}`,
		);
	});

	test('driving the preview lands the editor on the same source line', (t) => {
		let worst = 0;
		let worstAt = 0;

		for (const scrollTop of sweep(PREVIEW.scrollMax, 0, 1, 200)) {
			const sent = previewPositionAt(PREVIEW, scrollTop);
			const editor = editorScrollTopFor(EDITOR, sent);
			if (editor.clamped) continue;

			const drift = Math.abs(editorLineAt(editor.scrollTop) - previewLineAt(scrollTop));
			if (drift > worst) {
				worst = drift;
				worstAt = scrollTop;
			}
		}

		t.diagnostic(`preview -> editor: worst drift ${worst.toFixed(1)} source lines`);
		assert.ok(
			worst <= LINE_SLACK,
			`the editor drifted ${worst.toFixed(1)} source lines at preview scrollTop ${Math.round(worstAt)}`,
		);
	});

	/* ------------------------------------------------------------------ */
	/* the same document, with front matter above it                       */
	/* ------------------------------------------------------------------ */
	//
	// Everything above this point is a document with no front matter, where the
	// editor's line numbers and `data-sourcepos`'s are the same numbers — so the
	// conversion between them could be left out entirely and every measurement
	// above would still pass. It was left out, in this file: the glue here used to
	// be a copy of the viewer's rather than a call into it, and the copy had no
	// shift in it at all.
	//
	// The same fixture, then, with six buffer lines of YAML above the body and the
	// panel the preview renders for them. Nothing about the block mapping changes;
	// what changes is that a pane which forgets to convert is now six lines out,
	// everywhere, uniformly.

	const FRONT_MATTER_LINES = 6;
	const FM_COORDS = lineCoordinates(['---', 'title: "T"', 'tags:', '  - a', '---', '', '# Heading'].join('\n') + '\n');
	/** The rendered front-matter panel: a fixed height, and no source range at all. */
	const FM_PANEL = 180;

	const FM_PREVIEW = buildPreview(DOC, BLOCK_GAP, FM_PANEL);
	const FM_EDITOR = buildEditor(DOC, FRONT_MATTER_LINES);
	const FM_EDITOR_END = FRONT_MATTER_LINES * EDITOR_LINE_HEIGHT;

	/** Which BODY line each pane is showing, which is the only thing they can be compared on. */
	function fmEditorBodyLineAt(scrollTop: number): number {
		const line = getLineAtVerticalOffset(scrollTop, FM_EDITOR.lineCount, FM_EDITOR.topForLine);
		return FM_COORDS.toRendererLine(asBufferLine(line));
	}

	function fmPreviewBodyLineAt(scrollTop: number): number {
		const line = getSourceLineAtPreviewOffset(FM_PREVIEW.body, scrollTop, FM_PREVIEW.measure);
		assert.ok(line !== null, `the preview must resolve a source line at ${scrollTop}px`);
		return line;
	}

	test('the fixture has front matter in both panes, of different heights', () => {
		assert.equal(FM_COORDS.frontMatterLines, FRONT_MATTER_LINES);
		assert.equal(FM_EDITOR.lineCount, DOC.lineCount + FRONT_MATTER_LINES);
		// The preview's panel and the editor's six lines of text are not the same
		// number of pixels, which is the reason `scrollSync.ts` splits the range at
		// the boundary instead of carrying a single ratio.
		assert.notEqual(FM_PANEL, FM_EDITOR_END);
		assert.equal(FM_PREVIEW.measure(FM_PREVIEW.body.querySelectorAll('p')[0]).top, FM_PANEL);
	});

	test('with front matter the panes still show the same body line', (t) => {
		let worst = 0;
		let worstAt = 0;
		let unconverted = 0;

		for (const scrollTop of sweep(FM_EDITOR.scrollMax, 0, 1, 200)) {
			if (scrollTop <= FM_EDITOR_END) continue;

			const sent = editorPositionAt(FM_EDITOR, scrollTop, FM_EDITOR_END);
			assert.equal(sent.section, 'body');
			assert.ok(sent.line !== undefined, 'the editor resolves a line for every body position');

			const landed = previewScrollTopFor(FM_PREVIEW, sent, FM_PANEL, FM_COORDS);
			if (landed.clamped) continue;

			const drift = Math.abs(fmPreviewBodyLineAt(landed.scrollTop) - fmEditorBodyLineAt(scrollTop));
			if (drift > worst) {
				worst = drift;
				worstAt = scrollTop;
			}

			// The control: the same buffer line handed to the preview as if it were
			// a body line, which is what every consumer here did before the shift
			// existed and what the copied glue in this file kept doing after it.
			const naive = previewScrollTopFor(FM_PREVIEW, sent, FM_PANEL, NO_FRONT_MATTER);
			if (!naive.clamped) {
				unconverted = Math.max(unconverted, Math.abs(fmPreviewBodyLineAt(naive.scrollTop) - fmEditorBodyLineAt(scrollTop)));
			}
		}

		t.diagnostic(`converted: worst drift ${worst.toFixed(1)} body lines; unconverted: ${unconverted.toFixed(1)}`);

		assert.ok(
			unconverted > FRONT_MATTER_LINES - 1,
			`the control must be off by about the front matter, got ${unconverted.toFixed(1)} lines`,
		);
		assert.ok(
			worst <= LINE_SLACK,
			`the preview drifted ${worst.toFixed(1)} body lines from the editor at scrollTop ${Math.round(worstAt)}`,
		);
	});

	test('a position inside the front matter carries no line, and lands in the panel', () => {
		// Front matter renders as a panel with no source range, so there is nothing
		// for a line to resolve against and the section ratio is the only thing that
		// can carry the position. That carve-out is what `scrollSync.ts` is for, and
		// it has to survive the panes having different-sized front matter.
		const inside = editorPositionAt(FM_EDITOR, FM_EDITOR_END / 2, FM_EDITOR_END);
		assert.equal(inside.section, 'frontmatter');
		assert.equal(inside.line, undefined);

		const landed = previewScrollTopFor(FM_PREVIEW, inside, FM_PANEL, FM_COORDS);
		assert.equal(landed.scrollTop, FM_PANEL / 2);

		// And the boundary maps onto the boundary exactly, from either side.
		assert.equal(previewScrollTopFor(FM_PREVIEW, { section: 'frontmatter', ratio: 1 }, FM_PANEL, FM_COORDS).scrollTop, FM_PANEL);
		assert.equal(previewScrollTopFor(FM_PREVIEW, { section: 'body', ratio: 0 }, FM_PANEL, FM_COORDS).scrollTop, FM_PANEL);
	});

	test('the ends of the document are the ends of the mapping', (t) => {
		// What the mapping aligns is the line at the TOP of each viewport, which is
		// the only thing two panes of different heights can agree on. The panes'
		// last screenfuls are not the same amount of document — the preview's tail is
		// tables, so 800px of it is a handful of source lines, while 800px of editor
		// is 42 — and the consequence is visible at the very bottom.
		const atEditorBottom = previewScrollTopFor(PREVIEW, editorPositionAt(EDITOR, EDITOR.scrollMax));
		const drift = Math.abs(previewLineAt(atEditorBottom.scrollTop) - editorLineAt(EDITOR.scrollMax));
		t.diagnostic(
			`editor at its bottom: preview at ${Math.round(atEditorBottom.scrollTop)} of ${Math.round(PREVIEW.scrollMax)}, ` +
				`same top line to within ${drift.toFixed(2)}`,
		);

		// The top lines agree exactly...
		assert.ok(drift <= LINE_SLACK, `the preview's top line was ${drift.toFixed(1)} lines from the editor's`);
		// ...and the preview therefore still has room below, because the same lines
		// take more height there. Anything else would mean abandoning the alignment
		// at the one position the reporter looks at.
		assert.ok(atEditorBottom.scrollTop < PREVIEW.scrollMax);

		// Driven the other way the editor runs out first, and clamps rather than
		// trying to scroll past its own last line.
		const atPreviewBottom = editorScrollTopFor(EDITOR, previewPositionAt(PREVIEW, PREVIEW.scrollMax));
		assert.equal(atPreviewBottom.scrollTop, EDITOR.scrollMax);
		assert.ok(atPreviewBottom.clamped);

		// The top of the document is a fixed point in both directions.
		assert.equal(previewScrollTopFor(PREVIEW, editorPositionAt(EDITOR, 0)).scrollTop, 0);
		assert.equal(editorScrollTopFor(EDITOR, previewPositionAt(PREVIEW, 0)).scrollTop, 0);
	});

	/* ------------------------------------------------------------------ */
	/* no feedback loop                                                    */
	/* ------------------------------------------------------------------ */

	/**
	 * The panes are kept from echoing each other by two flags
	 * (`isProgrammaticScroll` in the viewer, `isApplyingExternalScroll` in the
	 * editor), and a flag is a promise about event ordering, not about the mapping.
	 * What is asserted here is the mapping's own contribution — that an echo which
	 * did get through, because a flag was consumed by the wrong event or a scroll
	 * was coalesced, would die instead of building up.
	 *
	 * The property is IDEMPOTENCE, not identity, and the difference is the point.
	 * A block mapping quantises: a scroll offset in the margin between two blocks
	 * belongs to no block, so it resolves to the nearest block edge, and a round
	 * trip from there snaps by up to that margin. It snaps ONCE — the result is a
	 * block edge, which is its own image — so the panes settle instead of walking.
	 * Both components stop below a 5px threshold, so a settled round trip sends
	 * nothing further.
	 */
	const ECHO_THRESHOLD = 5;

	function editorRoundTrip(scrollTop: number): number {
		const preview = previewScrollTopFor(PREVIEW, editorPositionAt(EDITOR, scrollTop));
		return editorScrollTopFor(EDITOR, previewPositionAt(PREVIEW, preview.scrollTop)).scrollTop;
	}

	function previewRoundTrip(scrollTop: number): number {
		const editor = editorScrollTopFor(EDITOR, previewPositionAt(PREVIEW, scrollTop));
		return previewScrollTopFor(PREVIEW, editorPositionAt(EDITOR, editor.scrollTop)).scrollTop;
	}

	test('an echo through the other pane settles in one step', (t) => {
		let worstFirst = 0;
		let worstSecond = 0;
		let worstAt = 0;

		for (const scrollTop of sweep(EDITOR.scrollMax, 0, 1, 200)) {
			const once = editorRoundTrip(scrollTop);
			const twice = editorRoundTrip(once);

			worstFirst = Math.max(worstFirst, Math.abs(once - scrollTop));
			if (Math.abs(twice - once) > worstSecond) {
				worstSecond = Math.abs(twice - once);
				worstAt = scrollTop;
			}
		}

		t.diagnostic(`editor -> preview -> editor: first echo up to ${worstFirst.toFixed(1)}px, second ${worstSecond.toFixed(3)}px`);

		// The second round trip is where an oscillation would show: it is the same
		// arithmetic on the settled position, so anything but zero here compounds.
		assert.ok(
			worstSecond < ECHO_THRESHOLD,
			`a second echo would move the editor a further ${worstSecond.toFixed(1)}px at scrollTop ${Math.round(worstAt)}`,
		);
		// And the first snap is bounded by the gap between two rendered blocks, not
		// by anything that scales with the document.
		assert.ok(worstFirst < 4 * BLOCK_GAP, `the first echo moved the editor ${worstFirst.toFixed(1)}px`);
	});

	test('the preview echo settles too', () => {
		let worstSecond = 0;

		for (const scrollTop of sweep(PREVIEW.scrollMax, 0, 1, 200)) {
			const once = previewRoundTrip(scrollTop);
			worstSecond = Math.max(worstSecond, Math.abs(previewRoundTrip(once) - once));
		}

		assert.ok(worstSecond < ECHO_THRESHOLD, `a second preview echo moved it ${worstSecond.toFixed(1)}px`);
	});

	/**
	 * The case the synthetic layout above nearly hid, and the reason this file
	 * insists on more than one of them.
	 *
	 * Margins collapse, so in a real preview one block's bottom edge IS the next
	 * block's top — the two boxes touch. A line mapped back to a pixel lands on the
	 * top edge of its own block, and if the block above is allowed to claim that
	 * pixel too, the round trip resolves to the block above. Every echo then walks
	 * the reader one block up the document: a feedback loop that the flags happen
	 * to stop, and that nothing in the mapping did.
	 *
	 * With `BLOCK_GAP` set to 16 no two boxes ever touched and the round trip was a
	 * perfect fixed point. It was measured in Chrome, over this pipeline's own
	 * output, before it was fixed; this is the guard.
	 */
	test('touching blocks do not walk the panes up the document', () => {
		const touching = buildPreview(DOC, 0);

		const roundTrip = (offset: number) => {
			const line = getSourceLineAtPreviewOffset(touching.body, offset, touching.measure);
			assert.ok(line !== null);
			const back = getPreviewOffsetForSourceLine(touching.body, line, touching.measure);
			assert.ok(back !== null);
			return back;
		};

		let worstSecond = 0;
		let worstThird = 0;
		for (const offset of sweep(touching.scrollMax, 0, 1, 400)) {
			const once = roundTrip(offset);
			const twice = roundTrip(once);
			worstSecond = Math.max(worstSecond, Math.abs(twice - once));
			worstThird = Math.max(worstThird, Math.abs(roundTrip(twice) - twice));
		}

		assert.equal(worstSecond, 0, `a second echo moved the preview ${worstSecond.toFixed(1)}px between touching blocks`);
		assert.equal(worstThird, 0, `a third echo moved the preview ${worstThird.toFixed(1)}px`);
	});

	test('the pixel two blocks share belongs to the lower one', () => {
		// Stated directly, because the loop above only shows the consequence. The
		// boundary pixel is the top of the block below, not the bottom of the block
		// above, and a mapping that says otherwise cannot have a fixed point there.
		const doc = new DocumentBuilder();
		doc.paragraph('First.');
		doc.blank();
		doc.paragraph('Second.');
		doc.blank();
		doc.paragraph('Third.');

		const preview = buildPreview(doc, 0);
		const second = preview.body
			.querySelectorAll('p')
			.find((el) => (el.getAttribute('data-sourcepos') ?? '').startsWith('3:'));
		assert.ok(second, 'fixture must contain the second paragraph');
		const box = preview.measure(second);

		assert.equal(getSourceLineAtPreviewOffset(preview.body, box.top, preview.measure), 3);
		assert.equal(getSourceLineAtPreviewOffset(preview.body, box.top + box.height, preview.measure), 5);
		assert.equal(getPreviewOffsetForSourceLine(preview.body, bodyLine(3), preview.measure), box.top);
	});

	test('repeating the echo does not walk the panes down the document', () => {
		// Twenty round trips from a settled position. A mapping that was merely
		// *close* to idempotent would creep, and creep is what an unguarded feedback
		// loop looks like from the outside.
		const started = editorRoundTrip(EDITOR.scrollMax * 0.8);
		let scrollTop = started;

		for (let round = 0; round < 20; round += 1) scrollTop = editorRoundTrip(scrollTop);

		assert.ok(
			Math.abs(scrollTop - started) < ECHO_THRESHOLD,
			`twenty echoes moved the editor ${Math.abs(scrollTop - started).toFixed(1)}px`,
		);
	});

	test('scrolling one pane down always moves the other pane down', () => {
		// The failure shape #433 shipped: a sync that reports something constant, so
		// the other pane never follows. Monotonicity covers the whole range at once.
		const scrollTops = sweep(EDITOR.scrollMax, 0, 1, 200);
		const mapped = scrollTops.map(
			(scrollTop) => previewScrollTopFor(PREVIEW, editorPositionAt(EDITOR, scrollTop)).scrollTop,
		);

		for (let index = 1; index < mapped.length; index += 1) {
			assert.ok(
				mapped[index] >= mapped[index - 1],
				`editor ${Math.round(scrollTops[index - 1])} -> ${Math.round(scrollTops[index])} moved the preview ` +
					`backwards: ${mapped[index - 1].toFixed(1)} -> ${mapped[index].toFixed(1)}`,
			);
		}

		assert.ok(mapped[mapped.length - 1] > mapped[0], 'the preview must actually travel');
	});

	/* ------------------------------------------------------------------ */
	/* the offsets a browser actually reports                              */
	/* ------------------------------------------------------------------ */

	/**
	 * The last table in the fixture: far enough down that "the top of the document"
	 * and "inside this table" cannot be confused for one another.
	 */
	const LAST_TABLE = (() => {
		const tables = PREVIEW.body.querySelectorAll('table');
		return tables[tables.length - 1];
	})();

	const LAST_TABLE_RANGE = (() => {
		const [start, end] = LAST_TABLE.getAttribute('data-sourcepos')!.split('-');
		return { startLine: parseInt(start.split(':')[0], 10), endLine: parseInt(end.split(':')[0], 10) };
	})();

	test('a row reports an offset measured from its table, and a code block from its shell', () => {
		const row = LAST_TABLE.querySelectorAll('tr')[7];
		const pre = PREVIEW.body.querySelectorAll('pre').at(-1)!;

		// Where they really are: near the end of a 21,000px document.
		assert.ok(PREVIEW.measure(row).top > PREVIEW.scrollMax * 0.8);
		assert.ok(PREVIEW.measure(pre).top > PREVIEW.scrollMax * 0.8);

		// What `offsetTop` says: a couple of hundred pixels into the table, and the
		// shell's padding into the code block. This is the whole defect — those two
		// numbers used to be read as positions in the document.
		assert.ok(PREVIEW.rawMeasure(row).top < 600, `the row's offsetTop was ${PREVIEW.rawMeasure(row).top}`);
		assert.equal(PREVIEW.rawMeasure(pre).top, 0);
	});

	test('a line inside a table maps into that table, not to the top of the document', () => {
		const line = bodyLine(LAST_TABLE_RANGE.startLine + 7);
		const table = PREVIEW.measure(LAST_TABLE);

		const offset = getPreviewOffsetForSourceLine(PREVIEW.body, line, PREVIEW.measure);
		assert.ok(offset !== null);
		assert.ok(
			offset >= table.top && offset <= table.top + table.height,
			`a line in a table at ${Math.round(table.top)}px resolved to ${Math.round(offset)}px`,
		);

		// The control: the same line, through raw `offsetTop`. The reporter's
		// "one scroll down and it sends me to the top of the document".
		const raw = getPreviewOffsetForSourceLine(PREVIEW.body, line, PREVIEW.rawMeasure);
		assert.ok(raw !== null && raw < VIEWPORT, `the control must land in the first screenful, got ${raw}`);
	});

	test('an offset inside a table resolves to the row at it, not to the row after the last', () => {
		const table = PREVIEW.measure(LAST_TABLE);
		const offset = table.top + table.height / 2;

		const line = getSourceLineAtPreviewOffset(PREVIEW.body, offset, PREVIEW.measure);
		assert.ok(line !== null);
		assert.ok(
			line > LAST_TABLE_RANGE.startLine && line < LAST_TABLE_RANGE.endLine,
			`halfway down the table resolved to line ${line} of ${LAST_TABLE_RANGE.startLine}-${LAST_TABLE_RANGE.endLine}`,
		);

		// The control, and the other half of the report: every row's raw box is far
		// above an offset in document space, so the nearest of them is always the
		// last one — the editor sticks at the end of the table until the reader has
		// scrolled past the whole thing.
		const raw = getSourceLineAtPreviewOffset(PREVIEW.body, offset, PREVIEW.rawMeasure);
		assert.ok(
			raw !== null && raw >= LAST_TABLE_RANGE.endLine,
			`the raw measure is expected to stick at or past the end of the table, got ${raw}`,
		);
	});

	/* ------------------------------------------------------------------ */
	/* what the mapping must never resolve to                              */
	/* ------------------------------------------------------------------ */

	/**
	 * #464's trap. `render.hardbreaks` is on, so soft-wrapped prose is full of
	 * `<br data-sourcepos>` elements that carry a source range and generate no box;
	 * a browser reports `offsetTop === 0, offsetHeight === 0` for every one. A
	 * mapping that let one win resolves the reader's position to the top of the
	 * document.
	 *
	 * The shim has no layout, so this is modelled rather than measured: the `<br>`s
	 * are given the box a browser gives them — the origin — and the assertion is
	 * that a position deep in the document does not come back as line 1.
	 */
	test('a boxless <br> at the origin never captures a scroll position', () => {
		const doc = new DocumentBuilder();
		for (let index = 1; index <= 40; index += 1) {
			doc.wrappedParagraph([
				`Paragraph ${index} first line of prose the author soft-wrapped.`,
				`Paragraph ${index} second line, still the same markdown block.`,
				`Paragraph ${index} third and final line of the block.`,
			]);
			doc.blank();
		}

		const body = parseHtml(processMarkdownHtml(doc.html(), FILE_PATH, new Set())).body;
		assert.ok(body.querySelectorAll('br[data-sourcepos]').length > 0, 'fixture must contain annotated hard breaks');

		const boxes = layOut(body);
		// Every `<br>` reports the box a browser reports for it: none, at the origin.
		const measure = (node: AnchorNode) => {
			const element = node as ShimElement;
			if (BOXLESS.has(element.tagName)) return { top: 0, height: 0 };
			return boxes.get(element) ?? { top: Number.NaN, height: Number.NaN };
		};

		let contentHeight = 0;
		for (const box of boxes.values()) contentHeight = Math.max(contentHeight, box.top + box.height);

		for (const offset of [400, 800, 1200, 1600, 2000]) {
			const line = getSourceLineAtPreviewOffset(body, offset, measure);
			assert.ok(line !== null, `offset ${offset} must resolve`);
			assert.ok(line > 1, `offset ${offset}px of ${Math.round(contentHeight)}px resolved to line ${line}`);

			// ...and the line it resolved to maps back to roughly that offset, which
			// a `<br>` at the origin could never do.
			const back = getPreviewOffsetForSourceLine(body, line, measure);
			assert.ok(back !== null && Math.abs(back - offset) < 40, `offset ${offset} came back as ${back}`);
		}
	});

	/* ------------------------------------------------------------------ */
	/* the fallback                                                        */
	/* ------------------------------------------------------------------ */

	test('front matter is still carried by the section ratio, not by a line', () => {
		// The carve-out `scrollSync.ts` exists for. The preview renders front matter
		// as a fixed-height panel with no source range at all, so there is no line to
		// send and the section/ratio pair is the only thing that can describe it.
		const editorFrontMatterEnd = 200;
		const previewFrontMatterEnd = 60;

		const inside = editorPositionAt(EDITOR, 100, editorFrontMatterEnd);
		assert.equal(inside.section, 'frontmatter');
		assert.equal(inside.line, undefined, 'a front-matter position must not carry a source line');
		assert.equal(inside.ratio, 0.5);

		// ...and it still lands on the preview's own boundary, proportionally.
		assert.equal(previewScrollTopFor(PREVIEW, inside, previewFrontMatterEnd).scrollTop, 30);
		assert.equal(
			previewScrollTopFor(
				PREVIEW,
				editorPositionAt(EDITOR, editorFrontMatterEnd - 1, editorFrontMatterEnd),
				previewFrontMatterEnd,
			).scrollTop,
			previewFrontMatterEnd * ((editorFrontMatterEnd - 1) / editorFrontMatterEnd),
		);

		// The first body pixel picks the line mapping straight back up.
		const body = editorPositionAt(EDITOR, editorFrontMatterEnd, editorFrontMatterEnd);
		assert.equal(body.section, 'body');
		assert.ok(body.line !== undefined, 'a body position must carry a source line');
	});

	test('a preview holding no annotated block falls back to the ratio', () => {
		// The other trigger: a document the renderer produced nothing anchorable
		// from. The position then has no line, and the receiving pane is back on the
		// mapping that was there before — which is a degraded sync, not a dead one.
		const empty = parseHtml('<div class="notice">Nothing rendered.</div>').body;
		const measure = () => ({ top: 0, height: 0 });

		assert.equal(getSourceLineAtPreviewOffset(empty, 400, measure), null);
		assert.equal(getPreviewOffsetForSourceLine(empty, bodyLine(12), measure), null);

		const emptyPreview: Preview = { body: empty, measure, rawMeasure: measure, contentHeight: 0, scrollMax: 600 };
		const position = previewPositionAt(emptyPreview, 300);
		assert.equal(position.line, undefined);
		assert.equal(position.section, 'body');
		assert.equal(position.ratio, 0.5);

		// And a line arriving from the editor still moves it, by ratio.
		assert.equal(previewScrollTopFor(emptyPreview, { section: 'body', ratio: 0.25, line: asBufferLine(400) }).scrollTop, 150);
	});

	test('an element the app renders around the document does not swallow the offset', () => {
		// The front-matter panel and the table of contents are real children of the
		// scroll container with no `data-sourcepos` anywhere inside them. Descending
		// into one would resolve every offset it covers to nothing.
		const doc = new DocumentBuilder();
		doc.paragraph('First paragraph.');
		doc.blank();
		doc.paragraph('Second paragraph.');

		const document = parseHtml(processMarkdownHtml(doc.html(), FILE_PATH, new Set()));
		const body = document.body;
		const panel = document.createElement('details');
		panel.setAttribute('class', 'frontmatter-panel');
		body.insertBefore(panel, body.childNodes[0]);

		// The panel occupies the first 120px of the scroll content; the document
		// starts underneath it.
		const boxes = layOut(body, 120);
		const measure = (node: AnchorNode) => {
			if (node === panel) return { top: 0, height: 120 };
			return boxes.get(node as ShimElement) ?? { top: Number.NaN, height: Number.NaN };
		};

		// An offset squarely inside the panel resolves to the nearest real block
		// rather than to nothing.
		const line = getSourceLineAtPreviewOffset(body, 60, measure);
		assert.ok(line !== null, 'an offset over the front-matter panel must still resolve to a block');
		assert.equal(line, 1);

		// ...and the block under it still answers for itself. Fractionally: the
		// mapping interpolates between the two samples either side of the offset,
		// so a position inside the first paragraph reads as "just past line 1"
		// rather than as a flat 1. That is the half that matches the editor, which
		// also answers with a fraction — an integer here is what USED to leave the
		// two panes disagreeing by up to a line.
		const insideFirst = getSourceLineAtPreviewOffset(body, 130, measure);
		assert.ok(
			insideFirst !== null && insideFirst >= 1 && insideFirst < 3,
			`an offset inside the first paragraph resolved to ${insideFirst}`,
		);
		const insideSecond = getSourceLineAtPreviewOffset(body, 175, measure);
		assert.ok(
			insideSecond !== null && insideSecond >= 3,
			`an offset inside the second paragraph resolved to ${insideSecond}`,
		);
	});

	test('a position past the last block resolves to the last block, not to nothing', () => {
		// The preview has padding under the last block, so the anchor offset at the
		// bottom of the document is past every box. Returning null there would put
		// the very end of the document — the thing #205 is about — back on the
		// proportional mapping.
		const line = getSourceLineAtPreviewOffset(PREVIEW.body, PREVIEW.contentHeight + 500, PREVIEW.measure);
		assert.ok(line !== null);
		assert.ok(
			line > DOC.lineCount - 10,
			`an offset past the end resolved to line ${line} of ${DOC.lineCount}`,
		);
	});

	test('a collapsed fold answers for its hidden contents', () => {
		// A collapsed wrapper is `height: 0; overflow: hidden`, so its children still
		// report offsets and those offsets point at where the content would be. The
		// mapping must stop at the wrapper, which is where the reader actually sees
		// that part of the document.
		const doc = new DocumentBuilder();
		doc.heading(2, 'Collapsed', 'collapsed');
		doc.blank();
		doc.paragraph('Hidden body text.');
		doc.blank();
		doc.heading(2, 'After', 'after');
		doc.blank();
		doc.paragraph('Visible body text.');

		const body = parseHtml(processMarkdownHtml(doc.html(), FILE_PATH, new Set(['collapsed']))).body;
		const wrapper = body.querySelector('.foldable-content-wrapper.is-collapsed');
		assert.ok(wrapper, 'fixture must contain a collapsed wrapper');

		const boxes = layOut(body);
		const measure = (node: AnchorNode) => {
			if (node === wrapper) return { top: 38, height: 0 };
			return boxes.get(node as ShimElement) ?? { top: Number.NaN, height: Number.NaN };
		};

		// Line 3 is inside the collapsed section; it must map to the wrapper's own
		// position and not to where its hidden paragraph claims to be.
		const offset = getPreviewOffsetForSourceLine(body, bodyLine(3), measure);
		assert.equal(offset, 38);
	});

	/* ------------------------------------------------------------------ */
	/* the editor half of the mapping                                      */
	/* ------------------------------------------------------------------ */

	test('the editor line lookup is the exact inverse of Monaco line tops', () => {
		// Monaco publishes line -> pixel and nothing for the inverse, so the inverse
		// is a binary search over the same function. Folded regions and wrapped lines
		// make the heights non-uniform, which is why a division by a line height
		// would not do: this table has three different ones.
		const heights = [24, 24, 96, 24, 48, 48, 24, 24, 24, 240, 24, 24];
		const tops = [0];
		for (const height of heights) tops.push(tops[tops.length - 1] + height);
		const topForLine = (line: number) => tops[Math.max(0, Math.min(tops.length - 1, line - 1))];
		const lineCount = heights.length;

		for (let line = 1; line <= lineCount; line += 1) {
			assert.equal(getVerticalOffsetForLine(line, lineCount, topForLine), tops[line - 1]);
			assert.equal(getLineAtVerticalOffset(tops[line - 1], lineCount, topForLine), line);
		}

		// Fractional positions survive the round trip, which is what keeps the paired
		// pane moving smoothly instead of jumping a line at a time.
		for (const line of [1.25, 3.5, 6.75, 10.1, 11.9]) {
			const offset = getVerticalOffsetForLine(line, lineCount, topForLine);
			assert.ok(
				Math.abs(getLineAtVerticalOffset(offset, lineCount, topForLine) - line) < 1e-9,
				`line ${line} returned as ${getLineAtVerticalOffset(offset, lineCount, topForLine)}`,
			);
		}

		// The bottom edge of the last line is `lineCount + 1`, and both directions
		// accept it: it is a position the reader can scroll to, and rounding it down
		// to the top of the last line would leave the very end of the document —
		// what #205 is about — as the one place the round trip did not close.
		assert.equal(getLineAtVerticalOffset(tops[lineCount], lineCount, topForLine), lineCount + 1);
		assert.equal(getVerticalOffsetForLine(lineCount + 1, lineCount, topForLine), tops[lineCount]);

		// Out of range in either direction clamps into the document.
		assert.equal(getLineAtVerticalOffset(-500, lineCount, topForLine), 1);
		assert.equal(getLineAtVerticalOffset(99999, lineCount, topForLine), lineCount + 1);
		assert.equal(getVerticalOffsetForLine(0, lineCount, topForLine), 0);
		assert.equal(getVerticalOffsetForLine(lineCount + 50, lineCount, topForLine), tops[lineCount]);

		// An empty or unmeasurable model never produces NaN pixels.
		assert.equal(getLineAtVerticalOffset(100, 0, topForLine), 1);
		assert.equal(getVerticalOffsetForLine(4, 0, topForLine), 0);
		assert.equal(getLineAtVerticalOffset(Number.NaN, lineCount, topForLine), 1);
		assert.equal(getVerticalOffsetForLine(Number.NaN, lineCount, topForLine), 0);
	});

	test('the binary search costs a logarithm, not a walk', () => {
		// The mapping runs on every scroll event, so the number of measurements it
		// asks Monaco for is part of the contract, not an implementation detail.
		const lineCount = 100_000;
		let calls = 0;
		const topForLine = (line: number) => {
			calls += 1;
			return (line - 1) * 20;
		};

		getLineAtVerticalOffset(1_234_567, lineCount, topForLine);
		assert.ok(calls <= 2 * Math.ceil(Math.log2(lineCount)), `binary search made ${calls} measurements`);
	});

	/* ------------------------------------------------------------------ */
	/* soft line breaks inside a long paragraph                            */
	/* ------------------------------------------------------------------ */
	//
	// The interpolation across a block assumes every source line in it renders to
	// the same height. Prose breaks that assumption the moment one line wraps and
	// the next does not — and a long paragraph is where the error accumulates,
	// because the block is tall and the mapping has only its two ends to go on.
	//
	// `render.hardbreaks` means every source newline is already a `<br>` carrying
	// the line it ended, so the positions exist in the DOM; they were unreachable
	// only because a `<br>` generates no box. `processSoftLineAnchors` gives each
	// one a zero-sized sibling that does.

	/** A comrak-shaped paragraph of `lines` source lines joined by hard breaks. */
	function wrappedParagraph(startLine: number, lines: number): string {
		const endLine = startLine + lines - 1;
		const body = Array.from({ length: lines }, (_, index) => {
			const line = startLine + index;
			const text = `line ${line} of the paragraph`;
			return index === lines - 1
				? text
				: `${text}<br data-sourcepos="${line}:${text.length}-${line}:${text.length}" />`;
		}).join('\n');
		return `<p data-sourcepos="${startLine}:1-${endLine}:24">${body}</p>`;
	}

	function renderParagraph(startLine: number, lines: number): ShimElement {
		return parseHtml(processMarkdownHtml(wrappedParagraph(startLine, lines), FILE_PATH, new Set<string>())).body;
	}

	/** Every soft-line anchor in `root`, in document order, with its source line. */
	function anchorsOf(root: ShimElement): { element: ShimElement; line: number }[] {
		const out: { element: ShimElement; line: number }[] = [];
		const walk = (node: ShimElement) => {
			for (const child of node.childNodes) {
				if (child.nodeType !== NODE_ELEMENT) continue;
				const element = child as ShimElement;
				if (element.getAttribute('class') === 'source-line-anchor') {
					const [start] = (element.getAttribute('data-sourcepos') ?? '').split('-');
					out.push({ element, line: Number(start?.split(':')[0]) });
				}
				walk(element);
			}
		};
		walk(root);
		return out;
	}

	test('a long paragraph gets one anchor per soft line break', () => {
		// Four source lines, three breaks — and the anchor names the line the break
		// STARTS, because "where does line N begin on screen" is the question the
		// mapping asks.
		const anchors = anchorsOf(renderParagraph(10, 4));
		assert.deepEqual(
			anchors.map((a) => a.line),
			[11, 12, 13],
		);
	});

	test('a short paragraph is left alone', () => {
		// Two lines cost half a line of interpolation error at worst. Anchoring
		// them would be DOM nobody can see the benefit of, and most paragraphs in a
		// document are short.
		assert.deepEqual(anchorsOf(renderParagraph(10, 2)), []);
	});

	test('the newline behind a break stays in front of the anchor', () => {
		// comrak writes a newline after every `<br>`, and a browser drops it only
		// while it is still at the start of the line. The anchor is an
		// `inline-block` — a box — so an anchor in front of that newline turns it
		// into a space BETWEEN two boxes, and every wrapped line of the paragraph
		// renders with an indent nobody typed (#725).
		const anchors = anchorsOf(renderParagraph(10, 4));
		assert.equal(anchors.length, 3);
		for (const { element } of anchors) {
			const gap = element.previousSibling;
			assert.equal(gap?.nodeType, NODE_TEXT, 'an anchor sits behind the whitespace, not in front of it');
			assert.match((gap as ShimText).nodeValue, /^\s+$/);
			assert.equal((gap.previousSibling as ShimElement | null)?.tagName, 'BR');
		}
	});

	test('the <br> itself is untouched', () => {
		// Replacing it would put the layout, selection and copy behaviour of every
		// wrapped paragraph at risk to save one node per line.
		const html = processMarkdownHtml(wrappedParagraph(10, 4), FILE_PATH, new Set<string>());
		assert.equal((html.match(/<br /g) ?? []).length, 3, 'all three breaks survive');
	});

	test('a line inside the paragraph resolves to its own anchor, not to an interpolation', () => {
		// The case the anchors exist for: line 10 wraps to three rendered lines and
		// the rest wrap to one, so the block is 6 rendered lines tall while holding
		// 4 source lines. Interpolating puts line 11 a third of the way down —
		// 2 rendered lines in — when it really starts 3 in.
		const root = renderParagraph(10, 4);
		const paragraph = root.querySelector('p');
		assert.ok(paragraph);
		const anchors = anchorsOf(root);

		const ROW = 20;
		const PARAGRAPH_TOP = 100;
		// line 10 wraps to 3 rows, then one row each for 11, 12, 13.
		const rowOfLine = new Map([
			[11, 3],
			[12, 4],
			[13, 5],
		]);

		const boxes = new Map<unknown, { top: number; height: number }>();
		boxes.set(paragraph, { top: PARAGRAPH_TOP, height: 6 * ROW });
		for (const { element, line } of anchors) {
			boxes.set(element, { top: PARAGRAPH_TOP + (rowOfLine.get(line) ?? 0) * ROW, height: 0 });
		}
		const measure = (node: unknown) => boxes.get(node) ?? { top: 0, height: 0 };

		const interpolated = PARAGRAPH_TOP + 6 * ROW * ((11 - 10) / (13 - 10));
		const actual = getPreviewOffsetForSourceLine(root as AnchorNode, bodyLine(11), measure as never);

		assert.equal(actual, PARAGRAPH_TOP + 3 * ROW, 'line 11 lands where line 11 is drawn');
		assert.notEqual(actual, interpolated, 'and not where the block-wide interpolation would put it');
	});

	test('an anchor carries no height, and the mapping never asks it for one', () => {
		// A single-line range makes `getAnchorScrollTop` take ratio 0, so the
		// height is multiplied away — which is what lets the anchor be invisible.
		const root = renderParagraph(10, 4);
		const anchors = anchorsOf(root);
		assert.ok(anchors.length > 0);

		const measure = (node: unknown) =>
			node === anchors[0].element ? { top: 250, height: 0 } : { top: 0, height: 999 };

		assert.equal(getPreviewOffsetForSourceLine(root as AnchorNode, bodyLine(11), measure as never), 250);
	});
});

describe('fold keys on rendered markup', async () => {
	installShimDom();

	const { processMarkdownHtml } = await import('../src/lib/utils/markdown.ts');
	const { foldKeyOf } = await import('../src/lib/utils/foldState.ts');

	// Fold state is keyed by `h.id || textContent`. comrak emits the deduplicated
	// heading id ("setup", "setup-1", …) on an empty inner <a class="anchor">, not
	// on the heading element, so without promotion every consumer falls back to
	// heading text: two sections both called "Setup" share one fold state, and the
	// ToC's id-based keys never match the preview's text-based ones.
	//
	// This used to be asserted by matching `/h\.id = \w+\.id/` against
	// markdown.ts. That pins a spelling rather than the behaviour — it goes red on
	// a rename that breaks nothing, and stays green if the promotion runs but the
	// ids collide. The document below has the collision in it, so the check is now
	// what the feature exists for: does collapsing the first "Setup" leave the
	// second one open.

	/** The shape comrak emits for two sections that share a title. */
	const DUPLICATE_TITLES = [
		'<h2><a href="#setup" aria-hidden="true" class="anchor" id="setup"></a>Setup</h2>',
		'<p>first body</p>',
		'<h2><a href="#setup-1" aria-hidden="true" class="anchor" id="setup-1"></a>Setup</h2>',
		'<p>second body</p>',
	].join('\n');

	function headings(html: string): ShimElement[] {
		return parseHtml(html).querySelectorAll('h2') as unknown as ShimElement[];
	}

	/** The fold wrapper `heading` opens and closes, found by its `data-fold-target`. */
	function wrapperFor(root: ReturnType<typeof parseHtml>, heading: ShimElement): ShimElement {
		const id = heading.getAttribute('data-fold-target');
		assert.ok(id, 'every foldable header points at its wrapper');
		const wrapper = root.querySelector(`#${id}`) as unknown as ShimElement | null;
		assert.ok(wrapper, `wrapper ${id} exists`);
		return wrapper;
	}

	test('the comrak anchor id is promoted onto the heading, and left nowhere else', () => {
		const [first, second] = headings(processMarkdownHtml(DUPLICATE_TITLES, '/doc.md', new Set()));

		assert.equal(first.getAttribute('id'), 'setup');
		assert.equal(second.getAttribute('id'), 'setup-1');

		// Not merely "an id is set": the ids must still be unique afterwards, which
		// is why the anchor gives its own up rather than sharing it.
		for (const heading of [first, second]) {
			const anchor = heading.querySelector('a.anchor') as unknown as ShimElement | null;
			assert.ok(anchor, 'the comrak anchor survives');
			assert.equal(anchor.getAttribute('id'), null, 'the anchor no longer carries the id');
		}
	});

	test('collapsing one of two sections that share a title leaves the other open', () => {
		// The defect this file exists for. Keyed by text, `new Set(['setup'])` would
		// match both headings and collapse the whole document.
		const root = parseHtml(processMarkdownHtml(DUPLICATE_TITLES, '/doc.md', new Set(['setup'])));
		const [first, second] = root.querySelectorAll('h2') as unknown as ShimElement[];

		assert.ok(first.classList.contains('is-collapsed'), 'the collapsed heading is the one in the set');
		assert.ok(wrapperFor(root, first).classList.contains('is-collapsed'), 'its content is hidden');

		assert.ok(!second.classList.contains('is-collapsed'), 'the same-titled sibling stays open');
		assert.ok(!wrapperFor(root, second).classList.contains('is-collapsed'), 'its content stays visible');
	});

	test('a heading that already carries an id keeps it', () => {
		// The promotion is guarded by `!h.id`. Raw HTML in the document can set one,
		// and overwriting it would break the anchor links pointing at it.
		const html = processMarkdownHtml(
			'<h2 id="hand-written"><a href="#auto" aria-hidden="true" class="anchor" id="auto"></a>Title</h2>',
			'/doc.md',
			new Set(),
		);
		const [heading] = headings(html);
		assert.equal(heading.getAttribute('id'), 'hand-written');
	});

	// This used to be a source-shape assertion — the preview and the outline were
	// each grepped for their own copy of `id || textContent`, because the two
	// consumers live in Svelte components this runner cannot import. That is the
	// wrong shape of check for a rule about agreement: three spellings of one
	// expression pass it happily, right up until one of them is edited.
	//
	// There is one spelling now. `assignFoldKey` computes the key while the markup
	// is built and leaves it on the element, so every consumer reads the answer
	// instead of recomputing it, and this file can check the producer by running it.

	test('the key a fold is stored under is written onto the markup', () => {
		const root = parseHtml(processMarkdownHtml(DUPLICATE_TITLES, '/doc.md', new Set()));
		const [first, second] = root.querySelectorAll('h2') as unknown as ShimElement[];

		assert.equal(foldKeyOf(first as unknown as Element), 'setup');
		assert.equal(foldKeyOf(second as unknown as Element), 'setup-1', 'the deduplicated id, not the shared text');
	});

	test('a foldable callout is named too, and two with the same title fold apart', () => {
		// Callouts have no id and no slug, so before they were keyed at all their
		// fold state had nowhere to live — the title toggled two classes and the
		// next render put them back. Keyed by title, in a namespace of their own.
		const html = processMarkdownHtml(
			[
				'<blockquote><p>[!note]- Details<br>first body</p></blockquote>',
				'<blockquote><p>[!note]- Details<br>second body</p></blockquote>',
			].join('\n'),
			'/doc.md',
			new Set(['callout:Details']),
		);
		const root = parseHtml(html);
		const [first, second] = root.querySelectorAll('.callout-foldable') as unknown as ShimElement[];

		assert.equal(foldKeyOf(first as unknown as Element), 'callout:Details');
		assert.equal(foldKeyOf(second as unknown as Element), 'callout:Details~1');

		// `[!note]-` opens folded, and the set holds the folds the reader flipped —
		// so the first callout, whose key is in the set, is the OPEN one.
		assert.equal(first.classList.contains('is-collapsed'), false, 'the flipped callout is open');
		assert.equal(second.classList.contains('is-collapsed'), true, 'its same-titled sibling keeps the source default');
	});

	test('a callout key cannot collide with a heading that reads the same', () => {
		const root = parseHtml(
			processMarkdownHtml(
				'<h2>Details</h2>\n<blockquote><p>[!note]+ Details<br>body</p></blockquote>',
				'/doc.md',
				new Set(),
			),
		);
		const heading = root.querySelector('h2') as unknown as ShimElement;
		const callout = root.querySelector('.callout-foldable') as unknown as ShimElement;

		assert.equal(foldKeyOf(heading as unknown as Element), 'Details');
		assert.equal(foldKeyOf(callout as unknown as Element), 'callout:Details');
	});
});
