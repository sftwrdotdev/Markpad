import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import test from 'node:test';

import { callbackBodies, readSource } from './sourceTree.js';

/*
 * Vim's scroll-cursor family — `zz`, `zt`, `zb`, `z.`, `z-`, `z<CR>` — does
 * nothing in monaco-vim 0.4.4 (#104, #393), and `zb`/`z-` are additionally
 * swapped with respect to `:help scroll-cursor`. `utils/vimScrollCommands.ts`
 * repairs both through the package's own `Vim.defineAction`/`Vim.mapCommand`.
 *
 * WHAT RUNS HERE. The keys are *pressed*. Every test below drives real
 * keystrokes into `Vim.handleKey` on a real `CMAdapter` built from the real
 * `monaco-vim` package — the same `dist/index.mjs` Vite hands the app — and
 * then asks the editor which reveal it was told to perform. Nothing in this
 * file asserts that a source file contains a string; the closest it comes is
 * lifting Editor.svelte's own `import("monaco-vim").then` callback out of the
 * component and *running* it.
 *
 * Only `monaco-editor` is faked, and only because it cannot be imported under
 * Node: it is 4 MB of code that reaches for `document` at module scope.
 * monaco-vim imports it as two ordinary externals (`Range`, `Selection`,
 * `KeyCode`, …) rather than bundling it, so a module hook can answer those two
 * specifiers with the handful of value classes the adapter actually constructs.
 * Everything downstream of that — the keymap, the command dispatcher, the
 * action registry, `CMAdapter` itself — is upstream's own shipped code.
 *
 * WHAT IT DOES NOT ESTABLISH: that Monaco's `revealRangeInCenter` puts the line
 * where a human would call the centre, that focus and key routing reach Vim
 * mode in the running app, or anything about rendering. It establishes which
 * reveal each key sequence asks the editor for, and where the cursor ends up.
 */

// ------------------------------------------------------- the monaco-editor fake
//
// A synthetic module URL, so the stub lives in this file instead of a second
// one that would have to be kept in step with it. Nothing reads the path: the
// `load` hook short-circuits before Node opens it.

const MONACO_STUB = new URL('./monaco-editor.stub-for-vim-tests.js', import.meta.url).href;

/**
 * The monaco-editor value exports monaco-vim constructs or compares against.
 *
 * `Range.fromPositions` and `Selection.fromPositions` are the two that matter:
 * `CMAdapter.moveCurrentLineTo` builds the range it reveals, and the motion
 * path builds the selection it moves the cursor with. `KeyCode` is only ever
 * used as a set of comparison constants, so a proxy answering with the property
 * name is enough to keep those comparisons distinct and false.
 */
const MONACO_STUB_SOURCE = `
	export const KeyCode = new Proxy({}, { get: (_target, key) => 'KeyCode:' + String(key) });
	export class Position {
		constructor(lineNumber, column) { this.lineNumber = lineNumber; this.column = column; }
	}
	export class Range {
		constructor(startLineNumber, startColumn, endLineNumber, endColumn) {
			this.startLineNumber = startLineNumber; this.startColumn = startColumn;
			this.endLineNumber = endLineNumber; this.endColumn = endColumn;
		}
		static fromPositions(start, end = start) {
			return new Range(start.lineNumber, start.column, end.lineNumber, end.column);
		}
		getStartPosition() { return new Position(this.startLineNumber, this.startColumn); }
		getEndPosition() { return new Position(this.endLineNumber, this.endColumn); }
	}
	export const SelectionDirection = { LTR: 0, RTL: 1 };
	export class Selection extends Range {
		static fromPositions(start, end = start) {
			return new Selection(start.lineNumber, start.column, end.lineNumber, end.column);
		}
		isEmpty() {
			return this.startLineNumber === this.endLineNumber && this.startColumn === this.endColumn;
		}
		getDirection() { return SelectionDirection.LTR; }
		getPosition() { return this.getEndPosition(); }
	}
	export const editor = {
		EditorOption: {},
		TrackedRangeStickiness: { NeverGrowsWhenTypingAtEdges: 0 },
		setTheme() {},
	};
	export class ShiftCommand {}
`;

registerHooks({
	resolve(specifier, context, next) {
		if (specifier === 'monaco-editor' || specifier.startsWith('monaco-editor/')) {
			return { url: MONACO_STUB, shortCircuit: true };
		}
		return next(specifier, context);
	},
	load(url, context, next) {
		if (url === MONACO_STUB) {
			return { format: 'module', shortCircuit: true, source: MONACO_STUB_SOURCE };
		}
		return next(url, context);
	},
});

// ------------------------------------------------------------------- the editor

