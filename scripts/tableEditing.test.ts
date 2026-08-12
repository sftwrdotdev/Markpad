import assert from 'node:assert/strict';
import test from 'node:test';

import {
	displayWidth,
	formatTable,
	parseTableAt,
	tableOperation,
	tableStep,
	type TableDocument,
	type TableEdit,
	type TableOperation,
} from '../src/lib/utils/tableEditing.js';
import { runEditorHandler } from './keymapHarness.js';

/*
 * Issue #604's first item: add a row or a column at the edge of a table without
 * a context menu, and leave the pipes lined up afterwards.
 *
 * WHAT IS RUN AND WHAT IS ONLY READ
 *
 * Everything below the first heading is the REAL `src/lib/utils/tableEditing.ts`
 * being called: parsing, the alignment arithmetic, where the caret lands. None
 * of it is a source-shape assertion, because none of it needs a browser.
 *
 * The last section runs the two Tab handlers out of `Editor.svelte` against a
 * stub editor (`runEditorHandler` in ./keymapHarness.ts), so what is asserted is
 * the edit they really produce — including the one case where the right answer
 * is to move the caret and make no edit at all.
 *
 * NOT ESTABLISHED HERE: that Monaco delivers Tab and Shift+Tab at runtime. The
 * `when` clauses that decide it are pinned in `listContinuation.test.ts`, which
 * owns the other half of the same two keys.
 */

/** A document from its lines — the shape Monaco's model already has. */
function doc(...lines: string[]): TableDocument {
	return { getLineCount: () => lines.length, getLineContent: (line) => lines[line - 1] };
}

/** The lines an edit produces, so an assertion can be written as the table itself. */
function linesOf(edit: TableEdit | null): string[] {
	assert.ok(edit, 'the edit was refused');
	return [...edit.lines];
}

/** The caret an edit lands on, and the character it lands ON. */
function caretOf(edit: TableEdit | null): { at: [number, number]; on: string } {
	assert.ok(edit, 'the edit was refused');
	const line = edit.lines[edit.caretLine - edit.startLine];
	return { at: [edit.caretLine, edit.caretColumn], on: line.slice(edit.caretColumn - 1, edit.caretColumn) };
}

/** The table Markpad's own Insert Table command writes, once. */
const INSERTED = [
	'| Header | Header | Header |',
	'| --- | --- | --- |',
	'| Cell | Cell | Cell |',
	'| Cell | Cell | Cell |',
];

// ------------------------------------------------------------------ parsing

test('a table is a block of pipe rows whose second line is a delimiter row', () => {
	const table = parseTableAt(doc(...INSERTED), 3);
	assert.ok(table);
	assert.deepEqual(
		{ start: table.startLine, end: table.endLine, alignments: table.alignments, rows: table.rows },
		{
			start: 1,
			end: 4,
			alignments: ['none', 'none', 'none'],
			// The delimiter row is not a row: three lines of content, not four.
			rows: [
				['Header', 'Header', 'Header'],
				['Cell', 'Cell', 'Cell'],
				['Cell', 'Cell', 'Cell'],
			],
		},
	);
});

test('the alignment markers are read, not just tolerated', () => {
	const table = parseTableAt(doc('| a | b | c | d |', '| :-- | --: | :-: | --- |', '| 1 | 2 | 3 | 4 |'), 1);
	assert.deepEqual(table?.alignments, ['left', 'right', 'center', 'none']);
});

test('what is not a table is not a table', () => {
	// A pipe in prose is a pipe in prose. The delimiter row is what makes a table
	// a table in GFM, and it is what makes one here.
	assert.equal(parseTableAt(doc('plain text', 'more text'), 1), null);
	assert.equal(parseTableAt(doc('| a | b |', '| c | d |'), 1), null, 'no delimiter row');
	assert.equal(parseTableAt(doc('| a | b |'), 1), null, 'a header on its own');
	assert.equal(parseTableAt(doc('| --- |', '| a |'), 1), null, 'the delimiter cannot be the header');
	// Without the outer pipe this module does not claim the block — the stated
	// limitation, asserted so that lifting it is a decision rather than a
	// surprise.
	assert.equal(parseTableAt(doc('a | b', '--- | ---', '1 | 2'), 1), null);
});

