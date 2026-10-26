import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { parse } from 'svelte/compiler';

import { fontFamilyValue } from '../src/lib/utils/fontFamily.js';
import { getSupportedLanguages, type LanguageCode, t, type Translation } from '../src/lib/utils/i18n.js';
import { isSafeCssColor, sanitizeThemeColors } from '../src/lib/utils/theme.js';
import { translations } from './allTranslations.js';
import { functionSource, readSource, walkSourceFiles } from './sourceTree.js';

/**
 * Settings whose label did not describe what the code did.
 *
 * Three of them, found in one sweep of the panel, and all three are the same
 * failure: a control whose effect depends on another control, with nothing in
 * the UI saying so.
 *
 *   * "Auto-save edits" + "Ask for confirmation before saving" — four
 *     combinations, two behaviours, and one of them turned auto-save off while
 *     showing it on. Merged into the single switch every call site already
 *     evaluated. `autoSaveSetting.ts` holds the migration.
 *
 *   * "Wrap Column" — fed to Monaco as `wordWrapColumn`, which Monaco reads
 *     only in one of the three "Word Wrap" modes. It sat ABOVE that select and
 *     was always editable, so the two settings' relationship was invisible.
 *
 *   * "Word Count" — rendered inside the status bar. With the status bar off,
 *     turning it on shows nothing at all.
 *
 * A fourth — that "Restore windows on launch" also decides whether resolved tabs
 * stay open when a window closes — was left alone. Saying so needs a real
 * tooltip, and a `title` attribute is not one: it only changes the cursor and
 * waits a second before a browser chrome bubble the app does not control.
 *
 * The first is a behaviour change and is tested as one. The other two are the
 * UI admitting a dependency that was always there, so what is pinned is the
 * gate, plus the layout rule that the prerequisite is the row above.
 */