type Pos = { lineNumber: number; column: number };
/** What `moveCurrentLineTo` asked the editor to do, and to which line. */
type Reveal = { position: 'top' | 'center' | 'bottom'; line: number };

/**
 * The Monaco editor widget, reduced to the state the z-family touches: a
 * cursor, a document, and a viewport.
 *
 * The three reveal methods are the whole point. `revealRangeAtTop`,
 * `revealRangeInCenter` and the private `_revealRange(range, 4)` are the only
 * three calls `CMAdapter.moveCurrentLineTo` can make, so recording them records
 * exactly what a keypress achieved — and recording *nothing* is what the defect
 * looks like. `revealPosition`, which `setCursor` calls on every cursor move,
 * is deliberately not one of them: it would log on motions that scrolled
 * nothing and make the empty list impossible to observe.
 */
function fakeEditor(lines: string[], visible: { first: number; last: number }) {
	let cursor: Pos = { lineNumber: 1, column: 1 };
	const reveals: Reveal[] = [];
	const disposable = () => ({ dispose() {} });

	const validate = (position: Pos): Pos => {
		const lineNumber = Math.min(Math.max(position.lineNumber, 1), lines.length);
		const column = Math.min(Math.max(position.column, 1), lines[lineNumber - 1].length + 1);
		return { lineNumber, column };
	};

	const selectionAt = (position: Pos) => ({
		startLineNumber: position.lineNumber,
		startColumn: position.column,
		endLineNumber: position.lineNumber,
		endColumn: position.column,
		isEmpty: () => true,
		getDirection: () => 0,
		getPosition: () => ({ ...position }),
		getStartPosition: () => ({ ...position }),
		getEndPosition: () => ({ ...position }),
	});

	const model = {
		getLineCount: () => lines.length,
		getLineContent: (n: number) => lines[n - 1],
		getLineMaxColumn: (n: number) => lines[n - 1].length + 1,
		getLineFirstNonWhitespaceColumn: (n: number) => {
			const at = lines[n - 1].search(/\S/);
			return at < 0 ? 0 : at + 1;
		},
		getLineLastNonWhitespaceColumn: (n: number) => lines[n - 1].replace(/\s+$/, '').length + 1,
		getValueInRange: () => '',
		getOptions: () => ({ tabSize: 4, insertSpaces: true }),
		validatePosition: validate,
	};

	const editor = {
		getModel: () => model,
		getPosition: () => ({ ...cursor }),
		setPosition: (position: Pos) => {
			cursor = validate(position);
		},
		getSelection: () => selectionAt(cursor),
		getSelections: () => [selectionAt(cursor)],
		setSelection: (range: { endLineNumber: number; endColumn: number }) => {
			cursor = validate({ lineNumber: range.endLineNumber, column: range.endColumn });
		},
		setSelections: (selections: { endLineNumber: number; endColumn: number }[]) => {
			const last = selections[selections.length - 1];
			cursor = validate({ lineNumber: last.endLineNumber, column: last.endColumn });
		},
		getVisibleRanges: () => [{ startLineNumber: visible.first, endLineNumber: visible.last }],

		revealRangeAtTop: (range: { startLineNumber: number }) =>
			void reveals.push({ position: 'top', line: range.startLineNumber }),
		revealRangeInCenter: (range: { startLineNumber: number }) =>
			void reveals.push({ position: 'center', line: range.startLineNumber }),
		_revealRange: (range: { startLineNumber: number }) =>
			void reveals.push({ position: 'bottom', line: range.startLineNumber }),
		revealPosition: () => {},

		createContextKey: () => ({ set() {} }),
		onDidChangeCursorPosition: disposable,
		onDidChangeModelContent: disposable,
		onKeyDown: disposable,
		updateOptions: () => {},
		getOption: () => ({}),
		executeCommand: () => {},
		trigger: () => {},
		pushUndoStop: () => {},
		focus: () => {},
	};

	return {
		editor,
		reveals,
		placeCursor(position: Pos) {
			cursor = validate(position);
		},
		get cursor() {
			return { ...cursor };
		},
	};
}

// -------------------------------------------------------------- the vim harness

const MONACO_VIM = import.meta.resolve('monaco-vim');
let instances = 0;

/**
 * A private copy of monaco-vim, plus an editor to drive it with.
 *
 * A fresh copy per case, because both repairs mutate module-level tables that
 * would otherwise leak between tests — and because the first test below is
 * about what upstream does *un*repaired, which a shared instance would make
 * unaskable after any other test had run. The query string is what buys it: the
 * module URL differs, so Node evaluates the file again.
 */
async function freshVim() {
	const { VimMode } = await import(`${MONACO_VIM}?instance=${(instances += 1)}`);
	return { VimMode, Vim: VimMode.Vim as Record<string, Function> };
}

