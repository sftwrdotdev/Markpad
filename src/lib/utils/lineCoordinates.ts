/**
 * The two line numberings, and the single place the shift between them lives.
 *
 * A line has two names in this app. The BUFFER line is what the editor holds:
 * line 1 is the first line of the file, front matter included. The RENDERER
 * line is what the preview knows: `renderMarkdownPreview` hands comrak
 * `getMarkdownBodyWithoutFrontMatter(raw)`, so every `data-sourcepos` — and
 * everything built out of one, which is the outline, the tab's reading position
 * and both halves of scroll sync — counts from the first line of the BODY.
 *
 * The difference is `frontMatterLineOffset(raw)` and it is invisible in any
 * document without front matter, which is most documents and was every fixture.
 * That is what made it a bug that could be introduced over and over: the shift
 * was applied by hand at each of the five places the two numberings meet, both
 * numbers were `number`, and a crossing that forgot it compiled and passed.
 *
 * So the two are different TYPES here. They are still numbers at run time —
 * the brands below have no representation — but a `RendererLine` is not
 * assignable to a `BufferLine` or the other way round, which means a crossing
 * that forgets to convert is a type error rather than a document that scrolls
 * to the wrong place. The conversion itself exists once, in `lineCoordinates`,
 * and the front-matter offset is read there and nowhere else.
 *
 * The pixel end of the mapping stays where it already was: Monaco answers for
 * the editor (`getLineAtVerticalOffset` in scrollSync.ts) and the descent
 * answers for the preview (previewAnchor.ts). What this module adds is the
 * preview pair in BUFFER lines, because that is the crossing the viewer's
 * scroll sync makes on every scroll event — and the crossing whose glue the
 * tests used to re-implement rather than import.
 */

import { frontMatterLineOffset } from './frontMatter.js';
import {
	getPreviewOffsetForSourceLine,
	getSourceLineAtPreviewOffset,
	type AnchorNode,
	type LineRange,
	type MeasureAnchorBox,
} from './previewAnchor.js';

/**
 * A line number in the editor's buffer: line 1 is the first line of the file.
 *
 * The brand is a phantom property. Nothing ever writes it and nothing can read
 * it, so a `BufferLine` is a `number` in every way that matters at run time —
 * arithmetic, comparison and JSON all behave exactly as before. What it buys is
 * that a plain `number` cannot be passed where one of these is wanted without
 * saying which of the two it is.
 */
export type BufferLine = number & { readonly __lineSpace: 'buffer' };

/** A line number as `data-sourcepos` writes it: line 1 is the first line of the body. */
export type RendererLine = number & { readonly __lineSpace: 'renderer' };

/** `LineRange` moved onto the buffer's numbering — what the editor can be aimed with. */
export type BufferLineRange = {
	startLine: BufferLine;
	endLine: BufferLine;
};

/**
 * The escape hatches, for the two places a number arrives from outside this
 * type system: Monaco (buffer lines) and `data-sourcepos` (renderer lines).
 * They are deliberately verbose to write, because every use of one is a claim
 * about which numbering a bare number was in, and a wrong claim is the bug
 * these types exist to prevent.
 */
export function asBufferLine(line: number): BufferLine {
	return line as BufferLine;
}

export function asRendererLine(line: number): RendererLine {
	return line as RendererLine;
}

export type LineCoordinates = {
	/** How many buffer lines sit above the body; `0` without front matter. */
	readonly frontMatterLines: number;
	toBufferLine(line: RendererLine): BufferLine;
	toRendererLine(line: BufferLine): RendererLine;
	/**
	 * A range read off `data-sourcepos` (the context menu's selection, an
	 * outline entry) moved onto the buffer, which is the only numbering the
	 * editor can be aimed with.
	 */
	toBufferRange(range: LineRange): BufferLineRange;
	/**
	 * The buffer line rendered at `offset` in the preview's scroll content, and
	 * its inverse. Both are the preview's own mapping with the shift applied, so
	 * a caller holding a buffer line never has to know there was one.
	 */
	bufferLineAtPreviewOffset(root: AnchorNode, offset: number, measure: MeasureAnchorBox): BufferLine | null;
	previewOffsetForBufferLine(root: AnchorNode, line: BufferLine, measure: MeasureAnchorBox): number | null;
};

/**
 * The coordinate systems of one document.
 *
 * `rawContent` is the buffer, not the render — measuring the render would
 * answer 0 forever, since the render is what the front matter was stripped out
 * of. Cheap enough to derive on every content change, which is what the viewer
 * does: the offset is one `parseFrontMatter` and the rest is closures.
 */
export function lineCoordinates(rawContent: string): LineCoordinates {
	const frontMatterLines = frontMatterLineOffset(rawContent);

	const toBufferLine = (line: RendererLine): BufferLine => asBufferLine(line + frontMatterLines);
	const toRendererLine = (line: BufferLine): RendererLine => asRendererLine(line - frontMatterLines);

	return {
		frontMatterLines,
		toBufferLine,
		toRendererLine,
		toBufferRange: (range) => ({
			startLine: toBufferLine(asRendererLine(range.startLine)),
			endLine: toBufferLine(asRendererLine(range.endLine)),
		}),
		bufferLineAtPreviewOffset: (root, offset, measure) => {
			const line = getSourceLineAtPreviewOffset(root, offset, measure);
			return line === null ? null : toBufferLine(line);
		},
		previewOffsetForBufferLine: (root, line, measure) =>
			getPreviewOffsetForSourceLine(root, toRendererLine(line), measure),
	};
}
