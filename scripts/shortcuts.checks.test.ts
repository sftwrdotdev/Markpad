import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import ts from 'typescript';

import { getEditorToolbarTools } from '../src/lib/utils/editorToolbar.js';
import { isHomePath } from '../src/lib/utils/homeTab.js';
import { t } from '../src/lib/utils/i18n.js';
import { formatChord, modifierFor, shortcutLabel, SHORTCUTS } from '../src/lib/utils/shortcuts.js';
import { getTabFileActions, hasRealFilePath } from '../src/lib/utils/tabFileActions.js';
import type { ViewerCommand } from '../src/lib/utils/viewerKeymap.js';
import { bareCommands, type Chord, chordOf, documentKeymap, editorKeymap, OperatingSystem, PLATFORMS, registeredActions, viewerCommandTable } from './keymapHarness.js';
import { functionSource, readSource, readSourceFiles, sliceBetween } from './sourceTree.js';

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
		const editor = readSource('src/lib/components/Editor.svelte');
		for (const id of ['file-reveal', 'view-toggle-edit', 'view-toggle-live']) {
			const label = new RegExp(`id: "${id}",\\s*label: t\\('([^']+)'`).exec(editor)?.[1];
			assert.equal(label, SHORTCUTS.find((entry) => entry.id === id)?.labelKey, `${id} in the palette`);
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

		// `oncommand` is bound to `runViewerCommand`, the switch the document-level
		// branch reaches too, so both halves run the same `new-file`.
		const probe = registeredActions(false);
		const fileNew = probe.actions.find((action) => action.id === 'file-new');
		assert.ok(fileNew, 'file-new is registered');
		const before = probe.calls.length;
		fileNew.run();
		assert.deepEqual(probe.calls.slice(before), ['oncommand("new-file")'], 'file-new runs the new-file command');

		assert.match(
			readSource('src/lib/MarkdownViewer.svelte'),
			/oncommand=\{runViewerCommand\}/,
			'the editor prop is wired to runViewerCommand',
		);
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

	// Monaco's own default chords are checked in `monacoChordOwnership.spec.ts`.

	// ------------------------------------- a core Monaco binding, left alone

	test('Mod+Shift+K deletes a line, as it does in Monaco', () => {
		// #652 took this key off as a guard against `Mod+K Shift+R` (Delete Row),
		// one slip away. That chord and the whole `Mod+K` namespace are gone, so the
		// guard protected nothing and cost users a key they asked for back (#821).
		// Nothing of ours may claim the chord either; `monacoChordOwnership.spec.ts`
		// holds that side.
		assert.doesNotMatch(
			readSource('src/lib/components/Editor.svelte'),
			/-editor\.action\.deleteLines/,
			'Editor.svelte removes Monaco\'s Delete Line key again',
		);
	});
});

describe('menu and modal guards', () => {
	const titleBar = readSource(new URL('../src/lib/components/TitleBar.svelte', import.meta.url));
	const modal = readSource(new URL('../src/lib/components/Modal.svelte', import.meta.url));

	/** Where `needle` sits inside `scope`, asserted to be present at all. */
	function offsetIn(scope: string, needle: string, what: string): number {
		const at = scope.indexOf(needle);
		assert.notEqual(at, -1, `${what} is gone from the handler`);
		return at;
	}

	test('titlebar menus close before a document context menu opens', () => {
		assert.match(titleBar, /window\.addEventListener\('contextmenu', handleGlobalDismiss\)/);
		assert.match(titleBar, /window\.addEventListener\('blur', handleGlobalDismiss\)/);
	});

	test('modal backdrop consumes context-menu events outside text fields', () => {
		// Scoped to the backdrop's own `oncontextmenu`, so a `preventDefault` that
		// belongs to some other handler in this component cannot satisfy it.
		const backdrop = sliceBetween(modal, 'oncontextmenu={', 'role="presentation"');
		const carveOut = offsetIn(backdrop, "closest('input, textarea')", 'the text-field carve-out');
		const prevent = offsetIn(backdrop, 'e.preventDefault();', 'the native-menu suppression');
		const stop = offsetIn(backdrop, 'e.stopPropagation();', 'the propagation guard');

		// The carve-out returns, so anything that suppresses the native menu has to
		// come after it or the prompt input loses Cut/Copy/Paste.
		assert.ok(prevent > carveOut && stop > carveOut, 'the backdrop suppresses the menu before letting text fields out');
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
	const editorSource = readSource(new URL('../src/lib/components/Editor.svelte', import.meta.url));
	const viewerSource = readSource(new URL('../src/lib/MarkdownViewer.svelte', import.meta.url));

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

		assert.match(editorSource, /id: "file-open",[\s\S]{0,200}?run: \(\) => oncommand\?\.\("open-file"\)/);
		assert.match(viewerSource, /oncommand=\{runViewerCommand\}/);
	});
});
