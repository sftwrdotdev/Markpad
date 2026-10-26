import assert from 'node:assert/strict';

import { decodeKeybinding, type KeyCodeChord } from 'monaco-editor/esm/vs/base/common/keybindings.js';
import { KeyCodeUtils } from 'monaco-editor/esm/vs/base/common/keyCodes.js';
import { KeyCode } from 'monaco-editor/esm/vs/editor/common/standalone/standaloneEnums.js';
import { KeyMod } from 'monaco-editor/esm/vs/editor/common/services/editorBaseApi.js';

import { viewerCommandFor, type KeyContext, type ViewerCommand } from '../src/lib/utils/viewerKeymap.js';
import { viewerCommandTable, type ViewerCommandHost } from '../src/lib/utils/viewerCommands.js';
import { editorActions, editorKeyCommands, type EditorActionDeps, type EditorKeyCommand } from '../src/lib/utils/editorActions.js';
import { readSource, functionSource } from './sourceTree.js';

/*
 * RUNNING the app's two keyboard layers, so tests can ask what a chord DOES.
 *
 * Extracted from `shortcuts.checks.test.ts` (#480) when a second test file
 * — the shortcut-registry contract — needed the same two functions. It is the
 * same harness, not a parallel one: both callers get the same keymaps from the
 * same extraction, so there is no way for one of them to be checked against a
 * more forgiving model of the app than the other.
 *
 * Both layers are imported and run: the editor's keymap from
 * `src/lib/utils/editorActions.ts`, the document-level dispatcher from
 * `src/lib/utils/viewerKeymap.ts`. Keybinding numbers come from Monaco's real
 * `KeyMod` and `KeyCode` and are turned back into chords by Monaco's real
 * `decodeKeybinding`, once per operating system. Changing a KEY changes the
 * answer; renaming a local does not.
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
	keybindingContext?: string;
	run: (ed?: unknown) => unknown;
};

/**
 * Every action `editorActions` (utils/editorActions.ts) declares, for one
 * platform, labelled in English.
 *
 * The keybinding numbers come from Monaco's real `KeyMod`/`KeyCode`. Everything
 * an action's `run` reaches — the component's editing primitives, `oncommand`,
 * the settings store — is a recording stub, so `calls` says what running an
 * action did: `oncommand("new-file")`, `toggleLineMarkerTool("fmt-quote")`,
 * `settings.toggleWordWrap`.
 */
export function registeredActions(mac: boolean): { actions: ActionDescriptor[]; calls: string[] } {
	const calls: string[] = [];
	const record = (name: string) =>
		(...args: unknown[]) => {
			calls.push(args.length ? `${name}(${args.map((a) => JSON.stringify(a)).join(',')})` : name);
			return undefined;
		};
	const recorder = (prefix: string) =>
		new Proxy({}, { get: (_target, key) => record(`${prefix}${String(key)}`) });

	const deps = new Proxy(
		{ monaco: { KeyMod, KeyCode }, isMac: mac, settings: recorder('settings.') } as Record<string, unknown>,
		{ get: (target, key) => (typeof key === 'string' && key in target ? target[key] : record(String(key))) },
	) as unknown as EditorActionDeps;

	const actions = editorActions(deps, 'en') as unknown as ActionDescriptor[];
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
		dialogOpen: false,
		isEditing: false,
		editorHasFocus: false,
	};
}

/**
 * Which command the document-level dispatcher means by each chord.
 *
 * The dispatcher is IMPORTED and called — `viewerCommandFor` is a plain
 * function of the keystroke and a seven-field context, so there is nothing to
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
 * What each `ViewerCommand` reaching the keyboard does, as the names of the
 * host members it touched: `'appExit'` for a call, `'settings.previewMaxWidth'`
 * for a read, `'settings.showTabs='` for a write.
 *
 * Runs the real `viewerCommandTable` (`viewerCommands.ts`) against a recording
 * host: any member the table asks for exists and is logged, so a command that
 * reached for something the host type never had (`addHomeTab`) shows up by
 * name. The active tab is `'tab-1'`, so split view has a tab to toggle.
 */
export function viewerCommandCalls(): Record<ViewerCommand, string[]> {
	let calls: string[] = [];
	const recording = (prefix: string, fields: Record<string, unknown>) =>
		new Proxy(fields, {
			get(target, prop) {
				const name = prefix + String(prop);
				calls.push(name);
				if (prop in target) return target[prop as string];
				return () => {
					calls.push(`${name}()`);
					return Promise.resolve();
				};
			},
			set(target, prop, value) {
				calls.push(`${prefix}${String(prop)}=`);
				target[prop as string] = value;
				return true;
			},
		});
	const host = recording('', {
		settings: recording('settings.', { previewFullWidth: true, previewMaxWidth: 880, showTabs: true }),
		tabManager: recording('tabManager.', { activeTabId: 'tab-1' }),
	}) as unknown as ViewerCommandHost;
	const table = viewerCommandTable(host);

	const reachable = new Set<ViewerCommand>();
	for (const platform of PLATFORMS) for (const command of documentKeymap(platform.osType).values()) reachable.add(command);
	const result = {} as Record<ViewerCommand, string[]>;
	for (const command of reachable) {
		calls = [];
		table[command]();
		// A call shows up twice, as the read and then the call; keep the call.
		result[command] = calls.filter((name) => !calls.includes(`${name}()`)).map((name) => name.replace(/\(\)$/, ''));
	}
	return result;
}

// ------------------------------------- the nameless commands, and their handlers


/** One `editor.addCommand(binding, handler, when)` call, as Monaco is handed it. */
export type BareCommand = EditorKeyCommand;

/**
 * Every bare `addCommand` the editor registers (`editorKeyCommands`): a
 * keybinding number from Monaco's real `KeyMod`/`KeyCode`, the name of the
 * handler, and the `when` clause.
 *
 * These are the keys with no action id — Enter, Tab, Shift+Tab, the clipboard
 * chords — so `registeredActions` above cannot see them.
 */
export function bareCommands(): BareCommand[] {
	return editorKeyCommands({ KeyMod, KeyCode } as never);
}
