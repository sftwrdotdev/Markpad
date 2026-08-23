import {
	LIST_MARKER,
	LIST_MARKER_PREFIX,
	ORDERED_MARKER,
	QUOTE_MARKER,
	TASK_BOX,
} from './listSyntax.js';

/**
 * "Given a block line and where the caret is, what should the next line be" —
 * the whole of issue #604's second item, plus #700's block quotes, with no
 * editor in it.
 *
 * WHY THIS IS A SEPARATE MODULE
 *
 * The interesting part of list continuation is arithmetic on a string: which
 * marker the next item wears, how much indentation it keeps, whether the item
 * was empty and the marker should therefore go away. The uninteresting part is
 * asking Monaco for the line and handing it back an edit. Keeping the first
 * part here means it can be RUN by `node --test` — every case in
 * `scripts/listContinuation.test.ts` is the real function, not a description of
 * it — and leaves `Editor.svelte` with a keybinding, a `when` clause and four
 * lines of plumbing, which is all that genuinely needs a browser.
 *
 * The marker vocabulary comes from ./listSyntax.ts, which is the same grammar
 * the toolbar's toggles and the preview's checkbox rewrite read. A fourth
 * spelling of "what a list marker looks like" is exactly what #631 collapsed,
 * and `scripts/singleImplementationConvention.test.ts` holds it collapsed.
 */

/**
 * One list item, split into the pieces continuation has to decide about
 * separately.
 *
 * The separator between the marker and the content is CAPTURED rather than
 * normalised: `-   item` is a hand-aligned list, and answering it with `- ` on
 * the next line silently un-aligns a document the user lined up by hand.
 */
export type ListItem = {
	/** Indentation and any block-quote markers — what makes a nested item nested. */
	readonly prefix: string;
	/** `-`, `+`, `*`, `1.` or `1)`, without the space after it. */
	readonly marker: string;
	/** The whitespace between the marker and what follows it. */
	readonly spacing: string;
	/** `[ ]` / `[x]` when this is a task item, else null. */
	readonly box: string | null;
	/** The whitespace after the box, empty when the box ends the line. */
	readonly boxSpacing: string;
	/** Everything after the marker (and the box): the text of the item. */
	readonly content: string;
	/** 1-based column where `content` starts, which is where the marker ends. */
	readonly contentColumn: number;
};

/**
 * A list item, anchored at both ends.
 *
 * The separator after the marker is REQUIRED (`[ \t]+`) and that is what keeps
 * `---` and `***` out: a thematic break is a bullet character followed by more
 * bullet characters, not by a space, so it never matches and Enter on it stays
 * Enter. The separator after a task box is optional, so that the `- [ ]` a user
 * has just typed — no trailing space yet — is recognised as the empty task item
 * it is rather than as a bullet whose text happens to be `[ ]`.
 */
const LIST_ITEM = new RegExp(
	String.raw`^(${LIST_MARKER_PREFIX})(${LIST_MARKER})([ \t]+)(?:(${TASK_BOX})([ \t]*))?(.*)$`,
);

/**
 * The whitespace a marker ends with, which the caret test below does NOT count
 * as part of it.
 */
const TRAILING_SEPARATOR = /[ \t]+$/;

/**
 * Where a marker's characters stop — the column Enter starts belonging to the
 * block at, one short of where its text starts.
 *
 * WHY NOT SIMPLY "WHERE THE TEXT STARTS". A caret drawn just after the `>` of
 * `> text` and one drawn just after the `>` of `>text` are the same pixel and
 * the same gesture, but the first is inside a two-character marker and the
 * second is at the head of the content. Testing against the text would answer
 * those two opposite things — one Enter ending the quote, the other continuing
 * it — from a position the user has no way to tell apart. Testing against the
 * marker's characters answers both the same.
 *
 * This is CodeMirror's rule, arrived at for the same reason: `commands.ts` in
 * @codemirror/lang-markdown declines only when
 * `inner.to - inner.spaceAfter.length > pos`, subtracting exactly this
 * whitespace. VS Code's Markdown All in One instead requires `> ` before the
 * caret and never continues `>text` at all, which sidesteps the question rather
 * than answering it — and cannot be copied here, because comrak draws `>text`
 * as a quote in the preview beside the editor.
 */
