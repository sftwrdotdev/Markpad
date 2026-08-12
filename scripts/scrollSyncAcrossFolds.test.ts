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

import assert from 'node:assert/strict';
import test from 'node:test';

import { installShimDom, parseHtml, NODE_ELEMENT, type ShimElement } from './renderProtocolDom.ts';

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
