/**
 * Resolving a source line to a rendered preview element, and back.
 *
 * Two features share this. Scrolling the preview saves a source line
 * (`tab.anchorLine`, produced by `getPreviewScrollAnchor`) and re-activating the
 * tab has to turn that line back into a scroll offset; split-view scroll sync
 * has to turn the preview's scroll offset into a source line for the editor and
 * a source line from the editor back into a preview offset. Both directions key
 * off the `data-sourcepos` attributes comrak writes onto the rendered blocks.
 *
 * The one thing that makes this non-trivial: `processMarkdownHtml` re-parents
 * everything that follows a heading into a `.foldable-content-wrapper` it
 * creates itself, and that wrapper has no `data-sourcepos` of its own. After
 * that pass the only top-level elements still carrying a source range are the
 * shallowest headings in the document, so a scan of `body.children` can only
 * ever match an anchor that landed exactly on one of those heading lines.
 *
 * Every lookup here therefore descends. It treats an element without a source
 * range as a transparent container whose span is derived from its first and
 * last annotated descendants, which lets it skip a whole section in one
 * comparison instead of visiting every annotated element in the document. The
 * work is proportional to the number of siblings along the path to the match
 * (plus the fold depth), not to the document size. That matters more than it
 * used to: scroll sync runs a lookup on every scroll event, where the flat
 * `querySelectorAll('[data-sourcepos]')` scan it replaced cost 8.3ms per event
 * on a 13,000-line document (measured in Chrome over this pipeline's output;
 * the descent, with the memos below, is 0.9ms on the same document and 0.2ms
 * on a 1,700-line one).
 */

import type { RendererLine } from './lineCoordinates.js';

/** Inclusive source line range, as written in `data-sourcepos`. */
export type LineRange = {
	startLine: number;
	endLine: number;
};

/**
 * The subset of `Element` this module reads. Declaring it structurally keeps
 * the resolution testable against the render-protocol DOM shim, which is what
 * lets the hit rate be measured over real `processMarkdownHtml` output.
 */
export type AnchorNode = {
	readonly nodeType: number;
	readonly tagName?: string;
	readonly childNodes: Iterable<AnchorNode>;
	getAttribute?(name: string): string | null;
	readonly classList?: { contains(token: string): boolean };
};

type AnchorMatch = LineRange & {
	element: AnchorNode;
};

/**
 * Where an element sits in the preview's scroll content, in the same space as
 * the container's `scrollTop`. In the browser this is `offsetTop` /
 * `offsetHeight`, which is what every other measurement in this file assumes.
 */
export type AnchorBox = {
	top: number;
	height: number;
};

export type MeasureAnchorBox = (node: AnchorNode) => AnchorBox;

/**
 * Every line number in this file is a RENDERER line, because every one of them
 * came out of a `data-sourcepos` and that attribute counts from the first line
 * of the body. `lineCoordinates.ts` holds the shift onto the editor's
 * numbering; this is the one place a number is declared to be on this side of
 * it. Imported as a type, so nothing here depends on that module at run time.
 */
const rendererLine = (line: number) => line as RendererLine;

/**
 * The layout API `measureAnchorBox` reads, declared structurally for the same
 * reason `AnchorNode` is: the shim has no layout, so a test supplies its own.
 */
export type OffsetLayoutNode = {
	readonly offsetTop: number;
	readonly offsetHeight: number;
	readonly offsetParent: OffsetLayoutNode | null;
};

function offsetFromRoot(node: OffsetLayoutNode | null): number {
	let total = 0;
	for (let current = node; current; current = current.offsetParent) total += current.offsetTop;
	return total;
}

