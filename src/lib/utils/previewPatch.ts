import { untrack } from 'svelte';

import { applyFolds, processBlockMarkup, wrapHeadings, type FoldIds } from './markdown.js';
import { invalidateAnchorMemos } from './previewAnchor.js';
import { replacedBy } from './richContent.js';
import { sanitizeMarkdownFragment } from './sanitize.js';

/**
 * Bringing the preview up to date block by block, from the renderer's HTML.
 *
 * After every typing pause the preview used to take the whole document
 * through `processMarkdownHtml` (DOMParser plus a dozen passes), DOMPurify,
 * and a diff that serialised every block to compare it. All three scale with
 * the document, not the edit: about 0.8s per pause at 1MB and 4.5s at 5MB,
 * on the main thread, to change one paragraph.
 *
 * `render_markdown` with `splitBlocks` writes `\0` between top-level blocks
 * (`BLOCK_SEPARATOR` in markdown.rs). comrak still parses the whole document,
 * so footnote numbers, reference links and heading-id dedupe are already in
 * each block's markup, and a block whose markup did not change needs nothing
 * done to it. Only the blocks that did change are processed, sanitized and
 * inserted. StackEdit's preview has the same shape.
 *
 * ## The key is the markup, not the source position
 *
 * Inserting a line renumbers every `data-sourcepos` below it, so a key that
 * included them would call the rest of the document new. The key is the
 * block's markup with its ranges removed; a kept block whose ranges moved gets
 * the new ones written onto it (`moveSourcepos`), because scroll sync, anchor
 * restore and the task checkboxes all read them.
 *
 * ## Keys are remembered, never read back off the live tree
 *
 * `renderRichContent` rewrites what it touches (a code block's shell, a
 * Mermaid diagram in place of its `<pre>`), so the live markup has nothing to
 * do with the renderer's. The record is of the renderer's markup and of the
 * elements each block was inserted as; `replacedBy` leads from an element
 * enrichment replaced to what stands there now.
 *
 * ## What is document-wide on this side
 *
 * The heading wrappers and the fold keys. Both are made on the live tree with
 * DOM calls only — nothing here parses markup after `sanitizeMarkdownFragment`
 * has seen it. A block is inserted after the one before it, or at the top of
 * that heading's wrapper; only an edit that adds, removes or re-levels a
 * top-level heading changes which wrapper a block belongs to, and that one
 * regroups the sections it touched (`regroupSections`).
 */

const SEPARATOR = '\0';
const SOURCEPOS_ATTRIBUTE = /\s+data-sourcepos="[^"]*"/g;
const FIRST_LINE = /data-sourcepos="(\d+):/;
const FOLD_HEADS = '.foldable-header, .callout-foldable';

interface PreviewState {
	/** The renderer's markup of each block, as last applied. */
	raws: string[];
	/** The same without source ranges: a block that only moved keeps its key. */
	keys: string[];
	/** What each block put into the preview: none, one, or a few elements. */
	els: Element[][];
	ids: FoldIds;
	/**
	 * `host.childElementCount` after the patch. Anything else next time means
	 * somebody else rewrote the article, and it is rebuilt rather than diffed
	 * against a stale record.
	 */
	topCount: number;
}

const states = new WeakMap<HTMLElement, PreviewState>();

export interface PreviewPatch {
	/** New blocks, for `renderRichContent`. Never nested inside one another. */
	inserted: HTMLElement[];
	/** New heading wrappers, for the fold layout observer only. */
	wrappers: HTMLElement[];
	replaced: number;
	kept: number;
}

let scratch: Document | null = null;

/** Processes and sanitizes `markup` in one pass, answering with the filter's own nodes. */
function processAndSanitize(markup: string, filePath: string): DocumentFragment {
	// An inert document: nothing in it runs or loads.
	scratch ??= document.implementation.createHTMLDocument('');
	const box = scratch.createElement('div');
	box.innerHTML = markup;
	processBlockMarkup(box, filePath);
	return sanitizeMarkdownFragment(box.innerHTML);
}

/** Headings inside a block (a callout, a list item) fold among their own siblings. */
function wrapNestedHeadings(block: ParentNode, ids: FoldIds): void {
	wrapHeadings(
		Array.from(block.querySelectorAll('.foldable-header')).filter((h) => h.parentNode !== block),
		ids,
	);
}

