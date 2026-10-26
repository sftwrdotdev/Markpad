import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import ts from 'typescript';

import { getEditorToolbarTools } from '../src/lib/utils/editorToolbar.js';
import { isHomePath } from '../src/lib/utils/homeTab.js';
import { t } from '../src/lib/utils/i18n.js';
import { modifierFor, shortcutLabel } from '../src/lib/utils/shortcuts.js';
import { getTabFileActions, hasRealFilePath } from '../src/lib/utils/tabFileActions.js';
import { viewerCommandTable } from './keymapHarness.js';
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

	test('no path anywhere still opens a Home tab from a keystroke', () => {
		// The #392 defect in its original spelling: the document branch for Ctrl+T
		// called `tabManager.addHomeTab`. There is no `ViewerCommand` for that any
		// more, so the checkable end is the other one — the component's command table
		// has no route to `addHomeTab`, from any chord. `viewerCommandTable()` reads
		// that table out of the component; see its note in `keymapHarness.ts`.
		const routes = Object.entries(viewerCommandTable()).filter(([, body]) => body.includes('addHomeTab'));
		assert.deepEqual(routes.map(([command]) => command), [], 'a keyboard command still reaches addHomeTab');
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
	const viewer = readSource(new URL('../src/lib/MarkdownViewer.svelte', import.meta.url));
	const titleBar = readSource(new URL('../src/lib/components/TitleBar.svelte', import.meta.url));
	const modal = readSource(new URL('../src/lib/components/Modal.svelte', import.meta.url));

	// Three of the four assertions below used to spell `\n\t\t` and `\n\t\t\t` into
	// the pattern, so they pinned the indentation of the code as much as its order.
	// A single `prettier` run — or wrapping one condition across two lines — turned
	// all three red without changing a thing the user can see. What actually has to
	// hold is which function the statement lives in and what it comes BEFORE, so
	// that is what is asserted now: the scope comes from `functionSource`, and the
	// ordering from offsets within that scope.

	/** The document-level right-click handler, braces included. */
	const contextMenuHandler = functionSource(viewer, 'handleContextMenu');

	/** Where `needle` sits inside `scope`, asserted to be present at all. */
	function offsetIn(scope: string, needle: string, what: string): number {
		const at = scope.indexOf(needle);
		assert.notEqual(at, -1, `${what} is gone from the handler`);
		return at;
	}

	test('document context menus do not open while a modal is active', () => {
		// First statement, not merely present: every branch below it either opens a
		// menu or returns, so a modal guard placed after any of them is not a guard.
		assert.match(contextMenuHandler, /^function handleContextMenu\([^)]*\)\s*\{\s*if \(modalState\.show\)\s*return;/);
	});

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

	test('text fields keep the webview edit menu so paste stays reachable', () => {
		const carveOut = offsetIn(
			contextMenuHandler,
			'closest(\'input, textarea, [contenteditable="true"]\')',
			'the text-field carve-out',
		);
		const prevent = offsetIn(contextMenuHandler, 'e.preventDefault();', 'the native-menu suppression');

		assert.ok(prevent > carveOut, 'preventDefault runs before the text-field carve-out, so paste is unreachable');
	});

	test('a second dialog settles the first instead of orphaning it', async () => {
		// One `modalState`, one `resolve`. A second `askCustom` used to overwrite the
		// first caller's resolver, so that caller awaited forever — when it was the
		// close walk, the window could not be closed again. The component's own
		// functions run here over a stand-in `modalState`; types erased, nothing else.
		const lifted = ['askCustom', 'handleModalConfirm'].map((name) => functionSource(viewer, name)).join('\n');
		const js = ts.transpileModule(
			`const __component = () => {
			let modalState = { show: false, resolve: null };
			${lifted}
			return { askCustom, handleModalConfirm };
		};`,
			{ compilerOptions: { target: ts.ScriptTarget.ES2022 } },
		).outputText;
		const component = new Function(`${js}\nreturn __component();`)() as {
			askCustom: (message: string, options: { title: string; kind: 'warning' }) => Promise<string>;
			handleModalConfirm: () => void;
		};

		const first = component.askCustom('first', { title: 'Unsaved', kind: 'warning' });
		const second = component.askCustom('second', { title: 'Unsaved', kind: 'warning' });
		component.handleModalConfirm();

		assert.equal(await Promise.race([first, Promise.resolve('never settled')]), 'cancel');
		assert.equal(await second, 'discard');
	});
});

describe('open shortcut in preview', () => {
	const viewerSource = readSource(new URL('../src/lib/MarkdownViewer.svelte', import.meta.url));

	test('the viewer wires the editor\'s oncommand to runViewerCommand', () => {
		// The other half of "the editor claims Mod+O / Mod+T too, and both layers do
		// the same thing" (shortcuts.editor.test.ts): the editor's actions hand their
		// command to `oncommand`, and the viewer must pass the same `runViewerCommand`
		// the document keyboard calls. A component prop: not observable without
		// mounting MarkdownViewer.
		assert.match(viewerSource, /oncommand=\{runViewerCommand\}/);
	});
});
