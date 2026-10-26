import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';

import type * as Monaco from 'monaco-editor';

import { blockEnter, parseListItem, shiftListItem } from '../src/lib/utils/listEditing.js';
import { displayWidth, formatTable, parseTableAt, type TableDocument, type TableEdit, tableOperation, type TableOperation, tableStep } from '../src/lib/utils/tableEditing.js';
import { isInFencedCode } from '../src/lib/utils/codeFence.js';
import { installShimDom, parseHtml } from './renderProtocolDom.ts';
import { headingLinkContext, headingQueryStart } from '../src/lib/utils/headingCompletion.js';
import { headingFoldRanges, headingSymbols } from '../src/lib/utils/headingSymbols.js';
import { DEFAULT_REFERENCE_STYLE, headingReference, preferredReferenceStyle } from '../src/lib/utils/headingReference.js';
import { findSeedFromSelection } from '../src/lib/utils/findSeed.js';
import { addFrontMatterListItems, getFrontMatterListItems, getMarkdownBodyWithoutFrontMatter, parseFrontMatter, removeFrontMatterListItem, updateFrontMatterField, updateFrontMatterListItem } from '../src/lib/utils/frontMatter.js';
import { getMarkdownLinkTarget, hasMarkdownLinkExtension, resolveMarkdownTargetPath } from '../src/lib/utils/markdownLinks.js';

/*
 * Issue #604's second item: Enter on a list item continues the list, Tab
 * changes its level, and Enter on an empty item ends the list.
 *
 * WHAT IS RUN AND WHAT IS ONLY READ
 *
 * The decision — "given this line and this caret, what should the next line
 * say" — is a pure function in `src/lib/utils/listEditing.ts` and is CALLED
 * here, once per shape of list item and block quote the app claims to
 * understand.
 *
 * The two handlers in `Editor.svelte` are lifted out of the component and run
 * against a stub editor, the same trick `keymapHarness.ts` uses, so what is
 * asserted is the edit they really produce rather than the shape of the source
 * that produces it.
 *
 * What NO test here can establish is that Monaco delivers these two keys at
 * runtime: keybinding resolution, the `when` clauses and the vim adapter all
 * live in a browser. What is pinned instead is the condition the app DECLARES —
 * the `when` expression is evaluated out of the source and read back — because
 * an Enter binding that forgets `!suggestWidgetVisible` breaks the completion
 * popup silently, and that is the one mistake this feature invites.
 */

