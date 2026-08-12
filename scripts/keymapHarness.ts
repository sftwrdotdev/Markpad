import assert from 'node:assert/strict';

import { decodeKeybinding, type KeyCodeChord } from 'monaco-editor/esm/vs/base/common/keybindings.js';
import { KeyCodeUtils } from 'monaco-editor/esm/vs/base/common/keyCodes.js';
import { KeyCode } from 'monaco-editor/esm/vs/editor/common/standalone/standaloneEnums.js';
import { KeyMod } from 'monaco-editor/esm/vs/editor/common/services/editorBaseApi.js';
import ts from 'typescript';

import { listEnter, parseListItem } from '../src/lib/utils/listEditing.js';
import { tableOperation, tableStep } from '../src/lib/utils/tableEditing.js';
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
 * `registerLocalizedActions` and `handleKeyDown` are lifted out of their Svelte
 * components and RUN. Keybinding numbers come from Monaco's real `KeyMod` and
 * `KeyCode` and are turned back into chords by Monaco's real `decodeKeybinding`,
 * once per operating system. Nothing here matches the components as text, so
 * renaming a local, reordering the actions or rewriting the branch structure
 * changes nothing; changing a KEY does.
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
 * Which app functions the document-level handler runs for each chord.
 *
 * The handler is extracted and evaluated the same way as the editor's action
 * list, then fired once per chord. Everything it can reach — `tabManager`,
 * `saveContent`, `handleNewFile` — is a recording stub, so what comes back is
 * the handler's real branch structure rather than a description of it.
 *
 * ASSIGNMENTS ARE RECORDED TOO, as `name=value`. Several branches do their work
 * by writing a variable rather than by calling anything — `showSettings = true`
 * for Mod+`,` and `settings.previewFullWidth = false` for the preview-width
 * chords — and a call-only recorder reported those chords as dead. They were
 * not; the harness simply could not see them, which is the empty-iteration
 * failure mode one level down. `set` on the scope proxy used to return `true`
 * and discard the write.
 */
export function documentKeymap(osType: string): Map<Chord, string[]> {
	const source = functionSource(readSource('src/lib/MarkdownViewer.svelte'), 'handleKeyDown');
	const js = ts.transpileModule(source, {
		compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
	}).outputText;

	let fired: string[] = [];
	/**
	 * A stub that is callable, indexable and self-similar, so
	 * `getCurrentWindow().close()` and `tabManager.cycleTab('next')` both work
	 * without the harness having to know they exist. Every call is recorded under
	 * its full path, which is what the assertions read.
	 */
	const record = (name: string): never => {
		const fn = (...args: unknown[]) => {
			fired.push(args.length && typeof args[0] === 'string' ? `${name}:${args[0]}` : name);
			return record(`${name}()`);
		};
		return new Proxy(fn, {
			get: (target, key) =>
				typeof key === 'string' && !(key in target) ? record(`${name}.${key}`) : (target as never)[key as never],
		}) as never;
	};

	const known: Record<string, unknown> = {
		// `has: () => true` below means the scope claims EVERY identifier, globals
		// included, so `Math` has to be handed back deliberately rather than
		// answered with a recording stub.
		Math,
		mode: 'app',
		// Writes to the store are recorded as well as calls: several branches do
		// their work by assigning a settings field (`settings.previewFullWidth =
		// false` for the preview-width chords), and without the `set` trap those
		// chords come back as firing nothing at all — the same blind spot the
		// scope proxy's own `set` trap fixed one level up. The trap does not write
		// through: `get` keeps answering with a fresh stub, so nothing a chord
		// assigns can leak into the next chord's starting state.
		settings: new Proxy(
			{ osType },
			{
				get: (t, k) => (k === 'osType' ? osType : record(`settings.${String(k)}`)),
				set: (t, k, value) => {
					fired.push(`settings.${String(k)}=${typeof value === 'object' ? '{…}' : String(value)}`);
					return true;
				},
			},
		),
		showSettings: false,
		showHome: false,
		isEditing: false,
		modalState: { show: false },
		promptModal: { show: false },
		editorPaneEl: null,
		document: { activeElement: null },
		tabManager: new Proxy(
			{ activeTab: { isSplit: false, isDirty: true, path: '/x.md' }, activeTabId: 'tab-1' },
			{ get: (t, k) => (k in t ? (t as Record<string, unknown>)[k as string] : record(`tabManager.${String(k)}`)) },
		),
		canUsePreviewWidthShortcut: () => true,
		adjustPreviewMaxWidth: () => 800,
	};

	// Written per fire so an assignment made by one chord cannot leak into the
	// next one's starting state — `zoomLevel` in particular is read as well as
	// written, and a leaked 110 would make the next zoom-in look like a no-op.
	const initial = { ...known };

	const scope = new Proxy(known, {
		has: () => true,
		get: (target, property) => {
			if (typeof property !== 'string') return undefined;
			if (property in target) return target[property];
			return record(property);
		},
		set: (target, property, value) => {
			if (typeof property === 'string') {
				fired.push(`${property}=${typeof value === 'object' ? '{…}' : String(value)}`);
				target[property] = value;
			}
			return true;
		},
	});

	const build = new Function('scope', `with (scope) { ${js}\nreturn handleKeyDown; }`) as (
		s: unknown,
	) => (e: unknown) => void;
	const handler = build(scope);

	const map = new Map<Chord, string[]>();
	for (const primary of [
		{ ctrlKey: false, metaKey: false },
		{ ctrlKey: true, metaKey: false },
		{ ctrlKey: false, metaKey: true },
	]) {
		for (const shiftKey of [false, true]) {
			for (const altKey of [false, true]) {
				for (const entry of FUZZ_KEYS) {
					fired = [];
					Object.assign(known, initial);
					handler({
						...primary,
						shiftKey,
						altKey,
						key: entry.key,
						code: entry.code,
						target: null,
						preventDefault: () => {},
					});
					if (fired.length === 0) continue;
					map.set(label({ ...primary, shiftKey, altKey, keyCode: entry.keyCode }), [...new Set(fired)]);
				}
			}
		}
	}
	assert.ok(
		map.size > 15,
		`the document handler answered ${map.size} chords; the harness is not running the real function`,
	);
	return map;
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
		listEnter,
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