test('the block stops where the prefix changes', () => {
	// An indented table and the one above it are two tables, not one seven-line
	// one whose columns would be merged by the next re-alignment.
	const table = parseTableAt(doc('| a |', '| - |', '| 1 |', '  | b |', '  | - |'), 2);
	assert.deepEqual({ start: table?.startLine, end: table?.endLine }, { start: 1, end: 3 });

	// …and a quoted table keeps its quote on every line it writes back.
	const quoted = tableOperation(doc('> | a | b |', '> | - | - |', '> | 1 | 2 |'), 3, 5, 'insert-column');
	assert.deepEqual(linesOf(quoted), [
		'> | a   |     | b   |',
		'> | --- | --- | --- |',
		'> | 1   |     | 2   |',
	]);
});

test('an escaped pipe stays inside its cell', () => {
	// `\|` is GFM's one escape inside a table. Splitting there would turn one cell
	// into two and shift every cell after it by one.
	const table = parseTableAt(doc('| a \\| b | c |', '| --- | --- |'), 1);
	assert.deepEqual(table?.rows, [['a \\| b', 'c']]);
	assert.equal(table?.alignments.length, 2);
});

// -------------------------------------------------------------- re-alignment

test('re-alignment sizes every column to its widest cell', () => {
	const table = parseTableAt(doc('| a | bb |', '| --- | --- |', '| cccc | d |'), 1)!;
	assert.deepEqual(formatTable(table), [
		'| a    | bb  |',
		'| ---- | --- |',
		'| cccc | d   |',
	]);
});

test('no column is drawn narrower than three, because `:-:` is three wide', () => {
	const table = parseTableAt(doc('| a | b |', '| :-: | --: |', '| 1 | 2 |'), 1)!;
	assert.deepEqual(formatTable(table), [
		'| a   | b   |',
		'| :-: | --: |',
		'| 1   | 2   |',
	]);
});

test('the alignment markers survive a re-alignment at any width', () => {
	// The failure this rules out is a re-alignment that writes `---` everywhere
	// and silently un-aligns every column the user set.
	const table = parseTableAt(
		doc('| left | right | centre | plain |', '| :- | -: | :-: | - |', '| 1 | 2 | 3 | 4 |'),
		1,
	)!;
	// Each marker is stretched to its own column's width and keeps its colons:
	// `left` is four wide, `centre` six, and the plain column stays plain.
	assert.deepEqual(formatTable(table)[1], '| :--- | ----: | :----: | ----- |');
});

test('a table of empty cells still renders as a table', () => {
	const table = parseTableAt(doc('|  |  |', '| --- | :-: |', '|  |  |'), 1)!;
	assert.deepEqual(formatTable(table), [
		'|     |     |',
		'| --- | :-: |',
		'|     |     |',
	]);
});

// ------------------------------------------------------- CJK and other widths

test('a CJK character counts as the two columns it draws', () => {
	assert.equal(displayWidth('abc'), 3);
	assert.equal(displayWidth('名前'), 4);
	assert.equal(displayWidth('한글'), 4);
	assert.equal(displayWidth('値 x'), 4);
	// Combining marks draw on the character before them and take no column.
	assert.equal(displayWidth('é'), 1);
});