/**
 * Where an element sits inside `container`'s scroll content.
 *
 * `offsetTop` alone is not that. It is measured from the element's OFFSET
 * PARENT, which CSSOM defines as the nearest ancestor that is positioned — or
 * that is a `table`, `td` or `th`, whatever its position. The preview has both
 * kinds inside it:
 *
 *   .markdown-body          <- the scroll container, the space scrollTop is in
 *     table[data-sourcepos]      offsetTop measured from the container    ✔
 *       tbody
 *         tr[data-sourcepos]     offsetTop measured from the TABLE        ✘
 *     div.code-block-shell       position: relative, added for the copy button
 *       pre[data-sourcepos]      offsetTop measured from the SHELL        ✘
 *
 * comrak stamps a source range on every table row and cell, so the descent
 * goes inside a table and reads a handful of table-relative offsets as if they
 * were document offsets: a line in a table resolves to a couple of hundred
 * pixels and the pane jumps to the top of the document, and every offset in the
 * table is far below every row's box so the reverse direction sticks on the
 * last row until the reader is past the whole table. Both are #205 comments,
 * and the same is true of any code block.
 *
 * Summing the chain and subtracting the container's own puts the box back in
 * the container's space. Subtracting rather than stopping at the container is
 * what keeps it exact when the container is not itself an offset parent: both
 * sums are then measured from the same ancestor above it, and the difference is
 * the same distance either way.
 */
export function measureAnchorBox(element: OffsetLayoutNode, container: OffsetLayoutNode): AnchorBox {
	return {
		top: offsetFromRoot(element) - offsetFromRoot(container),
		height: element.offsetHeight,
	};
}

const ELEMENT_NODE = 1;

/**
 * Elements comrak stamps with a `data-sourcepos` that generate no CSS box the
 * `offsetTop` / `offsetHeight` API can report. `render.hardbreaks` is on, so
 * every soft-wrapped line of prose ends in one of these, and resolving an
 * anchor to one hands the restore `offsetTop = 0, offsetHeight = 0` — which
 * scrolls the preview to the top of the document instead of to the line.
 */
const BOXLESS_TAGS = new Set(['BR', 'WBR']);

function isAnchorable(node: AnchorNode): boolean {
	return !BOXLESS_TAGS.has(node.tagName ?? '');
}

/**
 * Distance from the top of the viewport at which the anchor line is pinned.
 * Capture and restore have to agree on it or every round trip drifts by the
 * difference.
 */
export const PREVIEW_ANCHOR_OFFSET = 60;

/**
 * The factor between the coordinates `getBoundingClientRect()` reports and the
 * ones `scrollTop` is measured in, for anything inside `container`.
 *
 * The preview sets CSS `zoom` on `.markdown-container`, an ANCESTOR of the
 * scrolling element. A rect is reported in viewport pixels, which have that
 * zoom folded in; `scrollTop` counts in the scroller's own pixels, which do
 * not. The two are the same number only at 100%.
 *
 * Measured off the container rather than read from the settings store, so this
 * module keeps knowing nothing about where the zoom is applied or how many
 * ancestors apply one. `offsetWidth` is the container's own layout width and
 * the rect is its rendered width, so the ratio is exactly the accumulated
 * scale — whatever produced it.
 *
 * A container with no layout (display:none, detached) reports `offsetWidth` 0.
 * There is nothing to scroll in that case; 1 keeps the caller's arithmetic
 * finite instead of handing it an Infinity to scroll to.
 */
export function previewZoomFactor(container: HTMLElement): number {
	const layoutWidth = container.offsetWidth;
	if (!layoutWidth) return 1;
	const renderedWidth = container.getBoundingClientRect().width;
	if (!renderedWidth) return 1;
	return renderedWidth / layoutWidth;
}

/**
 * Where `container` has to scroll to for `element` to sit
 * `PREVIEW_ANCHOR_OFFSET` below its top edge.
 *
 * This was written out twice — once for an in-document anchor, once for the
 * outline — and both copies added a rect delta straight to `scrollTop`. At
 * zoom 150% that overshot the heading by half the distance to it, and at 50%
 * it stopped half-way short (#621). Dividing by the factor above puts both
 * terms in the scroller's own pixels before they meet.
 */
export function anchorScrollTop(container: HTMLElement, element: HTMLElement): number {
	const zoom = previewZoomFactor(container);
	const delta = element.getBoundingClientRect().top - container.getBoundingClientRect().top;
	return delta / zoom + container.scrollTop - PREVIEW_ANCHOR_OFFSET;
}

export function parseSourceposLineRange(sourcepos: string | null | undefined): LineRange | null {
	if (!sourcepos) return null;

	const [start, end] = sourcepos.split('-');
	const startLine = parseInt(start?.split(':')[0] ?? '', 10);
	const endLine = parseInt(end?.split(':')[0] ?? '', 10);

	if (Number.isNaN(startLine) || Number.isNaN(endLine)) return null;
	return { startLine, endLine };
}

