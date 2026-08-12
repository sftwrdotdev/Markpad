import assert from 'node:assert/strict';
import test from 'node:test';

import { KeyCode } from 'monaco-editor/esm/vs/editor/common/standalone/standaloneEnums.js';
import { KeyMod } from 'monaco-editor/esm/vs/editor/common/services/editorBaseApi.js';

import { listEnter, parseListItem } from '../src/lib/utils/listEditing.js';
import { bareCommands, runEditorHandler } from './keymapHarness.js';
import { functionSource, readSource } from './sourceTree.js';

/*
 * Issue #604's second item: Enter on a list item continues the list, Tab
 * changes its level, and Enter on an empty item ends the list.
 *
 * WHAT IS RUN AND WHAT IS ONLY READ
 *
 * The decision — "given this line and this caret, what should the next line
 * say" — is a pure function in `src/lib/utils/listEditing.ts` and is CALLED
 * here, once per shape of list item the app claims to understand.
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

/** `listEnter` at the end of `line`, which is where Enter is normally pressed. */
function enterAtEnd(line: string) {
	return listEnter(line, line.length + 1);
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
		'> quoted prose',
		'    indented code',
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

test('a caret still inside the marker gets the ordinary Enter', () => {
	// Enter at the very start of `- item` means "make room above me". A
	// continuation there would write a second marker in front of the first.
	assert.equal(listEnter('- item', 1), null);
	assert.equal(listEnter('- item', 2), null);
	assert.deepEqual(listEnter('- item', 3), { kind: 'continue', text: '- ' });
	assert.equal(listEnter('  - [ ] item', 8), null);
	assert.deepEqual(listEnter('  - [ ] item', 9), { kind: 'continue', text: '  - [ ] ' });
});

test('a caret in the middle of an item still continues the list', () => {
	// Splitting an item is continuing it: the tail moves down behind the new
	// marker, which is what every editor does and what the caller relies on.
	assert.deepEqual(listEnter('- hello world', 9), { kind: 'continue', text: '- ' });
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

const TAB_HANDLER = ['soleCaret', 'applyTableEdit', 'stepTableCell', 'handleTabKey'];

test('Enter on a list item inserts the line break and the next marker in one edit', () => {
	const run = runEditorHandler(['continueListOnEnter'], { lines: ['- item'], selections: [[1, 7, 1, 7]] });

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
	const run = runEditorHandler(['continueListOnEnter'], {
		lines: ['1. item'],
		selections: [[1, 8, 1, 8]],
		eol: '\r\n',
	});
	assert.deepEqual(run.edits.map((edit) => edit.text), ['\r\n2. ']);
});

test('Enter on an empty item replaces the line instead of breaking it', () => {
	const run = runEditorHandler(['continueListOnEnter'], { lines: ['- ', 'x'], selections: [[1, 3, 1, 3]] });

	assert.deepEqual(run.triggers, []);
	assert.deepEqual(run.edits, [
		// The whole line, marker and all, becomes nothing — and the caret stays
		// on it. No line is added: this keystroke leaves the list, it does not
		// extend it.
		{ range: [1, 1, 1, 3], text: '', cursor: [1, 1, 1, 1] },
	]);
});

test('Enter anywhere else is a plain Enter', () => {
	for (const lines of [['plain text'], ['---'], ['']]) {
		const run = runEditorHandler(['continueListOnEnter'], {
			lines,
			selections: [[1, lines[0].length + 1, 1, lines[0].length + 1]],
		});
		assert.deepEqual(run.edits, [], JSON.stringify(lines[0]));
		assert.deepEqual(run.triggers, ['type:"\\n"'], JSON.stringify(lines[0]));
	}
});

test('a selection, or a second caret, gets the plain Enter', () => {
	// One edit at the primary selection would silently discard what the other
	// carets were about to do.
	const spanning = runEditorHandler(['continueListOnEnter'], {
		lines: ['- item'],
		selections: [[1, 3, 1, 7]],
	});
	assert.deepEqual(spanning.edits, []);
	assert.deepEqual(spanning.triggers, ['type:"\\n"']);

	const multi = runEditorHandler(['continueListOnEnter'], {
		lines: ['- one', '- two'],
		selections: [
			[1, 6, 1, 6],
			[2, 6, 2, 6],
		],
	});
	assert.deepEqual(multi.edits, []);
	assert.deepEqual(multi.triggers, ['type:"\\n"']);
});

test('Tab on a list item indents the line; Tab anywhere else is a Tab', () => {
	// `editor.action.indentLines` moves the whole line by one level wherever the
	// caret is on it; the core `tab` command inserts indentation AT the caret,
	// which inside an item's text would be a tab character in the sentence.
	for (const line of ['- item', '  1. item', '> - [x] item', '- ']) {
		const run = runEditorHandler(TAB_HANDLER, { lines: [line], selections: [[1, 3, 1, 3]] });
		assert.deepEqual(run.triggers, ['editor.action.indentLines'], line);
		assert.deepEqual(run.edits, [], line);
	}

	for (const line of ['plain text', '# heading', '']) {
		const run = runEditorHandler(TAB_HANDLER, { lines: [line], selections: [[1, 1, 1, 1]] });
		assert.deepEqual(run.triggers, ['tab'], JSON.stringify(line));
	}

	// A selection spans lines on purpose or by accident; Monaco's own Tab
	// already indents every line of it.
	const selected = runEditorHandler(TAB_HANDLER, {
		lines: ['- one', '- two'],
		selections: [[1, 1, 2, 6]],
	});
	assert.deepEqual(selected.triggers, ['tab']);
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
	// Tables are that "more": there is no core command for "previous cell". So the
	// binding exists now, and what is pinned instead is the SAME decision one
	// level in — the handler's non-table path re-sends `outdent` rather than
	// reimplementing it, so a list item, a code block and a paragraph all still
	// get exactly Monaco's own behaviour.
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
