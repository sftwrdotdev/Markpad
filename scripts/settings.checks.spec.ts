import assert from 'node:assert/strict';

import { parse } from 'svelte/compiler';
import { describe, test } from 'vitest';

import { callbackBodies, readSource, sliceBetween } from './sourceTree.js';

// Plain TypeScript, no runes: safe to import statically, unlike the store below.
describe('settings persistence', async () => {
	/*
	 * `settings.svelte.ts` is a runes module, and this file runs under vitest so
	 * that it is compiled by the Svelte plugin: `$state` is a real proxy, `$effect`
	 * really tracks what it reads, and `flushSync()` really runs the pending ones.
	 *
	 * That matters here more than anywhere else in the suite. The property this
	 * file exists to guard — "changing one setting rewrites one localStorage key" —
	 * IS Svelte's dependency tracking. Under a hand-written `$effect` shim that
	 * only records its callback, the assertions could describe the intended shape
	 * but never exercise the mechanism that delivers it.
	 *
	 * jsdom supplies `window`, `localStorage` and `navigator` for real; only the
	 * Tauri backend is stubbed.
	 */
	(window as any).__TAURI_INTERNALS__ = { invoke: async () => 'macos' };

	function setNavigatorLanguage(language: string) {
		Object.defineProperty(globalThis, 'navigator', { value: { language }, configurable: true });
	}

	setNavigatorLanguage('en-US');

	const settingsModule = await import('../src/lib/stores/settings.svelte.js');
	const {
		CODE_FONT_SIZE_RANGE,
		DEFAULT_PRE_ZEN_STATE,
		EDITOR_FONT_SIZE_RANGE,
		EDITOR_MAX_WIDTH_RANGE,
		PREVIEW_FONT_SIZE_RANGE,
		SettingsStore,
		SIDEBAR_SPLIT_RANGE,
		TAB_COLUMN_WIDTH_RANGE,
		ZOOM_LEVEL_RANGE,
		clampToRange,
		createSettingsPersistence,
		detectSystemLanguage,
		isSupportedLanguage,
		isThemeSetting,
		isWithinRange,
		normalizePreZenState,
		parseStoredNumber,
		resolveLanguageTag,
		resolveTheme,
		stepWithinRange,
		wheelZoomFactor,
		writeStoredSetting,
	} = settingsModule;

	// Cwd-relative, not `import.meta.url`: see the note on `readSource`.
	const componentSource = readSource('src/lib/components/Settings.svelte');

	test('the settings UI renders its bounds from the shared range constants', () => {
		for (const range of ['EDITOR_FONT_SIZE_RANGE', 'PREVIEW_FONT_SIZE_RANGE', 'CODE_FONT_SIZE_RANGE', 'EDITOR_MAX_WIDTH_RANGE']) {
			assert.match(componentSource, new RegExp(`min=\\{${range}\\.min\\}`), `${range} min not wired to the UI`);
			assert.match(componentSource, new RegExp(`max=\\{${range}\\.max\\}`), `${range} max not wired to the UI`);
		}
		assert.doesNotMatch(componentSource, /max="48"/, 'hard-coded UI bound left behind');
	});

	test('numeric setting inputs are one-way bound and commit through the clamp', () => {
		const numericInputIds = ['editor-font-size', 'editor-max-width', 'preview-font-size', 'code-font-size'];
		for (const id of numericInputIds) {
			const input = sliceBetween(componentSource, `id="${id}"`, '/>');
			assert.doesNotMatch(input, /bind:value/, `${id} still uses a two-way number binding`);
			assert.match(input, /oninput=\{\(e\) => handleNumberInput\(/, `${id} does not validate input`);
			assert.match(input, /onchange=\{\(e\) => commitNumberInput\(/, `${id} does not clamp on change`);
			assert.match(input, /onblur=\{\(e\) => commitNumberInput\(/, `${id} does not clamp on blur`);
			assert.match(input, /onkeydown=\{\(e\) => handleNumberKeydown\(/, `${id} does not clamp on Enter`);
		}
		assert.match(componentSource, /function commitNumberInput[\s\S]{0,400}input\.value = String\(next\)/);
	});

	test('the persisted theme key is the one app.html paints from', () => {
		// The first-paint script in src/app.html reads `theme` before the bundle
		// loads and picks the background from it; renaming the key (to
		// `editor.theme`, say, matching its neighbours) brings back the white flash
		// that script exists to prevent, and nothing else in the app would notice.
		const keys = createSettingsPersistence().map((entry) => entry.key);
		assert.ok(keys.includes('theme'), 'the theme is persisted');
		const appHtml = readSource('src/app.html');
		assert.match(appHtml, /localStorage\.getItem\('theme'\)/);
	});

	test('the startup background command and its vocabulary match app.rs', () => {
		// What the frontend sends runs in settings.themeEffect.spec.ts ("the startup
		// background is told the appearance, not the theme name"). What stays here
		// is the contract: the command name, and the two words, are literals in
		// two languages with no compiler between them.
		const viewerSource = readSource('src/lib/MarkdownViewer.svelte');
		assert.match(viewerSource, /invoke\('save_theme', \{ theme: appearance \}\)/);
		assert.equal(
			(viewerSource.match(/invoke\('save_theme'/g) ?? []).length,
			1,
			'save_theme has one caller, so nothing can send it a raw theme name',
		);
		// The viewer keeps no theme of its own beside the store's.
		assert.doesNotMatch(viewerSource, /let theme = \$state/);

		const appRs = readSource('src-tauri/src/app.rs');
		assert.match(appRs, /"dark" => Some\(tauri::window::Color/);
		assert.match(appRs, /"light" => Some\(tauri::window::Color/);
	});

	/*
	 * ---------------------------------------------------------------------------
	 * Task 5 — the settings dialog restores focus to whatever opened it.
	 * ---------------------------------------------------------------------------
	 */

	test('the open effect neither reads the app version nor re-enters itself', () => {
		// The open effect is identified by what it reads, not by its indentation and
		// closing brace: the previous anchors were `'$effect(() => {\n\t\tif (show) {'`
		// and `'\n\t});'`, so reformatting the component silently moved this
		// assertion onto a different span of source.
		const openEffects = callbackBodies(componentSource, '$effect').filter((body) => /\bshow\b/.test(body));
		assert.equal(openEffects.length, 1, `expected exactly one $effect gated on show (got ${openEffects.length})`);
		const effectBody = openEffects[0];

		// Reading a state it also writes is what made the effect re-run and
		// re-capture the focus target from inside the dialog.
		assert.doesNotMatch(effectBody, /appVersion/, 'open effect still depends on appVersion');
		assert.match(componentSource, /function ensureAppVersion\(\)/);
		assert.match(componentSource, /let versionRequested = false;/);

		// `loaded` and `previousActiveElement` are read and written by this effect,
		// so they must not be reactive.
		assert.match(componentSource, /\n\tlet loaded = false;/);
		assert.match(componentSource, /\n\tlet previousActiveElement: HTMLElement \| null = null;/);
	});

	/*
	 * ---------------------------------------------------------------------------
	 * Structural guards on the store itself.
	 * ---------------------------------------------------------------------------
	 */

	// `the store listens for cross-window storage events` stood here, matching
	// `addEventListener('storage', onStorage)` and its `removeEventListener` in the
	// source text. Both halves are already run rather than read, in this same file:
	// neutering the `addEventListener` reddens eight tests, and replacing the
	// effect's disposer with `() => {}` reddens `a disposed store stops writing and
	// stops listening`. The text match added a way to fail that a rename of the
	// private `onStorage` handler would trigger on its own.

	/*
	 * ---------------------------------------------------------------------------
	 * Structural guards on the settings rows themselves.
	 * ---------------------------------------------------------------------------
	 *
	 * `.setting-item` is a two-column flex row: a leading <label> that occupies
	 * `--settings-label-column`, then the controls. Each control class carries its
	 * own sizing rule — `.select-wrapper` is 220px wide, `.slider-container` is
	 * `flex: 0 0 auto`, and so on — and every one of those rules assumes the
	 * element it names is a DIRECT child of the row, i.e. a flex item of it.
	 *
	 * The Appearance pane's theme row broke that assumption and nothing noticed.
	 * It wrapped its `.select-wrapper` in an unclassed `<div>` (to stack a
	 * "delete selected theme" link under the dropdown) and made that div a COLUMN
	 * flex container. Two consequences, both invisible to the compiler, to
	 * `npm run check`, and to every other test here:
	 *
	 *   * the flex item of the row was the unclassed div, which no rule sizes, so
	 *     nothing gave it the control column's width;
	 *   * `.select-wrapper`'s `flex: 0 1 220px` was read down the COLUMN axis, so
	 *     220px became a HEIGHT. The dropdown rendered 79px too narrow and sat
	 *     191px below its own label, in a row 272px tall next to 50px siblings.
	 *
	 * So the row shape is pinned here. A control wrapped one level deeper, or a
	 * flex item with no rule to size it, fails before it can reach a screenshot.
	 * Composite rows that are not label-and-control rows say so with
	 * `.setting-block`, which owns the border and the rhythm and nothing else.
	 */

	const settingsStyle = componentSource.slice(
		componentSource.lastIndexOf('<style>'),
		componentSource.lastIndexOf('</style>'),
	);

	/** Every class the component's own stylesheet writes a rule for. */
	const styledClasses = new Set(
		[...settingsStyle.matchAll(/\.(-?[_a-zA-Z][\w-]*)/g)].map((match) => match[1]),
	);

	/**
	 * The control classes `.setting-item`'s row layout sizes. Each is sized on the
	 * assumption that it is a flex item of the row, so each must be a direct child
	 * of one.
	 */
	const ROW_SIZED_CONTROLS = ['select-wrapper', 'slider-container', 'toggle', 'custom-dropdown-wrapper'];

	type Row = { children: { tag: string; classes: string[] }[]; nested: string[]; label: string };

	/** Every `.setting-item` in Settings.svelte, with its direct children. */
	function settingRows(): Row[] {
		const ast = parseComponent(componentSource, 'src/lib/components/Settings.svelte');
		const rows: Row[] = [];

		const classesOf = (node: Record<string, any>): string[] => {
			const out: string[] = [];
			for (const attribute of node.attributes ?? []) {
				if (attribute.type === 'ClassDirective') out.push(attribute.name);
				if (attribute.type !== 'Attribute' || attribute.name !== 'class') continue;
				const parts = Array.isArray(attribute.value) ? attribute.value : [attribute.value];
				for (const part of parts) if (part.type === 'Text') out.push(...String(part.data).split(/\s+/).filter(Boolean));
			}
			return out;
		};

		/** Elements below `node`, skipping `{#if}`/`{#each}` wrappers, to `depth`. */
		const elementsUnder = (node: unknown, depth: number, out: { node: Record<string, any>; depth: number }[] = []) => {
			if (Array.isArray(node)) {
				for (const child of node) elementsUnder(child, depth, out);
				return out;
			}
			if (!node || typeof node !== 'object') return out;
			const current = node as Record<string, any>;
			if (current.type === 'RegularElement') {
				out.push({ node: current, depth });
				elementsUnder(current.fragment, depth + 1, out);
				return out;
			}
			// Control-flow blocks do not add a DOM level.
			for (const key of ['fragment', 'nodes', 'consequent', 'alternate', 'body']) {
				if (current[key]) elementsUnder(current[key], depth, out);
			}
			return out;
		};

		const walk = (node: unknown): void => {
			if (Array.isArray(node)) {
				for (const child of node) walk(child);
				return;
			}
			if (!node || typeof node !== 'object') return;
			const current = node as Record<string, any>;

			if (current.type === 'RegularElement' && classesOf(current).includes('setting-item')) {
				const descendants = elementsUnder(current.fragment, 1);
				const direct = descendants.filter((entry) => entry.depth === 1);
				rows.push({
					label: direct[0] ? textOf(direct[0].node) : '(empty row)',
					children: direct.map((entry) => ({ tag: entry.node.name, classes: classesOf(entry.node) })),
					nested: descendants
						.filter(
							(entry) =>
								entry.depth > 1 &&
								classesOf(entry.node).some((name) => ROW_SIZED_CONTROLS.includes(name)) &&
								// `.number-input-wrapper` legitimately lives inside
								// `.slider-container`, which is itself a direct child.
								!parentIsSizedControl(descendants, entry),
						)
						.map((entry) => `${entry.node.name}.${classesOf(entry.node).join('.')}`),
				});
			}

			for (const [key, value] of Object.entries(current)) {
				if (key === 'parent' || key === 'metadata') continue;
				walk(value);
			}
		};

		walk((ast as Record<string, any>).fragment);
		return rows;
	}

	function parseComponent(text: string, filename: string): unknown {
		return parse(text, { modern: true, filename });
	}

	function textOf(node: Record<string, any>): string {
		const first = (node.fragment?.nodes ?? []).find((child: any) => child.type === 'ExpressionTag' || child.type === 'Text');
		if (!first) return node.name;
		return componentSource.slice(first.start, first.end).trim().slice(0, 48);
	}

	/** True when `entry`'s nearest element ancestor is itself a sized control. */
	function parentIsSizedControl(
		all: { node: Record<string, any>; depth: number }[],
		entry: { node: Record<string, any>; depth: number },
	): boolean {
		const index = all.indexOf(entry);
		for (let i = index - 1; i >= 0; i--) {
			if (all[i].depth !== entry.depth - 1) continue;
			const classes = (all[i].node.attributes ?? [])
				.filter((a: any) => a.type === 'Attribute' && a.name === 'class' && Array.isArray(a.value))
				.flatMap((a: any) => a.value.filter((v: any) => v.type === 'Text').flatMap((v: any) => String(v.data).split(/\s+/)));
			return classes.some((name: string) => ROW_SIZED_CONTROLS.includes(name));
		}
		return false;
	}

	const rows = settingRows();

	test('every settings row was found', () => {
		// Vacuous-pass guard: the two assertions below say nothing if the walk
		// stopped finding rows.
		assert.ok(rows.length > 25, `found ${rows.length} .setting-item rows`);
		assert.ok(styledClasses.has('setting-item') && styledClasses.has('select-wrapper'));
	});

	test('a settings row leads with the label that names its control', () => {
		const wrong = rows
			.filter((row) => row.children[0]?.tag !== 'label')
			.map((row) => `${row.label} leads with <${row.children[0]?.tag}>`);
		assert.deepEqual(wrong, [], 'a row whose first child is not the <label> loses the label column');
	});

	test('every control in a settings row is a flex item the stylesheet sizes', () => {
		// The unclassed <div> that broke the theme row would appear here.
		const unstyled = rows.flatMap((row) =>
			row.children
				.slice(1)
				.filter((child) => !child.classes.some((name) => styledClasses.has(name)))
				.map((child) => `${row.label}: <${child.tag}${child.classes.length ? ` class="${child.classes.join(' ')}"` : ''}> has no rule`),
		);
		assert.deepEqual(unstyled, [], 'a direct child of .setting-item that no rule sizes gets no column');
	});

	test('no settings row buries a sized control below its own flex level', () => {
		// `.select-wrapper` one level deeper is the theme-row defect: its sizing
		// stops meaning "width" as soon as some other element becomes the flex item.
		const buried = rows.flatMap((row) => row.nested.map((found) => `${row.label}: ${found}`));
		assert.deepEqual(buried, [], 'a sized control must be a direct child of its .setting-item');
	});
});