function markerColumn(prefix: string, markerAndSeparator: string): number {
	return prefix.length + markerAndSeparator.replace(TRAILING_SEPARATOR, '').length + 1;
}

/**
 * The marker to write, with its separator cut back to the part the caret has
 * already passed.
 *
 * WHY IT IS CUT. A caret parked inside the marker's own separator — `>| text`,
 * `-|  item` — splits that separator in two. The half after the caret travels
 * down with the text, because that is what a line break does; writing a whole
 * separator at the head of the new line therefore lands one space more than the
 * user typed, every time, and it accumulates on every Enter. Copying only the
 * half already behind the caret makes the two halves add back up to exactly the
 * separator that was there.
 *
 * The marker's CHARACTERS are never cut: the caret is past them or `blockEnter`
 * would not have got here. So an ordered marker still counts up and a task box
 * still resets, and only their trailing whitespace is rationed.
 *
 * CodeMirror writes the whole separator here and does land the extra space
 * (`commands.ts` walks `from` back over whitespace BEFORE the caret, which is a
 * different case). It is a small thing to see and an easy one to fix, so this
 * is one of the few places worth diverging.
 */
function markerUpTo(marker: string, markerColumn: number, column: number): string {
	const separator = TRAILING_SEPARATOR.exec(marker)?.[0].length ?? 0;
	return marker.slice(0, marker.length - separator + (column - markerColumn));
}

/** Is this whole marker an ordered one? The one question `nextMarker` asks. */
const ORDERED_ONLY = new RegExp(String.raw`^${ORDERED_MARKER}$`);

/** The item `line` is, or null when it is not a list item at all. */
export function parseListItem(line: string): ListItem | null {
	const match = LIST_ITEM.exec(line);
	if (!match) return null;

	const [, prefix, marker, spacing, box, boxSpacing, content] = match;
	const markerLength =
		prefix.length + marker.length + spacing.length + (box ? box.length + boxSpacing.length : 0);

	return {
		prefix,
		marker,
		spacing,
		box: box ?? null,
		boxSpacing: box ? boxSpacing : '',
		content,
		contentColumn: markerLength + 1,
	};
}

/**
 * The marker the item after this one wears.
 *
 * Bullets are returned unchanged, deliberately: `-`, `*` and `+` are three
 * spellings of the same list and CommonMark treats a change of character as the
 * start of a NEW list, so answering `* item` with `- ` would split the list the
 * user is in the middle of writing. Ordered markers count up and keep their
 * delimiter, for the same reason one delimiter over — `3)` and `4.` are two
 * lists, not one.
 */
function nextMarker(marker: string): string {
	if (!ORDERED_ONLY.test(marker)) return marker;
	return `${Number(marker.slice(0, -1)) + 1}${marker.slice(-1)}`;
}

/**
 * What Enter should do on this line.
 *
 * `continue` is the ordinary case: the text to put at the head of the new line,
 * after the line break. `clear` is the escape hatch every Markdown editor has
 * and this one needs most — a block with a marker and no text is how that block
 * ENDS, so Enter there takes the marker away instead of writing another one,
 * and the caller replaces the whole line with `line` rather than breaking it.
 * Without that there is no keystroke that gets a user out of a list or a quote.
 */
export type BlockEnter =
	| { readonly kind: 'continue'; readonly text: string }
	| { readonly kind: 'clear'; readonly line: string };

/**
 * A line that is a block quote and nothing else: `> text`, at any depth and
 * under any indentation. Anchored at the start, so a `>` in the middle of a
 * sentence is prose.
 */
const QUOTE_LINE = new RegExp(String.raw`^([ \t]*)((?:${QUOTE_MARKER})+)(.*)$`);


/**
 * Enter on a line whose whole marker is the quote — #700.
 *
 * The quote is copied rather than normalised, for the reason the list's spacing
 * is: `>  text` is a document someone typed that way, and answering it with
 * `> ` rewrites their file on a keystroke that was supposed to add a line. Both
 * implementations read for #700 normalise instead — CodeMirror to one space,
 * Markdown All in One to a hard-coded `> ` — but neither preserves a
 * hand-aligned LIST either, and agreeing with this app's own lists is worth
 * more here than agreeing with them.
 *
 * An empty quote clears to nothing rather than one level shallower. That is the
 * list rule, not a new one — `- [ ] ` clears the box AND the bullet in one
 * keystroke, never the box alone — and it is what makes the way out of `> > `
 * one Enter instead of one per level.
 */
