import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { containsUnusualLineTerminators } from 'monaco-editor/esm/vs/base/common/strings.js';
import { EditorOptions, inUntrustedWorkspace, type UnicodeHighlightOptions } from 'monaco-editor/esm/vs/editor/common/config/editorOptions.js';
import { type UnicodeHighlightResult, UnicodeTextModelHighlighter } from 'monaco-editor/esm/vs/editor/common/services/unicodeTextModelHighlighter.js';
import { parseTokenTheme, TokenTheme } from 'monaco-editor/esm/vs/editor/common/languages/supports/tokenization.js';
import { compile } from 'monaco-editor/esm/vs/editor/standalone/common/monarch/monarchCompile.js';
import { MonarchTokenizer } from 'monaco-editor/esm/vs/editor/standalone/common/monarch/monarchLexer.js';
import { getMapForWordSeparators } from 'monaco-editor/esm/vs/editor/common/core/wordCharacterClassifier.js';
// Monaco's own default — the editor does not set `wordSeparators`, so this is
// what the classifier is built with in the app.
import { USUAL_WORD_SEPARATORS } from 'monaco-editor/esm/vs/editor/common/core/wordHelper.js';
import { language as markdownLanguage } from 'monaco-editor/esm/vs/basic-languages/markdown/markdown.js';

import { getSupportedLanguages, type LanguageCode, t, type Translation } from '../src/lib/utils/i18n.js';
import { translations } from './allTranslations.js';
import { editorLanguageFor } from '../src/lib/utils/editorLanguage.js';
import { MARKDOWN_LINK_EXTENSIONS } from '../src/lib/utils/markdownLinks.js';
import { createdEditorOptions, editorOptionsFromSettings, editorReadOnly, updatedEditorOptions } from '../src/lib/utils/editorOptions.js';
import { markdownTokenRules, monacoThemeName, semanticTokenRules } from '../src/lib/utils/editorTheme.js';
import { importedThemeRules, MARKDOWN_SCOPE_ALIASES, markdownKindColors, monacoTokenRules } from '../src/lib/utils/theme.js';
import { encodeSemanticTokens, TOKEN_MODIFIERS, TOKEN_TYPES } from '../src/lib/utils/semanticTokens.js';
import { resolveExportImagePath } from '../src/lib/utils/exportHtml.js';
import { DEFAULT_IMAGE_DIRECTORY, documentParentDir, encodeImageDestination, imageEmbed, resolveImageDirectory } from '../src/lib/utils/imageEmbed.js';
import { resolveDocumentRelativePath } from '../src/lib/utils/markdown.js';
import { buildPasteProbe, findTokenAtOffset, getFrontMatterLineCount, isCodeToken, isInFrontMatter, type PasteContextToken, shouldLinkifyPastedUrl } from '../src/lib/utils/pasteContext.js';
import { paragraphAround } from '../src/lib/utils/focusParagraph.js';

// WHAT THIS FILE COVERS, AND WHAT IT DOES NOT
//
// Covered for real: the translation table. `t()` is imported and called, so the
// key-exists / falls-back / distinct-label assertions are genuine behaviour.
//
// Not covered: Monaco's runtime. Editor.svelte is a Svelte component and cannot
// be imported here, so "the context menu is rebuilt when the language changes"
// and "no action id is registered twice" are pinned by reading the component's
// source. Those assertions prove the code is *written* that way, not that
// Monaco behaves that way when the effect re-runs — verifying that needs a
// running editor.
describe('context menu labels', () => {
	const supported = getSupportedLanguages().map((l) => l.code);

	/**
	 * Does `lang`'s own dictionary define `key`, without the English fallback?
	 *
	 * `t()` falls back to English, so `assert.notEqual(t(key, lang), key)` can only
	 * fail when ENGLISH lacks the key — which each caller below already asserts one
	 * line earlier. The 26-language loop around it restated that 26 times and could
	 * not see the regression it was written for: deleting the German
	 * `menu.inlineCode` entry left the whole suite green while the German context
	 * menu rendered the English label.
	 *
	 * These labels are held to a stricter bar than the dictionary at large.
	 * i18nCoverage.test.ts reports per-locale gaps rather than failing on them,
	 * because 19 locales are missing >100 keys and nobody should have to translate
	 * a new English string 25 times before landing it. That trade does not apply
	 * here: this is a fixed list of a dozen context-menu entries, all 26 languages
	 * define all of them today, and adding an eleventh action means adding a row to
	 * FORMATTING_ACTIONS by hand — so the cost is visible where it is incurred.
	 */
	function defines(lang: LanguageCode, key: string): boolean {
		let node: string | Translation | undefined = translations[lang];
		for (const part of key.split('.')) {
			if (typeof node !== 'object' || node === null || !(part in node)) return false;
			node = node[part];
		}
		return typeof node === 'string';
	}

	// The markdown formatting entries that used to be English string literals.
	const FORMATTING_ACTIONS: ReadonlyArray<[actionId: string, key: string, englishLabel: string]> = [
		['fmt-strikethrough', 'menu.strikethrough', 'Strikethrough'],
		['fmt-inline-code', 'menu.inlineCode', 'Inline Code'],
		['fmt-code-block', 'menu.codeBlock', 'Code Block'],
		['fmt-quote', 'menu.quote', 'Quote'],
		['fmt-heading-1', 'menu.heading1', 'Heading 1'],
		['fmt-heading-2', 'menu.heading2', 'Heading 2'],
		['fmt-heading-3', 'menu.heading3', 'Heading 3'],
		['fmt-bullet-list', 'menu.bulletList', 'Bullet List'],
		['fmt-numbered-list', 'menu.numberedList', 'Numbered List'],
		['fmt-checklist', 'menu.checklist', 'Checklist'],
		['fmt-link', 'menu.link', 'Link'],
	];

	test('the formatting labels exist in English and are translated in every language', () => {
		for (const [, key, englishLabel] of FORMATTING_ACTIONS) {
			assert.equal(t(key, 'en'), englishLabel, `${key} is defined for English`);
			for (const lang of supported) {
				// `defines`, not `t(...) !== key` — see the note on the helper.
				assert.ok(
					defines(lang as LanguageCode, key),
					`${key} is translated for ${lang}; it currently falls back to the English label`,
				);
				assert.ok(t(key, lang as LanguageCode).length > 0, `${key} is non-empty for ${lang}`);
			}
		}
	});
});

describe('editor language', () => {
	test('every extension the preview renders as Markdown is edited as Markdown', () => {
		// The editor kept its own copy of the list, without `txt`: a `.txt` note
		// rendered as Markdown in the preview and showed as plain text in the editor.
		for (const ext of MARKDOWN_LINK_EXTENSIONS) {
			assert.equal(editorLanguageFor(`/notes/a.${ext}`), 'markdown', ext);
			assert.equal(editorLanguageFor(`/notes/a.${ext.toUpperCase()}`), 'markdown', ext);
		}
	});

	test('other files keep their own grammar, and an untitled buffer is Markdown', () => {
		assert.equal(editorLanguageFor(''), 'markdown');
		assert.equal(editorLanguageFor('/src/a.ts'), 'typescript');
		assert.equal(editorLanguageFor('/var/app.log'), 'plaintext');
		assert.equal(editorLanguageFor('/notes/constructor'), 'plaintext');
	});
});

