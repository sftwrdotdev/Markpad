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

/**
 * The fields of a tab the derivation below reads. Structural rather than
 * `Tab`, because the store imports this module and not the other way round —
 * and because a plain object is what the tests can hand it.
 */
export interface StoredTabPosition {
	id: string;
	isEditing: boolean;
	isSplit: boolean;
	/** `monaco.editor.ICodeEditorViewState | null` — see `Tab.editorViewState`. */
	editorViewState: any;
	/** The buffer, for the front-matter shift the crossing applies. */
	rawContent: string;
	/** What the tab records today, and what is returned unless the rule applies. */
	anchorLine: RendererLine;
}

/**
 * The anchor line to write down for `tab` at the two moments its position
 * leaves memory: `TabManager.serializeState` and the cross-window snapshot.
 *
 * For almost every tab the answer is the one already on the tab. The exception
 * is a tab left in EDIT-ONLY mode in the background, which is the one
 * population no writer of `Tab.anchorLine` covers. Both writers only ever
 * touch the ACTIVE tab: `handleScroll` in MarkdownViewer writes
 * `tabManager.activeTabId`, and `writeEditorPosition` in Editor writes the tab
 * the single editor is holding, which is the active one. So a tab sitting in
 * the background in edit-only mode has had neither pane speak for it since it
 * stopped being active — its preview is not on screen (the viewer pane gets
 * `flex: 0`, so it never scrolls), and the editor moved on to another model.
 * `editorViewState` is what covers that gap in memory, because the
 * tab-activation effect saves it on the way out of every switch; it is also
 * the one field that survives neither gate — `serializeState` does not write
 * it and `restoreState` seeds `null`, and `tabTransfer.ts` excludes it. Past
 * either gate the tab is left with an `anchorLine` from the last time it was
 * active in some other mode, or `0` for one opened straight into edit mode.
 *
 * So the top line is recovered from the view state instead, which needs no
 * live editor and no layout read: `viewState.firstPosition` is Monaco's own
 * record of the line at the top of the viewport. It is a BUFFER line, and the
 * crossing into the tab's renderer numbering is `tabAnchorForEditorTopLine`,
 * the same one and only one `editorReadingPosition` above uses.
 *
 * The rule is a population, and the two tabs it excludes are the ones that
 * would be made WORSE by including them:
 *
 * - `!isEditing`, i.e. a tab that has left edit mode. Nothing clears
 *   `editorViewState` when it does (only `clearReadingPosition`, on pointing
 *   the tab at another document, ever does), so a tab the reader edited,
 *   switched to reading mode and then scrolled carries a stale view state
 *   under a FRESH `anchorLine` that the preview wrote. Deriving there replaces
 *   a correct record with an older one.
 * - `isSplit`, because a split tab has its preview on screen writing
 *   `anchorLine` on every scroll event. Its record is a real reading position
 *   from a pane the reader was using, and the editor is scrolled independently
 *   of it unless `isScrollSynced`.
 *
 * The active tab is excluded for a different reason: it is the one tab a live
 * editor can be asked about, and #735 already asks — `flushPositionTo` runs
 * immediately before both gates. That reading is the better one, and it is
 * not the same one. Monaco's `saveViewState` records
 * `getLineNumberAtVerticalOffset(scrollTop)`, the first PARTIALLY visible
 * line, while `getVisibleRanges()` — what the flush reads — starts at
 * `completelyVisibleStartLineNumber`. The two differ by one whenever the top
 * line is cut in half by the viewport, which is most scroll positions, so
 * deriving over the flush would move the active tab by a line for no reason.
 * A tab in this population is always the active one or not; the editor holds
 * the active tab whenever that tab is `isEditing || isSplit`, which every tab
 * here is.
 *
 * Only `anchorLine` is recoverable. `scrollPercentage` is a fraction of the
 * scrollable range and the view state carries neither height, so there is no
 * honest number to write and this leaves that field alone. It costs nothing:
 * `anchorLine` is the first entry of both restore cascades (see
 * `Tab.scrollPercentage`), so it is the field that decides where the tab
 * opens.
 */
export function outgoingTabAnchorLine(
	tab: StoredTabPosition,
	activeTabId: string | null,
): RendererLine {
	if (!tab.isEditing || tab.isSplit || tab.id === activeTabId) return tab.anchorLine;

	// `editorViewState` is `any` and can be a view state written by an older
	// Monaco, which had no `firstPosition` — `reduceRestoreState` still carries
	// a path for those, so this is not hypothetical.
	const topLine = tab.editorViewState?.viewState?.firstPosition?.lineNumber;
	if (typeof topLine !== 'number') return tab.anchorLine;

	return tabAnchorForEditorTopLine(lineCoordinates(tab.rawContent), asBufferLine(topLine));
}
