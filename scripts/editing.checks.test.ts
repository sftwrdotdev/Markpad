import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { KeyCode } from 'monaco-editor/esm/vs/editor/common/standalone/standaloneEnums.js';
import { KeyMod } from 'monaco-editor/esm/vs/editor/common/services/editorBaseApi.js';
import ts from 'typescript';

import { bareCommands, runEditorHandler } from './keymapHarness.js';
import { functionSource, readRustBackend, readSource, sliceFrom } from './sourceTree.js';
import { frontMatterFenceLines, frontMatterLineOffset } from '../src/lib/utils/frontMatter.js';
import { hasMarkdownLinkExtension, MARKDOWN_LINK_EXTENSIONS } from '../src/lib/utils/markdownLinks.js';

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
describe('list keys in the editor', () => {
	// ------------------------------------------------- the handlers, actually run
	//
	// The two handlers are lifted out of the component and run against a stub
	// editor by `runEditorHandler` in ./keymapHarness.ts, the same trick the keymap
	// harness uses on `registerLocalizedActions` — so what is asserted is the edit
	// they really produce rather than the shape of the source that produces it. The
	// list module in scope there is the REAL one.
	//
	// Tab needs its collaborators named because it dispatches through them: the
	// table branch comes first, and a run without `stepTableCell` in scope would be
	// checking a handler the app does not have.

	const EDITOR = 'src/lib/components/Editor.svelte';

	const TAB_HANDLER = ['soleCaret', 'applyLineEdit', 'stepTableCell', 'shiftListLevel', 'handleTabKey'];

	const SHIFT_TAB_HANDLER = [
		'soleCaret',
		'applyLineEdit',
		'stepTableCell',
		'shiftListLevel',
		'handleShiftTabKey',
	];

	const ENTER_HANDLER = ['soleCaret', 'applyLineEdit', 'continueListOnEnter'];

	test('Enter on a list item inserts the line break and the next marker in one edit', () => {
		const run = runEditorHandler(ENTER_HANDLER, { lines: ['- item'], selections: [[1, 7, 1, 7]] });

		assert.deepEqual(run.triggers, [], 'the plain Enter must not fire as well');
		assert.deepEqual(run.edits, [
			{ range: [1, 7, 1, 7], text: '\n- ', cursor: [2, 3, 2, 3] },
		]);
		assert.equal(run.undoStops, 1, 'the continuation is its own undo step');
	});

	test('the line break is the document\'s, not a hard-coded \\n', () => {
		// The CRLF class of defect this repo has been bitten by before (#148): a
		// handler that writes '\n' into a CRLF document leaves one mixed line
		// behind, and nothing downstream reports it.
		const run = runEditorHandler(ENTER_HANDLER, {
			lines: ['1. item'],
			selections: [[1, 8, 1, 8]],
			eol: '\r\n',
		});
		assert.deepEqual(run.edits.map((edit) => edit.text), ['\r\n2. ']);
	});

	test('Enter on an empty item replaces the line instead of breaking it', () => {
		const run = runEditorHandler(ENTER_HANDLER, { lines: ['- ', 'x'], selections: [[1, 3, 1, 3]] });

		assert.deepEqual(run.triggers, []);
		assert.deepEqual(run.edits, [
			// The whole line, marker and all, becomes nothing — and the caret stays
			// on it. No line is added: this keystroke leaves the list, it does not
			// extend it.
			{ range: [1, 1, 1, 3], text: '', cursor: [1, 1, 1, 1] },
		]);
	});

	test('Enter on an empty nested item gives up one level instead of ending the list', () => {
		// #856: the list ends only from the margin. Below it, Enter is Shift+Tab —
		// the same `shiftListItem` edit, renumbering included.
		const bullet = runEditorHandler(ENTER_HANDLER, {
			lines: ['- a', '  - b', '  - '],
			selections: [[3, 5, 3, 5]],
		});
		assert.deepEqual(bullet.triggers, []);
		assert.deepEqual(bullet.edits, [{ range: [3, 1, 3, 5], text: '- ', cursor: [3, 3, 3, 3] }]);
		assert.equal(bullet.undoStops, 1);

		const ordered = runEditorHandler(ENTER_HANDLER, {
			lines: ['1. a', '   1. b', '   2. '],
			selections: [[3, 7, 3, 7]],
		});
		assert.deepEqual(ordered.edits, [{ range: [3, 1, 3, 7], text: '2. ', cursor: [3, 4, 3, 4] }]);

		const quoted = runEditorHandler(ENTER_HANDLER, {
			lines: ['> - a', '>   - '],
			selections: [[2, 7, 2, 7]],
		});
		assert.deepEqual(quoted.edits, [{ range: [2, 1, 2, 7], text: '> - ', cursor: [2, 5, 2, 5] }]);

		// At the margin there is no level left, so the list ends as before.
		const margin = runEditorHandler(ENTER_HANDLER, {
			lines: ['- a', '- '],
			selections: [[2, 3, 2, 3]],
		});
		assert.deepEqual(margin.edits, [{ range: [2, 1, 2, 3], text: '', cursor: [2, 1, 2, 1] }]);
	});

	test('Enter anywhere else is a plain Enter', () => {
		for (const lines of [['plain text'], ['---'], ['']]) {
			const run = runEditorHandler(ENTER_HANDLER, {
				lines,
				selections: [[1, lines[0].length + 1, 1, lines[0].length + 1]],
			});
			assert.deepEqual(run.edits, [], JSON.stringify(lines[0]));
			assert.deepEqual(run.triggers, ['type:"\\n"'], JSON.stringify(lines[0]));
		}
	});

	test('a quoted line continues in the editor too', () => {
		const run = runEditorHandler(ENTER_HANDLER, { lines: ['> quoted'], selections: [[1, 9, 1, 9]] });
		assert.deepEqual(run.triggers, []);
		assert.deepEqual(run.edits, [{ range: [1, 9, 1, 9], text: '\n> ', cursor: [2, 3, 2, 3] }]);
		assert.equal(run.undoStops, 1);

		const leaving = runEditorHandler(ENTER_HANDLER, { lines: ['> ', 'x'], selections: [[1, 3, 1, 3]] });
		assert.deepEqual(leaving.edits, [{ range: [1, 1, 1, 3], text: '', cursor: [1, 1, 1, 1] }]);
	});

	test('a selection, or a second caret, gets the plain Enter', () => {
		// One edit at the primary selection would silently discard what the other
		// carets were about to do.
		const spanning = runEditorHandler(ENTER_HANDLER, {
			lines: ['- item'],
			selections: [[1, 3, 1, 7]],
		});
		assert.deepEqual(spanning.edits, []);
		assert.deepEqual(spanning.triggers, ['type:"\\n"']);

		const multi = runEditorHandler(ENTER_HANDLER, {
			lines: ['- one', '- two'],
			selections: [
				[1, 6, 1, 6],
				[2, 6, 2, 6],
			],
		});
		assert.deepEqual(multi.edits, []);
		assert.deepEqual(multi.triggers, ['type:"\\n"']);
	});

	test('Tab on a list item is the list module’s edit, and Tab anywhere else is a Tab', () => {
		// The handler no longer sends `editor.action.indentLines`: that command moves
		// the line by `tabSize`, which is not a nesting level, and leaves the number
		// alone — both halves of #711. What it sends now is one `executeEdits` built
		// from `shiftListItem`, and nothing else, because a trigger AND an edit would
		// indent the line twice.
		const run = runEditorHandler(TAB_HANDLER, {
			lines: ['1. something', '2. ', '3. c'],
			selections: [[2, 4, 2, 4]],
		});
		assert.deepEqual(run.triggers, [], 'a core command fired as well as the edit');
		assert.deepEqual(run.edits, [{ range: [2, 1, 3, 5], text: '   1. \n2. c', cursor: [2, 7, 2, 7] }]);
		assert.equal(run.undoStops, 1, 'one Ctrl+Z must give the level back');

		// A LIST ITEM’S TAB NEVER FALLS THROUGH. The first item of a list has nothing
		// to nest under, so the key does nothing — handing it to `indentLines` would
		// indent a line that no longer nests anywhere, which is the state #711’s
		// reporter was left in.
		for (const line of ['- item', '  1. item', '> - [x] item', '- ']) {
			const alone = runEditorHandler(TAB_HANDLER, { lines: [line], selections: [[1, 3, 1, 3]] });
			assert.deepEqual(alone.triggers, [], line);
			assert.deepEqual(alone.edits, [], line);
		}

		for (const line of ['plain text', '# heading', '']) {
			const prose = runEditorHandler(TAB_HANDLER, { lines: [line], selections: [[1, 1, 1, 1]] });
			assert.deepEqual(prose.triggers, ['tab'], JSON.stringify(line));
		}

		// A selection spans lines on purpose or by accident; Monaco's own Tab
		// already indents every line of it.
		const selected = runEditorHandler(TAB_HANDLER, {
			lines: ['- one', '- two'],
			selections: [[1, 1, 2, 6]],
		});
		assert.deepEqual(selected.triggers, ['tab']);
	});

	test('Shift+Tab on a list item is the list’s level, not Monaco’s outdent', () => {
		const run = runEditorHandler(SHIFT_TAB_HANDLER, {
			lines: ['1. a', '   1. b', '   2. c'],
			selections: [[3, 10, 3, 10]],
		});
		assert.deepEqual(run.triggers, [], 'outdent fired as well as the edit');
		// It rejoins the list it left, so it is that list’s second item and not `1.`.
		assert.deepEqual(run.edits, [{ range: [3, 1, 3, 8], text: '2. c', cursor: [3, 7, 3, 7] }]);

		// Prose still gets Monaco’s own outdent.
		for (const line of ['plain text', '']) {
			const fallback = runEditorHandler(SHIFT_TAB_HANDLER, { lines: [line], selections: [[1, 1, 1, 1]] });
			assert.deepEqual(fallback.triggers, ['outdent'], JSON.stringify(line));
			assert.deepEqual(fallback.edits, [], JSON.stringify(line));
		}

		// A list item at the margin has no level to give up, and — like Tab’s first
		// item — does not fall through either. `outdent` on a line with no
		// indentation does nothing anyway; what the swallow rules out is the day a
		// list item carries indentation Monaco would happily eat a `tabSize` of,
		// leaving the item nested under nothing.
		const margin = runEditorHandler(SHIFT_TAB_HANDLER, { lines: ['1. a'], selections: [[1, 1, 1, 1]] });
		assert.deepEqual(margin.triggers, []);
		assert.deepEqual(margin.edits, []);
	});

	test('inside a fenced code block, Tab, Shift+Tab and Enter mean what they mean in code', () => {
		// `1. a` and `|a|bb|` inside ``` are code someone is writing, not a list or a
		// table; renumbering or re-aligning them rewrites the code.
		const table = ['```', '|a|bb|', '|-|-|', '|1|2|', '```'];
		const tab = runEditorHandler(TAB_HANDLER, { lines: table, selections: [[2, 2, 2, 2]] });
		assert.deepEqual(tab.edits, []);
		assert.deepEqual(tab.triggers, ['tab']);

		const list = ['~~~', '1. a', '2. b', '3. c', '~~~'];
		const nest = runEditorHandler(TAB_HANDLER, { lines: list, selections: [[3, 5, 3, 5]] });
		assert.deepEqual(nest.edits, []);
		assert.deepEqual(nest.triggers, ['tab']);
		// The first item used to swallow the key: nothing to nest under.
		const first = runEditorHandler(TAB_HANDLER, { lines: list, selections: [[2, 5, 2, 5]] });
		assert.deepEqual(first.triggers, ['tab']);

		const back = runEditorHandler(SHIFT_TAB_HANDLER, {
			lines: ['```', '1. a', '   1. b', '```'],
			selections: [[3, 8, 3, 8]],
		});
		assert.deepEqual(back.edits, []);
		assert.deepEqual(back.triggers, ['outdent']);

		const enter = runEditorHandler(ENTER_HANDLER, { lines: ['```', '- item', '```'], selections: [[2, 7, 2, 7]] });
		assert.deepEqual(enter.edits, []);
		assert.deepEqual(enter.triggers, ['type:"\\n"']);

		// …and below the closing fence the list is a list again.
		const after = runEditorHandler(ENTER_HANDLER, { lines: ['```', 'x', '```', '- item'], selections: [[4, 7, 4, 7]] });
		assert.deepEqual(after.edits.map((edit) => edit.text), ['\n- ']);
	});

	// ------------------------------------------------------------- the when clauses

	/** Guards that must stand in front of all three keys, and what owns the key without them. */
	const SHARED_GUARDS: Record<string, string> = {
		editorTextFocus: 'the find box and the rename input both take Enter, and neither is the text',
		'!editorReadonly': 'reading mode types nothing',
		'!suggestWidgetVisible':
			'Enter accepts a completion and Tab accepts a completion; this app has two completion providers, so the popup is a live case',
		'!inSnippetMode': 'Tab jumps to the next snippet placeholder, and so does Shift+Tab backwards',
	};

	test('the editing keys are registered, and behind every guard that owns them first', () => {
		// `bareCommands()` in ./keymapHarness.ts EVALUATES each `addCommand`
		// argument, so the keybinding numbers are Monaco's own and the `when` string
		// is the one the component computes.
		const calls = bareCommands();

		const enter = calls.filter((call) => call.binding === KeyCode.Enter);
		assert.equal(enter.length, 1, 'exactly one Enter binding');
		assert.equal(enter[0].handler, 'continueListOnEnter');

		const tab = calls.filter((call) => call.binding === KeyCode.Tab);
		assert.equal(tab.length, 1, 'exactly one plain-Tab binding');
		assert.equal(tab[0].handler, 'handleTabKey');

		const shiftTab = calls.filter((call) => call.binding === (KeyMod.Shift | KeyCode.Tab));
		assert.equal(shiftTab.length, 1, 'exactly one Shift+Tab binding');
		assert.equal(shiftTab[0].handler, 'handleShiftTabKey');

		for (const call of [enter[0], tab[0], shiftTab[0]]) {
			for (const [guard, why] of Object.entries(SHARED_GUARDS)) {
				assert.ok(
					call.when.split('&&').some((clause) => clause.trim() === guard),
					`${call.handler} is bound without ${guard}: ${why}. when = ${call.when}`,
				);
			}
		}

		// The extra guard both Tab keys need: the accessibility toggle exists so that
		// Tab leaves the editor, and a binding at weight 1000 would take that away.
		for (const call of [tab[0], shiftTab[0]]) {
			assert.ok(
				call.when.includes('!editorTabMovesFocus'),
				`${call.handler} is bound without !editorTabMovesFocus: ${call.when}`,
			);
		}
	});

	test('Shift+Tab still means outdent everywhere except inside a table', () => {
		// THE DECISION THIS TEST GUARDS, AND HOW IT CHANGED.
		//
		// When the list keys landed, Shift+Tab was deliberately left unbound: Monaco's
		// `outdent` already had the chord and already did the right thing, so a
		// wrapper in front of it would have been a second name for a key that was
		// already right. This test then asserted that no Shift+Tab command existed,
		// and said in its own failure message that one may only appear if it does more
		// than outdent.
		//
		// Tables were the first "more": there is no core command for "previous cell".
		// #711 is the second — a level is not a `tabSize`, and an item that leaves a
		// sub-list has to take the number of the list it rejoins. So the binding
		// exists now, and what is pinned instead is the SAME decision two branches in:
		// the handler's LAST path re-sends `outdent` rather than reimplementing it, so
		// a code block, a paragraph and an item already at the margin all still get
		// exactly Monaco's own behaviour.
		const handler = functionSource(readSource(EDITOR), 'handleShiftTabKey');
		assert.match(
			handler,
			/trigger\([^)]*"outdent"/,
			'the Shift+Tab handler no longer falls through to Monaco\'s outdent',
		);

		// …and the claim that rests on, pinned against the installed Monaco rather
		// than assumed: `outdent` is the command Shift+Tab means, in the editor, when
		// Tab is not moving focus. If Monaco ever renames or re-chords it, the
		// fall-through above becomes a no-op and this is what says so.
		const core = readSource(
			new URL('../node_modules/monaco-editor/esm/vs/editor/browser/coreCommands.js', import.meta.url),
		);
		const outdent = core.slice(core.indexOf("id: 'outdent'"), core.indexOf("id: 'tab'"));
		assert.match(outdent, /KeyMod\.Shift \*\/ \| 2 \/\* KeyCode\.Tab/);
		assert.match(outdent, /EditorContextKeys\.editorTextFocus, EditorContextKeys\.tabDoesNotMoveFocus/);
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
 * `when` clauses that decide it are pinned in `listContinuation.test.ts`, which
 * owns the other half of the same two keys.
 */
describe('table keys in the editor', () => {
	/** The table Markpad's own Insert Table command writes, once. */
	const INSERTED = [
		'| Header | Header | Header |',
		'| --- | --- | --- |',
		'| Cell | Cell | Cell |',
		'| Cell | Cell | Cell |',
	];

	// --------------------------------------------- the handlers, actually run

	/**
	 * The two dispatchers and everything they route through, entry point last.
	 *
	 * Naming the collaborators is what keeps this honest: a stub `stepTableCell`
	 * would let a Tab handler that had stopped looking at tables pass.
	 */
	const TAB = ['soleCaret', 'applyLineEdit', 'stepTableCell', 'shiftListLevel', 'handleTabKey'];

	const SHIFT_TAB = ['soleCaret', 'applyLineEdit', 'stepTableCell', 'shiftListLevel', 'handleShiftTabKey'];

	const MOD_ENTER = ['soleCaret', 'applyLineEdit', 'editTable', 'handleModEnterKey'];

	const MOD_SHIFT_ENTER = ['soleCaret', 'applyLineEdit', 'editTable', 'handleModShiftEnterKey'];

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
		// It still MOVES: from the start of `a` to the end of it, which is where every
		// landing in a cell now is.
		assert.deepEqual(run.selections, [[1, 4, 1, 4]]);
	});

	test('Shift+Tab outside a table and outside a list is Monaco’s own outdent', () => {
		for (const line of ['plain text', '']) {
			const run = runEditorHandler(SHIFT_TAB, { lines: [line], selections: [[1, 1, 1, 1]] });
			assert.deepEqual(run.triggers, ['outdent'], JSON.stringify(line));
			assert.deepEqual(run.edits, [], JSON.stringify(line));
		}

		// A list item stopped falling through with #711: `outdent` moves the line by
		// `tabSize`, which lands on a level only by coincidence, and it renumbers
		// nothing. The middle branch owns it now — table, then list, then the key.
		const item = runEditorHandler(SHIFT_TAB, {
			lines: ['  - a nested list item'],
			selections: [[1, 1, 1, 1]],
		});
		assert.deepEqual(item.triggers, []);
		assert.deepEqual(item.edits, [{ range: [1, 1, 1, 23], text: '- a nested list item', cursor: [1, 1, 1, 1] }]);
	});

	test('Tab on a list item is still the list’s Tab, and Tab in prose is still a Tab', () => {
		// The dispatch order this feature had to fit into: table, then list, then the
		// key's own meaning. #636 owns the middle branch and must not have moved.
		// #711 changed what the middle branch DOES — one `executeEdits` from
		// `shiftListItem` instead of `editor.action.indentLines` — but not where it
		// sits, which is what this file is about.
		const list = runEditorHandler(TAB, { lines: ['- a', '- item'], selections: [[2, 3, 2, 3]] });
		assert.deepEqual(list.triggers, []);
		assert.deepEqual(list.edits, [{ range: [2, 1, 2, 7], text: '  - item', cursor: [2, 5, 2, 5] }]);

		const prose = runEditorHandler(TAB, { lines: ['plain text'], selections: [[1, 1, 1, 1]] });
		assert.deepEqual(prose.triggers, ['tab']);
	});

	/*
	 * Mod+Enter and Mod+Shift+Enter: "insert a line below / above", one Markdown
	 * rule further on.
	 *
	 * These are Monaco's own `editor.action.insertLineAfter` and
	 * `insertLineBefore`, and the reason they are the right keys for a table row is
	 * that they keep meaning exactly what they already meant — inside a table, the
	 * line below IS the row below. The row verbs used to live on `Mod+K R`, which
	 * the user's verdict was 太难按: a two-key chord for the commonest table edit.
	 */

	test('Mod+Enter in a table inserts a row below and does not also insert a line', () => {
		const run = runEditorHandler(MOD_ENTER, { lines: [...INSERTED], selections: [[3, 3, 3, 3]] });

		assert.deepEqual(run.triggers, [], "Monaco's own insertLineAfter must not fire as well");
		assert.equal(run.undoStops, 1);
		assert.deepEqual(run.edits, [
			{
				range: [1, 1, 4, 23],
				text: [
					'| Header | Header | Header |',
					'| ------ | ------ | ------ |',
					'| Cell   | Cell   | Cell   |',
					'|        |        |        |',
					'| Cell   | Cell   | Cell   |',
				].join('\n'),
				cursor: [4, 3, 4, 3],
			},
		]);
	});

	test('Mod+Shift+Enter in a table inserts a row above', () => {
		// Same caret as the test above, so the two keys are told apart by WHERE the
		// new row goes: above the first body row rather than below it.
		const run = runEditorHandler(MOD_SHIFT_ENTER, { lines: [...INSERTED], selections: [[3, 3, 3, 3]] });
		assert.deepEqual(run.triggers, []);
		assert.deepEqual(run.edits[0].text.split('\n')[2], '|        |        |        |');
		assert.deepEqual(run.edits[0].cursor, [3, 3, 3, 3]);
	});

	test('outside a table both keys are Monaco’s own, unchanged', () => {
		// THE FALL-THROUGH IS THE POINT, the same as Shift+Tab's. These two chords
		// already had a meaning; this feature specialises it inside a table and hands
		// the key straight back everywhere else.
		for (const line of ['plain text', '- a list item', '']) {
			assert.deepEqual(
				runEditorHandler(MOD_ENTER, { lines: [line], selections: [[1, 1, 1, 1]] }).triggers,
				['editor.action.insertLineAfter'],
				JSON.stringify(line),
			);
			assert.deepEqual(
				runEditorHandler(MOD_SHIFT_ENTER, { lines: [line], selections: [[1, 1, 1, 1]] }).triggers,
				['editor.action.insertLineBefore'],
				JSON.stringify(line),
			);
		}
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
describe('heading link completion wiring', () => {
	const editorSource = readSource(new URL('../src/lib/components/Editor.svelte', import.meta.url));

	const rustSource = readRustBackend();

	/* ---------------------------------------------------------------- wiring */

	test('the heading context is asked before the path context, which shares its prefix', () => {
		// `](#` also satisfies the embed test — `/!?\[.*\]\($/` matches everything
		// up to the paren. Asking for files first would answer a `#` with a list of
		// filenames.
		const heading = editorSource.indexOf('const headingContext = headingLinkContext(prefix)');
		const embed = editorSource.indexOf('const isEmbedContext =');
		assert.ok(heading > 0 && embed > 0);
		assert.ok(heading < embed);
		// And `#` has to open the dropdown, or the reader types it and nothing
		// happens until the next character.
		assert.match(editorSource, /triggerCharacters: \["\(", "\/", "\\\\", '"', "#"\]/);
	});

	test('each context writes the text its own syntax resolves', () => {
		assert.match(
			editorSource,
			/insertText:\s*\n?\s*headingContext === "slug" \? anchor\.slug : anchor\.text/,
		);
		// Labelled by the heading, so typing a word of it finds the entry whatever
		// the slug turned that word into.
		assert.match(editorSource, /label: anchor\.text/);
		assert.match(editorSource, /detail: `#\$\{anchor\.slug\}`/);
	});

	test('the list is read from Rust, and re-read only when the buffer changes', () => {
		// A second anchorizer written in TypeScript would drift from comrak's
		// without anything failing — the links would simply stop landing.
		assert.match(editorSource, /const markdown = model\.getValue\(\);\s*const outline = \(\s*invoke\("markdown_outline", \{\s*markdown,/);
		assert.match(rustSource, /async fn markdown_outline\(\s*markdown: String,/);
		// Completion fires per keystroke while the dropdown is open; the headings
		// cannot have moved between two keystrokes of one edit. Keyed on the model
		// too, because version ids are counted per model and each tab has its own.
		assert.match(editorSource, /if \(outlineCache\?\.model === model && outlineCache\.version === version\) return outlineCache\.outline;/);
	});

	// The folding provider and the sticky-scroll symbols ask for the same version
	// together, and each ask sends the whole buffer to Rust to be parsed.
	test('two asks for one version share one Rust call', async () => {
		const lift = (name: string) => {
			try {
				return functionSource(editorSource, name);
			} catch {
				return '';
			}
		};
		const calls: string[] = [];
		const invoke = async (cmd: string) => {
			calls.push(cmd);
			return cmd === 'markdown_outline' ? { anchors: [], folds: [] } : [];
		};
		const headingAnchors = new Function(
			'invoke',
			'frontMatterFenceLines',
			ts.transpileModule(
				`let anchorCache = null;\nlet outlineCache = null;\n${lift('documentOutline')}\n${lift('headingAnchors')}\nreturn headingAnchors;`,
				{ compilerOptions: { target: ts.ScriptTarget.ES2022 } },
			).outputText,
		)(invoke, () => 0) as (model: unknown) => Promise<unknown>;
		const model = { getVersionId: () => 1, getValue: () => '# A\n' };

		await Promise.all([headingAnchors(model), headingAnchors(model)]);
		assert.equal(calls.length, 1, `one version, ${calls.length} calls: ${calls.join(', ')}`);
	});

	test('the Rust side numbers repeated headings the way the renderer does', () => {
		// One anchorizer for the document, not one per heading: a second
		// "Objectives" is `objectives-1`, and offering the bare slug for it would
		// link to the first section. `heading_anchor_id` stays fresh per lookup on
		// purpose — that one answers a wikilink, which names a heading by text.
		assert.match(rustSource, /let mut anchorizer = Anchorizer::new\(\);[\s\S]{0,900}?anchorizer\.anchorize\(&text\)/);
		assert.match(rustSource, /fn heading_anchor_id\(target: &str\) -> String \{\s*\n\s*Anchorizer::new\(\)/);
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
describe('copy reference wiring', () => {
	const viewerSource = readSource(new URL('../src/lib/MarkdownViewer.svelte', import.meta.url));

	/* ---------------------------------------------------------------- the wiring */

	test('all three Copy Reference entries call the one helper', () => {
		// The preview's heading menu, the outline's right-click, and the outline's
		// context menu. All three built the string inline before, which is how they
		// came to disagree about the filename in the first place. What the helper
		// writes runs in editing.test.ts ("copy reference wiring"); this pins
		// that there is no second builder.
		assert.equal((viewerSource.match(/copyHeadingReference\(/g) ?? []).length, 4, 'one helper, three callers');
	});
});

// #675: Monaco draws the find widget's button tooltips into a `.context-view`
// it appends beside the editor, above the target, and the widget sits at the
// top edge of the editor pane — so the tooltip lands in the strip the pane and
// `.editor-outer` clip away, and behind the fixed title bar.
//
// Both halves of the fix are invisible to the compiler and to any test that
// runs the app without a real layout: one is a CSS clip that has to be dropped
// on *both* boxes, the other is a z-index that only works while it stays above
// the title bar's. The second is a coupling between two rules in two files —
// raise `.custom-title-bar`'s z-index and the tooltip silently goes back under
// it, with nothing failing.
describe('find widget tooltip clip', () => {
	const styles = readSource('src/styles.css');

	const titleBar = readSource('src/lib/components/TitleBar.svelte');

	const fixBlock = sliceFrom(styles, ".pane.editor-pane:has(.find-widget.visible)");

	function zIndexOf(source: string, selector: string): number {
		// Line-anchored: `.context-view` is also named in the prose above the rule,
		// and a loose match starts there and runs into the wrong declaration block.
		const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
		const rule = source.match(new RegExp(`^\\s*${escaped}[^{}]*\\{([^}]*)\\}`, 'm'));
		assert.ok(rule, `expected a rule for ${selector}`);
		const declaration = rule[1].match(/(?<![\w-])z-index:\s*(\d+)/);
		assert.ok(declaration, `expected a z-index on ${selector}`);
		return Number(declaration[1]);
	}

	test('the find widget tooltip escapes both clips, and only while the widget is up', () => {
		// Not `overflow: clip` with a margin: WebKit ships `clip` without
		// `overflow-clip-margin`, so that spelling is a no-op on macOS and Linux.
		assert.match(fixBlock, /\.pane\.editor-pane:has\(\.find-widget\.visible\),\s*\n\s*\.pane\.editor-pane:has\(\.find-widget\.visible\) \.editor-outer \{\s*\n\s*overflow: visible;/);
	});

	test('the tooltip outranks the title bar it now paints over', () => {
		const contextView = zIndexOf(styles, '.context-view');
		const titleBarZ = zIndexOf(titleBar, '.custom-title-bar');
		assert.ok(
			contextView > titleBarZ,
			`.context-view (${contextView}) must stay above .custom-title-bar (${titleBarZ})`,
		);
		// Monaco writes `z-index: 2576` inline on the node, so the rule only lands
		// if it is marked important.
		assert.match(styles, /\.context-view \{\s*\n\s*z-index: \d+ !important;/);
	});
});

describe('front matter in the editor', () => {
	// Split view hands scroll positions across as "inside the front matter" or
	// "this line of the body", so both panes have to agree on where the front
	// matter ends. The preview's answer is parseFrontMatter's. The editor used to
	// scan for any two `---` lines on its own, so a document opening with a
	// thematic break told the preview it was inside a front matter panel the
	// preview did not have, and the preview stayed at the top until the editor
	// scrolled past the second rule.
	test('the editor finds the end of the front matter through parseFrontMatter too', () => {
		const leadingRule = `---\n\n${Array.from({ length: 40 }, (_, i) => `Paragraph ${i + 1}.`).join('\n\n')}\n\n---\n\n# Next\n`;
		assert.equal(frontMatterLineOffset(leadingRule), 0);

		const editor = readSource('src/lib/components/Editor.svelte');
		const scrollEnd = functionSource(editor, 'getEditorFrontMatterScrollEnd');
		assert.match(scrollEnd, /frontMatterLineOffset\(/);
		assert.doesNotMatch(editor, /\.trim\(\) !== '---'/);
	});

	// Split view asks for it on every scroll event, and it costs a copy of the
	// buffer plus a YAML parse: once per document version is enough.
	test('the editor parses the front matter once per document version, not per scroll event', () => {
		const scrollEnd = functionSource(readSource('src/lib/components/Editor.svelte'), 'getEditorFrontMatterScrollEnd');
		const run = new Function(
			'editor',
			'frontMatterLineOffset',
			'getEditorContentScrollMax',
			ts.transpileModule(`let frontMatterOffsetCache = null;\n${scrollEnd}\nreturn getEditorFrontMatterScrollEnd;`, {
				compilerOptions: { target: ts.ScriptTarget.ES2022 },
			}).outputText,
		);
		let version = 1;
		let reads = 0;
		const model = {
			getVersionId: () => version,
			getValue: () => (reads++, '---\ntitle: x\n---\n\n# Body\n'),
			getLineCount: () => 6,
		};
		const editor = {
			getModel: () => model,
			getTopForLineNumber: (line: number) => line * 10,
		};
		const scrollEndOf = run(editor, frontMatterLineOffset, () => 1000) as () => number;

		assert.equal(scrollEndOf(), 50);
		scrollEndOf();
		assert.equal(reads, 1, 'the buffer was re-read and re-parsed at the same version');
		version = 2;
		scrollEndOf();
		assert.equal(reads, 2, 'an edit must invalidate it');
	});

	// The editor's analyses (headings, folds, colours) run in Rust on the whole
	// buffer and blank the front matter lines first, so the closing `---` does not
	// underline the YAML into a heading. Rust used to find those lines itself, with
	// any two leading `---` lines, and blanked a thematic break plus the prose
	// under it that the preview renders. Now it is told, by the same rule.
	test('the editor tells Rust how many lines the front matter spans, fence to fence', () => {
		const leadingRule = '---\n\n# Title\n\nSome intro text.\n\n---\n\n## Part 2\n';
		assert.equal(frontMatterFenceLines(leadingRule), 0);
		assert.equal(frontMatterFenceLines('# Plain\n'), 0);
		assert.equal(frontMatterFenceLines('---\ntitle: x\ntags: [a]\n---\n\n# Body\n'), 4);
		assert.equal(frontMatterFenceLines('\uFEFF--- \r\ntitle: x\r\n  ---\r\n# Body\r\n'), 3);
		assert.equal(frontMatterFenceLines('---\n---\n'), 2);
		// No newline after the closing fence: it is still one of the lines.
		assert.equal(frontMatterFenceLines('---\ntitle: x\n---'), 3);
		// Malformed is still front matter: the preview strips it too.
		assert.equal(frontMatterFenceLines('---\ntitle: [broken\n---\n'), 3);

		const editor = readSource('src/lib/components/Editor.svelte');
		const tokens = readSource('src/lib/utils/semanticTokens.ts');
		for (const [source, command] of [
			[editor, 'markdown_outline'],
			[tokens, 'markdown_semantic_spans'],
		]) {
			const call = source.slice(source.indexOf(`invoke(${source === editor ? '"' : "'"}${command}`));
			assert.match(call.slice(0, call.indexOf('}')), /frontMatterLines: frontMatterFenceLines\(/, command);
		}
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
describe('wikilink extension and reference contracts', () => {
	const rustSource = readRustBackend();

	const referenceSource = readSource(new URL('../src/lib/utils/headingReference.ts', import.meta.url));

	test('the extension list the rewriter mirrors still matches markdownLinks.ts', () => {
		// The last cross-language copy of this list. Every TypeScript reader — the
		// sanitizer's URI pattern, the export's `.md` -> `.html` rewrite, the Open
		// dialog filter — now imports MARKDOWN_LINK_EXTENSIONS from markdownLinks.ts,
		// so a drift between two of them is no longer expressible. Rust cannot
		// import it, so the drift is caught here instead, by reading the array back
		// out of the source and comparing the two *sets*: a third-party extension
		// added to either side alone fails, in whichever direction it was added.
		const declared = rustSource.match(/const MARKDOWN_LINK_EXTENSIONS: \[&str; \d+\] = \[([^\]]*)\]/);
		assert.notEqual(declared, null, 'MARKDOWN_LINK_EXTENSIONS disappeared from the Rust backend');
		const extensions = [...declared![1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
		assert.deepEqual(
			[...extensions].sort(),
			[...MARKDOWN_LINK_EXTENSIONS].sort(),
			'the Rust and TypeScript extension lists disagree — add the extension to both',
		);
		for (const extension of extensions) {
			assert.equal(hasMarkdownLinkExtension(`file.${extension}`), true, extension);
		}
	});

	test('every wikilink Copy Reference builds carries the heading the rewriter needs', () => {
		// The rewriter only rewrites heading-bearing forms; a bare `[[Notes]]` stays
		// literal text (see the scope note above). So the contract is that *every*
		// `[[...]]` the viewer writes to the clipboard contains a `#`.
		//
		// Asserted that way round rather than as "three call sites match
		// `[[${fn}#${...}]]`". That form hard-coded the local variable names holding
		// the basename — renaming `fn` broke it — and the count, so adding a fourth
		// correct Copy Reference entry failed while replacing one of the three with a
		// broken bare form still left three matches and passed.
		// The string moved: all three entries build it through `headingReference`,
		// which picks the spelling the document is already written in (see
		// `copyReferenceStyle.test.ts`). The contract this test exists for is
		// unchanged — a wikilink Copy Reference writes always carries a `#`,
		// because the rewriter leaves a bare `[[Notes]]` as literal text — so it
		// is asserted where the string is now built.
		// Code lines only: the doc comment above the function spells `[[…]]` out
		// in prose, and prose is not something Copy Reference writes.
		const code = referenceSource
			.split('\n')
			.filter((line) => !/^\s*(\*|\/\/)/.test(line))
			.join('\n');
		const emitted = [...code.matchAll(/`\[\[[^`]*\]\]`/g)].map((match) => match[0]);
		assert.ok(emitted.length > 0, 'Copy Reference no longer builds a wikilink — has the format moved?');
		for (const wikilink of emitted) {
			assert.match(
				wikilink,
				/#/,
				`${wikilink}: a wikilink without a heading is left as literal text by process_wikilinks()`,
			);
		}
	});
});
