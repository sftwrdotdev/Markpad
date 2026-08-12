import assert from 'node:assert/strict';

import { flushSync } from 'svelte';
import { parse } from 'svelte/compiler';
import { test } from 'vitest';

import { callbackBodies, readSource, sliceBetween } from './sourceTree.js';
// Plain TypeScript, no runes: safe to import statically, unlike the store below.
import { getSupportedLanguages, translations } from '../src/lib/utils/i18n.js';

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

/** jsdom does not fire `storage` for writes made by this same document. */
function dispatchStorage(key: string | null, newValue: string | null) {
	window.dispatchEvent(new StorageEvent('storage', { key, newValue, storageArea: localStorage }));
}

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
	writeStoredSetting,
} = settingsModule;

type PersistedEntry = ReturnType<typeof createSettingsPersistence>[number];

// Cwd-relative, not `import.meta.url`: see the note on `readSource`.
const storeSource = readSource('src/lib/stores/settings.svelte.ts');
const componentSource = readSource('src/lib/components/Settings.svelte');

function resetStorage(seed: Record<string, string> = {}) {
	localStorage.clear();
	for (const [key, value] of Object.entries(seed)) localStorage.setItem(key, value);
}

/**
 * A stand-in store whose property reads are recorded. Values are plausible so
 * that the entries' normalizers behave, but only the *set of property names*
 * touched matters.
 */
function createRecordingStore(): { proxy: InstanceType<typeof SettingsStore>; reads: Set<string> } {
	const reads = new Set<string>();
	resetStorage();
	const real = new SettingsStore();
	const proxy = new Proxy(real, {
		get(target, property) {
			if (typeof property === 'string') reads.add(property);
			// `target`, not the receiver: the compiler turns `x = $state(…)` into a
			// getter over a `#x` private field, and a getter invoked with the proxy
			// as `this` throws — private fields are keyed on the real instance.
			return Reflect.get(target, property);
		},
	});
	return { proxy, reads };
}

/*
 * ---------------------------------------------------------------------------
 * Task 1 — one localStorage entry per store field.
 * ---------------------------------------------------------------------------
 */

test('each persisted entry reads exactly one store field', () => {
	const entries = createSettingsPersistence();
	const { proxy, reads } = createRecordingStore();

	for (const entry of entries) {
		reads.clear();
		entry.read(proxy);
		assert.equal(
			reads.size,
			1,
			`entry "${entry.key}" reads ${reads.size} fields (${[...reads].join(', ')}); it must read exactly one`,
		);
	}
});

test('no store field is read by two persisted entries', () => {
	// Svelte's dependency tracking *is* "which properties did this effect read".
	// With one effect per entry, a field read by two entries would mean changing
	// it rewrites two keys — the multi-window clobbering bug in miniature. This
	// asserts the dependency graph is a bijection, not an approximation of one.
	const entries = createSettingsPersistence();
	const { proxy, reads } = createRecordingStore();
	const owner = new Map<string, string>();

	for (const entry of entries) {
		reads.clear();
		entry.read(proxy);
		for (const field of reads) {
			const previous = owner.get(field);
			assert.equal(
				previous,
				undefined,
				`field "${field}" is read by both "${previous}" and "${entry.key}"`,
			);
			owner.set(field, entry.key);
		}
	}

	assert.equal(owner.size, entries.length);
});

test('persisted keys are unique and cover the documented settings surface', () => {
	const entries = createSettingsPersistence();
	const keys = entries.map((entry) => entry.key);
	assert.equal(new Set(keys).size, keys.length, 'duplicate localStorage key');
	for (const key of ['editor.fontSize', 'editor.language', 'preview.maxWidth', 'editor.preZenState']) {
		assert.ok(keys.includes(key), `missing persisted key ${key}`);
	}
});

/** Every key currently in localStorage, with its value. */
function storageSnapshot(): Map<string, string> {
	const out = new Map<string, string>();
	for (let i = 0; i < localStorage.length; i++) {
		const key = localStorage.key(i)!;
		out.set(key, localStorage.getItem(key)!);
	}
	return out;
}