// Editor.svelte translates the settings store into Monaco options and
// keybindings. Every regression locked here came from that translation layer
// being wired to the wrong shape: a string option read as a boolean, a
// modifier that macOS never delivers, one key bound twice, and a native
// behaviour dropped by the action that replaced it.
describe('editor options', () => {
	/** A settled settings store, so each test names only the field it is about. */
	const SETTINGS = {
		minimap: false,
		wordWrap: 'on',
		editorMaxWidth: 80,
		lineNumbers: 'on',
		renderLineHighlight: 'line',
		occurrencesHighlight: false,
		editorFontSize: 14,
		editorFont: 'Menlo',
		showWhitespace: false,
		animateJumpScroll: true,
		animateCursor: true,
		typewriterMode: false,
	};

	test('the caret glide is a setting and not a hard-coded on', () => {
		// It was `cursorSmoothCaretAnimation: 'on'` in the creation literal (#710),
		// which is why the assertion below is about `editorOptionsFromSettings` and
		// not about the literal: being in the shared options is what makes the
		// toggle reach the editor that is already open, through `updateOptions`.
		assert.equal(editorOptionsFromSettings(SETTINGS, 100).cursorSmoothCaretAnimation, 'on');
		assert.equal(
			editorOptionsFromSettings({ ...SETTINGS, animateCursor: false }, 100)
				.cursorSmoothCaretAnimation,
			'off',
		);

		// And it is its own preference: turning off the animated jump must not take
		// the caret glide with it.
		assert.equal(
			editorOptionsFromSettings({ ...SETTINGS, animateJumpScroll: false }, 100)
				.cursorSmoothCaretAnimation,
			'on',
		);
	});

	test('the editor animates a jump on the same preference the preview does', () => {
		// Monaco's `smoothScrolling` animates the scroll when the editor is sent to
		// a position — a find match, a go-to-line, the scroll sync. The preview
		// animates the same jump, so one preference answers both rather than the
		// two panes each having their own.
		assert.equal(editorOptionsFromSettings(SETTINGS, 100).smoothScrolling, true);
		assert.equal(
			editorOptionsFromSettings({ ...SETTINGS, animateJumpScroll: false }, 100).smoothScrolling,
			false,
		);
	});

	/**
	 * Monaco's shipped defaults with the component's option merged over them.
	 *
	 * `?? {}` models the real absence case rather than guarding: a component that
	 * passes no `unicodeHighlight` gets Monaco's defaults, which is the state this
	 * whole section exists to move away from. Without it, deleting the option from
	 * Editor.svelte fails the tests below with a TypeError raised inside Monaco
	 * instead of the assertion naming the characters that came back.
	 */
	function effectiveUnicodeHighlight(passed: unknown): UnicodeHighlightOptions {
		const option = EditorOptions.unicodeHighlight;
		// A copy: Monaco's `applyUpdate` merges in place unless the update carries
		// `allowedCharacters`, and the shipped defaults are one shared object.
		return option.applyUpdate(structuredClone(option.defaultValue), passed ?? {}).newValue;
	}

	/**
	 * What Monaco would outline in `lines`, given an effective option set.
	 *
	 * Mirrors `resolveOptions()` in unicodeHighlighter.ts, which is not exported.
	 * `trusted` is true because that is what standalone Monaco reports —
	 * `StandaloneWorkspaceTrustManagementService.isWorkspaceTrusted()` returns true
	 * unconditionally. That is why `nonBasicASCII`, whose default is the
	 * `inUntrustedWorkspace` sentinel, is already off and needs no setting in
	 * Editor.svelte: it resolves through `!trusted`.
	 */
	function outlined(lines: string[], effective: UnicodeHighlightOptions): UnicodeHighlightResult {
		const trusted = true;
		const through = (value: boolean | 'inUntrustedWorkspace') =>
			value === inUntrustedWorkspace ? !trusted : value;
		return UnicodeTextModelHighlighter.computeUnicodeHighlights(
			{ getLineCount: () => lines.length, getLineContent: (n: number) => lines[n - 1] },
			{
				nonBasicASCII: through(effective.nonBasicASCII),
				ambiguousCharacters: effective.ambiguousCharacters,
				invisibleCharacters: effective.invisibleCharacters,
				includeComments: through(effective.includeComments),
				includeStrings: through(effective.includeStrings),
				allowedCodePoints: Object.keys(effective.allowedCharacters).map((c) => c.codePointAt(0)),
				// The real value is derived from the OS locale and Monaco's UI
				// language. It is pinned here because it makes no difference: the
				// fullwidth forms are confusable in every locale Monaco ships, zh-CN
				// and ja-JP included, which is why the reporters saw boxes on
				// CJK systems in the first place.
				allowedLocales: ['en'],
			},
		);
	}

	// Prose a CJK author actually types. The boxes need a basic-ASCII character in
	// the same word as the fullwidth punctuation — `shouldHighlightNonBasicASCII`
	// suppresses the highlight when the surrounding word is entirely non-ASCII —
	// so a Latin technical term or a Markdown emphasis marker is what triggers it.
	const CJK_PROSE = [
		'使用 Monaco，然后保存。',
		'安装依赖（npm ci），再运行测试。',
		'这是 Markdown，不是 HTML。',
		'打开 Settings：Editor，字体大小。',
		'**粗体**，*斜体*，`代码`。',
		'标题（English Title）说明',
		'你好，世界。（测试）！？',
	];

	test('the fixtures still reproduce the bug once the option is taken away', () => {
		// Without this the test above could pass because Monaco stopped treating
		// the fullwidth forms as confusable — an upgrade would quietly leave it
		// asserting nothing. It fails loudly instead, on the fixtures rather than
		// on the fix.
		const withDefaults = effectiveUnicodeHighlight({ ambiguousCharacters: true });
		const found = outlined(CJK_PROSE, withDefaults);
		assert.ok(
			found.ambiguousCharacterCount >= 6,
			`Monaco's defaults still box CJK punctuation, got ${found.ambiguousCharacterCount}`,
		);
	});

	// U+3000 IDEOGRAPHIC SPACE is what a CJK IME puts on the page when the author
	// presses the space bar, and it is in Monaco's invisible set — so #462 took the
	// boxes off the punctuation and left them on the space. `allowedLocales` cannot
	// help: `strings.js` getData() flattens every locale bucket into one 465-entry
	// set, so U+3000 is in it unconditionally. Only `allowedCharacters` reaches it.
	//
	// Note the fixtures above are Latin. Measured while fixing #393, a zero-width
	// space inside CJK text is not flagged at all — shouldHighlightNonBasicASCII()
	// suppresses it when the surrounding word holds no basic ASCII. So the hazard
	// this option guards is real, but not everywhere the comment above implies.
	const CJK_IDEOGRAPHIC_SPACE = [
		'\u4eca\u5929\u3000\u5929\u6c14\u5f88\u597d\u3002',
		'\u3000\u6bb5\u843d\u9996\u884c\u7f29\u8fdb\u4e24\u683c\u3002',
		'\u5b89\u88c5\u4f9d\u8d56\u3000\u7136\u540e\u8fd0\u884c\u6d4b\u8bd5\u3002',
	];

	test('the U+3000 fixtures still reproduce the bug once the exemption is taken away', () => {
		// Same guard as the ambiguous-character pair above: without this, the test
		// before it could pass because a Monaco upgrade dropped U+3000 from the
		// invisible set, and would then be asserting nothing.
		const withoutExemption = effectiveUnicodeHighlight({ ambiguousCharacters: false });
		const found = outlined(CJK_IDEOGRAPHIC_SPACE, withoutExemption);
		assert.ok(
			found.invisibleCharacterCount >= 3,
			`Monaco still boxes U+3000 by default, got ${found.invisibleCharacterCount}`,
		);
	});

	test('an unset selectionHighlight still means "highlight the selection"', () => {
		// The other half of the test above, for the same reason the CJK fixtures are
		// re-checked against Monaco's defaults: without this, dropping
		// `selectionHighlight` from Editor.svelte would pass if Monaco ever flipped
		// that default, and the test would be asserting nothing. It fails on Monaco
		// instead, rather than on the fix.
		assert.equal(
			EditorOptions.selectionHighlight.validate(undefined),
			true,
			"Monaco still highlights the selection's occurrences when the option is not passed",
		);
		assert.notEqual(
			EditorOptions.occurrencesHighlight.validate(undefined),
			'off',
			'…and still runs the other highlighter, so neither is covered by leaving it out',
		);
	});

	test('the character that opens that dialog is one prose really carries', () => {
		// Not hypothetical: U+2028 is what several word processors and PDF text
		// extractors emit for a soft line break, so it arrives by pasting. This is
		// Monaco's own predicate — its result is what the piece-tree buffer stores
		// as `mightContainUnusualLineTerminators`, the flag the detector reads
		// before it prompts.
		//
		// Spelled as escapes rather than as the characters themselves: the value
		// Monaco sees is identical, and a reviewer can tell which character each
		// fixture is about instead of staring at an invisible one.
		assert.equal(containsUnusualLineTerminators('A pasted paragraph with a soft\u2028break.'), true);
		assert.equal(containsUnusualLineTerminators('Two paragraphs,\u2029joined.'), true);
		assert.equal(
			containsUnusualLineTerminators('# Heading\n\nOrdinary markdown\r\nwith both line endings.\n'),
			false,
			'ordinary line endings are not what this is about',
		);
	});

	// ─────────────────────────────────────────── wordSegmenterLocales
	//
	// Word-wise navigation splits on `wordSeparators`, and a language that puts no
	// spaces between its words offers none — so ⌥→ crosses a whole Chinese clause,
	// double-click selects it, ⌥⌫ deletes it. `wordSegmenterLocales` switches on
	// `Intl.Segmenter`, which knows where the words are.
	//
	// Driven through Monaco's own `getMapForWordSeparators`, the function
	// `wordOperations.js` and `cursorWordOperations.js` both call, rather than
	// asserting the option is spelled correctly in Editor.svelte.


	/** Every word boundary Monaco would find on `line`, walking it end to end. */
	function wordStarts(line: string, locales: string[]): number[] {
		const classifier = getMapForWordSeparators(USUAL_WORD_SEPARATORS, locales);
		const starts: number[] = [];
		for (let offset = 0; offset < line.length; ) {
			const found = classifier.findNextIntlWordAtOrAfterOffset(line, offset);
			if (!found) break;
			starts.push(found.index);
			offset = found.index + Math.max(1, found.segment.length);
		}
		return starts;
	}

	test('a Chinese clause is one word without the segmenter and several with it', () => {
		// The sentence a reporter would type. No spaces, so `wordSeparators` has
		// nothing to go on.
		const line = '这是一个用于测试的段落';

		assert.deepEqual(wordStarts(line, []), [], 'precondition: no segmenter, no boundaries');
		assert.ok(wordStarts(line, ['zh', 'ja']).length > 1, 'the clause splits into words');
	});

	test('the list is a switch, not a whitelist — ICU dispatches by script', () => {
		// None of these scripts are named in `wordSegmenterLocales`, and all of
		// them segment. Worth pinning, because the obvious "cleanup" is to trim the
		// list to match the languages in the comment, and that would change nothing
		// while making the code claim something false.
		const unnamed = {
			thai: 'นี่คือประโยคภาษาไทยสำหรับทดสอบ',
			khmer: 'នេះគឺជាប្រយោគភាសាខ្មែរ',
			lao: 'ນີ້ແມ່ນປະໂຫຍກພາສາລາວ',
		};

		for (const [name, line] of Object.entries(unnamed)) {
			assert.deepEqual(wordStarts(line, []), [], `precondition: ${name} has no boundaries unsegmented`);
			assert.ok(wordStarts(line, ['zh', 'ja']).length > 1, `${name} segments without being listed`);
		}

		// And the two spellings that look like they should differ, do not.
		const han = '私は日本語の文章を書いています';
		assert.deepEqual(wordStarts(han, ['zh']), wordStarts(han, ['ja']));
		assert.deepEqual(wordStarts(han, ['zh']), wordStarts(han, ['zh', 'ja']));
	});

	test('space-delimited languages are left exactly as they were', () => {
		// The reason this can be turned on for everyone rather than keyed off the
		// UI language: it costs the other half of the world nothing.
		for (const line of [
			'The quick brown fox jumps',
			'이 문장은 한국어 표시를 테스트합니다',
			'Đây là một câu tiếng Việt',
			'Это предложение на русском',
		]) {
			assert.deepEqual(
				wordStarts(line, ['zh', 'ja']),
				[...line.matchAll(/\S+/g)].map((m) => m.index),
				`segmentation moved a boundary in: ${line}`,
			);
		}
	});

	test('the gutter left of the text grows with zoom only as far as the folding chevron needs', () => {
		const at = (lineNumbers: string, zoom: number) =>
			editorOptionsFromSettings({ ...SETTINGS, lineNumbers }, zoom).lineDecorationsWidth as number;

		// #812 kept a blank line-number column for the TOC button, and Monaco
		// sizes that column in digits, so zooming in pushed the text right for
		// nothing drawn. "Off" is now a real 'off', and the clearance the button
		// needs is a fixed width that zoom does not touch while the chevron fits.
		assert.equal(editorOptionsFromSettings({ ...SETTINGS, lineNumbers: 'off' }, 100).lineNumbers, 'off');
		assert.equal(at('off', 50), at('off', 100));
		assert.equal(at('off', 100), at('on', 100) + 42);

		// The default is Monaco's own 10px, so nothing moves at 14px.
		assert.equal(at('on', 100), 10);

		// Monaco draws the chevron at 140% of the font size plus a 2px margin, in
		// this strip plus the 16px it adds for folding. Before, the strip stayed
		// 26px and a large zoom spilled the chevron onto the text.
		for (const zoom of [100, 150, 200, 300]) {
			const fontSize = SETTINGS.editorFontSize * (zoom / 100);
			assert.ok(at('on', zoom) + 16 >= fontSize * 1.4 + 2, `chevron fits at ${zoom}%`);
			assert.equal(at('off', zoom), at('on', zoom) + 42);
		}
	});

	test('Typewriter Mode keeps the cursor line centred, for clicks too', () => {
		const off = editorOptionsFromSettings(SETTINGS, 100);
		assert.equal(off.cursorSurroundingLines, 0);
		assert.equal(off.cursorSurroundingLinesStyle, 'default');
		const on = editorOptionsFromSettings({ ...SETTINGS, typewriterMode: true }, 100);
		assert.ok(on.cursorSurroundingLines! > 1000, 'more lines than any screen, which Monaco caps at half the viewport');
		assert.equal(on.cursorSurroundingLinesStyle, 'all');
	});

	/** What `monaco.editor.create` gets for a settings store, on a whole buffer. */
	function created(settings: Partial<typeof SETTINGS> = {}) {
		return createdEditorOptions({ ...SETTINGS, stickyScroll: true, ...settings }, 100, false);
	}

	test('an option a setting can change is one `updateOptions` re-applies', () => {
		// `smoothScrolling` used to be a bare `true` in the creation literal, where
		// options that are set once and never re-applied live. Left there, the
		// toggle would have taken effect only on a newly created editor — the same
		// shape as the `fontSize` divergence #369 removed. So: change each setting,
		// and every option that moves at creation has to move the same way in what
		// the update effect re-applies to the open editor.
		// `stickyScroll` is left out: it is set only at creation today (known bug,
		// reported, not fixed here).
		const OTHER: Record<string, string> = { wordWrap: 'off', lineNumbers: 'off', renderLineHighlight: 'none', editorFont: 'Georgia' };
		for (const [field, value] of Object.entries(SETTINGS)) {
			const changed = { ...SETTINGS, [field]: typeof value === 'boolean' ? !value : typeof value === 'number' ? value + 6 : OTHER[field] };
			const before = created();
			const after = created(changed);
			const reapplied = updatedEditorOptions(changed, 100, true, false) as Record<string, unknown>;
			const moved = Object.keys(after).filter((key) => JSON.stringify(Reflect.get(after, key)) !== JSON.stringify(Reflect.get(before, key)));
			assert.ok(moved.length > 0, `${field} changes some option`);
			for (const key of moved) {
				assert.deepEqual(reapplied[key], Reflect.get(after, key), `changing ${field} re-applies ${key} to an open editor`);
			}
		}
	});

	test('renderLineHighlight is a Monaco string enum, not a boolean flag', () => {
		// Any non-empty string is truthy, so a ternary on the stored 'line' / 'none'
		// can only ever produce "line" — which defeats both the line-highlight
		// toggle and Zen mode. Both stored values have to survive the trip, at
		// creation and on update; a ternary passes for 'line' and fails for 'none'.
		for (const stored of ['line', 'none'] as const) {
			assert.equal(created({ renderLineHighlight: stored }).renderLineHighlight, stored);
			assert.equal(updatedEditorOptions({ ...SETTINGS, renderLineHighlight: stored }, 100, true, false).renderLineHighlight, stored);
		}
	});

	test('editor options are applied by a single updateOptions effect', () => {
		// Two competing effects wrote the same Monaco options with different
		// values — notably fontSize with and without the zoom factor. What the one
		// update applies: every option the two effects used to fight over, and the
		// zoom-aware font size that was the value they disagreed on.
		const applied = updatedEditorOptions({ ...SETTINGS, editorFontSize: 20, editorMaxWidth: 90 }, 150, true, false);
		assert.equal(applied.fontSize, 30, 'the surviving font size carries the zoom factor');
		assert.equal(applied.wordWrapColumn, 90, 'wordWrapColumn survived the merge');
		assert.equal(created({ editorFontSize: 20 }).fontSize, 20, 'and creation derives it the same way');
	});

	test('a proportional font wraps on measured widths, a monospace font keeps the fast path', () => {
		// #758: 'simple' wrapped Times New Roman and Roboto lines well short of the
		// window edge. Both values are asserted because 'advanced' everywhere would
		// also fix the report, and would make every large file pay for it.
		assert.equal(updatedEditorOptions(SETTINGS, 100, true, false).wrappingStrategy, 'simple');
		assert.equal(updatedEditorOptions(SETTINGS, 100, false, false).wrappingStrategy, 'advanced');
	});

	test('Show Whitespace renders every whitespace run, not just trailing', () => {
		// The setting is labelled without qualification ("Show Whitespace" /
		// "显示空白字符"), so "trailing" left interior spaces unmarked.
		assert.equal(created({ showWhitespace: true }).renderWhitespace, 'all');
		assert.equal(created({ showWhitespace: false }).renderWhitespace, 'none');
		assert.equal(updatedEditorOptions({ ...SETTINGS, showWhitespace: true }, 100, true, false).renderWhitespace, 'all');
	});

	test('the editor narrows the Unicode highlighter without switching it off', () => {
		// Reports #186 and #94 are both Monaco outlining fullwidth punctuation.
		// Narrowness is the assertion: `unicodeHighlight: false`, or turning
		// `invisibleCharacters` off, would also make the boxes go away and would
		// take the NBSP warning with it. Two overrides, and only two: the
		// confusable rule off, and U+3000 exempted from the invisible rule (#393).
		const passed = created().unicodeHighlight as object;
		assert.deepEqual(Object.keys(passed).sort(), ['allowedCharacters', 'ambiguousCharacters'], 'no third sub-option');
		const effective = effectiveUnicodeHighlight(passed);
		assert.equal(effective.ambiguousCharacters, false);
		assert.deepEqual(effective.allowedCharacters, { '　': true }, 'exactly one character is exempted');
	});

	test('no box is drawn on fullwidth CJK punctuation', () => {
		const found = outlined(CJK_PROSE, effectiveUnicodeHighlight(created().unicodeHighlight));
		assert.equal(
			found.ranges.length,
			0,
			`nothing outlined in CJK prose, got ${JSON.stringify(
				found.ranges.map((r) => CJK_PROSE[r.startLineNumber - 1].slice(r.startColumn - 1, r.endColumn - 1)),
			)}`,
		);
		assert.equal(found.ambiguousCharacterCount, 0);
	});

	test('the invisible-character warning survives the fix', () => {
		// A stray NBSP or zero-width space is a real hazard in Markdown — an NBSP
		// after `-` stops a list from parsing.
		const effective = effectiveUnicodeHighlight(created().unicodeHighlight);
		assert.equal(effective.invisibleCharacters, true, 'left at the Monaco default');
		const found = outlined(['a b', 'x​z'], effective);
		assert.equal(found.invisibleCharacterCount, 2, 'NBSP and zero-width space are still flagged');
	});

	test('the space bar under a CJK IME is not outlined', () => {
		const found = outlined(CJK_IDEOGRAPHIC_SPACE, effectiveUnicodeHighlight(created().unicodeHighlight));
		assert.equal(
			found.ranges.length,
			0,
			`nothing outlined around U+3000, got ${JSON.stringify(found.ranges.map((r) => CJK_IDEOGRAPHIC_SPACE[r.startLineNumber - 1]))}`,
		);
	});

	test('exempting U+3000 does not exempt the NBSP that breaks a list', () => {
		const found = outlined(['- item', '今天　天气'], effectiveUnicodeHighlight(created().unicodeHighlight));
		assert.equal(found.invisibleCharacterCount, 1, 'the NBSP is flagged, the U+3000 is not');
		assert.equal(found.ranges[0].startLineNumber, 1, 'and it is the NBSP line');
	});

	test('"Highlight Occurrences" off leaves nothing highlighting occurrences', () => {
		// Monaco splits the feature in two: `SelectionHighlighter` gates itself on
		// `selectionHighlight` and consults `occurrencesHighlight` only to choose a
		// decoration style. So at the setting's own default, selecting a word still
		// highlighted every other copy of it. Read through each option's own
		// `validate`, at creation and on update, for both values of the setting.
		for (const occurrencesHighlight of [false, true]) {
			for (const options of [created({ occurrencesHighlight }), updatedEditorOptions({ ...SETTINGS, occurrencesHighlight }, 100, true, false)]) {
				assert.deepEqual(
					{
						occurrencesHighlight: EditorOptions.occurrencesHighlight.validate(options.occurrencesHighlight),
						selectionHighlight: EditorOptions.selectionHighlight.validate(options.selectionHighlight),
					},
					occurrencesHighlight
						? { occurrencesHighlight: 'singleFile', selectionHighlight: true }
						: { occurrencesHighlight: 'off', selectionHighlight: false },
				);
			}
		}
	});

	test('the editor does not offer to rewrite a document containing U+2028', () => {
		// `unusualLineTerminators` defaults to 'prompt', which in standalone Monaco
		// is a bare `mainWindow.confirm()` offering to delete characters out of the
		// user's file. 'auto' makes the same edit with no dialog. Read through
		// `validate`, because anything it does not recognise resolves back to the
		// dialog.
		assert.equal(EditorOptions.unusualLineTerminators.validate(created().unusualLineTerminators), 'off');
	});

	test('the editor turns the semantic layer on, because the default is off', () => {
		// `StandaloneTheme.semanticHighlighting` is hard-coded false, so
		// `'configuredByTheme'` cannot reach it and the provider is never asked.
		assert.equal(Reflect.get(created(), 'semanticHighlighting.enabled'), true);
	});

	test('an editor on a buffer that is not the whole file refuses typing', () => {
		// An unread or unreadable tab in edit mode shows an empty buffer that no
		// save will ever accept. Read-only at the keyboard, not a toast at the save.
		assert.equal(editorReadOnly({ isTruncated: true }), true);
		assert.equal(editorReadOnly({ isTruncated: false }), false);
		assert.equal(editorReadOnly({}), false);
		assert.equal(createdEditorOptions({ ...SETTINGS, stickyScroll: true }, 100, true).readOnly, true, 'at creation');
		assert.equal(updatedEditorOptions(SETTINGS, 100, true, true).readOnly, true, 'and when a tab is read later');
		assert.equal(updatedEditorOptions(SETTINGS, 100, true, false).readOnly, false, 'and typing is back once it is whole');
	});
});

