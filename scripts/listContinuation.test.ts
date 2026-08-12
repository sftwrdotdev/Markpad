import assert from 'node:assert/strict';
import test from 'node:test';

import { KeyCode } from 'monaco-editor/esm/vs/editor/common/standalone/standaloneEnums.js';
import { KeyMod } from 'monaco-editor/esm/vs/editor/common/services/editorBaseApi.js';
import ts from 'typescript';

import { listEnter, parseListItem } from '../src/lib/utils/listEditing.js';
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

const EDITOR = 'src/lib/components/Editor.svelte';

type Recorded = {
	triggers: string[];
	edits: Array<{ range: number[]; text: string; cursor: number[] }>;
	undoStops: number;
};

class FakeRange {
	constructor(
		readonly startLineNumber: number,
		readonly startColumn: number,
		readonly endLineNumber: number,
		readonly endColumn: number,
	) {}
	isEmpty() {
		return this.startLineNumber === this.endLineNumber && this.startColumn === this.endColumn;
	}
	numbers() {
		return [this.startLineNumber, this.startColumn, this.endLineNumber, this.endColumn];
	}
}

/**
 * One of the two component handlers, extracted and evaluated with a stub editor.
 *
 * The list logic in scope is the REAL module, so a handler that stopped calling
 * it — or called it with the wrong column — fails here rather than passing
 * against a second, more agreeable copy.
 */
function runHandler(
	name: string,
	options: { lines: string[]; selections: number[][]; eol?: string },
): Recorded {
	const recorded: Recorded = { triggers: [], edits: [], undoStops: 0 };
	const eol = options.eol ?? '\n';
	const selections = options.selections.map((s) => new FakeRange(s[0], s[1], s[2], s[3]));

	const model = {
		getLineContent: (line: number) => options.lines[line - 1],
		getLineMaxColumn: (line: number) => options.lines[line - 1].length + 1,
		getEOL: () => eol,
	};

	const scope: Record<string, unknown> = {
		listEnter,
		parseListItem,
		monaco: { Range: FakeRange, Selection: FakeRange },
		editor: {
			getModel: () => model,
			getSelections: () => selections,
			pushUndoStop: () => {
				recorded.undoStops += 1;
			},
			trigger: (_source: string, handlerId: string, payload: { text?: string } | null) => {
				recorded.triggers.push(payload?.text ? `${handlerId}:${JSON.stringify(payload.text)}` : handlerId);
			},
			executeEdits: (
				_source: string,
				edits: Array<{ range: FakeRange; text: string }>,
				cursor: FakeRange[],
			) => {
				for (const [index, edit] of edits.entries()) {
					recorded.edits.push({
						range: edit.range.numbers(),
						text: edit.text,
						cursor: cursor[index].numbers(),
					});
				}
			},
		},
	};

	const js = ts.transpileModule(`const handler = ${functionSource(readSource(EDITOR), name)};`, {
		compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
	}).outputText;
	const build = new Function('scope', `with (scope) { ${js}\nreturn handler; }`) as (
		s: unknown,
	) => () => void;
	build(new Proxy(scope, { has: () => true }))();

	return recorded;
}

test('Enter on a list item inserts the line break and the next marker in one edit', () => {
	const run = runHandler('continueListOnEnter', { lines: ['- item'], selections: [[1, 7, 1, 7]] });

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
	const run = runHandler('continueListOnEnter', {
		lines: ['1. item'],
		selections: [[1, 8, 1, 8]],
		eol: '\r\n',
	});
	assert.deepEqual(run.edits.map((edit) => edit.text), ['\r\n2. ']);
});