function quoteEnter(line: string, column: number): BlockEnter | null {
	const match = QUOTE_LINE.exec(line);
	if (!match) return null;

	const [, indent, marker, content] = match;
	const from = markerColumn(indent, marker);
	if (column < from) return null;
	if (content.trim() === '') return { kind: 'clear', line: '' };
	return { kind: 'continue', text: markerUpTo(`${indent}${marker}`, from, column) };
}

/**
 * Enter at `column` (1-based, as Monaco counts) of `line`, or null for "this is
 * not a list item or a quote; do whatever Enter normally does".
 *
 * A caret still inside a marker does NOT answer null on its own — it answers
 * whatever the enclosing block says. Enter with the caret at the very start of
 * `- item` means "make room above me", so the list branch declines and nothing
 * else claims the line; Enter at `> |- item` also declines the list, but the
 * quote still owns that caret, and the tail moving down keeps its `> `.
 *
 * WHAT THIS FUNCTION CANNOT SEE: a fence. `- item` inside a ``` block is the
 * same six characters as `- item` outside one, and the difference lives in the
 * lines above, which never reach here — nor does the caller check, so a list or
 * a quote inside a code block is continued as if it were prose. That is not new
 * with the quote branch; it is where lists have always stood. Nothing public in
 * Monaco answers "is this line code" without re-tokenizing every line above the
 * caret, which is 27 ms at 2 000 lines and 275 ms at 20 000 — a price Enter, of
 * all keys, cannot pay. Whoever fixes it has to reach Monaco's own incremental
 * tokens or this app's semantic layer first.
 */
export function blockEnter(line: string, column: number): BlockEnter | null {
	const item = parseListItem(line);
	// The separator between the marker and the text belongs to neither: see
	// `markerColumn`. For a task item the marker runs through the box, so what
	// is subtracted is the space after the BOX, not the one before it.
	const listMarker = `${item?.marker}${item?.spacing}${item?.box ?? ''}${item?.boxSpacing ?? ''}`;
	const from = item ? markerColumn(item.prefix, listMarker) : 0;
	if (item && column >= from) {
		if (item.content.trim() === '') {
			// The prefix is kept when it carries a block quote (`> - ` empties to
			// `> `, staying in the quote the user is writing) and dropped when it
			// is only indentation, which would otherwise leave a line of trailing
			// spaces behind on every list a user finishes.
			return { kind: 'clear', line: item.prefix.trim() === '' ? '' : item.prefix };
		}

		// A checked box never propagates: the new item is something still to do.
		// `boxSpacing` can be empty when the box ended the line, and a `- [ ]`
		// with no space after it is not a task item to any renderer.
		const box = item.box ? `[ ]${item.boxSpacing || ' '}` : '';
		const marker = `${item.prefix}${nextMarker(item.marker)}${item.spacing}${box}`;
		return { kind: 'continue', text: markerUpTo(marker, from, column) };
	}

	return quoteEnter(line, column);
}