test('changing one setting rewrites only that setting key', () => {
	// The regression this guards: a single effect that read every field, so any
	// one change rewrote all ~30 keys from a stale snapshot.
	//
	// This runs the real effects. `new SettingsStore()` installs them inside an
	// `$effect.root`, `flushSync()` runs the pending ones, and what lands in
	// localStorage afterwards is decided by Svelte's dependency tracking — not
	// by this file's idea of it. Under the hand-written `$effect` shim this
	// suite used to install, the assertion below could not fail: nothing re-ran.
	resetStorage();
	const store = new SettingsStore();
	flushSync(); // seeds every key from the store's current values

	const written = (change: () => void) => {
		const before = storageSnapshot();
		change();
		flushSync();
		return [...storageSnapshot()]
			.filter(([key, value]) => before.get(key) !== value)
			.map(([key]) => key)
			.sort();
	};

	assert.deepEqual(written(() => (store.minimap = !store.minimap)), ['editor.minimap']);
	assert.deepEqual(
		written(() => {
			store.editorFontSize = 30;
			store.language = 'ja';
		}),
		['editor.fontSize', 'editor.language'],
	);
	// A write with no state change is not a write at all.
	assert.deepEqual(written(() => {}), []);
});

test('the store installs a storage listener that survives on the real window', () => {
	// The other half of the multi-window fix, through jsdom's real event
	// dispatch: `addEventListener('storage', …)` runs inside an `$effect`, so it
	// is only wired up once the effects flush.
	resetStorage();
	const store = new SettingsStore();
	flushSync();

	localStorage.setItem('editor.fontSize', '30');
	dispatchStorage('editor.fontSize', '30');
	assert.equal(store.editorFontSize, 30);
});

test('a second window no longer clobbers what the first window just changed', () => {
	// Window A and window B are separate webviews with separate store instances
	// over one shared localStorage.
	const entries = createSettingsPersistence();
	resetStorage();

	const windowA = new SettingsStore();
	const windowB = new SettingsStore(); // holds its own construction-time snapshot

	// A changes font size and language and persists just those two keys.
	windowA.editorFontSize = 30;
	windowA.language = 'ja';
	for (const entry of entries) writeStoredSetting(entry.key, entry.read(windowA));

	// B, still unaware, flips an unrelated toggle and persists only its own key.
	windowB.minimap = !windowB.minimap;
	const minimapEntry = entries.find((entry) => entry.key === 'editor.minimap') as PersistedEntry;
	writeStoredSetting(minimapEntry.key, minimapEntry.read(windowB));

	assert.equal(localStorage.getItem('editor.fontSize'), '30');
	assert.equal(localStorage.getItem('editor.language'), 'ja');

	// And a fresh window (a restart) sees A's changes intact.
	const restarted = new SettingsStore();
	assert.equal(restarted.editorFontSize, 30);
	assert.equal(restarted.language, 'ja');
});

test('storage events fold another window changes into this instance', () => {
	resetStorage();
	const store = new SettingsStore();
	flushSync();

	// Another window wrote the value; localStorage already reflects it when the
	// event is delivered here.
	localStorage.setItem('editor.fontSize', '30');
	dispatchStorage('editor.fontSize', '30');
	assert.equal(store.editorFontSize, 30);

	localStorage.setItem('editor.language', 'ja');
	dispatchStorage('editor.language', 'ja');
	assert.equal(store.language, 'ja');
});

test('a value that arrived from localStorage is not written back', () => {
	// The anti-echo property. No flag is involved: the write-back is dropped
	// because compare-and-set finds the value already stored.
	const entries = createSettingsPersistence();
	resetStorage();
	const store = new SettingsStore();
	flushSync();
	const entry = entries.find((item) => item.key === 'editor.fontSize') as PersistedEntry;

	localStorage.setItem('editor.fontSize', '30');
	dispatchStorage('editor.fontSize', '30');

	// This is the follow-up effect run that a naive implementation would use to
	// echo the value straight back to the other window.
	assert.equal(writeStoredSetting(entry.key, entry.read(store)), false);
});

test('writeStoredSetting is compare-and-set and removes on null', () => {
	resetStorage();
	assert.equal(writeStoredSetting('demo.key', 'a'), true);
	assert.equal(writeStoredSetting('demo.key', 'a'), false);
	assert.equal(writeStoredSetting('demo.key', 'b'), true);
	assert.equal(writeStoredSetting('demo.key', null), true);
	assert.equal(localStorage.getItem('demo.key'), null);
	assert.equal(writeStoredSetting('demo.key', null), false);
});

test('a cleared localStorage is re-read rather than half-applied', () => {
	resetStorage({ 'editor.fontSize': '30' });
	const store = new SettingsStore();
	flushSync();
	assert.equal(store.editorFontSize, 30);

	localStorage.clear();
	dispatchStorage(null, null);
	assert.equal(store.editorFontSize, EDITOR_FONT_SIZE_RANGE.default);
});