test('a table with CJK cells lines up on screen, not just in the model', () => {
	// THE POINT OF `displayWidth`. By character count `名前` is 2 and `Name` is 4,
	// so a character-counting pad would make the CJK column the NARROWER of the
	// two and the pipes would step left on every CJK row in a monospace font.
	const table = parseTableAt(doc('| 名前 | 値 |', '| --- | --- |', '| Name | 12345 |'), 1)!;
	assert.deepEqual(formatTable(table), [
		'| 名前 | 値    |',
		'| ---- | ----- |',
		'| Name | 12345 |',
	]);

	// The claim above, measured rather than eyeballed: every rendered line is the
	// same number of COLUMNS wide, which is what a reader sees.
	const widths = new Set(formatTable(table).map(displayWidth));
	assert.equal(widths.size, 1, `rendered widths differ: ${[...widths].join(', ')}`);
});

test('a ZWJ emoji sequence is the known limitation, and this is what it does', () => {
	// Recorded, not endorsed. `displayWidth` counts CODE POINTS, so a family
	// emoji — one glyph, drawn two columns wide in most fonts — is counted as its
	// four faces and three joiners and the cell is over-padded. Nothing breaks:
	// the table is still valid Markdown and every other column is still right.
	// The fix is a grapheme segmenter, which nothing else here needs.
	assert.equal(displayWidth('😀'), 2, 'a single emoji is two columns');
	assert.equal(displayWidth('👨‍👩‍👧'), 6, 'a ZWJ family is counted as its parts');
});

// ------------------------------------------------------------- Tab and Shift+Tab

test('Tab in the middle of a table moves to the next cell', () => {
	const step = tableStep(doc(...INSERTED), 3, 3, false);
	assert.deepEqual(caretOf(step), { at: [3, 12], on: 'C' });
	// …and re-aligns on the way, which is the whole reason a move is an edit.
	assert.deepEqual(linesOf(step)[0], '| Header | Header | Header |');
	assert.deepEqual(linesOf(step)[1], '| ------ | ------ | ------ |');
});

test('Tab at the end of a row wraps to the first cell of the next one', () => {
	const step = tableStep(doc(...INSERTED), 3, 26, false);
	assert.deepEqual(caretOf(step)?.at, [4, 3]);
});

test('Tab in the LAST cell of the LAST row adds a row — the feature the issue asks for', () => {
	const step = tableStep(doc(...INSERTED), 4, 26, false);
	assert.deepEqual(linesOf(step), [
		'| Header | Header | Header |',
		'| ------ | ------ | ------ |',
		'| Cell   | Cell   | Cell   |',
		'| Cell   | Cell   | Cell   |',
		'|        |        |        |',
	]);
	// The caret lands in the new row's first cell, ready to type.
	assert.deepEqual(caretOf(step)?.at, [5, 3]);
	// The replaced range is the table as it WAS: four lines becoming five.
	assert.deepEqual([step?.startLine, step?.endLine], [1, 4]);
});

test('Tab in a table with no body rows yet adds the first one', () => {
	const step = tableStep(doc('| a | b |', '| --- | --- |'), 1, 20, false);
	assert.deepEqual(linesOf(step), ['| a   | b   |', '| --- | --- |', '|     |     |']);
	assert.deepEqual(caretOf(step)?.at, [3, 3]);
});

test('Shift+Tab moves back a cell, and back a row at the start of one', () => {
	assert.deepEqual(caretOf(tableStep(doc(...INSERTED), 3, 12, true))?.at, [3, 3]);
	// From the first cell of a body row, back to the last cell of the one above.
	assert.deepEqual(caretOf(tableStep(doc(...INSERTED), 4, 3, true))?.at, [3, 21]);
	// …and across the delimiter row into the header, which is not a row.
	assert.deepEqual(caretOf(tableStep(doc(...INSERTED), 3, 3, true))?.at, [1, 21]);
});

test('Shift+Tab in the very first cell stays there instead of leaving the table', () => {
	// There is no cell before the first one. Falling through to Monaco's outdent
	// would take an indent level off the header row and break the table the user
	// was navigating — so this returns an edit that keeps the caret put.
	const step = tableStep(doc(...INSERTED), 1, 3, true);
	assert.deepEqual(caretOf(step)?.at, [1, 3]);
	assert.deepEqual(linesOf(step)[0], '| Header | Header | Header |');
});