/** Five lines; line 2 is indented, so a cursor column change is visible. */
const LINES = ['alpha', '    beta is indented', 'gamma', 'delta', 'epsilon'];
/** The cursor's home for every run: line 2, on the `s` of `is`. */
const START: Pos = { lineNumber: 2, column: 13 };

const KEYSTROKES: Record<string, string[]> = {
	zz: ['z', 'z'],
	'z.': ['z', '.'],
	zt: ['z', 't'],
	'z<CR>': ['z', '<CR>'],
	zb: ['z', 'b'],
	'z-': ['z', '-'],
};

/**
 * `installVimScrollCommands`, or a no-op when the app has no such module.
 *
 * The fallback is what makes a falsification run worth anything. Reverting the
 * fix deletes the module; importing it directly would turn every test below red
 * with the same "cannot find module", and not one of them would then be
 * evidence about `zz`. An app that never installs the commands behaves exactly
 * like one whose install does nothing — so that is what it is given, and each
 * test fails on its own claim instead. Same reasoning as `lifted` in
 * undoHistoryPerTab.ts.
 */
async function loadInstaller(): Promise<(vimMode: unknown) => boolean> {
	try {
		return (await import('../src/lib/utils/vimScrollCommands.js')).installVimScrollCommands;
	} catch {
		return () => false;
	}
}

/** Press `command` in normal mode and report what the editor was asked to do. */
async function press(command: string, options: { install: boolean }) {
	const { VimMode, Vim } = await freshVim();
	if (options.install) (await loadInstaller())(VimMode);

	const host = fakeEditor(LINES, { first: 1, last: 3 });
	const cm = new VimMode(host.editor);
	host.placeCursor(START);

	const keys = KEYSTROKES[command];
	assert.ok(keys, `no keystrokes recorded for ${command}`);
	for (const key of keys) Vim.handleKey(cm, key, 'user');

	return { reveals: host.reveals, cursor: host.cursor };
}

// ----------------------------------------------------------------------- tests

/*
 * The defect, executed. This is the drift guard: the day an upgrade fixes
 * `scrollToCursor` upstream, this test goes red and says the shim can go —
 * which is the only way anyone would find out, since a working `zz` looks the
 * same either way.
 */
test('unpatched monaco-vim performs no scroll for any of the six keys', async () => {
	for (const command of Object.keys(KEYSTROKES)) {
		const { reveals } = await press(command, { install: false });
		assert.deepEqual(reveals, [], `${command} should still be dead in monaco-vim without the fix`);
	}
});

test('unpatched monaco-vim has zb and z- the wrong way round', async () => {
	// Vim: `zb` keeps the column, `z-` goes to the first non-blank. Upstream has
	// the motion on `zb`. Reaching the cursor at all is what the scroll fix
	// exposes, so this pins the second defect at the same level as the first.
	const zb = await press('zb', { install: false });
	assert.equal(zb.cursor.column, 5, 'unpatched zb wrongly jumps the cursor to the first non-blank');

	const zMinus = await press('z-', { install: false });
	assert.equal(zMinus.cursor.column, START.column, 'unpatched z- wrongly leaves the column alone');
});

test('every key in the z family scrolls to the position Vim documents', async () => {
	const expected: Record<string, 'top' | 'center' | 'bottom'> = {
		zz: 'center',
		'z.': 'center',
		zt: 'top',
		'z<CR>': 'top',
		zb: 'bottom',
		'z-': 'bottom',
	};

	for (const [command, position] of Object.entries(expected)) {
		const { reveals } = await press(command, { install: true });
		assert.deepEqual(
			reveals,
			[{ position, line: START.lineNumber }],
			`${command} should reveal the cursor line at the ${position}`,
		);
	}
});

test('the punctuation forms move to the first non-blank and the letter forms hold the column', async () => {
	// `:help scroll-cursor`. Line 2 is `    beta is indented`, so the first
	// non-blank is column 5 and the cursor starts at column 13.
	const FIRST_NON_BLANK = 5;

	for (const command of ['z.', 'z<CR>', 'z-']) {
		const { cursor } = await press(command, { install: true });
		assert.equal(cursor.column, FIRST_NON_BLANK, `${command} should move the cursor to the first non-blank`);
		assert.equal(cursor.lineNumber, START.lineNumber, `${command} should not leave the line`);
	}

	for (const command of ['zz', 'zt', 'zb']) {
		const { cursor } = await press(command, { install: true });
		assert.equal(cursor.column, START.column, `${command} should leave the cursor column alone`);
		assert.equal(cursor.lineNumber, START.lineNumber, `${command} should not leave the line`);
	}
});

