import { invoke } from '@tauri-apps/api/core';
import {
	DEFAULT_EDITOR_TOOLBAR_ORDER,
	applyEditorToolbarMove,
	getEditorToolbarAdjacentMove,
	getEditorToolbarReorderMove,
	normalizeEditorToolbarHidden,
	normalizeEditorToolbarOrder,
} from '../utils/editorToolbar.js';
import {
	DEFAULT_AUTO_SAVE,
	resolveAutoSave,
} from '../utils/autoSaveSetting.js';
import {
	DEFAULT_OPEN_FILE_MODE,
	resolveOpenFileMode,
	type OpenFileMode,
} from '../utils/openFileMode.js';
import {
	DEFAULT_TITLEBAR_TOOLBAR_ORDER,
	DEFAULT_TITLEBAR_TOOLBAR_PLACEMENT,
	applyTitlebarToolbarMove,
	getTitlebarToolbarAdjacentMove,
	getTitlebarToolbarReorderMove,
	normalizeTitlebarToolbarHidden,
	normalizeTitlebarToolbarOrder,
	normalizeTitlebarToolbarPlacement,
	type TitlebarToolbarPlacement,
} from '../utils/titlebarToolbar.js';
import {
	DEFAULT_PREVIEW_MAX_WIDTH,
	getStoredPreviewFullWidth,
	normalizePreviewMaxWidth,
} from '../utils/previewWidth.js';
import { getSupportedLanguages, type LanguageCode } from '../utils/i18n.js';

export type OSType = 'macos' | 'windows' | 'linux' | 'unknown';

export type { LanguageCode };

/**
 * Everything the appearance `<select>` can be set to: the three built-ins plus
 * one entry per imported VS Code theme, whose names are user data and so cannot
 * be enumerated here.
 *
 * A union rather than `string` for the same reason {@link LanguageCode} is one —
 * `theme` crosses four modules (the viewer's effect, the title bar menu, the
 * settings dialog and `save_theme`), and while it was a bare `string` the
 * dialog needed two `as any` casts to hand a value back.
 */
export type ThemeSetting = 'system' | 'light' | 'dark' | `vscode:${string}`;

export const DEFAULT_THEME: ThemeSetting = 'system';

/**
 * The four the backend can answer `get_os_type` with.
 *
 * Guarded rather than cast, because the failure that reaches here is not a
 * rejection. `initOSType` catches those; what it did not catch was a
 * *successful* `null` or `undefined`, which `as OSType` laundered into the
 * union. `DEFAULT_FONTS[null]` is `undefined`, and the line after it reads
 * `.editorFont` off that — so the store's constructor threw before any
 * setting was applied.
 *
 * Not reachable from the shipped app: the Rust command always answers with a
 * string. It surfaced in #635, when the vitest move started booting the real
 * singleton against a bridge stub that answered `null` to everything.
 */
export function isOSType(value: unknown): value is OSType {
	return value === 'macos' || value === 'windows' || value === 'linux' || value === 'unknown';
}

export function isThemeSetting(value: unknown): value is ThemeSetting {
	if (value === 'system' || value === 'light' || value === 'dark') return true;
	return typeof value === 'string' && value.startsWith('vscode:') && value.length > 'vscode:'.length;
}

/**
 * Coerces a raw string — from localStorage, from a `<select>`, from a sibling
 * window's `storage` event — to a theme. Anything unrecognised is the default
 * rather than an error: a theme the app cannot apply must not stop it starting.
 */
export function resolveTheme(value: unknown): ThemeSetting {
	return isThemeSetting(value) ? value : DEFAULT_THEME;
}

/**
 * The codes `isSupportedLanguage` will accept out of persisted storage, taken
 * from the same catalogue the language `<select>` renders.
 *
 * This module used to carry its own `{ code, name, nativeName }` table beside
 * `getSupportedLanguages()`. Only the `code` column was ever read, so the two
 * copies of the display columns drifted unnoticed: `pt` was "Portuguese" in
 * the catalogue the dialog renders and "Portuguese (European)" in the copy
 * here, and no user ever saw the second spelling. Deriving from the catalogue
 * means a language can only be added, removed or renamed in one place.
 */
const SUPPORTED_LANGUAGE_CODES: readonly LanguageCode[] = getSupportedLanguages().map((entry) => entry.code);

export function isSupportedLanguage(value: unknown): value is LanguageCode {
	return typeof value === 'string' && (SUPPORTED_LANGUAGE_CODES as readonly string[]).includes(value);
}

/**
 * Maps a BCP-47 *primary language subtag* to one of our catalogue entries.
 *
 * Matching is on the exact primary subtag rather than a `startsWith()` prefix:
 * prefix matching silently confuses distinct languages that share leading
 * letters (`nl` Dutch vs. `nn`/`nb` Norwegian), and it also matches unrelated
 * tags such as `nog` (Nogai).
 */
const LANGUAGE_BY_PRIMARY_SUBTAG: Readonly<Record<string, LanguageCode>> = {
	cs: 'cs',
	da: 'da',
	de: 'de',
	el: 'el',
	en: 'en',
	es: 'es',
	fi: 'fi',
	fr: 'fr',
	hu: 'hu',
	id: 'id',
	it: 'it',
	ja: 'ja',
	ko: 'ko',
	nl: 'nl',
	// Our catalogue is keyed by the `no` macrolanguage, but BCP-47 tags in the
	// wild are `nb` (Bokmål) or `nn` (Nynorsk); browsers essentially never
	// report a bare `no`. Accept all three.
	nb: 'no',
	nn: 'no',
	no: 'no',
	pl: 'pl',
	ro: 'ro',
	ru: 'ru',
	sk: 'sk',
	sv: 'sv',
	tr: 'tr',
	vi: 'vi',
};

