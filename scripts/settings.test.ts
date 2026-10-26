import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { DEFAULT_AUTO_SAVE, resolveAutoSave } from '../src/lib/utils/autoSaveSetting.js';
import { fontFamilyValue } from '../src/lib/utils/fontFamily.js';
import { editorOptionsFromSettings } from '../src/lib/utils/editorOptions.js';
import { previewAppearanceFrom } from '../src/lib/utils/previewLayout.js';
import { getSupportedLanguages, type LanguageCode, t, type Translation } from '../src/lib/utils/i18n.js';
import { isHexColor, isSafeCssColor, sanitizeThemeColors } from '../src/lib/utils/theme.js';
import { translations } from './allTranslations.js';

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
	/* ------------------------------------------------- A: one save preference */

	test('every old combination keeps the behaviour it already had', () => {
		// The expression the whole app used to evaluate, one row per combination.
		//        autoSave  confirmBeforeSave        silently saves?
		assert.equal(resolveAutoSave(null, 'true', 'false'), true);
		assert.equal(resolveAutoSave(null, 'true', 'true'), false); // the contradictory one
		assert.equal(resolveAutoSave(null, 'false', 'false'), false);
		assert.equal(resolveAutoSave(null, 'false', 'true'), false);
	});

	test('an install that never touched either switch keeps the default', () => {
		assert.equal(resolveAutoSave(null, null, null), DEFAULT_AUTO_SAVE);
		assert.equal(DEFAULT_AUTO_SAVE, true);
		// Auto-save on by default, so an absent `confirmBeforeSave` must not read
		// as "confirm" and silently turn saving off for everybody.
		assert.equal(resolveAutoSave(null, null, 'false'), true);
		assert.equal(resolveAutoSave(null, null, 'true'), false);
	});

	test('the old pair stops being consulted once the merged key exists', () => {
		// Otherwise a reader who upgrades with both switches on, then turns
		// auto-save back on, has the stale veto disable it again on next launch.
		assert.equal(resolveAutoSave('true', 'true', 'true'), true);
		assert.equal(resolveAutoSave('false', 'true', 'false'), false);
	});
});

describe('font family values', () => {
	// The names in this test are the failure, not a sample of exotic input: each
	// one is a real family that the settings dropdown offered and that selecting
	// did nothing at all for, because bare interpolation made the declaration
	// invalid and the browser dropped it whole. Measured in a WKWebView with the
	// parent element at `40px Courier`: `M+ 1c`, `04b03`, `Gill Sans (Body)` and
	// `Helvetica!` each computed to `Courier` at an identical width, while
	// `Helvetica` in the same shape rendered. See #810.
	test('a family name is quoted, whatever characters it carries', () => {
		assert.equal(fontFamilyValue('Lato', 'sans-serif'), '"Lato", sans-serif');
		assert.equal(fontFamilyValue('M+ 1c', 'sans-serif'), '"M+ 1c", sans-serif');
		assert.equal(fontFamilyValue('04b03', 'sans-serif'), '"04b03", sans-serif');
		assert.equal(fontFamilyValue('Gill Sans (Body)', 'sans-serif'), '"Gill Sans (Body)", sans-serif');
		assert.equal(fontFamilyValue('Helvetica!', 'sans-serif'), '"Helvetica!", sans-serif');
	});

	test('quotes and backslashes in a name cannot end the string early', () => {
		assert.equal(fontFamilyValue('Say "Hi"', 'sans-serif'), '"Say \\"Hi\\"", sans-serif');
		assert.equal(fontFamilyValue('back\\slash', 'sans-serif'), '"back\\\\slash", sans-serif');
		// A family name reaches this from localStorage, which any window can write,
		// so the value has to be unable to close the string and open a declaration
		// of its own.
		assert.equal(fontFamilyValue('x"; color: red; font-family: "y', 'sans-serif'), '"x\\"; color: red; font-family: \\"y", sans-serif');
	});

	test('generic families stay unquoted, which is what keeps the Linux defaults working', () => {
		// `defaultFontsFor('linux')` picks `Monospace` and `system-ui`. Quoted, both
		// become a request for a family nobody has; CSS keywords are
		// case-insensitive, so `Monospace` is the generic.
		assert.equal(fontFamilyValue('Monospace', 'monospace'), 'Monospace, monospace');
		assert.equal(fontFamilyValue('system-ui', 'sans-serif'), 'system-ui, sans-serif');
		assert.equal(fontFamilyValue('ui-rounded', 'sans-serif'), 'ui-rounded, sans-serif');
	});

	test('the generics table holds the grammar and nothing that only looks like it', () => {
		// `generic(fangsong)` is how CSS Fonts 4 §2.1.2 spells the script-specific
		// generics, so the bare word is an ordinary family name — and macOS ships two
		// real ones. Exempting it would emit a user's 仿宋 face unquoted, which an
		// engine that does treat the bare word as a keyword resolves to a generic.
		assert.equal(fontFamilyValue('FangSong', 'serif'), '"FangSong", serif');
		assert.equal(fontFamilyValue('fangsong', 'serif'), '"fangsong", serif');
		assert.equal(fontFamilyValue('emoji', 'sans-serif'), '"emoji", sans-serif');
		// The other direction, and the one that must never be "fixed" by adding an
		// entry: §2.1.1 requires a family named after a CSS-wide keyword to be
		// quoted. Measured in a WKWebView, `font-family: inherit, serif` and
		// `font-family: default, serif` are rejected outright, while the quoted form
		// is accepted.
		for (const reserved of ['inherit', 'initial', 'unset', 'revert', 'revert-layer', 'default']) {
			assert.equal(fontFamilyValue(reserved, 'serif'), `"${reserved}", serif`);
		}
	});

	test('a blank preference is the fallback alone, not a leading comma', () => {
		// `stringSetting` applies any non-null raw value, so an empty `preview.font`
		// key lands as an empty family. Interpolated bare it produced
		// `font-family: , sans-serif` — invalid, and dropped like the rest.
		assert.equal(fontFamilyValue('', 'sans-serif'), 'sans-serif');
		assert.equal(fontFamilyValue('   ', 'monospace'), 'monospace');
		assert.equal(fontFamilyValue('  Lato  ', 'sans-serif'), '"Lato", sans-serif');
	});

	test('a chosen family reaches the preview, its code and the editor quoted', () => {
		const hostile = 'x"; color: red; font-family: "y';
		const quoted = '"x\\"; color: red; font-family: \\"y"';
		const appearance = previewAppearanceFrom({
			previewFont: hostile,
			previewFontSize: 16,
			codeFont: 'Gill Sans (Body)',
			codeFontSize: 14,
			highlightColor: 'yellow',
		});
		assert.equal(appearance.fontFamily, `${quoted}, sans-serif`);
		assert.equal(appearance.codeFontFamily, '"Gill Sans (Body)", monospace');

		const editor = editorOptionsFromSettings(
			{
				minimap: false,
				stickyScroll: true,
				wordWrap: 'on',
				editorMaxWidth: 80,
				lineNumbers: 'on',
				renderLineHighlight: 'line',
				occurrencesHighlight: false,
				editorFontSize: 14,
				editorFont: 'M+ 1c',
				animateJumpScroll: false,
				animateCursor: false,
				showWhitespace: false,
				typewriterMode: false,
			},
			100,
		);
		assert.equal(editor.fontFamily, '"M+ 1c", monospace');
	});
});

