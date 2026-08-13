import {
	BULLET_MARKER,
	LIST_MARKER,
	LIST_MARKER_PREFIX,
	ORDERED_MARKER,
	TASK_BOX,
} from './listSyntax.js';
import { shortcutLabel } from './shortcuts.js';

type EditorToolbarGroup = 'inline' | 'block' | 'list' | 'insert';

export type EditorToolbarTool = {
	id: string;
	label: string;
	name: string;
	shortcut?: (modifier: 'Ctrl' | 'Cmd') => string;
	group: EditorToolbarGroup;
};

type EditorToolbarMove = {
	fromIndex: number;
	toIndex: number;
};

/**
 * The buttons, without their shortcut hints — those come from the registry.
 *
 * A tool id IS the Monaco action id, which is also the registry id, so a button
 * and the shortcut it advertises cannot be attached to different commands.
 */
const BASE_TOOLBAR_TOOLS: ReadonlyArray<Omit<EditorToolbarTool, 'shortcut'>> = [
	{ id: 'fmt-bold', label: 'B', name: 'Bold', group: 'inline' },
	{ id: 'fmt-italic', label: 'I', name: 'Italic', group: 'inline' },
	{ id: 'fmt-underline', label: 'U', name: 'Underline', group: 'inline' },
	{ id: 'fmt-strikethrough', label: 'S', name: 'Strikethrough', group: 'inline' },
	{ id: 'fmt-inline-code', label: '`', name: 'Inline Code', group: 'inline' },
	{ id: 'fmt-code-block', label: '{}', name: 'Code Block', group: 'block' },
	{ id: 'fmt-quote', label: '>', name: 'Quote', group: 'block' },
	{ id: 'fmt-heading-1', label: 'H1', name: 'Heading 1', group: 'block' },
	{ id: 'fmt-heading-2', label: 'H2', name: 'Heading 2', group: 'block' },
	{ id: 'fmt-heading-3', label: 'H3', name: 'Heading 3', group: 'block' },
	{ id: 'fmt-bullet-list', label: '-', name: 'Bullet List', group: 'list' },
	{ id: 'fmt-numbered-list', label: '1.', name: 'Numbered List', group: 'list' },
	{ id: 'fmt-checklist', label: '[ ]', name: 'Checklist', group: 'list' },
	{ id: 'fmt-link', label: '[]', name: 'Link', group: 'insert' },
	{ id: 'insert-table-simple', label: '#', name: 'Table', group: 'insert' },
];

/**
 * The tooltip hint used to be a second copy of each chord, kept in step with
 * `Editor.svelte` by hand until #480 wrote a test for it. It is now read from
 * `shortcuts.ts`, so a tool with no registry row advertises nothing — which is
 * the same rule the test enforces from the other side.
 */
const EDITOR_TOOLBAR_TOOLS: EditorToolbarTool[] = BASE_TOOLBAR_TOOLS.map((tool) =>
	shortcutLabel(tool.id, 'Ctrl') === undefined
		? { ...tool }
		: { ...tool, shortcut: (modifier: 'Ctrl' | 'Cmd') => shortcutLabel(tool.id, modifier)! },
);

export const DEFAULT_EDITOR_TOOLBAR_ORDER = EDITOR_TOOLBAR_TOOLS.map((tool) => tool.id);

/** The box and the space after it, which travel together. */
const TASK_BOX_MARKER = String.raw`${TASK_BOX}\s+`;

/**
 * A bullet, an ordered number and a task box all claim the same slot at the
 * head of a line, so applying one of them has to take away whichever one is
 * already there — that is what `1. foo` -> `- 1. foo` got wrong.
 *
 * The box is part of the marker, not part of the text: stripping only `- ` off
 * `- [ ] foo` would leave the orphan `[ ] foo`, which no toggle recognises any
 * more. The ordered-plus-box form is matched too, so the `1. [ ] foo` that the
 * old numbered-list toggle used to produce normalises on the next toggle
 * instead of round-tripping to an orphan box.
 *
 * The marker vocabulary itself comes from ./listSyntax.ts, shared with the
 * renderer's side of the same grammar. It used to be spelled here as
 * `(?:[-*+]|\d+\.)`, which is the same defect one delimiter over: `1) foo`
 * became `- 1) foo`.
 */