/**
 * Resolves a BCP-47 language tag to a supported catalogue code, or `null` when
 * we have no translation for it. Pure so it can be unit-tested directly.
 */
export function resolveLanguageTag(tag: string | null | undefined): LanguageCode | null {
	if (typeof tag !== 'string') return null;
	const subtags = tag.trim().toLowerCase().split(/[-_]/).filter(Boolean);
	const primary = subtags[0];
	if (!primary) return null;
	const rest = subtags.slice(1);

	if (primary === 'zh') {
		// The script subtag is authoritative when present: `zh-Hant` and
		// `zh-Hant-TW` are Traditional even without a Traditional region, and
		// `zh-Hans-HK` is Simplified despite the Hong Kong region.
		if (rest.includes('hant')) return 'zh-TW';
		if (rest.includes('hans')) return 'zh-CN';
		if (rest.some((subtag) => subtag === 'tw' || subtag === 'hk' || subtag === 'mo')) return 'zh-TW';
		return 'zh-CN';
	}
	if (primary === 'pt') {
		return rest.includes('br') ? 'pt-BR' : 'pt';
	}
	return LANGUAGE_BY_PRIMARY_SUBTAG[primary] ?? null;
}

export function detectSystemLanguage(): LanguageCode {
	if (typeof navigator === 'undefined') return 'en';
	return resolveLanguageTag(navigator.language) ?? 'en';
}

export interface DefaultFonts {
	editorFont: string;
	previewFont: string;
	codeFont: string;
}

export const DEFAULT_FONTS: Record<OSType, DefaultFonts> = {
	macos: {
		editorFont: 'Menlo',
		previewFont: 'Helvetica Neue',
		codeFont: 'Menlo',
	},
	windows: {
		editorFont: 'Consolas',
		previewFont: 'Segoe UI',
		codeFont: 'Consolas',
	},
	linux: {
		editorFont: 'Monospace',
		previewFont: 'system-ui',
		codeFont: 'Monospace',
	},
	unknown: {
		editorFont: 'Consolas',
		previewFont: 'Segoe UI',
		codeFont: 'Consolas',
	},
};

/**
 * The allowed range of a numeric setting. Single source of truth: the settings
 * UI renders `min`/`max`/`step` from it and every write path (typing, spin
 * buttons, reset, load from localStorage) clamps against the same object, so
 * the UI can never offer a value that persistence would silently shrink.
 */
export interface NumericSettingRange {
	readonly min: number;
	readonly max: number;
	readonly step: number;
	readonly default: number;
}

// Upper bound is 48 across all three font sizes: the spin buttons already let
// users reach 48, so profiles in the wild contain sizes above the old clamp of
// 24/28. Aligning persistence up to the UI keeps those settings; aligning the
// UI down to persistence would shrink an existing user's editor on upgrade.
export const EDITOR_FONT_SIZE_RANGE: NumericSettingRange = { min: 10, max: 48, step: 1, default: 14 };
export const PREVIEW_FONT_SIZE_RANGE: NumericSettingRange = { min: 12, max: 48, step: 1, default: 16 };
export const CODE_FONT_SIZE_RANGE: NumericSettingRange = { min: 10, max: 48, step: 1, default: 14 };
export const EDITOR_MAX_WIDTH_RANGE: NumericSettingRange = { min: 20, max: 500, step: 10, default: 80 };
export const TOC_WIDTH_RANGE: NumericSettingRange = { min: 180, max: 420, step: 1, default: 240 };
// The preview zoom factor, as a percentage. The 25/500 pair used to be written
// out three times — the wheel handler and the keyboard chords in
// MarkdownViewer.svelte and the editor's own wheel handler — beside a `100` in
// three more places, and the stored value was read with a bare `parseInt` that
// let a corrupt key through as NaN. `Math.min(NaN + 10, 500)` is NaN too, so
// once that happened neither the wheel nor the chords could get back out; the
// preview rendered `zoom: NaN` until the reset button was found.
export const ZOOM_LEVEL_RANGE: NumericSettingRange = { min: 25, max: 500, step: 10, default: 100 };

/** True when `value` is a finite number the user is allowed to commit as-is. */
export function isWithinRange(value: unknown, range: NumericSettingRange): boolean {
	return typeof value === 'number' && Number.isFinite(value) && value >= range.min && value <= range.max;
}

/**
 * Coerces anything to an in-range integer, falling back to the range default.
 *
 * "No value" (null/undefined/empty) is the default rather than the minimum:
 * `Number(null)` is 0, so clamping it blindly would turn a cleared input into
 * the smallest legal font size instead of the one the user started with.
 */
export function clampToRange(value: unknown, range: NumericSettingRange): number {
	if (value === null || value === undefined || value === '') return range.default;
	const parsed = typeof value === 'number' ? value : Number(value);
	if (!Number.isFinite(parsed)) return range.default;
	return Math.min(range.max, Math.max(range.min, Math.round(parsed)));
}

/** Parses a persisted string. Missing/blank/garbage all fall back to the default. */
export function parseStoredNumber(raw: string | null, range: NumericSettingRange): number {
	if (raw === null || raw.trim() === '') return range.default;
	return clampToRange(raw, range);
}

/** Spin-button helper: nudge by `delta` steps and clamp with the same rules. */
export function stepWithinRange(current: unknown, delta: number, range: NumericSettingRange): number {
	return clampToRange(clampToRange(current, range) + delta, range);
}