const BLOCK_MARK = 'data-preview-block';

/**
 * The elements each of `raws` becomes, in one parse and one DOMPurify pass
 * however many blocks there are: a call per block costs a document of
 * DOMPurify's own each time, which made a first render of 50,000 blocks a
 * second slower than the whole-document pipeline.
 *
 * Each block goes in inside a `<section>` carrying a nonce, and comes back
 * out of it. Markup that closed one early or forged one cannot know the
 * nonce, so the count or a nonce is wrong and the blocks are done one at a
 * time instead.
 */
function renderBlocks(raws: string[], filePath: string, ids: FoldIds): HTMLElement[][] {
	if (raws.length === 0) return [];
	const nonce = Math.random().toString(36).slice(2);
	const clean = processAndSanitize(
		raws.map((raw) => `<section ${BLOCK_MARK}="${nonce}">${raw}</section>`).join(''),
		filePath,
	);
	const marks = Array.from(clean.children);
	const intact =
		marks.length === raws.length &&
		marks.every((mark) => mark.tagName === 'SECTION' && mark.getAttribute(BLOCK_MARK) === nonce);
	if (!intact) {
		if (raws.length > 1) return raws.map((raw) => renderBlocks([raw], filePath, ids)[0]);
		const lone = processAndSanitize(raws[0], filePath);
		wrapNestedHeadings(lone, ids);
		return [Array.from(lone.children) as HTMLElement[]];
	}
	// One query for the whole batch, not one per block.
	wrapHeadings(
		Array.from(clean.querySelectorAll('.foldable-header')).filter((h) => h.parentNode?.parentNode !== clean),
		ids,
	);
	return marks.map((mark) => Array.from(mark.children) as HTMLElement[]);
}

function live(element: Element): Element {
	for (let next = replacedBy.get(element); next; next = replacedBy.get(element)) element = next;
	return element;
}

function isTopHeading(element: Element): boolean {
	return /^H[1-6]$/.test(element.tagName) && element.classList.contains('foldable-header');
}

function firstLine(raw: string): number {
	const match = FIRST_LINE.exec(raw);
	return match ? Number(match[1]) : 0;
}

const SOURCEPOS_VALUE = /data-sourcepos="([^"]*)"/g;

/**
 * A kept block whose markup differs only in its source ranges: the text above
 * it gained or lost lines. Each range the renderer wrote is replaced by its
 * counterpart in the new markup (same markup, so same order); the ones this
 * side derived (`source-line-anchor`) move by the block's own shift.
 */
function moveSourcepos(elements: Element[], before: string, after: string): void {
	const from = Array.from(before.matchAll(SOURCEPOS_VALUE), (m) => m[1]);
	const to = Array.from(after.matchAll(SOURCEPOS_VALUE), (m) => m[1]);
	const moved = new Map(from.map((range, index) => [range, to[index]]));
	const delta = firstLine(after) - firstLine(before);
	const shift = (range: string) =>
		range.replace(/^(\d+)(:\d+-)(\d+)/, (_, a, mid, b) => `${Number(a) + delta}${mid}${Number(b) + delta}`);
	for (const element of elements) {
		const nodes = element.hasAttribute('data-sourcepos') ? [element] : [];
		nodes.push(...element.querySelectorAll('[data-sourcepos]'));
		for (const node of nodes) {
			const range = node.getAttribute('data-sourcepos')!;
			const next = moved.get(range) ?? shift(range);
			if (next !== range) node.setAttribute('data-sourcepos', next);
		}
	}
}

