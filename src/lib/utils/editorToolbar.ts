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

const TASK_BOX = String.raw`\[[ xX]\]\s+`;

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
 */
const ANY_LIST_MARKER = new RegExp(String.raw`^(?:[-*+]|\d+\.)\s+(?:${TASK_BOX})?`);

const ANY_HEADING = /^#{1,6}\s+/;

type LineMarker = {
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
	'fmt-quote': { own: /^>\s+/, render: () => '> ', competing: null },
	// The list toggles exclude a following task box from `own` so that they add
	// their marker to a checklist item instead of un-toggling it and leaving the
	// box behind.
	'fmt-bullet-list': {
		own: new RegExp(String.raw`^[-*+]\s+(?!${TASK_BOX})`),
		render: () => '- ',
		competing: ANY_LIST_MARKER,
	},
	'fmt-numbered-list': {
		own: new RegExp(String.raw`^\d+\.\s+(?!${TASK_BOX})`),
		render: (itemIndex: number) => `${itemIndex}. `,
		competing: ANY_LIST_MARKER,
	},
	'fmt-checklist': {
		own: new RegExp(String.raw`^[-*+]\s+${TASK_BOX}`),
		render: () => '- [ ] ',
		competing: ANY_LIST_MARKER,
	},
	'fmt-heading-1': { own: /^#\s+/, render: () => '# ', competing: ANY_HEADING },
	'fmt-heading-2': { own: /^##\s+/, render: () => '## ', competing: ANY_HEADING },
	'fmt-heading-3': { own: /^###\s+/, render: () => '### ', competing: ANY_HEADING },
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
 */
export function toggleLineMarker(id: LineMarkerToolId, lines: readonly string[]): string[] {
	const marker = LINE_MARKERS[id];
	const contentLines = lines.filter((line) => line.trim().length > 0);
	const shouldRemove = contentLines.length > 0 && contentLines.every((line) => marker.own.test(line));

	let itemIndex = 1;
	return lines.map((line) => {
		if (!line.trim()) return line;
		if (shouldRemove) return line.replace(marker.own, '');
		const body = marker.competing ? line.replace(marker.competing, '') : line;
		return `${marker.render(itemIndex++)}${body}`;
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
