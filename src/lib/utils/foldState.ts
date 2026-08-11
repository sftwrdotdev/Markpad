/**
 * Who owns a fold.
 *
 * A fold is one thing with three drivers: the chevron in the preview, the
 * outline's fold button, and find opening whatever is hiding a match. Each of
 * them used to reach the state by a different route, and the routes disagreed.
 *
 * - The heading chevron wrote `tab.collapsedHeaders`; the callout title wrote
 *   `classList.toggle('is-collapsed')` and nothing else, so a folded callout
 *   sprang open again on the next render — which is every keystroke in split
 *   view. Two affordances that look identical, one of them amnesiac.
 * - Find had no way to say "open this", so it built a `MouseEvent` and fired
 *   it at the chevron, hoping the viewer's delegated click handler would pick
 *   it up. Three modules coupled through a class name and a synthetic event.
 * - The key that identifies a fold was spelled out three times — in the
 *   renderer, in the preview's click handler and in the outline — and the
 *   outline's spelling did not match the other two for a heading whose text
 *   carries a block id.
 *
 * So the key is computed exactly once, by `assignFoldKey`, while the markup is
 * being built, and written into that markup as `data-fold-key`. Every later
 * reader asks the element (`foldKeyOf`) instead of recomputing, which is why
 * there is no second algorithm left to drift. Everything else here is about
 * getting from something the user pointed at — a chevron, a key from the
 * outline, a search hit buried in a collapsed section — to the pair of
 * elements that wear `is-collapsed`.
 *
 * What the tab stores is deliberately NOT "the folds that are closed": it is
 * the folds whose state differs from the one the document asks for. Headings
 * always start open, so for them the two readings are the same set — which is
 * why the stored field survived this change unaltered in meaning for every
 * heading. Callouts do not: `> [!note]-` starts closed. Storing "closed" would
 * make a callout the reader OPENED indistinguishable from one they never
 * touched, and the next render would shut it again — symptom A over, with the
 * sign flipped. Storing the deviation costs one `!==` and answers both.
 */

/** Where `assignFoldKey` leaves its answer for every later reader. */
export const FOLD_KEY_ATTR = 'data-fold-key';

const HEADING_HEAD_CLASS = 'foldable-header';
const HEADING_CONTENT_CLASS = 'foldable-content-wrapper';
const CALLOUT_CONTENT_CLASS = 'markdown-alert-content';
const COLLAPSED_CLASS = 'is-collapsed';

/**
 * The two elements a fold toggles, and the key its state is stored under.
 *
 * `head` is what the reader clicks and what the chevron rotates with; `content`
 * is the box whose height animates. Both carry `is-collapsed` because the CSS
 * needs it in both places, and keeping them in one object is what stops a
 * caller from setting one and forgetting the other.
 */
export interface FoldRegion {
	key: string;
	head: Element;
	content: Element;
}

/**
 * Name this fold, once, and leave the name on it.
 *
 * `taken` is the keys already handed out in this render, so that two callouts
 * with the same title — or two headings with the same text and no id — get
 * keys of their own rather than folding as one. It is the same guarantee
 * comrak gives heading ids, applied to the things comrak does not name.
 *
 * Keys only have to be unique within a document and stable across re-renders of
 * it. Both fall out of keying by content in document order: an edit somewhere
 * else leaves this fold's key alone.
 */
export function assignFoldKey(head: Element, taken: Set<string>): string {
	// A heading's id is comrak's slug, already deduplicated, and it is what the
	// outline and every `#anchor` link name the heading by. Text is the fallback
	// for a heading the renderer gave no id. A callout has neither, so it is
	// keyed by its title, in a namespace of its own so that a callout titled
	// "Notes" and an id-less heading reading "Notes" stay two folds.
	const base = head.classList.contains(HEADING_HEAD_CLASS)
		? head.id || head.textContent?.trim() || ''
		: `callout:${head.querySelector('.callout-title-inner')?.textContent?.trim() ?? ''}`;

	let key = base;
	for (let n = 1; taken.has(key); n += 1) key = `${base}~${n}`;
	taken.add(key);
	head.setAttribute(FOLD_KEY_ATTR, key);
	return key;
}

