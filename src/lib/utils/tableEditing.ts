/**
 * "Given a Markdown table and where the caret is, what should the table become" —
 * the whole of issue #604's first item, with no editor in it.
 *
 * WHY THIS IS A SEPARATE MODULE
 *
 * The interesting part of editing a table is arithmetic on strings: which cell
 * the caret is in, which cell it should move to, which cells exist after a
 * column is added, and — the part that is actually most of the work — how wide
 * every column has to be so the pipes line up again afterwards. The
 * uninteresting part is asking Monaco for the lines and handing it back an edit.
 *
 * Keeping the first part here means `node --test` runs it: every case in
 * `scripts/tableEditing.test.ts` is the real function rather than a description
 * of it, and `Editor.svelte` is left with a keybinding, a `when` clause and one
 * `executeEdits`. It is the shape `utils/listEditing.ts` already has for the
 * other half of #604, deliberately.
 *
 * WHAT IS NOT SUPPORTED, STATED RATHER THAN DISCOVERED
 *
 * - A table row must start with `|`. GFM lets the outer pipes be omitted, so
 *   `a | b` over a delimiter line is a table this module does not see. Requiring
 *   the leading pipe is what keeps ordinary prose that happens to contain a pipe
 *   (`ls | grep`, `A | B` in a sentence) from being silently re-flowed into a
 *   table. Every table Markpad itself writes has the outer pipes.
 * - Cells are re-flowed to one line each. A table row is a single line in GFM
 *   anyway, so there is no multi-line cell to lose.
 */

/**
 * The two things this module asks of a document, which is exactly the shape
 * Monaco's `ITextModel` already has — so `Editor.svelte` passes the model itself
 * and a test passes three lines of object literal. Neither side adapts.
 *
 * Taking a reader rather than `string[]` is not ceremony: a table is a handful
 * of lines and this runs on every Tab keystroke, so scanning outward from the
 * caret is O(table) where `getLinesContent()` would be O(document).
 */
export type TableDocument = {
	getLineCount(): number;
	getLineContent(line: number): string;
};

/** What a column's delimiter cell says about its contents. */
export type Alignment = 'none' | 'left' | 'right' | 'center';

/** A table, taken apart into the things an edit has to decide about separately. */
export type Table = {
	/** 1-based line of the header row. */
	readonly startLine: number;
	/** 1-based line of the last row — the range an edit replaces ends here. */
	readonly endLine: number;
	/** Indentation and any block-quote markers, identical on every row. */
	readonly prefix: string;
	/**
	 * Row 0 is the header; rows 1.. are the body. The delimiter row is NOT here —
	 * it is `alignments`, because it is not a row of content and every operation
	 * that touches columns has to touch it too.
	 */
	readonly rows: readonly (readonly string[])[];
	/** One per column, so `alignments.length` is the table's column count. */
	readonly alignments: readonly Alignment[];
};

/** A replacement for one line range, and where the caret goes in it. */
export type TableEdit = {
	/** 1-based inclusive line range to replace — the table as it is now. */
	readonly startLine: number;
	readonly endLine: number;
	/** The table as it should be: re-aligned, always. */
	readonly lines: readonly string[];
	/** 1-based, and pointing at the first character of a cell's content. */
	readonly caretLine: number;
	readonly caretColumn: number;
};

/** What the `Mod+K` chords ask for. */
export type TableOperation = 'insert-row' | 'delete-row' | 'insert-column' | 'delete-column';

/**
 * A table row: indentation, optional block-quote markers, then a pipe.
 *
 * The prefix is captured rather than skipped because it has to be written back
 * on every line — a table inside a block quote stays inside it.
 */
const TABLE_ROW = /^([ \t]*(?:>[ \t]*)*)\|(.*)$/;

/** A delimiter cell: dashes, optionally colon-anchored at either end. */
const DELIMITER_CELL = /^\s*(:?)-+(:?)\s*$/;

/**
 * The narrowest a column may be rendered.
 *
 * Three, because `:-:` is three characters and a centred column's delimiter has
 * to fit inside the column it delimits. Prettier's Markdown printer picks the
 * same floor for the same reason.
 */
const MIN_WIDTH = 3;

