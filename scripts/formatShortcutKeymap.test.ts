import assert from 'node:assert/strict';
import test from 'node:test';

import { getEditorToolbarTools } from '../src/lib/utils/editorToolbar.js';
import {
	OperatingSystem,
	PLATFORMS,
	documentKeymap,
	editorKeymap,
	registeredActions,
	type Chord,
} from './keymapHarness.js';
import { readRustBackend, readSource } from './sourceTree.js';

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
		assert.equal(tool.shortcut('Cmd'), tool.shortcut('Ctrl').replace('Ctrl', 'Cmd'));
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
			assert.deepEqual(
				keymap.get(chord),
				['handleNewFile'],
				`${chord} on ${platform.name} opens a new file and nothing else`,
			);
		}
	}
});

test('no path anywhere still opens a Home tab from a keystroke', () => {
	for (const platform of PLATFORMS) {
		for (const [chord, fired] of documentKeymap(platform.osType)) {
			assert.ok(
				!fired.some((call) => call.includes('addHomeTab')),
				`${chord} on ${platform.name} still reaches addHomeTab`,
			);
		}
	}
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
	const MIRROR: Record<string, string> = {
		'file-new': 'handleNewFile',
		'file-open': 'selectFile',
		'file-save': 'saveContent',
		'file-close': 'closeFile',
		'view-toggle-edit': 'toggleEditView',
		'view-toggle-split': 'toggleSplitView',
		'tab-undo-close': 'handleUndoCloseTab',
	};

	for (const platform of PLATFORMS) {
		const editorSide = editorKeymap(platform.mac, platform.os);
		const documentSide = documentKeymap(platform.osType);

		for (const [id, expectedCall] of Object.entries(MIRROR)) {
			const chords = editorSide.get(id);
			assert.ok(chords?.length, `${id} is bound in the editor on ${platform.name}`);
			for (const chord of chords) {
				if (chord in KNOWN_LAYER_DIVERGENCES) continue;
				const fired = documentSide.get(chord);
				assert.ok(fired, `${platform.name}: ${chord} runs ${id} in the editor but nothing outside it`);
				assert.ok(
					fired.some((call) => call.startsWith(expectedCall)),
					`${platform.name}: ${chord} runs ${id} in the editor but ${fired.join(', ')} outside it`,
				);
			}
		}
	}
});

/**
 * Standalone Monaco's own defaults for the chords this change considered.
 *
 * A SNAPSHOT, and the weakest assertion in this file — it is a copy of what
 * Monaco 0.55 registers, not a reading of it. Enumerating them for real means
 * evaluating `monaco-editor`'s browser-side contribution graph, which needs a
 * DOM the Node test runner does not have; a shim large enough to load it would
 * be a second, synthetic source of truth for exactly the thing being checked.
 *
 * Regenerate against the installed package (not against VS Code's documentation
 * — the two keymaps are NOT the same, which is how Ctrl+Shift+K got proposed
 * for a code block) by loading `monaco-editor` under a DOM shim and dumping
 * `KeybindingsRegistry.getDefaultKeybindings()` once per `process.platform`.
 */
const MONACO_DEFAULTS: Record<Chord, string> = {
	'Ctrl+Shift+K': 'editor.action.deleteLines',
	'Shift+Meta+K': 'editor.action.deleteLines',
	'Alt+Meta+C': 'toggleFindCaseSensitive',
	'Ctrl+Shift+L': 'editor.action.selectHighlights',
	'Shift+Meta+L': 'editor.action.selectHighlights',
	'Ctrl+Shift+O': 'editor.action.quickOutline',
	'Shift+Meta+O': 'editor.action.quickOutline',
	'Ctrl+Shift+1': 'editor.action.replaceOne',
	'Shift+Meta+1': 'editor.action.replaceOne',
	'Ctrl+Shift+,': 'editor.action.inPlaceReplace.up',
	'Shift+Meta+,': 'editor.action.inPlaceReplace.up',
};

test('the shortcuts added for #121 avoid the Monaco defaults they were checked against', () => {
	for (const platform of PLATFORMS) {
		for (const [id, mac, other] of NEW_BINDINGS) {
			const chord = platform.mac ? mac : other;
			assert.ok(
				!(chord in MONACO_DEFAULTS),
				`${id} takes ${chord} on ${platform.name}, which is Monaco's ${MONACO_DEFAULTS[chord]}`,
			);
		}
	}

	// The one deliberate exception, stated rather than left implicit: Quote
	// takes Ctrl/Cmd+Shift+. — GitHub's blockquote chord — from Monaco's
	// `inPlaceReplace.down`, which stays reachable from the command palette.
	// Its sibling `inPlaceReplace.up` is listed above precisely so that moving
	// Quote onto Ctrl+Shift+, would fail this test instead of silently taking
	// the other half.
	assert.equal(MONACO_DEFAULTS['Ctrl+Shift+.'], undefined);
});