/*
 * ---------------------------------------------------------------------------
 * Task 2 — UI bounds and persisted bounds are the same constants.
 * ---------------------------------------------------------------------------
 */

test('font size ranges reach the maximum the UI already offers', () => {
	assert.equal(EDITOR_FONT_SIZE_RANGE.max, 48);
	assert.equal(PREVIEW_FONT_SIZE_RANGE.max, 48);
	assert.equal(CODE_FONT_SIZE_RANGE.max, 48);
	assert.equal(EDITOR_FONT_SIZE_RANGE.min, 10);
	assert.equal(PREVIEW_FONT_SIZE_RANGE.min, 12);
	assert.equal(CODE_FONT_SIZE_RANGE.min, 10);
	assert.deepEqual(
		{ min: EDITOR_MAX_WIDTH_RANGE.min, max: EDITOR_MAX_WIDTH_RANGE.max, default: EDITOR_MAX_WIDTH_RANGE.default },
		{ min: 20, max: 500, default: 80 },
	);
});

test('a size the UI allows survives a restart', () => {
	// Regression: 30 used to be clamped back to 24 (editor/code) or 28 (preview)
	// on load, so the value silently shrank on the next launch.
	resetStorage({
		'editor.fontSize': '30',
		'preview.fontSize': '40',
		'preview.codeFontSize': '48',
		'editor.maxWidth': '500',
	});
	const store = new SettingsStore();
	assert.equal(store.editorFontSize, 30);
	assert.equal(store.previewFontSize, 40);
	assert.equal(store.codeFontSize, 48);
	assert.equal(store.editorMaxWidth, 500);
});

test('values outside the shared range are still clamped on load', () => {
	resetStorage({ 'editor.fontSize': '900', 'preview.fontSize': '2', 'editor.maxWidth': '5000' });
	const store = new SettingsStore();
	assert.equal(store.editorFontSize, EDITOR_FONT_SIZE_RANGE.max);
	assert.equal(store.previewFontSize, PREVIEW_FONT_SIZE_RANGE.min);
	assert.equal(store.editorMaxWidth, EDITOR_MAX_WIDTH_RANGE.max);
});

test('the settings UI renders its bounds from the shared range constants', () => {
	for (const range of ['EDITOR_FONT_SIZE_RANGE', 'PREVIEW_FONT_SIZE_RANGE', 'CODE_FONT_SIZE_RANGE', 'EDITOR_MAX_WIDTH_RANGE']) {
		assert.match(componentSource, new RegExp(`min=\\{${range}\\.min\\}`), `${range} min not wired to the UI`);
		assert.match(componentSource, new RegExp(`max=\\{${range}\\.max\\}`), `${range} max not wired to the UI`);
	}
	assert.doesNotMatch(componentSource, /max="48"/, 'hard-coded UI bound left behind');
});

/*
 * ---------------------------------------------------------------------------
 * Task 3 — typed input is validated before it reaches the store.
 * ---------------------------------------------------------------------------
 */

test('an empty or unparseable field falls back to the default, never to null', () => {
	assert.equal(parseStoredNumber('', EDITOR_FONT_SIZE_RANGE), EDITOR_FONT_SIZE_RANGE.default);
	assert.equal(parseStoredNumber('   ', EDITOR_FONT_SIZE_RANGE), EDITOR_FONT_SIZE_RANGE.default);
	assert.equal(parseStoredNumber(null, EDITOR_FONT_SIZE_RANGE), EDITOR_FONT_SIZE_RANGE.default);
	assert.equal(parseStoredNumber('null', EDITOR_FONT_SIZE_RANGE), EDITOR_FONT_SIZE_RANGE.default);
	assert.equal(parseStoredNumber('abc', EDITOR_FONT_SIZE_RANGE), EDITOR_FONT_SIZE_RANGE.default);
	assert.equal(clampToRange(null, EDITOR_FONT_SIZE_RANGE), EDITOR_FONT_SIZE_RANGE.default);
	assert.equal(clampToRange(Number.NaN, EDITOR_FONT_SIZE_RANGE), EDITOR_FONT_SIZE_RANGE.default);
});