const LEGACY_START_IN_EDITOR_KEY = 'editor.startInEditor';
const LEGACY_PREVIEW_FULL_WIDTH_KEY = 'isFullWidth';
const LEGACY_AUTO_SAVE_KEY = 'editor.autoSave';
const LEGACY_CONFIRM_BEFORE_SAVE_KEY = 'editor.confirmBeforeSave';

function readStoredKey(key: string): string | null {
	if (typeof localStorage === 'undefined' || typeof localStorage.getItem !== 'function') return null;
	return localStorage.getItem(key);
}

function parseStoredStringList(value: string | null): string[] | null {
	if (value === null) return null;
	try {
		const parsed = JSON.parse(value);
		return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : null;
	} catch {
		return null;
	}
}

function parseStoredRecord(value: string | null): Record<string, unknown> | null {
	if (value === null) return null;
	try {
		const parsed = JSON.parse(value);
		return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
	} catch {
		return null;
	}
}

/**
 * The six settings zen mode flattens, as they were the moment it was entered.
 * `null` means "no snapshot": either zen mode is off, or the stored one could
 * not be trusted.
 */
export interface PreZenState {
	renderLineHighlight: string;
	showTabs: boolean;
	statusBar: boolean;
	minimap: boolean;
	lineNumbers: string;
	showToc: boolean;
}

/**
 * What leaving zen mode restores when there is no snapshot to restore from.
 *
 * These are the same six values the store's own field initializers use — pinned
 * against drift by a test — because "the setting's own default" is the only
 * answer available once the record of what the user had is gone.
 */
export const DEFAULT_PRE_ZEN_STATE: PreZenState = {
	renderLineHighlight: 'line',
	showTabs: true,
	statusBar: true,
	minimap: false,
	lineNumbers: 'on',
	showToc: false,
};

/**
 * Validates a parsed `editor.preZenState`, the way every other entry in
 * {@link createSettingsPersistence} validates its own raw value.
 *
 * All six fields or none. A snapshot missing a field, or carrying one of the
 * wrong type, comes from a version of Markpad this one cannot interpret, and
 * half-applying it produces a state the user never had — so it is rejected
 * whole and zen mode leaves through {@link DEFAULT_PRE_ZEN_STATE} instead.
 *
 * The unvalidated `JSON.parse` this replaces is how the tab bar could vanish
 * for good: a snapshot with no `showTabs` restored `showTabs = undefined`, the
 * write effect stored the string `"undefined"`, and every later launch read
 * that back as `false` with no way out but the settings dialog.
 */
export function normalizePreZenState(value: unknown): PreZenState | null {
	if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
	const record = value as Record<string, unknown>;
	const { renderLineHighlight, showTabs, statusBar, minimap, lineNumbers, showToc } = record;
	if (typeof renderLineHighlight !== 'string' || typeof lineNumbers !== 'string') return null;
	if (typeof showTabs !== 'boolean' || typeof statusBar !== 'boolean') return null;
	if (typeof minimap !== 'boolean' || typeof showToc !== 'boolean') return null;
	return { renderLineHighlight, showTabs, statusBar, minimap, lineNumbers, showToc };
}

/**
 * One persisted localStorage entry.
 *
 * `read` must touch **exactly one** field of the target. That is not a style
 * rule: `read` runs inside the entry's own `$effect`, so whatever it reads
 * becomes that effect's dependency set, and every dependency is a field whose
 * change rewrites this key. A `read` that touched two fields would resurrect
 * the multi-window bug this shape exists to fix.
 */
export interface PersistedSetting<T> {
	readonly key: string;
	/** Serializes this entry's single field. `null` means "remove the key". */
	readonly read: (target: T) => string | null;
	/** Applies a stored (or remotely changed) raw value back onto that field. */
	readonly load: (target: T, raw: string | null) => void;
}

/**
 * Compare-and-set write. Returns true when localStorage actually changed.
 *
 * This is the whole anti-echo mechanism for cross-window sync, and it is why no
 * "I am currently applying a remote change" flag is involved. Such a flag
 * cannot work here: Svelte flushes effects asynchronously, so a flag raised and
 * lowered synchronously inside a `storage` handler is long gone by the time the
 * dependent effect runs — and holding it up until the next flush would also
 * swallow genuine local edits made in the same tick.
 *
 * Reading before writing needs no timing assumption at all. A value that
 * arrived *from* localStorage is by definition already equal to what is stored,
 * so the write-back is dropped at its source and the
 * `storage` -> state -> effect -> write -> `storage` loop terminates after one
 * hop. It also makes redundant writes free in the ordinary single-window case.
 */
export function writeStoredSetting(key: string, value: string | null): boolean {
	if (typeof localStorage === 'undefined' || typeof localStorage.getItem !== 'function') return false;
	const current = localStorage.getItem(key);
	if (value === null) {
		if (current === null) return false;
		localStorage.removeItem(key);
		return true;
	}
	if (current === value) return false;
	localStorage.setItem(key, value);
	return true;
}

/** Applies everything currently in localStorage onto `target`. */
function loadPersistedSettings<T>(target: T, entries: readonly PersistedSetting<T>[]): void {
	if (typeof localStorage === 'undefined' || typeof localStorage.getItem !== 'function') return;
	for (const entry of entries) {
		entry.load(target, localStorage.getItem(entry.key));
	}
}

/**
 * Wires `entries` up to localStorage. Must be called inside an effect root.
 *
 * One effect per key, instead of one effect reading every field: a change to
 * setting A then rewrites only A's key. Markpad opens several windows, each a
 * separate webview with its own store instance, all sharing one localStorage —
 * with a single all-fields effect, any change in window B rewrote all ~30 keys
 * from B's construction-time snapshot and threw away whatever window A had just
 * changed.
 *
 * The `storage` listener closes the other half: localStorage fires it in every
 * *other* same-origin document, so each window folds its siblings' changes into
 * its own state instead of drifting until the next restart.
 */
