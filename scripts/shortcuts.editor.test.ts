import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { getEditorToolbarTools } from '../src/lib/utils/editorToolbar.js';
import { t } from '../src/lib/utils/i18n.js';
import { formatChord, SHORTCUTS } from '../src/lib/utils/shortcuts.js';
import type { ViewerCommand } from '../src/lib/utils/viewerKeymap.js';
import { bareCommands, type Chord, chordOf, documentKeymap, editorKeymap, OperatingSystem, PLATFORMS, registeredActions } from './keymapHarness.js';

// The editor half of the shortcut contract: the keymap `utils/editorActions.ts`
// declares (actions and nameless key commands), run through `keymapHarness.ts`,
// against the registry the shortcuts panel prints.

describe('shortcut registry', () => {
	/*
	 * THE CONTRACT: every chord the shortcuts panel shows is a chord that actually
	 * fires, and it fires the command the panel says it does.
	 *
	 * A test that compared the registry against the panel would be worthless —
	 * they are the same copy. So every row of `src/lib/utils/shortcuts.ts` is
	 * checked against the code that implements it, using the same harness
	 * the other shortcut tests use (`./keymapHarness.ts`): the editor's
	 * actions are registered by really running `registerLocalizedActions`, and the
	 * document-level chords are discovered by firing synthetic keystrokes at the
	 * real `handleKeyDown`. Neither is a description of the handlers; both are the
	 * handlers.
	 *
	 * The registry is a CLAIM about behaviour. This file is what stops the claim
	 * drifting away from the behaviour.
	 *
	 * NOT ESTABLISHED HERE: that a running WebView delivers these chords. See the
	 * note at the top of `keymapHarness.ts` — resolution order, `when` clauses and
	 * the vim adapter all live in a browser.
	 */
	// ------------------------------------------------ registry chord -> Monaco label

	/**
	 * The key names Monaco's `KeyCodeUtils.toString` prints, where they differ from
	 * the way the registry spells the key for a human.
	 */
	const MONACO_KEY_NAMES: Record<string, string> = {
		Left: 'LeftArrow',
		Right: 'RightArrow',
	};

	/**
	 * A registry chord as the harness spells the same chord.
	 *
	 * The registry is written for a reader (`Mod+Shift+E`); Monaco's decoder emits
	 * `Shift+Meta+E` on macOS and `Ctrl+Shift+E` elsewhere, in its own modifier
	 * order. Translating in this direction — registry into harness — rather than
	 * the other way keeps the registry human-facing, and a mistake here makes
	 * assertions FAIL rather than pass, because the comparison is against chords
	 * the real code produced.
	 */
	function toMonacoLabel(chord: string, mac: boolean): Chord {
		return chord
			.split(' ') // a chord SEQUENCE ("Mod+K T") is two chords
			.map((single) => {
				const parts = single.split('+');
				const key = parts.pop()!;
				const mods = new Set(parts);
				const ctrl = mods.has('Ctrl') || (mods.has('Mod') && !mac);
				// A literal `Meta` stays Meta on every platform, the same way a literal
				// `Ctrl` does. The registry has no such row — the chords that need this
				// spelling are the unadvertised ones named in
				// DOCUMENT_CHORDS_NOT_ADVERTISED, which are written in registry syntax so
				// the exemption list and the registry read alike.
				const meta = mods.has('Meta') || (mods.has('Mod') && mac);
				return [
					ctrl && 'Ctrl',
					mods.has('Shift') && 'Shift',
					mods.has('Alt') && 'Alt',
					meta && 'Meta',
					MONACO_KEY_NAMES[key] ?? key,
				]
					.filter(Boolean)
					.join('+');
			})
			.join(' ');
	}

	test('the chord translator agrees with the harness on chords both already know', () => {
		// If `toMonacoLabel` were broken every assertion below would fail, not pass —
		// but a silent disagreement about ONE key name would look like a real bug in
		// the app, so it is pinned against chords the editor layer independently
		// produces.
		const mac = editorKeymap(true, OperatingSystem.Macintosh);
		const win = editorKeymap(false, OperatingSystem.Windows);

		assert.equal(toMonacoLabel('Mod+Shift+E', true), 'Shift+Meta+E');
		assert.equal(toMonacoLabel('Mod+Shift+E', false), 'Ctrl+Shift+E');
		assert.equal(toMonacoLabel('Mod+K T', false), 'Ctrl+K T');
		assert.equal(toMonacoLabel('Ctrl+Tab', true), 'Ctrl+Tab', 'a literal Ctrl stays Ctrl on macOS');
		assert.equal(toMonacoLabel('Meta+Alt+Left', false), 'Alt+Meta+LeftArrow', 'a literal Meta stays Meta off macOS');
		assert.equal(toMonacoLabel('Alt+Left', false), 'Alt+LeftArrow');

		assert.deepEqual(mac.get('fmt-inline-code'), ['Shift+Meta+E']);
		// `Mod+K T` above is still translated correctly; nothing BINDS a sequence any
		// more, which is the rule asserted further down. Insert Table is the action
		// that used to hold the two-part chord and is the single stroke `Mod+Alt+T`
		// now, so this is the row that would have to change if the sequence came back.
		assert.deepEqual(win.get('insert-table-simple'), ['Ctrl+Alt+T']);
	});

	// ------------------------------------------------------ the contract itself

	test('every chord the registry advertises is the chord the editor really registers', () => {
		let checked = 0;
		for (const platform of PLATFORMS) {
			const keymap = editorKeymap(platform.mac, platform.os);
			for (const entry of SHORTCUTS) {
				if (!entry.editorAction) continue;
				const registered = keymap.get(entry.id);
				assert.ok(
					registered,
					`${platform.name}: the registry says ${entry.id} has a shortcut, but Editor.svelte registers no keybinding for that action id`,
				);
				for (const chord of entry.chords) {
					const want = toMonacoLabel(chord, platform.mac);
					assert.ok(
						registered.includes(want),
						`${platform.name}: the panel would show ${formatChord(chord, platform.mac ? 'Cmd' : 'Ctrl')} for ${entry.id}, but the editor binds it to ${registered.join(', ')}`,
					);
					checked++;
				}
			}
		}
		assert.ok(checked > 50, `only ${checked} editor chords were checked`);
	});

	test('a chord with both halves runs the same command in the editor as outside it', () => {
		// Mod+S inside Monaco called `saveContent` straight, past the clean-file
		// check `runViewerCommand('save')` makes, so it rewrote a saved file the
		// menu and the preview left alone. The editor half now hands the command
		// name to the same switch, so it cannot carry its own copy of a guard.
		const { actions, calls } = registeredActions(false);
		let checked = 0;
		for (const entry of SHORTCUTS) {
			if (!entry.editorAction || !entry.documentCommands) continue;
			const action = actions.find((candidate) => candidate.id === entry.id);
			assert.ok(action, `${entry.id} is registered in the editor`);
			const before = calls.length;
			action.run();
			assert.deepEqual(calls.slice(before), [`oncommand(${JSON.stringify(entry.documentCommands[0])})`], entry.id);
			checked++;
		}
		assert.ok(checked > 10, `only ${checked} editor commands were checked`);
	});

	test('the editor command palette names the commands the way the panel does', () => {
		const { actions } = registeredActions(false);
		for (const id of ['file-reveal', 'view-toggle-edit', 'view-toggle-live']) {
			const labelKey = SHORTCUTS.find((entry) => entry.id === id)?.labelKey;
			assert.ok(labelKey, `${id} is in the registry`);
			assert.equal(actions.find((action) => action.id === id)?.label, t(labelKey, 'en'), `${id} in the palette`);
		}
	});

	// -------------------------------------------------- editor bindings vs panel

	/**
	 * Editor actions that carry a keybinding and are deliberately NOT advertised.
	 *
	 * Without this list the registry could quietly fall behind: someone binds a new
	 * chord, the panel never mentions it, and no test notices. Each exclusion is a
	 * decision with a reason, in the shape this repo already uses for
	 * `KNOWN_LAYER_DIVERGENCES`.
	 */
	const NOT_ADVERTISED: Record<string, string> = {
		'custom-copy':
			'the OS clipboard convention, not an app shortcut; its Ctrl+V twin is a bare addCommand with no id, so listing one without the other is the more confusing half-answer',
	};

	test('every keybinding the editor registers is either advertised or consciously not', () => {
		const advertised = new Set(SHORTCUTS.filter((entry) => entry.editorAction).map((entry) => entry.id));
		const bound = [...editorKeymap(false, OperatingSystem.Windows).keys()];
		assert.ok(bound.length > 20, `the editor binds ${bound.length} actions`);

		const unexplained = bound.filter((id) => !advertised.has(id) && !(id in NOT_ADVERTISED));
		assert.deepEqual(
			unexplained,
			[],
			'these editor actions have a keybinding that the shortcuts panel never mentions; ' +
				'add a row to SHORTCUTS or a reason to NOT_ADVERTISED',
		);

		// The exclusion list must not rot: a binding that went away has to leave it.
		for (const id of Object.keys(NOT_ADVERTISED)) {
			assert.ok(bound.includes(id), `${id} no longer has a keybinding — drop it from NOT_ADVERTISED`);
		}
	});

	// ------------------------------------------- every chord is one keystroke
	//
	// The rule that replaced the `Mod+K` namespace. Insert Table and Insert Column
	// used to be `Mod+K T` and `Mod+K C`, and Insert Table had to be registered
	// TWICE — once released, once with the modifier still held — because "Cmd+K T"
	// reads as one gesture and `Cmd+K` then `Cmd+T` otherwise fell through to
	// `file-new`: asking for a table opened a tab. That was the cheaper half of the
	// problem. The expensive half was that people found the two-key gesture awkward
	// enough to stop using it, which is what this whole rework came out of.
	//
	// So there is no namespace to keep consistent any more, and the invariant worth
	// holding is the stronger one: nothing the app binds is a sequence at all.

	test('the app binds no chord sequence anywhere, in either keyboard layer', () => {
		// `Mod+K` is Insert Link now, so a sequence beginning with it could not be
		// typed even if something declared one — the first key would fire the link.
		// This is the rule that would catch a new sequence being introduced on some
		// other prefix, which is the shape the ergonomics complaint was about rather
		// than anything specific to K.
		let checked = 0;
		for (const platform of PLATFORMS) {
			for (const [id, chords] of editorKeymap(platform.mac, platform.os)) {
				for (const chord of chords) {
					assert.ok(
						!chord.includes(' '),
						`${platform.name}: ${id} is bound to the sequence ${chord}; every binding here is one keystroke`,
					);
					checked++;
				}
			}
			for (const command of bareCommands()) {
				const chord = chordOf(command.binding, platform.os);
				assert.ok(!chord.includes(' '), `${platform.name}: ${command.handler} is bound to the sequence ${chord}`);
				checked++;
			}
		}
		assert.ok(checked > 90, `only ${checked} bindings were checked`);

		// And the registry says the same thing, which is the half a user sees: the
		// panel cannot advertise a gesture the editor no longer answers.
		for (const entry of SHORTCUTS) {
			for (const chord of entry.chords) {
				assert.ok(!chord.includes(' '), `${entry.id} advertises the sequence ${chord}`);
			}
		}
	});

	test('Mod+K belongs to Insert Link, on every platform', () => {
		// The decision itself, asserted where a reader will look for it. Typora, Bear,
		// iA Writer and GitHub all document this chord for Insert Link — four
		// independent sources agreeing exactly, which no other command in the survey
		// managed — and the link button carried no shortcut at all before this.
		for (const platform of PLATFORMS) {
			const chord = platform.mac ? 'Meta+K' : 'Ctrl+K';
			assert.deepEqual(editorKeymap(platform.mac, platform.os).get('fmt-link'), [chord], platform.name);
			assert.equal(
				SHORTCUTS.find((entry) => entry.id === 'fmt-link')?.chords[0],
				'Mod+K',
				'the panel advertises it too',
			);
		}
	});

	/**
	 * Table verbs that are commands with no key, and the reason each one lost it.
	 *
	 * Dropping a CHORD is not dropping a command: `addAction` without `keybindings`
	 * still puts the verb in the command palette (`Mod+P`, which runs Monaco's
	 * `editor.action.quickCommand`).
	 *
	 * WHAT DECIDES IT IS HOW HARD THE EDIT IS BY HAND, not whether it destroys
	 * anything. This table used to say the opposite — that destructive table verbs
	 * get no keys because a mis-fire costs too much — and that rule is gone rather
	 * than sitting here next to the one the code follows: Delete Column destroys
	 * more than Delete Row does and has a chord (`Mod+Shift+Backspace`), so the old
	 * rationale could not have been what was being applied. The hazard it named is
	 * also gone in fact: the `Mod+K` namespace no longer exists, so no table verb
	 * sits one slip from Monaco's delete-line (`Mod+Shift+K`) any more.
	 *
	 * The four verbs, and what each one is worth a key for:
	 *
	 *   Insert Row      Mod+Enter / Mod+Shift+Enter, and Tab at the last cell
	 *                   — the frequent one, so it gets the cheapest keys there are
	 *   Insert Column   Mod+Shift+C — mid-frequency, and fiddly by hand
	 *   Delete Column   Mod+Shift+Backspace — NO manual fallback: it means editing
	 *                   the pipes on every row without slipping once
	 *   Delete Row      palette only — trivial by hand. Put the caret on the line,
	 *                   select it, delete. A chord buys nothing the keyboard does
	 *                   not already do, and an unearned chord is one more key to
	 *                   mis-fire.
	 *
	 * So the test of a new row here is not "is it dangerous" but "can the user
	 * already do this without us".
	 */
	const TABLE_VERBS_WITHOUT_A_CHORD: Record<string, string> = {
		'table-insert-row':
			'Mod+Enter owns it now — inside a table, "insert a line below" already means "insert a row below"',
		'table-delete-row':
			'trivial by hand — put the caret on the line, select it, delete — so a chord buys nothing the ' +
			'keyboard already does. This is the only one of the four with a manual fallback that good, ' +
			'which is why it is the only one left without a key',
	};

	test('the table verbs with no chord are still commands, and advertise nothing', () => {
		const actions = new Map(registeredActions(false).actions.map((action) => [action.id, action]));
		for (const [id, why] of Object.entries(TABLE_VERBS_WITHOUT_A_CHORD)) {
			const action = actions.get(id);
			assert.ok(action, `${id} must stay registered — the key went away, not the command (${why})`);
			assert.deepEqual(action.keybindings ?? [], [], `${id} has a keybinding again; it was dropped because ${why}`);
			assert.equal(
				SHORTCUTS.find((entry) => entry.id === id),
				undefined,
				`${id} has no chord, so the panel must not claim one`,
			);
		}
	});

	// ------------------------------------- the contextual keys (the `keys` group)
	//
	// Enter, Tab and Shift+Tab are bound with a bare `editor.addCommand`: no action
	// id, no label, no menu entry. That is right — they are not commands a user
	// invokes, they are what those keys already mean one Markdown rule further on —
	// but it also made them INVISIBLE. #636 shipped Enter continuing a list and
	// nothing in the app said so anywhere; the `keys` group in the registry is that
	// omission being fixed, and this section is what keeps the fix honest.
	//
	// `editorAction` cannot carry these rows, because `editorKeymap` is built from
	// `addAction` descriptors and a nameless command has none. So the row names the
	// HANDLER instead, and the handler is looked up in the component's real
	// `addCommand` calls with the keybinding evaluated by Monaco's own `KeyMod`.

	/**
	 * Nameless commands the editor binds that are deliberately not advertised.
	 *
	 * The two clipboard chords, for the reason `NOT_ADVERTISED` already gives for
	 * their `custom-copy` twin: they are OS conventions rather than app shortcuts.
	 * Everything else the editor binds without a name has to be in the panel.
	 */
	const BARE_NOT_ADVERTISED: Record<string, string> = {
		cutToClipboard:
			'the OS clipboard convention, not an app shortcut; bound only because Monaco leaves cut/paste unbound in a browser',
		pasteFromClipboard: 'the same, one key over',
	};

	test('every contextual key the registry advertises is bound to the handler it names', () => {
		const advertised = SHORTCUTS.filter((entry) => entry.editorCommand);
		assert.ok(advertised.length >= 3, `${advertised.length} rows name a bare command`);

		for (const platform of PLATFORMS) {
			const bound = new Map(bareCommands().map((call) => [chordOf(call.binding, platform.os), call.handler]));
			for (const entry of advertised) {
				for (const chord of entry.chords) {
					const want = toMonacoLabel(chord, platform.mac);
					assert.equal(
						bound.get(want),
						entry.editorCommand,
						`${platform.name}: the panel would show ${formatChord(chord, platform.mac ? 'Cmd' : 'Ctrl')} ` +
							`for ${entry.id} (${entry.editorCommand}), but that chord is bound to ${bound.get(want) ?? 'nothing'}`,
					);
				}
			}
		}
	});

	test('every nameless command the editor binds is advertised, or consciously not', () => {
		// The completeness direction, which is the one that would have caught #636
		// shipping unannounced: a new bare binding has to be shown or explained.
		const advertised = new Set(SHORTCUTS.map((entry) => entry.editorCommand).filter(Boolean));
		const bound: string[] = bareCommands().map((call) => call.handler);

		const unexplained = bound.filter((handler) => !advertised.has(handler) && !(handler in BARE_NOT_ADVERTISED));
		assert.deepEqual(
			unexplained,
			[],
			'these keys do something extra in the editor and the shortcuts panel never mentions it; ' +
				'add a row to SHORTCUTS (group `keys`) or a reason to BARE_NOT_ADVERTISED',
		);

		for (const handler of Object.keys(BARE_NOT_ADVERTISED)) {
			assert.ok(bound.includes(handler), `${handler} is no longer bound — drop it from BARE_NOT_ADVERTISED`);
		}
	});
});