test('a half-typed value is neither accepted nor clamped mid-keystroke', () => {
	// Typing "18" passes through "1". Clamping there would jump the field to 10
	// and fight the user, so in-range is the acceptance test while typing.
	assert.equal(isWithinRange(1, EDITOR_FONT_SIZE_RANGE), false);
	assert.equal(isWithinRange(18, EDITOR_FONT_SIZE_RANGE), true);
	assert.equal(isWithinRange(4, EDITOR_MAX_WIDTH_RANGE), false);
	assert.equal(isWithinRange(40, EDITOR_MAX_WIDTH_RANGE), true);
	assert.equal(isWithinRange(Number.NaN, EDITOR_FONT_SIZE_RANGE), false);
	// ...and committing settles it inside the range.
	assert.equal(clampToRange(1, EDITOR_FONT_SIZE_RANGE), EDITOR_FONT_SIZE_RANGE.min);
	assert.equal(clampToRange(4, EDITOR_MAX_WIDTH_RANGE), EDITOR_MAX_WIDTH_RANGE.min);
});

test('spin buttons clamp with the same rules as typing', () => {
	assert.equal(stepWithinRange(EDITOR_FONT_SIZE_RANGE.max, 1, EDITOR_FONT_SIZE_RANGE), EDITOR_FONT_SIZE_RANGE.max);
	assert.equal(stepWithinRange(EDITOR_FONT_SIZE_RANGE.min, -1, EDITOR_FONT_SIZE_RANGE), EDITOR_FONT_SIZE_RANGE.min);
	assert.equal(stepWithinRange(47, 1, EDITOR_FONT_SIZE_RANGE), 48);
	assert.equal(stepWithinRange(490, 10, EDITOR_MAX_WIDTH_RANGE), 500);
	// A corrupt current value cannot escape the range either.
	assert.equal(stepWithinRange(Number.NaN, 1, EDITOR_FONT_SIZE_RANGE), EDITOR_FONT_SIZE_RANGE.default + 1);
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

/*
 * ---------------------------------------------------------------------------
 * Task 3b — the three values that used to write localStorage on their own.
 *
 * `theme`, `zoomLevel` and `preview.fullWidth` each had their own `$state` in
 * MarkdownViewer.svelte with a bare `localStorage.setItem` beside it. What that
 * cost is asserted below, one property per test; that no such write can come
 * back is asserted by the `localStorage is written through one function` rule in
 * singleImplementationConvention.test.ts.
 * ---------------------------------------------------------------------------
 */

test('a theme picked in one window reaches the others without a restart', () => {
	// THE BUG. Every other switch in the appearance panel synced live, because
	// every other switch was a persisted entry and got the `storage` listener for
	// free. The theme <select> sat in the same panel and did not: it wrote
	// `localStorage` directly, and nothing in the app listened for `theme`.
	resetStorage();
	const store = new SettingsStore();
	// The `storage` listener is only wired up once the effects flush.
	flushSync();
	assert.equal(store.theme, 'system');

	// A real `storage` event through the real `window`, so what is exercised is
	// the listener the store actually registered — not a callback this test
	// captured and called itself.
	localStorage.setItem('theme', 'dark');
	dispatchStorage('theme', 'dark');
	assert.equal(store.theme, 'dark');

	localStorage.setItem('theme', 'vscode:Ayu Dark');
	dispatchStorage('theme', 'vscode:Ayu Dark');
	assert.equal(store.theme, 'vscode:Ayu Dark');

	// And the arriving value is not echoed back at the window that sent it.
	const entry = createSettingsPersistence().find((item) => item.key === 'theme') as PersistedEntry;
	assert.equal(writeStoredSetting(entry.key, entry.read(store)), false);
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

test('the startup background is told the appearance, not the theme name', () => {
	// The fourth reader of this one setting, and the one that cannot see
	// localStorage at all: `app.rs` paints a window's background before the
	// webview exists, reading `theme.txt`. Its vocabulary is "dark", "light" and
	// "anything else means ask the OS" — so every `vscode:` name fell into that
	// last arm, and a dark VS Code theme on a light desktop flashed white on
	// every launch. Whether such a theme is dark is inside its own JSON, which
	// only the frontend parses, so the resolved answer is what gets sent.
	const viewerSource = readSource('src/lib/MarkdownViewer.svelte');
	assert.match(viewerSource, /function saveStartupAppearance\(appearance: 'system' \| 'light' \| 'dark'\)/);
	assert.match(viewerSource, /invoke\('save_theme', \{ theme: appearance \}\)/);
	assert.equal(
		(viewerSource.match(/invoke\('save_theme'/g) ?? []).length,
		1,
		'save_theme has one caller, so nothing can send it a raw theme name',
	);
	// The VS Code branch answers only after the parse, because that is when the
	// appearance becomes knowable.
	assert.match(
		viewerSource,
		/await parseAndApplyVscodeTheme\(json, name\);[\s\S]{0,300}?saveStartupAppearance\(document\.documentElement\.dataset\.themeType === 'dark' \? 'dark' : 'light'\)/,
	);
	// The viewer keeps no theme of its own beside the store's.
	assert.doesNotMatch(viewerSource, /let theme = \$state/);

	// Both words are literals in two languages with no compiler between them.
	const appRs = readSource('src-tauri/src/app.rs');
	assert.match(appRs, /"dark" => Some\(tauri::window::Color/);
	assert.match(appRs, /"light" => Some\(tauri::window::Color/);
});

test('an unusable stored theme falls back rather than being applied', () => {
	assert.equal(resolveTheme('dark'), 'dark');
	assert.equal(resolveTheme('vscode:Ayu Dark'), 'vscode:Ayu Dark');
	assert.equal(resolveTheme(null), 'system');
	assert.equal(resolveTheme('midnight'), 'system');
	// A bare `vscode:` names no theme; `theme.replace('vscode:', '')` would ask
	// Rust to read the file called "".
	assert.equal(resolveTheme('vscode:'), 'system');
	assert.equal(isThemeSetting('vscode:'), false);
	assert.equal(isThemeSetting(42), false);

	resetStorage({ theme: 'midnight' });
	assert.equal(new SettingsStore().theme, 'system');
	resetStorage({ theme: 'vscode:Ayu Dark' });
	assert.equal(new SettingsStore().theme, 'vscode:Ayu Dark');
});

test('a corrupt stored zoom level loads as 100, not as NaN', () => {
	// THE BUG. The viewer read this key with `parseInt(… || '100', 10)` and no
	// validation, so any value that is not a number became NaN — and NaN is a
	// trap, not a glitch: the preview renders `zoom: NaN`, and both ways out
	// (`Math.min(NaN + 10, 500)` on the wheel and on Mod+=) are NaN as well. Only
	// the reset button could recover the app.
	for (const stored of ['banana', 'null', '', '   ', 'NaN', 'Infinity']) {
		resetStorage({ zoomLevel: stored });
		const store = new SettingsStore();
		assert.equal(store.zoomLevel, ZOOM_LEVEL_RANGE.default, `zoomLevel=${JSON.stringify(stored)}`);
		assert.ok(Number.isFinite(store.zoomLevel));
	}

	resetStorage({ zoomLevel: '250' });
	assert.equal(new SettingsStore().zoomLevel, 250, 'a good value still survives a restart');
	resetStorage({ zoomLevel: '9000' });
	assert.equal(new SettingsStore().zoomLevel, ZOOM_LEVEL_RANGE.max, 'and one out of range is clamped, not dropped');
});

test('the zoom operations are bounded by one range, and recover a corrupt level', () => {
	// The 25/500 pair used to be written out three times (the viewer's wheel
	// handler, its keyboard chords, and the editor's own wheel handler) beside a
	// `100` in three more. These are the operations all of them call now.
	assert.deepEqual(
		{ min: ZOOM_LEVEL_RANGE.min, max: ZOOM_LEVEL_RANGE.max, step: ZOOM_LEVEL_RANGE.step, default: ZOOM_LEVEL_RANGE.default },
		{ min: 25, max: 500, step: 10, default: 100 },
	);

	resetStorage();
	const store = new SettingsStore();
	store.zoomIn();
	assert.equal(store.zoomLevel, 110);
	store.zoomOut();
	store.zoomOut();
	assert.equal(store.zoomLevel, 90);
	store.resetZoom();
	assert.equal(store.zoomLevel, ZOOM_LEVEL_RANGE.default);

	store.zoomLevel = ZOOM_LEVEL_RANGE.max;
	store.zoomIn();
	assert.equal(store.zoomLevel, ZOOM_LEVEL_RANGE.max, 'zooming in at the top is a no-op, not 510');
	store.zoomLevel = ZOOM_LEVEL_RANGE.min;
	store.zoomOut();
	assert.equal(store.zoomLevel, ZOOM_LEVEL_RANGE.min);

	// The other half of the NaN trap: a level that is already corrupt has to be
	// escapable with the wheel, not only with the reset button.
	store.zoomLevel = Number.NaN;
	store.zoomIn();
	assert.equal(store.zoomLevel, ZOOM_LEVEL_RANGE.default + ZOOM_LEVEL_RANGE.step);
});

test('zoom and preview width follow the other windows too', () => {
	resetStorage();
	const store = new SettingsStore();
	flushSync();

	localStorage.setItem('zoomLevel', '150');
	dispatchStorage('zoomLevel', '150');
	assert.equal(store.zoomLevel, 150);

	// Including garbage another window somehow published: the load path is the
	// same one the constructor uses, so it validates the same way.
	localStorage.setItem('zoomLevel', 'banana');
	dispatchStorage('zoomLevel', 'banana');
	assert.equal(store.zoomLevel, ZOOM_LEVEL_RANGE.default);

	localStorage.setItem('preview.fullWidth', 'true');
	dispatchStorage('preview.fullWidth', 'true');
	assert.equal(store.previewFullWidth, true);
	store.togglePreviewFullWidth();
	assert.equal(store.previewFullWidth, false);
});

test('the legacy full-width key is honoured once and then superseded', () => {
	resetStorage({ isFullWidth: 'true' });
	assert.equal(new SettingsStore().previewFullWidth, true, 'an install upgrading from the old key keeps its setting');

	// The old key is left in place rather than deleted — `read` touches one field
	// and so cannot remove a second key — and the new one takes precedence from
	// the first write onwards, which is how `editor.openFileMode` and
	// `editor.autoSaveEdits` treat theirs.
	resetStorage({ isFullWidth: 'true', 'preview.fullWidth': 'false' });
	assert.equal(new SettingsStore().previewFullWidth, false);
});

/*
 * ---------------------------------------------------------------------------
 * Task 4 — language tag resolution.
 * ---------------------------------------------------------------------------
 */

test('Norwegian BCP-47 tags resolve to the Norwegian catalogue entry', () => {
	// `no` is the macrolanguage; browsers report nb/nn.
	assert.equal(resolveLanguageTag('nb'), 'no');
	assert.equal(resolveLanguageTag('nb-NO'), 'no');
	assert.equal(resolveLanguageTag('nn'), 'no');
	assert.equal(resolveLanguageTag('nn-NO'), 'no');
	assert.equal(resolveLanguageTag('no'), 'no');
});

test('Dutch is not swallowed by the Norwegian rule', () => {
	assert.equal(resolveLanguageTag('nl'), 'nl');
	assert.equal(resolveLanguageTag('nl-NL'), 'nl');
	assert.equal(resolveLanguageTag('nl-BE'), 'nl');
});

test('Traditional Chinese is detected from the script subtag, not just the region', () => {
	assert.equal(resolveLanguageTag('zh-Hant'), 'zh-TW');
	assert.equal(resolveLanguageTag('zh-Hant-TW'), 'zh-TW');
	assert.equal(resolveLanguageTag('zh-Hant-HK'), 'zh-TW');
	assert.equal(resolveLanguageTag('zh-TW'), 'zh-TW');
	assert.equal(resolveLanguageTag('zh-HK'), 'zh-TW');
	assert.equal(resolveLanguageTag('zh-MO'), 'zh-TW');
	assert.equal(resolveLanguageTag('zh-Hans'), 'zh-CN');
	assert.equal(resolveLanguageTag('zh-Hans-CN'), 'zh-CN');
	assert.equal(resolveLanguageTag('zh'), 'zh-CN');
	assert.equal(resolveLanguageTag('zh-CN'), 'zh-CN');
});

test('regional variants and unsupported tags resolve predictably', () => {
	assert.equal(resolveLanguageTag('pt-BR'), 'pt-BR');
	assert.equal(resolveLanguageTag('pt'), 'pt');
	assert.equal(resolveLanguageTag('pt-PT'), 'pt');
	assert.equal(resolveLanguageTag('en_GB'), 'en');
	assert.equal(resolveLanguageTag('ar'), null);
	assert.equal(resolveLanguageTag('nog'), null); // used to match startsWith('no')
	assert.equal(resolveLanguageTag(''), null);
	assert.equal(resolveLanguageTag(null), null);
	assert.equal(resolveLanguageTag(undefined), null);
});

test('system detection falls back to English for unsupported locales', () => {
	setNavigatorLanguage('ar-EG');
	assert.equal(detectSystemLanguage(), 'en');
	setNavigatorLanguage('nb-NO');
	assert.equal(detectSystemLanguage(), 'no');
	setNavigatorLanguage('en-US');
});

test('a stored language is validated against the catalogue', () => {
	resetStorage({ 'editor.language': 'klingon' });
	setNavigatorLanguage('ja-JP');
	assert.equal(new SettingsStore().language, 'en'); // unchanged default, not the bogus code

	resetStorage();
	assert.equal(new SettingsStore().language, 'ja'); // nothing stored -> detect
	setNavigatorLanguage('en-US');
});

test('the validator accepts exactly the languages the dialog offers', () => {
	// SUPPORTED_LANGUAGE_CODES is derived from getSupportedLanguages(), so the
	// first assertion is true by construction *today* — and that is the point.
	// It is the assertion that fails the moment someone re-forks the catalogue
	// into this module, which is how the two copies got here in the first place.
	// The `pt` drift the fork produced was in `name`/`nativeName`, which codes
	// cannot see; the `nativeName:` rule in singleImplementationConvention.test.ts
	// covers that half.
	const offered = getSupportedLanguages().map((entry) => entry.code);

	// Not by construction: `translations` and LANGUAGE_BY_PRIMARY_SUBTAG (via
	// resolveLanguageTag) are hand-maintained beside the catalogue. A language
	// offered in the <select> with no dictionary renders as raw English, and a
	// language the tag resolver can produce but the validator rejects makes
	// detectSystemLanguage's result unstorable.
	for (const code of offered) {
		assert.ok(translations[code], `${code} is offered by the language <select> but has no dictionary`);
	}
	assert.deepEqual(Object.keys(translations).sort(), [...offered].sort());

	for (const tag of ['nb', 'nn', 'pt-PT', 'pt-BR', 'zh-Hant', 'zh-Hans', 'en_GB']) {
		const resolved = resolveLanguageTag(tag);
		assert.ok(resolved && isSupportedLanguage(resolved), `${tag} resolves to ${resolved}, which will not survive a reload`);
	}
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
 * Task 6 — the zen-mode snapshot is validated like every other stored value.
 *
 * `editor.preZenState` was the one entry in the table that trusted what it
 * found: a bare `JSON.parse` straight onto the field, with a `console.error`
 * for the only failure it considered possible. Its neighbours all validate —
 * `normalizeEditorToolbarOrder`, `parseStoredNumber`, `isSupportedLanguage`,
 * `raw === 'left' || raw === 'right'` — and this is the entry whose unchecked
 * value is copied back onto six other settings the moment zen mode ends.
 * ---------------------------------------------------------------------------
 */

/** A snapshot whose six values all differ from the store's defaults. */
const USER_SNAPSHOT = {
	renderLineHighlight: 'none',
	showTabs: false,
	statusBar: false,
	minimap: true,
	lineNumbers: 'off',
	showToc: true,
};

/** Every way a stored snapshot can be unusable, as it appears in localStorage. */
const CORRUPT_SNAPSHOTS: Record<string, string> = {
	'a field of the wrong type': '{"renderLineHighlight":"none","showTabs":"yes","statusBar":true,"minimap":false,"lineNumbers":"on","showToc":false}',
	'a missing field': '{"renderLineHighlight":"none","statusBar":true,"minimap":false,"lineNumbers":"on","showToc":false}',
	'not an object': '"showTabs"',
	'unparseable JSON': '{"showTabs":',
};

test('a stored zen snapshot is accepted only whole', () => {
	assert.deepEqual(normalizePreZenState({ ...USER_SNAPSHOT }), USER_SNAPSHOT);
	// Fields nobody declared are dropped rather than carried onto the store.
	assert.deepEqual(normalizePreZenState({ ...USER_SNAPSHOT, wordWrap: 'off' }), USER_SNAPSHOT);

	// One field wrong is the whole record wrong: a snapshot this version cannot
	// read comes from a version whose other five fields it cannot vouch for
	// either, and a half-applied restore is a state the user never had.
	assert.equal(normalizePreZenState({ ...USER_SNAPSHOT, showTabs: 'yes' }), null);
	assert.equal(normalizePreZenState({ ...USER_SNAPSHOT, showTabs: 1 }), null);
	assert.equal(normalizePreZenState({ ...USER_SNAPSHOT, lineNumbers: 0 }), null);
	assert.equal(normalizePreZenState({ ...USER_SNAPSHOT, showToc: null }), null);
	const { showTabs, ...missingShowTabs } = USER_SNAPSHOT;
	assert.equal(normalizePreZenState(missingShowTabs), null);
	assert.equal(normalizePreZenState({}), null);

	// And nothing that is not an object gets that far.
	for (const value of [null, undefined, 42, 'showTabs', true, [USER_SNAPSHOT]]) {
		assert.equal(normalizePreZenState(value), null, `${JSON.stringify(value)} is not a snapshot`);
	}
});

test('a corrupt zen snapshot never reaches the settings it would restore', () => {
	for (const [description, stored] of Object.entries(CORRUPT_SNAPSHOTS)) {
		resetStorage({ 'editor.preZenState': stored });
		const store = new SettingsStore();
		assert.equal(store.preZenState, null, description);
		// The store's own fields are untouched: the record was rejected before
		// anything could be copied out of it.
		assert.equal(store.showTabs, true, description);
		assert.equal(store.statusBar, true, description);
	}

	resetStorage({ 'editor.preZenState': JSON.stringify(USER_SNAPSHOT) });
	assert.deepEqual(new SettingsStore().preZenState, USER_SNAPSHOT, 'a good snapshot still survives a restart');
});

test('the tab bar comes back on leaving zen mode even when the snapshot is unusable', () => {
	// THE BUG, end to end. Zen mode had already hidden the tab bar and written
	// `editor.showTabs=false`; the snapshot that says how to put it back is one
	// this version cannot read.
	//
	// Unvalidated, the missing-field case restored `showTabs = undefined`, whose
	// write effect stored the *string* `"undefined"` — and `raw === 'true'` is
	// false forever after, so the tab bar was gone on every later launch too,
	// with only the settings dialog to bring it back.
	for (const [description, stored] of Object.entries(CORRUPT_SNAPSHOTS)) {
		resetStorage({
			'editor.zenMode': 'true',
			'editor.showTabs': 'false',
			'editor.statusBar': 'false',
			'editor.lineNumbers': 'off',
			'editor.preZenState': stored,
		});
		const store = new SettingsStore();
		flushSync();
		assert.equal(store.zenMode, true, description);
		assert.equal(store.showTabs, false, description);

		store.toggleZenMode();
		flushSync();

		assert.equal(store.zenMode, false, description);
		assert.equal(store.showTabs, true, `${description}: the tab bar is back`);
		assert.equal(store.statusBar, true, description);
		assert.equal(store.lineNumbers, 'on', description);
		assert.equal(store.renderLineHighlight, 'line', description);
		assert.equal(store.showToc, false, description);

		// What was persisted is a boolean's spelling, not "undefined"...
		assert.equal(localStorage.getItem('editor.showTabs'), 'true', description);
		assert.equal(localStorage.getItem('editor.preZenState'), null, `${description}: the bad record is gone`);
		// ...so the next launch keeps the tab bar instead of reading it back as false.
		assert.equal(new SettingsStore().showTabs, true, `${description}: and it is still there after a restart`);
	}
});

test('a good snapshot still restores what the user had, not the defaults', () => {
	// The other half: the fallback must not be reached while there is a record
	// to honour, or leaving zen mode would reset six settings every time.
	resetStorage();
	const store = new SettingsStore();
	Object.assign(store, USER_SNAPSHOT);
	flushSync();

	store.toggleZenMode();
	flushSync();
	assert.equal(store.showTabs, false);
	assert.equal(store.minimap, false, 'zen mode flattens everything, including what was already off');

	// Through localStorage and a restart, the way a real session gets there.
	const restarted = new SettingsStore();
	assert.deepEqual(restarted.preZenState, USER_SNAPSHOT);
	restarted.toggleZenMode();
	assert.equal(restarted.zenMode, false);
	for (const [field, value] of Object.entries(USER_SNAPSHOT)) {
		assert.equal(Reflect.get(restarted, field), value, `${field} came back as the user left it`);
	}
	assert.equal(restarted.preZenState, null, 'the snapshot is spent once it has been restored');
});

test('the zen fallback is each setting own default', () => {
	// DEFAULT_PRE_ZEN_STATE spells out six values the store already declares in
	// its field initializers. This is what stops the two copies drifting.
	resetStorage();
	const fresh = new SettingsStore();
	for (const [field, value] of Object.entries(DEFAULT_PRE_ZEN_STATE)) {
		assert.equal(Reflect.get(fresh, field), value, `${field} default differs from the zen fallback`);
	}
	assert.equal(Object.keys(DEFAULT_PRE_ZEN_STATE).length, 6);
});

/*
 * ---------------------------------------------------------------------------
 * Structural guards on the store itself.
 * ---------------------------------------------------------------------------
 */

test('the store listens for cross-window storage events', () => {
	assert.match(storeSource, /addEventListener\('storage', onStorage\)/);
	assert.match(storeSource, /removeEventListener\('storage', onStorage\)/);
});

test('the store has no single effect that writes every key', () => {
	const setItemCalls = storeSource.match(/localStorage\.setItem\(/g) ?? [];
	assert.equal(setItemCalls.length, 1, 'localStorage writes must funnel through writeStoredSetting');
	assert.match(storeSource, /function writeStoredSetting[\s\S]{0,600}if \(current === value\) return false;/);
});

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
