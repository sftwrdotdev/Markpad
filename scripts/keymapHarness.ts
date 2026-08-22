import assert from 'node:assert/strict';

import { decodeKeybinding, type KeyCodeChord } from 'monaco-editor/esm/vs/base/common/keybindings.js';
import { KeyCodeUtils } from 'monaco-editor/esm/vs/base/common/keyCodes.js';
import { KeyCode } from 'monaco-editor/esm/vs/editor/common/standalone/standaloneEnums.js';
import { KeyMod } from 'monaco-editor/esm/vs/editor/common/services/editorBaseApi.js';
import ts from 'typescript';

import { blockEnter, parseListItem } from '../src/lib/utils/listEditing.js';
import { tableOperation, tableStep } from '../src/lib/utils/tableEditing.js';
import { viewerCommandFor, type KeyContext, type ViewerCommand } from '../src/lib/utils/viewerKeymap.js';
import { readSource, functionSource } from './sourceTree.js';

/*
 * RUNNING the app's two keyboard layers, so tests can ask what a chord DOES.
 *
 * Extracted from `formatShortcutKeymap.test.ts` (#480) when a second test file
 * — the shortcut-registry contract — needed the same two functions. It is the
 * same harness, not a parallel one: both callers get the same keymaps from the
 * same extraction, so there is no way for one of them to be checked against a
 * more forgiving model of the app than the other.
 *
 * `registerLocalizedActions` is lifted out of Editor.svelte and RUN; the
 * document-level dispatcher is simply imported, having been moved to
 * `src/lib/utils/viewerKeymap.ts` for that reason. Keybinding numbers come from
 * Monaco's real `KeyMod` and `KeyCode` and are turned back into chords by
 * Monaco's real `decodeKeybinding`, once per operating system. Nothing here
 * matches the components as text, so renaming a local, reordering the actions or
 * rewriting the branch structure changes nothing; changing a KEY does.
 *
 * WHAT IT DOES NOT ESTABLISH
 *
 * - That Monaco delivers these chords at runtime. Resolution order, the `when`
 *   clauses and the vim adapter all live in a browser. What is pinned here is
 *   the keymap the app declares.
 * - Layout-dependent `key` values. The synthetic events carry the UNSHIFTED
 *   character (`key: ','`, not `'<'`), because that is the only value that is
 *   the same on every keyboard layout.
 */

// --------------------------------------------------------------- chord labels

export type Chord = string;

/**
 * `OperatingSystem` is a TypeScript `const enum` in Monaco, so the shipped ESM
 * has the numbers inlined and exports no symbol to import. The values are the
 * ones `vs/base/common/platform.js` inlines when it computes its own `OS`.
 */
export const OperatingSystem = { Windows: 1, Macintosh: 2, Linux: 3 } as const;

type OperatingSystemValue = (typeof OperatingSystem)[keyof typeof OperatingSystem];

const MODIFIER_ORDER = ['Ctrl', 'Shift', 'Alt', 'Meta'] as const;

export function label(parts: {
	ctrlKey: boolean;
	shiftKey: boolean;
	altKey: boolean;
	metaKey: boolean;
	keyCode: number;
}): string {
	const mods = [
		parts.ctrlKey && 'Ctrl',
		parts.shiftKey && 'Shift',
		parts.altKey && 'Alt',
		parts.metaKey && 'Meta',
	].filter(Boolean) as Array<(typeof MODIFIER_ORDER)[number]>;
	return [...MODIFIER_ORDER.filter((m) => mods.includes(m)), KeyCodeUtils.toString(parts.keyCode)].join('+');
}

/** A Monaco keybinding number, as the chord (or chord sequence) Monaco resolves it to. */
export function chordOf(binding: number, os: OperatingSystemValue): Chord {
	const decoded = decodeKeybinding(binding, os);
	assert.ok(decoded, `Monaco could not decode keybinding ${binding}`);
	return decoded.chords.map((chord) => label(chord as KeyCodeChord)).join(' ');
}