describe('theme CSS validation', () => {
	// P1-C-3: an imported VS Code theme's colour values are interpolated into a
	// global <style> block that is replayed on every launch (the theme name is
	// persisted in theme.txt), so an unvalidated value is a permanent UI takeover
	// that can only be undone by deleting the config file by hand.

	const injectionPoc = '#fff; } * { display:none; background-image:url(https://evil.tld/beacon) } :root {';

	test('[P1-C-3] the theme.json injection PoC is rejected', () => {
		assert.equal(isSafeCssColor(injectionPoc), false);

		const safe = sanitizeThemeColors({
			'editor.background': injectionPoc,
			'editor.foreground': '#d4d4d4',
		});

		assert.deepEqual(safe, { 'editor.foreground': '#d4d4d4' });
		assert.equal(Object.prototype.hasOwnProperty.call(safe, 'editor.background'), false);
	});

	test('[P1-C-3] every shape that can escape a declaration block is rejected', () => {
		for (const value of [
			injectionPoc,
			'#fff;}*{display:none',
			'red; }',
			'url(https://evil.tld/beacon)',
			'#fff /* } */',
			'var(--x)',
			'expression(alert(1))',
			'#fff\n}',
			'#ggg',
			'#12345',
			'rgb(0,0,0);}',
			'rgba(0,0,0,0) !important',
			'',
			'   ',
			'#'.repeat(200),
		]) {
			assert.equal(isSafeCssColor(value), false, `must reject ${JSON.stringify(value)}`);
		}

		for (const value of [null, undefined, 42, {}, [], true]) {
			assert.equal(isSafeCssColor(value), false, `must reject ${String(value)}`);
		}
	});

	test('[P1-C-3] real VS Code theme colour values still pass', () => {
		for (const value of [
			'#fff',
			'#FFFA',
			'#1e1e1e',
			'#1E1E1EFF',
			'rgb(30, 30, 30)',
			'rgba(255, 255, 255, 0.1)',
			'rgba(0,0,0,.35)',
			'rgb(0 0 0 / 50%)',
			'transparent',
			'Black',
		]) {
			assert.equal(isSafeCssColor(value), true, `must allow ${value}`);
		}
	});

	test('[P1-C-3] Monaco only receives hex colours', () => {
		assert.equal(isHexColor('#1e1e1e'), true);
		assert.equal(isHexColor('#1e1e1eff'), true);
		assert.equal(isHexColor('rgba(0, 0, 0, 0.1)'), false);
		assert.equal(isHexColor('transparent'), false);
		assert.equal(isHexColor(injectionPoc), false);
	});

	test('[P1-C-3] sanitizeThemeColors survives a hostile theme.json shape', () => {
		assert.deepEqual(sanitizeThemeColors(null), {});
		assert.deepEqual(sanitizeThemeColors(undefined), {});
		assert.deepEqual(sanitizeThemeColors('#fff'), {});
		assert.deepEqual(
			sanitizeThemeColors({ a: '  #fff  ', b: 12, c: { toString: () => '#fff' }, d: ['#fff'] }),
			{ a: '#fff' },
		);
	});
});