/* ---------------------------------------------------------------- #711: Tab

 * Changing an item's LEVEL, which is two edits and not one.
 *
 * `editor.action.indentLines` — what Tab did until #711 — moves the line by the
 * editor's `tabSize` and leaves the number alone. Both halves of that are wrong
 * in Markdown, and each is wrong on its own:
 *
 *   1. NESTING IS A COLUMN, NOT A TAB. An item nests inside the one above it
 *      only when its indentation reaches that item's CONTENT column: 2 for
 *      `- `, 3 for `1. `, 4 for `10. `. With `tabSize` at 2 under a `1. ` parent
 *      the line moves and nothing nests — CommonMark reads it as the next
 *      sibling, which is what #711's reporter saw.
 *   2. THE NUMBER SUDDENLY MATTERS. In a flat list the numbers after the first
 *      are ignored: `1. / 7. / 3.` renders 1, 2, 3, because a list's start comes
 *      from its FIRST item and the renderer counts from there. Tab moves a line
 *      to exactly the one position where its number is read — the first item of
 *      a new sub-list — so the `2.` that Enter wrote, and that had been
 *      invisible all along, renders as `2.`.
 *
 * So Tab has to indent to the parent's content column AND renumber, and the
 * renumbering cannot stop at the moved line: the siblings it left behind in the
 * parent list are now 1, 3, 4.
 *
 * WHAT IS COPIED FROM MARKDOWN ALL IN ONE, AND WHAT IS NOT
 *
 * The shape is `vscode-markdown`'s (`src/listEditing.ts`: `indent()` +
 * `fixMarker()`), which is the de-facto standard for this key — its adaptive
 * indentation is the same "align to the parent's marker width" rule, and its
 * `lookUpwardForMarker` is the same upward scan for a sibling. Three deliberate
 * divergences:
 *
 *   - MAIO's sibling test compares the caret's indentation against the previous
 *     item's DIGITS (`prevLeadingSpace + prevMarker`), not against its content
 *     column, so under `1. x` it reads indentation 2 as nested when CommonMark
 *     needs 3. That is invisible in MAIO because MAIO only ever writes 3, and
 *     very visible here, where every document already carries the indentation
 *     the old Tab produced.
 *   - MAIO renumbers a list's FIRST item too, so `5. 6. 7.` — a list that
 *     legitimately starts at 5 — silently becomes 1, 2, 3 on a Tab elsewhere in
 *     the document. Here the number is only forced on the line the user is
 *     moving; a first item nobody touched keeps what it says, and every scan
 *     that fails to find a sibling therefore degrades to "leave it alone"
 *     rather than to "write 1".
 *   - Block quotes are respected. MAIO has no concept of them, which is the
 *     same defect Obsidian still has inside callouts, and this app has had
 *     quote-aware list handling since #700.
 *
 * WHAT IS NOT SUPPORTED, STATED RATHER THAN DISCOVERED
 *
 *   - A CHILD DOES NOT TRAVEL WITH ITS PARENT. Tab on an item that already has
 *     a sub-list under it moves one line, so the sub-list is left at what is now
 *     its parent's own level and becomes its sibling. MAIO behaves the same way;
 *     Obsidian, whose editor holds a real tree, moves the subtree. Doing it here
 *     means deciding where an item's children END, which is the fenced-code
 *     problem `blockEnter` documents one function up.
 *   - THE WALK IS O(LIST), not O(edit). Every ordered item below the moved one
 *     is re-derived, because one of them changing can change the next; only the
 *     lines that actually differ end up in the edit, but all of them are read.
 *     Measured on a flat ordered list: 2 ms at 500 items, 5 ms at 5 000, 22 ms
 *     at 20 000. Tab is not Enter — it moves a whole line and the user expects
 *     the document to change — so this stays until a list long enough to feel it
 *     turns up in a real document.
 *   - THE SEPARATOR AFTER THE MARKER IS NOT RE-PADDED. Renumbering `10.` to `9.`
 *     shortens the marker by one column, so text hand-aligned under it is off by
 *     one until the user fixes it. MAIO pads the separator to hold the content
 *     column still; this module keeps the separator the user typed, which is the
 *     rule the whole module already follows.
 */

/**
 * The two things this module asks of a document — the shape Monaco's
 * `ITextModel` already has, so `Editor.svelte` passes the model itself and a
 * test passes an object literal. `utils/tableEditing.ts` asks for the same two
 * for the same reason: a scan outward from the caret is O(list), where
 * `getLinesContent()` would be O(document) on every keystroke.
 */
export type ListDocument = {
	getLineCount(): number;
	getLineContent(line: number): string;
};

/**
 * A replacement for one line range, and where the caret goes in it.
 *
 * Deliberately the same record as `TableEdit`: both keys end at the same
 * `executeEdits` in `Editor.svelte`, and giving them one shape is what lets that
 * be one function instead of two.
 */
export type ListEdit = {
	/** 1-based inclusive line range to replace. */
	readonly startLine: number;
	readonly endLine: number;
	/** The lines as they should be. `lines[0]` is the line that moved. */
	readonly lines: readonly string[];
	readonly caretLine: number;
	readonly caretColumn: number;
};

/**
 * A tab stop, in columns. CommonMark's own figure: a tab advances to the next
 * multiple of four, which is not the same as "four columns" once a space
 * precedes it.
 */
const TAB_STOP = 4;

/** How many columns `text` occupies, counting a tab to the next tab stop. */
function columnsOf(text: string): number {
	let width = 0;
	for (const character of text) {
		width = character === '\t' ? width + TAB_STOP - (width % TAB_STOP) : width + 1;
	}
	return width;
}

