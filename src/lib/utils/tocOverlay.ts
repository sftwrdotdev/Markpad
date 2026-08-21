import type { SplitEditorSide } from './splitPanes.js';

export type TocSide = 'left' | 'right';

export interface TocPlacement {
	isEditing: boolean;
	isSplit: boolean;
	tocSide: TocSide;
	splitEditorSide: SplitEditorSide;
}

export interface TocOverhangInput extends TocPlacement {
	isFullWidth: boolean;
	/** Client width of the VIEWER pane. Zero while that pane is collapsed. */
	viewerWidth: number;
	/** The preview's centred content width, or null when it fills the pane. */
	previewContentWidth: number | null;
	tocWidth: number;
}

/**
 * The narrowest gutter the outline may share with the text before it counts as
 * covering it. Below this the "gap" reads as a collision either way.
 */
const MIN_GUTTER = 50;

/**
 * Is the preview the thing underneath the outline?
 *
 * The outline is positioned against the LAYOUT container, not against the pane
 * it happens to land on. "Is there room beside the text?" is therefore only the
 * right question when the pane underneath is the preview: the preview centres
 * its content and leaves a gutter either side, while the editor fills its pane
 * edge to edge and has no gutter to lend.
 *
 * Only a split has two panes to put in an order. In the other two modes the
 * pane that is rendered fills the container and holds both edges at once, so
 * the outline lands on it whichever side it is pinned to — which is why the
 * side is not consulted there:
 *
 *   reading        viewer alone           → preview on both sides
 *   editing only   viewer is `flex: 0`    → editor on both sides
 *   split          two panes              → whichever one is not on `tocSide`
 *
 * The split row used to be read off the DOM order instead, on the grounds that
 * the editor is the first child and so takes the left edge. `splitEditorSide`
 * reverses that row (#184), and it reverses it with `flex-direction`, which
 * leaves the first child exactly where it was in the markup. Asking the
 * preference is the only way to see it.
 */
export function isTocOverPreview({ isEditing, isSplit, tocSide, splitEditorSide }: TocPlacement): boolean {
	if (isSplit) return tocSide !== splitEditorSide;
	return !isEditing;
}

/**
 * Does the outline sit ON TOP of what the reader is reading?
 *
 * This drives the shadow and border that tell the reader the panel is floating
 * over their text rather than beside it, and it gates the auto-collapse: an
 * outline that is not covering anything has no reason to get out of the way.
 *
 * Measuring the viewer pane was only ever right in reading mode. In the other
 * two the outline covers the editor, and in editing-only mode `viewerWidth` is
 * 0, so the old test answered "no overlap" while the panel sat on the code.
 */
export function isTocOverhanging(input: TocOverhangInput): boolean {
	// Nothing under it centres its content, so there is no gutter to fall into.
	if (!isTocOverPreview(input)) return true;
	if (input.isFullWidth) return true;
	if (input.viewerWidth <= 0 || input.previewContentWidth === null) return false;
	const gutter = (input.viewerWidth - input.previewContentWidth) / 2;
	return input.tocWidth > Math.max(MIN_GUTTER, gutter);
}