test('a second install does not map the commands a second time', async () => {
	// `mapCommand` unshifts onto a module-global keymap, so an install per
	// Vim-mode toggle would grow it without bound. Counted at the call rather
	// than inferred from behaviour, because a doubled keymap behaves correctly
	// right up until it does not fit in memory.
	const { VimMode, Vim } = await freshVim();
	const installVimScrollCommands = await loadInstaller();

	const mapped: string[] = [];
	const realMapCommand = Vim.mapCommand;
	Vim.mapCommand = function (this: unknown, ...args: unknown[]) {
		mapped.push(String(args[0]));
		return realMapCommand.apply(this, args);
	};

	assert.equal(installVimScrollCommands(VimMode), true);
	assert.equal(installVimScrollCommands(VimMode), true, 'a repeat install still reports the commands as present');
	assert.equal(installVimScrollCommands(VimMode), true);

	assert.deepEqual(mapped, ['zb', 'z-'], 'the swapped pair should be remapped exactly once');
});

test('an object that is not monaco-vim is left alone', async () => {
	const { installVimScrollCommands } = await import('../src/lib/utils/vimScrollCommands.js');

	// Every shape a changed or renamed upstream API could arrive as. None may
	// throw: this runs while the user is switching Vim mode on, and a throw
	// there takes the editor with it.
	assert.equal(installVimScrollCommands(undefined), false);
	assert.equal(installVimScrollCommands(null), false);
	assert.equal(installVimScrollCommands({}), false, 'no Vim export');
	assert.equal(installVimScrollCommands({ Vim: {} }), false, 'no defineAction');
	assert.equal(installVimScrollCommands({ Vim: { defineAction: 'not a function' } }), false);

	// defineAction without mapCommand: the scroll is repairable, the swap is
	// not, and the half that works still goes in.
	const actions: Record<string, unknown> = {};
	assert.equal(
		installVimScrollCommands({
			Vim: {
				defineAction: (name: string, fn: unknown) => {
					actions[name] = fn;
				},
			},
		}),
		true,
	);
	assert.equal(typeof actions.scrollToCursor, 'function');
});

test('a cm without moveCurrentLineTo does not throw', async () => {
	const { installVimScrollCommands } = await import('../src/lib/utils/vimScrollCommands.js');
	let action: ((cm: unknown, args: unknown) => void) | undefined;
	installVimScrollCommands({
		Vim: {
			defineAction: (_name: string, fn: (cm: unknown, args: unknown) => void) => {
				action = fn;
			},
		},
	});
	assert.equal(typeof action, 'function');
	action!({}, { position: 'center' });
	action!(undefined, undefined);
});

test('Editor.svelte installs the commands on the module it just imported', async () => {
	// The component's own callback, lifted and run — not read. It has to install
	// before `initVimMode` attaches the adapter, and it has to install even on
	// the disposed path, because the tables it writes to are the package's and
	// outlive this editor.
	const source = readSource('src/lib/components/Editor.svelte');
	const bodies = callbackBodies(source, 'import("monaco-vim").then');
	assert.equal(bodies.length, 1, `expected exactly one monaco-vim import callback, found ${bodies.length}`);

	const run = new Function(
		'installVimScrollCommands',
		'installVimClipboardRegisters',
		'invoke',
		'initVimMode',
		'VimMode',
		'currentEditor',
		'currentStatusNode',
		'disposed',
		`let vim = null; ${bodies[0]} return vim;`,
	) as (...args: unknown[]) => unknown;

	const calls: string[] = [];
	const VimMode = { marker: 'the module export' };
	const install = (mode: unknown) => {
		assert.equal(mode, VimMode, 'the VimMode from the same import must be the one patched');
		calls.push('install');
		return true;
	};
	const initVimMode = () => {
		calls.push('initVimMode');
		return { dispose() {} };
	};

	const written: unknown[] = [];
	const installClipboard = (mode: unknown, write: (text: string) => void) => {
		assert.equal(mode, VimMode, 'the clipboard registers go on the same module');
		calls.push('clipboard');
		write('yanked');
		return true;
	};
	const invoke = (command: string, args: unknown) => {
		written.push([command, args]);
		return Promise.resolve();
	};

	const vim = run(install, installClipboard, invoke, initVimMode, VimMode, {}, {}, false);
	assert.deepEqual(calls, ['install', 'clipboard', 'initVimMode'], 'the commands must be in place before the adapter attaches');
	assert.ok(vim, 'the adapter is still handed back for disposal');
	assert.deepEqual(written, [['clipboard_write_text', { text: 'yanked' }]], '"+ writes through the Rust clipboard');

	calls.length = 0;
	assert.ok(!run(install, installClipboard, invoke, initVimMode, VimMode, {}, {}, true), 'a disposed effect attaches nothing');
	assert.deepEqual(calls, ['install', 'clipboard'], 'a disposed effect still patches the package');
});