export const PLATFORMS = [
	{ name: 'macOS', os: OperatingSystem.Macintosh, osType: 'macos', mac: true },
	{ name: 'Windows', os: OperatingSystem.Windows, osType: 'windows', mac: false },
	{ name: 'Linux', os: OperatingSystem.Linux, osType: 'linux', mac: false },
] as const;

// ------------------------------------------------- the editor (Monaco) layer

type ActionDescriptor = {
	id: string;
	label: string;
	keybindings?: number[];
	run: (ed?: unknown) => unknown;
};

/**
 * Every action `registerLocalizedActions` registers, for one platform.
 *
 * The function is extracted by name (not by a `sliceBetween` anchor pair, which
 * widens as neighbours are added) and evaluated inside a `with` block whose
 * scope object answers for EVERY free identifier. A dependency the function
 * grows later resolves to a recording stub instead of a ReferenceError, so this
 * harness does not have to be edited every time the component gains a callback
 * — and a stub cannot fake a keybinding, because the keybinding numbers come
 * from the real `KeyMod`/`KeyCode` handed in below.
 */
export function registeredActions(mac: boolean): { actions: ActionDescriptor[]; calls: string[] } {
	const source = functionSource(readSource('src/lib/components/Editor.svelte'), 'registerLocalizedActions');
	const js = ts.transpileModule(source, {
		compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
	}).outputText;

	const actions: ActionDescriptor[] = [];
	const calls: string[] = [];
	const record = (name: string) =>
		(...args: unknown[]) => {
			calls.push(args.length ? `${name}(${args.map((a) => JSON.stringify(a)).join(',')})` : name);
			return undefined;
		};

	const known: Record<string, unknown> = {
		monaco: { KeyMod, KeyCode },
		editor: {
			addAction(descriptor: ActionDescriptor) {
				actions.push(descriptor);
				return { dispose() {} };
			},
			getSelection: () => null,
			executeEdits: record('executeEdits'),
			trigger: record('trigger'),
		},
		isMacPlatform: () => mac,
		// `t` is not the real translator on purpose: this file is about keys, and
		// editorContextMenuI18n.test.ts already asserts that every one of these
		// labels comes from the dictionary.
		t: (key: string) => key,
		localizedActions: [],
		disposeLocalizedActions: () => {},
	};

	const scope = new Proxy(known, {
		has: () => true,
		get: (target, property) => {
			if (typeof property !== 'string') return undefined;
			if (property in target) return target[property];
			const stub = record(property);
			// Callbacks are read as `onnew?.()` and settings as
			// `settings.toggleMinimap()`, so the stub has to be callable AND
			// indexable.
			return new Proxy(stub, {
				get: (fn, key) => (key in fn ? (fn as never)[key] : record(`${property}.${String(key)}`)),
			});
		},
	});

	const build = new Function('scope', `with (scope) { ${js}\nreturn registerLocalizedActions; }`) as (
		s: unknown,
	) => (lang: string) => void;
	build(scope)('en');

	assert.ok(
		actions.length > 20,
		`registerLocalizedActions registered ${actions.length} actions; the harness is not running the real function`,
	);
	return { actions, calls };
}

/** actionId -> chord, for the actions that declare one. */
export function editorKeymap(mac: boolean, os: OperatingSystemValue): Map<string, Chord[]> {
	const map = new Map<string, Chord[]>();
	for (const action of registeredActions(mac).actions) {
		if (!action.keybindings?.length) continue;
		map.set(
			action.id,
			action.keybindings.map((binding) => chordOf(binding, os)),
		);
	}
	return map;
}

// ----------------------------------------------- the document (window) layer

/**
 * The keys the document-level handler is fired with.
 *
 * `key` is the unshifted character and `code` the physical key, which is what a
 * US layout reports and what every layout reports for letters and digits.
 */