/**
 * The subset of `Element` the lookup below reads, declared structurally for the
 * same reason `AnchorNode` is: so it can be exercised against the
 * render-protocol DOM shim over real `processMarkdownHtml` output.
 */
export type SourceposElement = {
	getAttribute(name: string): string | null;
	closest(selector: string): SourceposElement | null;
};

/** Any DOM node a selection or a pointer event can land on. */
export type SourceposNode = {
	readonly nodeType: number;
	readonly parentElement?: SourceposElement | null;
	closest?(selector: string): SourceposElement | null;
};

/**
 * The source lines behind whatever `node` is part of: the narrowest annotated
 * element at or above it.
 *
 * Narrowest matters. comrak stamps a range on inline nodes as well as blocks —
 * `<img>`, `<strong>`, `<code>`, `<a>`, `<em>` all carry one — so an image
 * inside a paragraph answers with the image's own line instead of the whole
 * paragraph's. Everything the app renders around the document (the front
 * matter panel, the outline, the window chrome) has no annotated ancestor and
 * answers `null`.
 */
export function findSourceLineRange(node: SourceposNode | null | undefined): LineRange | null {
	const element = node?.nodeType === ELEMENT_NODE ? node : node?.parentElement;
	const annotated = element?.closest?.('[data-sourcepos]');
	return parseSourceposLineRange(annotated?.getAttribute('data-sourcepos'));
}

/**
 * The lines two ends of a preview selection cover together.
 *
 * A selection in the preview can start in one rendered block and end in
 * another, and the two ends resolve independently — so "which source lines did
 * the reader select" is the union of what each end resolved to, and one end on
 * its own when the other landed somewhere with no source range (the front
 * matter panel, the outline, a rendered diagram that lost its range).
 *
 * Lines, never columns, here and everywhere else this attribute is read.
 * `data-sourcepos` describes the text `convert_markdown` handed comrak, not the
 * buffer the user edits: only the LINE numbers of the two are contractually
 * equal (`line_preserving_transforms` in src-tauri/src/lib.rs). The columns are
 * not — masking `$a+b$` for the math pass substitutes a token of a different
 * length, so every column after it on that line is off by the difference.
 */
export function mergeSourceLineRanges(a: LineRange | null, b: LineRange | null): LineRange | null {
	if (!a) return b;
	if (!b) return a;

	return {
		startLine: Math.min(a.startLine, b.startLine),
		endLine: Math.max(a.endLine, b.endLine),
	};
}

function elementChildren(node: AnchorNode): AnchorNode[] {
	const out: AnchorNode[] = [];
	for (const child of node.childNodes) {
		if (child.nodeType === ELEMENT_NODE && isAnchorable(child)) out.push(child);
	}
	return out;
}

/*
 * Both lookups below are memoised on the node, and both memos are WeakMaps
 * keyed by the element itself.
 *
 * This is what makes the mapping affordable on a scroll event. A source range
 * is parsed out of a string and a container's span is derived by walking to its
 * first and last annotated descendants; without a memo both are recomputed for
 * every candidate sibling on every call, and on a 13,000-line document that is
 * ~6ms per mapping — measured, in Chrome, over this pipeline's own output.
 *
 * WHAT INVALIDATES THEM: `invalidateAnchorMemos`, which `patchPreviewBlocks`
 * calls before it touches the tree. It has to, because these answers are no
 * longer a function of a node's identity.
 *
 * They used to be, and this comment used to say so: the preview was rebuilt
 * wholesale by `bind:innerHTML` on every render pass, so a changed document was
 * a new set of nodes and the entries describing the old ones were collected
 * with them. Nothing invalidated these memos because nothing could.
 * `blockPatch.ts` breaks that premise on purpose — it keeps the nodes whose
 * rendering did not change, and rewrites `data-sourcepos` ON THOSE KEPT NODES
 * from the new tree (`refreshSourcepos`, `carrySourcepos`). A kept node is the
 * same key, so its entry survives the edit that changed its range, and the memo
 * keeps answering with the lines the block used to be on — permanently, because
 * nothing is ever going to replace that node either. Every edit that shifts a
 * line number widens the error, and scroll sync, the tab reading position and
 * the outline's current heading all resolve through here.
 *
 * Both maps are dropped whole rather than entry by entry, because `spanCache`
 * cannot be invalidated per node. A span is a property of the subtree, not of
 * the element: the patch keeps a `.foldable-content-wrapper` and replaces a
 * paragraph inside it, and the wrapper's cached span is stale without the
 * wrapper itself having been touched. Per-node invalidation would have to walk
 * to the root from every change and would silently under-invalidate the first
 * time somebody added a case that skipped the walk; two assignments cannot miss
 * an ancestor. The cost is one cold lookup per render pass — renders are
 * debounced against a pause in typing, scroll events are not — and that lookup
 * refills the memo for every event after it.
 *
 * Folding, task checkboxes and rich-content rendering still leave the annotated
 * blocks and their ranges exactly where they were.
 */