/**
 * The block-quote markers a line opens with, separated from the indentation
 * that follows them.
 *
 * Each `>` takes AT MOST ONE space with it, which is the rule that makes the
 * split meaningful: in `>   - item` the quote is `> ` and the list is indented
 * by two, so the item is nested inside the quote's list rather than sitting at
 * its margin. `LIST_MARKER_PREFIX` cannot answer this on its own — its
 * `QUOTE_MARKER` is greedy and swallows all three spaces.
 */
const QUOTE_PREFIX = /^(?:[ \t]*>[ \t]?)*/;

function splitQuote(prefix: string): { quote: string; indent: string } {
	const quote = QUOTE_PREFIX.exec(prefix)?.[0] ?? '';
	return { quote, indent: prefix.slice(quote.length) };
}

/** The leading whitespace and quote markers of ANY line, list item or not. */
const LINE_PREFIX = new RegExp(String.raw`^(${LIST_MARKER_PREFIX})`);

/**
 * One line, reduced to what the two scans below ask about it.
 *
 * `indent` and `content` are columns INSIDE the quote — measured from after the
 * last `>` — because that is where a quoted list's own margin is.
 */
type Row = {
	readonly depth: number;
	readonly indent: number;
	/** The column an item's content starts at; `indent` again when there is none. */
	readonly content: number;
	readonly blank: boolean;
	readonly item: ListItem | null;
	/** The ordered marker's number, or null for a bullet and for a non-item. */
	readonly number: number | null;
};

function rowOf(line: string): Row {
	const item = parseListItem(line);
	const { quote, indent } = splitQuote(item ? item.prefix : (LINE_PREFIX.exec(line)?.[1] ?? ''));
	const depth = (quote.match(/>/g) ?? []).length;
	const indentWidth = columnsOf(indent);

	return {
		depth,
		indent: indentWidth,
		content: item ? columnsOf(`${indent}${item.marker}${item.spacing}`) : indentWidth,
		blank: line.trim() === '',
		item,
		number: item && ORDERED_ONLY.test(item.marker) ? Number(item.marker.slice(0, -1)) : null,
	};
}

/** An item's line, rebuilt with a different prefix and a different marker. */
function rebuild(item: ListItem, prefix: string, marker: string): string {
	return `${prefix}${marker}${item.spacing}${item.box ?? ''}${item.boxSpacing}${item.content}`;
}

/** The same item wearing a different number, delimiter and spacing untouched. */
function withNumber(item: ListItem, number: number): string {
	return rebuild(item, item.prefix, `${number}${item.marker.slice(-1)}`);
}

/**
 * The item this one follows at its own level, or null when it is the first of
 * its list — which is the one question renumbering asks.
 *
 * A blank line is skipped: a loose list is still one list. A line that is NOT a
 * list item ends the scan only when it is no deeper than the caret's own
 * indentation, so an item's own wrapped paragraph is scanned past and the prose
 * before the list is not.
 *
 * `lineAt` rather than the document, because the cascade below has already
 * rewritten some of these lines and every later scan has to see the rewrite.
 */
function siblingAbove(
	lineAt: (line: number) => string,
	from: number,
	depth: number,
	indent: number,
): Row | null {
	for (let line = from - 1; line >= 1; line--) {
		const row = rowOf(lineAt(line));
		if (row.blank) continue;
		if (row.depth !== depth) return null;

		if (row.item) {
			// Reaching that item's content column means it is the PARENT, so
			// there is no sibling above and this line is the first of its list.
			if (indent >= row.content) return null;
			if (indent >= row.indent) return row;
			// Deeper than this line: something nested inside an earlier sibling.
			continue;
		}

		if (row.indent <= indent) return null;
	}
	return null;
}

/**
 * The indentation, in columns, the line should move to — null for "it cannot
 * move", which is a key that does nothing rather than a key that inserts
 * whitespace.
 *
 * Tab looks for the SIBLING above and takes its content column: nesting under a
 * previous item is the only thing indenting a list item can mean, so the first
 * item of a list has nowhere to go (Tab there is a no-op in Obsidian and in
 * every outliner). Shift+Tab looks for the PARENT and takes its margin, which
 * lands the line on a level that exists rather than `tabSize` columns to the
 * left of one.
 */