const ANY_LIST_MARKER = new RegExp(String.raw`^${LIST_MARKER}\s+(?:${TASK_BOX_MARKER})?`);

const ANY_HEADING = /^#{1,6}\s+/;

/** Leading indentation, which every tool preserves. */
const INDENT = /^[ \t]*/;

/**
 * Indentation plus block-quote nesting: the prefix the *list* tools preserve.
 *
 * A quoted list item (`> - item`) is a list item — it is what the renderer reads
 * as one — so the list buttons have to find the marker behind the quote markers
 * rather than write a second marker in front of them. The quote and heading
 * tools keep `INDENT` instead: Quote's whole job is to add a `>` in front of
 * whatever is there, including another `>`.
 */
const QUOTED_INDENT = new RegExp(String.raw`^${LIST_MARKER_PREFIX}`);

type LineMarker = {
	/**
	 * What this tool leaves untouched at the head of the line. Matched first, and
	 * put back afterwards: it is the difference between un-bulleting a nested item
	 * and flattening it to the top level.
	 */
	readonly prefix: RegExp;
	/** Matches the marker this tool owns; deciding when a toggle un-toggles. */
	readonly own: RegExp;
	/** The marker text. The argument counts content lines, for `1.`, `2.`, … */
	readonly render: (itemIndex: number) => string;
	/**
	 * The markers this tool replaces when it applies its own. Quote has none on
	 * purpose: `> - foo` is a quoted list item, a nesting people write by hand
	 * and ask a toolbar for, not a line wearing two competing markers.
	 */
	readonly competing: RegExp | null;
};