// The editor's Markdown colours. Two things can make a rule here do nothing at
// all, and neither is visible to the compiler: a token name no grammar emits
// (#676's defect, one layer over), and a colour that has drifted from the one
// the rest of the app resolves through `--color-*`.
describe('editor theme', () => {
	test('every rule is scoped to Markdown', () => {
		// Monaco's Markdown grammar appends `.md` to every token it emits, and a
		// rule without that suffix sits at the root of the token trie — where it
		// repaints Python, Rust and JSON inside fenced code blocks as well. That is
		// not a hypothetical: the first version of this palette did exactly that.
		for (const rule of markdownTokenRules('light')) {
			assert.ok(rule.token.endsWith('.md'), `${rule.token} would leak into every other language`);
		}
	});

	test('the markup all reads as markup, and the content inside it does not', () => {
		// The one line a reader actually scans by: is this the document, or the
		// syntax around it? Every structural marker takes the same colour, and the
		// two pieces of content that live inside markup take the text colour.
		for (const appearance of ['light', 'dark'] as const) {
			const byToken = new Map(markdownTokenRules(appearance).map((rule) => [rule.token, rule.foreground]));
			const structure = ['keyword.md', 'keyword.table.left.md', 'keyword.table.middle.md', 'keyword.table.right.md', 'comment.md', 'meta.separator.md'];
			for (const token of structure) {
				assert.equal(byToken.get(token), byToken.get('keyword.md'), `${token} must read as markup`);
			}
			for (const token of ['keyword.table.header.md', 'variable.source.md']) {
				assert.notEqual(byToken.get(token), byToken.get('keyword.md'), `${token} is content, not markup`);
			}
		}
	});

	test('the two inheritance overrides are present, or a table and a code block are miscoloured', () => {
		// Monaco resolves a token against a trie, so a rule on `keyword` also paints
		// `keyword.table.header`, and one on `variable` also paints
		// `variable.source`. Drop either override and every table header reads as a
		// heading, every fenced block as inline code.
		for (const appearance of ['light', 'dark'] as const) {
			const byToken = new Map(markdownTokenRules(appearance).map((rule) => [rule.token, rule.foreground]));
			assert.notEqual(byToken.get('keyword.table.header.md'), byToken.get('keyword.md'));
			assert.notEqual(byToken.get('variable.source.md'), byToken.get('variable.md'));
		}
	});

	test('bold and italic keep the font style the base theme gives them', () => {
		// A rule with no `fontStyle` is `FontStyle.NotSet`, which Monaco merges by
		// leaving what is already there — `vs`/`vs-dark` define `strong: bold` and
		// `emphasis: italic`. Spelling `regular` here would flatten both.
		for (const rule of markdownTokenRules('light')) {
			assert.ok(!('fontStyle' in rule), `${rule.token} must not decide a font style`);
		}
	});

	test('light and dark are actually different themes', () => {
		const light = markdownTokenRules('light');
		const dark = markdownTokenRules('dark');
		assert.deepEqual(light.map((rule) => rule.token), dark.map((rule) => rule.token));
		for (const [index, rule] of light.entries()) {
			assert.notEqual(rule.foreground, dark[index].foreground, `${rule.token} is the same colour on both`);
		}
	});

	test('a formula reads as markup around content, not as one flat run', () => {
		// Both math rules used to resolve to the same colour, which made the split
		// between the delimiters and the body invisible on screen. The `$` and every
		// control sequence inside now read as markup, like every other marker; the
		// operands keep the code colour and take the italics TeX would give them.
		for (const appearance of ['light', 'dark'] as const) {
			const byToken = new Map(semanticTokenRules(appearance).map((rule) => [rule.token, rule]));
			const marker = byToken.get('math.marker');
			const body = byToken.get('math');
			assert.equal(marker?.foreground, byToken.get('heading.marker')?.foreground, 'markup colour');
			assert.notEqual(marker?.foreground, body?.foreground, 'delimiters must not vanish into the body');
			assert.equal(body?.foreground, byToken.get('code')?.foreground, 'a formula is code-coloured');
			assert.equal(body?.fontStyle, 'italic');
		}
	});

	// ------------------------------------------- who tells Monaco which theme it is

	// `monaco.editor.setTheme` is global to the page, not scoped to an editor, so
	// the last caller in a flush decides what every editor is wearing. Two callers
	// disagreed: `Editor.svelte` asked for `app-theme-*` (the rules above) and
	// `MarkdownViewer.svelte` asked for Monaco's stock `vs`/`vs-dark` from a second
	// effect over the same `settings.theme`. Svelte 5 runs a child's effects before
	// its parent's and `Editor` is the viewer's child, so the stock name won every
	// theme change and the whole palette above stopped existing until the pane was
	// re-created.

	test('a settings value maps to one theme name', () => {
		assert.equal(monacoThemeName('dark', false), 'app-theme-dark');
		assert.equal(monacoThemeName('light', true), 'app-theme-light');
		assert.equal(monacoThemeName('system', true), 'app-theme-dark');
		assert.equal(monacoThemeName('system', false), 'app-theme-light');
		// The OS preference is only consulted for `system`.
		assert.equal(monacoThemeName('dark', true), 'app-theme-dark');
		assert.equal(monacoThemeName('light', false), 'app-theme-light');
		// An imported theme is one Monaco theme whatever its file is called, and
		// carries its own appearance rather than the desktop's.
		assert.equal(monacoThemeName('vscode:Dracula', false), 'vscode-custom');
		assert.equal(monacoThemeName('vscode:Solarized Light', true), 'vscode-custom');
	});
});