const FUZZ_KEYS: Array<{ keyCode: number; key: string; code: string }> = [
	...'abcdefghijklmnopqrstuvwxyz'.split('').map((c) => ({
		keyCode: KeyCode.KeyA + (c.charCodeAt(0) - 97),
		key: c,
		code: `Key${c.toUpperCase()}`,
	})),
	...'0123456789'.split('').map((c) => ({
		keyCode: KeyCode.Digit0 + (c.charCodeAt(0) - 48),
		key: c,
		code: `Digit${c}`,
	})),
	{ keyCode: KeyCode.Tab, key: 'Tab', code: 'Tab' },
	{ keyCode: KeyCode.PageUp, key: 'PageUp', code: 'PageUp' },
	{ keyCode: KeyCode.PageDown, key: 'PageDown', code: 'PageDown' },
	{ keyCode: KeyCode.LeftArrow, key: 'ArrowLeft', code: 'ArrowLeft' },
	{ keyCode: KeyCode.RightArrow, key: 'ArrowRight', code: 'ArrowRight' },
	{ keyCode: KeyCode.F4, key: 'F4', code: 'F4' },
	{ keyCode: KeyCode.F5, key: 'F5', code: 'F5' },
	{ keyCode: KeyCode.Backslash, key: '\\', code: 'Backslash' },
	{ keyCode: KeyCode.IntlBackslash, key: '\\', code: 'IntlBackslash' },
	{ keyCode: KeyCode.BracketLeft, key: '[', code: 'BracketLeft' },
	{ keyCode: KeyCode.BracketRight, key: ']', code: 'BracketRight' },
	{ keyCode: KeyCode.Period, key: '.', code: 'Period' },
	{ keyCode: KeyCode.Comma, key: ',', code: 'Comma' },
	{ keyCode: KeyCode.Minus, key: '-', code: 'Minus' },
	{ keyCode: KeyCode.Equal, key: '=', code: 'Equal' },
];

/**
 * Reading the document, not editing it, with nothing in front of it — the state
 * every caller of `documentKeymap` is asking about.
 *
 * `editorHasFocus: false` is the reporter's scenario in #153 (preview mode) and
 * the one in which the app's own chords, rather than Monaco's, are supposed to
 * answer.
 */
function readingContext(osType: string): KeyContext {
	return {
		mode: 'app',
		osType: osType as KeyContext['osType'],
		isSplit: false,
		overlayOpen: false,
		isEditing: false,
		editorHasFocus: false,
	};
}

/**
 * Which command the document-level dispatcher means by each chord.
 *
 * The dispatcher is IMPORTED and called — `viewerCommandFor` is a plain
 * function of the keystroke and a six-field context, so there is nothing to
 * extract, transpile or stand in for. It used to be the body of
 * `handleKeyDown` inside MarkdownViewer.svelte, and getting at it meant slicing
 * the function out of the component by name, running it through
 * `ts.transpileModule`, and evaluating it inside a `with` block whose scope
 * object answered EVERY free identifier with a recording stub.
 *
 * That last part is why the extraction was worth doing. A stub is indexable,
 * callable and self-similar, which makes it a plausible answer to a question the
 * harness has never heard of — and its result compares false to everything. #649
 * hit exactly that: `platformOf(...)` inside the handler resolved to a stub,
 * every `=== 'macos'` test against it was false, and the harness cheerfully
 * reported 610 answered chords where the app answers 51. The failure was silent
 * in both directions, because a stub neither throws nor refuses.
 *
 * Nothing here can go that way again. `viewerCommandFor` closes over nothing, so
 * a dependency it grows is a compile error at this call site rather than a stub.
 */