test('the delimiter row is a place the caret can be, and both keys leave it sensibly', () => {
	assert.deepEqual(caretOf(tableStep(doc(...INSERTED), 2, 3, false))?.at, [3, 3], 'Tab: into the body');
	assert.deepEqual(caretOf(tableStep(doc(...INSERTED), 2, 3, true))?.at, [1, 21], 'Shift+Tab: back to the header');
});

test('Tab outside a table is not this feature at all', () => {
	const notATable = doc('plain text', '- a list item', '', '| a | b |');
	for (const line of [1, 2, 3, 4]) {
		assert.equal(tableStep(notATable, line, 1, false), null, `line ${line}`);
		assert.equal(tableStep(notATable, line, 1, true), null, `line ${line}`);
	}
});

// -------------------------------------------------------- rows and columns

/** `operation` at line/column of a fresh copy of Markpad's own inserted table. */
function operate(operation: TableOperation, line: number, column: number) {
	return tableOperation(doc(...INSERTED), line, column, operation);
}

test('a column is inserted to the right of the caret, delimiter row included', () => {
	const edit = operate('insert-column', 3, 3);
	assert.deepEqual(linesOf(edit), [
		'| Header |     | Header | Header |',
		'| ------ | --- | ------ | ------ |',
		'| Cell   |     | Cell   | Cell   |',
		'| Cell   |     | Cell   | Cell   |',
	]);
	// The caret goes into the cell that was just made, in the row it was in.
	assert.deepEqual(caretOf(edit)?.at, [3, 12]);
});

test('the delimiter row keeps as many cells as the rows, whichever way the count moves', () => {
	// The defect this rules out: a column added to the rows and not to the
	// delimiter row, which is a table that stops being a table.
	const cells = (line: string) => line.split('|').length;
	for (const edit of [operate('insert-column', 1, 3), operate('delete-column', 1, 3)]) {
		const lines = linesOf(edit);
		assert.equal(new Set(lines.map(cells)).size, 1, lines.join('\n'));
	}
});

test('an alignment marker travels with its column when a neighbour is inserted', () => {
	// Insert in front of a right-aligned column and the right-alignment must
	// still be on the right-aligned column, not on the empty one.
	const edit = tableOperation(doc('| a | b |', '| :-- | --: |', '| 1 | 2 |'), 1, 3, 'insert-column');
	assert.deepEqual(linesOf(edit), [
		'| a   |     | b   |',
		'| :-- | --- | --: |',
		'| 1   |     | 2   |',
	]);
});

test('deleting a column takes its alignment with it', () => {
	const edit = tableOperation(doc('| a | b | c |', '| :-- | --: | :-: |', '| 1 | 2 | 3 |'), 1, 8, 'delete-column');
	assert.deepEqual(linesOf(edit), ['| a   | c   |', '| :-- | :-: |', '| 1   | 3   |']);
});

test('a row is inserted below the caret, and below the delimiter from the header', () => {
	assert.deepEqual(linesOf(operate('insert-row', 3, 3)), [
		'| Header | Header | Header |',
		'| ------ | ------ | ------ |',
		'| Cell   | Cell   | Cell   |',
		'|        |        |        |',
		'| Cell   | Cell   | Cell   |',
	]);
	// "Below the header" is the top of the body, not between the header and its
	// own delimiter row.
	assert.deepEqual(linesOf(operate('insert-row', 1, 3))[2], '|        |        |        |');
	assert.deepEqual(caretOf(operate('insert-row', 1, 3))?.at, [3, 3]);
});