// The layer that colours from the renderer's answer instead of the grammar's
// guess. Three seams, each invisible to the compiler: the kinds Rust emits
// against the legend the encoder indexes, the legend against the theme rules
// that style it, and the delta encoding Monaco decodes.
describe('semantic tokens', () => {
	test('the legend and the theme agree on what can be styled', () => {
		// A rule for a type the legend lacks styles nothing; a type with no rule
		// paints whatever the grammar left, which for a construct the grammar has
		// never heard of means no colour at all.
		const styled = new Set(semanticTokenRules('light').map((rule) => rule.token.split('.')[0]));
		for (const type of TOKEN_TYPES) {
			assert.ok(styled.has(type), `no theme rule styles \`${type}\``);
		}
		for (const rule of semanticTokenRules('light')) {
			const [type, modifier] = rule.token.split('.');
			assert.ok((TOKEN_TYPES as readonly string[]).includes(type), `rule \`${rule.token}\` names no legend type`);
			if (modifier) {
				assert.ok(
					(TOKEN_MODIFIERS as readonly string[]).includes(modifier),
					`rule \`${rule.token}\` names no legend modifier`,
				);
			}
		}
	});

	test('a semantic rule spells out every font style it wants', () => {
		// `getTokenStyleMetadata` reports bold and italic as booleans rather than
		// "not set", so a semantic token claims those bits whatever the rule says.
		// A rule that stays silent about bold therefore switches it OFF for the
		// range it covers — the opposite of the grammar rules, where silence means
		// "leave it alone".
		const byToken = new Map(semanticTokenRules('light').map((rule) => [rule.token, rule.fontStyle]));
		assert.equal(byToken.get('strong.marker'), 'bold');
		assert.equal(byToken.get('emph.marker'), 'italic');
		assert.equal(byToken.get('heading'), 'bold');
		assert.equal(byToken.get('strike'), 'strikethrough');
		assert.equal(byToken.get('strong'), 'bold');
		assert.equal(byToken.get('emph'), 'italic');
		assert.equal(byToken.get('strongemph'), 'bold italic');
		assert.equal(byToken.get('math'), 'italic');
	});

	test('the encoder writes deltas Monaco can decode', () => {
		const data = encodeSemanticTokens([
			{ kind: 'heading.marker', line: 0, start: 0, len: 3 },
			{ kind: 'heading', line: 0, start: 3, len: 5 },
			{ kind: 'strong.marker', line: 2, start: 4, len: 2 },
		]);

		assert.deepEqual(
			[...data],
			[
				// deltaLine, deltaStart, length, type, modifiers
				0, 0, 3, TOKEN_TYPES.indexOf('heading'), 1,
				0, 3, 5, TOKEN_TYPES.indexOf('heading'), 0,
				2, 4, 2, TOKEN_TYPES.indexOf('strong'), 1,
			],
		);
	});

	test('an unknown kind is dropped rather than mapped to another construct', () => {
		// Index arithmetic on an unknown name would paint some other construct's
		// colour, which is worse than leaving the grammar's.
		const data = encodeSemanticTokens([
			{ kind: 'nonesuch', line: 0, start: 0, len: 2 },
			{ kind: 'code', line: 0, start: 4, len: 6 },
		]);
		assert.equal(data.length, 5);
		assert.equal(data[1], 4, 'the surviving token still measures from the start of the line');
	});

	test('a theme that colours a construct colours all of it, markers included', () => {
		// Rules are sorted by name, and a child node is cloned from its parent at the
		// moment it is created. The app's base carries `strike.marker`, which sorts
		// after the theme's `strike`, so an alias that stopped at the content left
		// the theme colouring a word and the app colouring the `~~` on either side of
		// it — one construct in two greys, and the same for `##` against its title.
		//
		// Driven off the alias table rather than a list written out here: the failure
		// arrives when the app names a *longer* token than the alias does, so a new
		// entry is exactly the case that would otherwise go unchecked.
		// A colour per *kind*, not per scope: two scopes can name the same construct
		// (`markup.inline.raw` and `markup.raw.inline` are both inline code), and
		// giving those two different colours would only test which one sorts last.
		// Distinct across kinds is what catches a rule landing on the wrong one.
		const kinds = [...new Set(Object.values(MARKDOWN_SCOPE_ALIASES).map((alias) => alias.kind))];
		const colourOf = (kind: string) =>
			`#${(kinds.indexOf(kind) + 1).toString(16).padStart(2, '0').repeat(3)}`;
		const scopes = Object.entries(MARKDOWN_SCOPE_ALIASES).map(([scope, alias], index) => ({
			// Every other one language-qualified, which is the commoner spelling in
			// real themes and reaches the alias lookup by its prefix rule rather
			// than by an exact hit.
			scope: index % 2 ? `${scope}.markdown` : scope,
			kind: alias.kind,
			foreground: colourOf(alias.kind),
		}));

		const theme = TokenTheme.createFromParsedTokenTheme(
			parseTokenTheme([
				{ token: '', foreground: '#e6e6e6', background: '#12141a' },
				...importedThemeRules(
					scopes.map(({ scope, foreground }) => ({ scope, settings: { foreground } })),
					true,
				),
			]),
			[],
		);
		const colours = theme.getColorMap();
		// The map holds Monaco `Color` objects; their string form is the hex.
		const foregroundOf = (token: string) =>
			String(colours[(theme._match(token).metadata >>> 15) & 511]).toLowerCase();

		for (const { scope, kind, foreground } of scopes) {
			assert.equal(foregroundOf(kind), foreground, `${scope} must reach ${kind}`);
			assert.equal(foregroundOf(`${kind}.marker`), foreground, `${scope} must reach ${kind}.marker`);
		}
	});
});