export function patchPreview(
	host: HTMLElement,
	html: string,
	filePath: string,
	foldOverrides: Set<string>,
): PreviewPatch {
	invalidateAnchorMemos();
	const raws = html.split(SEPARATOR);
	const keys = raws.map((raw) => raw.replace(SOURCEPOS_ATTRIBUTE, ''));
	const patch: PreviewPatch = { inserted: [], wrappers: [], replaced: 0, kept: 0 };
	const recorded = states.get(host);
	const old = recorded?.topCount === host.childElementCount ? recorded : undefined;

	if (!old) {
		const ids: FoldIds = { next: 0 };
		const els = renderBlocks(raws, filePath, ids);
		const flat = els.flat() as HTMLElement[];
		host.replaceChildren(...flat);
		patch.wrappers = wrapHeadings(flat.filter(isTopHeading), ids);
		applyFolds(host, foldOverrides);
		states.set(host, { raws, keys, els, ids, topCount: host.childElementCount });
		patch.inserted = flat;
		patch.replaced = flat.length;
		return patch;
	}

	const oldLength = old.keys.length;
	const shortest = Math.min(oldLength, keys.length);
	let head = 0;
	while (head < shortest && old.keys[head] === keys[head]) head += 1;
	let tail = 0;
	while (tail < shortest - head && old.keys[oldLength - 1 - tail] === keys[keys.length - 1 - tail]) tail += 1;

	const els: Element[][] = new Array(raws.length);
	const keep = (index: number, oldIndex: number) => {
		els[index] = old.els[oldIndex].map(live);
		patch.kept += 1;
		if (old.raws[oldIndex] !== raws[index]) moveSourcepos(els[index], old.raws[oldIndex], raws[index]);
	};
	for (let index = 0; index < head; index += 1) keep(index, index);
	for (let back = 1; back <= tail; back += 1) keep(raws.length - back, oldLength - back);

	// The changed run. Same length on both sides means the blocks correspond
	// pair for pair (a renamed heading renumbering later duplicates), so only
	// the pairs that really differ are rendered.
	const oldTo = oldLength - tail;
	const newTo = raws.length - tail;
	const pairwise = oldTo - head === newTo - head;
	const removed: Element[] = [];
	const render: number[] = [];
	for (let index = head; index < newTo; index += 1) {
		if (pairwise && old.keys[index] === keys[index]) keep(index, index);
		else render.push(index);
	}
	for (let index = head; index < oldTo; index += 1) {
		if (!(pairwise && old.keys[index] === keys[index])) removed.push(...old.els[index].map(live));
	}
	renderBlocks(
		render.map((index) => raws[index]),
		filePath,
		old.ids,
	).forEach((elements, at) => (els[render[at]] = elements));
	const added = render.flatMap((index) => els[index]) as HTMLElement[];

	// A renamed heading of the same level keeps its wrapper. Any other change
	// to the top-level headings changes which blocks belong to which heading.
	const regroup =
		removed.some(isTopHeading) || added.some(isTopHeading)
			? !(
					pairwise &&
					render.every((index) => {
						const before = old.els[index].map(live);
						const after = els[index];
						return before.length === 1 && after.length === 1
							? isTopHeading(before[0]) === isTopHeading(after[0]) && before[0].tagName === after[0].tagName
							: !before.some(isTopHeading) && !after.some(isTopHeading);
					})
				)
			: false;
	const touchesFolds =
		removed.some((e) => e.matches(FOLD_HEADS) || e.querySelector(FOLD_HEADS)) ||
		added.some((e) => e.matches(FOLD_HEADS) || e.querySelector(FOLD_HEADS));

	if (regroup) {
		patch.wrappers = regroupSections(host, els, head, newTo, removed, added, old.ids);
		applyFolds(host, foldOverrides, true);
		// A kept heading keeps its state, which its new wrapper takes on.
		for (const wrapper of patch.wrappers) {
			wrapper.classList.toggle('is-collapsed', wrapper.previousElementSibling!.classList.contains('is-collapsed'));
		}
	} else {
		for (const index of render) {
			const before = pairwise ? old.els[index].map(live) : [];
			const after = els[index] as HTMLElement[];
			if (pairwise && before.length === 1 && after.length === 1 && isTopHeading(before[0])) {
				after[0].setAttribute('data-fold-target', before[0].getAttribute('data-fold-target') ?? '');
				before[0].replaceWith(after[0]);
				continue;
			}
			for (const element of before) element.remove();
			if (after.length > 0) insertBlock(host, els, index, after);
		}
		for (const element of removed) element.remove();
		if (touchesFolds) applyFolds(host, foldOverrides, true);
	}

	states.set(host, { raws, keys, els, ids: old.ids, topCount: host.childElementCount });
	patch.inserted = added;
	patch.replaced = added.length;
	return patch;
}

const levelOf = (heading: Element) => Number(heading.tagName[1]);
const topHeadingOf = (elements: Element[] | undefined) => elements?.find(isTopHeading);