let ownRangeCache = new WeakMap<object, LineRange | null>();
let spanCache = new WeakMap<object, LineRange | null>();

/**
 * Forget every memoised range. Whoever rewrites a `data-sourcepos` in place, or
 * changes what is inside a node that is being kept, owes this call.
 */
export function invalidateAnchorMemos(): void {
	ownRangeCache = new WeakMap<object, LineRange | null>();
	spanCache = new WeakMap<object, LineRange | null>();
}

function ownRange(node: AnchorNode): LineRange | null {
	const cached = ownRangeCache.get(node as object);
	if (cached !== undefined) return cached;

	const range = parseSourceposLineRange(node.getAttribute?.('data-sourcepos'));
	ownRangeCache.set(node as object, range);
	return range;
}

/**
 * A collapsed fold (or callout) keeps its children in the layout tree — the
 * wrapper is `height: 0; overflow: hidden`, not `display: none` — so those
 * children still report offsets, and those offsets point at where the content
 * *would* be rather than where it is. Descent stops at such a container and
 * uses the container itself, which sits at the right place on screen.
 */
function isCollapsedContainer(node: AnchorNode): boolean {
	return node.classList?.contains('is-collapsed') === true;
}

/**
 * The span an element covers: its own range, or — for a container the render
 * pipeline created — the range from its first to its last annotated descendant.
 */
function resolveSpan(node: AnchorNode): LineRange | null {
	const cached = spanCache.get(node as object);
	if (cached !== undefined) return cached;

	const span = computeSpan(node);
	spanCache.set(node as object, span);
	return span;
}

function computeSpan(node: AnchorNode): LineRange | null {
	const own = ownRange(node);
	if (own) return own;

	const children = elementChildren(node);

	let first: LineRange | null = null;
	for (const child of children) {
		first = resolveSpan(child);
		if (first) break;
	}
	if (!first) return null;

	let last: LineRange | null = null;
	for (let index = children.length - 1; index >= 0; index -= 1) {
		last = resolveSpan(children[index]);
		if (last) break;
	}

	return { startLine: first.startLine, endLine: Math.max(first.endLine, last?.endLine ?? first.endLine) };
}

/**
 * How far a candidate element is from what the caller is looking for: `0` when
 * it is the thing, otherwise the size of the gap. `NaN` disqualifies a
 * candidate outright, which is how an element the browser could not measure
 * drops out (`NaN < best` is false).
 *
 * One descent serves three lookups — an exact line, the nearest line, and a
 * pixel offset — so the element the two sync directions pick is chosen by the
 * same walk over the same tree with the same skip rules. That is what makes
 * line -> offset -> line an identity rather than an approximation: if the two
 * directions descended differently they could land on an ancestor one way and
 * a descendant the other, and the round trip would drift by the difference.
 */
type AnchorDistance = (span: LineRange, node: AnchorNode) => number;

function lineDistance(span: LineRange, line: number): number {
	if (line < span.startLine) return span.startLine - line;
	if (line > span.endLine) return line - span.endLine;
	return 0;
}

