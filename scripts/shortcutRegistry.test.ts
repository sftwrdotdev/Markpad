import assert from 'node:assert/strict';
import test from 'node:test';

import ts from 'typescript';

import { getEditorToolbarTools } from '../src/lib/utils/editorToolbar.js';
import { isHomePath } from '../src/lib/utils/homeTab.js';
import { getSupportedLanguages, t, translations, type LanguageCode, type Translation } from '../src/lib/utils/i18n.js';
import {
	SHORTCUTS,
	SHORTCUT_GROUPS,
	formatChord,
	modifierFor,
	shortcutLabel,
	shortcutSections,
	type ShortcutEntry,
} from '../src/lib/utils/shortcuts.js';
import { getTabFileActions, hasRealFilePath } from '../src/lib/utils/tabFileActions.js';
import {
	OperatingSystem,
	PLATFORMS,
	bareCommands,
	chordOf,
	documentKeymap,
	editorKeymap,
	registeredActions,
	type Chord,
} from './keymapHarness.js';
import { functionSource, readRustBackend, readSource, readSourceFiles } from './sourceTree.js';

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
	// Two keybindings, one action: the second is the same chord with the modifier
	// still held for the second key. See the modifier-held test further down.
	assert.deepEqual(win.get('insert-table-simple'), ['Ctrl+K T', 'Ctrl+K Ctrl+T']);
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
			entry.editorAction || entry.editorCommand || entry.documentCall || entry.nativeMenuAccelerator,
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

/**
 * A chord as a user reads it: a modifier word, a `+`, and something to press.
 *
 * `Mod+…` is deliberately absent — that is the registry's own spelling and is
 * not a claim about any one platform.
 */
