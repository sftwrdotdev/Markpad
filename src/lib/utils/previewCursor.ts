import { asRendererLine, type RendererLine } from './lineCoordinates.js';

/**
 * The preview's half of the shared cursor (#799): a point in the rendered
 * preview and a place in the source, in both directions.
 *
 * A block's rendered text is its source with the markup taken out, in the same
 * order. So each rendered character is paired with the next matching source
 * character, and a point on either side reads its partner off that pairing.
 * Where rendering changed the text (KaTeX, an entity, smart punctuation) a
 * character finds no partner nearby and the pairing moves on in order.
 */

/** `column` is 1-based in UTF-16 units, the way Monaco counts. */
export type SourcePoint = { line: RendererLine; column: number };

export type DomPoint = { node: Node; offset: number };

/** Source text for a renderer line, or undefined past the end. */
export type SourceLineReader = (line: number) => string | undefined;

/**
 * Inline elements carry their own `data-sourcepos` too, but their range starts
 * at their opening delimiter, which the pairing would have to know. A block
 * starts at its text or at markup the pairing skips (`## `, `- `, `> `). Void
 * elements (`<br>`) hold no text to pair.
 */
const NOT_BLOCKS = new Set(['A', 'ABBR', 'B', 'BR', 'CODE', 'DEL', 'EM', 'HR', 'I', 'IMG', 'INPUT', 'INS', 'KBD', 'MARK', 'S', 'SMALL', 'SPAN', 'STRONG', 'SUB', 'SUP', 'U']);

/** How far past the last paired character a rendered character is looked for. */
const LOOKAHEAD = 24;

type Block = {
	el: Element;
	line: number;
	/** UTF-16 index on the block's first line where `source` starts. */
	skipped: number;
	source: string;
	lineStarts: number[];
};

type Pair = { node: Text; offset: number; source: number };

export function sourceAtPoint(root: Element, point: DomPoint, readLine: SourceLineReader): SourcePoint | null {
	const block = blockContaining(root, point.node, readLine);
	if (!block) return null;

	const at = block.el.ownerDocument.createRange();
	at.setStart(point.node, point.offset);
	const next = pairsOf(block).find((pair) => at.comparePoint(pair.node, pair.offset) >= 0);
	return sourcePointOf(block, next ? next.source : block.source.length);
}

export function pointAtSource(root: Element, target: SourcePoint, readLine: SourceLineReader): DomPoint | null {
	const el = narrowestBlockAt(root, target, readLine);
	if (!el) return null;
	const block = readBlock(el, readLine);
	if (!block) return null;

	const index = sourceIndexOf(block, target);
	const pairs = pairsOf(block);
	const next = pairs.find((pair) => pair.source >= index);
	if (next) return { node: next.node, offset: next.offset };
	const last = pairs.at(-1);
	return last ? { node: last.node, offset: last.offset + 1 } : { node: el, offset: 0 };
}

function blockContaining(root: Element, node: Node, readLine: SourceLineReader): Block | null {
	for (let el = node instanceof Element ? node : node.parentElement; el && root.contains(el); el = el.parentElement) {
		if (el.hasAttribute('data-sourcepos') && !NOT_BLOCKS.has(el.tagName)) return readBlock(el, readLine);
	}
	return null;
}

/**
 * The fewest lines wins, and on a tie the later element, which in document
 * order is the nested one (`<p>` over its `<li>`) or the next cell on the row.
 * A block that starts on the target line must start at or before its column.
 */
function narrowestBlockAt(root: Element, target: SourcePoint, readLine: SourceLineReader): Element | null {
	let best: Element | null = null;
	let bestSpan = Infinity;
	for (const el of root.querySelectorAll('[data-sourcepos]')) {
		if (NOT_BLOCKS.has(el.tagName)) continue;
		const range = parseSourcepos(el);
		if (!range || target.line < range.line || target.line > range.endLine) continue;
		if (target.line === range.line && indexOfByteColumn(readLine(range.line) ?? '', range.column) + 1 > target.column) continue;
		const span = range.endLine - range.line;
		if (span <= bestSpan) {
			best = el;
			bestSpan = span;
		}
	}
	return best;
}