/**
 * A block owns the pixels `[top, top + height)` — half open at the bottom.
 *
 * Adjacent blocks touch: margins collapse, and one block's bottom edge is the
 * next one's top. If both claim that pixel the earlier one wins, because the
 * descent stops at the first candidate whose distance is zero. That is a
 * feedback loop rather than an off-by-one: a line resolved back to a pixel
 * lands on the TOP edge of its block, which the block ABOVE then claims, so
 * every echo between the panes walks the reader one block up the document.
 * (Observed in Chrome over this pipeline's own output; the DOM shim has no
 * layout, so its blocks never touched and the loop was invisible there.)
 *
 * A block whose bottom edge is exactly the offset therefore reports the
 * smallest positive distance instead of zero: still the nearest thing when
 * nothing contains the offset, but beaten by whatever does.
 */
function boxDistance(box: AnchorBox, offset: number): number {
	if (!Number.isFinite(box.top) || !Number.isFinite(box.height)) return Number.NaN;
	if (offset < box.top) return box.top - offset;

	const below = offset - (box.top + box.height);
	if (below < 0) return 0;
	return below > 0 ? below : Number.EPSILON;
}

/**
 * Descend to the narrowest annotated element `distanceOf` says is closest.
 *
 * `strict` is the difference between "which block owns this line" (a line
 * between two blocks owns nothing, and the caller has a fallback for that) and
 * "which block is this scroll position in" — where returning nothing would put
 * a gap between two blocks, or the padding under the last one, back on the
 * proportional mapping and make the panes jump every time the reader crossed
 * one.
 */
function descend(
	node: AnchorNode,
	inherited: AnchorMatch | null,
	distanceOf: AnchorDistance,
	strict: boolean,
): AnchorMatch | null {
	let chosen: AnchorNode | null = null;
	let chosenSpan: LineRange | null = null;
	let chosenOwn: LineRange | null = null;
	let best = Number.POSITIVE_INFINITY;

	for (const child of elementChildren(node)) {
		const own = ownRange(child);
		const span = own ?? resolveSpan(child);
		// No annotated descendant: the front-matter panel, the table of contents,
		// anything else the app renders around the document. Nothing here maps to
		// a source line, so it must not swallow the offset.
		if (!span) continue;

		const distance = distanceOf(span, child);
		if (!(distance < best)) continue;

		best = distance;
		chosen = child;
		chosenSpan = span;
		chosenOwn = own;
		if (distance === 0) break;
	}

	if (!chosen || !chosenSpan) return null;
	if (strict && best > 0) return null;

	const carried: AnchorMatch | null = chosenOwn ? { element: chosen, ...chosenOwn } : inherited;
	const fallback: AnchorMatch = carried ?? { element: chosen, ...chosenSpan };

	if (!chosenOwn && isCollapsedContainer(chosen)) return { element: chosen, ...chosenSpan };

	return descend(chosen, carried, distanceOf, strict) ?? fallback;
}

/**
 * The narrowest visible element whose source range contains `line`, or `null`
 * when the line falls outside every rendered block (a stale anchor, or a blank
 * line between blocks) and the caller should fall back to a proportional
 * restore.
 */
export function findAnchorElement(root: AnchorNode, line: number): AnchorMatch | null {
	if (!Number.isFinite(line) || line <= 0) return null;
	return descend(root, null, (span) => lineDistance(span, line), true);
}

/**
 * As `findAnchorElement`, but a line no block owns resolves to the nearest
 * block instead of to nothing. Only the scroll-sync mapping wants this: the
 * blank lines between blocks are a third of a typical document, and falling
 * back to the proportional mapping on every one of them would make the paired
 * pane jump back and forth as the reader scrolled.
 */
function findNearestAnchorElement(root: AnchorNode, line: number): AnchorMatch | null {
	if (!Number.isFinite(line) || line <= 0) return null;
	return descend(root, null, (span) => lineDistance(span, line), false);
}

/**
 * The narrowest annotated element whose box covers `offset`, or the nearest one
 * when the offset falls in the margin between two blocks or in the padding
 * below the last one.
 *
 * `measure` supplies the layout — `offsetTop` / `offsetHeight` in the browser.
 * It is a parameter because this module is otherwise pure enough to run against
 * the render-protocol DOM shim, and that shim has no layout at all; injecting
 * one is what lets the mapping be tested over real pipeline output.
 */
