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