// ------------------------------------------------------------- the pure part
describe('list continuation and nesting', () => {
	/** `blockEnter` at the end of `line`, which is where Enter is normally pressed. */
	function enterAtEnd(line: string) {
		return blockEnter(line, line.length + 1);
	}

	test('a bullet item continues with the same bullet character', () => {
		// Not normalised to `-`: CommonMark starts a NEW list when the bullet
		// character changes, so answering `* a` with `- ` would split the list.
		assert.deepEqual(enterAtEnd('- item'), { kind: 'continue', text: '- ' });
		assert.deepEqual(enterAtEnd('* item'), { kind: 'continue', text: '* ' });
		assert.deepEqual(enterAtEnd('+ item'), { kind: 'continue', text: '+ ' });
	});

	test('an ordered item counts up and keeps its delimiter', () => {
		assert.deepEqual(enterAtEnd('1. item'), { kind: 'continue', text: '2. ' });
		assert.deepEqual(enterAtEnd('3) item'), { kind: 'continue', text: '4) ' });
		assert.deepEqual(enterAtEnd('9. item'), { kind: 'continue', text: '10. ' });
		// `1.` and `1)` are two different lists, which is #451's defect one
		// delimiter over; the delimiter travels with the number.
		assert.deepEqual(enterAtEnd('1) item'), { kind: 'continue', text: '2) ' });
	});

	test('a task item continues with an UNCHECKED box, whatever the old one was', () => {
		assert.deepEqual(enterAtEnd('- [ ] item'), { kind: 'continue', text: '- [ ] ' });
		assert.deepEqual(enterAtEnd('- [x] item'), { kind: 'continue', text: '- [ ] ' });
		assert.deepEqual(enterAtEnd('- [X] item'), { kind: 'continue', text: '- [ ] ' });
		// The box belongs to the marker, not to the text: an ordered task list
		// keeps both halves.
		assert.deepEqual(enterAtEnd('1. [x] item'), { kind: 'continue', text: '2. [ ] ' });
	});

	test('indentation and block-quote prefixes are carried to the new item', () => {
		assert.deepEqual(enterAtEnd('  - nested'), { kind: 'continue', text: '  - ' });
		assert.deepEqual(enterAtEnd('\t\t1. deep'), { kind: 'continue', text: '\t\t2. ' });
		// A quoted list item is a list item — the rule #631 established for the
		// toolbar, applied to the key that writes the next one.
		assert.deepEqual(enterAtEnd('> - quoted'), { kind: 'continue', text: '> - ' });
		assert.deepEqual(enterAtEnd('  > > 2. deep quote'), { kind: 'continue', text: '  > > 3. ' });
	});

	test('a hand-aligned list stays aligned', () => {
		// The separator is copied rather than normalised to one space, so a list
		// someone lined up by hand is not silently un-aligned by pressing Enter.
		assert.deepEqual(enterAtEnd('-   item'), { kind: 'continue', text: '-   ' });
		assert.deepEqual(enterAtEnd('1.  item'), { kind: 'continue', text: '2.  ' });
	});

	test('Enter on an empty item ends the list', () => {
		// The behaviour the issue does not ask for and the feature is unusable
		// without: this is the only keystroke that gets a user OUT of a list.
		assert.deepEqual(enterAtEnd('- '), { kind: 'clear', line: '' });
		assert.deepEqual(enterAtEnd('1. '), { kind: 'clear', line: '' });
		assert.deepEqual(enterAtEnd('  * '), { kind: 'clear', line: '' });
		assert.deepEqual(enterAtEnd('- [ ] '), { kind: 'clear', line: '' });
		assert.deepEqual(enterAtEnd('- [x] '), { kind: 'clear', line: '' });
		// A box with nothing after it at all, which is what a user who has just
		// typed the checkbox is looking at.
		assert.deepEqual(enterAtEnd('- [ ]'), { kind: 'clear', line: '' });
		// An item that is only whitespace is empty too.
		assert.deepEqual(enterAtEnd('-    '), { kind: 'clear', line: '' });
	});

	test('ending a quoted list stays inside the quote', () => {
		assert.deepEqual(enterAtEnd('> - '), { kind: 'clear', line: '> ' });
		assert.deepEqual(enterAtEnd('> > 1. '), { kind: 'clear', line: '> > ' });
	});

	test('lines that are not list items are left to the ordinary Enter', () => {
		for (const line of [
			'',
			'plain text',
			'# heading',
			'    indented code',
			// A `>` inside a sentence is prose: the quote has to start the line.
			'a > b',
			'-> arrow',
			// A thematic break is a bullet character followed by more of them, never
			// by a space — which is what keeps `---` out.
			'---',
			'***',
			'___',
			// A bare marker with nothing after it, not even a space.
			'-',
			'1.',
		]) {
			assert.equal(enterAtEnd(line), null, JSON.stringify(line));
		}
	});

	test('a thematic break written with spaces keeps the plain Enter', () => {
		// CommonMark: when a line can be a thematic break or a list item, the break
		// wins. `- - -` matched the list pattern and Enter wrote a `- ` under it.
		for (const line of ['- - -', '* * *', '-  -  -', '* * * *', '> - - -', '  - - -']) {
			assert.equal(parseListItem(line), null, JSON.stringify(line));
		}
		assert.equal(enterAtEnd('- - -'), null);
		assert.equal(enterAtEnd('* * *'), null);
		// Inside a quote the break is still not an item, and the quote continues.
		assert.deepEqual(enterAtEnd('> - - -'), { kind: 'continue', text: '> ' });
		// Two dashes are not a break: `- -` is an item, and so is an item whose text
		// is a break in another character.
		assert.deepEqual(enterAtEnd('- -'), { kind: 'continue', text: '- ' });
		assert.deepEqual(enterAtEnd('- * * *'), { kind: 'continue', text: '- ' });
		assert.deepEqual(enterAtEnd('- - - text'), { kind: 'continue', text: '- ' });
	});

	// -------------------------------------------------------- block quotes (#700)

	test('a quoted line continues the quote', () => {
		assert.deepEqual(enterAtEnd('> quoted'), { kind: 'continue', text: '> ' });
		assert.deepEqual(enterAtEnd('> > deeper'), { kind: 'continue', text: '> > ' });
		assert.deepEqual(enterAtEnd('  > indented'), { kind: 'continue', text: '  > ' });
		// The spacing is copied, not normalised — the rule the hand-aligned list
		// above lives by, applied to the quote.
		assert.deepEqual(enterAtEnd('>   wide'), { kind: 'continue', text: '>   ' });
	});

	test('a quote written without its space is a quote too', () => {
		// `>text` IS a block quote — CommonMark says so, comrak says so, and the
		// preview beside the editor draws one. VS Code's Markdown All in One
		// declines it (`/^> /.test(textBeforeCursor)`); this key does not, because
		// declining would make Enter disagree with the app's own renderer.
		assert.deepEqual(enterAtEnd('>tight'), { kind: 'continue', text: '>' });
		assert.deepEqual(enterAtEnd('>> deep'), { kind: 'continue', text: '>> ' });
		// A bare `>` is an empty quote, so Enter leaves the quote as it does on `> `.
		assert.deepEqual(enterAtEnd('>'), { kind: 'clear', line: '' });
	});

	test('Enter on an empty quote leaves the quote, whatever its depth', () => {
		assert.deepEqual(enterAtEnd('> '), { kind: 'clear', line: '' });
		assert.deepEqual(enterAtEnd('> > '), { kind: 'clear', line: '' });
		assert.deepEqual(enterAtEnd('  > '), { kind: 'clear', line: '' });
	});

	test('leaving a quoted list takes one Enter per block, not one per level', () => {
		// The ladder the two branches make together, and the reason `clear` on a
		// quote goes to nothing rather than one level shallower: the list ends, then
		// the quote ends. Three Enters from a nested item to prose.
		assert.deepEqual(enterAtEnd('> > - item'), { kind: 'continue', text: '> > - ' });
		assert.deepEqual(enterAtEnd('> > - '), { kind: 'clear', line: '> > ' });
		assert.deepEqual(enterAtEnd('> > '), { kind: 'clear', line: '' });
	});

	test('the caret joins the block after the marker\'s CHARACTERS, not after its space', () => {
		// THE RULE, and the reason it is not "after the marker's text starts".
		//
		// A caret just after the `>` of `> quoted` and one just after the `>` of
		// `>quoted` are the same pixel and the same gesture; the first sits inside a
		// two-character marker, the second at the head of the content. Measuring to
		// where the TEXT starts answers those two opposite things — one Enter ending
		// the quote, the other continuing it — from a position nobody can tell
		// apart. Measuring to where the marker's characters stop answers both the
		// same. It is CodeMirror's rule for the same reason: @codemirror/lang-markdown
		// declines only when `inner.to - inner.spaceAfter.length > pos`.
		//
		// Column 1 is still the ordinary Enter everywhere: in front of the marker,
		// Enter means "make room above me".
		assert.equal(blockEnter('> quoted', 1), null);
		assert.deepEqual(blockEnter('> quoted', 2), { kind: 'continue', text: '>' });
		assert.equal(blockEnter('>quoted', 1), null);
		assert.deepEqual(blockEnter('>quoted', 2), { kind: 'continue', text: '>' });

		// Lists answer to the same measurement, which is where `-` stops.
		assert.equal(blockEnter('- item', 1), null);
		assert.deepEqual(blockEnter('- item', 2), { kind: 'continue', text: '-' });
		assert.deepEqual(blockEnter('1. item', 3), { kind: 'continue', text: '2.' });
		// A task item's marker runs through the box, so the space that does not
		// count is the one after `]`, not the one before `[`.
		assert.equal(blockEnter('  - [ ] item', 7), null);
		assert.deepEqual(blockEnter('  - [ ] item', 8), { kind: 'continue', text: '  - [ ]' });

		// Between the quote and a list marker the LIST has not started but the quote
		// has, so the tail moving down keeps its `> `.
		assert.deepEqual(blockEnter('> - item', 2), { kind: 'continue', text: '>' });
		assert.deepEqual(blockEnter('> - item', 4), { kind: 'continue', text: '> -' });
	});

	test('a caret inside the marker\'s space does not double that space', () => {
		// The separator is split by the caret: its second half rides down with the
		// text, so writing a whole one at the head of the new line lands an extra
		// space — and another on every Enter after that. What each pair below has to
		// add up to is the separator that was already there, not two of them.
		const split = (line: string, column: number) => {
			const next = blockEnter(line, column);
			assert.equal(next?.kind, 'continue', line);
			return [line.slice(0, column - 1), (next as { text: string }).text + line.slice(column - 1)];
		};

		assert.deepEqual(split('> quoted', 2), ['>', '> quoted']);
		assert.deepEqual(split('- item', 2), ['-', '- item']);
		// A hand-aligned list keeps every one of its spaces, and no more.
		assert.deepEqual(split('-   aligned', 2), ['-', '-   aligned']);
		// The marker's CHARACTERS are never rationed, only its whitespace: the
		// number still counts up and the box still comes back unchecked.
		assert.deepEqual(split('9. item', 3), ['9.', '10. item']);
		assert.deepEqual(split('- [x] task', 6), ['- [x]', '- [ ] task']);
	});

	test('a caret in the middle of an item still continues the list', () => {
		// Splitting an item is continuing it: the tail moves down behind the new
		// marker, which is what every editor does and what the caller relies on.
		assert.deepEqual(blockEnter('- hello world', 9), { kind: 'continue', text: '- ' });
	});

	test('parseListItem reports where the marker ends', () => {
		const item = parseListItem('  > - [x]  do it');
		assert.ok(item);
		assert.deepEqual(
			{
				prefix: item.prefix,
				marker: item.marker,
				box: item.box,
				content: item.content,
				contentColumn: item.contentColumn,
			},
			{ prefix: '  > ', marker: '-', box: '[x]', content: 'do it', contentColumn: 12 },
		);
		assert.equal('  > - [x]  do it'.slice(item.contentColumn - 1), 'do it');
	});

	// ----------------------------------------------------- #711: the level, run

	/** A document of literal lines — the two methods `shiftListItem` asks for. */
	const docOf = (lines: string[]) => ({
		getLineCount: () => lines.length,
		getLineContent: (line: number) => lines[line - 1],
	});

	/** Tab (or Shift+Tab) on `line`, as the lines it writes back. Null is "no level to move to". */
	function shift(lines: string[], line: number, back = false): string[] | null {
		const edit = shiftListItem(docOf(lines), line, 1, back);
		return edit ? [...edit.lines] : null;
	}

	test('Tab nests to the parent’s content column, which is not tabSize', () => {
		// #711 verbatim: Enter continued `1. something` as `2. `, and Tab has to put
		// that line INSIDE the item above it. Under `1. ` that column is 3 — with
		// tabSize at 2 the old Tab wrote two spaces, which CommonMark reads as the
		// next sibling, so the user got neither the nesting nor the number.
		assert.deepEqual(shift(['1. something', '2. '], 2), ['   1. ']);
		// Four under `10. `, and two under a bullet: the column is the marker’s width,
		// so it is a different number for every list.
		assert.deepEqual(shift(['10. a', '11. b'], 2), ['    1. b']);
		assert.deepEqual(shift(['- a', '- b'], 2), ['  - b']);
		// The box travels with the item and stays checked: this key moves an item, it
		// does not re-open a task the way Enter opens a new one.
		assert.deepEqual(shift(['- [ ] a', '- [x] b'], 2), ['  - [x] b']);
	});

	test('the item that moves starts its sub-list at 1, and the list it left closes up', () => {
		// Both halves of the renumbering, in one edit: `3. c` becomes the first item
		// of a nested list, and `4. d` — which is now the parent list’s third item —
		// stops claiming to be its fourth.
		assert.deepEqual(shift(['1. a', '2. b', '3. c', '4. d'], 3), ['   1. c', '3. d']);
		// The same in reverse: an item that leaves a sub-list takes the number of the
		// list it rejoins.
		assert.deepEqual(shift(['1. a', '   1. b', '   2. c'], 3, true), ['2. c']);
	});

	test('a list that starts at five keeps starting at five', () => {
		// The divergence from Markdown All in One, which renumbers a list’s first
		// item too and would rewrite this list to 1, 2, 3 on a Tab three lines away.
		// A first item is the one item whose number the renderer reads, so it is the
		// one item nobody may quietly overwrite.
		assert.deepEqual(shift(['5. a', '6. b', '7. c'], 2), ['   1. b', '6. c']);
		// Including when it is the line that moved: this one was a list’s start
		// before the key and is a list’s start after it.
		assert.deepEqual(shift(['   3. orphan'], 1, true), ['3. orphan']);
	});

	test('a level that does not exist is not invented', () => {
		// The first item of a list has nothing to nest under, and an item at the
		// margin has nothing to fall back to. Both answer null, and the handler turns
		// that into a key that does nothing rather than one that inserts whitespace.
		assert.equal(shift(['1. a', '2. b'], 1), null);
		assert.equal(shift(['1. a', '   - x'], 2), null, 'already the first item of its sub-list');
		assert.equal(shift(['1. a', '2. b'], 2, true), null);
	});

	test('a quoted list is indented inside the quote, not in front of it', () => {
		// What Markdown All in One cannot do and Obsidian still gets wrong in
		// callouts: the `>` stays where it is and the indentation goes after it.
		assert.deepEqual(shift(['> 1. a', '> 2. b'], 2), ['>    1. b']);
		assert.deepEqual(shift(['> 1. a', '>    1. b', '>    2. c'], 3, true), ['> 2. c']);
	});

	test('the renumbering stops where the list does', () => {
		// A blank line and a paragraph at the margin end a list, and the list AFTER
		// them is a different list — its `1.` must not be counted as this one’s third
		// item. `endLine` is the last line that actually changed, so the undo step and
		// the dirty-diff cover the move and nothing else.
		const edit = shiftListItem(docOf(['1. a', '2. b', '', 'text', '', '1. new']), 2, 1, false);
		assert.deepEqual(edit, {
			startLine: 2,
			endLine: 2,
			lines: ['   1. b'],
			caretLine: 2,
			caretColumn: 4,
		});
	});

	test('the renumbering stops at a change of delimiter or bullet', () => {
		// CommonMark starts a new list when the delimiter changes, so `1) x` is the
		// first item of its own list and is not counted as the next item of `1.`.
		assert.deepEqual(shift(['1. a', '2. b', '1) x', '2) y'], 2), ['   1. b']);
		assert.deepEqual(shift(['1. a', '   1) x', '   2) y', '2. b'], 2, true), ['1) x']);
		// A bullet between two ordered items ends the first list the same way. A
		// bullet has no number, so this one held already and is kept held.
		assert.deepEqual(shift(['1. a', '2. b', '* x', '1. c'], 2), ['   1. b']);
		// Tab reads the same boundary: `1) x` opens its own list, so it has no item
		// above to nest under, however much `2. b` looks like one.
		assert.equal(shift(['1. a', '2. b', '1) x'], 3), null);
		assert.equal(shift(['- a', '* b'], 2), null);
		// Shift+Tab still finds the parent, which does not care about the delimiter.
		assert.deepEqual(shift(['1. a', '   1. b', '   1) x'], 3, true), ['1) x']);
	});

	test('the caret keeps its place in the text it was in', () => {
		// Column 7 is in front of `bcd`; after a three-column indent it is column 10,
		// still in front of `bcd`. Losing that is how a level change stops being a
		// level change and starts being a jump.
		const edit = shiftListItem(docOf(['1. a', '2. bcd']), 2, 7, false);
		assert.deepEqual(edit?.caretColumn, 10);
	});
});

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
 * `when` clauses that decide it are pinned in `editing.test.ts`, which
 * owns the other half of the same two keys.
 */
