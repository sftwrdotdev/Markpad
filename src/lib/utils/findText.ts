/**
 * Find in the preview, matched against the text as it is drawn (#982).
 *
 * Searching one text node at a time missed every phrase that crossed an
 * element: `bold **text**` split at `<strong>`, a soft break split at its
 * `<br>`. This follows the browser's own find instead, measured in Chromium:
 * inline elements do not split a match, whitespace collapses to one space
 * outside `<pre>`, a visible `<br>` is a newline a space does not match, and
 * no match crosses from one block into the next.
 */

export interface FindOptions {
	caseSensitive: boolean;
	wholeWord: boolean;
}

/** A stretch of one text node a match covers. */
export interface MatchPiece {
	node: Text;
	start: number;
	end: number;
}

const BLOCK_TAGS = new Set([
	'ADDRESS', 'ARTICLE', 'ASIDE', 'BLOCKQUOTE', 'CAPTION', 'DD', 'DETAILS', 'DIV', 'DL', 'DT',
	'FIGCAPTION', 'FIGURE', 'FOOTER', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'HEADER', 'HR', 'LI',
	'MAIN', 'NAV', 'OL', 'P', 'PRE', 'SECTION', 'SUMMARY', 'TABLE', 'TBODY', 'TD', 'TFOOT',
	'TH', 'THEAD', 'TR', 'UL',
]);

/** Start offsets of the non-overlapping matches of `needle` in `text`. */
export function findInText(text: string, needle: string, options: FindOptions): number[] {
	const indices: number[] = [];
	if (!needle) return indices;
	const haystack = options.caseSensitive ? text : text.toLowerCase();
	const search = options.caseSensitive ? needle : needle.toLowerCase();
	const isBoundary = (c: string) => c === '' || !/[\p{L}\p{N}_]/u.test(c);
	let from = 0;
	while (from <= haystack.length - search.length) {
		const i = haystack.indexOf(search, from);
		if (i === -1) break;
		if (options.wholeWord && !(isBoundary(haystack.charAt(i - 1)) && isBoundary(haystack.charAt(i + search.length)))) {
			from = i + 1;
			continue;
		}
		indices.push(i);
		from = i + search.length;
	}
	return indices;
}

function blockOf(parent: Element | null, root: Element): Element {
	for (let el = parent; el && el !== root; el = el.parentElement) {
		if (BLOCK_TAGS.has(el.tagName)) return el;
	}
	return root;
}

const WHITESPACE = /\s+/g;

/** What one text node put into a run: `length` characters from `start`. */
interface Segment {
	node: Text;
	start: number;
	length: number;
	literal: boolean;
	/** The node's leading whitespace was dropped, the line already ending in a space. */
	dropLead: boolean;
	/** Where each drawn character sits in the node. Worked out only for a node a match reaches. */
	offsets?: Uint32Array;
}

function offsetsOf(segment: Segment): Uint32Array {
	if (segment.offsets) return segment.offsets;
	const value = segment.node.nodeValue ?? '';
	const offsets = new Uint32Array(segment.length);
	let length = 0;
	let inGap = segment.dropLead;
	for (let i = 0; i < value.length && length < segment.length; i++) {
		const space = !segment.literal && /\s/.test(value[i]);
		if (space && inGap) continue;
		offsets[length++] = i;
		inGap = space;
	}
	return (segment.offsets = offsets);
}

/** One block's text as drawn, and the text nodes it came from. */
interface Run {
	text: string;
	segments: Segment[];
}

/**
 * Every match of `query` under `root`, each as the text-node stretches it
 * covers, in document order. `skip` rejects text that is not the reader's
 * (scripts, existing marks). Stops after `limit` matches.
 */
export function findMatches(
	root: Element,
	query: string,
	options: FindOptions,
	skip: (node: Text) => boolean,
	limit: number,
): { matches: MatchPiece[][]; truncated: boolean } {
	const runs: Run[] = [];
	let run: Run | null = null;
	let runBlock: Element | null = null;
	// Siblings share a parent, so most nodes find their block in one lookup.
	let lastParent: Element | null = null;
	let lastBlock: Element = root;

	const walker = root.ownerDocument.createTreeWalker(root, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
	for (let node = walker.nextNode(); node; node = walker.nextNode()) {
		const isBreak = node.nodeType === Node.ELEMENT_NODE && (node as Element).tagName === 'BR';
		if (node.nodeType !== Node.TEXT_NODE && !isBreak) continue;
		if (node.nodeType === Node.TEXT_NODE && (!(node as Text).nodeValue || skip(node as Text))) continue;

		if (node.parentElement !== lastParent) {
			lastParent = node.parentElement;
			lastBlock = blockOf(lastParent, root);
		}
		const block = lastBlock;
		if (!run || block !== runBlock) {
			run = { text: '', segments: [] };
			runs.push(run);
			runBlock = block;
		}

		if (isBreak) {
			// A soft break the preview hides is drawn as nothing; the newline
			// after it collapses into the space between the words.
			const view = root.ownerDocument.defaultView;
			if (view?.getComputedStyle(node as Element).display !== 'none') run.text += '\n';
			continue;
		}

		const text = node as Text;
		const value = text.nodeValue ?? '';
		// `<pre>` is a block, so text inside one has it as its block.
		const literal = block.tagName === 'PRE';
		let drawn = literal ? value : value.replace(WHITESPACE, ' ');
		const tail = run.text.charAt(run.text.length - 1);
		const dropLead = !literal && drawn.startsWith(' ') && (tail === '' || tail === ' ' || tail === '\n');
		if (dropLead) drawn = drawn.slice(1);
		if (drawn) {
			run.segments.push({ node: text, start: run.text.length, length: drawn.length, literal, dropLead });
			run.text += drawn;
		}
	}

	const matches: MatchPiece[][] = [];
	for (const { text, segments } of runs) {
		// Matches come in order, so the first segment a match can touch only moves forward.
		let first = 0;
		for (const start of findInText(text, query, options)) {
			if (matches.length >= limit) return { matches, truncated: true };
			const end = start + query.length;
			while (first < segments.length && segments[first].start + segments[first].length <= start) first++;
			const pieces: MatchPiece[] = [];
			for (let i = first; i < segments.length && segments[i].start < end; i++) {
				const segment = segments[i];
				const offsets = offsetsOf(segment);
				const from = Math.max(start, segment.start) - segment.start;
				const to = Math.min(end, segment.start + segment.length) - segment.start;
				pieces.push({ node: segment.node, start: offsets[from], end: offsets[to - 1] + 1 });
			}
			if (pieces.length > 0) matches.push(pieces);
		}
	}
	return { matches, truncated: false };
}

/**
 * Wraps each match in `<mark>`s, one per text node it covers, all tagged with
 * the match's index so they highlight and step as one.
 */
export function markMatches(matches: MatchPiece[][], className: string): void {
	// Last first: splitting a node leaves its earlier offsets where they were.
	for (let index = matches.length - 1; index >= 0; index--) {
		const pieces = matches[index];
		for (let p = pieces.length - 1; p >= 0; p--) {
			const { node, start, end } = pieces[p];
			const covered = node.splitText(start);
			covered.splitText(end - start);
			const mark = node.ownerDocument.createElement('mark');
			mark.className = className;
			mark.dataset.findMatch = String(index);
			covered.replaceWith(mark);
			mark.appendChild(covered);
		}
	}
}