describe('translation coverage', () => {
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

	test('no language defines a key English does not have', () => {
		// A translation filed one level away from where the code reads it is
		// invisible: `settings.colors.blue` can never be reached by t('colors.blue').
		// Since every reachable key must exist in English, "exists somewhere but not
		// in English" is exactly the set of unreachable translations.
		const orphans = new Map<string, string[]>();
		for (const lang of languages) {
			if (lang === 'en') continue;
			for (const key of dictionaries.get(lang)!.keys()) {
				if (english.has(key)) continue;
				orphans.set(key, [...(orphans.get(key) ?? []), lang]);
			}
		}

		assert.equal(
			orphans.size,
			0,
			`translations that no code path can reach (present in a locale, absent in English):\n${[...orphans]
				.map(([key, langs]) => `  ${key}  [${langs.length}] ${langs.join(', ')}`)
				.join('\n')}`,
		);
	});

	test('the tag-colour names reach the UI in every language', () => {
		// The regression pin for the misfiled block: English fallback would keep the
		// previous test green, so require each locale to own the block outright.
		const colourNames = Object.keys(translations.en.colors as Translation);
		assert.ok(colourNames.length >= 9, 'English still defines the colour block');

		for (const lang of languages) {
			const own = dictionaries.get(lang)!;
			for (const name of colourNames) {
				assert.ok(own.has(`colors.${name}`), `${lang} defines colors.${name} at the top level`);
				assert.ok(!own.has(`settings.colors.${name}`), `${lang} no longer hides it under settings.*`);
			}
		}
	});

	// The two tests below import the dictionary and look keys up in it. They are the only thing in the suite that fails when
	// a *specific locale* silently falls back to English. The general rules above
	// cannot see that — (1) only requires the key in English, and per-locale
	// completeness is reported rather than enforced. These keys are the exception
	// to that leniency because they label controls whose meaning is carried by the
	// word alone: an untranslated "Move Up" on an icon button is unusable, not
	// merely unpolished.

	/** The value `lang` itself defines for `key`, ignoring the English fallback. */
	function directTranslation(lang: LanguageCode, key: string): string | undefined {
		return dictionaries.get(lang)!.get(key);
	}

	test('interactive button labels are directly translated for every supported language', () => {
		const interactiveLabelKeys = [
			'common.close',
			'common.decrease',
			'common.increase',
			'toc.resizeTableOfContents',
			'settings.move',
			'settings.moveUp',
			'settings.moveDown',
			'settings.resetToolbar',
			'settings.toolbarOnBar',
			'settings.toolbarInMenu',
			'settings.resizeWindow',
		];

		const missing = languages.flatMap((lang) =>
			interactiveLabelKeys
				.filter((key) => directTranslation(lang, key) === undefined)
				.map((key) => `${lang}:${key}`),
		);

		assert.deepEqual(missing, []);
	});

	test('Simplified Chinese directly translates the window organization labels', () => {
		const keys = [
			'menu.moveToWindow', 'menu.window', 'menu.mergeAllWindows', 'menu.setWindowTag',
			'menu.windowTagPlaceholder', 'menu.windowTagClear', 'menu.pinWindowTag',
			'menu.unpinWindowTag', 'toast.noOtherWindows', 'home.pinnedTags', 'home.pinnedFileCount',
		];

		assert.deepEqual(keys.filter((key) => directTranslation('zh-CN', key) === undefined), []);
	});

	test('per-locale completeness (reported, never enforced)', () => {
		// A worklist for translators, not a gate. Adding an English key must not
		// turn 25 locales red.
		const rows = languages
			.filter((lang) => lang !== 'en')
			.map((lang) => {
				const own = dictionaries.get(lang)!;
				const missing = [...english.keys()].filter((key) => !own.has(key));
				return { lang, missing: missing.length };
			})
			.sort((a, b) => b.missing - a.missing);

		const total = rows.reduce((sum, row) => sum + row.missing, 0);
		console.log(`\n  i18n coverage — ${english.size} English keys, 25 other locales`);
		for (const { lang, missing } of rows) {
			const pct = (((english.size - missing) / english.size) * 100).toFixed(1);
			console.log(`    ${lang.padEnd(6)} ${String(english.size - missing).padStart(3)}/${english.size}  ${pct.padStart(5)}%  ${missing} missing`);
		}
		console.log(`    ${'total'.padEnd(6)} ${total} untranslated key-slots (falling back to English)\n`);

		// No assertion, deliberately. `total` is a sum of array lengths, so the
		// `assert.ok(total >= 0)` that used to close this block was true for every
		// possible dictionary — it read as a gate while enforcing nothing. The gates
		// are the two tests above: every key the source asks for exists in English,
		// and no language defines a key English does not have. Completeness per
		// locale stays a worklist.
	});
});
