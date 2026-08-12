import assert from 'node:assert/strict';
import test from 'node:test';

import { KeyCode } from 'monaco-editor/esm/vs/editor/common/standalone/standaloneEnums.js';
import { KeyMod } from 'monaco-editor/esm/vs/editor/common/services/editorBaseApi.js';

import { getEditorToolbarTools } from '../src/lib/utils/editorToolbar.js';
import {
	OperatingSystem,
	PLATFORMS,
	bareCommands,
	chordOf,
	documentKeymap,
	editorKeymap,
	registeredActions,
	viewerCommandTable,
	type Chord,
} from './keymapHarness.js';
import type { ViewerCommand } from '../src/lib/utils/viewerKeymap.js';
import { readRustBackend, readSource, sliceBetween, sliceFrom } from './sourceTree.js';

/*
 * Issues #121 (six formatting commands with no shortcut) and #392 (Ctrl+T means
 * two things). Both needed the same thing first — the whole keymap — so they are
 * held by one file.
 *
 * The machinery that RUNS the two keyboard layers now lives in
 * `./keymapHarness.ts`, because the shortcut-registry contract needs the same
 * two functions and must not be checked against a second, more forgiving model
 * of the app. What each harness does and does not establish is documented there.
 */

// ------------------------------------------------------------------ item #121

/**
 * The six bindings this change adds, and the chord each must resolve to.
 *
 * `CtrlCmd` resolves to Meta on macOS and Ctrl everywhere else, so each row is
 * checked against Monaco's decoder once per platform rather than assumed.
 */
const NEW_BINDINGS: ReadonlyArray<[actionId: string, mac: Chord, other: Chord, toolbarLabel: string]> = [
	['fmt-heading-1', 'Meta+1', 'Ctrl+1', '+1'],
	['fmt-heading-2', 'Meta+2', 'Ctrl+2', '+2'],
	['fmt-heading-3', 'Meta+3', 'Ctrl+3', '+3'],
	['fmt-inline-code', 'Shift+Meta+E', 'Ctrl+Shift+E', '+Shift+E'],
	['fmt-code-block', 'Shift+Meta+F', 'Ctrl+Shift+F', '+Shift+F'],
	['fmt-quote', 'Shift+Meta+.', 'Ctrl+Shift+.', '+Shift+.'],
];

test('each formatting action asked for in #121 now carries its shortcut', () => {
	for (const platform of PLATFORMS) {
		const keymap = editorKeymap(platform.mac, platform.os);
		for (const [id, mac, other] of NEW_BINDINGS) {
			assert.deepEqual(
				keymap.get(id),
				[platform.mac ? mac : other],
				`${id} on ${platform.name}`,
			);
		}
	}
});

test('each new shortcut runs the command it is labelled with', () => {
	// The binding and the body are two separate fields of one object literal,
	// and nothing in the type system stops `fmt-heading-2` from carrying
	// heading 3's `run`. Each action is invoked and the call it makes recorded.
	const expected: Record<string, string> = {
		'fmt-heading-1': 'toggleLineMarkerTool("fmt-heading-1")',
		'fmt-heading-2': 'toggleLineMarkerTool("fmt-heading-2")',
		'fmt-heading-3': 'toggleLineMarkerTool("fmt-heading-3")',
		'fmt-quote': 'toggleLineMarkerTool("fmt-quote")',
		'fmt-inline-code': 'toggleInlineWrapTool("fmt-inline-code")',
		'fmt-code-block': 'wrapAsCodeBlock',
	};

	const { actions, calls } = registeredActions(false);
	for (const [id, want] of Object.entries(expected)) {
		const action = actions.find((a) => a.id === id);
		assert.ok(action, `${id} is registered`);
		const before = calls.length;
		action.run();
		assert.deepEqual(calls.slice(before), [want], `${id} runs ${want}`);
	}
});

