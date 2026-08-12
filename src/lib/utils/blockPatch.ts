import { invalidateAnchorMemos } from './previewAnchor.js';
import { carrySourcepos } from './richContent.js';

/**
 * Putting the newly rendered document into the preview by replacing only the
 * blocks that changed.
 *
 * The preview used to be `{@html sanitizedHtml}`: every keystroke destroyed the
 * whole article and built a new one. Three rounds of fixes attacked the cost of
 * rebuilding it — memoising KaTeX and highlight.js (#614), debouncing the
 * pipeline against a pause rather than a frame (#614), measuring folds from
 * layout height rather than scrollable extent (#617) — and the report never went
 * away, because the remaining defect is not cost. `scrollTop` was measured
 * unchanged at Δ0.0 while the text still moved: a rebuilt tree is not required
 * to lay out to the same pixels as the one it replaced. Inline maths (KaTeX's
 * auto-renderer, which has no memo), font metrics, a re-attached
 * ResizeObserver, an image whose intrinsic size is not known again until it
 * decodes — any one of them is a frame of difference, and there is no end to
 * that list. The only stable tree is the one that is not rebuilt.
 *
 * So this module keeps the nodes whose rendering did not change and swaps the
 * ones that did, which is what VS Code and Obsidian do for the same reason.
 *
 * Measured in Chromium over the real pipeline (comrak → `processMarkdownHtml` →
 * `sanitizeMarkdownHtml` → here), typing one character in the middle of a
 * paragraph, against the same edit applied by rebuilding the article:
 *
 *     samples/markdown-syntax.md   1000 -> 2 elements re-created (of 1733)
 *     samples/katex-stress.md       230 -> 1                     (of 4641)
 *     samples/stress-test.md       6985 -> 1                     (of 7819)
 *
 * and the whole apply — patch plus highlighting, typesetting and diagrams over
 * what it changed — 23.8 -> 5.9ms, 27.7 -> 5.3ms and 51.1 -> 17.5ms
 * respectively. What the reader is looking at is the node they were looking at
 * before, not a copy of it: a fixed reference block sampled at frames 0, 1, 2, 5
 * and 11 after the edit is at +0.000px in every case.
 *
 * Renaming a heading is the one edit that does not collapse to a block or two:
 * comrak deduplicates heading ids (`objectives-24`, `objectives-25`, …), so
 * renaming one renumbers every later duplicate and those blocks really are
 * different markup. On stress-test.md that is 71 blocks instead of 1 — still a
 * third of the document rather than all of it, and the id is in the markup, so
 * no key can call them unchanged without lying.
 *
 * ## The key is the markup, not the source position
 *
 * comrak stamps every block with `data-sourcepos`, and it is tempting to diff
 * on that. It is exactly wrong: inserting one line renumbers every block below
 * the cursor, so a source-position key says "everything after the caret is
 * new" — the whole document, on every keystroke, which is the thing being
 * fixed. The key here is the block's own markup with every source range removed,
 * so a paragraph that merely moved down two lines is recognised as the same
 * paragraph. It is not hashed: the string *is* the key, which costs one map
 * comparison per block and cannot collide.
 *
 * `data-sourcepos` still has to be *right* on a kept node — `lineCoordinates.ts`
 * and `previewAnchor.ts` resolve every scroll-sync and anchor-restore question
 * through it, and split-view scroll sync is running while the user types. So the
 * ranges are refreshed onto kept nodes from the new tree (`refreshSourcepos`).
 * That is an attribute write no CSS rule reads: no style invalidation, no
 * layout, no paint — the class of work this module exists to preserve.
 *
 * It is not, however, a write nothing reads. `previewAnchor.ts` memoises the
 * range it parses off a node and the span it derives from a node's subtree, and
 * both memos were built on the guarantee this module removes: that a node whose
 * source lines changed is a *new* node, so a stale entry is unreachable. Keeping
 * the node keeps the entry, and the memo goes on answering with the lines the
 * block was on before the edit, for as long as the node lives. So the patch owes
 * `invalidateAnchorMemos` a call — the whole of it, not per node, for the reason
 * spelled out where those memos are declared.
 *
 * ## Keys are remembered, never read back off the live tree
 *
 * `renderRichContent` rewrites what it touches: a `<pre>` gains a
 * `.code-block-shell` parent and a copy button, a Mermaid `<pre>` becomes a
 * `<div class="mermaid-diagram">`, a formula's `innerHTML` becomes KaTeX's. The
 * live markup therefore has nothing to do with the markup that produced it, and
 * a diff that re-serialised the live tree would find every enriched block
 * "changed" forever. `renderedKeys` holds the keys of what this module last
 * *inserted*, per container, positionally. Every one of those rewrites is
 * one-node-for-one-node, so the positions still line up.
 *
 * A container whose live child count no longer matches its remembered keys is
 * one somebody else rewrote; it gets replaced wholesale rather than guessed at.
 *
 * ## Why this descends
 *
 * "Top-level block" is not a useful unit in this pipeline. `processMarkdownHtml`
 * re-parents everything under a heading into a `.foldable-content-wrapper`, so a
 * document that opens with `# Title` has exactly two top-level children and the
 * second one is the rest of the file. The diff therefore recurses into the
 * containers Markpad builds itself (`DESCENDABLE`) — and only those. Their
 * children are always whole blocks, which is what makes it safe to compare them
 * as a list and to drop the inter-block whitespace. Descending into arbitrary
 * elements is not: a `<p>` whose element children are unchanged can still have
 * different text between them, and an element-wise diff would keep the old
 * words.
 */