/**
 * Re-wraps the part of the document whose sections an edit to its top-level
 * headings changed, and nothing else. With `L` the highest level the edit
 * added or removed, that part runs from the nearest heading of level `L` or
 * higher before the edit to the next one after it: a section of a higher
 * level contains it unchanged, and one of the same level ends where it did.
 * The blocks are moved, not rebuilt. Returns the new wrappers.
 */
function regroupSections(
	host: HTMLElement,
	els: Element[][],
	from: number,
	to: number,
	removed: Element[],
	added: Element[],
	ids: FoldIds,
): HTMLElement[] {
	const level = Math.min(...[...removed, ...added].filter(isTopHeading).map(levelOf));
	const wrapperOf = (heading: Element) => {
		const next = heading.nextElementSibling;
		return next?.classList.contains('foldable-content-wrapper') ? next : null;
	};

	// Where the regrouped run goes: a placeholder, set before anything moves.
	const marker = host.ownerDocument.createComment('');
	let start = 0;
	for (let index = from - 1; index >= 0; index -= 1) {
		const heading = topHeadingOf(els[index]);
		if (!heading || levelOf(heading) > level) continue;
		if (levelOf(heading) === level) {
			start = index;
			heading.before(marker);
		} else {
			start = index + 1;
			const inner = Array.from(wrapperOf(heading)?.children ?? []).find((child) =>
				child.classList.contains('content-inner'),
			);
			(inner ?? host).prepend(marker);
		}
		break;
	}
	if (!marker.parentNode) host.prepend(marker);
	let end = els.length;
	for (let index = to; index < els.length; index += 1) {
		const heading = topHeadingOf(els[index]);
		if (heading && levelOf(heading) <= level) {
			end = index;
			break;
		}
	}

	const stale: Element[] = [];
	for (const element of removed) if (isTopHeading(element)) stale.push(...[wrapperOf(element)].filter((w) => w !== null));
	const run = els.slice(start, end).flat() as HTMLElement[];
	for (const element of run) if (isTopHeading(element)) stale.push(...[wrapperOf(element)].filter((w) => w !== null));
	for (const element of removed) element.remove();
	marker.replaceWith(...run);
	for (const wrapper of stale) wrapper.remove();
	return wrapHeadings(run.filter(isTopHeading), ids);
}

/** Puts `nodes` where block `index` belongs: after the previous block's last element. */
function insertBlock(host: HTMLElement, els: Element[][], index: number, nodes: HTMLElement[]) {
	for (let before = index - 1; before >= 0; before -= 1) {
		const previous = els[before];
		if (!previous || previous.length === 0) continue;
		const last = previous[previous.length - 1];
		if (isTopHeading(last)) {
			last.nextElementSibling!.querySelector(':scope > .content-inner')!.prepend(...nodes);
		} else {
			last.after(...nodes);
		}
		return;
	}
	host.prepend(...nodes);
}

const patchedHtml = new WeakMap<HTMLElement, string>();

/**
 * `patchPreview` for the viewer's hosts, once per document.
 *
 * A host that already holds `html` — a tab being re-activated — is not
 * sanitized and diffed again: every block would compare equal. The switch did
 * change which host is displayed, which the anchor memos read, and the patch is
 * what would have invalidated them.
 *
 * Only the new blocks go to `observe`. `ResizeObserver.observe` on a target it
 * is already watching re-registers it rather than doing nothing, and a fresh
 * registration delivers an initial observation — so handing it the whole host
 * would put back the per-keystroke re-measure of every fold that keeping the
 * observation alive removed.
 *
 * The patch runs untracked, `readTab` included: a fold toggle or a rename is
 * not a new document, so nothing it reads may re-run the caller's effect.
 */
export function patchHost(
	host: HTMLElement,
	html: string,
	readTab: () => { filePath: string; foldOverrides: Set<string> },
	observe: (scope: Element) => void,
): Pick<PreviewPatch, 'inserted' | 'wrappers'> {
	const unchanged = patchedHtml.get(host) === html;
	patchedHtml.set(host, html);
	if (unchanged) invalidateAnchorMemos();
	const patch = unchanged
		? { inserted: [], wrappers: [] }
		: untrack(() => {
				const { filePath, foldOverrides } = readTab();
				return patchPreview(host, html, filePath, foldOverrides);
			});
	for (const block of patch.inserted) observe(block);
	for (const wrapper of patch.wrappers) observe(wrapper);
	return patch;
}
