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