export function documentKeymap(osType: string): Map<Chord, ViewerCommand> {
	const context = readingContext(osType);
	const map = new Map<Chord, ViewerCommand>();

	for (const primary of [
		{ ctrlKey: false, metaKey: false },
		{ ctrlKey: true, metaKey: false },
		{ ctrlKey: false, metaKey: true },
	]) {
		for (const shiftKey of [false, true]) {
			for (const altKey of [false, true]) {
				for (const entry of FUZZ_KEYS) {
					const command = viewerCommandFor(
						{ ...primary, shiftKey, altKey, key: entry.key, code: entry.code, target: null },
						context,
					);
					if (command) map.set(label({ ...primary, shiftKey, altKey, keyCode: entry.keyCode }), command);
				}
			}
		}
	}
	assert.ok(
		map.size > 15,
		`the document dispatcher answered ${map.size} chords; the harness is not running the real function`,
	);
	return map;
}

/**
 * The component's command table: each `ViewerCommand`, and the code
 * `MarkdownViewer.svelte` runs for it.
 *
 * THE ONE THING THE SEAM COULD NOT MOVE, and the only text-matching in this
 * file. Deciding WHICH command a chord means is now a pure function that tests
 * import; deciding what `'new-file'` DOES is a switch over the component's own
 * closures — `handleNewFile`, `saveContent`, `getCurrentWindow().close()` — and
 * a closure over component state is the thing that cannot leave a component.
 *
 * The alternative was to pass those eleven functions in as a host object, so
 * that a test could hand over eleven spies. That is the shape #644 rejected for
 * three members and it does not improve at eleven: every caller has to build
 * one, and the test that builds one is describing the component rather than
 * running it. So the seam stops at the command name, and this reads the last
 * inch as text — deliberately, and in one place instead of thirty.
 *
 * What it is NOT is the old `handleKeyDown` extraction. There is no
 * `transpileModule`, no `with`, no scope proxy and therefore no stub that can
 * answer a question nobody asked: the parse yields case labels and body text,
 * every command the dispatcher can reach must have exactly one case, and a
 * command that lost its case is a missing key rather than a silent no-op.
 */
export function viewerCommandTable(): Record<ViewerCommand, string> {
	const source = functionSource(readSource('src/lib/MarkdownViewer.svelte'), 'runViewerCommand');
	const table: Record<string, string> = {};

	// `case 'a':` runs of one or more labels, then everything up to the next
	// `case` or the end of the switch. Stacked labels fall through to one body —
	// that is how `preview-width-narrower` and `preview-width-wider` share theirs
	// — so a label with nothing of its own is given the next label's, walking
	// backwards. Without that the first of a pair maps to the empty string, which
	// any `doesNotMatch` would pass against.
	const labels = [...source.matchAll(/\n\t*case '([a-z-]+)':/g)];
	let shared = '';
	for (let index = labels.length - 1; index >= 0; index--) {
		const match = labels[index];
		const body = source.slice(match.index + match[0].length, labels[index + 1]?.index ?? source.length);
		shared = body.trim() ? body : shared;
		table[match[1]] = shared;
	}

	const reachable = new Set<ViewerCommand>();
	for (const platform of PLATFORMS) for (const command of documentKeymap(platform.osType).values()) reachable.add(command);
	for (const command of reachable) {
		assert.ok(command in table, `runViewerCommand has no case for ${command}, which the keyboard reaches`);
	}
	assert.equal(
		Object.keys(table).length,
		reachable.size,
		`runViewerCommand handles ${Object.keys(table).length} commands, ${reachable.size} are reachable`,
	);
	return table as Record<ViewerCommand, string>;
}

// ------------------------------------- the nameless commands, and their handlers

const EDITOR = 'src/lib/components/Editor.svelte';

/** One `editor.addCommand(binding, handler, when)` call, as Monaco is handed it. */
export type BareCommand = { binding: number; handler: string; when: string };