describe('table editing', () => {
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

	/**
	 * The line the edit really writes, cut where the column it really reports says.
	 *
	 * Every caret assertion below is written against these two halves rather than
	 * against a number, because the number alone cannot express the defect it is
	 * guarding: `caretColumn` is a MONACO column — a UTF-16 offset into this very
	 * line — while a table is laid out in DISPLAY columns, where a CJK character is
	 * two and an ASCII one is one. The two units agree on `| Cell | Cell |` and
	 * disagree by one per wide character on `| 甲 | 北京 |`, so any assertion that
	 * only ever reads ASCII is satisfied by both the right answer and the wrong one.
	 */
	function caretSplit(edit: TableEdit | null): { before: string; after: string } {
		assert.ok(edit, 'the edit was refused');
		const line = edit.lines[edit.caretLine - edit.startLine];
		assert.ok(
			line !== undefined,
			`the caret is on line ${edit.caretLine}, outside the ${edit.lines.length} lines the edit writes`,
		);
		return { before: line.slice(0, edit.caretColumn - 1), after: line.slice(edit.caretColumn - 1) };
	}

	/**
	 * The caret sits at the END of the cell holding `text`.
	 *
	 * "At the end" is two claims, and both are checked: `text` is immediately behind
	 * the caret, and nothing but the cell's own padding stands between the caret and
	 * the pipe that closes the cell. An empty cell has no text, so the caret sits
	 * where text would start — one space past the pipe, the only position in it.
	 */
	function assertEndOfCell(edit: TableEdit | null, text: string) {
		const { before, after } = caretSplit(edit);
		assert.ok(
			before.endsWith(text === '' ? '| ' : text),
			`the caret is after ${JSON.stringify(before)}, which does not end with ${JSON.stringify(text)}`,
		);
		assert.match(
			after,
			/^ *\|/,
			`the caret is not at the end of its cell: ${JSON.stringify(after)} follows it`,
		);
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

	test('Tab in the middle of a table moves to the END of the next cell', () => {
		// AT THE END, not at the start. Landing on the first character means the next
		// thing typed goes in front of what is already there, and every editor with a
		// table Tab — Typora, Obsidian, VS Code's Markdown extensions — leaves the
		// caret ready to keep typing instead.
		const step = tableStep(doc(...INSERTED), 3, 3, false);
		assert.deepEqual(caretOf(step)?.at, [3, 16]);
		assertEndOfCell(step, 'Cell');
		// …and re-aligns on the way, which is the whole reason a move is an edit.
		assert.deepEqual(linesOf(step)[0], '| Header | Header | Header |');
		assert.deepEqual(linesOf(step)[1], '| ------ | ------ | ------ |');
	});

	test('Tab at the end of a row wraps to the first cell of the next one', () => {
		const step = tableStep(doc(...INSERTED), 3, 26, false);
		assert.deepEqual(caretOf(step)?.at, [4, 7]);
		assertEndOfCell(step, 'Cell');
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
		assert.deepEqual(caretOf(tableStep(doc(...INSERTED), 3, 12, true))?.at, [3, 7]);
		// From the first cell of a body row, back to the last cell of the one above.
		assert.deepEqual(caretOf(tableStep(doc(...INSERTED), 4, 3, true))?.at, [3, 25]);
		// …and across the delimiter row into the header, which is not a row.
		assert.deepEqual(caretOf(tableStep(doc(...INSERTED), 3, 3, true))?.at, [1, 27]);
	});

	test('Shift+Tab in the very first cell stays in it, at the end of what it holds', () => {
		// There is no cell before the first one. Falling through to Monaco's outdent
		// would take an indent level off the header row and break the table the user
		// was navigating — so this returns an edit that keeps the caret in the cell.
		const step = tableStep(doc(...INSERTED), 1, 3, true);
		assert.deepEqual(caretOf(step)?.at, [1, 9]);
		assertEndOfCell(step, 'Header');
		assert.deepEqual(linesOf(step)[0], '| Header | Header | Header |');
	});

	test('the delimiter row is a place the caret can be, and both keys leave it sensibly', () => {
		assert.deepEqual(caretOf(tableStep(doc(...INSERTED), 2, 3, false))?.at, [3, 7], 'Tab: into the body');
		assert.deepEqual(caretOf(tableStep(doc(...INSERTED), 2, 3, true))?.at, [1, 27], 'Shift+Tab: back to the header');
	});

	test('Tab outside a table is not this feature at all', () => {
		const notATable = doc('plain text', '- a list item', '', '| a | b |');
		for (const line of [1, 2, 3, 4]) {
			assert.equal(tableStep(notATable, line, 1, false), null, `line ${line}`);
			assert.equal(tableStep(notATable, line, 1, true), null, `line ${line}`);
		}
	});

	// --------------------------------------------- the caret column, in Monaco's unit

	/*
	 * A Monaco column is a UTF-16 offset; `displayWidth` counts the columns a
	 * monospace font draws. Those are two different numbers for the same cell, and
	 * the first version of this feature computed the caret from the second:
	 *
	 *     let caretColumn = table.prefix.length + 3;
	 *     for (let i = 0; i < cell; i++) caretColumn += widths[i] + 3;
	 *
	 * On `| 甲   | 北京 | 一   |` that answers 10, and column 10 of that string is
	 * BETWEEN 北 and 京 — one place off per wide character in every earlier cell.
	 * The status bar said 列 10 and the caret was inside a character.
	 *
	 * The fix is not a better sum. It is that there is no sum: the column is read
	 * back out of the line the edit is about to write, so the only way for it to be
	 * wrong is for that line to be wrong too. Every test in this section cuts the
	 * produced line at the produced column and looks at what is on either side,
	 * which is an assertion no re-derivation from widths can satisfy.
	 */

	test('an all-ASCII table still lands where it always did', () => {
		// The regression direction. ASCII is the one case where display columns and
		// UTF-16 offsets agree, so it is the case a units bug leaves looking fine.
		const step = tableStep(doc('| a | bb |', '| --- | --- |', '| cccc | d |'), 3, 3, false);
		assert.deepEqual(linesOf(step), ['| a    | bb  |', '| ---- | --- |', '| cccc | d   |']);
		assertEndOfCell(step, 'd');
		assert.deepEqual(caretOf(step)?.at, [3, 11]);
	});

	test('a CJK cell puts the caret after its last character, not inside one', () => {
		// The user's report, verbatim: Tab out of cell 0 of the body row.
		const cjk = doc('| 姓名 | 城市 | 备注 |', '| --- | --- | --- |', '| 甲 | 北京 | 一 |');
		const step = tableStep(cjk, 3, 3, false);
		assert.deepEqual(linesOf(step)[2], '| 甲   | 北京 | 一   |');
		assertEndOfCell(step, '北京');
		// Spelled out, because this is the number the status bar showed as 10: the
		// two characters of 北京 are ONE UTF-16 unit each, so the cell ends at 11.
		assert.deepEqual(caretOf(step)?.at, [3, 11]);
		assert.equal(caretSplit(step).before, '| 甲   | 北京');
	});

	test('a mixed CJK and ASCII table is right in both directions', () => {
		const mixed = doc('| 名前 | Value | 備考 |', '| --- | --- | --- |', '| abc | 日本語 | x |');
		// Forward into the widest cell of the row…
		const forward = tableStep(mixed, 3, 3, false);
		assert.deepEqual(linesOf(forward)[2], '| abc  | 日本語 | x    |');
		assertEndOfCell(forward, '日本語');
		// …and backward out of it, which is the same arithmetic one cell to the left.
		const back = tableStep(doc(...linesOf(forward)), forward!.caretLine, forward!.caretColumn, true);
		assertEndOfCell(back, 'abc');
	});

	test('an emoji cell is measured the same way, and the caret still lands past it', () => {
		// An emoji draws two columns and is TWO UTF-16 units (a surrogate pair), so it
		// is the case where the two units disagree in the opposite direction from CJK.
		const step = tableStep(doc('| a | b | c |', '| --- | --- | --- |', '| 😀 | ok | z |'), 3, 3, false);
		assert.deepEqual(linesOf(step)[2], '| 😀  | ok  | z   |');
		assertEndOfCell(step, 'ok');
	});

	test('stepping backwards through a CJK table ends every cell where the cell ends', () => {
		// Shift+Tab from the last cell of the last row back to the first cell of the
		// header, checking every landing on the way. Each step is fed the lines the
		// previous one produced, which is what the editor does.
		let lines = ['| 姓名 | 城市 | 备注 |', '| --- | --- | --- |', '| 甲 | 北京 | 一 |'];
		let line = 3;
		let column = 15;
		const landings: string[] = [];

		for (let i = 0; i < 5; i++) {
			const step = tableStep(doc(...lines), line, column, true);
			assert.ok(step, `step ${i} was refused`);
			const { before, after } = caretSplit(step);
			assert.match(after, /^ *\|/, `step ${i} did not land at the end of a cell: ${JSON.stringify(after)}`);
			landings.push(before);
			lines = [...step.lines];
			line = step.caretLine;
			column = step.caretColumn;
		}

		assert.deepEqual(landings, [
			'| 甲   | 北京',
			'| 甲',
			'| 姓名 | 城市 | 备注',
			'| 姓名 | 城市',
			'| 姓名',
		]);
	});

	test('an empty cell has one place for the caret, and that is where it goes', () => {
		// There is no last character to sit after, so "the end of the content" and
		// "the start of it" are the same position: the single padding space.
		const step = tableStep(doc('| 名前 | 値 |', '| --- | --- |', '| a |  |'), 3, 3, false);
		assert.deepEqual(linesOf(step)[2], '| a    |     |');
		assertEndOfCell(step, '');
		assert.equal(caretSplit(step).after, '    |');
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

	test('a row can be inserted ABOVE the caret, which is the other half of the pair', () => {
		assert.deepEqual(linesOf(operate('insert-row-above', 4, 3)), [
			'| Header | Header | Header |',
			'| ------ | ------ | ------ |',
			'| Cell   | Cell   | Cell   |',
			'|        |        |        |',
			'| Cell   | Cell   | Cell   |',
		]);
		// From the header or the delimiter row there is no row above that is still
		// inside the table, so both directions mean the top of the body.
		assert.deepEqual(linesOf(operate('insert-row-above', 1, 3))[2], '|        |        |        |');
		assert.deepEqual(linesOf(operate('insert-row-above', 2, 3))[2], '|        |        |        |');
		assert.deepEqual(caretOf(operate('insert-row-above', 4, 3))?.at, [4, 3]);
	});

	test('a row is deleted and the caret stays in the table', () => {
		assert.deepEqual(linesOf(operate('delete-row', 3, 3)), [
			'| Header | Header | Header |',
			'| ------ | ------ | ------ |',
			'| Cell   | Cell   | Cell   |',
		]);
		// The caret keeps its CELL and falls onto the row that took the deleted one's
		// place — or onto the last row when there is none.
		assert.deepEqual(caretOf(operate('delete-row', 4, 12))?.at, [3, 16]);
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
		assert.deepEqual(caretOf(edit)?.at, [3, 4]);
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
		for (const operation of ['insert-row', 'insert-row-above', 'delete-row', 'insert-column', 'delete-column'] as const) {
			assert.equal(tableOperation(prose, 1, 1, operation), null, operation);
		}
	});
});

describe('fenced code detection', () => {
	/** Every line of `text`, 1-based, answered in order. */
	function inside(text: string): boolean[] {
		const lines = text.split('\n');
		const doc = { getLineContent: (line: number) => lines[line - 1] };
		return lines.map((_, index) => isInFencedCode(doc, index + 1));
	}

	test('the lines after an opening fence are inside it, up to and including the closing fence', () => {
		assert.deepEqual(inside('a\n```\n1. x\n```\nb'), [false, false, true, true, false]);
		assert.deepEqual(inside('~~~ts\n|a|\n~~~\n|a|'), [false, true, true, false]);
	});

	test('only the same character, at least as long, with nothing after it, closes', () => {
		assert.deepEqual(inside('````\n```\nx\n````\ny'), [false, true, true, true, false]);
		assert.deepEqual(inside('```\n~~~\nx\n```\ny'), [false, true, true, true, false]);
		assert.deepEqual(inside('```\n``` ts\nx\n```  \ny'), [false, true, true, true, false]);
	});

	test('an unclosed fence runs to the end of the document', () => {
		assert.deepEqual(inside('```\na\nb'), [false, true, true]);
	});

	test('a backtick run with a backtick after it is inline code, not a fence', () => {
		assert.deepEqual(inside('```a```\n1. x'), [false, false]);
		// A tilde fence's info string may say anything.
		assert.deepEqual(inside('~~~ a`b\nx\n~~~'), [false, true, true]);
	});

	test('a fence nested in a list item or a quote counts; two backticks do not', () => {
		assert.deepEqual(inside('1. a\n   ```\n   2. b\n   ```\n3. c'), [false, false, true, true, false]);
		assert.deepEqual(inside('> ```\n> - x\n> ```\n- y'), [false, true, true, false]);
		assert.deepEqual(inside('``\n- x'), [false, false]);
	});

	test('a fence opened on the list marker line counts, and so does its closing line', () => {
		assert.deepEqual(inside('- item\n- ```js\n  code\n  ```\n- next\n  - child'), [false, false, true, true, false, false]);
		assert.deepEqual(inside('1. ```bash\n   ls\n   ```\n2. b'), [false, true, true, false]);
		assert.deepEqual(inside('* [ ] ```\n  x\n  ```\n+ y'), [false, true, true, false]);
		// Containers nest: a quote holding a list, a list holding a list.
		assert.deepEqual(inside('> - ```\n>   x\n>   ```\n- y'), [false, true, true, false]);
		assert.deepEqual(inside('> 1. - ```\n>      x\n>      ```\n- y'), [false, true, true, false]);
	});

	test('a list item with inline code spans is not a fence', () => {
		assert.deepEqual(inside('- use ```x``` here\n- y'), [false, false]);
		assert.deepEqual(inside('- ```x```\n- y'), [false, false]);
	});

	test('inside a fence a marker line is code, never the close', () => {
		// A Markdown sample showing a fence on a list item, and a diff that deletes
		// one: both lines are code, and taking them for the close inverted the rest.
		assert.deepEqual(inside('```md\n- ```\n  x\n```\n- item\n- item2'), [false, true, true, true, false, false]);
		assert.deepEqual(inside('```diff\n- ```\n+ ```ts\n```\n- item'), [false, true, true, true, false]);
	});

	test('a task box opens a fence only after a list marker', () => {
		assert.deepEqual(inside('[x] ```\na\nb'), [false, false, false]);
	});
});

describe('callout marker', () => {
	// The shim globals are this block's alone: install them for its tests and put
	// back whatever was there before.
	const SHIM_GLOBALS = ['DOMParser', 'document', 'Node', 'NodeFilter'] as const;
	const saved = new Map<string, PropertyDescriptor | undefined>();
	let processMarkdownHtml: (typeof import('../src/lib/utils/markdown.ts'))['processMarkdownHtml'];
	before(async () => {
		for (const name of SHIM_GLOBALS) saved.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
		installShimDom();
		({ processMarkdownHtml } = await import('../src/lib/utils/markdown.ts'));
	});
	after(() => {
		for (const [name, descriptor] of saved) {
			if (descriptor) Object.defineProperty(globalThis, name, descriptor);
			else delete (globalThis as Record<string, unknown>)[name];
		}
	});

	// Only the text a quote opens with can make it a callout, as in Obsidian and
	// GitHub. The marker used to be looked for in every text node of the quote, so
	// a `[!note]` shown in inline code, a code block or a nested quote turned the
	// whole quote into a callout and the matched text was deleted.

	function render(html: string) {
		return parseHtml(processMarkdownHtml(html, '/doc.md', new Set()));
	}

	test('a marker in inline code is text, not a callout', () => {
		const root = render('<blockquote>\n<p>Use <code>[!note]</code> to make a callout</p>\n</blockquote>');
		assert.equal(root.querySelector('.markdown-alert'), null);
		assert.equal(root.querySelector('code')?.textContent, '[!note]');
	});

	test('a marker at the top of a code block is text, not a callout', () => {
		const root = render('<blockquote>\n<pre><code>[!warning] Title\n</code></pre>\n</blockquote>');
		assert.equal(root.querySelector('.markdown-alert'), null);
		assert.equal(root.querySelector('code')?.textContent, '[!warning] Title\n');
	});

	test('a callout in a nested quote leaves the outer quote alone', () => {
		const root = render(
			'<blockquote>\n<p>Outer</p>\n<blockquote>\n<p>[!tip] Inner</p>\n</blockquote>\n</blockquote>',
		);
		const outer = root.querySelector('blockquote');
		assert.ok(outer, 'the outer quote is still a quote');
		assert.equal(outer.querySelector('p')?.textContent, 'Outer');
		const tip = outer.querySelector('.markdown-alert-tip');
		assert.ok(tip, 'the inner quote is the callout');
		assert.equal(tip.querySelector('.callout-title-inner')?.textContent, 'Inner');
	});

	test('a quote that opens with the marker is still a callout, fold and title included', () => {
		const root = render('<blockquote>\n<p>[!note]+ My title<br />\nbody</p>\n</blockquote>');
		const callout = root.querySelector('.markdown-alert-note');
		assert.ok(callout);
		assert.ok(callout.classList.contains('callout-foldable'));
		assert.equal(callout.querySelector('.callout-title-inner')?.textContent, 'My title');
		assert.match(callout.querySelector('.content-inner')?.textContent ?? '', /body/);
	});
});

/**
 * #200: "implement some function which slugify titles and purpose those as
 * #targets for URL of link".
 *
 * Half of it already worked — comrak renders an `id` onto every heading and
 * `[…](#that-id)` jumps to it — but nothing offered the ids, so writing one
 * meant doing comrak's anchorizer by hand: lowercase, drop the punctuation it
 * drops, hyphenate the spaces, and remember that a repeated heading is
 * numbered. Getting it wrong produces a link that looks right and lands
 * nowhere.
 *
 * The list comes from Rust, from the renderer's own parse and anchorizer
 * (`outline`, pinned against the rendered `id=` attributes in
 * `lib.rs`). What is asserted here is the other half: WHERE a heading is the
 * answer, and what gets written when it is — the two link syntaxes take
 * different text, which is the part that is easy to get backwards.
 */
describe('heading link completion', () => {
	test('an inline link destination after # wants the slug', () => {
		assert.equal(headingLinkContext('See [the diagrams](#'), 'slug');
		assert.equal(headingLinkContext('See [the diagrams](#mer'), 'slug');
		assert.equal(headingLinkContext('![alt](#'), 'slug');
	});

	test('a wikilink to this document wants the heading as it reads', () => {
		assert.equal(headingLinkContext('[[#'), 'wikilink');
		assert.equal(headingLinkContext('[[#11. Mer'), 'wikilink');
	});

	test('a wikilink into another file is not this document\'s question', () => {
		// Those are that file's headings, and this buffer does not have them.
		// Offering these would be worse than offering nothing.
		assert.equal(headingLinkContext('[[notes#'), null);
		assert.equal(headingLinkContext('[[notes.md#Setup'), null);
		// Past the pipe is the alias, which is prose.
		assert.equal(headingLinkContext('[[#Setup|jump to '), null);
	});

	test('a finished destination, and prose that merely contains #, are not contexts', () => {
		assert.equal(headingLinkContext('[the diagrams](#mermaid) and then'), null);
		assert.equal(headingLinkContext('[the diagrams](#mermaid diagrams'), null, 'a space ends it');
		assert.equal(headingLinkContext('issue #200 is about'), null);
		assert.equal(headingLinkContext('# A heading being typed'), null);
		assert.equal(headingLinkContext('[a file link](./notes'), null, 'that is the path completion');
	});

	test('the suggestion replaces what was typed after the #, not the # itself', () => {
		const prefix = 'See [the diagrams](#mer';
		assert.equal(headingQueryStart(prefix), prefix.indexOf('#') + 1);
		assert.equal(prefix.slice(headingQueryStart(prefix)), 'mer');
	});
});

describe('heading symbols and folds', () => {
	const heading = (line: number, level: number, text: string) => ({ line, level, text, slug: '' });

	/** One row per symbol, indented by depth: `name start-end`. */
	function outline(symbols: Monaco.languages.DocumentSymbol[], depth = 0): string[] {
		return symbols.flatMap((symbol) => [
			`${'  '.repeat(depth)}${symbol.name} ${symbol.range.startLineNumber}-${symbol.range.endLineNumber}`,
			...outline(symbol.children ?? [], depth + 1),
		]);
	}

	test('#759: a section nests under the heading above it, and ends where a peer or a parent starts', () => {
		// The document from the issue, with a second H2 so a section has to close.
		const symbols = headingSymbols(
			[heading(1, 1, 'H1'), heading(3, 2, 'H2'), heading(5, 3, 'H3'), heading(10, 3, 'Second H3'), heading(14, 2, 'Another H2')],
			16,
			0,
		);
		assert.deepEqual(outline(symbols), [
			'H1 1-16',
			'  H2 3-13',
			'    H3 5-9',
			'    Second H3 10-13',
			'  Another H2 14-16',
		]);
	});

	test('a skipped level still nests, and a shallower heading closes every deeper section', () => {
		const symbols = headingSymbols([heading(1, 1, 'A'), heading(2, 3, 'deep'), heading(4, 2, 'B'), heading(6, 1, 'C')], 8, 0);
		assert.deepEqual(outline(symbols), ['A 1-5', '  deep 2-3', '  B 4-5', 'C 6-8']);
	});

	test('#777: a heading folds to the last non-blank line of its section, and an empty one does not fold', () => {
		const lines = ['# A', 'text', '', '## B', '', '# C', '', 'end', ''];
		const ranges = headingFoldRanges(
			[heading(1, 1, 'A'), heading(4, 2, 'B'), heading(6, 1, 'C')],
			lines.length,
			(n) => lines[n - 1],
		);
		assert.deepEqual(ranges, [
			{ start: 1, end: 4 },
			{ start: 6, end: 8 },
		]);
	});
});

/**
 * "Copy Reference" writes the spelling the document is already written in.
 *
 * Markpad understands two ways to link a heading — `[[note#Setup]]`, which it
 * rewrites before the parse, and `[Setup](note.md#setup)`, which every reader
 * resolves — and this menu always produced the first. Which one is right
 * depends on the person, not on the app: a vault full of `[[…]]` wants
 * another one; a document written for GitHub wants a link that survives
 * leaving Markpad.
 *
 * The document is the evidence, because a person's habit is already written
 * down in the file they are working in. The inference has a floor: says
 * nothing, or says both, and the answer is what the menu always produced. So
 * it can be better than the old behaviour and never worse — which is the only
 * reason inferring is defensible here at all.
 *
 * Known and accepted: a reference is usually pasted into a DIFFERENT document,
 * so following this one is a guess about that one.
 */
describe('copy reference style', () => {
	/* ------------------------------------------------------ reading the document */

	test('a document that links one way gets another of the same', () => {
		assert.equal(
			preferredReferenceStyle('See [[Setup#Install]] for details.\n'),
			'wikilink',
		);
		assert.equal(
			preferredReferenceStyle('See [Install](setup.md#install) for details.\n'),
			'inline',
		);
		// A same-document anchor counts as well — it is the same spelling.
		assert.equal(preferredReferenceStyle('Back to [the top](#introduction).\n'), 'inline');
		// And a bare note link, which the renderer leaves literal, still says what
		// the writer's habit is.
		assert.equal(preferredReferenceStyle('See [[Setup]].\n'), 'wikilink');
	});

	test('silence and disagreement both fall back to what the menu always did', () => {
		assert.equal(DEFAULT_REFERENCE_STYLE, 'wikilink');
		assert.equal(preferredReferenceStyle(''), DEFAULT_REFERENCE_STYLE);
		assert.equal(preferredReferenceStyle('# A document\n\nWith no links at all.\n'), DEFAULT_REFERENCE_STYLE);
		assert.equal(
			preferredReferenceStyle('Both [[Setup#Install]] and [Install](setup.md#install).\n'),
			DEFAULT_REFERENCE_STYLE,
			'a document using both is not evidence of either',
		);
		// An ordinary link with no anchor is not evidence: every document has those.
		assert.equal(preferredReferenceStyle('See [the site](https://example.com).\n'), DEFAULT_REFERENCE_STYLE);
	});

	test('a document ABOUT markdown does not vote with its examples', () => {
		// `samples/stress-test.md` and this project's own notes are full of
		// both spellings inside fences. Counting those would make the syntax
		// documentation the loudest voice in every vault.
		const teaching = [
			'# Linking',
			'',
			'```markdown',
			'[[Setup#Install]]',
			'```',
			'',
			'Prose with [an anchor](setup.md#install) in it.',
			'',
		].join('\n');

		assert.equal(preferredReferenceStyle(teaching), 'inline', 'the fenced example must not count');

		const tildeFenced = '~~~md\n[[Setup#Install]]\n~~~\n\nSee [x](a.md#b).\n';
		assert.equal(preferredReferenceStyle(tildeFenced), 'inline', 'tilde fences too');
	});

	/* ------------------------------------------------------------ writing it out */

	test('each style is written the way its own resolver reads it', () => {
		const heading = { text: 'Setup', slug: 'setup', fileName: 'notes.md' as string | null };

		// The wikilink drops the extension — `process_wikilinks` appends `.md`
		// itself — and names the heading by its TEXT.
		assert.equal(headingReference({ ...heading, style: 'wikilink' }), '[[notes#Setup]]');
		// The CommonMark form keeps it, because that is how the frontend claims a
		// link for local navigation, and names the heading by its rendered id.
		assert.equal(headingReference({ ...heading, style: 'inline' }), '[Setup](notes.md#setup)');
	});

	test('the wikilink drops only an extension the renderer would add back', () => {
		// `process_wikilinks` appends `.md` to a target with no extension, so
		// `[[note#Setup]]` reaches `note.md` and never `note.markdown`.
		const reference = (fileName: string) =>
			headingReference({ text: 'Setup', slug: 'setup', fileName, style: 'wikilink' });
		assert.equal(reference('note.markdown'), '[[note.markdown#Setup]]');
		assert.equal(reference('notes.txt'), '[[notes.txt#Setup]]');
		// Left as `v1.2`, the target would read as having a `.2` extension.
		assert.equal(reference('v1.2.md'), '[[v1.2.md#Setup]]');
		assert.equal(reference('v1.2 spec.md'), '[[v1.2 spec#Setup]]');
	});

	test('an unsaved document has no file to name', () => {
		const heading = { text: 'Setup', slug: 'setup', fileName: null };
		assert.equal(headingReference({ ...heading, style: 'wikilink' }), '#Setup');
		assert.equal(headingReference({ ...heading, style: 'inline' }), '[Setup](#setup)');
	});

	test('the CommonMark form survives a filename with a space and a bracketed heading', () => {
		// `[Setup](my notes.md#setup)` stops at the space; `[Notes [draft](…)` ends
		// its label early. Neither can happen in the wikilink form, which is part
		// of why this only applies to one of them.
		assert.equal(
			headingReference({ text: 'Setup', slug: 'setup', fileName: 'my notes.md', style: 'inline' }),
			'[Setup](<my notes.md#setup>)',
		);
		assert.equal(
			headingReference({ text: 'Notes [draft', slug: 'notes-draft', fileName: null, style: 'inline' }),
			'[Notes \\[draft](#notes-draft)',
		);
	});

	test('a repeated heading is addressable, because the slug comes from the render', () => {
		// comrak numbers them; recomputing the id here would drift from that.
		assert.equal(
			headingReference({ text: 'Objectives', slug: 'objectives-1', fileName: 'n.md', style: 'inline' }),
			'[Objectives](n.md#objectives-1)',
		);
	});
});

describe('find seed', () => {
	/** A `Selection` as far as `findSeedFromSelection` is concerned. */
	function selecting(text: string, where: 'preview' | 'elsewhere' | 'caret' = 'preview') {
		const node = where === 'elsewhere' ? 'outside' : 'inside';
		return { isCollapsed: where === 'caret', anchorNode: node, focusNode: node, toString: () => text } as unknown as Selection;
	}

	/** The rendered document. `contains` is the only question the seed asks of it. */
	const preview = { contains: (node: unknown) => node === 'inside' } as unknown as Node;

	test('what Cmd/Ctrl+F starts from, given what is selected', () => {
		const seed = (s: Selection | null, root: Node | null = preview) => findSeedFromSelection(s, root);

		assert.equal(seed(selecting('deterministic')), 'deterministic');
		// Across `**bold**`, a link or inline code the selection spans several text
		// nodes; reading only one would leave the feature off in the commonest case.
		assert.equal(seed(selecting('bold word')), 'bold word');
		assert.equal(seed(selecting('  spaced  ')), 'spaced', 'a double-click drags the trailing space in');

		// Empty means "leave the box alone" — a repeated Cmd/Ctrl+F re-focuses the
		// previous query (#559) rather than wiping it.
		assert.equal(seed(selecting('first\nsecond')), '', 'multi-line: Monaco’s rule in the other pane');
		assert.equal(seed(selecting('   ')), '', 'whitespace only');
		assert.equal(seed(selecting('x', 'caret')), '', 'a caret with nothing selected');
		assert.equal(seed(selecting('x', 'elsewhere')), '', 'selected in a modal or the tab strip');
		assert.equal(seed(null), '', 'no selection');
		assert.equal(seed(selecting('x'), null), '', 'no preview on screen');
	});
});

describe('front matter parsing and editing', () => {
	const planMarkdown = `---
type: plan
name: dflex-logger-onoff-dir-synlog
title: "Sterowanie loggerami dFLEX: on/off domyslnie OFF"
project: "dflex"
keywords: [logger, synlog, appconfig, onoff, codesite]
created: 2026-06-26T18:29:35+02:00
status: in-progress
---

## Summary

Body text.
`;

	test('parseFrontMatter extracts top-level YAML metadata and body', () => {
		const parsed = parseFrontMatter(planMarkdown);

		assert.equal(parsed.exists, true);
		assert.equal(parsed.valid, true);
		assert.equal(parsed.body, '## Summary\n\nBody text.\n');
		assert.deepEqual(
			parsed.fields.map((field) => [field.key, field.kind, field.displayValue]),
			[
				['type', 'string', 'plan'],
				['name', 'string', 'dflex-logger-onoff-dir-synlog'],
				['title', 'string', 'Sterowanie loggerami dFLEX: on/off domyslnie OFF'],
				['project', 'string', 'dflex'],
				['keywords', 'list', 'logger, synlog, appconfig, onoff, codesite'],
				['created', 'string', '2026-06-26T18:29:35+02:00'],
				['status', 'string', 'in-progress'],
			],
		);
	});

	test('parseFrontMatter ignores thematic breaks outside the first document line', () => {
		const markdown = `# Title

---

Body`;
		const parsed = parseFrontMatter(markdown);

		assert.equal(parsed.exists, false);
		assert.equal(parsed.body, markdown);
		assert.equal(getMarkdownBodyWithoutFrontMatter(markdown), markdown);
	});

	test('parseFrontMatter strips invalid front matter from rendered body but keeps the error', () => {
		const parsed = parseFrontMatter(`---
title: [broken
---

# Body
`);

		assert.equal(parsed.exists, true);
		assert.equal(parsed.valid, false);
		assert.match(parsed.error || '', /Flow sequence|unexpected|end/i);
		assert.equal(parsed.body, '# Body\n');
		assert.deepEqual(parsed.fields, []);
	});

	test('updateFrontMatterField updates one property without changing markdown body', () => {
		const updated = updateFrontMatterField(planMarkdown, 'status', 'done');
		const parsed = parseFrontMatter(updated);

		assert.equal(parsed.exists, true);
		assert.equal(parsed.valid, true);
		assert.equal(parsed.fields.find((field) => field.key === 'status')?.displayValue, 'done');
		assert.equal(parsed.body, '## Summary\n\nBody text.\n');
	});

	test('updateFrontMatterField preserves CRLF documents', () => {
		const markdown = '---\r\nname: old\r\ntags:\r\n  - one\r\n---\r\n\r\nText\r\n';
		const updated = updateFrontMatterField(markdown, 'name', 'new');

		assert.match(updated, /^---\r\nname: new\r\ntags:/);
		assert.equal(parseFrontMatter(updated).body, 'Text\r\n');
	});

	test('getFrontMatterListItems returns string tag values for YAML lists', () => {
		const parsed = parseFrontMatter(planMarkdown);
		const keywords = parsed.fields.find((field) => field.key === 'keywords');

		assert.ok(keywords);
		assert.deepEqual(getFrontMatterListItems(keywords), ['logger', 'synlog', 'appconfig', 'onoff', 'codesite']);
	});

	test('front matter tag helpers add, edit, and remove tags predictably', () => {
		const original = ['logger', 'synlog'];

		assert.deepEqual(addFrontMatterListItems(original, [' appconfig ']), ['logger', 'synlog', 'appconfig']);
		assert.deepEqual(addFrontMatterListItems(original, ['logger']), ['logger', 'synlog']);
		assert.deepEqual(addFrontMatterListItems(original, [' ', 'synlog', 'codesite, onoff']), ['logger', 'synlog', 'codesite', 'onoff']);
		assert.deepEqual(updateFrontMatterListItem(original, 1, ' syslog '), ['logger', 'syslog']);
		assert.deepEqual(updateFrontMatterListItem(original, 1, 'logger'), ['logger', 'synlog']);
		assert.deepEqual(updateFrontMatterListItem(original, 1, ' '), ['logger', 'synlog']);
		assert.deepEqual(removeFrontMatterListItem(original, 0), ['synlog']);
	});

	test('updateFrontMatterField writes edited keywords as a YAML list', () => {
		const updated = updateFrontMatterField(planMarkdown, 'keywords', ['logger', 'synlog']);
		const parsed = parseFrontMatter(updated);
		const keywords = parsed.fields.find((field) => field.key === 'keywords');

		assert.ok(keywords);
		assert.deepEqual(getFrontMatterListItems(keywords), ['logger', 'synlog']);
		assert.equal(parsed.body, '## Summary\n\nBody text.\n');
	});
});

describe('front matter versus a prose block', () => {
	// A document may open with a thematic break and then use a setext underline for
	// its first heading. That looks exactly like a front matter block, but the text
	// between the rules is prose, not metadata, so it has to survive into the body.
	const proseBetweenRules = `---
Lead paragraph
---

Body starts here.
`;

	test('a leading --- block that is not a YAML mapping stays in the rendered body', () => {
		const parsed = parseFrontMatter(proseBetweenRules);

		assert.equal(parsed.exists, false);
		assert.equal(parsed.valid, true);
		assert.equal(parsed.raw, '');
		assert.deepEqual(parsed.fields, []);
		assert.deepEqual(parsed.data, {});
		assert.equal(parsed.body, proseBetweenRules);
		assert.equal(getMarkdownBodyWithoutFrontMatter(proseBetweenRules), proseBetweenRules);
	});

	test('prose that spans several lines between the rules is not swallowed either', () => {
		const markdown = '---\nline one\nline two\n---\n\nBody\n';
		const parsed = parseFrontMatter(markdown);

		assert.equal(parsed.exists, false);
		assert.equal(parsed.body, markdown);
	});

	test('a leading --- block holding a bare YAML sequence is not metadata', () => {
		const markdown = '---\n- one\n- two\n---\n\nBody\n';
		const parsed = parseFrontMatter(markdown);

		assert.equal(parsed.exists, false);
		assert.equal(parsed.body, markdown);
	});

	test('front matter that is a mapping keeps working, including empty and string-valued ones', () => {
		const empty = parseFrontMatter('---\n---\n\nBody\n');
		assert.equal(empty.exists, true);
		assert.equal(empty.valid, true);
		assert.deepEqual(empty.fields, []);
		assert.equal(empty.body, 'Body\n');

		const blank = parseFrontMatter('---\n\n---\n\nBody\n');
		assert.equal(blank.exists, true);
		assert.equal(blank.body, 'Body\n');

		const stringValued = parseFrontMatter('---\ntitle: hello\n---\n\nBody\n');
		assert.equal(stringValued.exists, true);
		assert.equal(stringValued.valid, true);
		assert.deepEqual(
			stringValued.fields.map((field) => [field.key, field.kind, field.displayValue]),
			[['title', 'string', 'hello']],
		);
		assert.equal(stringValued.body, 'Body\n');

		const crlf = parseFrontMatter('---\r\ntitle: hello\r\n---\r\n\r\nBody\r\n');
		assert.equal(crlf.exists, true);
		assert.equal(crlf.body, 'Body\r\n');
	});

	test('a malformed mapping is still reported as broken front matter rather than body', () => {
		const parsed = parseFrontMatter('---\ntitle: [broken\n---\n\n# Body\n');

		assert.equal(parsed.exists, true);
		assert.equal(parsed.valid, false);
		assert.equal(parsed.body, '# Body\n');
	});

	test('an unresolved alias in the block is broken front matter, not an exception', () => {
		const parsed = parseFrontMatter('---\n**bold**\n---\n\n# Body\n');

		assert.equal(parsed.exists, true);
		assert.equal(parsed.valid, false);
		assert.match(parsed.error ?? '', /alias/i);
		assert.equal(parsed.body, '# Body\n');
	});
});

// `[[Notes#Setup]]` — the exact string the "Copy Reference" context-menu item
// writes to the clipboard — used to render as literal text: the Rust
// preprocessor only understood the same-document form `[[#Setup]]`. It now
// emits a plain markdown link, and these tests pin the *shape* of the href it
// emits against the frontend that has to claim it. The Rust side owns the
// other half of this contract in src-tauri/src/lib.rs (`copy_reference_output_
// becomes_a_real_link` and friends); if either half moves, the other fails.
//
// Scope: only the heading-bearing forms (`[[#h]]`, `[[file#h]]`, and their
// `|alias` variants) are rewritten. Obsidian's bare note link `[[Notes]]` is
// a separate feature, not this defect, and is left literal.
//
// Not covered here: whether the file exists, and the actual tab-opening (that
// runs inside MarkdownViewer.svelte and needs a live webview). These tests
// only prove the href is recognized as a local markdown target and decodes
// back to the path and anchor the document asked for.
describe('wikilink file targets', () => {
	// href values as produced by process_wikilinks() in src-tauri/src/lib.rs.
	// Only the heading-bearing forms appear: a wikilink with no `#` is
	// deliberately left as literal text and never reaches the frontend at all.
	const cases: { wikilink: string; href: string; path: string; hash: string }[] = [
		{ wikilink: '[[Notes#Setup]]', href: 'Notes.md#setup', path: 'Notes.md', hash: 'setup' },
		{ wikilink: '[[docs/Guide#Setup]]', href: 'docs/Guide.md#setup', path: 'docs/Guide.md', hash: 'setup' },
		{ wikilink: '[[docs/Guide#1. 概述|Overview]]', href: 'docs/Guide.md#1-概述', path: 'docs/Guide.md', hash: '1-概述' },
		{ wikilink: '[[My Notes (v2)#Setup]]', href: 'My%20Notes%20%28v2%29.md#setup', path: 'My Notes (v2).md', hash: 'setup' },
		{ wikilink: '[[Notes#^abc123]]', href: 'Notes.md#abc123', path: 'Notes.md', hash: 'abc123' },
		{ wikilink: '[[log.txt#Errors]]', href: 'log.txt#errors', path: 'log.txt', hash: 'errors' },
	];

	test('every href the wikilink rewriter emits is claimed as a local markdown target', () => {
		for (const { wikilink, href, path, hash } of cases) {
			const target = getMarkdownLinkTarget(href);
			assert.notEqual(target, null, `${wikilink} -> ${href} was not claimed as a markdown link`);
			assert.equal(target?.path, path, `${wikilink} resolved to the wrong path`);
			assert.equal(target?.hash, hash, `${wikilink} resolved to the wrong anchor`);
		}
	});

	test('a bare note name without the appended extension would not be claimed', () => {
		// This is why the rewriter appends ".md": Obsidian omits the extension,
		// but getMarkdownLinkTarget() keys entirely off it, and an unclaimed href
		// falls through to the external-URL opener instead of opening a tab.
		assert.equal(hasMarkdownLinkExtension('Notes'), false);
		assert.equal(getMarkdownLinkTarget('Notes#setup'), null);
	});

	test('wikilink targets resolve relative to the document that contains them', () => {
		const target = getMarkdownLinkTarget('docs/Guide.md#1-概述');
		assert.notEqual(target, null);
		assert.equal(resolveMarkdownTargetPath('/vault/index.md', target!), '/vault/docs/Guide.md');
	});

	test('non-markdown wikilink targets are left literal rather than emitted as links', () => {
		// The rewriter declines these (`wikilinks_to_files_the_viewer_cannot_open_
		// stay_literal`); this asserts the reason — the frontend would not claim
		// them either.
		assert.equal(getMarkdownLinkTarget('report.pdf#Intro'), null);
		assert.equal(getMarkdownLinkTarget('diagram.svg#part'), null);
	});
});
