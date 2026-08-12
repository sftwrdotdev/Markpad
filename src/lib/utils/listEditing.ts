import { LIST_MARKER, LIST_MARKER_PREFIX, ORDERED_MARKER, TASK_BOX } from './listSyntax.js';

/**
 * "Given a list line and where the caret is, what should the next line be" —
 * the whole of issue #604's second item, with no editor in it.
 *
 * WHY THIS IS A SEPARATE MODULE
 *
 * The interesting part of list continuation is arithmetic on a string: which
 * marker the next item wears, how much indentation it keeps, whether the item
 * was empty and the marker should therefore go away. The uninteresting part is
 * asking Monaco for the line and handing it back an edit. Keeping the first
 * part here means it can be RUN by `node --test` — every case in
 * `scripts/listEditing.test.ts` is the real function, not a description of it —
 * and leaves `Editor.svelte` with a keybinding, a `when` clause and four lines
 * of plumbing, which is all that genuinely needs a browser.
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
 * and this one needs most — an item with a marker and no text is how a list
 * ENDS, so Enter there takes the marker away instead of writing another one,
 * and the caller replaces the whole line with `line` rather than breaking it.
 * Without that there is no keystroke that gets a user out of a list.
 */
export type ListEnter =
	| { readonly kind: 'continue'; readonly text: string }
	| { readonly kind: 'clear'; readonly line: string };

/**
 * Enter at `column` (1-based, as Monaco counts) of `line`, or null for "this is
 * not a list item; do whatever Enter normally does".
 *
 * A caret still inside the marker answers null too. Enter with the caret at the
 * very start of `- item` means "make room above me", and a continuation there
 * would write its marker in front of the one already on the line.
 */
export function listEnter(line: string, column: number): ListEnter | null {
	const item = parseListItem(line);
	if (!item || column < item.contentColumn) return null;

	if (item.content.trim() === '') {
		// The prefix is kept when it carries a block quote (`> - ` empties to
		// `> `, staying in the quote the user is writing) and dropped when it is
		// only indentation, which would otherwise leave a line of trailing
		// spaces behind on every list a user finishes.
		return { kind: 'clear', line: item.prefix.trim() === '' ? '' : item.prefix };
	}

	// A checked box never propagates: the new item is something still to do.
	// `boxSpacing` can be empty when the box ended the line, and a `- [ ]` with
	// no space after it is not a task item to any renderer.
	const box = item.box ? `[ ]${item.boxSpacing || ' '}` : '';
	return { kind: 'continue', text: `${item.prefix}${nextMarker(item.marker)}${item.spacing}${box}` };
}