/**
 * Source ranges, removed before a block is keyed. The values comrak writes are
 * `line:col-line:col`, so there is no quote to escape and no need to parse.
 */
const SOURCEPOS_ATTRIBUTE = /\s+data-sourcepos="[^"]*"/g;

/**
 * The containers this diff may look inside instead of replacing.
 *
 * Every one is built by `processMarkdownHtml` out of `appendChild` calls on
 * whole blocks, which is the property that makes a positional child diff sound.
 */
const DESCENDABLE =
	'.foldable-content-wrapper, .content-inner, .markdown-alert, .markdown-alert-content';

/** What this module last put into each container, in order. */
const renderedKeys = new WeakMap<Element, string[]>();

export interface BlockPatch {
	/**
	 * The elements that were newly inserted — everything, and only what,
	 * `renderRichContent` has to visit. Never nested inside one another.
	 */
	inserted: HTMLElement[];
	/** Elements inserted, at every depth the diff reached. Diagnostics. */
	replaced: number;
	/** Elements left in place, at every depth the diff reached. Diagnostics. */
	kept: number;
}

function blockKey(element: Element): string {
	return element.outerHTML.replace(SOURCEPOS_ATTRIBUTE, '');
}

function childKeys(container: ParentNode): string[] {
	return Array.from(container.children).map(blockKey);
}

/**
 * Bring the preview's blocks up to date with `sanitizedHtml`, replacing as few
 * of them as possible.
 *
 * The string is parsed into a `<template>`, whose content lives in an inert
 * document: the blocks that turn out to be unchanged are discarded without ever
 * having loaded an image or run anything. Nothing is cut out of the string and
 * nothing is filtered a second time — the caller sanitizes the whole document,
 * exactly as it did when this was `{@html}`, and what is parsed here is that
 * one string.
 */
export function patchPreviewBlocks(host: HTMLElement, sanitizedHtml: string): BlockPatch {
	const template = host.ownerDocument.createElement('template');
	template.innerHTML = sanitizedHtml;

	// Before the tree moves, not after: a patch that throws half-way through has
	// still changed some of it, and an empty memo is only ever a slow answer
	// where a stale one is a wrong one.
	invalidateAnchorMemos();

	const patch: BlockPatch = { inserted: [], replaced: 0, kept: 0 };
	patchContainer(host, template.content, patch);
	return patch;
}