function installPersistedSettings<T>(target: T, entries: readonly PersistedSetting<T>[]): void {
	for (const entry of entries) {
		$effect(() => {
			writeStoredSetting(entry.key, entry.read(target));
		});
	}

	$effect(() => {
		if (typeof window === 'undefined') return;
		const entriesByKey = new Map(entries.map((entry) => [entry.key, entry]));
		const onStorage = (event: StorageEvent) => {
			if (event.storageArea && typeof localStorage !== 'undefined' && typeof localStorage.getItem === 'function' && event.storageArea !== localStorage) return;
			// A null key means the whole store was cleared; re-read everything.
			if (event.key === null) {
				loadPersistedSettings(target, entries);
				return;
			}
			const entry = entriesByKey.get(event.key);
			if (entry) entry.load(target, event.newValue);
		};
		window.addEventListener('storage', onStorage);
		return () => window.removeEventListener('storage', onStorage);
	});
}

export class SettingsStore {
	minimap = $state(false);
	wordWrap = $state('on');
	lineNumbers = $state('on');
	vimMode = $state(false);
	statusBar = $state(true);
	wordCount = $state(false);
	renderLineHighlight = $state('line');
	highlightColor = $state('yellow');
	showTabs = $state(true);
	restoreStateOnReopen = $state(true);
	zenMode = $state(false);
	showToc = $state(false);
	preZenState = $state<PreZenState | null>(null);
	occurrencesHighlight = $state(false);
	showWhitespace = $state(false);
	stickyScroll = $state(true);
	/**
	 * Whether a newly split tab starts with its panes scroll-locked.
	 *
	 * A preference, not a tab's state: `Tab.isScrollSynced` is the per-tab
	 * answer, lives in the window-state snapshot, and is what the title bar
	 * toggles. This is the sticky default the last toggle left behind, which
	 * `TabManager.splitScrollSyncPreference` seeds the next split from — one
	 * scalar shared by every tab and every window, so it belongs here with the
	 * rest of them rather than in the tab store that reads it.
	 */
	splitScrollSync = $state(false);
	openFileMode = $state<OpenFileMode>(DEFAULT_OPEN_FILE_MODE);
	newFileDefaultMode = $state(true);
	showRecentFiles = $state(true);
	/*
	 * On, so nothing about an existing install changes.
	 *
	 * It covers a jump in either pane — a heading from the table of contents, a
	 * find match, back and forward — because they are one decision the user
	 * makes once, not a preview one and an editor one. `utils/motion.ts` holds
	 * that decision; the seven places that used to spell it themselves ask it.
	 */
	animateJumpScroll = $state(true);
	/**
	 * The system's own request for less motion. Not persisted and not a default
	 * for `animateJumpScroll` — it is the OS answering, live, and a stored copy
	 * would be wrong the moment the user changed it.
	 */
	systemReducedMotion = $state(false);
	/*
	 * Off, so a click on a relative link keeps navigating this tab.
	 *
	 * Following a link in place is the only thing that writes a tab's file
	 * history, and Back and Forward read it — they sit on the title bar by
	 * default. Turning this on by default would leave both of them permanently
	 * inert for anyone who never opened this page, which is a capability to
	 * take away deliberately rather than as the side effect of a new setting.
	 */
	linksOpenInNewTab = $state(false);
	editorMaxWidth = $state(80);
	previewMaxWidth = $state(DEFAULT_PREVIEW_MAX_WIDTH);
	// Preview ignores previewMaxWidth and fills the pane.
	previewFullWidth = $state(false);
	// Preview zoom, in percent. See ZOOM_LEVEL_RANGE.
	zoomLevel = $state(ZOOM_LEVEL_RANGE.default);
	theme = $state<ThemeSetting>(DEFAULT_THEME);
	pinnedToc = $state(false);
	tocSide = $state<'left' | 'right'>('left');
	/**
	 * Which side of a split the editor takes, and so which side the preview
	 * takes (#184). Read only while a tab is split: with one pane on screen it
	 * fills the container and there is no order to state.
	 *
	 * Window-wide rather than per tab, like `tocSide` and unlike `splitRatio`.
	 * A ratio is about one document — how much of it you want to see while you
	 * write — and a reader sets it again per file. Which hand the editor is
	 * under is about the reader, and answering it once per tab would mean
	 * answering it again every time one is opened.
	 */
	splitEditorSide = $state<'left' | 'right'>('left');
	tocWidth = $state(240);
	osType = $state<OSType>('unknown');
	imageDirectory = $state('img');
	macosImageScaling = $state(true);
	language = $state<LanguageCode>('en');
	showEditorToolbar = $state(true);
	editorToolbarOrder = $state<string[]>([...DEFAULT_EDITOR_TOOLBAR_ORDER]);
	editorToolbarHidden = $state<string[]>([]);
	titlebarToolbarOrder = $state<string[]>([...DEFAULT_TITLEBAR_TOOLBAR_ORDER]);
	titlebarToolbarHidden = $state<string[]>([]);
	titlebarToolbarPlacement = $state<Record<string, TitlebarToolbarPlacement>>({ ...DEFAULT_TITLEBAR_TOOLBAR_PLACEMENT });

	editorFont = $state('Consolas');
	editorFontSize = $state(14);
	previewFont = $state('Segoe UI');
	previewFontSize = $state(16);
	codeFont = $state('Consolas');
	codeFontSize = $state(14);