/**
 * Characters that take two columns in a monospace font.
 *
 * The CJK blocks plus Hangul and the fullwidth forms — the East Asian
 * Wide/Fullwidth set as every terminal and monospace font implements it — and
 * emoji, which those fonts also draw double-width. JavaScript's regex engine
 * exposes no `East_Asian_Width` property, so the ranges are written out; they
 * are the ones `wcwidth` uses.
 */
const WIDE =
	/[\u1100-\u115F\u2E80-\u303E\u3041-\u33FF\u3400-\u4DBF\u4E00-\u9FFF\uA000-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE10-\uFE19\uFE30-\uFE6F\uFF00-\uFF60\uFFE0-\uFFE6]|[\u{20000}-\u{3FFFD}]|\p{Extended_Pictographic}/u;

/** Characters that take none: combining marks, joiners, variation selectors. */
const ZERO_WIDTH = /[\p{M}\u200B-\u200F\u2060\uFE00-\uFE0F\uFEFF]/u;

/**
 * How many columns `text` occupies in a monospace font.
 *
 * WHY NOT `text.length`. `| 名前 | 値 |` has cells of 2 and 1 characters but of 4
 * and 2 columns; padding by character count lines the pipes up in the model and
 * nowhere on screen, which is the whole complaint that makes re-alignment worth
 * doing at all. The editor's font is monospace, so columns are the right unit.
 *
 * KNOWN LIMITATION, stated rather than hidden: this counts CODE POINTS. A ZWJ
 * emoji sequence (a family emoji, a flag) draws as one glyph in most fonts but
 * is counted here as its parts, so a cell containing one is over-padded by a few
 * columns. Nothing is corrupted by that — the table is still valid Markdown and
 * still parses — it is only less pretty, and the fix is a grapheme segmenter
 * this module does not otherwise need.
 */
export function displayWidth(text: string): number {
	let width = 0;
	for (const char of text) {
		if (ZERO_WIDTH.test(char)) continue;
		width += WIDE.test(char) ? 2 : 1;
	}
	return width;
}

/**
 * The cells of one row, in source order, trimmed.
 *
 * `\|` is an escaped pipe INSIDE a cell — GFM's only escape in a table — so the
 * scan steps over it rather than splitting there, and keeps the backslash, so
 * that writing the cell back out round-trips rather than re-escaping.
 *
 * `rest` is everything after the leading pipe. A trailing pipe is optional in
 * GFM and does not open a final empty cell, so the empty segment it leaves is
 * dropped — unless it is the only one, which is how an empty row keeps a cell.
 */
function splitCells(rest: string): string[] {
	const cells: string[] = [];
	let cell = '';
	for (let i = 0; i < rest.length; i++) {
		if (rest[i] === '\\' && i + 1 < rest.length) {
			cell += rest[i] + rest[i + 1];
			i++;
		} else if (rest[i] === '|') {
			cells.push(cell.trim());
			cell = '';
		} else {
			cell += rest[i];
		}
	}
	if (cell.trim() !== '' || cells.length === 0) cells.push(cell.trim());
	return cells;
}

/** The alignment `cell` declares, or null when it is not a delimiter cell at all. */
function alignmentOf(cell: string): Alignment | null {
	const match = DELIMITER_CELL.exec(cell);
	if (!match) return null;
	if (match[1] && match[2]) return 'center';
	if (match[1]) return 'left';
	if (match[2]) return 'right';
	return 'none';
}

/** `line` split into prefix and cells, or null when it is not a table row. */
function rowOf(line: string): { prefix: string; cells: string[] } | null {
	const match = TABLE_ROW.exec(line);
	return match ? { prefix: match[1], cells: splitCells(match[2]) } : null;
}

/**
 * The table the caret is inside, or null.
 *
 * The block is grown outward from `line` over rows sharing the SAME prefix — an
 * indented table and a quoted one are two things — and is only a table when its
 * second line is a delimiter row, which is exactly GFM's own rule.
 *
 * Rows are padded to the widest row rather than truncated to the header. A row
 * with an extra cell is a typo either way, and dropping the text in it would be
 * this feature silently eating a word.
 */