// #676: an imported VS Code theme colours TextMate scopes, Monaco's markdown
// tokenizer emits names of its own, and until now nothing renamed one into the
// other — so `markup.bold` reached `defineTheme` and matched nothing.
describe('markdown token colours', () => {
	const rulesFor = (tokenColors: unknown) => monacoTokenRules(tokenColors);

	const tokens = (tokenColors: unknown) => rulesFor(tokenColors).map((rule) => rule.token);

	test('an emphasis scope also arrives under the token Monaco emits', () => {
		const rules = rulesFor([
			{ scope: 'markup.bold', settings: { foreground: '#ff0000', fontStyle: 'bold' } },
			{ scope: 'markup.italic', settings: { foreground: '#00ff00' } },
			{ scope: ['markup.inline.raw', 'markup.underline.link'], settings: { foreground: '#0000ff' } },
		]);

		const byToken = new Map(rules.map((rule) => [rule.token, rule]));
		assert.deepEqual(byToken.get('strong'), { token: 'strong', foreground: 'ff0000', fontStyle: 'bold' });
		assert.equal(byToken.get('emphasis')?.foreground, '00ff00');
		assert.equal(byToken.get('variable')?.foreground, '0000ff');
		assert.equal(byToken.get('string.link')?.foreground, '0000ff');

		// The scope keeps its own rule too — it is inert, not wrong.
		assert.ok(byToken.has('markup.bold'));
	});

	test('a language-qualified scope is renamed too, and a shorter neighbour is not', () => {
		assert.ok(tokens([{ scope: 'markup.bold.markdown', settings: { foreground: '#ff0000' } }]).includes('strong'));
		assert.ok(tokens([{ scope: 'markup.italic.markdown', settings: { foreground: '#ff0000' } }]).includes('emphasis'));

		// `markup.underline` is underlined text, not a link, and must not take the
		// link colour on the strength of a shared prefix.
		assert.deepEqual(tokens([{ scope: 'markup.underline', settings: { foreground: '#ff0000' } }]), ['markup.underline']);
	});

	test('a colour-only rule leaves the base theme to keep bold and italic', () => {
		// Monaco reads a missing `fontStyle` as NotSet and keeps what is already on
		// the token — `vs`/`vs-dark` define `strong: bold` and `emphasis: italic`.
		// Spelling it `regular` here instead would flatten the text the theme was
		// only asked to colour.
		const rule = rulesFor([{ scope: 'markup.bold', settings: { foreground: '#ff0000' } }]).find((r) => r.token === 'strong');
		assert.ok(rule, 'the alias must exist before its fontStyle means anything');
		assert.equal(rule.fontStyle, undefined);
	});

	test('scopes written as one comma-separated string are split', () => {
		// Left whole, the comma is part of the token name and the entry colours
		// nothing — the same silent miss as the missing rename.
		assert.deepEqual(
			tokens([{ scope: 'comment, markup.bold', settings: { foreground: '#ff0000' } }]),
			['comment', 'markup.bold', 'strong'],
		);
	});

	test('an unusable entry is dropped rather than passed to defineTheme', () => {
		// A non-hex foreground makes `defineTheme` throw, which drops the whole
		// editor theme, so it cannot reach it — alias or not.
		assert.deepEqual(tokens([{ scope: 'markup.bold', settings: { foreground: 'red' } }]), []);
		assert.deepEqual(tokens([{ scope: 'markup.bold', settings: {} }]), []);
		assert.deepEqual(tokens([{ settings: { foreground: '#ff0000' } }]), []);
		assert.deepEqual(tokens(undefined), []);
	});

	test('an imported theme reaches the semantic names too, not only the grammar ones', () => {
		// The grammar calls italics `emphasis` and the renderer's parse calls it
		// `emph`; a scope that stopped at the first spelling would leave the second
		// unstyled. `~~strikethrough~~` has no grammar name at all, so `strike` is
		// the only way a theme can colour it — which is the half of #676 that could
		// not be answered until the parse drove the colours.
		const byToken = new Map(
			rulesFor([
				{ scope: 'markup.italic', settings: { foreground: '#00ff00' } },
				{ scope: 'markup.strikethrough', settings: { foreground: '#888888' } },
				{ scope: 'markup.heading', settings: { foreground: '#61afef' } },
				{ scope: 'markup.inline.raw', settings: { foreground: '#98c379' } },
				{ scope: 'markup.underline.link', settings: { foreground: '#56b6c2' } },
				{ scope: 'markup.quote', settings: { foreground: '#5c6370' } },
			]).map((rule) => [rule.token, rule.foreground]),
		);
		assert.equal(byToken.get('emph'), '00ff00');
		assert.equal(byToken.get('emphasis'), '00ff00');
		assert.equal(byToken.get('strike'), '888888');
		assert.equal(byToken.get('heading'), '61afef');
		assert.equal(byToken.get('code'), '98c379');
		assert.equal(byToken.get('link'), '56b6c2');
		assert.equal(byToken.get('quote'), '5c6370');
	});

	// #682: the same scopes, read as colours rather than as Monaco rules, because
	// the preview renders the constructs as HTML and takes them through CSS.

	test('a theme\'s Markdown scopes are readable as a colour per construct', () => {
		const colors = markdownKindColors([
			{ scope: 'markup.bold.markdown', settings: { foreground: '#ff0000' } },
			{ scope: ['markup.heading', 'markup.quote'], settings: { foreground: '#00ff00' } },
			{ scope: 'markup.underline.link', settings: { foreground: '#0000ff', fontStyle: 'underline' } },
			// Not Markdown, and not a colour: neither may reach the preview.
			{ scope: 'keyword.control', settings: { foreground: '#123456' } },
			{ scope: 'markup.italic', settings: { fontStyle: 'italic' } },
		]);

		assert.equal(colors.get('strong'), 'ff0000');
		assert.equal(colors.get('heading'), '00ff00');
		assert.equal(colors.get('quote'), '00ff00');
		assert.equal(colors.get('link'), '0000ff');
		assert.equal(colors.has('emph'), false);
		assert.equal([...colors.keys()].length, 4);
	});

	test('a theme with no token colours at all leaves the preview alone', () => {
		// The built-in themes, and a theme file that only paints the workbench. An
		// empty map writes no variable, and every rule falls back to what the
		// stylesheet already said.
		for (const tokenColors of [undefined, null, [], 'markup.bold']) {
			assert.equal(markdownKindColors(tokenColors).size, 0);
		}
	});
});