test('a row is deleted and the caret stays in the table', () => {
	assert.deepEqual(linesOf(operate('delete-row', 3, 3)), [
		'| Header | Header | Header |',
		'| ------ | ------ | ------ |',
		'| Cell   | Cell   | Cell   |',
	]);
	// The caret keeps its COLUMN and falls onto the row that took the deleted
	// one's place — or onto the last row when there is none.
	assert.deepEqual(caretOf(operate('delete-row', 4, 12))?.at, [3, 12]);
});

// ---------------------------------------------------------------- the edges

test('the header row cannot be deleted', () => {
	// A table without a header does not parse, and neither does one whose
	// delimiter row has become the header. Both refuse rather than mangle.
	assert.equal(operate('delete-row', 1, 3), null, 'the header');
	assert.equal(operate('delete-row', 2, 3), null, 'the delimiter row');
});

test('the only body row can be deleted; the resulting empty table is still a table', () => {
	const single = doc('| a | b |', '| --- | --- |', '| 1 | 2 |');
	const edit = tableOperation(single, 3, 3, 'delete-row');
	assert.deepEqual(linesOf(edit), ['| a   | b   |', '| --- | --- |']);
	// And it parses back, which is the assertion that "still a table" is a claim
	// about the format rather than about the string.
	assert.ok(parseTableAt(doc(...linesOf(edit)), 1));
});

test('a table with no body rows at all refuses to lose one', () => {
	assert.equal(tableOperation(doc('| a | b |', '| --- | --- |'), 1, 3, 'delete-row'), null);
});

test('the only column cannot be deleted', () => {
	// One dimension down from the header rule: a table with no columns is not a
	// table, and the delimiter row would become a thematic break.
	const single = doc('| a |', '| --- |', '| 1 |');
	assert.equal(tableOperation(single, 1, 3, 'delete-column'), null);
	assert.equal(tableOperation(single, 3, 3, 'delete-column'), null);
	// Inserting into it still works, which is what makes the refusal above a
	// boundary rather than a dead table.
	assert.deepEqual(linesOf(tableOperation(single, 1, 3, 'insert-column')), [
		'| a   |     |',
		'| --- | --- |',
		'| 1   |     |',
	]);
});

test('deleting the last column leaves the caret on a column that exists', () => {
	const edit = tableOperation(doc('| a | b |', '| --- | --- |', '| 1 | 2 |'), 3, 9, 'delete-column');
	assert.deepEqual(linesOf(edit), ['| a   |', '| --- |', '| 1   |']);
	assert.deepEqual(caretOf(edit)?.at, [3, 3]);
});

test('a ragged row keeps its text rather than being truncated to the header', () => {
	// GFM would render the extra cell away. Deleting it here would be the feature
	// eating a word the user typed, so the table grows to fit instead.
	const edit = tableOperation(doc('| a | b |', '| --- | --- |', '| 1 | 2 | 3 |'), 3, 3, 'insert-row');
	assert.deepEqual(linesOf(edit), [
		'| a   | b   |     |',
		'| --- | --- | --- |',
		'| 1   | 2   | 3   |',
		'|     |     |     |',
	]);
});

test('a table operation outside a table does nothing', () => {
	const prose = doc('plain text', '', '- item');
	for (const operation of ['insert-row', 'delete-row', 'insert-column', 'delete-column'] as const) {
		assert.equal(tableOperation(prose, 1, 1, operation), null, operation);
	}
});

// --------------------------------------------- the handlers, actually run

/**
 * The two dispatchers and everything they route through, entry point last.
 *
 * Naming the collaborators is what keeps this honest: a stub `stepTableCell`
 * would let a Tab handler that had stopped looking at tables pass.
 */
const TAB = ['soleCaret', 'applyTableEdit', 'stepTableCell', 'handleTabKey'];
const SHIFT_TAB = ['soleCaret', 'applyTableEdit', 'stepTableCell', 'handleShiftTabKey'];