function findAnchorElementAtOffset(
	root: AnchorNode,
	offset: number,
	measure: MeasureAnchorBox,
): AnchorMatch | null {
	if (!Number.isFinite(offset)) return null;
	return descend(root, null, (_span, node) => boxDistance(measure(node), offset), false);
}

/**
 * Where to scroll so `line` sits `offset` pixels below the top of the viewport,
 * interpolating linearly across the resolved element for multi-line blocks.
 *
 * `elementTop` is the element's top in the scroll container's own space —
 * `measureAnchorBox` above, which is also what `getPreviewScrollAnchor`
 * measures on the way in. Both sides measure the same element the same way, so
 * the round trip is exact.
 */
export function getAnchorScrollTop(
	elementTop: number,
	elementHeight: number,
	range: LineRange,
	line: number,
	offset: number = PREVIEW_ANCHOR_OFFSET,
): number {
	const totalLines = range.endLine - range.startLine;
	const ratio = totalLines > 0 ? Math.max(0, Math.min(1, (line - range.startLine) / totalLines)) : 0;

	return Math.max(0, elementTop + elementHeight * ratio - offset);
}

/* ------------------------------------------------------------------ */
/* the sample table                                                    */
/* ------------------------------------------------------------------ */
//
// Scroll sync maps a pixel to a source line and back. It used to do that by
// descending to the single narrowest annotated element containing the offset
// and interpolating across ITS range — which has two problems that only show
// up together.
//
// The first is that it measures every child at every level on the way down, so
// the cost is linear in the size of the document on an event that fires many
// times a second. The second is worse: adding more annotated elements makes it
// LESS accurate, because a finer element is a narrower range, and an element
// spanning a single line cannot interpolate at all — the answer quantises to
// whole lines. Any attempt to improve the mapping by giving it more to work
// with made it step instead of glide.
//
// So the model is the one VS Code's Markdown preview uses
// (`extensions/markdown-language-features/preview-src/scroll-sync.ts`): a flat,
// ordered table of (element, line) samples, a binary search for the pair the
// offset falls between, and interpolation BETWEEN the two —
//
//     progress = (offset - previous.top) / (next.top - previous.top)
//     line     = previous.line + progress * (next.line - previous.line)
//
// In that shape an extra sample is always an improvement: it splits an
// interval, and interpolating across a shorter interval is never worse. It
// also measures O(log n) elements instead of O(n).

type LineSample = { element: AnchorNode; line: number };

/**
 * Every annotated element in document order, one sample each, deduplicated so
 * that a line is represented by the innermost element that starts on it.
 *
 * A `<ul>` and its first `<li>` start on the same source line, as do a
 * `<blockquote>` and its first paragraph. Keeping both would put two samples
 * at one line and give the interval between them zero span. The inner one is
 * kept because it is the one whose box actually bounds the text.
 *
 * Not memoised: this walks the tree without measuring anything, and the
 * measuring is what costs. Caching it would mean invalidating on every render,
 * and a stale table would silently map to the wrong lines.
 */
function collectLineSamples(root: AnchorNode): LineSample[] {
	const samples: LineSample[] = [];

	const visit = (node: AnchorNode) => {
		for (const child of elementChildren(node)) {
			// A collapsed fold is `height: 0; overflow: hidden`, and its
			// children keep reporting the offsets they would have if it were
			// open. Following them in would put samples below the fold at
			// positions above it — which does not merely misplace those
			// samples, it breaks the ordering the binary search depends on for
			// everything after them. The fold answers for its own contents, at
			// the one place the reader can actually see them.
			//
			// This is the same guard VS Code applies with `isVisible`, done by
			// class so that building the table still costs no measurement.
			if (isCollapsedContainer(child)) {
				const span = ownRange(child) ?? resolveSpan(child);
				if (span) samples.push({ element: child, line: span.startLine });
				continue;
			}

			const own = ownRange(child);
			if (!own) {
				visit(child);
				continue;
			}

			const before = samples.length;
			visit(child);
			// Only if no descendant already claimed this line.
			if (samples[before]?.line !== own.startLine) {
				samples.splice(before, 0, { element: child, line: own.startLine });
			}
		}
	};

	visit(root);
	return samples;
}