const CHORD_LITERAL = /\b(?:Ctrl|Cmd|Command|Meta|Super)\+(?:(?:Shift|Alt|Option|Ctrl|Cmd)\+)*[A-Za-z0-9\\[\]`,.\-=]/g;

/**
 * Whether the match at `index` is inside a comment.
 *
 * Judged from the text before it ON ITS OWN LINE, never by stripping comments
 * out of the file first: a stripper that mistakes a block-comment opener inside
 * a string literal for a real one swallows everything up to the next closer, and
 * a chord hidden that way is a guard that quietly stopped guarding. This can
 * only ever
 * miss a literal that shares a line with an earlier `//`, which no display code
 * in `src/` is written as.
 */
function inComment(text: string, index: number): boolean {
	return /^\s*\*|\/\/|\/\*|<!--/.test(text.slice(text.lastIndexOf('\n', index) + 1, index));
}

/**
 * Files allowed to spell a chord out.
 *
 * One, and it is the registry: `Ctrl+Tab` and `Ctrl+Shift+Tab` are a literal
 * Ctrl on macOS too (Cmd+Tab is the system application switcher), so the table
 * has to be able to say so. Everything else asks `shortcutLabel()`.
 *
 * NOT exempted, though the shapes are different: a `title=` tooltip is as
 * user-visible as a menu row, and the two that read `(Ctrl+W)` and `(Ctrl+T)`
 * were as wrong on macOS as the menu rows beside them. Comments are excluded by
 * `inComment` rather than listed here — a comment discussing Cmd+S is prose, not
 * a label.
 */
const CHORD_LITERAL_EXEMPT: Record<string, string> = {
	'src/lib/utils/shortcuts.ts':
		'the registry itself: the one file whose job is to spell chords, and the only place a literal Ctrl (Ctrl+Tab) is a deliberate cross-platform claim',
};

test('no chord is spelled by hand anywhere in src, in any shape', () => {
	// The widening of the guard above, which only ever read
	// `<span class="menu-shortcut">` bodies in `TitleBar.svelte`. Six live
	// literals were invisible to it: three `shortcut:` properties in `Tab.svelte`,
	// two in `TabList.svelte`, and two `title=` tooltips — a different shape in a
	// different file, printed into the same span by `ContextMenu.svelte`. This
	// sweep is shape-agnostic on purpose, so the next one does not need a seventh
	// pattern written for it.
	const files = readSourceFiles('src');
	assert.ok(files.length > 50, `swept ${files.length} files`);

	// Not vacuous: the pattern really does find chords in the file that has them.
	const registry = readSource('src/lib/utils/shortcuts.ts');
	assert.ok(
		[...registry.matchAll(CHORD_LITERAL)].some((m) => !inComment(registry, m.index)),
		'the chord pattern matches nothing even in the registry, so this sweep proves nothing',
	);

	const offenders: string[] = [];
	for (const { path, text } of files) {
		if (path in CHORD_LITERAL_EXEMPT) continue;
		for (const match of text.matchAll(CHORD_LITERAL)) {
			if (inComment(text, match.index)) continue;
			offenders.push(`${path}:${text.slice(0, match.index).split('\n').length}: ${match[0]}…`);
		}
	}
	assert.deepEqual(
		offenders,
		[],
		'a keyboard chord is written out by hand here; it belongs in src/lib/utils/shortcuts.ts, ' +
			'read back with shortcutLabel(id, modifierFor(settings.osType)) so macOS reads Cmd',
	);

	for (const path of Object.keys(CHORD_LITERAL_EXEMPT)) {
		assert.ok(files.some((file) => file.path === path), `${path} is gone — drop it from CHORD_LITERAL_EXEMPT`);
	}
});

// ------------------------------------------- the context menus, actually run

/*
 * `ContextMenu.svelte` prints `item.shortcut` into the SAME
 * `<span class="menu-shortcut">` the app menu uses, so a chord handed to it sits
 * in the same visual slot as a chord the app menu derived from the registry —
 * and the tab menus handed it `'Ctrl+T'`, `'Ctrl+Shift+T'` and `'Ctrl+W'` as
 * literals. On macOS that printed "New File · Ctrl+T" one keystroke away from
 * the File menu's "Cmd+T", and Ctrl+T is not bound there at all: `Editor.svelte`
 * binds `monaco.KeyMod.CtrlCmd`, which is ⌘ on a Mac.
 *
 * The guard above could not see it. It reads the `<span>` bodies of
 * `TitleBar.svelte`, and these were `shortcut:` object properties in two other
 * components — a different shape in a different file. Same for the two `title=`
 * tooltips on the `+` button and the tab close button.
 *
 * So the menus are RUN here rather than read: the builder function is lifted out
 * of its component (the same trick `keymapHarness.ts` uses on `handleKeyDown`)
 * and evaluated with a `settings` store that says macOS, then one that says
 * Windows. What comes back is the array `ContextMenu` would render, so the
 * assertion is about the string the user sees rather than about the shape of the
 * source that produced it.
 */

type MenuItem = { label?: string; shortcut?: string; separator?: true };

/** The items `fn` in `file` builds, on `osType`. */
async function contextMenuItems(file: string, fn: string, osType: string): Promise<MenuItem[]> {
	const js = ts.transpileModule(functionSource(readSource(file), fn), {
		compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
	}).outputText;

	let menu: { items?: MenuItem[] } | undefined;
	const known: Record<string, unknown> = {
		// The real store field the component has to consult, and the real
		// translator and registry functions — a stub for any of these would let a
		// component that asked the wrong question still look right.
		settings: { osType, language: 'en' },
		t,
		shortcutLabel,
		modifierFor,
		getTabFileActions,
		hasRealFilePath,
		isHomePath,
		tab: { id: 'tab-1', path: '/notes/a.md', title: 'a.md' },
		tabManager: { tabs: [{ id: 'tab-1' }, { id: 'tab-2' }] },
		getCurrentWindow: () => ({ label: 'main' }),
		emitTo: () => {},
		// The only other window is this one, so the "move to window" section is
		// empty and the shortcut-bearing rows are undisturbed.
		invoke: async () => [],
		console,
	};

	const scope = new Proxy(known, {
		has: () => true,
		get: (target, property) =>
			typeof property === 'string' && property in target ? target[property] : () => undefined,
		set: (target, property, value) => {
			const items = (value as { items?: unknown })?.items;
			if (Array.isArray(items)) menu = value as { items: MenuItem[] };
			target[property as string] = value;
			return true;
		},
	});

	const build = new Function('scope', `with (scope) { ${js}\nreturn ${fn}; }`) as (
		s: unknown,
	) => (e: unknown) => unknown;

	// `handleContainerContextMenu` returns early unless the event landed on the
	// container itself, so target and currentTarget are the same object.
	const el = { classList: { contains: () => false } };
	await build(scope)({ preventDefault() {}, stopPropagation() {}, clientX: 10, clientY: 20, target: el, currentTarget: el });

	assert.ok(menu?.items?.length, `${fn} in ${file} produced no menu at all; the harness is not running the real function`);
	return menu!.items!;
}

/** file -> builder, and the labelled chords it must show on each platform. */
const TAB_MENUS: Array<{ file: string; fn: string; macos: Array<[string, string]> }> = [
	{
		file: 'src/lib/components/Tab.svelte',
		fn: 'handleContextMenu',
		macos: [
			['menu.newFile', 'Cmd+T'],
			['menu.undoCloseTab', 'Cmd+Shift+T'],
			['menu.closeFile', 'Cmd+W'],
		],
	},
	{
		file: 'src/lib/components/TabList.svelte',
		fn: 'handleContainerContextMenu',
		macos: [
			['menu.newFile', 'Cmd+T'],
			['menu.undoCloseTab', 'Cmd+Shift+T'],
		],
	},
];

test('the tab context menus print the modifier the user is on, not a hard-coded Ctrl', async () => {
	for (const { file, fn, macos } of TAB_MENUS) {
		for (const platform of ['macos', 'windows'] as const) {
			const shown = (await contextMenuItems(file, fn, platform))
				.filter((item) => item.shortcut)
				.map((item) => [item.label, item.shortcut]);

			const want = macos.map(([labelKey, chord]) => [
				t(labelKey, 'en'),
				platform === 'macos' ? chord : chord.replaceAll('Cmd', 'Ctrl'),
			]);

			assert.deepEqual(
				shown,
				want,
				`${file}: the ${platform} tab context menu shows ${JSON.stringify(shown)}; ` +
					'every chord in it must come from shortcutLabel() so it agrees with the app menu',
			);
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
	const DESTRUCTIVE = ['closeFile', 'getCurrentWindow'];
	let plainClosesFound = 0;

	for (const platform of PLATFORMS) {
		const keymap = documentKeymap(platform.osType);
		for (const [chord, calls] of keymap) {
			const damage = calls.filter((call) => DESTRUCTIVE.some((command) => call.startsWith(command)));
			if (damage.length === 0) continue;
			if (!/\b(Shift|Alt)\b/.test(chord)) {
				plainClosesFound++;
				continue;
			}
			assert.fail(
				`${platform.name}: ${chord} runs ${damage.join(', ')} — a chord reached for a window-level or ` +
					'"close all" gesture must not close the document',
			);
		}
	}

	// Without this the test passes just as happily when the handler answers no
	// close chord at all, which is the empty-iteration failure the file guards
	// against everywhere else.
	assert.ok(plainClosesFound >= 3, `only ${plainClosesFound} unmodified close chords fire; the harness found nothing to guard`);
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

// ---------------------------------------- the Mod+K chords, with Mod held down

/**
 * `Mod+K <key>` chords that deliberately do NOT also take `Mod+K Mod+<key>`.
 *
 * The exemption is a collision, not a preference: `addAction` registers at
 * weight 1000, above every Monaco default, so taking one of these would not fill
 * an empty slot — it would silently delete a command that works today.
 */
const MODIFIER_HELD_EXEMPT: Record<string, string> = {
	'table-insert-column':
		"Mod+K Mod+C is Monaco's own editor.action.addCommentLine " +
		'(contrib/comment/browser/comment.js), and it is not a dead binding in Markdown: with no ' +
		'line-comment token the command falls back to wrapping the line in <!-- -->. Mod+K C, ' +
		'released, is unclaimed and stays the chord for Insert Column.',
};

test('every Mod+K chord also answers with the modifier still held', () => {
	// HOW PEOPLE ACTUALLY PRESS THESE. "Cmd+K T" reads as one gesture, so the Cmd
	// stays down for the T — and `Cmd+K` then `Cmd+T` matched nothing here, fell
	// through, and reached the app's own new-tab chord: asking for Insert Table
	// opened a tab. VS Code registers both forms of every Mod+K chord it ships for
	// exactly this reason.
	let checked = 0;
	for (const platform of PLATFORMS) {
		const modifier = platform.mac ? 'Meta' : 'Ctrl';
		for (const [id, chords] of editorKeymap(platform.mac, platform.os)) {
			if (id in MODIFIER_HELD_EXEMPT) continue;
			for (const chord of chords) {
				const [first, second] = chord.split(' ');
				if (!second || first !== `${modifier}+K` || second.startsWith(`${modifier}+`)) continue;
				assert.ok(
					chords.includes(`${first} ${modifier}+${second}`),
					`${platform.name}: ${id} answers ${chord}, but not the same chord with ${modifier} ` +
						'still held for the second key — which is how the chord is pressed',
				);
				checked++;
			}
		}
	}
	assert.ok(checked >= 3, `only ${checked} Mod+K chords were checked`);

	// The exemption list must not rot either: an id that stopped binding a Mod+K
	// chord has no collision left to be excused from.
	const bound = editorKeymap(false, OperatingSystem.Windows);
	for (const id of Object.keys(MODIFIER_HELD_EXEMPT)) {
		assert.ok(
			bound.get(id)?.some((chord) => chord.startsWith('Ctrl+K ')),
			`${id} no longer binds a Mod+K chord — drop it from MODIFIER_HELD_EXEMPT`,
		);
	}
});

/**
 * Table verbs that are commands with no key, and the reason each one lost it.
 *
 * Dropping a CHORD is not dropping a command: `addAction` without `keybindings`
 * still puts the verb in the command palette (`Mod+P`, which runs Monaco's
 * `editor.action.quickCommand`), which is where a rarely-used destructive edit
 * belongs.
 */
const TABLE_VERBS_WITHOUT_A_CHORD: Record<string, string> = {
	'table-insert-row':
		'Mod+Enter owns it now — inside a table, "insert a line below" already means "insert a row below"',
	'table-delete-row':
		"Mod+K Shift+R sat one slip from Monaco's own Mod+Shift+K (delete line), and a mis-fired " +
		'destructive table edit is much worse than a mis-fired insert',
	'table-delete-column': 'the same, one key over',
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
	const bound = bareCommands().map((call) => call.handler);

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

test('the panel’s groups are visibly separated, not run together', () => {
	// The five sections stacked with nothing between them, so each heading sat
	// flush against the last row of the group above and read as belonging to it —
	// the whole pane looked like one undifferentiated list.
	//
	// A source-shape assertion, because the subject is CSS and there is no DOM
	// here. What it pins is the part that can silently regress: that consecutive
	// groups get a rule and space at all, and that the rule's colour is a theme
	// token rather than a literal, so it survives the light/dark switch.
	const text = readSource('src/lib/components/Settings.svelte');
	assert.match(
		text,
		/class="settings-group shortcut-group"/,
		'the shortcut sections need a class of their own: `.settings-group` is shared with every other pane',
	);

	const rule = /\.shortcut-group\s*\+\s*\.shortcut-group\s*\{([^}]*)\}/.exec(text);
	assert.ok(rule, 'nothing separates one shortcut group from the next');
	assert.match(
		rule[1],
		/border-top:[^;]*var\(--color-border-[a-z]+\)/,
		'the separator must take its colour from a theme variable, so both themes get it',
	);
	assert.match(rule[1], /padding-top:\s*\d/, 'a rule with no space under it still reads as part of the row above');
	assert.match(rule[1], /margin-top:\s*\d/, 'and no space above it still reads as part of the row above');
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
		'The Windows document-close convention, kept as a second way to reach file-close. Not shown because ' +
		'the panel already prints Mod+W for that command and a second row would read as a second command.',
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
			SHORTCUTS.filter((entry) => entry.documentCall)
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