test('Enter on an empty item replaces the line instead of breaking it', () => {
	const run = runHandler('continueListOnEnter', { lines: ['- ', 'x'], selections: [[1, 3, 1, 3]] });

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
		const run = runHandler('continueListOnEnter', {
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
	const spanning = runHandler('continueListOnEnter', {
		lines: ['- item'],
		selections: [[1, 3, 1, 7]],
	});
	assert.deepEqual(spanning.edits, []);
	assert.deepEqual(spanning.triggers, ['type:"\\n"']);

	const multi = runHandler('continueListOnEnter', {
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
		const run = runHandler('indentListItemOnTab', { lines: [line], selections: [[1, 3, 1, 3]] });
		assert.deepEqual(run.triggers, ['editor.action.indentLines'], line);
		assert.deepEqual(run.edits, [], line);
	}

	for (const line of ['plain text', '# heading', '']) {
		const run = runHandler('indentListItemOnTab', { lines: [line], selections: [[1, 1, 1, 1]] });
		assert.deepEqual(run.triggers, ['tab'], JSON.stringify(line));
	}

	// A selection spans lines on purpose or by accident; Monaco's own Tab
	// already indents every line of it.
	const selected = runHandler('indentListItemOnTab', {
		lines: ['- one', '- two'],
		selections: [[1, 1, 2, 6]],
	});
	assert.deepEqual(selected.triggers, ['tab']);
});

// ------------------------------------------------------------- the when clauses

/**
 * Every `editor.addCommand(binding, handler, when)` the component registers, as
 * the values Monaco is handed.
 *
 * The arguments are EVALUATED, not matched as text: the keybinding numbers come
 * from Monaco's real `KeyMod`/`KeyCode` and the `when` expression is the string
 * the component computes, template literal and shared constant included. So
 * renaming the constant or reflowing the call changes nothing here; changing a
 * key or dropping a guard changes everything.
 */
function addCommandCalls(): Array<{ binding: number; handler: string; when: string }> {
	const text = readSource(EDITOR);
	const script = text.slice(text.indexOf('>', text.indexOf('<script')) + 1, text.indexOf('</script>'));
	const file = ts.createSourceFile('editor.ts', script, ts.ScriptTarget.ES2022, true);

	const constants: Record<string, string> = {};
	const calls: Array<{ binding: number; handler: string; when: string }> = [];

	const evaluate = (expression: string): unknown =>
		new Function('monaco', 'constants', `with (constants) { return (${expression}); }`)(
			{ KeyMod, KeyCode },
			constants,
		);

	const visit = (node: ts.Node) => {
		if (
			ts.isVariableDeclaration(node) &&
			ts.isIdentifier(node.name) &&
			node.initializer &&
			(ts.isStringLiteral(node.initializer) || ts.isTemplateExpression(node.initializer))
		) {
			// Best effort: the component is full of template literals built from
			// component state (`${label}px`), and none of them is a `when` clause.
			// One that fails to evaluate here is simply not a constant the calls
			// below can be reading, and an argument that turns out to need it
			// fails loudly at its own `evaluate`.
			try {
				constants[node.name.text] = String(evaluate(node.initializer.getText()));
			} catch {
				/* not a constant */
			}
		}

		if (
			ts.isCallExpression(node) &&
			node.expression.getText() === 'editor.addCommand' &&
			node.arguments.length === 3
		) {
			calls.push({
				binding: evaluate(node.arguments[0].getText()) as number,
				handler: node.arguments[1].getText(),
				when: String(evaluate(node.arguments[2].getText())),
			});
		}

		ts.forEachChild(node, visit);
	};
	visit(file);

	assert.ok(calls.length >= 4, `found ${calls.length} addCommand calls; the extraction is not running`);
	return calls;
}

/** Guards that must stand in front of BOTH keys, and what owns the key without them. */
const SHARED_GUARDS: Record<string, string> = {
	editorTextFocus: 'the find box and the rename input both take Enter, and neither is the text',
	'!editorReadonly': 'reading mode types nothing',
	'!suggestWidgetVisible':
		'Enter accepts a completion and Tab accepts a completion; this app has two completion providers, so the popup is a live case',
	'!inSnippetMode': 'Tab jumps to the next snippet placeholder',
};

test('the list keys are registered, and behind every guard that owns them first', () => {
	const calls = addCommandCalls();

	const enter = calls.filter((call) => call.binding === KeyCode.Enter);
	assert.equal(enter.length, 1, 'exactly one Enter binding');
	assert.equal(enter[0].handler, 'continueListOnEnter');

	const tab = calls.filter((call) => call.binding === KeyCode.Tab);
	assert.equal(tab.length, 1, 'exactly one plain-Tab binding');
	assert.equal(tab[0].handler, 'indentListItemOnTab');

	for (const call of [enter[0], tab[0]]) {
		for (const [guard, why] of Object.entries(SHARED_GUARDS)) {
			assert.ok(
				call.when.split('&&').some((clause) => clause.trim() === guard),
				`${call.handler} is bound without ${guard}: ${why}. when = ${call.when}`,
			);
		}
	}

	// Tab's own extra guard: the accessibility toggle exists so that Tab leaves
	// the editor, and a binding at weight 1000 would take that away.
	assert.ok(
		tab[0].when.includes('!editorTabMovesFocus'),
		`Tab is bound without !editorTabMovesFocus: ${tab[0].when}`,
	);
});

test('Shift+Tab is left to Monaco, which already outdents the line', () => {
	// The deliberate omission, stated rather than left implicit. A wrapper in
	// front of `outdent` would be a second name for a key that is already right.
	const shiftTab = KeyMod.Shift | KeyCode.Tab;
	assert.ok(
		!addCommandCalls().some((call) => call.binding === shiftTab),
		'a Shift+Tab command has appeared; either it does more than outdent, or it should go',
	);

	// …and the claim it rests on, pinned against the installed Monaco rather
	// than assumed: `outdent` is bound to Shift+Tab, in the editor, when Tab is
	// not moving focus.
	const core = readSource(
		new URL('../node_modules/monaco-editor/esm/vs/editor/browser/coreCommands.js', import.meta.url),
	);
	const outdent = core.slice(core.indexOf("id: 'outdent'"), core.indexOf("id: 'tab'"));
	assert.match(outdent, /KeyMod\.Shift \*\/ \| 2 \/\* KeyCode\.Tab/);
	assert.match(outdent, /EditorContextKeys\.editorTextFocus, EditorContextKeys\.tabDoesNotMoveFocus/);
});