	// File-save behavior: on, edits are persisted without Cmd+S; off, they are
	// kept until saved and closing asks. One switch, because that is the number
	// of behaviours the app has — see `autoSaveSetting.ts` for the pair it
	// replaced and why the two of them were never independent.
	autoSave = $state(DEFAULT_AUTO_SAVE);

	/** The `$effect.root` disposer from the constructor. See {@link dispose}. */
	#disposeEffects: (() => void) | null = null;

	constructor() {
		if (typeof localStorage === 'undefined' || typeof localStorage.getItem !== 'function') return;

		const entries = createSettingsPersistence();

		// Whether a font *family* was ever chosen has to be sampled before the
		// write effects run, because those effects seed every key with the
		// current value; asking localStorage later would always find something.
		const hasStoredFontFamily = {
			editorFont: localStorage.getItem('editor.font') !== null,
			previewFont: localStorage.getItem('preview.font') !== null,
			codeFont: localStorage.getItem('preview.codeFont') !== null,
		};

		loadPersistedSettings(this, entries);

		// Font families default per OS, and the OS is only known once the
		// backend answers. Re-apply just the ones the user never picked.
		this.initOSType().then(() => {
			const defaults = DEFAULT_FONTS[this.osType];
			if (!hasStoredFontFamily.editorFont) this.editorFont = defaults.editorFont;
			if (!hasStoredFontFamily.previewFont) this.previewFont = defaults.previewFont;
			if (!hasStoredFontFamily.codeFont) this.codeFont = defaults.codeFont;
		});

		this.#disposeEffects = $effect.root(() => {
			installPersistedSettings(this, entries);
		});
	}

	/**
	 * Stops this store persisting, the way `observeFoldLayout`'s stop function
	 * stops it observing. Held on the instance rather than returned, because the
	 * one thing a constructor cannot hand back is a second value.
	 *
	 * The app never calls it: `settings` below is a singleton that lives as long
	 * as its window, and that is the behaviour the whole file is written for. A
	 * *test* constructs stores by the dozen into one shared jsdom, and each
	 * construction installs ~30 write effects plus a `storage` listener that
	 * outlive the test that made them — so a later `flushSync()` runs an
	 * abandoned store's effects too, and they rewrite its keys from its own
	 * construction-time values.
	 *
	 * Disposing the root destroys those effects *and* runs their teardowns, so
	 * the `window` listener comes off with them; nothing here is registered
	 * outside the root.
	 */
	dispose(): void {
		this.#disposeEffects?.();
		this.#disposeEffects = null;
	}

	toggleMinimap() {
		this.minimap = !this.minimap;
	}

	toggleWordWrap() {
		if (this.wordWrap === 'off') {
			this.wordWrap = 'on';
		} else if (this.wordWrap === 'on') {
			this.wordWrap = 'wordWrapColumn';
		} else {
			this.wordWrap = 'off';
		}
	}

	toggleLineNumbers() {
		this.lineNumbers = this.lineNumbers === 'on' ? 'off' : 'on';
	}

	toggleVimMode() {
		this.vimMode = !this.vimMode;
	}

	toggleStatusBar() {
		this.statusBar = !this.statusBar;
	}

	toggleWordCount() {
		this.wordCount = !this.wordCount;
	}

	toggleLineHighlight() {
		this.renderLineHighlight = this.renderLineHighlight === 'line' ? 'none' : 'line';
	}

	toggleTabs() {
		this.showTabs = !this.showTabs;
	}

	toggleRestoreStateOnReopen() {
		this.restoreStateOnReopen = !this.restoreStateOnReopen;
	}

	toggleShowRecentFiles() {
		this.showRecentFiles = !this.showRecentFiles;
	}

	toggleAnimateJumpScroll() {
		this.animateJumpScroll = !this.animateJumpScroll;
	}

	toggleLinksOpenInNewTab() {
		this.linksOpenInNewTab = !this.linksOpenInNewTab;
	}

	toggleZenMode() {
		this.zenMode = !this.zenMode;
		if (this.zenMode) {
			this.preZenState = {
				renderLineHighlight: this.renderLineHighlight,
				showTabs: this.showTabs,
				statusBar: this.statusBar,
				minimap: this.minimap,
				lineNumbers: this.lineNumbers,
				showToc: this.showToc,
			};
			this.renderLineHighlight = 'none';
			this.showTabs = false;
			this.statusBar = false;
			this.minimap = false;
			this.lineNumbers = 'off';
			this.showToc = false;
		} else {
			// Leaving zen mode always un-hides the six things entering it hid,
			// snapshot or no snapshot. The old `if (this.preZenState)` made "no
			// snapshot" mean "stay flattened", which is the state a rejected or
			// missing record leaves behind — tab bar, status bar and line numbers
			// gone with nothing in the UI saying zen mode was ever involved.
			const restored = this.preZenState ?? DEFAULT_PRE_ZEN_STATE;
			this.renderLineHighlight = restored.renderLineHighlight;
			this.showTabs = restored.showTabs;
			this.statusBar = restored.statusBar;
			this.minimap = restored.minimap;
			this.lineNumbers = restored.lineNumbers;
			this.showToc = restored.showToc;
			this.preZenState = null;
		}
	}

	toggleToc() {
		this.showToc = !this.showToc;
	}

	toggleOccurrencesHighlight() {
		this.occurrencesHighlight = !this.occurrencesHighlight;
	}

	toggleShowWhitespace() {
		this.showWhitespace = !this.showWhitespace;
	}

	toggleStickyScroll() {
		this.stickyScroll = !this.stickyScroll;
	}

	toggleNewFileDefaultMode() {
		this.newFileDefaultMode = !this.newFileDefaultMode;
	}

	togglePinnedToc() {
		this.pinnedToc = !this.pinnedToc;
	}

	toggleTocSide() {
		this.tocSide = this.tocSide === 'left' ? 'right' : 'left';
	}

	toggleSplitEditorSide() {
		this.splitEditorSide = this.splitEditorSide === 'left' ? 'right' : 'left';
	}

	setTocWidth(width: number) {
		this.tocWidth = clampToRange(width, TOC_WIDTH_RANGE);
	}

	toggleMacosImageScaling() {
		this.macosImageScaling = !this.macosImageScaling;
	}

	toggleAutoSave() {
		this.autoSave = !this.autoSave;
	}

	setLanguage(lang: LanguageCode) {
		this.language = lang;
	}

	toggleEditorToolbar() {
		this.showEditorToolbar = !this.showEditorToolbar;
	}

	setEditorToolbarToolVisible(id: string, visible: boolean) {
		const hidden = normalizeEditorToolbarHidden(this.editorToolbarHidden);
		if (visible) {
			this.editorToolbarHidden = hidden.filter((hiddenId) => hiddenId !== id);
		} else if (!hidden.includes(id)) {
			this.editorToolbarHidden = normalizeEditorToolbarHidden([...hidden, id]);
		}
	}

	moveEditorToolbarTool(id: string, direction: 'up' | 'down') {
		const move = getEditorToolbarAdjacentMove(this.editorToolbarOrder, id, direction);
		if (!move) return;
		this.editorToolbarOrder = applyEditorToolbarMove(this.editorToolbarOrder, move);
	}

	reorderEditorToolbarTool(draggedId: string, targetId: string) {
		const move = getEditorToolbarReorderMove(this.editorToolbarOrder, draggedId, targetId);
		if (!move) return;
		this.editorToolbarOrder = applyEditorToolbarMove(this.editorToolbarOrder, move);
	}

	resetEditorToolbar() {
		this.editorToolbarOrder = [...DEFAULT_EDITOR_TOOLBAR_ORDER];
		this.editorToolbarHidden = [];
	}

	setTitlebarToolbarActionVisible(id: string, visible: boolean) {
		const hidden = normalizeTitlebarToolbarHidden(this.titlebarToolbarHidden);
		if (visible) {
			this.titlebarToolbarHidden = hidden.filter((hiddenId) => hiddenId !== id);
		} else if (!hidden.includes(id)) {
			this.titlebarToolbarHidden = normalizeTitlebarToolbarHidden([...hidden, id]);
		}
	}

	setTitlebarToolbarActionPlacement(id: string, placement: TitlebarToolbarPlacement) {
		this.titlebarToolbarPlacement = normalizeTitlebarToolbarPlacement({
			...this.titlebarToolbarPlacement,
			[id]: placement,
		});
	}

	moveTitlebarToolbarAction(id: string, direction: 'up' | 'down') {
		const move = getTitlebarToolbarAdjacentMove(this.titlebarToolbarOrder, id, direction);
		if (!move) return;
		this.titlebarToolbarOrder = applyTitlebarToolbarMove(this.titlebarToolbarOrder, move);
	}

	reorderTitlebarToolbarAction(draggedId: string, targetId: string) {
		const move = getTitlebarToolbarReorderMove(this.titlebarToolbarOrder, draggedId, targetId);
		if (!move) return;
		this.titlebarToolbarOrder = applyTitlebarToolbarMove(this.titlebarToolbarOrder, move);
	}

	resetTitlebarToolbar() {
		this.titlebarToolbarOrder = [...DEFAULT_TITLEBAR_TOOLBAR_ORDER];
		this.titlebarToolbarHidden = [];
		this.titlebarToolbarPlacement = { ...DEFAULT_TITLEBAR_TOOLBAR_PLACEMENT };
	}

	resetEditorMaxWidth() {
		this.editorMaxWidth = EDITOR_MAX_WIDTH_RANGE.default;
	}

	resetPreviewMaxWidth() {
		this.previewMaxWidth = DEFAULT_PREVIEW_MAX_WIDTH;
	}

	togglePreviewFullWidth() {
		this.previewFullWidth = !this.previewFullWidth;
	}

	// The three zoom operations live here rather than at the four keyboard and
	// wheel handlers that used to spell them out, so ZOOM_LEVEL_RANGE is the only
	// place the bounds and the neutral factor exist. `stepWithinRange` also
	// re-clamps the *current* value, which is what makes a corrupt zoomLevel
	// recoverable by any of them instead of only by the reset button.
	zoomIn() {
		this.zoomLevel = stepWithinRange(this.zoomLevel, ZOOM_LEVEL_RANGE.step, ZOOM_LEVEL_RANGE);
	}

	zoomOut() {
		this.zoomLevel = stepWithinRange(this.zoomLevel, -ZOOM_LEVEL_RANGE.step, ZOOM_LEVEL_RANGE);
	}

	resetZoom() {
		this.zoomLevel = ZOOM_LEVEL_RANGE.default;
	}

	async initOSType() {
		try {
			const osType = await invoke<unknown>('get_os_type');
			this.osType = isOSType(osType) ? osType : 'unknown';
		} catch (e) {
			console.error('Failed to get OS type:', e);
			this.osType = 'unknown';
		}
	}

	resetEditorFont() {
		const defaults = DEFAULT_FONTS[this.osType];
		this.editorFont = defaults.editorFont;
		this.editorFontSize = EDITOR_FONT_SIZE_RANGE.default;
	}

	resetPreviewFont() {
		const defaults = DEFAULT_FONTS[this.osType];
		this.previewFont = defaults.previewFont;
		this.previewFontSize = PREVIEW_FONT_SIZE_RANGE.default;
		this.codeFont = defaults.codeFont;
		this.codeFontSize = CODE_FONT_SIZE_RANGE.default;
	}
}