describe('formatting shortcuts keymap', () => {
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
			// `shortcuts.test.ts` owns the per-platform naming and this only has to
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

		// `oncommand` is bound to `runViewerCommand`, the switch the document-level
		// branch reaches too, so both halves run the same `new-file`.
		const probe = registeredActions(false);
		const fileNew = probe.actions.find((action) => action.id === 'file-new');
		assert.ok(fileNew, 'file-new is registered');
		const before = probe.calls.length;
		fileNew.run();
		assert.deepEqual(probe.calls.slice(before), ['oncommand("new-file")'], 'file-new runs the new-file command');
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
		// switcher; the document handler accepts
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
});

/**
 * #153: "While in Preview Mode - Ctrl+O doesn't work on windows."
 *
 * It works now — the branch is in the document-level dispatcher, which is
 * attached to `<svelte:document>` rather than to the editor, and it carries no
 * editing condition. What it never had is anything holding it there. The comment on
 * the fix cited a test file that does not exist, and grepping the suite for
 * `selectFile` returned nothing, so the report's own scenario was resting on
 * the absence of a guard nobody had written down.
 *
 * That is the failure mode this file exists for: a shortcut that lives in two
 * layers. `Ctrl+T` already went wrong that way (#392) — Monaco answered it
 * inside the editor and the document handler answered it outside, and the two
 * meant different things. Ctrl+O is answered by both layers as well; what
 * makes it correct rather than a second #392 is that both call the same
 * function, and that is what the second test holds.
 *
 * `documentKeymap` fires real chords at the real imported dispatcher with
 * `isEditing: false` — the reporter's preview mode — and reports what each one
 * means.
 */
describe('open shortcut in preview', () => {
	test('the editor claims it too, and both layers do the same thing', () => {
		// Monaco calls `stopPropagation()` on a keystroke it consumes, so inside
		// the editor its own `file-open` answers and the document handler never
		// runs. That is fine — and is the shape #392 got WRONG — only because the
		// two answers are the same command: `file-open` hands `open-file` to
		// `oncommand`, and the viewer passes `runViewerCommand` to it, which is
		// what the document branch calls.
		for (const platform of PLATFORMS) {
			const chord = platform.mac ? 'Meta+O' : 'Ctrl+O';
			const claimed = [...editorKeymap(platform.mac, platform.os)]
				.filter(([, chords]) => chords.includes(chord))
				.map(([actionId]) => actionId);

			assert.deepEqual(claimed, ['file-open'], `${platform.name}: ${chord}`);
		}

		const { actions, calls } = registeredActions(false);
		actions.find((action) => action.id === 'file-open')?.run();
		assert.deepEqual(calls, ['oncommand("open-file")'], 'file-open hands open-file to oncommand');
	});
});
