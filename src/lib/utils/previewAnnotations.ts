import { pointAtSource, sourceAtPoint, type SourceLineReader, type SourcePoint } from './previewCursor.js';

/**
 * A reader's highlight in the preview, kept for this session only: nothing is
 * written to the file. Held as source points rather than DOM ranges, since the
 * preview replaces its blocks on re-render, and drawn through the CSS Custom
 * Highlight API, which paints ranges without touching the DOM.
 */
export type Annotation = { start: SourcePoint; end: SourcePoint };

function before(a: SourcePoint, b: SourcePoint): boolean {
	return a.line < b.line || (a.line === b.line && a.column < b.column);
}

/** Half-open ranges: touching ends do not overlap. */
export function overlaps(a: Annotation, b: Annotation): boolean {
	return before(a.start, b.end) && before(b.start, a.end);
}

export function overlapping(marks: readonly Annotation[], span: Annotation): Annotation[] {
	return marks.filter((mark) => overlaps(mark, span));
}

/** An empty span, the point a right-click landed on, still hits the mark around it. */
export function hitAt(marks: readonly Annotation[], at: SourcePoint): Annotation[] {
	return marks.filter((mark) => !before(at, mark.start) && before(at, mark.end));
}

/** A DOM range in the preview as source points, or null where either end maps to no block. */
export function annotationOf(root: Element, range: AbstractRange, readLine: SourceLineReader): Annotation | null {
	const start = sourceAtPoint(root, { node: range.startContainer, offset: range.startOffset }, readLine);
	const end = sourceAtPoint(root, { node: range.endContainer, offset: range.endOffset }, readLine);
	return start && end ? { start, end } : null;
}

/** The DOM range an annotation covers in the preview as rendered now. */
export function rangeOf(root: Element, mark: Annotation, readLine: SourceLineReader): Range | null {
	const start = pointAtSource(root, mark.start, readLine);
	const end = pointAtSource(root, mark.end, readLine);
	if (!start || !end) return null;
	const range = root.ownerDocument.createRange();
	range.setStart(start.node, start.offset);
	range.setEnd(end.node, end.offset);
	return range.collapsed ? null : range;
}

/**
 * Every copy of `needle` in the preview's text, up to `limit`, for the preview's
 * Highlight Occurrences. Case-sensitive, and no overlaps.
 */
export function occurrenceRanges(root: Element, needle: string, limit: number): Range[] {
	// ponytail: matches within one text node, so a copy split by markup (half of
	// it bold) is missed; join the block's text first if readers ask for it.
	const walker = root.ownerDocument.createTreeWalker(root, 4 /* NodeFilter.SHOW_TEXT */, {
		acceptNode: (node) => (node.parentElement?.closest('.katex') ? 2 /* FILTER_REJECT */ : 1 /* FILTER_ACCEPT */),
	});
	const ranges: Range[] = [];
	for (let node = walker.nextNode() as Text | null; node && ranges.length < limit; node = walker.nextNode() as Text | null) {
		for (let at = node.data.indexOf(needle); at !== -1 && ranges.length < limit; at = node.data.indexOf(needle, at + needle.length)) {
			const range = root.ownerDocument.createRange();
			range.setStart(node, at);
			range.setEnd(node, at + needle.length);
			ranges.push(range);
		}
	}
	return ranges;
}