/**
 * The samples either side of `offset`: the last one at or above it, and the
 * first one below.
 *
 * Binary search over `top`, which is monotonic in document order for the
 * elements that survive the deduplication above — they are siblings or
 * ancestors laid out in flow, so a later element never starts higher.
 */
function samplesAround(
	samples: LineSample[],
	offset: number,
	measure: MeasureAnchorBox,
): { previous: LineSample; next?: LineSample } {
	let low = 0;
	let high = samples.length - 1;

	while (low < high) {
		const mid = Math.ceil((low + high) / 2);
		if (measure(samples[mid].element).top <= offset) low = mid;
		else high = mid - 1;
	}

	const previous = samples[low];
	const next = samples[low + 1];
	return next ? { previous, next } : { previous };
}

/**
 * The source line rendered at `offset` in the preview's scroll content —
 * fractional, interpolated across the block that owns the offset.
 *
 * This is the half of split-view scroll sync that a ratio cannot do. Forty
 * source lines of table render as a tall block and forty of prose as a short
 * one, so the share of the preview's scroll range a position occupies is not
 * the share of the document it corresponds to. Asking which block is on screen
 * and where inside it does not care.
 *
 * `null` only when the preview holds no annotated block at all.
 */
export function getSourceLineAtPreviewOffset(
	root: AnchorNode,
	offset: number,
	measure: MeasureAnchorBox,
): RendererLine | null {
	if (!Number.isFinite(offset)) return null;

	const samples = collectLineSamples(root);
	if (samples.length === 0) return null;

	const { previous, next } = samplesAround(samples, offset, measure);
	const previousTop = measure(previous.element).top;
	if (!Number.isFinite(previousTop)) return null;

	if (next) {
		const nextTop = measure(next.element).top;
		const span = nextTop - previousTop;
		if (!Number.isFinite(span) || span <= 0) return rendererLine(previous.line);

		const progress = Math.max(0, Math.min(1, (offset - previousTop) / span));
		return rendererLine(previous.line + progress * (next.line - previous.line));
	}

	// Past the last sample: its own height is all there is to go on, and a
	// height of one rendered line is worth one source line.
	const height = measure(previous.element).height;
	if (!Number.isFinite(height) || height <= 0) return rendererLine(previous.line);
	return rendererLine(previous.line + Math.max(0, (offset - previousTop) / height));
}

/**
 * The inverse: where in the preview's scroll content `line` is rendered.
 * Interpolates through `getAnchorScrollTop` — the same interpolation the tab
 * restore uses — with no viewport offset applied, so the caller decides where
 * on screen to put it.
 *
 * `null` only when the preview holds no annotated block at all.
 */
export function getPreviewOffsetForSourceLine(
	root: AnchorNode,
	line: RendererLine,
	measure: MeasureAnchorBox,
): number | null {
	if (!Number.isFinite(line)) return null;

	const samples = collectLineSamples(root);
	if (samples.length === 0) return null;

	// The mirror of `samplesAround`, over lines rather than pixels. Both
	// directions read the same table, so a round trip through the pair lands
	// where it started.
	let low = 0;
	let high = samples.length - 1;
	while (low < high) {
		const mid = Math.ceil((low + high) / 2);
		if (samples[mid].line <= line) low = mid;
		else high = mid - 1;
	}

	const previous = samples[low];
	const next = samples[low + 1];
	const previousTop = measure(previous.element).top;
	if (!Number.isFinite(previousTop)) return null;

	if (next) {
		const lineSpan = next.line - previous.line;
		if (lineSpan <= 0) return Math.max(0, previousTop);

		const nextTop = measure(next.element).top;
		if (!Number.isFinite(nextTop)) return Math.max(0, previousTop);

		const progress = Math.max(0, Math.min(1, (line - previous.line) / lineSpan));
		return Math.max(0, previousTop + progress * (nextTop - previousTop));
	}

	// Past the last sample, as in the forward direction: one source line is
	// worth one rendered line of the element's own height.
	const height = measure(previous.element).height;
	if (!Number.isFinite(height) || height <= 0) return Math.max(0, previousTop);
	return Math.max(0, previousTop + (line - previous.line) * height);
}
