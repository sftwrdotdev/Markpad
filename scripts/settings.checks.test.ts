import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { readSource, walkSourceFiles } from './sourceTree.js';

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
 * gate, plus the layout rule that the prerequisite is the row above. Both run
 * on the pane data: settings.spec.ts "settings panes".
 */
describe('merged auto-save preference', () => {
	const settingsSource = readSource(new URL('../src/lib/stores/settings.svelte.ts', import.meta.url));

	test('the merged preference is stored under its own key, and the old ones are read-only', () => {
		assert.match(settingsSource, /key: 'editor\.autoSaveEdits'/);
		assert.match(settingsSource, /const LEGACY_AUTO_SAVE_KEY = 'editor\.autoSave'/);
		assert.match(settingsSource, /const LEGACY_CONFIRM_BEFORE_SAVE_KEY = 'editor\.confirmBeforeSave'/);
		// A rollback finds both of the old keys where it left them.
		assert.doesNotMatch(settingsSource, /key: 'editor\.autoSave'/);
		assert.doesNotMatch(settingsSource, /key: 'editor\.confirmBeforeSave'/);
	});
});

describe('font family values', () => {
	const viewerSource = readSource(new URL('../src/lib/MarkdownViewer.svelte', import.meta.url));
	const editorOptionsSource = readSource(new URL('../src/lib/utils/editorOptions.ts', import.meta.url));

	test('no font preference reaches CSS bare', () => {
		// The values are settings.test.ts "a chosen family reaches the preview, its
		// code and the editor quoted". This is the absence claim: a second bare
		// interpolation of a font preference is the defect returning.
		assert.doesNotMatch(viewerSource, /font-family: \{settings\./);
		assert.doesNotMatch(viewerSource, /--code-font: \{settings\./);
		assert.doesNotMatch(editorOptionsSource, /fontFamily: settings\./);
	});
});

describe('theme CSS validation', () => {
	// The validation itself is run in settings.themeLoad.spec.ts. What stays here is
	// the convention that the tag is never assigned as markup (lint-candidate).
	test('the theme style tag is filled as text, never as markup', () => {
		const source = readSource('src/lib/utils/theme.ts');

		assert.doesNotMatch(
			source,
			/styleTag\.innerHTML\s*=/,
			'use textContent so the style tag can never be parsed as markup',
		);
	});
});

describe('translation coverage', () => {
	// Keys are typed now: `t(key: TranslationKey, lang)` takes only a dotted path
	// that English defines, so a missing key, an unresolvable template-literal
	// family and a free-form `string` key are all tsc errors (`npm run check`).
	// What is left here are the two lint candidates: the `t()` signature and
	// toasts that never go through `t()`.

	const SOURCE_ROOT = 'src';
	const DICTIONARY = 'src/lib/utils/i18n.ts';
	const LOCALES = 'src/lib/locales/';

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

	/** The first argument of every `addToast(…)` call, whitespace-normalised. */
	const toastMessages: { arg: string; file: string }[] = [];

	for (const file of walkSourceFiles(SOURCE_ROOT)) {
		if (file === DICTIONARY || file.startsWith(LOCALES)) continue;
		const src = stripCommentLines(readSource(file));

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

	// ------------------------------------------------------------------- tests

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
			'key: TranslationKey, lang: LanguageCode',
			't() must take the language as a required parameter, with no default',
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
});