function targetIndent(doc: ListDocument, line: number, here: Row, back: boolean): number | null {
	for (let above = line - 1; above >= 1; above--) {
		const row = rowOf(doc.getLineContent(above));
		if (row.blank) continue;
		if (row.depth !== here.depth) break;

		if (row.item) {
			if (here.indent >= row.content) return back ? row.indent : null;
			if (!back && here.indent >= row.indent) return row.content;
			continue;
		}

		if (row.indent <= here.indent) break;
	}

	// Nothing above owns this line. Shift+Tab still has somewhere to go if the
	// line is indented at all; Tab has nothing to nest under.
	return back && here.indent > 0 ? 0 : null;
}

/**
 * The shallowest column an ordered item's content can start at, and therefore
 * the shallowest a line can be indented and still be INSIDE one: `1. ` is three
 * columns. Used to end the downward walk — after a blank line, a line shallower
 * than this is a new block, and the list it follows is over.
 */
const LIST_CONTENT_MIN = 3;

/**
 * Tab / Shift+Tab on a list item: the line at its new level, with every ordered
 * number that the move invalidated rewritten. Null when the line is not a list
 * item, or when it has no level to move to.
 *
 * THE RANGE IS AS SHORT AS THE EDIT. The walk downward continues past lines it
 * does not change — an item's own paragraphs, a nested bullet list — but the
 * range ends at the last line that actually differs, so the undo step and the
 * dirty-diff cover what moved and nothing else.
 */
export function shiftListItem(
	doc: ListDocument,
	line: number,
	column: number,
	back: boolean,
): ListEdit | null {
	const source = doc.getLineContent(line);
	const item = parseListItem(source);
	if (!item) return null;

	const here = rowOf(source);
	const target = targetIndent(doc, line, here, back);
	if (target === null || target === here.indent) return null;

	const edited = new Map<number, string>();
	const lineAt = (at: number) => edited.get(at) ?? doc.getLineContent(at);

	const { quote } = splitQuote(item.prefix);
	const prefix = `${quote}${' '.repeat(target)}`;

	// The moved line is the one line whose number may be FORCED, because it is
	// the one line that has just changed what its number MEANS: an item with a
	// sibling above it is counted by the renderer, and an item without one starts
	// a list at whatever it says. Landing without a sibling therefore writes 1 —
	// unless the line had no sibling before the move either, in which case it was
	// already a list's start and `5.` is a start, not a mistake.
	const sibling = siblingAbove(lineAt, line, here.depth, target);
	const first = sibling?.number == null;
	const started = first && siblingAbove(lineAt, line, here.depth, here.indent) === null;
	const number = first ? (started ? here.number : 1) : sibling!.number! + 1;
	const marker = here.number === null ? item.marker : `${number}${item.marker.slice(-1)}`;
	const shifted = rebuild(item, prefix, marker);
	edited.set(line, shifted);

	const lines = [shifted];
	let last = line;
	let afterBlank = false;

	for (let below = line + 1; below <= doc.getLineCount(); below++) {
		const text = doc.getLineContent(below);
		const row = rowOf(text);

		if (row.blank) {
			afterBlank = true;
			lines.push(text);
			continue;
		}
		if (row.depth !== here.depth) break;
		if (afterBlank && row.indent < LIST_CONTENT_MIN && !row.item) break;
		afterBlank = false;

		if (row.number === null) {
			lines.push(text);
			continue;
		}

		// No sibling means this item is the first of its own list, and a first
		// item nobody moved keeps the number it says: `5. 6. 7.` is a list that
		// starts at five, not a list that is wrong.
		const previous = siblingAbove(lineAt, below, row.depth, row.indent);
		const fixed =
			previous?.number == null || previous.number + 1 === row.number
				? text
				: withNumber(row.item!, previous.number + 1);
		if (fixed !== text) {
			edited.set(below, fixed);
			last = below;
		}
		lines.push(fixed);
	}

	// The caret keeps its place in the text: everything before the content moved
	// by the same amount, so the caret does too.
	const head = prefix.length + marker.length - item.prefix.length - item.marker.length;

	return {
		startLine: line,
		endLine: last,
		lines: lines.slice(0, last - line + 1),
		caretLine: line,
		caretColumn: Math.max(1, column + head),
	};
}