test('the toolbar tooltip prints the shortcut the editor actually registered', () => {
	// Two copies of one fact: Editor.svelte binds the key, editorToolbar.ts
	// renders the hint on the button. Bold, Italic and Underline already had
	// both and nothing held them together.
	const byId = new Map(getEditorToolbarTools(null).map((tool) => [tool.id, tool]));
	const bound = editorKeymap(false, OperatingSystem.Windows);

	for (const [id, tool] of byId) {
		const chords = bound.get(id);
		if (!chords) {
			assert.equal(tool.shortcut, undefined, `${id} has no keybinding, so the toolbar must not advertise one`);
			continue;
		}
		assert.ok(tool.shortcut, `${id} is bound to ${chords.join(' ')} but the toolbar shows nothing`);
		// "Ctrl+Shift+E" -> "Ctrl+Shift+E"; a chord sequence "Ctrl+K T" -> "Ctrl+K T".
		assert.equal(
			tool.shortcut('Ctrl'),
			chords[0].replace(/\bMeta\b/g, 'Ctrl'),
			`${id}: toolbar hint and registered keybinding disagree`,
		);
		// Both renderings come from the same registry row through `formatChord`, so
		// they name the same key and the same number of modifiers — but NOT the same
		// WORDS: `Alt` is `Opt` on macOS (#651). Asserting a string substitution here
		// would be a second copy of that word map, which is the defect #651 removed;
		// `shortcutRegistry.test.ts` owns the per-platform naming and this only has to
		// prove the two renderings are still the same chord.
		const asCmd = tool.shortcut('Cmd').split('+');
		const asCtrl = tool.shortcut('Ctrl').split('+');
		assert.equal(asCmd.length, asCtrl.length, `${id}: the two renderings are not the same chord`);
		assert.equal(asCmd.at(-1), asCtrl.at(-1), `${id}: the two renderings end on different keys`);
	}

	// The rows this change adds, spelled out, so that deleting one of them from
	// editorToolbar.ts fails here rather than passing the loop above vacuously.
	for (const [id, , , suffix] of NEW_BINDINGS) {
		assert.equal(byId.get(id)?.shortcut?.('Cmd'), `Cmd${suffix}`, `${id} toolbar hint`);
	}
});

// ------------------------------------------------------------------ item #392

const NEW_FILE_CHORDS = { mac: ['Meta+N', 'Meta+T'], other: ['Ctrl+N', 'Ctrl+T'] };

test('Ctrl/Cmd+T means new file in the editor, on every platform', () => {
	for (const platform of PLATFORMS) {
		const chords = editorKeymap(platform.mac, platform.os).get('file-new');
		assert.deepEqual(
			chords,
			platform.mac ? NEW_FILE_CHORDS.mac : NEW_FILE_CHORDS.other,
			`file-new on ${platform.name}`,
		);
	}

	// `onnew` is the prop MarkdownViewer.svelte binds to `handleNewFile`, which
	// is the same function the document-level branch calls after this change.
	const probe = registeredActions(false);
	const fileNew = probe.actions.find((action) => action.id === 'file-new');
	assert.ok(fileNew, 'file-new is registered');
	const before = probe.calls.length;
	fileNew.run();
	assert.deepEqual(probe.calls.slice(before), ['onnew'], 'file-new calls the onnew prop');

	assert.match(
		readSource('src/lib/MarkdownViewer.svelte'),
		/onnew=\{handleNewFile\}/,
		'the editor prop is wired to handleNewFile',
	);
});

test('Ctrl/Cmd+T means new file outside the editor too, on every platform', () => {
	// This is #392. Before the fix the document-level handler answered the same
	// chord with `tabManager.addHomeTab`, so the meaning of Ctrl+T depended on
	// where the caret was — Monaco consumes the keystroke and stops it
	// propagating only when it is the editor that has focus.
	for (const platform of PLATFORMS) {
		const keymap = documentKeymap(platform.osType);
		for (const chord of platform.mac ? ['Meta+T', 'Meta+N'] : ['Ctrl+T', 'Ctrl+N']) {
			assert.equal(
				keymap.get(chord),
				'new-file',
				`${chord} on ${platform.name} opens a new file and nothing else`,
			);
		}
	}
});

test('no path anywhere still opens a Home tab from a keystroke', () => {
	// The #392 defect in its original spelling: the document branch for Ctrl+T
	// called `tabManager.addHomeTab`. There is no `ViewerCommand` for that any
	// more, so the checkable end is the other one — the component's command table
	// has no route to `addHomeTab`, from any chord. `viewerCommandTable()` reads
	// that table out of the component; see its note in `keymapHarness.ts`.
	const routes = Object.entries(viewerCommandTable()).filter(([, body]) => body.includes('addHomeTab'));
	assert.deepEqual(routes.map(([command]) => command), [], 'a keyboard command still reaches addHomeTab');
});

