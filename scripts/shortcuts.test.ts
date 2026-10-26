import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import ts from 'typescript';

import { buildMenuModel, type MenuNode, type MenuState } from '../src/lib/utils/appMenu.js';
import { getSupportedLanguages, type LanguageCode, t, type Translation } from '../src/lib/utils/i18n.js';
import { formatChord, modifierFor, SHORTCUT_GROUPS, type ShortcutEntry, shortcutLabel, SHORTCUTS, shortcutSections } from '../src/lib/utils/shortcuts.js';
import type { ViewMode } from '../src/lib/utils/titlebarToolbar.js';
import type { ViewerCommand } from '../src/lib/utils/viewerKeymap.js';
import { tabListMenuItems, tabMenuItems } from '../src/lib/utils/tabContextMenu.js';
import { translations } from './allTranslations.js';
import { type Chord, documentKeymap, PLATFORMS } from './keymapHarness.js';

describe('shortcut registry', () => {
	/*
	 * THE CONTRACT: every chord the shortcuts panel shows is a chord that actually
	 * fires, and it fires the command the panel says it does.
	 *
	 * A test that compared the registry against the panel would be worthless —
	 * they are the same copy. So every row of `src/lib/utils/shortcuts.ts` is
	 * checked against the code that implements it, using the same harness
	 * `formatShortcutKeymap.test.ts` uses (`./keymapHarness.ts`): the editor's
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

	// ------------------------------------------------------------- sanity guards

	test('the registry was actually read, and is internally coherent', () => {
		// Every assertion below iterates SHORTCUTS. If it were empty — or if a filter
		// silently dropped everything — they would all pass having checked nothing.
		assert.ok(SHORTCUTS.length > 25, `the registry holds ${SHORTCUTS.length} entries`);

		const ids = SHORTCUTS.map((entry) => entry.id);
		assert.equal(new Set(ids).size, ids.length, 'shortcut ids are unique');

		for (const entry of SHORTCUTS) {
			assert.ok(entry.chords.length > 0, `${entry.id} declares at least one chord`);
			assert.ok(
				SHORTCUT_GROUPS.some((group) => group.group === entry.group),
				`${entry.id} is in a group the panel renders`,
			);
		}

		// Every entry reaches the panel: no row can be in the registry and invisible.
		const rendered = shortcutSections('macos').flatMap((section) => section.entries.map((e) => e.id));
		assert.deepEqual([...rendered].sort(), [...ids].sort());
	});

	test('no registry entry is unverifiable', () => {
		// The rule that makes this file mean something: a row must name the thing
		// that implements it, or it cannot be checked and must not be advertised.
		for (const entry of SHORTCUTS) {
			assert.ok(
				entry.editorAction || entry.editorCommand || entry.documentCommands,
				`${entry.id} names no implementation, so nothing here can confirm its chord fires`,
			);
		}
	});

	test('no two entries advertise the same chord on the same platform', () => {
		// Two rows claiming one chord means at least one of them is a lie, and the
		// panel would print both with a straight face.
		for (const platform of PLATFORMS) {
			const owners = new Map<string, string[]>();
			for (const entry of SHORTCUTS) {
				for (const chord of entry.chords) {
					const key = toMonacoLabel(chord, platform.mac);
					owners.set(key, [...(owners.get(key) ?? []), entry.id]);
				}
			}
			for (const [chord, ids] of owners) {
				assert.equal(ids.length, 1, `${platform.name}: ${chord} is advertised by ${ids.join(' and ')}`);
			}
		}
	});

	test('every chord the registry advertises runs the command it names, outside the editor', () => {
		let checked = 0;
		for (const platform of PLATFORMS) {
			const keymap = documentKeymap(platform.osType);
			for (const entry of SHORTCUTS) {
				if (!entry.documentCommands) continue;
				if (entry.documentExempt?.includes(platform.osType)) continue;
				for (const [index, chord] of entry.chords.entries()) {
					// One command for the whole row, or one per chord in `chords` order.
					// `assert.equal` rather than the old prefix match: the registry names a
					// `ViewerCommand` now, so there is an exact answer to compare against
					// and `tab-next` can no longer be satisfied by `tab-prev`'s branch.
					const command: ViewerCommand | undefined =
						entry.documentCommands[entry.documentCommands.length === 1 ? 0 : index];
					assert.ok(command, `${entry.id} lists ${entry.documentCommands.length} commands for ${entry.chords.length} chords`);
					const want = toMonacoLabel(chord, platform.mac);
					assert.ok(
						keymap.has(want),
						`${platform.name}: the panel would show ${formatChord(chord, platform.mac ? 'Cmd' : 'Ctrl')} for ${entry.id}, but that chord does nothing outside the editor`,
					);
					assert.equal(
						keymap.get(want),
						command,
						`${platform.name}: ${want} is advertised as ${entry.id} (${command}) but means ${keymap.get(want)}`,
					);
					checked++;
				}
			}
		}
		assert.ok(checked > 40, `only ${checked} document chords were checked`);
	});

	/** Every macOS menu item that carries an accelerator, in every state that changes which. */
	function menuAccelerators(): Array<{ text: string; accelerator: string; action: MenuNode & { kind: 'item' | 'check' } }> {
		const flatten = (nodes: readonly MenuNode[]): MenuNode[] =>
			nodes.flatMap((node) => (node.kind === 'submenu' ? flatten(node.items) : [node]));
		return flatten(buildMenuModel({ language: 'en', viewMode: 'edit', liveMode: true, hasEditorPane: true, showToc: true, showTabs: true, showEditorToolbar: true, previewFullWidth: false })).flatMap((node) =>
			(node.kind === 'item' || node.kind === 'check') && node.accelerator
				? [{ text: node.text, accelerator: node.accelerator, action: node }]
				: [],
		);
	}

	/** A menu accelerator as a registry chord (`CmdOrCtrl` is `Mod`). */
	function chordOfAccelerator(accelerator: string): string {
		return accelerator.replace(/^CmdOrCtrl\b/, 'Mod');
	}

	test('the panel names each command the way the macOS menu does', () => {
		// One command, one name: the panel said "Exit" where the menu says "Quit
		// Markpad", "Editor" for Edit Mode, "Toggle Live Mode" for Auto-Reload and
		// "Move to" for Move Tab to Next Window.
		const panel = shortcutSections('macos').flatMap((section) => section.entries);
		// Pre-existing: the menu's check item is "Tab Bar", the panel's "Toggle Tab Bar".
		const knownDifferent = new Set(['toggle-tabs']);
		let compared = 0;
		for (const { text, accelerator } of menuAccelerators()) {
			const row = SHORTCUTS.find((entry) => entry.chords.includes(chordOfAccelerator(accelerator)));
			if (!row || knownDifferent.has(row.id)) continue;
			const entry = panel.find((candidate) => candidate.id === row.id)!;
			assert.equal(t(entry.labelKey, 'en'), text, `${row.id}: the panel and the menu disagree`);
			compared++;
		}
		assert.ok(compared > 30, `only ${compared} menu items compared`);
		// Windows and Linux have no app menu; their in-app menu says Exit.
		const windows = shortcutSections('windows').flatMap((section) => section.entries);
		assert.equal(windows.find((entry) => entry.id === 'app-exit')?.labelKey, 'menu.exit');
	});

	test('the command palette row says it only works in the editor', () => {
		const palette = shortcutSections('macos')
			.flatMap((section) => section.entries)
			.find((entry) => entry.id === 'app-command-palette');
		assert.equal(palette?.hintKey, 'settings.toolbarEditOrSplit');
	});

	test('every macOS menu accelerator is a chord the registry advertises for the command the item runs', () => {
		const items = menuAccelerators();
		assert.ok(items.length > 30, `${items.length} menu accelerators`);
		const seen = new Set<string>();
		for (const { text, accelerator, action: { action } } of items) {
			assert.ok(!seen.has(accelerator), `${accelerator} is on two menu items`);
			seen.add(accelerator);
			const chord = chordOfAccelerator(accelerator);
			const row = SHORTCUTS.find((entry) => entry.chords.includes(chord));
			assert.ok(row, `${text} claims ${accelerator}, which no registry row advertises`);
			const runs =
				'viewer' in action ? row.documentCommands?.includes(action.viewer)
				: 'editor' in action ? row.id === action.editor
				: 'app' in action ? row.id === action.app
				: false;
			assert.ok(runs, `${text} claims ${accelerator}, but the registry says that chord is ${row.id}`);
		}
	});

	test('a chord the macOS document handler leaves alone is one the menu answers', () => {
		// Quit is the registry's one macOS exemption: the page lets ⌘Q through.
		const claimed = new Set(menuAccelerators().map((item) => chordOfAccelerator(item.accelerator)));
		const exempt = SHORTCUTS.filter((entry) => entry.documentExempt?.includes('macos'));
		assert.ok(exempt.length > 0);
		for (const entry of exempt) assert.ok(claimed.has(entry.chords[0]), `${entry.id} is answered by nothing on macOS`);
	});

	test('the page answers a menu accelerator with the menu item\'s own command, or not at all', () => {
		// WKWebView offers a key equivalent to the page first and the page prevents
		// every chord it answers, so the menu never ALSO runs. What could still go
		// wrong is the page answering the menu's chord with a different command.
		const keymap = documentKeymap('macos');
		let answered = 0;
		for (const { text, accelerator, action: { action } } of menuAccelerators()) {
			const command = keymap.get(toMonacoLabel(chordOfAccelerator(accelerator), true));
			if (command === undefined) continue;
			answered++;
			assert.ok('viewer' in action && action.viewer === command, `${accelerator}: the page runs ${command}, the menu's ${text} something else`);
		}
		assert.ok(answered > 15, `the page answered ${answered} menu accelerators`);
	});

	test('each zoom chord reaches its own zoom operation, not just the zoom code', () => {
		// The contract test above compares each chord against the command its
		// registry row names, so it cannot catch a registry that names the same
		// command twice — three rows all saying `zoom-in` would agree with a
		// dispatcher that answers `zoom-in` to all three, and + and − would be the
		// same key. What is left for this test is that the three are DISTINCT.
		//
		// It used to read the number the chord assigned to a local `zoomLevel`,
		// because the arithmetic lived in the handler. It lives in the store now, so
		// the two halves of the claim are checked where each one is: that zoomIn
		// really raises the level and resetZoom really returns to ZOOM_LEVEL_RANGE's
		// default is asserted against the real store in settingsPersistence.spec.ts,
		// and what is left here — which chord asks for which — is the half only the
		// keymap can answer.
		const expected: Array<[string, ViewerCommand]> = [
			['view-zoom-in', 'zoom-in'],
			['view-zoom-out', 'zoom-out'],
			['view-zoom-reset', 'zoom-reset'],
		];

		for (const platform of PLATFORMS) {
			const keymap = documentKeymap(platform.osType);
			const seen = new Map<ViewerCommand, string>();
			for (const [id, command] of expected) {
				const entry = SHORTCUTS.find((e) => e.id === id)!;
				const answered = keymap.get(toMonacoLabel(entry.chords[0], platform.mac));
				assert.equal(answered, command, `${id} must mean ${command} on ${platform.name}, not ${answered}`);
				assert.equal(seen.get(command), undefined, `${platform.name}: ${id} and ${seen.get(command)} both mean ${command}`);
				seen.set(command, id);
			}
		}
	});

	test('Save As runs Save As, and not a plain Save', () => {
		// The chord the app menu printed for years while nothing bound it. The save
		// branch matched `cmdOrCtrl && key === 's'` with no Shift guard, so the
		// advertised keystroke reached plain Save and silently overwrote the file the
		// user was asking to write elsewhere. This is the assertion that the label is
		// now true rather than merely present.
		for (const platform of PLATFORMS) {
			const keymap = documentKeymap(platform.osType);
			const shiftS = platform.mac ? 'Shift+Meta+S' : 'Ctrl+Shift+S';
			assert.equal(
				keymap.get(shiftS),
				'save-as',
				`${platform.name}: ${shiftS} means ${keymap.get(shiftS) ?? 'nothing'} instead of save-as`,
			);
		}
	});

	test('a close chord wearing an extra modifier destroys nothing', () => {
		// `Mod+W` and `Mod+Q` tested the platform modifier and the key and nothing
		// else, so the whole Shift/Alt cross product reached them. `Shift+Cmd+W`,
		// `Alt+Cmd+W` and `Shift+Cmd+Q` — the last of which is the macOS Log Out
		// gesture — each threw the document away, while the neighbours in the same
		// handler (`file-new`, `file-open`, `app-find`) had spelled every modifier
		// out from the start.
		//
		// Not "these three chords do nothing" but "nothing destructive answers to a
		// modifier it does not name": a fourth spelling nobody thought of fails here
		// too, and so does a future destructive branch that forgets its guard.
		const DESTRUCTIVE: ViewerCommand[] = ['close-file', 'app-exit'];
		let plainClosesFound = 0;

		for (const platform of PLATFORMS) {
			const keymap = documentKeymap(platform.osType);
			for (const [chord, command] of keymap) {
				if (!DESTRUCTIVE.includes(command)) continue;
				if (!/\b(Shift|Alt)\b/.test(chord)) {
					plainClosesFound++;
					continue;
				}
				assert.fail(
					`${platform.name}: ${chord} means ${command} — a chord reached for a window-level or ` +
						'"close all" gesture must not close the document',
				);
			}
		}

		// Without this the test passes just as happily when the handler answers no
		// close chord at all, which is the empty-iteration failure the file guards
		// against everywhere else.
		assert.ok(plainClosesFound >= 3, `only ${plainClosesFound} unmodified close chords fire; the harness found nothing to guard`);
	});

	test('Mod+F4 closes a document on Windows, the one platform it was scoped to', () => {
		// The scope is not a judgement call made here — it is the requirement the
		// binding shipped with and then exceeded. `docs/requirements/157-ctrl-f4-
		// close-tab.md`, added by the same commit that added the branch (4670743,
		// "add Ctrl+F4 shortcut to close active tab on Windows"), lists under "Out of
		// scope": "macOS / Linux (dort ist Ctrl+F4 kein Standard)". The handler bound
		// it on all three anyway. The doc was later swept away with the rest of
		// docs/ (d69c181), which is how the intent stopped being checkable — so it is
		// restated here, where it now fails if it is exceeded again.
		//
		// The convention argument agrees and is why the doc says what it says:
		// Ctrl+F4 closes a document window on Windows, an MDI-era convention still
		// live in Office and the IDEs. macOS has none — Cmd+F4 means nothing, and
		// with "Use F1, F2, etc. as standard function keys" off, which is the
		// default, F4 runs a system function and the app never receives the event.
		//
		// What this is NOT is a rule about odd-looking chords. `Cmd+Shift+=` stays on
		// every platform though it looks similarly strange: it is not a platform
		// convention at all, it is how "Cmd plus" is typed — `+` is the shifted `=`
		// on every layout — so Mac users press it as much as anyone. The question is
		// "does anyone on this platform actually press this?", not "does it carry a
		// Shift?".
		for (const platform of PLATFORMS) {
			const keymap = documentKeymap(platform.osType);
			// Both spellings on every platform: `cmdOrCtrl` is `ctrlKey || metaKey`
			// everywhere, so a Mac or a Linux box answering EITHER one is the defect.
			for (const spelling of documentSpellings('Mod+F4', platform.mac)) {
				const command = keymap.get(spelling);
				if (platform.osType === 'windows') {
					assert.equal(
						command,
						'close-file',
						`${platform.name}: ${spelling} means ${command ?? 'nothing'} instead of close-file`,
					);
				} else {
					assert.equal(
						command,
						undefined,
						`${platform.name}: ${spelling} still means ${command} — requirement 157 puts this platform out of scope`,
					);
				}
			}
		}
	});

	test('the contextual keys are shown as single keystrokes, never as chord sequences', () => {
		// What separates this group from the four menu groups is not the absence of a
		// modifier — Mod+Enter is in it — but that each row is ONE keystroke whose
		// meaning depends on where the caret is. A two-part `Mod+K …` sequence is a
		// command being invoked by name and belongs under the menu it lives in.
		const shown = shortcutSections('macos').find((section) => section.group === 'keys');
		assert.ok(shown, 'the panel renders the keys group');
		assert.deepEqual(
			shown.entries.flatMap((entry) => entry.chords),
			['Enter', 'Tab', 'Shift+Tab', 'Cmd+Enter', 'Cmd+Shift+Enter'],
		);
		for (const chord of shown.entries.flatMap((entry) => entry.chords)) {
			assert.ok(!chord.includes(' '), `${chord} is a chord sequence, not a key`);
		}
	});

	// ------------------------------------------------------------------- i18n

	test('every label the registry names is a key English already defines', () => {
		// The registry deliberately mints no new command names: each label is a key
		// that already existed for a menu or context-menu entry, and is therefore
		// already translated everywhere. This is the assertion that keeps it that
		// way — a new key would have to be added to the dictionary first.
		const labelKeys = [...SHORTCUTS.map((e) => e.labelKey), ...SHORTCUT_GROUPS.map((g) => g.labelKey)];
		assert.ok(labelKeys.length > 30, `checking ${labelKeys.length} label keys`);

		for (const key of labelKeys) {
			assert.notEqual(t(key, 'en'), key, `${key} is defined in English`);
			assert.ok(t(key, 'en').length > 0, `${key} is non-empty in English`);
		}
	});

	/** The value `lang` itself defines for `key`, ignoring the English fallback. */
	function defines(lang: LanguageCode, key: string): boolean {
		let node: string | Translation | undefined = translations[lang];
		for (const part of key.split('.')) {
			if (typeof node !== 'object' || node === null || !(part in node)) return false;
			node = node[part];
		}
		return typeof node === 'string';
	}

	/**
	 * Registry labels that are NOT translated in every locale.
	 *
	 * Reusing existing keys bought full 26-locale coverage for 32 of the 38 labels
	 * the panel needs. It did not buy it for these six — and pretending otherwise
	 * was the first thing this test caught. Every one of them is a key the app menu
	 * ALREADY renders today (Reload from Disk, Find…, Back, Forward, Open File
	 * Location, Window), so the panel inherits an existing gap rather than
	 * creating one, and `t()` falls back to English exactly as the menu does.
	 *
	 * Pinned rather than waived: a new under-translated label fails the test below,
	 * and a key that gets translated has to leave this list.
	 */
	const PARTIALLY_TRANSLATED: Record<string, number> = {
		'menu.reloadFromDisk': 22,
		'menu.openFileLocation': 21,
		'menu.find': 22,
		'menu.back': 21,
		'menu.forward': 21,
		'menu.window': 23,
		// Already rendered by the preview settings pane; the panel inherits its gap.
		'settings.previewMaxWidth': 23,
	};

	test('every panel label is translated everywhere, or is a named pre-existing gap', () => {
		// The stated reason for reusing dictionary keys instead of minting new ones
		// was that the existing ones are already translated. That is a claim about
		// the dictionary, so it is measured here rather than asserted from memory.
		const languages = getSupportedLanguages().map((l) => l.code) as LanguageCode[];
		assert.equal(languages.length, 26);

		const measured = new Map<string, number>();
		for (const key of new Set([...SHORTCUTS.map((e) => e.labelKey), ...SHORTCUT_GROUPS.map((g) => g.labelKey)])) {
			const missing = languages.filter((lang) => !defines(lang, key)).length;
			if (missing > 0) measured.set(key, missing);
		}

		assert.deepEqual(
			Object.fromEntries([...measured].sort()),
			Object.fromEntries(Object.entries(PARTIALLY_TRANSLATED).sort()),
			'a panel label’s translation coverage changed; if a key was newly introduced or ' +
				'newly translated, update PARTIALLY_TRANSLATED — do not let the panel quietly ' +
				'grow labels that 20-odd locales cannot read',
		);
	});

	test('no two rows in one panel section read the same, in any language', () => {
		// Two rows with one label is indistinguishable from a duplicated entry from
		// the user's side — the defect `editorContextMenuI18n.test.ts` calls ED-6.
		const languages = getSupportedLanguages().map((l) => l.code) as LanguageCode[];
		for (const { group } of SHORTCUT_GROUPS) {
			const rows = SHORTCUTS.filter((entry: ShortcutEntry) => entry.group === group);
			for (const lang of languages) {
				const seen = new Map<string, string>();
				for (const row of rows) {
					const text = t(row.labelKey, lang);
					const owner = seen.get(text);
					assert.equal(owner, undefined, `${lang} ${group}: ${owner} and ${row.id} both read "${text}"`);
					seen.set(text, row.id);
				}
			}
		}
	});

	test('the panel renders the platform modifier the user is on', () => {
		const mac = shortcutSections('macos').flatMap((s) => s.entries);
		const win = shortcutSections('windows').flatMap((s) => s.entries);

		assert.equal(mac.find((e) => e.id === 'fmt-bold')?.chords[0], 'Cmd+B');
		assert.equal(win.find((e) => e.id === 'fmt-bold')?.chords[0], 'Ctrl+B');
		// A literal Ctrl is not a Mod: tab cycling is Ctrl+Tab on macOS too.
		assert.equal(mac.find((e) => e.id === 'tab-next')?.chords[0], 'Ctrl+Tab');
		// F5 has no modifier at all.
		assert.equal(mac.find((e) => e.id === 'file-reload')?.chords[0], 'F5');

		assert.equal(shortcutLabel('fmt-quote', 'Cmd'), 'Cmd+Shift+.');
		assert.equal(shortcutLabel('no-such-command', 'Cmd'), undefined);
	});

	/**
	 * What each modifier the registry writes is CALLED on each platform.
	 *
	 * `Mod` was the only one `formatChord` ever substituted, and its docblock said
	 * everything else "is already the literal the key carries". That was false for
	 * `Alt`: Apple keyboards print `⌥ option`, the word "Alt" appears on no modern
	 * Mac keyboard, and so the panel told Mac users to press a key their hardware
	 * does not have — `Alt+Left`/`Alt+Right`, the two navigation rows.
	 *
	 * The two columns are what stops a repeat. A modifier is listed here with BOTH
	 * of its names, so a row added later that reaches for a key macOS names
	 * differently has to say so here, and the test below then requires the panel to
	 * actually render that difference. A modifier absent from this table fails
	 * outright rather than defaulting to "same word everywhere", which is the
	 * assumption that produced the defect.
	 */
	const MODIFIER_NAMES: Record<string, { macos: string; windows: string }> = {
		Mod: { macos: 'Cmd', windows: 'Ctrl' },
		// Ctrl and Shift really are spelled the same on both: a Mac keyboard prints
		// `control` and `shift`. These two rows are the claim the docblock got right.
		Ctrl: { macos: 'Ctrl', windows: 'Ctrl' },
		Shift: { macos: 'Shift', windows: 'Shift' },
		Alt: { macos: 'Opt', windows: 'Alt' },
	};

	/**
	 * The modifiers of a chord: every `+`-separated part except the last, which is
	 * the key. Handles a chord SEQUENCE (`Mod+K T`) the way the rest of this file
	 * does, one chord at a time.
	 */
	function modifiersOf(chord: string): string[] {
		return chord.split(' ').flatMap((single) => single.split('+').slice(0, -1));
	}

	test('every modifier the panel prints is what that platform calls the key', () => {
		// Enumerated from SHORTCUTS rather than hand-listed, so a row added later with
		// a modifier nobody has classified fails here instead of silently rendering
		// its raw registry spelling to a user.
		const used = new Set(SHORTCUTS.flatMap((entry: ShortcutEntry) => entry.chords.flatMap(modifiersOf)));
		assert.ok(used.size > 2, `the registry uses ${used.size} distinct modifiers`);

		assert.deepEqual(
			[...used].filter((token) => !(token in MODIFIER_NAMES)),
			[],
			'nothing says what these keys are called on each platform — add them to MODIFIER_NAMES, ' +
				'with the macOS name spelled the way the key is actually printed on a Mac keyboard',
		);

		for (const entry of SHORTCUTS) {
			for (const chord of entry.chords) {
				const raw = modifiersOf(chord);
				const rendered = {
					macos: modifiersOf(formatChord(chord, modifierFor('macos'))),
					windows: modifiersOf(formatChord(chord, modifierFor('windows'))),
				};
				for (const platform of ['macos', 'windows'] as const) {
					assert.equal(
						rendered[platform].length,
						raw.length,
						`${entry.id}: rendering "${chord}" for ${platform} changed the shape of the chord`,
					);
					raw.forEach((token, i) => {
						assert.equal(
							rendered[platform][i],
							MODIFIER_NAMES[token][platform],
							`${entry.id}: the panel shows "${formatChord(chord, modifierFor(platform))}" on ${platform}, ` +
								`but ${platform} calls that key "${MODIFIER_NAMES[token][platform]}", not "${rendered[platform][i]}"`,
						);
					});
				}
			}
		}
	});

	// ------------------------------------------- reality -> registry (completeness)
	//
	// Every assertion above runs registry -> reality: it takes a row and checks the
	// app really answers that chord. Nothing ran the other way, so a chord the app
	// binds that never made it into the table was invisible to the whole file —
	// `no registry entry is unverifiable` cannot see it, because there is no entry
	// to check. This section is the missing direction, and it found two live gaps
	// the first pass shipped: the preview-width chords, and the native Settings
	// accelerator.
	//
	// The editor layer's half of this is `every keybinding the editor registers is
	// either advertised or consciously not`, above.

	test('every command the document dispatcher can reach is advertised', () => {
		const advertised = new Set(SHORTCUTS.flatMap((entry) => entry.documentCommands ?? []));
		assert.ok(advertised.size > 10, `${advertised.size} commands are named by a registry row`);

		const reachable = new Set<ViewerCommand>();
		for (const platform of PLATFORMS) for (const command of documentKeymap(platform.osType).values()) reachable.add(command);
		// Without this the whole test passes vacuously if the harness stops running.
		assert.ok(reachable.size > 10, `the dispatcher reached ${reachable.size} commands`);

		assert.deepEqual(
			[...reachable].filter((command) => !advertised.has(command)).sort(),
			[],
			'these commands are reachable from the keyboard but the shortcuts panel never mentions them; ' +
				'add a row to SHORTCUTS',
		);

		// And the other direction: a row naming a command no chord answers is a
		// panel entry that does nothing.
		assert.deepEqual(
			[...advertised].filter((command) => !reachable.has(command)).sort(),
			[],
			'the panel advertises these commands but no chord reaches them',
		);
	});

	/**
	 * Every harness label one registry chord is answered by.
	 *
	 * `cmdOrCtrl` in the document handler is `e.ctrlKey || e.metaKey` on EVERY
	 * platform, so a `Mod` chord answers both spellings everywhere — a Windows
	 * user's Ctrl fingers keep working on a Mac and the reverse. That is one
	 * decision about the modifier, not one decision per chord, so it is applied
	 * here rather than repeated as thirty exemptions below.
	 */
	function documentSpellings(chord: string, mac: boolean): Chord[] {
		if (!chord.includes('Mod')) return [toMonacoLabel(chord, mac)];
		return [toMonacoLabel(chord, false), toMonacoLabel(chord, true)];
	}

	/**
	 * Chords the document handler answers that the panel deliberately never shows,
	 * written in registry syntax so this list and the registry read alike.
	 *
	 * The command-level test above cannot see any of this: it asks whether a
	 * command is mentioned somewhere, and `closeFile` is mentioned, so `Mod+W`
	 * accounted for `Shift+Mod+W`, `Alt+Mod+W` and the rest of the cross product
	 * as well. This is the same completeness question asked one level finer — per
	 * CHORD — which is the level the bug lived at.
	 *
	 * What that buys: a branch added tomorrow that forgets to say which modifiers
	 * must be up does not quietly grow four undocumented chords. It fails here,
	 * and the author either advertises what they bound or writes down why not.
	 */
	const DOCUMENT_CHORDS_NOT_ADVERTISED: Record<string, string> = {
		'Mod+F4':
			'The Windows document-close convention, kept there as a second way to reach file-close and gated off ' +
			'macOS and Linux, which requirement 157 put out of scope from the start (see the per-platform test ' +
			'above). Not shown because the panel already prints Mod+W for that command and a second row would read ' +
			'as a second command — and a row true on one platform of three would have to say so.',
		'Mod+PageUp':
			'Tab cycling as browsers and editors bind it. tab-prev advertises Ctrl+Shift+Tab; this is the same ' +
			'command under the chord the muscle memory reaches for.',
		'Mod+PageDown': 'The tab-next half of the same pair as Mod+PageUp.',
		'Meta+Alt+Left':
			'The macOS tab-cycling gesture (Cmd+Alt+arrow), kept for Mac users whose fingers expect it. Advertising ' +
			'it would give tab-prev a platform-specific second row that is wrong on the other two platforms.',
		'Meta+Alt+Right': 'The tab-next half of the same pair as Meta+Alt+Left.',
		'Mod+OEM_102':
			'The extra backslash key on ISO keyboards, the same physical gesture as view-toggle-split\'s Mod+\\. ' +
			"The registry's own note on that row says why it is not shown as a second chord.",
		'Meta+Tab':
			'The Cmd twin of tab-next, which is spelled with a literal Ctrl precisely because Cmd+Tab is the macOS ' +
			'application switcher and never reaches the app. Reachable in the handler, unreachable in practice.',
		'Meta+Shift+Tab': 'The tab-prev half of the same pair as Meta+Tab.',
	};

	test('every chord the document handler answers is advertised, or consciously not', () => {
		for (const platform of PLATFORMS) {
			const advertised = new Set(
				SHORTCUTS.filter((entry) => entry.documentCommands)
					.flatMap((entry) => entry.chords)
					.flatMap((chord) => documentSpellings(chord, platform.mac)),
			);
			for (const chord of Object.keys(DOCUMENT_CHORDS_NOT_ADVERTISED)) {
				for (const spelling of documentSpellings(chord, platform.mac)) advertised.add(spelling);
			}

			const answered = [...documentKeymap(platform.osType).keys()];
			assert.ok(answered.length > 15, `${platform.name}: the handler answered ${answered.length} chords`);

			assert.deepEqual(
				answered.filter((chord) => !advertised.has(chord)).sort(),
				[],
				`${platform.name}: the keyboard reaches these chords and nothing accounts for them. ` +
					'A branch must name every modifier that has to be UP, or the chord it really binds ' +
					'belongs in SHORTCUTS or in DOCUMENT_CHORDS_NOT_ADVERTISED with a reason.',
			);
		}

		// The exemption list must not rot: a chord that stopped firing has to leave it.
		const live = new Set(PLATFORMS.flatMap((platform) => [...documentKeymap(platform.osType).keys()]));
		for (const chord of Object.keys(DOCUMENT_CHORDS_NOT_ADVERTISED)) {
			assert.ok(
				documentSpellings(chord, false).some((spelling) => live.has(spelling)) ||
					documentSpellings(chord, true).some((spelling) => live.has(spelling)),
				`${chord} is no longer answered — drop it from DOCUMENT_CHORDS_NOT_ADVERTISED`,
			);
		}
	});
});

