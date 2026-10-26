import { asRendererLine, type LineCoordinates, type RendererLine } from './lineCoordinates.js';
import { getSourceLineAtPreviewOffset, PREVIEW_ANCHOR_OFFSET, type AnchorNode, type MeasureAnchorBox } from './previewAnchor.js';
import { getScrollSyncPositionFromPixels, getScrollTopForSyncPosition, type ScrollSyncPosition } from './scrollSync.js';

/**
 * The preview's scrolling element, as these functions read it. Its scroll
 * extent (`scrollMax`) is the caller's measurement.
 */
export type PreviewScroller = AnchorNode & {
	readonly scrollTop: number;
	querySelector(selector: string): AnchorNode | null;
};

function getPreviewFrontMatterScrollEnd(target: PreviewScroller, scrollMax: number, measure: MeasureAnchorBox) {
	const panel = target.querySelector('.frontmatter-panel');
	if (!panel) return 0;

	// In the same space as `target.scrollTop`, which is what it is compared
	// against — see `measurePreviewBox`.
	const box = measure(panel);
	return Math.max(0, Math.min(scrollMax, box.top + box.height));
}

export function getPreviewScrollSyncPosition(
	target: PreviewScroller,
	scrollMax: number,
	lineCoords: LineCoordinates,
	measure: MeasureAnchorBox,
): ScrollSyncPosition {
	const position = getScrollSyncPositionFromPixels(
		target.scrollTop,
		scrollMax,
		getPreviewFrontMatterScrollEnd(target, scrollMax, measure),
	);

	// Front matter is a rendered panel with no source range, so there is no
	// line to send and the section ratio is the only thing that can carry it.
	// This is the carve-out `scrollSync.ts` exists for, unchanged.
	if (position.section !== 'body') return position;

	const line = lineCoords.bufferLineAtPreviewOffset(target, target.scrollTop, measure);

	return line === null ? position : { ...position, line };
}

/**
 * Where the preview has to scroll to show `position`, or null when it is
 * already within 5px of it.
 */
export function getPreviewScrollTopForSyncPosition(
	target: PreviewScroller,
	scrollMax: number,
	position: ScrollSyncPosition,
	lineCoords: LineCoordinates,
	measure: MeasureAnchorBox,
): number | null {
	let targetScroll: number | null = null;

	if (position.section === 'body' && position.line !== undefined) {
		const offset = lineCoords.previewOffsetForBufferLine(
			target,
			position.line,
			measure,
		);
		if (offset !== null) targetScroll = offset;
	}

	if (targetScroll === null) {
		targetScroll = getScrollTopForSyncPosition(
			position,
			scrollMax,
			getPreviewFrontMatterScrollEnd(target, scrollMax, measure),
		);
	}

	// The line mapping can point past either end — the last block interpolates
	// beyond the bottom of a preview that has no room left to scroll. Clamping
	// before the threshold check is what keeps `isProgrammaticScroll` honest:
	// an unreachable target fires no scroll event, and the flag would then be
	// spent swallowing the reader's next real scroll instead.
	targetScroll = Math.max(0, Math.min(scrollMax, targetScroll));

	if (Math.abs(target.scrollTop - targetScroll) <= 5) return null;
	return targetScroll;
}

/**
 * The source line to save as this tab's reading position: the one rendered
 * `PREVIEW_ANCHOR_OFFSET` below the top of the viewport, which is where the
 * restore puts it back.
 *
 * This used to be its own scan — `querySelectorAll('[data-sourcepos]')` over
 * the whole preview, then `offsetTop` and `offsetHeight` on every element it
 * returned, on every scroll event. Two things were wrong with that beyond the
 * cost (8.3ms per event on a 13,000-line document, measured in Chrome). It
 * took the FIRST element covering the offset in document order, which is the
 * outermost, while the restore's `findAnchorElement` takes the narrowest — so
 * capture and restore disagreed about which block a position belonged to. And
 * it had no opinion about `<br>`, which carries a source range and no box, so
 * an anchor at the top of the document could resolve to one (#464).
 */
export function getPreviewScrollAnchor(target: PreviewScroller, measure: MeasureAnchorBox): RendererLine | null {
	const line = getSourceLineAtPreviewOffset(
		target,
		target.scrollTop + PREVIEW_ANCHOR_OFFSET,
		measure,
	);

	// Straight off `data-sourcepos`, so it is already a renderer line: the
	// two consumers — the tab's saved reading position and the outline —
	// both count from the first line of the body.
	return line === null ? null : asRendererLine(Math.round(line));
}
