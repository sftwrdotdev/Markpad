/**
 * Where the editor is, in the terms a tab records it in.
 *
 * `Tab.scrollPercentage` and `Tab.anchorLine` have two writers, one per pane.
 * The preview's is `handleScroll` in MarkdownViewer, which measures the DOM and
 * writes straight through on every scroll event. The editor's is here, and it
 * is asked rather than volunteered: the numbers below are Monaco LAYOUT reads,
 * too expensive to take on every keystroke and every scroll, so `Editor.svelte`
 * takes them at the moments a stale record would be seen — its own teardown,
 * and the flush a caller asks for before reading a tab's position while the
 * editor is still mounted.
 *
 * The whole derivation lives in this one function so those moments cannot
 * disagree. The disagreement worth naming is the numbering: Monaco counts from
 * the first line of the FILE and a tab's anchor counts from the first line of
 * the BODY, so a second site deriving its own anchor is a second chance to make
 * that crossing differently. There is one crossing, it is
 * `tabAnchorForEditorTopLine`, and this is the only caller in the editor.
 */

import {
	asBufferLine,
	lineCoordinates,
	tabAnchorForEditorTopLine,
	type RendererLine,
} from './lineCoordinates.js';

/**
 * One reading of the editor. Every field is a layout read; the caller pays for
 * them once.
 *
 * The two heights are Monaco's `getScrollHeight()` and `getLayoutInfo().height`,
 * named after what they mean rather than after the DOM properties that answer
 * the same questions about an element. Nothing here touches an element, and
 * borrowing the DOM's spelling in this directory trips the guardrail that keeps
 * fold heights off the scrollable extent (singleImplementationConvention).
 */
export interface EditorViewport {
	scrollTop: number;
	/** The full scrollable extent of the document. */
	contentHeight: number;
	/** What fits on screen. */
	viewportHeight: number;
	/**
	 * Monaco's first visible line, a BUFFER line — `null` when the editor has
	 * no model or nothing laid out yet, which is not the same as line 1.
	 */
	topLine: number | null;
	/** The buffer's text, and only for the front-matter shift the crossing applies. */
	text: string;
}

/**
 * `null` on either field means this reading says nothing about it, so whatever
 * the tab already records stands: a document shorter than the viewport has no
 * meaningful percentage, and an editor with no visible range has no top line.
 * Writing 0 in either case would move the reader to the top of the document.
 */
export interface EditorReadingPosition {
	scrollPercentage: number | null;
	anchorLine: RendererLine | null;
}

export function editorReadingPosition(view: EditorViewport): EditorReadingPosition {
	return {
		scrollPercentage:
			view.contentHeight > view.viewportHeight
				? view.scrollTop / (view.contentHeight - view.viewportHeight)
				: null,
		anchorLine:
			view.topLine === null
				? null
				: tabAnchorForEditorTopLine(lineCoordinates(view.text), asBufferLine(view.topLine)),
	};
}