export function parseTableAt(doc: TableDocument, line: number): Table | null {
	if (line < 1 || line > doc.getLineCount()) return null;
	const here = rowOf(doc.getLineContent(line));
	if (!here) return null;

	let start = line;
	while (start > 1) {
		const above = rowOf(doc.getLineContent(start - 1));
		if (!above || above.prefix !== here.prefix) break;
		start--;
	}
	let end = line;
	while (end < doc.getLineCount()) {
		const below = rowOf(doc.getLineContent(end + 1));
		if (!below || below.prefix !== here.prefix) break;
		end++;
	}

	if (end < start + 1) return null;
	const delimiter = rowOf(doc.getLineContent(start + 1))!.cells.map(alignmentOf);
	if (delimiter.some((alignment) => alignment === null)) return null;

	const rows: string[][] = [];
	for (let n = start; n <= end; n++) {
		if (n !== start + 1) rows.push(rowOf(doc.getLineContent(n))!.cells);
	}

	const columns = Math.max(delimiter.length, ...rows.map((row) => row.length));
	return {
		startLine: start,
		endLine: end,
		prefix: here.prefix,
		rows: rows.map((row) => Array.from({ length: columns }, (_, i) => row[i] ?? '')),
		alignments: Array.from({ length: columns }, (_, i) => delimiter[i] ?? 'none'),
	};
}

/** The width each column is rendered at: its widest cell, but never below `MIN_WIDTH`. */
function columnWidths(table: Table): number[] {
	return table.alignments.map((_, i) =>
		Math.max(MIN_WIDTH, ...table.rows.map((row) => displayWidth(row[i] ?? ''))),
	);
}

/** `cell`, padded on the right to `width` columns. */
function pad(cell: string, width: number): string {
	return cell + ' '.repeat(Math.max(0, width - displayWidth(cell)));
}

/**
 * The delimiter cell for a column of `width`, keeping whichever colons it had.
 *
 * The markers travel with the column, which is the point: adding a column in
 * front of a right-aligned one must not turn it into a left-aligned one, and the
 * delimiter row must always come out with exactly as many cells as the rows do.
 */
function delimiterFor(alignment: Alignment, width: number): string {
	if (alignment === 'center') return `:${'-'.repeat(width - 2)}:`;
	if (alignment === 'left') return `:${'-'.repeat(width - 1)}`;
	if (alignment === 'right') return `${'-'.repeat(width - 1)}:`;
	return '-'.repeat(width);
}

/**
 * The table, written back out with every pipe aligned.
 *
 * Cell text is left-justified in its column whatever the column's alignment
 * says. The alignment is a rendering instruction for the preview; expressing it
 * in the source too would push a right-aligned column's text away from the pipe
 * that starts it, which is harder to read as source — the only thing this
 * function is for.
 */
export function formatTable(table: Table): string[] {
	const widths = columnWidths(table);
	const render = (cells: readonly string[]) =>
		`${table.prefix}| ${cells.map((cell, i) => pad(cell, widths[i])).join(' | ')} |`;

	return [
		render(table.rows[0]),
		`${table.prefix}| ${table.alignments.map((a, i) => delimiterFor(a, widths[i])).join(' | ')} |`,
		...table.rows.slice(1).map(render),
	];
}

/**
 * Which line row `index` lands on, counting the delimiter row that sits between
 * the header and the body and is not a row.
 */
function lineOfRow(startLine: number, index: number): number {
	return startLine + (index === 0 ? 0 : index + 1);
}

/** The table as an edit that re-aligns it and puts the caret in cell (`row`, `cell`). */
function editAt(table: Table, row: number, cell: number): TableEdit {
	const widths = columnWidths(table);
	// Each cell occupies `width + 3` characters from the start of its content to
	// the start of the next one: the padding, the space, the pipe and the space.
	let caretColumn = table.prefix.length + 3;
	for (let i = 0; i < cell; i++) caretColumn += widths[i] + 3;

	return {
		startLine: table.startLine,
		endLine: table.endLine,
		lines: formatTable(table),
		caretLine: lineOfRow(table.startLine, row),
		caretColumn,
	};
}

/**
 * Which cell of `line` column `column` is in.
 *
 * Counts unescaped pipes to the left of the caret rather than re-splitting: the
 * caret can sit anywhere, including inside the run of padding a previous
 * re-alignment left, and the pipes are what divide it. The leading pipe makes
 * the count one too high, hence starting at -1; a caret past the last pipe — at
 * the end of the line — clamps back onto the last cell.
 */
function cellAtColumn(line: string, column: number, cellCount: number): number {
	let cell = -1;
	for (let i = 0; i < column - 1 && i < line.length; i++) {
		if (line[i] === '\\') i++;
		else if (line[i] === '|') cell++;
	}
	return Math.min(Math.max(cell, 0), cellCount - 1);
}

