// Split-view scroll sync maps a position in one pane onto pixels in the other.
//
// The two panes are not proportional to each other. Front matter renders as a
// fixed-height panel in the preview and as ordinary text lines in the editor, so
// the same document gives the two panes different total scroll ranges *and* a
// different share of that range spent on front matter. A single global
// scrollTop/scrollMax ratio therefore drifts: at the moment the editor finishes
// scrolling past its front matter, the naive ratio has already carried the
// preview well into the body.
//
// The fix is to split the range in two at `frontMatterEnd` and carry a
// (section, ratio) pair between the panes instead of a raw ratio. Front matter
// maps onto front matter and body onto body, whatever each pane's proportions
// are, and the boundary maps onto the boundary exactly.
//
// Both functions are pure arithmetic. They lived, byte for byte, in both
// Editor.svelte and MarkdownViewer.svelte; neither copy could be imported by a
// test, because `node --test` cannot load a `.svelte` file. Here they are
// covered for real by scripts/scrollSync.test.ts.
//
// Splitting the range at the front matter is not enough on its own. Inside the
// body a ratio is still wrong, for the same reason it is wrong across the
// boundary: forty source lines of table render as a tall block and forty of
// prose as a short one, so equal progress through the source is not equal
// progress through the rendered height, and the error accumulates towards the
// end of the document — which is where #205 reports it. A position therefore
// also carries the SOURCE LINE at the pane's anchor, and each pane resolves
// that line through its own layout. The ratio stays in the payload as the
// fallback for the positions no line can describe.

// The line each pane reports is the one at the TOP of its own viewport — the
// pane's `scrollTop` exactly, with nothing added. That is the only offset at
// which the ends of the document are fixed points of the mapping: pin the line
// 60px down instead, as the tab restore does, and a reader at the top of the
// editor puts the preview 36px into the document, because 60px is a different
// line in each pane. `PREVIEW_ANCHOR_OFFSET` is a separate decision about a
// separate feature — where to put a line the reader is being *returned* to.

import type { BufferLine } from './lineCoordinates.js';

export type ScrollSyncPosition = {
	section: 'frontmatter' | 'body';
	ratio: number;
	/**
	 * Fractional BUFFER line at the sending pane's anchor. Absent when the
	 * sender could not resolve one — front matter (which renders as a panel with
	 * no source range at all, so only `section`/`ratio` can carry it) or a
	 * document with no annotated block. The receiver falls back to the ratio.
	 *
	 * Buffer, because the editor is the only pane that can produce one and the
	 * buffer is all it knows. The preview's own numbering starts at the first
	 * line of the body, so its half of this crossing goes through
	 * `lineCoordinates` — and the type is what says so, rather than a comment
	 * the next crossing can be written without reading.
	 */
	line?: BufferLine;
};

function clampScrollRatio(value: number) {
	if (!Number.isFinite(value)) return 0;
	return Math.max(0, Math.min(1, value));
}

export function getScrollSyncPositionFromPixels(scrollTop: number, scrollMax: number, frontMatterEnd: number): ScrollSyncPosition {
	const safeMax = Math.max(0, scrollMax);
	const safeFrontMatterEnd = Math.max(0, Math.min(safeMax, frontMatterEnd));
	const safeScrollTop = Math.max(0, Math.min(safeMax, scrollTop));

	if (safeFrontMatterEnd > 0 && safeScrollTop < safeFrontMatterEnd) {
		return {
			section: 'frontmatter',
			ratio: clampScrollRatio(safeScrollTop / safeFrontMatterEnd),
		};
	}

	const bodyRange = Math.max(0, safeMax - safeFrontMatterEnd);
	return {
		section: 'body',
		ratio: bodyRange > 0 ? clampScrollRatio((safeScrollTop - safeFrontMatterEnd) / bodyRange) : 0,
	};
}

export function getScrollTopForSyncPosition(position: ScrollSyncPosition, scrollMax: number, frontMatterEnd: number) {
	const safeMax = Math.max(0, scrollMax);
	const safeFrontMatterEnd = Math.max(0, Math.min(safeMax, frontMatterEnd));
	const ratio = clampScrollRatio(position.ratio);

	if (position.section === 'frontmatter') {
		return safeFrontMatterEnd * ratio;
	}

	const bodyRange = Math.max(0, safeMax - safeFrontMatterEnd);
	return safeFrontMatterEnd + bodyRange * ratio;
}

/*
 * The editor's half of the line mapping.
 *
 * Monaco publishes line -> pixel (`getTopForLineNumber`) and nothing for the
 * inverse, so the inverse is a binary search over the same function: it is
 * non-decreasing in the line number, which is all a search needs. That costs
 * ~log2(lineCount) calls — 14 on a 10,000-line document — instead of the walk
 * a line-height table would need, and it stays correct with folded regions,
 * wrapped lines and view zones, none of which have a uniform height.
 *
 * `topForLine` must accept `lineCount + 1` (Monaco does; it answers with the
 * bottom of the last line), because that is the height of the last line. That
 * is also why the line these two agree on runs to `lineCount + 1` rather than
 * to `lineCount`: the bottom edge of the document is a position the reader can
 * scroll to, and rounding it down to the top of the last line would make the
 * end of the document — the part #205 is about — the one place the round trip
 * did not close.
 */
type LineTopLookup = (line: number) => number;

/** Fractional line number rendered at `offset`. Inverse of the function below. */
export function getLineAtVerticalOffset(offset: number, lineCount: number, topForLine: LineTopLookup): number {
	if (!Number.isFinite(offset) || !Number.isFinite(lineCount) || lineCount < 1) return 1;

	let low = 1;
	let high = Math.floor(lineCount);
	while (low < high) {
		const mid = Math.ceil((low + high) / 2);
		if (topForLine(mid) <= offset) low = mid;
		else high = mid - 1;
	}

	const top = topForLine(low);
	const bottom = topForLine(low + 1);
	const height = bottom - top;
	if (!Number.isFinite(height) || height <= 0) return low;

	return low + Math.max(0, Math.min(1, (offset - top) / height));
}

/** Vertical offset of a fractional line. Inverse of the function above. */
export function getVerticalOffsetForLine(line: number, lineCount: number, topForLine: LineTopLookup): number {
	if (!Number.isFinite(line) || !Number.isFinite(lineCount) || lineCount < 1) return 0;

	const clamped = Math.max(1, Math.min(lineCount + 1, line));
	const index = Math.floor(clamped);
	const top = topForLine(index);

	const fraction = clamped - index;
	if (fraction <= 0) return top;

	const bottom = topForLine(index + 1);
	const height = bottom - top;
	return Number.isFinite(height) && height > 0 ? top + height * fraction : top;
}