const LINE_MARKERS = {
	'fmt-quote': { prefix: INDENT, own: /^>\s+/, render: () => '> ', competing: null },
	// The list toggles exclude a following task box from `own` so that they add
	// their marker to a checklist item instead of un-toggling it and leaving the
	// box behind.
	'fmt-bullet-list': {
		prefix: QUOTED_INDENT,
		own: new RegExp(String.raw`^${BULLET_MARKER}\s+(?!${TASK_BOX_MARKER})`),
		render: () => '- ',
		competing: ANY_LIST_MARKER,
	},
	'fmt-numbered-list': {
		prefix: QUOTED_INDENT,
		own: new RegExp(String.raw`^${ORDERED_MARKER}\s+(?!${TASK_BOX_MARKER})`),
		render: (itemIndex: number) => `${itemIndex}. `,
		competing: ANY_LIST_MARKER,
	},
	'fmt-checklist': {
		prefix: QUOTED_INDENT,
		own: new RegExp(String.raw`^${BULLET_MARKER}\s+${TASK_BOX_MARKER}`),
		render: () => '- [ ] ',
		competing: ANY_LIST_MARKER,
	},
	'fmt-heading-1': { prefix: INDENT, own: /^#\s+/, render: () => '# ', competing: ANY_HEADING },
	'fmt-heading-2': { prefix: INDENT, own: /^##\s+/, render: () => '## ', competing: ANY_HEADING },
	'fmt-heading-3': { prefix: INDENT, own: /^###\s+/, render: () => '### ', competing: ANY_HEADING },
} satisfies Record<string, LineMarker>;

export type LineMarkerToolId = keyof typeof LINE_MARKERS;

export const LINE_MARKER_TOOL_IDS = Object.keys(LINE_MARKERS) as LineMarkerToolId[];

/**
 * Applies (or removes) one toolbar line marker across the selected lines.
 *
 * Removal wins only when every content line already carries this tool's own
 * marker; otherwise the marker is applied to all of them, which is what makes a
 * mixed selection converge on one list type instead of stacking markers.
 * Blank lines are left exactly as they are and are not numbered.
 *
 * The caller hands over whole lines, untrimmed (`Editor.svelte` reads the
 * selection from column 1), so every line arrives with whatever puts it where it
 * is: the indentation of a nested item, the `>` of a quoted one. That prefix is
 * split off, held, and put back — the markers below are matched against the rest
 * of the line and never see it. Matching them against the whole line instead is
 * what made a nested bullet unrecognisable, and stripping the prefix along with
 * the marker is what would have flattened the item to the top level.
 */
export function toggleLineMarker(id: LineMarkerToolId, lines: readonly string[]): string[] {
	const marker = LINE_MARKERS[id];
	// Both patterns can match the empty string, so `exec` never returns null —
	// the fallback is there for the type, not for a case.
	const split = (line: string) => {
		const prefix = (marker.prefix.exec(line) ?? [''])[0];
		return { prefix, rest: line.slice(prefix.length) };
	};

	const contentLines = lines.filter((line) => line.trim().length > 0);
	const shouldRemove =
		contentLines.length > 0 && contentLines.every((line) => marker.own.test(split(line).rest));

	let itemIndex = 1;
	return lines.map((line) => {
		if (!line.trim()) return line;
		const { prefix, rest } = split(line);
		if (shouldRemove) return `${prefix}${rest.replace(marker.own, '')}`;
		const body = marker.competing ? rest.replace(marker.competing, '') : rest;
		return `${prefix}${marker.render(itemIndex++)}${body}`;
	});
}

type InlineWrap = {
	/** The one spelling the button writes. */
	readonly write: string;
	/**
	 * The spellings it takes back off, LONGEST FIRST. Order is load-bearing:
	 * with `~` tried first, `~~gone~~` would lose one tilde per end and come back
	 * as `~gone~`, which is still struck through.
	 */
	readonly strip: readonly string[];
};

/**
 * What each wrapping tool writes, and what it recognises as its own.
 *
 * Two fields rather than one marker because Markdown spells most of these twice.
 * `**bold**` and `__bold__` are the same span, and a toolbar that knew only the
 * asterisk spelling answered a click on `__bold__` by wrapping a second pair
 * around it. So: write the portable spelling, accept both.
 *
 * That is also why Strikethrough writes `~~` and not `~`. GFM reads one or two
 * tildes, and so does this app's renderer — deliberately, which is why
 * `markdown_options` in src-tauri/src/markdown.rs refuses the `subscript`
 * extension: taking `~x~` for a subscript would make a valid GFM document
 * render differently here. The same reasoning applies one step further out. The
 * app can *accept* a single tilde without hurting anyone; writing one would make
 * it the source of text that other renderers read differently.
 */
const INLINE_WRAPS = {
	'fmt-bold': { write: '**', strip: ['**', '__'] },
	'fmt-italic': { write: '*', strip: ['*', '_'] },
	'fmt-strikethrough': { write: '~~', strip: ['~~', '~'] },
	'fmt-inline-code': { write: '`', strip: ['`'] },
} satisfies Record<string, InlineWrap>;

export type InlineWrapToolId = keyof typeof INLINE_WRAPS;

export const INLINE_WRAP_TOOL_IDS = Object.keys(INLINE_WRAPS) as InlineWrapToolId[];

/** Every marker any wrapping tool owns — what the rule below measures against. */
const ALL_WRAP_MARKERS = [...new Set(Object.values(INLINE_WRAPS).flatMap((wrap) => wrap.strip))];

/**
 * Is `text` `marker`…`marker`? The length guard is what stops a selection of
 * exactly `**` from being read as an empty bold span whose two ends are the
 * same two characters, and sliced into nothing.
 */
function wrappedIn(text: string, marker: string): boolean {
	return text.length >= marker.length * 2 && text.startsWith(marker) && text.endsWith(marker);
}

/**
 * Applies (or removes) one toolbar inline format around the selected text.
 *
 * THE RULE THAT KEEPS ITALIC OFF BOLD'S MARKER
 *
 * `*` is a prefix of `**`, so "the selection starts and ends with my marker"
 * said yes for Italic on `**bold**`: it took one asterisk off each end and
 * turned bold text into italic text. Trying the longer markers first does not
 * fix that on its own, because `**` is not in Italic's list at all — Italic
 * never considers it.
 *
 * So a marker counts as this tool's own only when no LONGER marker belonging to
 * another tool is standing in the same place. Italic looking at `**bold**` sees
 * bold's `**` wrapped around the `*` it was about to take, leaves it alone, and
 * falls through to wrapping — which is the other half of the answer: asking for
 * italic on bold text means both, `***bold***`.
 *
 * Unless BOTH are there, which is what `***bold***` itself is: the two markers
 * side by side, not one of them. Taking italic's asterisk off that leaves bold's
 * pair whole, so there is nothing to protect and the toggle does what it was
 * asked — un-italicise text that really was italic.
 */
export function toggleInlineWrap(id: InlineWrapToolId, text: string): string {
	const { write, strip } = INLINE_WRAPS[id];

	for (const marker of strip) {
		if (!wrappedIn(text, marker)) continue;
		const belongsToAnotherTool = ALL_WRAP_MARKERS.some(
			(other) =>
				other.length > marker.length &&
				!strip.includes(other) &&
				wrappedIn(text, other) &&
				!wrappedIn(text, other + marker),
		);
		if (belongsToAnotherTool) continue;
		return text.slice(marker.length, -marker.length);
	}

	return `${write}${text}${write}`;
}

/** The longest run of `ch` at the end of `text`. */
function trailingRun(text: string, ch: string): number {
	let n = 0;
	while (n < text.length && text[text.length - 1 - n] === ch) n += 1;
	return n;
}

/** The longest run of `ch` at the start of `text`. */
function leadingRun(text: string, ch: string): number {
	let n = 0;
	while (n < text.length && text[n] === ch) n += 1;
	return n;
}

/**
 * How far outside the selection this tool's own pair sits, or 0 for none.
 *
 * WHY IT MEASURES THE WHOLE RUN RATHER THAN MATCHING THE MARKER. Asking only
 * "is the character outside the selection mine" says yes for Italic on
 * `**word**` — that run does end in an asterisk — and taking one from each side
 * would break bold's pair in half. Requiring the run to be exactly this marker's
 * length is the same protection the longer-marker rule above gives, expressed on
 * text the toggle cannot see: a run of two is bold's, so Italic leaves it alone
 * and falls through to wrapping, which is `***word***` — asking for italic on
 * bold text means both, exactly as it does when the markers are selected.
 *
 * Both sides must match, so a half-written `~~word~` is left alone rather than
 * half unwrapped.
 */
function ownMarkerReach(id: InlineWrapToolId, before: string, after: string): number {
	for (const marker of INLINE_WRAPS[id].strip) {
		const ch = marker[0];
		if (trailingRun(before, ch) !== marker.length) continue;
		if (leadingRun(after, ch) !== marker.length) continue;
		return marker.length;
	}
	return 0;
}

/** How far outside a selection any marker can reach — how much context a caller must read. */
export const INLINE_WRAP_LOOKAROUND = Math.max(...ALL_WRAP_MARKERS.map((marker) => marker.length));

/**
 * One toolbar inline format applied to a selection *and its surroundings*: the
 * replacement text, and how far the edit range has to grow on each side to
 * cover markers the selection left out.
 *
 * WHY THE SELECTION ALONE IS NOT ENOUGH. `toggleInlineWrap` decides from the
 * selected text, and the most ordinary way to undo a format does not select the
 * markers: double-click the word. On `~~word~~` that selects `word`, the toggle
 * sees no tildes, and wrapping is all it can do — leaving `~~~~word~~~~`, which
 * at the start of a line is a four-tilde code fence whose info string is
 * `word~~~~`. Nothing closes it, so the rest of the document renders as code.
 * The same gesture answered `*word*` with `**word**`: the user asked to stop
 * italicising and the text turned bold instead.
 *
 * The decision lives here rather than in the editor component so that it is
 * reachable from a test that can spell the whole gesture — buffer, selection,
 * click — instead of asserting on how the component is written.
 */
export function inlineWrapEdit(
	id: InlineWrapToolId,
	before: string,
	selected: string,
	after: string,
): { reach: number; text: string } {
	const reach = ownMarkerReach(id, before, after);
	const text = toggleInlineWrap(
		id,
		before.slice(before.length - reach) + selected + after.slice(0, reach),
	);
	return { reach, text };
}

/**
 * Where `text` ends when it is written starting at `startColumn`, as a line
 * offset from the start and a column — what the caller needs to leave exactly
 * the written text selected.
 *
 * WHY THE EDIT HAS TO SAY. An `executeEdits` with no end-cursor state leaves
 * the old selection to be adjusted against the new text, and once the replaced
 * range is wider than the selection was, that adjustment is nonsense: taking
 * `~~word~~` down to `word` clamps a selection of columns 3-7 to columns 3-5,
 * which is `rd`. The next click on the same button then wraps `rd` and writes
 * `wo~~rd~~`. Reported from a build, not caught here: the toggle itself is a
 * pure function and cannot see a selection, which is the half of this feature
 * only the editor holds.
 *
 * Selecting what was written keeps the two directions symmetric — strip and
 * the word stays selected, wrap and the marked-up word does — so a second
 * click on the same button is always the inverse of the first.
 */
export function inlineWrapSelectionEnd(
	startColumn: number,
	text: string,
): { lineOffset: number; column: number } {
	const lines = text.split('\n');
	const lineOffset = lines.length - 1;
	return {
		lineOffset,
		// Columns are 1-based, so the column after a line of length n is n + 1.
		column: lineOffset === 0 ? startColumn + text.length : lines[lineOffset].length + 1,
	};
}

const knownToolbarIds = new Set(DEFAULT_EDITOR_TOOLBAR_ORDER);

export function normalizeEditorToolbarOrder(order: readonly string[] | null | undefined): string[] {
	const normalized: string[] = [];

	for (const id of order ?? []) {
		if (!knownToolbarIds.has(id) || normalized.includes(id)) continue;
		normalized.push(id);
	}

	for (const id of DEFAULT_EDITOR_TOOLBAR_ORDER) {
		if (!normalized.includes(id)) normalized.push(id);
	}

	return normalized;
}

export function normalizeEditorToolbarHidden(hidden: readonly string[] | null | undefined): string[] {
	const normalized: string[] = [];

	for (const id of hidden ?? []) {
		if (!knownToolbarIds.has(id) || normalized.includes(id)) continue;
		normalized.push(id);
	}

	return normalized;
}

export function getEditorToolbarTools(order: readonly string[] | null | undefined): EditorToolbarTool[] {
	const byId = new Map(EDITOR_TOOLBAR_TOOLS.map((tool) => [tool.id, tool]));
	return normalizeEditorToolbarOrder(order).map((id) => byId.get(id)!).filter(Boolean);
}

export function getVisibleEditorToolbarTools(
	order: readonly string[] | null | undefined,
	hidden: readonly string[] | null | undefined,
): EditorToolbarTool[] {
	const hiddenIds = new Set(normalizeEditorToolbarHidden(hidden));
	return getEditorToolbarTools(order).filter((tool) => !hiddenIds.has(tool.id));
}

export function getEditorToolbarReorderMove(
	order: readonly string[],
	draggedId: string,
	targetId: string,
): EditorToolbarMove | null {
	const normalized = normalizeEditorToolbarOrder(order);
	const fromIndex = normalized.indexOf(draggedId);
	const toIndex = normalized.indexOf(targetId);

	if (fromIndex === -1 || toIndex === -1 || fromIndex === toIndex) return null;
	return { fromIndex, toIndex };
}

export function getEditorToolbarAdjacentMove(
	order: readonly string[],
	id: string,
	direction: 'up' | 'down',
): EditorToolbarMove | null {
	const normalized = normalizeEditorToolbarOrder(order);
	const fromIndex = normalized.indexOf(id);
	if (fromIndex === -1) return null;

	const toIndex = direction === 'up' ? fromIndex - 1 : fromIndex + 1;
	if (toIndex < 0 || toIndex >= normalized.length) return null;

	return { fromIndex, toIndex };
}

export function applyEditorToolbarMove(order: readonly string[], move: EditorToolbarMove): string[] {
	const normalized = normalizeEditorToolbarOrder(order);
	if (
		move.fromIndex < 0 ||
		move.fromIndex >= normalized.length ||
		move.toIndex < 0 ||
		move.toIndex >= normalized.length ||
		move.fromIndex === move.toIndex
	) {
		return normalized;
	}

	const next = [...normalized];
	const [moved] = next.splice(move.fromIndex, 1);
	next.splice(move.toIndex, 0, moved);
	return next;
}
