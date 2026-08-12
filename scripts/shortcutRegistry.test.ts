import assert from 'node:assert/strict';
import test from 'node:test';

import { getEditorToolbarTools } from '../src/lib/utils/editorToolbar.js';
import { getSupportedLanguages, t, translations, type LanguageCode, type Translation } from '../src/lib/utils/i18n.js';
import {
	SHORTCUTS,
	SHORTCUT_GROUPS,
	formatChord,
	shortcutLabel,
	shortcutSections,
	type ShortcutEntry,
} from '../src/lib/utils/shortcuts.js';
import { OperatingSystem, PLATFORMS, documentKeymap, editorKeymap, type Chord } from './keymapHarness.js';
import { readRustBackend, readSource } from './sourceTree.js';

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
			const meta = mods.has('Mod') && mac;
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
	assert.equal(toMonacoLabel('Alt+Left', false), 'Alt+LeftArrow');

	assert.deepEqual(mac.get('fmt-inline-code'), ['Shift+Meta+E']);
	assert.deepEqual(win.get('insert-table-simple'), ['Ctrl+K T']);
});

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
			entry.editorAction || entry.documentCall || entry.nativeMenuAccelerator,
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

test('every chord the registry advertises runs the command it names, outside the editor', () => {
	let checked = 0;
	for (const platform of PLATFORMS) {
		const keymap = documentKeymap(platform.osType);
		for (const entry of SHORTCUTS) {
			if (!entry.documentCall) continue;
			if (entry.documentExempt?.includes(platform.osType)) continue;
			for (const chord of entry.chords) {
				const want = toMonacoLabel(chord, platform.mac);
				const fired = keymap.get(want);
				assert.ok(
					fired,
					`${platform.name}: the panel would show ${formatChord(chord, platform.mac ? 'Cmd' : 'Ctrl')} for ${entry.id}, but that chord does nothing outside the editor`,
				);
				assert.ok(
					fired.some((call) => call.startsWith(entry.documentCall!)),
					`${platform.name}: ${want} is advertised as ${entry.id} (${entry.documentCall}) but runs ${fired.join(', ')}`,
				);
				checked++;
			}
		}
	}
	assert.ok(checked > 40, `only ${checked} document chords were checked`);
});