test('the native macOS menu claims exactly two accelerators, and T is not one', () => {
	// The third code path in #392. The menu was trimmed to Settings and Quit
	// (#281); anything added back that takes Cmd+T would reintroduce a fourth
	// meaning, above both layers above, and neither of them could see it.
	const rust = readRustBackend();
	const accelerators = [...rust.matchAll(/\.accelerator\("([^"]+)"\)/g)].map((m) => m[1]).sort();
	assert.deepEqual(accelerators, ['CmdOrCtrl+,', 'CmdOrCtrl+Q']);
});

// ---------------------------------------------------------- the whole keymap

test('no two editor actions claim the same chord', () => {
	for (const platform of PLATFORMS) {
		const owners = new Map<Chord, string[]>();
		for (const [id, chords] of editorKeymap(platform.mac, platform.os)) {
			for (const chord of chords) owners.set(chord, [...(owners.get(chord) ?? []), id]);
		}
		for (const [chord, ids] of owners) {
			assert.equal(ids.length, 1, `${platform.name}: ${chord} is claimed by ${ids.join(' and ')}`);
		}
	}
});

/**
 * Chords the two layers answer differently, on purpose or not.
 *
 * A chord that both Monaco and the document handler answer must mean the same
 * thing in both, or it means two things depending on focus — which is exactly
 * what #392 reported. Everything left here is a divergence that predates this
 * change; each is named so that a NEW one fails instead of joining a silent
 * pile.
 */
const KNOWN_LAYER_DIVERGENCES: Record<Chord, string> = {
	// Monaco binds real Ctrl+Tab on macOS because Cmd+Tab is the system app
	// switcher (see editorOptionWiring.test.ts); the document handler accepts
	// either modifier. Same action, different chord — not a meaning conflict.
	'Ctrl+Tab': 'tab cycling: Monaco uses WinCtrl on macOS, the window handler accepts Ctrl or Cmd',
	'Ctrl+Shift+Tab': 'tab cycling, as above',
	'Meta+Tab': 'tab cycling, as above',
	'Shift+Meta+Tab': 'tab cycling, as above',
};

test('a chord that both layers answer means the same thing in both', () => {
	// The pairs the app deliberately mirrors: the editor action and the
	// window-level branch that stands in for it when the caret is elsewhere.
	const MIRROR: Record<string, ViewerCommand> = {
		'file-new': 'new-file',
		'file-open': 'open-file',
		'file-save': 'save',
		'file-close': 'close-file',
		'view-toggle-edit': 'toggle-edit-view',
		'view-toggle-split': 'toggle-split-view',
		'tab-undo-close': 'undo-close-tab',
	};

	for (const platform of PLATFORMS) {
		const editorSide = editorKeymap(platform.mac, platform.os);
		const documentSide = documentKeymap(platform.osType);

		for (const [id, expectedCommand] of Object.entries(MIRROR)) {
			const chords = editorSide.get(id);
			assert.ok(chords?.length, `${id} is bound in the editor on ${platform.name}`);
			for (const chord of chords) {
				if (chord in KNOWN_LAYER_DIVERGENCES) continue;
				assert.ok(documentSide.has(chord), `${platform.name}: ${chord} runs ${id} in the editor but nothing outside it`);
				assert.equal(
					documentSide.get(chord),
					expectedCommand,
					`${platform.name}: ${chord} runs ${id} in the editor but ${documentSide.get(chord)} outside it`,
				);
			}
		}
	}
});

/*
 * WHERE THE MONACO SIDE OF THIS WENT.
 *
 * This file used to end with `MONACO_DEFAULTS`: eleven chords hand-copied out
 * of Monaco 0.55, and a test that the six #121 bindings avoided them. It was
 * the weakest assertion here and said so — a copy of Monaco's keymap, not a
 * reading of it, covering the chords that happened to be considered at the
 * time. What it could not see is what it did not list, and `toggle-zen-mode`
 * sitting on `redo` was exactly that.
 *
 * `monacoChordOwnership.spec.ts` replaces it by importing `monaco-editor` under
 * jsdom and dumping `KeybindingsRegistry.getDefaultKeybindings()` per platform,
 * so the check is against ALL of Monaco's chords rather than a remembered
 * eleven — including Quote's deliberate `inPlaceReplace.down` override, which
 * is now argued in that file's allow-list instead of asserted by absence here.
 *
 * What is left in this file is the other direction, below: a Monaco default the
 * app takes OFF the keymap rather than takes over. Nothing of ours claims that
 * key, so it is not a chord-ownership question and does not belong in the
 * ownership file; both ends of it are read out of the installed Monaco.
 */

// ------------------------------------- a core Monaco binding, taken back off

/**
 * The `-`-prefixed rules `Editor.svelte` hands `monaco.editor.addKeybindingRules`,
 * evaluated with Monaco's own `KeyMod`/`KeyCode`.
 *
 * The same trick as the rest of this harness: the numbers come from the real
 * enums, so a rule that names the wrong chord cannot look right here.
 */
function removedKeybindings(): Array<{ keybinding: number; command: string }> {
	const marker = 'monaco.editor.addKeybindingRules(';
	const literal = sliceBetween(readSource('src/lib/components/Editor.svelte'), marker, ');').slice(marker.length);
	return new Function('monaco', `return ${literal};`)({ KeyMod, KeyCode });
}

test('Mod+Shift+K deletes no line here, and Delete Line keeps its palette entry', () => {
	// WHY THE KEY GOES. `editor.action.deleteLines` is VS Code's convention,
	// inherited by standalone Monaco and inherited again by this app, where it
	// silently destroys the line the caret is on. None of the mainstream Markdown
	// editors — Typora, Obsidian, iA Writer, Bear — binds it: it is a code-editor
	// key that leaked into a prose editor, and it was being mis-fired.
	//
	// WHY IT IS A REMOVAL RULE. Binding the chord to a no-op `addCommand` would
	// make the key dead AND leave a fake command sitting in front of Monaco's;
	// a rule whose command id starts with `-` is what Monaco itself reads as
	// "drop this default", which is the shape a core binding has to be undone in.

	// 1. That mechanism, read out of the installed Monaco rather than assumed.
	const resolver = readSource(
		new URL('../node_modules/monaco-editor/esm/vs/platform/keybinding/common/keybindingResolver.js', import.meta.url),
	);
	assert.match(
		sliceFrom(resolver, 'static handleRemovals('),
		/rule\.command\.charAt\(0\) === '-'/,
		"Monaco no longer drops defaults by a '-'-prefixed command id",
	);

	// 2. The default being removed, likewise: both the id and the chord come from
	//    Monaco's source, so a rename or a re-chord upstream fails here instead of
	//    leaving behind a rule that quietly matches nothing.
	const linesOperations = readSource(
		new URL('../node_modules/monaco-editor/esm/vs/editor/contrib/linesOperations/browser/linesOperations.js', import.meta.url),
	);
	assert.match(
		sliceBetween(linesOperations, "id: 'editor.action.deleteLines'", 'run(_accessor'),
		/primary: 2048 \/\* KeyMod\.CtrlCmd \*\/ \| 1024 \/\* KeyMod\.Shift \*\/ \| 41 \/\* KeyCode\.KeyK \*\//,
		'Monaco binds Delete Line to some other chord now',
	);

	// 3. The rule the app registers, and nothing else: this is a keymap subtraction
	//    with one entry, and a second one arriving unremarked is a decision nobody
	//    wrote down.
	assert.deepEqual(removedKeybindings(), [
		{ keybinding: KeyMod.CtrlCmd | KeyMod.Shift | KeyCode.KeyK, command: '-editor.action.deleteLines' },
	]);

	// 4. And nothing of the app's took the chord instead. The command stays in the
	//    command palette — dropping a KEY is not dropping a command, the same rule
	//    the table delete verbs live under — but the keystroke now does nothing.
	for (const platform of PLATFORMS) {
		const chord = platform.mac ? 'Shift+Meta+K' : 'Ctrl+Shift+K';
		assert.equal(chordOf(removedKeybindings()[0].keybinding, platform.os), chord);
		for (const [id, chords] of editorKeymap(platform.mac, platform.os)) {
			assert.ok(!chords.includes(chord), `${platform.name}: ${id} binds ${chord}, the chord just unbound`);
		}
		for (const command of bareCommands()) {
			assert.notEqual(
				chordOf(command.binding, platform.os),
				chord,
				`${platform.name}: ${command.handler} binds ${chord}, the chord just unbound`,
			);
		}
	}
});