describe('formatting shortcuts keymap', () => {
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

	test('the macOS menu gives Cmd+T and Cmd+N no meaning but New File', () => {
		// The third code path in #392: a menu item on Cmd+T would be a meaning
		// above both layers above, and neither of them could see it.
		const flatten = (nodes: readonly MenuNode[]): MenuNode[] =>
			nodes.flatMap((node) => (node.kind === 'submenu' ? flatten(node.items) : [node]));
		const claims = flatten(buildMenuModel({ language: 'en', viewMode: 'edit', liveMode: true, hasEditorPane: true, showToc: true, showTabs: true, showEditorToolbar: true, previewFullWidth: false })).flatMap(
			(node) =>
				(node.kind === 'item' || node.kind === 'check') && /^CmdOrCtrl\+[TN]$/.test(node.accelerator ?? '')
					? [[node.accelerator, node.action]]
					: [],
		);
		assert.deepEqual(claims, [['CmdOrCtrl+N', { viewer: 'new-file' }]]);
	});
});

describe('macOS app menu', () => {
	// The macOS menu bar as each window builds it. This replaced #281's minimal
	// native menu (App, Edit, Window) when the maintainer chose a full one.

	void translations; // every locale loaded, so `t` answers in each language

	const base: MenuState = {
		language: 'en',
		viewMode: 'preview',
		liveMode: true,
		hasEditorPane: false,
		showToc: true,
		showTabs: true,
		showEditorToolbar: true,
		previewFullWidth: false,
	};

	function flatten(nodes: readonly MenuNode[]): MenuNode[] {
		return nodes.flatMap((node) => (node.kind === 'submenu' ? [node, ...flatten(node.items)] : [node]));
	}

	function find(nodes: readonly MenuNode[], text: string): MenuNode {
		const node = flatten(nodes).find((candidate) => 'text' in candidate && candidate.text === text);
		assert.ok(node, `no menu item reads ${text}`);
		return node;
	}

	test('every label is a translation, in English and in Chinese', () => {
		for (const language of ['en', 'zh-CN', 'zh-TW'] as const) {
			for (const node of flatten(buildMenuModel({ ...base, language }))) {
				if (!('text' in node)) continue;
				// A predefined item without text shows AppKit's English default.
				assert.ok(node.text, `${language}: a ${node.kind} item has no text`);
				assert.doesNotMatch(node.text, /^[a-z]+\.[A-Za-z0-9.]+$/, `${language}: ${node.text} is an untranslated key`);
			}
		}
		const zh = buildMenuModel({ ...base, language: 'zh-CN' });
		assert.deepEqual(
			zh.map((node) => (node as { text: string }).text),
			['Markpad', '文件', '编辑', '视图', '窗口'],
		);
		find(zh, '退出 Markpad');
		find(zh, '切换全屏');
		find(buildMenuModel({ ...base, language: 'zh-TW' }), '切換全螢幕');
	});

	function check(state: MenuState, text: string) {
		const node = find(buildMenuModel(state), text);
		assert.ok(node.kind === 'check', `${text} is not a check item`);
		return node;
	}

	test('Edit Mode is checked while the editor shows, and disabled in split where ⌘E does nothing', () => {
		for (const [viewMode, checked, enabled] of [
			['preview', false, true],
			['edit', true, true],
			['split', true, false],
			[null, false, true],
		] as const) {
			const item = check({ ...base, viewMode }, 'Edit Mode');
			assert.equal(item.checked, checked, `${viewMode}: checked`);
			assert.equal(item.enabled ?? true, enabled, `${viewMode}: enabled`);
			assert.deepEqual(item.action, { viewer: 'toggle-edit-view' });
		}
	});

	test('Split View is checked exactly in split', () => {
		for (const viewMode of ['preview', 'edit', 'split', null] as (ViewMode | null)[]) {
			const item = check({ ...base, viewMode }, 'Split View');
			assert.equal(item.checked, viewMode === 'split');
			assert.deepEqual(item.action, { viewer: 'toggle-split-view' });
		}
	});

	test('each View toggle is a check item that follows its own state', () => {
		const toggles = [
			['Auto-Reload', 'liveMode'],
			['Table of Contents', 'showToc'],
			['Tab Bar', 'showTabs'],
			['Editor Toolbar', 'showEditorToolbar'],
			['Full Width', 'previewFullWidth'],
		] as const;
		for (const [text, key] of toggles) {
			for (const on of [true, false]) assert.equal(check({ ...base, [key]: on }, text).checked, on, `${text} with ${key}=${on}`);
		}
	});

	test('Edit Mode, Split View and Tab Bar carry the registry chords', () => {
		const model = buildMenuModel(base);
		for (const [text, id] of [
			['Edit Mode', 'view-toggle-edit'],
			['Split View', 'view-toggle-split'],
			['Tab Bar', 'toggle-tabs'],
		] as const) {
			const item = find(model, text);
			const chord = SHORTCUTS.find((row) => row.id === id)!.chords[0];
			assert.equal(item.kind === 'check' && item.accelerator, chord.replace(/^Mod\b/, 'CmdOrCtrl'), text);
		}
	});

	test('the View toggles read as state names in Chinese', () => {
		const zh = { ...base, language: 'zh-CN' } as const;
		for (const text of ['编辑模式', '分屏视图', '自动重载', '目录', '标签栏', '编辑器工具栏', '全宽']) check(zh, text);
	});

	test('View has no radio group of modes left', () => {
		const view = buildMenuModel(base)[3];
		assert.ok(view.kind === 'submenu');
		const checks = view.items.flatMap((node) => (node.kind === 'check' ? [node.text] : []));
		assert.deepEqual(checks, ['Edit Mode', 'Split View', 'Auto-Reload', 'Table of Contents', 'Tab Bar', 'Editor Toolbar', 'Full Width']);
		assert.ok(flatten(buildMenuModel(base)).every((node) => !('action' in node) || !('viewMode' in node.action)));
	});

	test('Format acts on the editor, so it is disabled without one', () => {
		for (const hasEditorPane of [false, true]) {
			const formatting = flatten(buildMenuModel({ ...base, hasEditorPane })).filter(
				(node) => node.kind === 'item' && 'editor' in node.action,
			);
			assert.equal(formatting.length, 15);
			assert.ok(formatting.every((node) => node.kind === 'item' && node.enabled === hasEditorPane));
		}
	});

	test('Back, Forward and tab cycling carry no accelerator', () => {
		// ⌥←/→ and ⌘[/] belong to the editor's caret and indent; Ctrl+Tab is
		// answered by the page, not reliably by AppKit.
		const model = buildMenuModel(base);
		for (const text of ['Back', 'Forward', 'Next Tab', 'Previous Tab']) {
			const item = find(model, text);
			assert.equal(item.kind === 'item' && item.accelerator, undefined, `${text} has an accelerator`);
		}
	});

	test('Edit keeps the system text commands that WKWebView fields rely on (#526)', () => {
		const edit = buildMenuModel(base)[2];
		assert.ok(edit.kind === 'submenu');
		const predefined = edit.items.flatMap((node) => (node.kind === 'predefined' ? [node.item] : []));
		assert.deepEqual(predefined, ['Undo', 'Redo', 'Cut', 'Copy', 'Paste', 'SelectAll']);
	});

	test('Quit runs the app exit path, so hot exit still sees it (#962)', () => {
		const quit = find(buildMenuModel(base), 'Quit Markpad');
		assert.ok(quit.kind === 'item');
		assert.deepEqual(quit.action, { viewer: 'app-exit' });
		assert.equal(quit.accelerator, 'CmdOrCtrl+Q');
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
	test('Ctrl/Cmd+O opens the file dialog while reading, on every platform', () => {
		for (const platform of PLATFORMS) {
			const chord = platform.mac ? 'Meta+O' : 'Ctrl+O';
			assert.equal(
				documentKeymap(platform.osType).get(chord),
				'open-file',
				`${platform.name}: ${chord} must open a file from preview mode`,
			);
		}
	});

	test('Shift and Alt do not reach it', () => {
		// The branch tests `!e.shiftKey && !e.altKey`. Without that, chords the app
		// has not defined would silently open a file dialog on top of whatever the
		// user was actually doing.
		for (const chord of ['Ctrl+Shift+O', 'Alt+Ctrl+O']) {
			assert.equal(documentKeymap('windows').get(chord), undefined, chord);
		}
	});
});

describe('tab context menus', () => {
	test('the tab context menus print the modifier the user is on, not a hard-coded Ctrl', () => {
		const emit = () => {};
		const menus = (osType: string) => ({
			tab: tabMenuItems({
				tab: { id: 'tab-1', path: '/notes/a.md' },
				language: 'en',
				osType,
				tabCount: 2,
				fileActionItems: [],
				moveToWindowItems: [],
				emit,
			}),
			strip: tabListMenuItems('en', osType, emit),
		});
		const shown = (items: { label?: string; shortcut?: string }[]) =>
			items.filter((item) => item.shortcut).map((item) => [item.label, item.shortcut]);

		for (const [osType, mod] of [['macos', 'Cmd'], ['windows', 'Ctrl'], ['linux', 'Ctrl']] as const) {
			const { tab, strip } = menus(osType);
			// Every chord comes from shortcutLabel(), so it agrees with the app menu.
			assert.deepEqual(shown(tab), [
				[t('menu.newFile', 'en'), `${mod}+T`],
				[t('menu.undoCloseTab', 'en'), `${mod}+Shift+T`],
				[t('menu.closeFile', 'en'), `${mod}+W`],
			]);
			assert.deepEqual(shown(strip), [
				[t('menu.newFile', 'en'), `${mod}+T`],
				[t('menu.undoCloseTab', 'en'), `${mod}+Shift+T`],
			]);
		}
	});
});
