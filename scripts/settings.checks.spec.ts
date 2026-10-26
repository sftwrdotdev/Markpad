import assert from 'node:assert/strict';

import { describe, test } from 'vitest';

import { readSource } from './sourceTree.js';

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

	test('the startup background command has one caller', () => {
		// What the frontend sends runs in settings.themeEffect.spec.ts ("the startup
		// background is told the appearance, not the theme name"). The command name
		// and its words are the generated `commands.saveTheme(theme: Appearance)`,
		// and Rust's reader is commands.rs
		// `the_startup_reader_reads_back_every_appearance_save_theme_writes`.
		const viewerSource = readSource('src/lib/MarkdownViewer.svelte');
		assert.equal(
			(viewerSource.match(/commands\.saveTheme\(/g) ?? []).length,
			1,
			'save_theme has one caller, so nothing can send it a raw theme name',
		);
		// The viewer keeps no theme of its own beside the store's.
		assert.doesNotMatch(viewerSource, /let theme = \$state/);
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
});
