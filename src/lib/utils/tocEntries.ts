import { foldKeyOf } from './foldState.js';
import { headingText } from './headingReference.js';
import type { RendererLine } from './lineCoordinates.js';
import { sourceLineOf } from './tocFollow.js';

export interface TocItem {
	id: string;
	text: string;
	level: number;
	isBlock: boolean;
	hasChildren?: boolean;
	/**
	 * How the fold state names this heading — read off the rendered heading,
	 * never recomputed, so the outline and the renderer cannot disagree about
	 * it. `''` for a block anchor, which is not a fold.
	 */
	foldKey: string;
	/** Where this entry starts in the source, for following the editor. */
	line: RendererLine | null;
}

/**
 * Everything the outline can show, in the order the document holds it.
 *
 * One query rather than three. `querySelectorAll` returns document order,
 * so asking for the headings and the block anchors together IS the
 * interleaving — this used to ask for each separately and then sort the two
 * lists back together against a third walk (`[id]`, which matches every
 * element in the document carrying one) built into a position map.
 *
 * That cost is per render, and a render is a keystroke. #632 stopped the
 * preview rebuilding its article for one character; an outline that walks
 * the whole of it three times regardless spends a good part of that back,
 * and on the documents where the patch matters most — 7819 elements in
 * `samples/stress-test.md` — it is the largest remaining full-document pass
 * in the render.
 */
const ENTRY_SELECTOR = 'h1, h2, h3, h4, h5, h6, a[id].block-id-anchor, span[id].block-id-anchor';

/** The outline's entries, scanned out of the active tab's `.markdown-blocks`. */
export function buildTocEntries(contentRoot: ParentNode): TocItem[] {
	const result: TocItem[] = [];

	const entries = contentRoot.querySelectorAll(ENTRY_SELECTOR) as NodeListOf<HTMLElement>;
	for (const el of Array.from(entries)) {
		if (el.classList.contains('block-id-anchor')) {
			result.push({ id: el.id, text: el.getAttribute('data-label') || el.id, foldKey: '', level: 0, isBlock: true, line: sourceLineOf(el.dataset.sourcepos) });
			continue;
		}

		// Everything the selector matches that is not a block anchor is a
		// heading, which is the only other thing it asks for.
		const h = el;
		const text = headingText(h);
		const anchor = h.querySelector('a.anchor') as HTMLElement | null;
		const id = h.id || (anchor ? anchor.id : '');
		if (id) {
			result.push({ id, text, foldKey: foldKeyOf(h), level: parseInt(h.tagName[1], 10), isBlock: false, line: sourceLineOf(h.dataset.sourcepos) });
		}
	}

	for (let i = 0; i < result.length; i++) {
		const item = result[i];
		if (item.isBlock) continue;
		item.hasChildren = false;
		
		if (i + 1 < result.length) {
			const next = result[i+1];
			if (next.isBlock || next.level > item.level) {
				item.hasChildren = true;
			}
		}
	}
	return result;
}

/**
 * Decides whether a re-render replaces the items. The line is in it: an edit
 * that only moves a heading changes nothing else about it, and without it the
 * outline would keep answering with the old positions.
 */
export function tocFingerprint(result: readonly TocItem[]): string {
	return result.map(i => `${i.id}-${i.text}-${i.level}-${i.line}`).join('|');
}