/*
	The link the app writes for a pasted or dropped image has to name the file
	Rust just created — after a CommonMark parse, and after each of Markpad's
	two readers has had its way with the result.

	So every case below is checked end to end, through the real readers:

	  parse    the destination CommonMark hands the renderer, per its grammar
	  preview  `processMarkdownHtml`: decodeURIComponent, then resolve
	  export   `resolveExportImagePath`, imported here, not modelled

	The one thing modelled rather than run is comrak, which is Rust. Its
	`escape_href` (comrak 0.54, src/html.rs) is the identity on everything
	`encodeImageDestination` emits: its safe set covers the unreserved ASCII we
	pass through, it copies a `%` verbatim when two hex digits follow, and the
	two characters it does rewrite — `&` to `&amp;`, `'` to `&#x27;` — are
	undone by the HTML parser before either reader sees them. Passing the
	destination straight to the readers is therefore faithful, and
	`the escapes comrak passes through unchanged` below pins the assumption
	that matters.
*/
describe('image embed', () => {
	/**
	 * The destination CommonMark reads out of `![alt](…)`: it ends at the first
	 * ASCII space or control character, and parentheses count only while balanced.
	 * This is where `photo).png` loses its tail, so the fix has to be visible here
	 * before anything downstream is worth checking.
	 */
	function parseDestination(embed: string): string {
		const open = embed.indexOf('](');
		assert.notEqual(open, -1, `not an inline image: ${embed}`);

		let depth = 1;
		let i = open + 2;
		for (; i < embed.length; i++) {
			const char = embed[i];
			if (char.charCodeAt(0) <= 0x20) break;
			if (char === '\\') {
				i++;
				continue;
			}
			if (char === '(') depth++;
			if (char === ')' && --depth === 0) break;
		}
		return embed.slice(open + 2, i);
	}

	/** What the preview does with a `src` in `processMarkdownHtml`. */
	function previewResolves(destination: string, tabPath: string): string {
		return resolveDocumentRelativePath(tabPath, decodeURIComponent(destination));
	}

	const TAB_PATH = '/home/u/notes/note.md';

	/**
	 * `relPath` is what `save_image` / `copy_file_to_img` return: the image
	 * directory and the file name joined with `/`, relative to the document.
	 */
	function roundTrips(relPath: string, expectedFile: string) {
		const destination = parseDestination(imageEmbed(relPath));

		assert.equal(
			destination,
			encodeImageDestination(relPath),
			'CommonMark truncated the destination',
		);
		assert.equal(previewResolves(destination, TAB_PATH), expectedFile, 'preview');
		assert.equal(resolveExportImagePath(destination, TAB_PATH), expectedFile, 'export');
	}

	test('a file name whose # would otherwise become an anchor', () => {
		// The report: `![alt](img/note#1.png)` exports as `img/note`.
		roundTrips('img/note#1.png', '/home/u/notes/img/note#1.png');
		assert.equal(imageEmbed('img/note#1.png'), '![alt](img/note%231.png)');
	});

	test('spaces, which were the only thing the old code escaped', () => {
		roundTrips('img/my photo.png', '/home/u/notes/img/my photo.png');
		assert.equal(imageEmbed('img/my photo.png'), '![alt](img/my%20photo.png)');
	});

	test('an unbalanced parenthesis, which ends the link early', () => {
		roundTrips('img/photo).png', '/home/u/notes/img/photo).png');
		roundTrips('img/photo(1.png', '/home/u/notes/img/photo(1.png');
	});

	test('balanced parentheses, which CommonMark allows and we encode anyway', () => {
		// Legal unescaped, so this is a deliberate cost: one rule beats a paren
		// counter, and both spellings name the same file at every reader.
		roundTrips('img/photo (1).png', '/home/u/notes/img/photo (1).png');
	});

	test('a ? , which the export resolver reads as a query string', () => {
		roundTrips('img/really?.png', '/home/u/notes/img/really?.png');
	});

	test('a literal % , which decodes back into a different name unencoded', () => {
		// comrak copies `%20` through untouched, so an unencoded `50%20off.png`
		// reaches decodeURIComponent and comes out as `50 off.png`.
		roundTrips('img/50%20off.png', '/home/u/notes/img/50%20off.png');
		assert.equal(imageEmbed('img/50%20off.png'), '![alt](img/50%2520off.png)');
	});

	test('a backslash, which CommonMark reads as an escape', () => {
		// Encoded for the parse — unencoded, `\(` is an escape and the destination
		// comes out as `img/a(b.png`, a different file.
		assert.equal(imageEmbed('img/a\\(b.png'), '![alt](img/a%5C%28b.png)');
		assert.equal(parseDestination(imageEmbed('img/a\\(b.png')), 'img/a%5C%28b.png');

		// Not round-tripped, and this is the one case that cannot be: both readers
		// resolve through a path splitter that counts `\` as a directory separator
		// on purpose, because a Windows author writes `![](img\a.png)` and means
		// one. See resolveDocumentRelativePath in src/lib/utils/markdown.ts. A
		// POSIX file whose *name* contains a backslash is unreachable through a
		// Markpad link however it is spelled, so nothing here can fix it.
		assert.equal(
			previewResolves('img/a%5C%28b.png', TAB_PATH),
			'/home/u/notes/img/a/(b.png',
		);
	});

	test('an imageDirectory carrying the same characters', () => {
		roundTrips('my imgs #1/photo.png', '/home/u/notes/my imgs #1/photo.png');
		roundTrips('assets (old)/a?.png', '/home/u/notes/assets (old)/a?.png');
	});

	test('an empty imageDirectory, whose leading slash is not an absolute path', () => {
		// Rust joins with `/`, so an empty setting yields `/photo.png`; left alone
		// it resolves to the filesystem root at both readers.
		roundTrips('/photo #1.png', '/home/u/notes/photo #1.png');
		assert.equal(imageEmbed('/photo #1.png'), '![alt](photo%20%231.png)');
	});

	test('non-ASCII names stay readable in the document', () => {
		// The reason encodeURI/encodeURIComponent were not used: both would write
		// `%E5%9B%BE%E7%89%87/…` into a file a person reads.
		assert.equal(imageEmbed('图片/截图.png'), '![alt](图片/截图.png)');
		roundTrips('图片/截图 1.png', '/home/u/notes/图片/截图 1.png');
	});

	test('the escapes comrak passes through unchanged', () => {
		// Every byte we emit is either in comrak's HREF_SAFE set or a `%` followed
		// by two hex digits, which its escape_href copies verbatim. If this ever
		// fails, the destination is being double-escaped on the way to the HTML.
		const safe = /^(?:[-_.+!*(),#@?=;:/$~a-zA-Z0-9]|%[0-9A-F]{2}|[^\x00-\x7f])*$/;
		for (const relPath of ['img/note#1.png', 'img/my photo.png', 'img/50%20off.png']) {
			assert.match(encodeImageDestination(relPath), safe);
		}
	});

	test('angle brackets would need the export resolver changed to work', () => {
		// The other candidate, and the form headingReference.ts uses for spaces and
		// parentheses. It answers the CommonMark grammar and nothing else: the `#`
		// reaches the readers raw, and the export resolver — correctly, for a URL —
		// treats it as a fragment. Recorded so the choice is not re-litigated from
		// memory; if this ever starts returning the whole path, angle brackets are
		// back on the table.
		assert.equal(parseDestination('![alt](<img/note#1.png>)'), '<img/note#1.png>');
		assert.equal(resolveExportImagePath('img/note#1.png', TAB_PATH), '/home/u/notes/img/note');
		assert.equal(resolveExportImagePath('img/a?.png', TAB_PATH), '/home/u/notes/img/a');
	});

	test('documentParentDir refuses a path with no directory in it', () => {
		assert.equal(documentParentDir('/home/u/notes/note.md'), '/home/u/notes');
		assert.equal(documentParentDir('C:\\notes\\note.md'), 'C:\\notes');
		assert.equal(documentParentDir('note.md'), null);
	});

	test('${filename} expands to the document name, so each document can own its images', () => {
		assert.equal(
			resolveImageDirectory('${filename}.assets', '/home/u/notes/trip.md'),
			'trip.assets',
		);
		assert.equal(
			resolveImageDirectory('${filename}.assets', 'C:\\notes\\trip.md'),
			'trip.assets',
		);
		// The extension comes off at the last dot; a leading dot is a name, not an
		// extension.
		assert.equal(resolveImageDirectory('${filename}', '/n/archive.tar.md'), 'archive.tar');
		assert.equal(resolveImageDirectory('${filename}', '/n/.gitignore'), '.gitignore');
		// No token, no expansion: the setting stays the literal folder name it has
		// always been, and an empty one still means the default.
		assert.equal(resolveImageDirectory('img', '/n/trip.md'), 'img');
		assert.equal(resolveImageDirectory('', '/n/trip.md'), DEFAULT_IMAGE_DIRECTORY);
	});

	test('a $ in the document name is not read as a replacement pattern', () => {
		// `String.replace` reads `$&` and `$'` in the *replacement* as the match and
		// the text after it, so a document named `$&.md` would have written the
		// literal token back out and created a folder called `${filename}.assets`.
		assert.equal(resolveImageDirectory('${filename}.assets', '/n/$&.md'), '$&.assets');
		assert.equal(resolveImageDirectory('${filename}', "/n/$'.md"), "$'");
	});
});

// WHAT THIS FILE COVERS, AND WHAT IT DOES NOT
//
// Covered for real: every classification below runs Monaco's *actual* markdown
// Monarch grammar — the same `language` definition monaco-editor ships and the
// same `MonarchTokenizer` that `monaco.editor.tokenize()` drives — over real
// markdown, and asserts on the decision `pasteContext.ts` reaches. So the token
// types, the fence state machine, and the caret lookup are genuinely exercised,
// not mocked.
//
// Not covered: that Editor.svelte calls this code on the Ctrl+V path with the
// right arguments. Editor.svelte is a Svelte component and cannot be imported
// here, so that wiring is pinned by a source-text assertion at the bottom of
// the file, which proves only that the code reads a certain way.
//
// Also not covered: Monaco's async tokenizer bootstrap. In the app,
// `monaco.editor.tokenize()` falls back to null tokens if the language has not
// finished loading; that degrades to "no code token found", i.e. to the old
// linkify-everything behaviour, and is not reproduced here.
describe('paste URL context', () => {
	// `monaco.editor.tokenize()` needs a browser-backed editor to exist, so the
	// tokenizer is driven directly. Only the handful of services Monarch actually
	// touches during plain (non-encoded) tokenization are stubbed.
	function createMarkdownTokenizer() {
		const lexer = compile('markdown', markdownLanguage);
		const languageService = {
			languageIdCodec: { encodeLanguageId: () => 1, decodeLanguageId: () => 'markdown' },
			isRegisteredLanguageId: () => true,
			// ```lang fences: Monarch asks for the embedded language and stamps its
			// tokens with the resulting id, which is the signal pasteContext keys on.
			getLanguageIdByLanguageName: (name: string) => name,
			requestBasicLanguageFeatures: () => {},
			requestRichLanguageFeatures: () => {},
			onDidRequestBasicLanguageFeatures: () => ({ dispose() {} }),
			onDidRequestRichLanguageFeatures: () => ({ dispose() {} }),
		};
		const themeService = {
			getColorTheme: () => ({ tokenTheme: { match: () => 0 } }),
			onDidColorThemeChange: () => ({ dispose() {} }),
		};
		const configurationService = {
			getValue: () => undefined,
			onDidChangeConfiguration: () => ({ dispose() {} }),
		};

		const tokenizer = new MonarchTokenizer(
			languageService,
			themeService,
			'markdown',
			lexer,
			configurationService,
		);

		return (text: string): PasteContextToken[][] => {
			let state = tokenizer.getInitialState();
			return text.split('\n').map((line: string) => {
				const result = tokenizer.tokenize(line, true, state);
				state = result.endState;
				return result.tokens as PasteContextToken[];
			});
		};
	}

	const tokenize = createMarkdownTokenizer();

	/**
	 * Places the caret with a `|` marker inside `content` and asks whether a pasted
	 * URL should become a markdown link there.
	 */
	function linkifiesAt(content: string, languageId = 'markdown'): boolean {
		const caret = content.indexOf('|');
		assert.notEqual(caret, -1, 'the fixture must mark the caret with |');
		const withoutCaret = content.slice(0, caret) + content.slice(caret + 1);

		const before = content.slice(0, caret).split('\n');
		const lineNumber = before.length;
		const column = before[before.length - 1].length + 1;

		return shouldLinkifyPastedUrl({
			languageId,
			content: withoutCaret,
			linesUpToCaret: withoutCaret.split('\n').slice(0, lineNumber),
			column,
			tokenize,
		});
	}

	test('a URL pasted into prose still becomes a markdown link', () => {
		assert.equal(linkifiesAt('some prose |here'), true);
		assert.equal(linkifiesAt('# A heading |'), true);
		assert.equal(linkifiesAt('- a list item |'), true);
		assert.equal(linkifiesAt('> a quoted line |'), true);
		assert.equal(linkifiesAt('see [other link](http://a) |'), true);
	});

	test('a URL pasted inside a fenced code block stays a bare URL', () => {
		assert.equal(linkifiesAt('```\nconst a = |\n```'), false);
		assert.equal(linkifiesAt('```js\nconst a = |\n```'), false);
		assert.equal(linkifiesAt('~~~\nplain |text\n~~~'), false);
	});

	test('a URL pasted on a blank line inside a fence stays a bare URL', () => {
		// The realistic gesture: open a fence, press Enter, paste. Monarch emits no
		// tokens at all for an empty line, which is why the caret is probed.
		assert.equal(linkifiesAt('```\n|\n```'), false);
		assert.equal(linkifiesAt('```js\n|\n```'), false);
	});

	test('fence state is tracked, so prose after a closed fence linkifies again', () => {
		assert.equal(linkifiesAt('```\ncode\n```\n\nback to prose |'), true);
		// An indented fence inside a list is still a fence.
		assert.equal(linkifiesAt('- item\n\n  ```\n  code |\n  ```'), false);
	});

	test('a URL pasted inside inline code stays a bare URL', () => {
		assert.equal(linkifiesAt('run `npm | install` now'), false);
		// Immediately after the closing backtick is prose again.
		assert.equal(linkifiesAt('run `npm`| now'), true);
		// And immediately before the opening backtick.
		assert.equal(linkifiesAt('run |`npm` now'), true);
	});

	test('a URL pasted inside an indented code block stays a bare URL', () => {
		assert.equal(linkifiesAt('paragraph\n\n    indented | code'), false);
	});

	test('a URL pasted inside front matter stays a bare URL', () => {
		const doc = '---\ntitle: Post\nsource: |\n---\n\nbody text\n';
		assert.equal(linkifiesAt(doc), false);
		assert.equal(linkifiesAt('-|--\ntitle: Post\n---\n\nbody\n'), false, 'opening fence');
		assert.equal(linkifiesAt('---\ntitle: Post\n-|--\n\nbody\n'), false, 'closing fence');
		assert.equal(linkifiesAt('---\ntitle: Post\n---\n\nbody |\n'), true, 'body below is prose');
	});

	test('a document that only looks like front matter is treated as prose', () => {
		// `---` over prose is a thematic break plus a setext heading, not metadata;
		// parseFrontMatter already draws that line and pasteContext reuses it.
		assert.equal(linkifiesAt('---\njust prose |\n---\n'), true);
	});

	test('non-markdown documents keep their existing paste behaviour', () => {
		assert.equal(linkifiesAt('const a = |', 'javascript'), true);
		assert.equal(linkifiesAt('plain |text', 'plaintext'), true);
	});

	test('front matter line count covers both fences', () => {
		assert.equal(getFrontMatterLineCount('---\ntitle: a\n---\nbody\n'), 3);
		assert.equal(getFrontMatterLineCount('---\ntitle: a\nb: c\n---\n'), 4);
		// No trailing newline after the closing fence.
		assert.equal(getFrontMatterLineCount('---\ntitle: a\n---'), 3);
		assert.equal(getFrontMatterLineCount('---\r\ntitle: a\r\n---\r\nbody\r\n'), 3);
		assert.equal(getFrontMatterLineCount('no front matter here\n'), 0);

		assert.equal(isInFrontMatter('---\ntitle: a\n---\nbody\n', 3), true);
		assert.equal(isInFrontMatter('---\ntitle: a\n---\nbody\n', 4), false);
	});

	test('the caret probe inserts one character without disturbing earlier lines', () => {
		const probe = buildPasteProbe(['first', 'second'], 4);
		assert.equal(probe.text, 'first\nsecxond');
		assert.equal(probe.lineIndex, 1);
		assert.equal(probe.offset, 3);

		// A blank caret line still gets a probe, which is the whole point.
		assert.deepEqual(buildPasteProbe(['```', ''], 1), { text: '```\nx', lineIndex: 1, offset: 0 });

		// Columns outside the line are clamped rather than producing gaps.
		assert.equal(buildPasteProbe(['ab'], 99).offset, 2);
		assert.equal(buildPasteProbe(['ab'], -5).offset, 0);
	});

	test('link syntax is not mistaken for code', () => {
		// `string.link.md` shares a prefix with the `string.md` code token, so the
		// classifier has to match whole token types.
		assert.equal(isCodeToken({ offset: 0, type: 'string.link.md', language: 'markdown' }), false);
		assert.equal(isCodeToken({ offset: 0, type: 'string.md', language: 'markdown' }), true);
		assert.equal(isCodeToken({ offset: 0, type: 'variable.md', language: 'markdown' }), true);
		assert.equal(isCodeToken({ offset: 0, type: 'variable.source.md', language: 'markdown' }), true);
		assert.equal(isCodeToken({ offset: 0, type: '', language: 'markdown' }), false);
		// Anything an embedded grammar emits counts as code.
		assert.equal(isCodeToken({ offset: 0, type: 'identifier.js', language: 'javascript' }), true);
	});

	test('the caret lands in the token that starts at or before it', () => {
		const tokens: PasteContextToken[] = [
			{ offset: 0, type: '', language: 'markdown' },
			{ offset: 4, type: 'variable.md', language: 'markdown' },
			{ offset: 9, type: '', language: 'markdown' },
		];
		assert.equal(findTokenAtOffset(tokens, 0)?.type, '');
		assert.equal(findTokenAtOffset(tokens, 4)?.type, 'variable.md');
		assert.equal(findTokenAtOffset(tokens, 8)?.type, 'variable.md');
		assert.equal(findTokenAtOffset(tokens, 9)?.type, '');
		assert.equal(findTokenAtOffset([], 0), null);
	});
});

describe('focus paragraph', () => {
	const LINES = ['# Title', '', 'one', 'two', '  ', 'three', ''];

	const read = (line: number) => LINES[line - 1];

	test('the paragraph is the run of non-blank lines around the cursor', () => {
		assert.deepEqual(paragraphAround(read, LINES.length, 1), { start: 1, end: 1 });
		assert.deepEqual(paragraphAround(read, LINES.length, 4), { start: 3, end: 4 }, 'from its last line');
		assert.deepEqual(paragraphAround(read, LINES.length, 3), { start: 3, end: 4 }, 'from its first line');
		assert.deepEqual(paragraphAround(read, LINES.length, 6), { start: 6, end: 6 }, 'a whitespace-only line ends a paragraph');
		assert.deepEqual(paragraphAround(read, LINES.length, 2), { start: 2, end: 2 }, 'a blank line is its own');
	});
});
