/**
 * Which outline entry the EDITOR is inside.
 *
 * The outline already follows the preview: `Toc.svelte` listens to the
 * preview's scroll event and picks the last heading whose rendered box is above
 * the top of the viewport. That mechanism needs a rendered box, so it has
 * nothing to say while the reader is in the editor — in split view the preview
 * scrolls along only when scroll sync is on, and in editor-only mode there is
 * no preview scrolling at all, which is the half of #169 the reporter asked
 * for ("while scrolling through the editor or preview").
 *
 * The editor's answer is a SOURCE LINE, which every outline entry already
 * carries: `data-sourcepos` is on the rendered heading, and the outline is
 * built from those elements. So the same question is answered here by
 * comparison instead of by layout.
 *
 * Deliberately the same shape as the preview's rule, so the two cannot
 * disagree while both are live: the last entry at or above the position, and
 * the first entry when the position is above all of them.
 */
import { asRendererLine, type RendererLine } from './lineCoordinates.js';

export type TocLineEntry = {
	id: string;
	/** `null` for an entry the renderer gave no source range (a block anchor). */
	line: RendererLine | null;
};

/**
 * Renderer lines throughout: the outline is built out of `data-sourcepos`, so
 * both the entries and the position they are compared against count from the
 * first line of the body. The editor's answer is a buffer line and has to go
 * through `lineCoordinates` on the way in — which the types now insist on,
 * because that conversion was missing for as long as the outline existed.
 */
export function activeTocIdForLine(entries: readonly TocLineEntry[], line: RendererLine): string | null {
	if (!Number.isFinite(line) || entries.length === 0) return null;

	// Above the first heading the first entry is the active one — what the
	// preview's handler does with `visibleItems[0]` before its loop.
	let active: string | null = entries[0].id;
	for (const entry of entries) {
		if (entry.line !== null && entry.line <= line) active = entry.id;
	}

	return active;
}

/** The start line of a rendered block, from the `data-sourcepos` comrak wrote. */
export function sourceLineOf(sourcepos: string | null | undefined): RendererLine | null {
	const line = Number(sourcepos?.match(/^(\d+):/)?.[1]);
	return Number.isInteger(line) && line > 0 ? asRendererLine(line) : null;
}