function booleanSetting(
	key: string,
	read: (target: SettingsStore) => boolean,
	load: (target: SettingsStore, value: boolean) => void,
): PersistedSetting<SettingsStore> {
	return {
		key,
		read: (target) => String(read(target)),
		load: (target, raw) => {
			if (raw !== null) load(target, raw === 'true');
		},
	};
}

function stringSetting(
	key: string,
	read: (target: SettingsStore) => string,
	load: (target: SettingsStore, value: string) => void,
): PersistedSetting<SettingsStore> {
	return {
		key,
		read,
		load: (target, raw) => {
			if (raw !== null) load(target, raw);
		},
	};
}

function numberSetting(
	key: string,
	range: NumericSettingRange,
	read: (target: SettingsStore) => number,
	load: (target: SettingsStore, value: number) => void,
): PersistedSetting<SettingsStore> {
	return {
		key,
		read: (target) => String(read(target)),
		load: (target, raw) => load(target, parseStoredNumber(raw, range)),
	};
}

/**
 * The complete localStorage contract of {@link SettingsStore}: one entry per
 * key, and — by construction — one store field per entry.
 *
 * Adding a setting means adding one entry here; load and save then cannot drift
 * apart, and cross-window sync comes for free because
 * {@link installPersistedSettings} reuses `load` for incoming `storage` events.
 */