test('Tab in a table writes the re-aligned table in one edit, and no plain Tab', () => {
	const run = runEditorHandler(TAB, { lines: [...INSERTED], selections: [[4, 26, 4, 26]] });

	assert.deepEqual(run.triggers, [], 'the plain Tab must not fire as well');
	assert.equal(run.undoStops, 1, 'growing the table is its own undo step');
	assert.deepEqual(run.edits, [
		{
			// The whole table, replaced — because every column may have changed width.
			range: [1, 1, 4, 23],
			text: [
				'| Header | Header | Header |',
				'| ------ | ------ | ------ |',
				'| Cell   | Cell   | Cell   |',
				'| Cell   | Cell   | Cell   |',
				'|        |        |        |',
			].join('\n'),
			cursor: [5, 3, 5, 3],
		},
	]);
});

test("the line break between rows is the document's, not a hard-coded \\n", () => {
	// The CRLF class of defect this repo has been bitten by before (#148): a
	// handler that writes '\n' into a CRLF document leaves mixed lines behind and
	// nothing downstream reports it.
	const run = runEditorHandler(TAB, {
		lines: [...INSERTED],
		selections: [[4, 26, 4, 26]],
		eol: '\r\n',
	});
	assert.ok(run.edits[0].text.includes('\r\n'), run.edits[0].text);
	assert.ok(!/[^\r]\n/.test(run.edits[0].text), 'a bare \\n slipped into a CRLF document');
});

test('Shift+Tab in the first cell moves the caret and writes nothing', () => {
	// An ALREADY ALIGNED table, so the "edit" would be the same text it replaces.
	// Executing it anyway would push an undo step that undoes nothing and mark the
	// document dirty for a keystroke that changed no character.
	const run = runEditorHandler(SHIFT_TAB, {
		lines: ['| a   | b   |', '| --- | --- |', '| 1   | 2   |'],
		selections: [[1, 3, 1, 3]],
	});
	assert.deepEqual(run.edits, []);
	assert.deepEqual(run.triggers, [], 'and it must not fall through to outdent either');
	assert.equal(run.undoStops, 0);
	assert.deepEqual(run.selections, [[1, 3, 1, 3]]);
});

test('Shift+Tab outside a table is Monaco’s own outdent', () => {
	for (const line of ['plain text', '  - a nested list item', '']) {
		const run = runEditorHandler(SHIFT_TAB, { lines: [line], selections: [[1, 1, 1, 1]] });
		assert.deepEqual(run.triggers, ['outdent'], JSON.stringify(line));
		assert.deepEqual(run.edits, [], JSON.stringify(line));
	}
});

test('Tab on a list item is still the list’s Tab, and Tab in prose is still a Tab', () => {
	// The dispatch order this feature had to fit into: table, then list, then the
	// key's own meaning. #636 owns the middle branch and must not have moved.
	const list = runEditorHandler(TAB, { lines: ['- item'], selections: [[1, 3, 1, 3]] });
	assert.deepEqual(list.triggers, ['editor.action.indentLines']);
	assert.deepEqual(list.edits, []);

	const prose = runEditorHandler(TAB, { lines: ['plain text'], selections: [[1, 1, 1, 1]] });
	assert.deepEqual(prose.triggers, ['tab']);
});

test('a selection, or a second caret, gets the ordinary key', () => {
	// One edit at the primary selection would silently discard what the other
	// carets were about to do — and Monaco's own Tab already indents every line
	// of a multi-line selection.
	const spanning = runEditorHandler(TAB, { lines: [...INSERTED], selections: [[3, 3, 3, 8]] });
	assert.deepEqual(spanning.edits, []);
	assert.deepEqual(spanning.triggers, ['tab']);

	const multi = runEditorHandler(SHIFT_TAB, {
		lines: [...INSERTED],
		selections: [
			[3, 3, 3, 3],
			[4, 3, 4, 3],
		],
	});
	assert.deepEqual(multi.edits, []);
	assert.deepEqual(multi.triggers, ['outdent']);
});