function parseSourcepos(el: Element) {
	const match = el.getAttribute('data-sourcepos')?.match(/^(\d+):(\d+)-(\d+):\d+$/);
	return match ? { line: Number(match[1]), column: Number(match[2]), endLine: Number(match[3]) } : null;
}

function readBlock(el: Element, readLine: SourceLineReader): Block | null {
	const range = parseSourcepos(el);
	if (!range) return null;

	// A fenced block's range starts at the fence, whose info string (`js`)
	// would take the pairing of code that begins with the same letters.
	if (el.tagName === 'PRE' && /^\s*(```|~~~)/.test(readLine(range.line) ?? '')) {
		range.line++;
		range.column = 1;
	}

	const first = readLine(range.line) ?? '';
	const skipped = indexOfByteColumn(first, range.column);
	const lines = [first.slice(skipped)];
	for (let line = range.line + 1; line <= range.endLine; line++) lines.push(readLine(line) ?? '');

	const lineStarts: number[] = [];
	let offset = 0;
	for (const text of lines) {
		lineStarts.push(offset);
		offset += text.length + 1;
	}
	return { el, line: range.line, skipped, source: lines.join('\n'), lineStarts };
}

/** comrak reports columns as 1-based UTF-8 byte offsets; this is the UTF-16 index they point at. */
function indexOfByteColumn(text: string, column: number): number {
	let bytes = 0;
	let index = 0;
	while (index < text.length && bytes < column - 1) {
		const codePoint = text.codePointAt(index)!;
		bytes += codePoint < 0x80 ? 1 : codePoint < 0x800 ? 2 : codePoint < 0x10000 ? 3 : 4;
		index += codePoint > 0xffff ? 2 : 1;
	}
	return index;
}

function pairsOf(block: Block): Pair[] {
	const walker = block.el.ownerDocument.createTreeWalker(block.el, 4 /* NodeFilter.SHOW_TEXT */, {
		// KaTeX's text is a layout of glyphs, not the source it came from.
		acceptNode: (node) => (node.parentElement?.closest('.katex') ? 2 /* FILTER_REJECT */ : 1 /* FILTER_ACCEPT */),
	});

	const pairs: Pair[] = [];
	let cursor = 0;
	for (let node = walker.nextNode() as Text | null; node; node = walker.nextNode() as Text | null) {
		for (let offset = 0; offset < node.data.length; offset++) {
			const found = seek(block.source, node.data[offset], cursor);
			pairs.push({ node, offset, source: found ?? cursor });
			if (found !== null) cursor = found + 1;
		}
	}
	return pairs;
}

function seek(source: string, char: string, from: number): number | null {
	const end = Math.min(source.length, from + LOOKAHEAD);
	for (let index = from; index < end; index++) {
		if (sameCharacter(source[index], char)) return index;
	}
	return null;
}

function sameCharacter(a: string, b: string): boolean {
	return a === b || (/\s/.test(a) && /\s/.test(b));
}

function sourcePointOf(block: Block, index: number): SourcePoint {
	let row = 0;
	while (row + 1 < block.lineStarts.length && block.lineStarts[row + 1] <= index) row++;
	const column = index - block.lineStarts[row] + 1 + (row === 0 ? block.skipped : 0);
	return { line: asRendererLine(block.line + row), column };
}

function sourceIndexOf(block: Block, target: SourcePoint): number {
	const row = Math.min(Math.max(0, target.line - block.line), block.lineStarts.length - 1);
	const column = target.column - 1 - (row === 0 ? block.skipped : 0);
	return block.lineStarts[row] + Math.max(0, column);
}