export function createSettingsPersistence(): PersistedSetting<SettingsStore>[] {
	return [
		booleanSetting('editor.minimap', (s) => s.minimap, (s, v) => { s.minimap = v; }),
		stringSetting('editor.wordWrap', (s) => s.wordWrap, (s, v) => { s.wordWrap = v; }),
		stringSetting('editor.lineNumbers', (s) => s.lineNumbers, (s, v) => { s.lineNumbers = v; }),
		booleanSetting('editor.vimMode', (s) => s.vimMode, (s, v) => { s.vimMode = v; }),
		booleanSetting('editor.statusBar', (s) => s.statusBar, (s, v) => { s.statusBar = v; }),
		booleanSetting('editor.wordCount', (s) => s.wordCount, (s, v) => { s.wordCount = v; }),
		stringSetting('editor.renderLineHighlight', (s) => s.renderLineHighlight, (s, v) => { s.renderLineHighlight = v; }),
		booleanSetting('editor.showTabs', (s) => s.showTabs, (s, v) => { s.showTabs = v; }),
		booleanSetting('editor.restoreStateOnReopen', (s) => s.restoreStateOnReopen, (s, v) => { s.restoreStateOnReopen = v; }),
		booleanSetting('editor.zenMode', (s) => s.zenMode, (s, v) => { s.zenMode = v; }),
		booleanSetting('editor.occurrencesHighlight', (s) => s.occurrencesHighlight, (s, v) => { s.occurrencesHighlight = v; }),
		booleanSetting('editor.showWhitespace', (s) => s.showWhitespace, (s, v) => { s.showWhitespace = v; }),
		booleanSetting('editor.stickyScroll', (s) => s.stickyScroll, (s, v) => { s.stickyScroll = v; }),
		booleanSetting('editor.splitScrollSync', (s) => s.splitScrollSync, (s, v) => { s.splitScrollSync = v; }),
		booleanSetting('editor.showToc', (s) => s.showToc, (s, v) => { s.showToc = v; }),
		stringSetting('editor.highlightColor', (s) => s.highlightColor, (s, v) => { s.highlightColor = v; }),
		{
			key: 'editor.openFileMode',
			read: (s) => s.openFileMode,
			// The second key is read, never written: it is the boolean this
			// setting replaced, and it is what an existing install still has on
			// the first launch after the upgrade. See `resolveOpenFileMode`.
			load: (s, raw) => {
				s.openFileMode = resolveOpenFileMode(raw, readStoredKey(LEGACY_START_IN_EDITOR_KEY));
			},
		},
		booleanSetting('editor.newFileDefaultMode', (s) => s.newFileDefaultMode, (s, v) => { s.newFileDefaultMode = v; }),
		booleanSetting('editor.showRecentFiles', (s) => s.showRecentFiles, (s, v) => { s.showRecentFiles = v; }),
		booleanSetting('motion.animateJumpScroll', (s) => s.animateJumpScroll, (s, v) => { s.animateJumpScroll = v; }),
		booleanSetting('links.openInNewTab', (s) => s.linksOpenInNewTab, (s, v) => { s.linksOpenInNewTab = v; }),
		numberSetting('editor.maxWidth', EDITOR_MAX_WIDTH_RANGE, (s) => s.editorMaxWidth, (s, v) => { s.editorMaxWidth = v; }),
		{
			key: 'preview.maxWidth',
			read: (s) => String(s.previewMaxWidth),
			load: (s, savedPreviewMaxWidth) => { s.previewMaxWidth = normalizePreviewMaxWidth(savedPreviewMaxWidth); },
		},
		{
			key: 'preview.fullWidth',
			read: (s) => String(s.previewFullWidth),
			// The second key is read, never written: it is the name this setting
			// had before, and it is what an existing install still has on the
			// first launch after the upgrade. The write effect seeds the new key
			// immediately, and `??` prefers it, so the legacy one stops being
			// consulted after that — the same treatment `editor.openFileMode` and
			// `editor.autoSaveEdits` give theirs. It used to be deleted here
			// instead, which a `read` that touches one field cannot do.
			load: (s, raw) => {
				s.previewFullWidth = getStoredPreviewFullWidth(raw, readStoredKey(LEGACY_PREVIEW_FULL_WIDTH_KEY));
			},
		},
		numberSetting('zoomLevel', ZOOM_LEVEL_RANGE, (s) => s.zoomLevel, (s, v) => { s.zoomLevel = v; }),
		booleanSetting('editor.pinnedToc', (s) => s.pinnedToc, (s, v) => { s.pinnedToc = v; }),
		{
			key: 'editor.tocSide',
			read: (s) => s.tocSide,
			load: (s, raw) => {
				if (raw === 'left' || raw === 'right') s.tocSide = raw;
			},
		},
		{
			key: 'editor.splitEditorSide',
			read: (s) => s.splitEditorSide,
			load: (s, raw) => {
				if (raw === 'left' || raw === 'right') s.splitEditorSide = raw;
			},
		},
		numberSetting('editor.tocWidth', TOC_WIDTH_RANGE, (s) => s.tocWidth, (s, v) => { s.tocWidth = v; }),
		stringSetting('editor.imageDirectory', (s) => s.imageDirectory, (s, v) => { s.imageDirectory = v; }),
		booleanSetting('editor.macosImageScaling', (s) => s.macosImageScaling, (s, v) => { s.macosImageScaling = v; }),
		{
			key: 'editor.language',
			read: (s) => s.language,
			load: (s, raw) => {
				if (raw === null) {
					s.language = detectSystemLanguage();
				} else if (isSupportedLanguage(raw)) {
					s.language = raw;
				}
			},
		},
		{
			// Unprefixed, because that is the key `src/app.html` reads in its
			// first-paint script to pick a background colour before the bundle
			// loads. Renaming it would reintroduce the white flash that script
			// exists to prevent.
			key: 'theme',
			read: (s) => s.theme,
			load: (s, raw) => { s.theme = resolveTheme(raw); },
		},
		booleanSetting('editor.showEditorToolbar', (s) => s.showEditorToolbar, (s, v) => { s.showEditorToolbar = v; }),
		{
			key: 'editor.toolbarOrder',
			read: (s) => JSON.stringify(normalizeEditorToolbarOrder(s.editorToolbarOrder)),
			load: (s, raw) => { s.editorToolbarOrder = normalizeEditorToolbarOrder(parseStoredStringList(raw)); },
		},
		{
			key: 'editor.toolbarHidden',
			read: (s) => JSON.stringify(normalizeEditorToolbarHidden(s.editorToolbarHidden)),
			load: (s, raw) => { s.editorToolbarHidden = normalizeEditorToolbarHidden(parseStoredStringList(raw)); },
		},
		{
			key: 'titlebar.toolbarOrder',
			read: (s) => JSON.stringify(normalizeTitlebarToolbarOrder(s.titlebarToolbarOrder)),
			load: (s, raw) => { s.titlebarToolbarOrder = normalizeTitlebarToolbarOrder(parseStoredStringList(raw)); },
		},
		{
			key: 'titlebar.toolbarHidden',
			read: (s) => JSON.stringify(normalizeTitlebarToolbarHidden(s.titlebarToolbarHidden)),
			load: (s, raw) => { s.titlebarToolbarHidden = normalizeTitlebarToolbarHidden(parseStoredStringList(raw)); },
		},
		{
			key: 'titlebar.toolbarPlacement',
			read: (s) => JSON.stringify(normalizeTitlebarToolbarPlacement(s.titlebarToolbarPlacement)),
			load: (s, raw) => { s.titlebarToolbarPlacement = normalizeTitlebarToolbarPlacement(parseStoredRecord(raw)); },
		},
		stringSetting('editor.font', (s) => s.editorFont, (s, v) => { s.editorFont = v; }),
		numberSetting('editor.fontSize', EDITOR_FONT_SIZE_RANGE, (s) => s.editorFontSize, (s, v) => { s.editorFontSize = v; }),
		stringSetting('preview.font', (s) => s.previewFont, (s, v) => { s.previewFont = v; }),
		numberSetting('preview.fontSize', PREVIEW_FONT_SIZE_RANGE, (s) => s.previewFontSize, (s, v) => { s.previewFontSize = v; }),
		stringSetting('preview.codeFont', (s) => s.codeFont, (s, v) => { s.codeFont = v; }),
		numberSetting('preview.codeFontSize', CODE_FONT_SIZE_RANGE, (s) => s.codeFontSize, (s, v) => { s.codeFontSize = v; }),
		{
			key: 'editor.autoSaveEdits',
			read: (s) => String(s.autoSave),
			// The two older keys are read, never written: they are what an
			// existing install still has on the first launch after the upgrade.
			// See `resolveAutoSave`.
			load: (s, raw) => {
				s.autoSave = resolveAutoSave(
					raw,
					readStoredKey(LEGACY_AUTO_SAVE_KEY),
					readStoredKey(LEGACY_CONFIRM_BEFORE_SAVE_KEY),
				);
			},
		},
		{
			key: 'editor.preZenState',
			read: (s) => (s.preZenState ? JSON.stringify(s.preZenState) : null),
			// Same two steps as `titlebar.toolbarPlacement`: parse to a record
			// (unparseable, non-object and array all become `null` there), then
			// validate the shape. Nothing here can throw, and nothing reaches the
			// field that the field's type does not describe.
			load: (s, raw) => { s.preZenState = normalizePreZenState(parseStoredRecord(raw)); },
		},
	];
}

export const settings = new SettingsStore();