test('the native accelerator the registry defers to is the one the Rust menu claims', () => {
	// Quit is the one entry whose chord is answered neither by Monaco nor by the
	// document handler on macOS. Saying so in the registry is only honest if the
	// menu really does claim it.
	const rust = readRustBackend();
	const accelerators = new Set([...rust.matchAll(/\.accelerator\("([^"]+)"\)/g)].map((m) => m[1]));
	assert.ok(accelerators.size > 0, 'the native menu accelerators were found');

	let checked = 0;
	for (const entry of SHORTCUTS) {
		if (!entry.nativeMenuAccelerator) continue;
		assert.ok(
			accelerators.has(entry.nativeMenuAccelerator),
			`${entry.id} defers to the native ${entry.nativeMenuAccelerator}, which the menu does not claim`,
		);
		checked++;
	}
	assert.equal(checked, 2, 'Quit and Settings are the two entries the native menu also claims');
});

test('each zoom chord reaches its own zoom operation, not just the zoom code', () => {
	// All three zoom chords land in the same three lines of `handleKeyDown`, so
	// the contract test above can only prove they reach the zoom code — not that
	// + and − are the right way round. What tells them apart is which store
	// method each one calls.
	//
	// This used to read the number the chord assigned to a local `zoomLevel`,
	// because the arithmetic lived in the handler. It lives in the store now, so
	// the two halves of the claim are checked where each one is: that zoomIn
	// really raises the level and resetZoom really returns to ZOOM_LEVEL_RANGE's
	// default is asserted against the real store in settingsPersistence.test.ts,
	// and what is left here — which chord asks for which — is the half only the
	// keymap can answer.
	const operations: Array<[string, string]> = [
		['view-zoom-in', 'settings.zoomIn'],
		['view-zoom-out', 'settings.zoomOut'],
		['view-zoom-reset', 'settings.resetZoom'],
	];

	for (const platform of PLATFORMS) {
		const keymap = documentKeymap(platform.osType);
		for (const [id, operation] of operations) {
			const entry = SHORTCUTS.find((e) => e.id === id)!;
			const fired = keymap.get(toMonacoLabel(entry.chords[0], platform.mac));
			assert.ok(fired, `${id} answers on ${platform.name}`);
			assert.ok(
				fired.includes(operation),
				`${id} must run ${operation}() on ${platform.name}; recorded ${fired.join(', ')}`,
			);
			// And nothing else: a chord that called two of the three would satisfy
			// its own row above while quietly undoing another one.
			for (const [, other] of operations) {
				if (other === operation) continue;
				assert.ok(!fired.includes(other), `${id} also runs ${other}() on ${platform.name}`);
			}
		}
	}
});

// ------------------------------------------------------ the display layers

test('the editor toolbar declares no chord of its own', () => {
	// NOT "the toolbar hint equals the registry", which is what stood here first:
	// once `editorToolbar.ts` derives its hints from `shortcuts.ts`, both sides of
	// that comparison are the same copy and the assertion cannot fail. Deleting a
	// registry row left it green.
	//
	// The toolbar-vs-reality link is held where it belongs — by
	// `formatShortcutKeymap.test.ts`, which compares the rendered hint against the
	// keybinding `Editor.svelte` really registers — and by the coverage test
	// below, which is what caught the deleted row. What is left for this file is
	// the migration itself: the fourteen hand-written chords are gone and cannot
	// come back unnoticed.
	const source = readSource('src/lib/utils/editorToolbar.ts');
	const literals = [...source.matchAll(/`\$\{modifier\}\+[^`]*`/g)].map((m) => m[0]);
	assert.deepEqual(literals, [], 'a chord literal is back in editorToolbar.ts; it belongs in shortcuts.ts');

	// And the hints still render, so "no literals" was not achieved by dropping
	// the feature.
	const tools = getEditorToolbarTools(null);
	assert.ok(tools.length > 10, `found ${tools.length} toolbar tools`);
	const hinted = tools.filter((tool) => tool.shortcut);
	assert.ok(hinted.length >= 10, `only ${hinted.length} toolbar buttons show a shortcut`);
	assert.equal(getEditorToolbarTools(null).find((t) => t.id === 'fmt-bold')?.shortcut?.('Cmd'), 'Cmd+B');
});

test('the app menu prints no shortcut literal of its own', () => {
	// The fourteen hard-coded `<span class="menu-shortcut">{modifier}+T</span>`
	// literals are what this change exists to delete. This is a structural
	// assertion — it cannot see whether the chord is RIGHT, which is what every
	// test above is for — but it is what stops a fifteenth being added by hand.
	const titleBar = readSource('src/lib/components/TitleBar.svelte');
	const spans = [...titleBar.matchAll(/<span class="menu-shortcut">([\s\S]*?)<\/span>/g)].map((m) => m[1].trim());
	assert.ok(spans.length > 10, `found ${spans.length} menu-shortcut spans`);

	const literals = spans.filter((body) => !body.startsWith('{'));
	assert.deepEqual(literals, [], 'every menu shortcut is an expression, not a hard-coded chord');

	// …and specifically, an expression that goes through the registry. The zoom
	// reset button reuses the class for the word "Reset", which is a label rather
	// than a chord.
	const offRegistry = spans.filter((body) => !body.includes('shortcutLabel(') && !body.includes("t('tooltip.reset'"));
	assert.deepEqual(offRegistry, [], 'every menu chord comes from shortcutLabel()');
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
		const fired = keymap.get(shiftS);
		assert.ok(fired, `${shiftS} does nothing on ${platform.name}`);
		assert.ok(
			fired.some((call) => call.startsWith('saveContentAs')),
			`${platform.name}: ${shiftS} runs ${fired.join(', ')} instead of saveContentAs`,
		);
		assert.ok(
			!fired.some((call) => call === 'saveContent'),
			`${platform.name}: ${shiftS} still falls through to a plain Save`,
		);
	}
});

// -------------------------------------------------- editor bindings vs panel

/**
 * Editor actions that carry a keybinding and are deliberately NOT advertised.
 *
 * Without this list the registry could quietly fall behind: someone binds a new
 * chord, the panel never mentions it, and no test notices. Each exclusion is a
 * decision with a reason, in the shape this repo already uses for
 * `KNOWN_LAYER_DIVERGENCES` and `KNOWN_ORPHANS`.
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
 * Reusing existing keys bought full 26-locale coverage for 31 of the 38 labels
 * the panel needs. It did not buy it for these seven — and pretending otherwise
 * was the first thing this test caught. Every one of them is a key the app menu
 * ALREADY renders today (Reload from Disk, Find…, Back, Forward, Open File
 * Location, Move to, Window), so the panel inherits an existing gap rather than
 * creating one, and `t()` falls back to English exactly as the menu does.
 *
 * Pinned rather than waived: a new under-translated label fails the test below,
 * and a key that gets translated has to leave this list.
 */
const PARTIALLY_TRANSLATED: Record<string, number> = {
	'menu.reloadFromDisk': 22,
	'menu.openFileLocation': 21,
	'menu.find': 22,
	'menu.moveToWindow': 23,
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

/** A recorded call, reduced to the command it names: drop the argument and the assigned value. */
function commandOf(call: string): string {
	return call.split(':')[0].replace(/=.*$/, '=');
}

/**
 * Commands the document handler can reach that are deliberately not advertised.
 *
 * One entry, and it is a second write inside a branch that IS advertised rather
 * than a chord of its own: everything the keyboard can *reach* is in the panel.
 * A new branch has to be listed here with a reason, or shown.
 */
const DOCUMENT_NOT_ADVERTISED: Record<string, string> = {
	'settings.previewFullWidth=':
		'The preview-width chords (view-preview-width) turn full-width off before they narrow or widen ' +
		'the preview, so this write is half of that one shortcut. No chord toggles full width on its own; ' +
		'the title bar button does.',
};

/** Native menu accelerators deliberately not advertised. Also empty today. */
const NATIVE_NOT_ADVERTISED: Record<string, string> = {};

test('every command the document handler can reach is advertised, or consciously not', () => {
	const advertised = SHORTCUTS.map((entry) => entry.documentCall).filter(Boolean) as string[];
	assert.ok(advertised.length > 10, `${advertised.length} rows name a document command`);

	const reachable = new Set<string>();
	for (const platform of PLATFORMS) {
		for (const calls of documentKeymap(platform.osType).values()) for (const call of calls) reachable.add(commandOf(call));
	}
	// Without this the whole test passes vacuously if the harness stops running.
	assert.ok(reachable.size > 10, `the document handler reached ${reachable.size} commands`);

	// Prefix either way: a row may name `getCurrentWindow` for a chord recorded as
	// `getCurrentWindow().close`, or `showSettings=true` for one recorded as
	// `showSettings=`. This direction is a coverage question — is the command
	// mentioned at all — and the exact chord-by-chord contract is asserted above.
	const unexplained = [...reachable].filter(
		(command) =>
			!advertised.some((call) => command.startsWith(call) || call.startsWith(command)) &&
			!(command in DOCUMENT_NOT_ADVERTISED),
	);
	assert.deepEqual(
		unexplained.sort(),
		[],
		'these commands are reachable from the keyboard but the shortcuts panel never mentions them; ' +
			'add a row to SHORTCUTS or a reason to DOCUMENT_NOT_ADVERTISED',
	);

	for (const command of Object.keys(DOCUMENT_NOT_ADVERTISED)) {
		assert.ok(reachable.has(command), `${command} is no longer reachable — drop it from DOCUMENT_NOT_ADVERTISED`);
	}
});

test('every native menu accelerator is advertised, or consciously not', () => {
	// The macOS menu is a third layer above the other two, and #392 was in part a
	// chord it owned that nothing else knew about.
	const rust = readRustBackend();
	const accelerators = [...rust.matchAll(/\.accelerator\("([^"]+)"\)/g)].map((m) => m[1]);
	assert.ok(accelerators.length > 0, 'the native menu accelerators were found');

	const advertised = new Set(SHORTCUTS.map((entry) => entry.nativeMenuAccelerator).filter(Boolean));
	const unexplained = accelerators.filter(
		(accelerator) => !advertised.has(accelerator) && !(accelerator in NATIVE_NOT_ADVERTISED),
	);
	assert.deepEqual(
		unexplained.sort(),
		[],
		'the native menu claims these accelerators and the shortcuts panel never mentions them',
	);
});