describe('merged auto-save preference', () => {
	const settingsSource = readSource(new URL('../src/lib/stores/settings.svelte.ts', import.meta.url));
	const settingsComponentSource = readSource(new URL('../src/lib/components/Settings.svelte', import.meta.url));
	const viewerSource = readSource(new URL('../src/lib/MarkdownViewer.svelte', import.meta.url));
	const sessionSource = readSource(new URL('../src/lib/sessions/documentSession.svelte.ts', import.meta.url));

	test('the merged preference is stored under its own key, and the old ones are read-only', () => {
		assert.match(settingsSource, /key: 'editor\.autoSaveEdits'/);
		assert.match(settingsSource, /const LEGACY_AUTO_SAVE_KEY = 'editor\.autoSave'/);
		assert.match(settingsSource, /const LEGACY_CONFIRM_BEFORE_SAVE_KEY = 'editor\.confirmBeforeSave'/);
		// A rollback finds both of the old keys where it left them.
		assert.doesNotMatch(settingsSource, /key: 'editor\.autoSave'/);
		assert.doesNotMatch(settingsSource, /key: 'editor\.confirmBeforeSave'/);
	});

	test('nothing evaluates the pair any more', () => {
		// Four sites read `autoSave && !confirmBeforeSave`; a survivor would be a
		// path that still consults a preference no UI can set.
		for (const source of [viewerSource, sessionSource, settingsComponentSource, settingsSource]) {
			assert.doesNotMatch(source, /settings\.confirmBeforeSave/);
		}
		// And the four decisions are still there, now reading the one switch.
		assert.match(viewerSource, /if \(!settings\.autoSave\) return;/); // leaving an editable pane
		assert.match(viewerSource, /if \(!settings\.autoSave\) \{/); // the debounce
		assert.match(viewerSource, /if \(settings\.autoSave\) \{/); // the close-window walk
		// Closing a tab. The condition grew a third term — a file that changed
		// under the buffer is a question for the user, not something auto-save may
		// answer by writing — but it is still this one switch that decides whether
		// the silent save happens at all.
		assert.match(sessionSource, /if \(settings\.autoSave && tab\.path !== '' && !diskMoved\)/);
	});

	/* ---------------------------------------------- B & C: visible dependency */

	test('the wrap column sits under the wrap mode, and is inert without it', () => {
		const wrapMode = settingsComponentSource.indexOf('<label for="editor-word-wrap">');
		const wrapColumn = settingsComponentSource.indexOf('<label for="editor-max-width">');
		assert.ok(wrapMode > 0 && wrapColumn > 0);
		assert.ok(wrapMode < wrapColumn, 'the prerequisite must be the row above the setting it gates');

		// Monaco reads `wordWrapColumn` only in this mode — `Editor.svelte` passes
		// the value unconditionally, and Monaco ignores it in the other two.
		const gate = /settings\.wordWrap !== 'wordWrapColumn'/g;
		assert.equal((settingsComponentSource.match(gate) ?? []).length, 4, 'the row, its input and both steppers');
	});

	test('the word count is greyed out when there is no status bar to show it in', () => {
		assert.match(settingsComponentSource, /class:inactive=\{!settings\.statusBar\}/);
		assert.match(
			settingsComponentSource,
			/id="editor-word-count"[^>]*disabled=\{!settings\.statusBar\}/,
		);
		const statusBar = settingsComponentSource.indexOf('<label for="editor-status-bar">');
		const wordCount = settingsComponentSource.indexOf('<label for="editor-word-count">');
		assert.ok(statusBar > 0 && statusBar < wordCount, 'same rule: the prerequisite is the row above');
	});

	test('an inactive row is dimmed rather than hidden', () => {
		// Hiding it would answer "where did that setting go?" with nothing.
		assert.match(settingsComponentSource, /\.setting-item\.inactive[\s\S]{0,200}?opacity: 0\.45/);
	});


	/* ------------------------------------------------ D: last tab (#829) */

	test('closing the last tab leaves the window on Home when the setting is off', () => {
		const body = functionSource(viewerSource, 'closeTabAndWindowIfLast');
		assert.match(body, /if \(settings\.closeWindowWithLastTab\) await destroyWindowAfterTabsClosed\(\);/);
		assert.equal(body.match(/destroyWindowAfterTabsClosed\(/g)?.length, 1, 'no ungated destroy');
	});
});

describe('font family values', () => {
	const viewerSource = readSource(new URL('../src/lib/MarkdownViewer.svelte', import.meta.url));
	const editorOptionsSource = readSource(new URL('../src/lib/utils/editorOptions.ts', import.meta.url));

	test('every place a chosen family reaches CSS goes through the one helper', () => {
		assert.match(viewerSource, /fontFamily: fontFamilyValue\(settings\.previewFont, 'sans-serif'\),/);
		assert.match(viewerSource, /codeFontFamily: fontFamilyValue\(settings\.codeFont, 'monospace'\),/);
		assert.match(editorOptionsSource, /fontFamily: fontFamilyValue\(settings\.editorFont, "monospace"\),/);
		// The absence claim is the point of this one: a second bare interpolation of
		// a font preference is the defect returning, and it cannot be observed by
		// running the helper that does exist.
		assert.doesNotMatch(viewerSource, /font-family: \{settings\./);
		assert.doesNotMatch(viewerSource, /--code-font: \{settings\./);
		assert.doesNotMatch(editorOptionsSource, /fontFamily: settings\./);
	});
});

describe('theme CSS validation', () => {
	test('[P1-C-3] the injected style tag is built only from validated values', () => {
		const source = readSource('src/lib/utils/theme.ts');

		assert.match(source, /const colors = sanitizeThemeColors\(theme\.colors\)/);
		assert.match(
			source,
			/\.filter\(\(\[, v\]\) => isSafeCssColor\(v\)\)/,
			'the final interpolation must re-check each value',
		);
		assert.doesNotMatch(
			source,
			/styleTag\.innerHTML\s*=/,
			'use textContent so the style tag can never be parsed as markup',
		);
	});
});

describe('translation coverage', () => {
	// WHAT THIS FILE COVERS, AND WHY IT EXISTS
	//
	// `t(key: string)` takes a free-form string. Nothing — not tsc, not
	// `svelte-check`, not the rest of this suite — notices when that string names a
	// key no dictionary has, or when a translator files a key one level away from
	// where the code reads it. Both failure modes are silent: `t()` returns the key
	// itself, or falls back to English, and the app ships looking fine to whoever
	// wrote the code in English.
	//
	// Two real bugs motivated this file:
	//   * TitleBar's window-tag editor called `t('common.save')`. No language
	//     defines `common.save`, so the button read literally "common.save" —
	//     in English too.
	//   * 21 languages filed the tag colours under `settings.colors.*` while
	//     Settings.svelte reads `colors.*`. ~190 finished translations sat in the
	//     file and never reached a user.
	//
	// So: (1) every key the source asks for must exist in English, and (2) no
	// language may define a key English does not have. (2) is what catches
	// misfiled translations, because a misfiled key is by construction one English
	// never had.
	//
	// Per-locale completeness is REPORTED, never asserted. 19 locales are missing
	// >100 keys each; failing on that would mean nobody could add an English key
	// without translating it 25 times first.

	const SOURCE_ROOT = 'src';
	const DICTIONARY = 'src/lib/utils/i18n.ts';
	const LOCALES = 'src/lib/locales/';

	const languages = getSupportedLanguages().map((l) => l.code) as LanguageCode[];

	// ---------------------------------------------------------------- dictionary

	function flatten(node: Translation, prefix = ''): Map<string, string> {
		const out = new Map<string, string>();
		for (const [key, value] of Object.entries(node)) {
			const path = prefix ? `${prefix}.${key}` : key;
			if (typeof value === 'string') out.set(path, value);
			else for (const [k, v] of flatten(value, path)) out.set(k, v);
		}
		return out;
	}

	const dictionaries = new Map<LanguageCode, Map<string, string>>(
		languages.map((lang) => [lang, flatten(translations[lang])]),
	);
	const english = dictionaries.get('en')!;

	// ------------------------------------------------------------------- source

	// Prose in a doc comment can mention `t('foo')`. Drop whole comment lines
	// rather than trying to parse comments out of the middle of code — this only
	// ever removes candidates, and no real call site starts a line with `*` or `//`.
	function stripCommentLines(source: string): string {
		return source
			.split('\n')
			.map((line) => {
				const trimmed = line.trimStart();
				const isComment =
					trimmed.startsWith('*') ||
					trimmed.startsWith('//') ||
					trimmed.startsWith('/*') ||
					trimmed.startsWith('<!--');
				return isComment ? '' : line;
			})
			.join('\n');
	}

	/** Index just past the template literal that starts at `i`. */
	function endOfTemplate(src: string, i: number): number {
		i++;
		while (i < src.length) {
			if (src[i] === '\\') i += 2;
			else if (src[i] === '`') return i + 1;
			else if (src[i] === '$' && src[i + 1] === '{') i = endOfInterpolation(src, i + 2);
			else i++;
		}
		return i;
	}

	/** Index just past the `${ … }` whose body starts at `i`. */
	function endOfInterpolation(src: string, i: number): number {
		let depth = 1;
		while (i < src.length && depth > 0) {
			const c = src[i];
			if (c === '{') depth++;
			else if (c === '}') depth--;
			else if (c === '`') { i = endOfTemplate(src, i); continue; }
			else if (c === "'" || c === '"') { i = endOfString(src, i); continue; }
			i++;
		}
		return i;
	}

	/** Index just past the quoted string that starts at `i`. */
	function endOfString(src: string, i: number): number {
		const quote = src[i++];
		while (i < src.length && src[i] !== quote) i += src[i] === '\\' ? 2 : 1;
		return i + 1;
	}

	/** The text of the first argument of the call whose `(` sits at `open`. */
	function firstArgument(src: string, open: number): string {
		const start = open + 1;
		let i = start;
		let depth = 0;
		while (i < src.length) {
			const c = src[i];
			if (c === "'" || c === '"') { i = endOfString(src, i); continue; }
			if (c === '`') { i = endOfTemplate(src, i); continue; }
			if (c === '(' || c === '[' || c === '{') { depth++; i++; continue; }
			if (c === ')' && depth === 0) return src.slice(start, i);
			if (c === ')' || c === ']' || c === '}') { depth--; i++; continue; }
			if (c === ',' && depth === 0) return src.slice(start, i);
			i++;
		}
		return src.slice(start);
	}

	type Reference = { key: string; file: string };

	const staticKeys: Reference[] = [];
	/** `t(`colors.${…}`)` → prefix `colors.`, which no scanner can resolve alone. */
	const dynamicPrefixes = new Map<string, Set<string>>();
	/** `t(someVariable, lang)` — the key is computed elsewhere. */
	const indirectCalls = new Set<string>();
	/** The first argument of every `addToast(…)` call, whitespace-normalised. */
	const toastMessages: { arg: string; file: string }[] = [];

	for (const file of walkSourceFiles(SOURCE_ROOT)) {
		if (file === DICTIONARY || file.startsWith(LOCALES)) continue;
		const src = stripCommentLines(readSource(file));

		// `t(` but not `format(`, `.at(`, `assert(` …
		for (const match of src.matchAll(/(?<![\w$.])t\(/g)) {
			const arg = firstArgument(src, match.index + 1).trim();
			if (arg === '') continue; // `t()` does not type-check; nothing to resolve.
			let i = 0;
			let resolved = false;
			while (i < arg.length) {
				const c = arg[i];
				if (c === "'" || c === '"') {
					const end = endOfString(arg, i);
					staticKeys.push({ key: arg.slice(i + 1, end - 1), file });
					resolved = true;
					i = end;
					continue;
				}
				if (c === '`') {
					const end = endOfTemplate(arg, i);
					const literal = arg.slice(i + 1, end - 1);
					const hole = literal.indexOf('${');
					if (hole === -1) staticKeys.push({ key: literal, file });
					else {
						const prefix = literal.slice(0, hole);
						dynamicPrefixes.set(prefix, (dynamicPrefixes.get(prefix) ?? new Set()).add(file));
					}
					resolved = true;
					i = end;
					continue;
				}
				i++;
			}
			if (!resolved) indirectCalls.add(`${file}: t(${arg.replace(/\s+/g, ' ')})`);
		}

		// Toolbar/menu descriptors carry their key as data and are handed to `t()`
		// through `t(action.labelKey)` or `t(action.hintKey)`. Same exposure,
		// different spelling.
		for (const match of src.matchAll(/\b(?:labelKey|hintKey): '([^']+)'/g)) {
			staticKeys.push({ key: match[1], file });
		}

		// Toast text is the one user-facing string nothing above can see. Every rule
		// in this file is about a key that WAS asked for; a hardcoded English
		// literal handed straight to `addToast()` never asks for one, so it passes
		// every check and then shows English to all 26 locales. (`function addToast`
		// is the declaration, not a call.)
		for (const match of src.matchAll(/(?<!function\s)(?<![\w$.])addToast\(/g)) {
			const arg = firstArgument(src, match.index + 'addToast'.length)
				.trim()
				.replace(/\s+/g, ' ');
			toastMessages.push({ arg, file });
		}
	}

	// ------------------------------------------------ declared dynamic families
	//
	// A template-literal key cannot be resolved by reading the call site, so each
	// family is declared here together with the source of truth that enumerates its
	// members at runtime. The members are re-derived from that source on every run,
	// so adding a swatch colour or an update-dialog string is checked like any
	// other key — this is not an exemption list.

	const DYNAMIC_FAMILIES: Record<string, { file: string; member: RegExp; why: string }> = {
		'colors.': {
			file: 'src/lib/components/Settings.svelte',
			// Settings renders one swatch per `highlightColors` entry and labels it
			// with t(`colors.${color.value}`).
			member: /\{ value: '([a-z]+)', color: /g,
			why: 'the highlight-colour swatch list',
		},
		'update.': {
			file: 'src/lib/components/UpdateDialog.svelte',
			// Every string in the dialog goes through `tk(key)`, i.e. t(`update.${key}`).
			member: /\btk\('([A-Za-z0-9]+)'/g,
			why: 'the update dialog’s tk() call sites',
		},
	};

	// `t(action.labelKey, …)` and `t(action.hintKey, …)`: resolved by the harvest
	// above. Any new unexplained indirection has to be added here consciously.
	//
	// The two shortcut-panel entries are the same shape: the panel renders
	// `t(section.labelKey)` and `t(entry.labelKey)` over `src/lib/utils/shortcuts.ts`,
	// whose rows spell their key as `labelKey: '…'` — so the harvest above already
	// collects every one of them and checks it exists in English like any other key.
	// `scripts/shortcutRegistry.test.ts` additionally measures their per-locale
	// coverage, which this file only reports.
	// ------------------------------------------------- toasts that carry no t()
	//
	// One shape, reached from two call sites (`documentSession`'s and
	// `windowSession`'s `onError`). It is a pass-through, not a message: the words
	// are chosen by the caller in `src/lib/sessions/`, and those callers already
	// pass `t('toast.lossySaveBlocked', …)` and `t('toast.partialSaveBlocked', …)`
	// through it. The remaining raw strings ("Failed to release tab transfer
	// claim") are developer detail printed next to `String(error)` for a bug
	// report; translating them here is impossible anyway, because the scanner
	// cannot see which caller it is looking at. Fix them where they are written.
	const UNTRANSLATED_TOASTS = new Map<string, string>([
		['`${message}: ${String(error)}`', 'the two onError pass-throughs (see src/lib/sessions/)'],
	]);

	const KNOWN_INDIRECT_CALLS = new Set([
		'src/lib/components/EditorToolbar.svelte: t(tool.labelKey)',
		'src/lib/components/Settings.svelte: t(action.hintKey)',
		'src/lib/components/Settings.svelte: t(action.labelKey)',
		'src/lib/components/Settings.svelte: t(entry.hintKey)',
		'src/lib/components/Settings.svelte: t(entry.labelKey)',
		'src/lib/components/Settings.svelte: t(section.labelKey)',
		'src/lib/components/Settings.svelte: t(tool.labelKey)',
		'src/lib/components/Tab.svelte: t(action.labelKey)',
	]);

	// ------------------------------------------------------------------- tests

	test('the scanner actually found the call sites', () => {
		// Guards against the whole file silently passing because a regex stopped
		// matching. Every assertion below is vacuous if this one is wrong.
		assert.ok(staticKeys.length > 250, `found ${staticKeys.length} literal t() keys`);
		assert.ok(english.size > 300, `English defines ${english.size} keys`);
		assert.equal(languages.length, 26);
	});

	test('t() requires a language, so a call site cannot forget one', () => {
		// `lang: LanguageCode = 'en'` made the language optional at ~322 call sites,
		// and 9 of them omitted it — including the window-control aria-labels a
		// screen reader reads out, which said "Close" in all 26 languages. tsc is
		// the real guard now; this asserts the source form so nobody types the
		// default back in and re-opens the hole.
		const signature = /export function t\((.*?)\): string/.exec(readSource('src/lib/utils/i18n.ts'));
		assert.ok(signature, 'the exported t() signature moved; this test can no longer see it');
		assert.equal(
			signature[1],
			'key: string, lang: LanguageCode',
			't() must take the language as a required parameter, with no default',
		);
	});

	test('every key the source asks for exists in English', () => {
		// TitleBar called t('common.save'); en.common has close/minimize/maximize/
		// loadingFullDocument and no save, so the button rendered "common.save".
		const missing = new Map<string, Set<string>>();
		for (const { key, file } of staticKeys) {
			if (english.has(key)) continue;
			missing.set(key, (missing.get(key) ?? new Set()).add(file));
		}
		const report = [...missing]
			.map(([key, files]) => `  ${key}  <- ${[...files].join(', ')}`)
			.join('\n');
		assert.equal(
			missing.size,
			0,
			`t() references ${missing.size} key(s) English does not define; the UI shows the raw key:\n${report}`,
		);
	});

	test('every template-literal key family is declared and resolvable', () => {
		assert.deepEqual(
			[...dynamicPrefixes.keys()].sort(),
			Object.keys(DYNAMIC_FAMILIES).sort(),
			'a t(`prefix.${…}`) call site is undeclared (or a declared one disappeared); ' +
				'declare it in DYNAMIC_FAMILIES together with whatever enumerates its members',
		);

		for (const [prefix, { file, member, why }] of Object.entries(DYNAMIC_FAMILIES)) {
			const source = readSource(file);
			// A member may legitimately appear at several call sites (`tk('close')`),
			// so this is a set, not a list.
			const members = new Set([...source.matchAll(member)].map((m) => m[1]));
			assert.ok(members.size > 0, `${why} in ${file} no longer matches its pattern`);

			for (const name of members) {
				assert.ok(
					english.has(`${prefix}${name}`),
					`${prefix}${name} is rendered from ${why} but English does not define it`,
				);
			}
		}
	});

	test('t() never echoes a key back for a reachable string', () => {
		// The end-to-end statement of both bugs, expressed through t() itself
		// rather than through the tables.
		const reachable = new Set(staticKeys.map((r) => r.key));
		for (const [prefix, { file, member }] of Object.entries(DYNAMIC_FAMILIES)) {
			const source = readSource(file);
			for (const m of source.matchAll(member)) reachable.add(`${prefix}${m[1]}`);
		}
		for (const key of reachable) {
			for (const lang of languages) {
				const value = t(key, lang);
				assert.notEqual(value, key, `t('${key}', '${lang}') renders the key itself`);
				assert.ok(value.length > 0, `t('${key}', '${lang}') is empty`);
			}
		}
	});

	test('every t() call resolves to a literal, a declared family, or a known indirection', () => {
		assert.deepEqual(
			[...indirectCalls].sort(),
			[...KNOWN_INDIRECT_CALLS].sort(),
			'a t() call takes a key this scanner cannot see; either give it a literal ' +
				'or add it here after making sure the key is checked some other way',
		);
	});

	test('every toast message goes through t()', () => {
		// The gap this closes: `addToast('Reloaded from disk', 'info')` satisfies
		// every rule above by asking for nothing. Eleven of these shipped in
		// MarkdownViewer.svelte, two of them inside `exportAsHtml`, whose next
		// statement already read `t('modal.openExportedFileTitle', …)`.
		//
		// The rule is stated over the whole argument rather than over "is it a
		// string literal", because `` `Failed to open ${path}` `` is the same defect
		// spelled as a template. Anything that is not visibly built from t() has to
		// be justified below.
		assert.ok(toastMessages.length > 25, `found ${toastMessages.length} addToast() call sites`);

		const untranslated = toastMessages.filter(({ arg }) => !/(?<![\w$.])t\(/.test(arg));
		const unexpected = untranslated.filter(({ arg }) => !UNTRANSLATED_TOASTS.has(arg));
		assert.deepEqual(
			unexpected.map(({ arg, file }) => `${file}: addToast(${arg})`),
			[],
			'a toast shows text that never went through t(); it will read English in all 26 languages',
		);

		// The pin must not rot: a shape that got translated has to leave the list.
		for (const [arg] of UNTRANSLATED_TOASTS) {
			assert.ok(
				untranslated.some((toast) => toast.arg === arg),
				`addToast(${arg}) no longer exists — drop it from UNTRANSLATED_TOASTS`,
			);
		}
	});

	// ------------------------------------------- one label per control, per pane
	//
	// The preview pane shipped four controls under two labels. `preview-font` and
	// `code-font` both read `t('settings.font')`, `preview-font-size` and
	// `code-font-size` both read `t('settings.fontSize')`, so the pane rendered
	//
	//     Font       [ Helvetica Neue (Default) ]
	//     Font Size  [− 16 +]
	//     Font       [ Menlo (Default) ]
	//     Font Size  [− 14 +]
	//
	// and nothing on screen said which pair was the prose font and which the code
	// font. The `id` attributes knew; the user could not.
	//
	// Nothing in the suite could see it. Every rule above is about a key existing
	// and resolving — two controls pointed at the SAME existing, correctly
	// resolving key satisfies all of them. So this reads the controls out of the
	// component and compares what a user would actually see, in each language:
	// two controls in one pane may not render the same words. Spelling the check
	// against `t()` output rather than against the key names is the point — a
	// future locale that translates two distinct keys to one string is the same
	// defect and fails here too.

	const SETTINGS = 'src/lib/components/Settings.svelte';

	type LabelledControl = { pane: string; id: string; key: string };

	/**
	 * Every `<label for="…">{t('…')}</label>` in Settings.svelte, tagged with the
	 * `{#if activeCategory === '…'}` branch it renders in.
	 *
	 * Read from the parsed component rather than by matching text: the panes are a
	 * `{:else if}` chain, so "which pane is this row in" is a question about tree
	 * position that no regex over the file can answer.
	 */
	function labelledControls(): LabelledControl[] {
		const source = readSource(SETTINGS);
		const ast = parse(source, { modern: true, filename: SETTINGS }) as Record<string, any>;
		const found: LabelledControl[] = [];

		const visit = (node: unknown, pane: string | null): void => {
			if (Array.isArray(node)) {
				for (const child of node) visit(child, pane);
				return;
			}
			if (!node || typeof node !== 'object') return;
			const current = node as Record<string, any>;

			if (current.type === 'IfBlock' && current.test) {
				const category = source
					.slice(current.test.start, current.test.end)
					.match(/activeCategory === '([a-z]+)'/);
				if (category) {
					// The consequent is that pane; the `{:else if}` chain in the
					// alternate names its own.
					visit(current.consequent, category[1]);
					visit(current.alternate, pane);
					return;
				}
			}

			if (current.type === 'RegularElement' && current.name === 'label') {
				const forAttribute = (current.attributes ?? []).find(
					(attribute: Record<string, any>) => attribute.type === 'Attribute' && attribute.name === 'for',
				);
				const id = forAttribute?.value?.[0]?.type === 'Text' ? String(forAttribute.value[0].data) : null;
				for (const child of current.fragment?.nodes ?? []) {
					const call = child.type === 'ExpressionTag' ? child.expression : null;
					if (call?.type !== 'CallExpression' || call.callee?.name !== 't') continue;
					const key = call.arguments?.[0];
					if (key?.type !== 'Literal' || typeof key.value !== 'string') continue;
					assert.ok(id, `a t() label in ${SETTINGS} has no "for" attribute to name its control`);
					assert.ok(pane, `${id} is labelled outside any activeCategory branch`);
					found.push({ pane: pane!, id: id!, key: key.value });
				}
			}

			for (const [name, value] of Object.entries(current)) {
				if (name === 'parent' || name === 'metadata') continue;
				visit(value, pane);
			}
		};

		visit(ast.fragment, null);
		return found;
	}

	const settingsControls = labelledControls();

	test('the settings panes were actually read', () => {
		// Every assertion below is vacuous if the walk found nothing, and the one
		// that matters is vacuous if it stopped finding the preview pane.
		const panes = new Set(settingsControls.map((control) => control.pane));
		assert.deepEqual([...panes].sort(), ['appearance', 'editor', 'files', 'preview']);
		assert.ok(settingsControls.length > 25, `found ${settingsControls.length} labelled controls`);

		const preview = settingsControls.filter((control) => control.pane === 'preview').map((c) => c.id);
		assert.deepEqual(preview.sort(), [
			'code-font',
			'code-font-size',
			'preview-annotations',
			'preview-cursor',
			'preview-font',
			'preview-font-size',
			'preview-max-width',
			'preview-newline-breaks',
			'preview-occurrences',
			'preview-table-breakout',
			'preview-table-scroll',
		]);
	});

	test('no two controls in one settings pane carry the same label, in any language', () => {
		const collisions: string[] = [];

		for (const pane of new Set(settingsControls.map((control) => control.pane))) {
			const controls = settingsControls.filter((control) => control.pane === pane);
			for (const lang of languages) {
				const seen = new Map<string, string>();
				for (const { id, key } of controls) {
					const label = t(key, lang);
					const owner = seen.get(label);
					if (owner) collisions.push(`${lang} ${pane}: ${owner} and ${id} both read "${label}"`);
					else seen.set(label, id);
				}
			}
		}

		assert.deepEqual(collisions, []);
	});
});