/**
 * Every bare `addCommand` the editor registers: a keybinding number, the name of
 * the handler, and the `when` clause.
 *
 * These are the keys with no action id — Enter, Tab, Shift+Tab, the clipboard
 * chords — so `registeredActions` above cannot see them at all, and neither can
 * anything built on it. Two files need them for different reasons
 * (`listContinuation.test.ts` checks the guards, `shortcutRegistry.test.ts`
 * checks the panel's claims), which is why the extraction lives here rather than
 * in either of them.
 *
 * The arguments are EVALUATED, not matched as text: the keybinding numbers come
 * from Monaco's real `KeyMod`/`KeyCode` and the `when` expression is the string
 * the component computes, template literal and shared constant included. So
 * renaming the constant or reflowing the call changes nothing; changing a key or
 * dropping a guard changes everything.
 */
export function bareCommands(): BareCommand[] {
	const text = readSource(EDITOR);
	const script = text.slice(text.indexOf('>', text.indexOf('<script')) + 1, text.indexOf('</script>'));
	const file = ts.createSourceFile('editor.ts', script, ts.ScriptTarget.ES2022, true);

	const constants: Record<string, string> = {};
	const calls: BareCommand[] = [];

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
			// below can be reading, and an argument that turns out to need it fails
			// loudly at its own `evaluate`.
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

	assert.ok(calls.length >= 5, `found ${calls.length} addCommand calls; the extraction is not running`);
	return calls;
}

/** What a handler did to the stub editor it was handed. */
export type RecordedEdits = {
	triggers: string[];
	edits: Array<{ range: number[]; text: string; cursor: number[] }>;
	/** `setSelection` calls: a caret moved without an edit. */
	selections: number[][];
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
 * Component handlers, extracted by name and evaluated against a stub editor.
 *
 * `names` is every function the run needs, entry point LAST — a handler that
 * dispatches through helpers needs the helpers in scope, and naming them makes
 * the dependency visible instead of resolving it with a stub that would happily
 * pass.
 *
 * The list and table modules in scope are the REAL ones, so a handler that
 * stopped calling them — or called them with the wrong column — fails here
 * rather than passing against a second, more agreeable copy.
 */
export function runEditorHandler(
	names: string[],
	options: { lines: string[]; selections: number[][]; eol?: string },
): RecordedEdits {
	const recorded: RecordedEdits = { triggers: [], edits: [], selections: [], undoStops: 0 };
	const eol = options.eol ?? '\n';
	const selections = options.selections.map((s) => new FakeRange(s[0], s[1], s[2], s[3]));

	const model = {
		getLineContent: (line: number) => options.lines[line - 1],
		getLineCount: () => options.lines.length,
		getLineMaxColumn: (line: number) => options.lines[line - 1].length + 1,
		getEOL: () => eol,
		getValueInRange: (range: FakeRange) => {
			const span = options.lines.slice(range.startLineNumber - 1, range.endLineNumber);
			span[span.length - 1] = span[span.length - 1].slice(0, range.endColumn - 1);
			span[0] = span[0].slice(range.startColumn - 1);
			return span.join(eol);
		},
	};

	const scope: Record<string, unknown> = {
		blockEnter,
		parseListItem,
		tableStep,
		tableOperation,
		monaco: { Range: FakeRange, Selection: FakeRange },
		editor: {
			getModel: () => model,
			getSelections: () => selections,
			pushUndoStop: () => {
				recorded.undoStops += 1;
			},
			setSelection: (selection: FakeRange) => {
				recorded.selections.push(selection.numbers());
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

	const source = readSource(EDITOR);
	const declarations = names.map((name) => `const ${name} = ${functionSource(source, name)};`).join('\n');
	const js = ts.transpileModule(declarations, {
		compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
	}).outputText;
	const build = new Function('scope', `with (scope) { ${js}\nreturn ${names[names.length - 1]}; }`) as (
		s: unknown,
	) => () => void;
	build(new Proxy(scope, { has: () => true }))();

	return recorded;
}