/**
 * Where the caret is, in the table's own coordinates. `row` is -1 on the
 * delimiter row, which is a real place to have the caret and is not a row.
 */
function locate(table: Table, line: string, lineNumber: number, column: number) {
	const row =
		lineNumber === table.startLine
			? 0
			: lineNumber === table.startLine + 1
				? -1
				: lineNumber - table.startLine - 1;
	return { row, cell: cellAtColumn(line, column, table.alignments.length) };
}

/** `table` with one more empty row at `at`. */
function withRowAt(table: Table, at: number): Table {
	const rows = table.rows.map((row) => [...row]);
	rows.splice(at, 0, table.alignments.map(() => ''));
	return { ...table, rows };
}

/**
 * Tab (`back` false) and Shift+Tab (`back` true) inside a table, or null when
 * the caret is not in one — in which case the caller re-sends the key's ordinary
 * meaning.
 *
 * Tab past the last cell of the last row APPENDS A ROW and lands in its first
 * cell. That is the "add a row at the edge of the table" the issue asks for, and
 * it is what Typora, Obsidian, Notion and the VS Code Markdown extensions all
 * do — a table is the one place where Tab is already understood to grow the
 * thing you are inside.
 *
 * Shift+Tab out of the very first cell does NOT leave the table: it stays put.
 * There is no cell before the first one, and letting the key fall through would
 * outdent the header row instead, mangling the table the user was navigating.
 */
export function tableStep(
	doc: TableDocument,
	line: number,
	column: number,
	back: boolean,
): TableEdit | null {
	const table = parseTableAt(doc, line);
	if (!table) return null;

	const last = table.alignments.length - 1;
	const { row, cell } = locate(table, doc.getLineContent(line), line, column);

	// The delimiter row is between the header and the body, so that is where the
	// two keys go from it.
	if (row === -1) {
		if (back) return editAt(table, 0, last);
		return editAt(table.rows.length > 1 ? table : withRowAt(table, 1), 1, 0);
	}

	if (back) {
		if (cell > 0) return editAt(table, row, cell - 1);
		if (row > 0) return editAt(table, row - 1, last);
		return editAt(table, 0, 0);
	}

	if (cell < last) return editAt(table, row, cell + 1);
	if (row < table.rows.length - 1) return editAt(table, row + 1, 0);
	return editAt(withRowAt(table, table.rows.length), table.rows.length, 0);
}

/**
 * Add or remove a row or a column at the caret, re-aligning what is left.
 *
 * The two refusals are the two shapes that stop being a table:
 *
 * - the header row cannot be deleted (a table without a header does not parse,
 *   and neither does one whose delimiter row has become the header);
 * - the last column cannot be deleted, for the same reason one dimension down.
 *
 * Both return null and the caller does nothing. Nothing else here can fail: a
 * table with a header and no body rows is valid GFM, so deleting the only body
 * row is allowed and leaves an empty table rather than a broken one.
 */
export function tableOperation(
	doc: TableDocument,
	line: number,
	column: number,
	operation: TableOperation,
): TableEdit | null {
	const table = parseTableAt(doc, line);
	if (!table) return null;

	const { row, cell } = locate(table, doc.getLineContent(line), line, column);

	if (operation === 'insert-row') {
		// From the header or the delimiter row, "below" means the top of the body.
		const at = row <= 0 ? 1 : row + 1;
		return editAt(withRowAt(table, at), at, 0);
	}

	const rows = table.rows.map((r) => [...r]);
	const alignments = [...table.alignments];

	if (operation === 'delete-row') {
		if (row <= 0) return null;
		rows.splice(row, 1);
		return editAt({ ...table, rows, alignments }, Math.min(row, rows.length - 1), cell);
	}

	if (operation === 'insert-column') {
		for (const r of rows) r.splice(cell + 1, 0, '');
		alignments.splice(cell + 1, 0, 'none');
		return editAt({ ...table, rows, alignments }, Math.max(row, 0), cell + 1);
	}

	if (alignments.length === 1) return null;
	for (const r of rows) r.splice(cell, 1);
	alignments.splice(cell, 1);
	return editAt(
		{ ...table, rows, alignments },
		Math.max(row, 0),
		Math.min(cell, alignments.length - 1),
	);
}