function patchContainer(live: HTMLElement, next: ParentNode, patch: BlockPatch): void {
	const nextElements = Array.from(next.children) as HTMLElement[];
	const newKeys = childKeys(next);
	const liveElements = Array.from(live.children) as HTMLElement[];
	const oldKeys = renderedKeys.get(live);

	renderedKeys.set(live, newKeys);

	// First render into this container, or one whose children somebody else
	// changed. Only elements are carried over: the whitespace between blocks is
	// comrak's line breaks, invisible between block boxes, and keeping it out
	// means `children` and `childNodes` stay the same list forever.
	if (!oldKeys || oldKeys.length !== liveElements.length) {
		live.replaceChildren(...nextElements);
		for (const element of nextElements) rememberSubtree(element);
		patch.inserted.push(...nextElements);
		patch.replaced += nextElements.length;
		return;
	}

	// Common prefix and suffix rather than a full edit-distance: the edit this
	// exists for is a keystroke, which produces one changed block with an
	// unchanged run on either side of it. A block that *moved* (cut here, pasted
	// far away) falls outside the run and is replaced, which is correct and only
	// costs the incrementality nobody is typing to get.
	const shortest = Math.min(oldKeys.length, newKeys.length);
	let head = 0;
	while (head < shortest && oldKeys[head] === newKeys[head]) head += 1;
	let tail = 0;
	while (
		tail < shortest - head &&
		oldKeys[oldKeys.length - 1 - tail] === newKeys[newKeys.length - 1 - tail]
	) {
		tail += 1;
	}
	patch.kept += head + tail;

	let oldFrom = head;
	let oldTo = oldKeys.length - tail;
	let newFrom = head;
	let newTo = newKeys.length - tail;

	// The changed run is usually a single container holding the edit. Descending
	// from both ends rather than only the front is what keeps typing inside a
	// heading from being a whole-document replacement: the `<h1>` really did
	// change and gets swapped, and the wrapper carrying the rest of the file is
	// reached from the other side and looked inside.
	while (oldFrom < oldTo && newFrom < newTo && canDescend(liveElements[oldFrom], nextElements[newFrom])) {
		descend(liveElements[oldFrom], nextElements[newFrom], patch);
		oldFrom += 1;
		newFrom += 1;
	}
	while (oldTo > oldFrom && newTo > newFrom && canDescend(liveElements[oldTo - 1], nextElements[newTo - 1])) {
		descend(liveElements[oldTo - 1], nextElements[newTo - 1], patch);
		oldTo -= 1;
		newTo -= 1;
	}

	// Read before anything is removed: still a live node, and still in place
	// afterwards, because everything removed sits before it.
	const before = liveElements[oldTo] ?? null;
	for (let index = oldFrom; index < oldTo; index += 1) liveElements[index].remove();

	const incoming = nextElements.slice(newFrom, newTo);
	if (incoming.length > 0) {
		const fragment = live.ownerDocument.createDocumentFragment();
		for (const element of incoming) fragment.appendChild(element);
		live.insertBefore(fragment, before);
		for (const element of incoming) rememberSubtree(element);
		patch.inserted.push(...incoming);
		patch.replaced += incoming.length;
	}

	// Kept blocks moved in the source even when they did not move on screen, and
	// a nested container's whole child list shifts when a line is added above the
	// heading that owns it — so the prefix needs this as much as the suffix does.
	for (let index = 0; index < head; index += 1) {
		refreshSourcepos(liveElements[index], nextElements[index]);
	}
	for (let index = 1; index <= tail; index += 1) {
		refreshSourcepos(liveElements[liveElements.length - index], nextElements[nextElements.length - index]);
	}
}

function descend(live: HTMLElement, next: HTMLElement, patch: BlockPatch): void {
	// The container is kept, so it keeps its own source range too — a callout is
	// annotated, and scroll sync reads the outermost annotation it can find.
	carrySourcepos(next, live);
	patchContainer(live, next, patch);
}

function canDescend(live: Element, next: Element): boolean {
	return (
		live.tagName === next.tagName &&
		// A fold that was toggled has `is-collapsed` on one side and not the
		// other; that is a replacement, not a container to look inside.
		live.className === next.className &&
		next.childElementCount > 0 &&
		next.matches(DESCENDABLE)
	);
}

/**
 * Record the keys of every descendable container inside a freshly inserted
 * block, so the *next* diff can look inside it instead of replacing it.
 *
 * Must run before `renderRichContent` touches these nodes, which is why the
 * patch and the enrichment are ordered rather than independent.
 */
function rememberSubtree(element: Element): void {
	if (element.matches(DESCENDABLE)) renderedKeys.set(element, childKeys(element));
	for (const container of element.querySelectorAll(DESCENDABLE)) {
		renderedKeys.set(container, childKeys(container));
	}
}

function annotatedNodes(element: Element): Element[] {
	const nodes = element.hasAttribute('data-sourcepos') ? [element] : [];
	nodes.push(...element.querySelectorAll('[data-sourcepos]'));
	return nodes;
}

/**
 * Copy the new source ranges onto a block that is being kept.
 *
 * The two subtrees are the same markup apart from the ranges the key strips, so
 * their annotated elements line up one for one — including after enrichment,
 * because every node `renderRichContent` replaces it replaces singly and
 * `carrySourcepos` moves the range across. A length mismatch means that
 * assumption does not hold for this block; leaving it untouched is the safe
 * answer, and it costs a stale range rather than a wrong one somewhere else.
 */
function refreshSourcepos(live: Element, next: Element): void {
	const liveNodes = annotatedNodes(live);
	const nextNodes = annotatedNodes(next);
	if (liveNodes.length !== nextNodes.length) return;

	for (let index = 0; index < liveNodes.length; index += 1) {
		const range = nextNodes[index].getAttribute('data-sourcepos');
		if (range !== null && liveNodes[index].getAttribute('data-sourcepos') !== range) {
			liveNodes[index].setAttribute('data-sourcepos', range);
		}
	}
}