/** The key the renderer wrote on this element, or `''` if it is not a fold head. */
export function foldKeyOf(head: Element | null | undefined): string {
	return head?.getAttribute(FOLD_KEY_ATTR) ?? '';
}

/**
 * Is this fold closed, for a tab that has these deviations recorded?
 *
 * `foldedInSource` is what the document asks for — `> [!note]-` for a callout,
 * always `false` for a heading. See the note at the top of this file for why
 * the stored set is deviations rather than closures.
 */
export function isFolded(
	overrides: ReadonlySet<string>,
	key: string,
	foldedInSource = false,
): boolean {
	return overrides.has(key) !== foldedInSource;
}

/**
 * The same set with this key's deviation flipped.
 *
 * A NEW set, never a mutation: the viewer holds the tab's set through a
 * `$derived`, and Svelte cannot see an `add` or a `delete` on a Set it is
 * already holding — see `Tab.foldOverrides`.
 */
export function flipFold(overrides: ReadonlySet<string>, key: string): Set<string> {
	const next = new Set(overrides);
	if (!next.delete(key)) next.add(key);
	return next;
}

function regionOfHead(head: Element): FoldRegion | null {
	const key = foldKeyOf(head);
	if (!key) return null;

	// The heading's wrapper is the sibling the renderer inserts right after it
	// (`renderProtocol.test.ts` pins that), so the pairing needs no id lookup
	// and no document to look ids up in. A callout encloses its own content.
	const content = head.classList.contains(HEADING_HEAD_CLASS)
		? head.nextElementSibling
		: head.querySelector(`.${CALLOUT_CONTENT_CLASS}`);
	const contentClass = head.classList.contains(HEADING_HEAD_CLASS)
		? HEADING_CONTENT_CLASS
		: CALLOUT_CONTENT_CLASS;

	return content?.classList.contains(contentClass) ? { key, head, content } : null;
}

/** The fold whose control the reader just clicked — a chevron, or a callout title. */
export function foldRegionAt(control: Element): FoldRegion | null {
	const head = control.closest(`.${HEADING_HEAD_CLASS}, .callout-foldable`);
	return head ? regionOfHead(head) : null;
}

/**
 * The fold this key names, in the document currently on screen.
 *
 * A scan rather than an attribute selector: a callout key is its title, which
 * is arbitrary user text, and building a selector out of it means escaping it
 * correctly for the exact question `getAttribute` answers directly.
 */
export function foldRegionByKey(root: Element, key: string): FoldRegion | null {
	for (const head of Array.from(root.querySelectorAll(`[${FOLD_KEY_ATTR}]`))) {
		if (foldKeyOf(head) === key) return regionOfHead(head);
	}
	return null;
}

export function isFoldCollapsed(region: FoldRegion): boolean {
	return region.content.classList.contains(COLLAPSED_CLASS);
}

/** Put a fold's two elements in the given state. The stored deviation is the caller's. */
export function applyFold(region: FoldRegion, collapsed: boolean): void {
	region.head.classList.toggle(COLLAPSED_CLASS, collapsed);
	region.content.classList.toggle(COLLAPSED_CLASS, collapsed);
}

/**
 * Every collapsed fold between `el` and the preview root, outermost first.
 *
 * Find calls this to learn what is hiding a match. Outermost first so that a
 * nested fold is already on screen by the time its own height is measured.
 */
export function collapsedFoldsAround(el: Element, root: Element): FoldRegion[] {
	const folds: FoldRegion[] = [];
	for (let curr = el.parentElement; curr && curr !== root; curr = curr.parentElement) {
		if (!curr.classList.contains(COLLAPSED_CLASS)) continue;

		const head = curr.classList.contains(HEADING_CONTENT_CLASS)
			? curr.previousElementSibling
			: curr.classList.contains(CALLOUT_CONTENT_CLASS)
				? curr.parentElement
				: null;
		const region = head ? regionOfHead(head) : null;
		if (region) folds.unshift(region);
	}
	return folds;
}
