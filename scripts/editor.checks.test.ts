import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { describe, test } from 'node:test';

import { EditorOptions, inUntrustedWorkspace, type UnicodeHighlightOptions } from 'monaco-editor/esm/vs/editor/common/config/editorOptions.js';
import { type UnicodeHighlightResult, UnicodeTextModelHighlighter } from 'monaco-editor/esm/vs/editor/common/services/unicodeTextModelHighlighter.js';
import ts from 'typescript';
import { parseTokenTheme, TokenTheme } from 'monaco-editor/esm/vs/editor/common/languages/supports/tokenization.js';

import { getSupportedLanguages, type LanguageCode, t, type Translation } from '../src/lib/utils/i18n.js';
import { translations } from './allTranslations.js';
import { callbackBodies, enclosingFunctionName, filesMatching, functionSource, offsetOf, readDictionarySource, readRustBackend, readSource, readSourceFiles, sliceBetween, walkSourceFiles } from './sourceTree.js';
import { editorOptionsFromSettings } from '../src/lib/utils/editorOptions.js';
import { markdownTokenRules, monacoThemeName } from '../src/lib/utils/editorTheme.js';
import { runEditorHandler } from './keymapHarness.js';
import { MONACO_IME_PATCH, MONACO_TEXTAREA_FILE, patchMonacoTextAreaForIme } from './monacoImePatch.mjs';
import { importedThemeRules, PREVIEW_KIND_VARS } from '../src/lib/utils/theme.js';
import { TOKEN_TYPES } from '../src/lib/utils/semanticTokens.js';
import { DEFAULT_IMAGE_DIRECTORY } from '../src/lib/utils/imageEmbed.js';

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
describe('context menu actions', () => {
	const editor = readSource('src/lib/components/Editor.svelte');

	const supported = getSupportedLanguages().map((l) => l.code);

	function count(source: string, pattern: RegExp): number {
		return source.match(pattern)?.length ?? 0;
	}

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

	test('every context-menu label is translated, none is an English literal', () => {
		for (const [actionId, key, englishLabel] of FORMATTING_ACTIONS) {
			assert.doesNotMatch(
				editor,
				new RegExp(`id: "${actionId}",\\s*\\n\\s*label: "${englishLabel}"`),
				`${actionId} must not hard-code "${englishLabel}"`,
			);
			assert.match(
				editor,
				new RegExp(`id: "${actionId}",\\s*\\n\\s*label: t\\('${key.replace('.', '\\.')}', lang\\)`),
				`${actionId} takes its label from ${key}`,
			);
		}

		// No `addAction` anywhere in the component may carry a bare string label.
		assert.equal(
			count(editor, /addAction\(\{\s*\n\s*id: "[^"]+",\s*\n\s*label: "/g),
			0,
			'no action label is a raw string literal',
		);
	});

	test('toggle-occurrences-highlight has its own label, not Show Whitespace', () => {
		// The two actions shared `settings.showWhitespace`, so the context menu
		// listed the same entry twice and one of them silently toggled the other
		// setting.
		assert.match(
			editor,
			/id: "toggle-occurrences-highlight",\s*\n\s*label: t\('settings\.occurrencesHighlight', lang\)/,
		);
		assert.match(
			editor,
			/id: "toggle-whitespace",\s*\n\s*label: t\('settings\.showWhitespace', lang\)/,
		);
		assert.equal(
			count(editor, /label: t\('settings\.showWhitespace', lang\)/g),
			1,
			'settings.showWhitespace labels exactly one action',
		);

		for (const lang of supported) {
			const occurrences = t('settings.occurrencesHighlight', lang as LanguageCode);
			const whitespace = t('settings.showWhitespace', lang as LanguageCode);
			// Same substitution as above: `occurrences !== 'settings.occurrencesHighlight'`
			// only ever failed if English lacked the key, which the assertions at the
			// top of this test already cover.
			assert.ok(defines(lang as LanguageCode, 'settings.occurrencesHighlight'), `translated for ${lang}`);
			assert.ok(defines(lang as LanguageCode, 'settings.showWhitespace'), `translated for ${lang}`);
			assert.notEqual(
				occurrences,
				whitespace,
				`the two context-menu entries are distinguishable in ${lang}`,
			);
		}
	});

	test('no two actions share a label within a language', () => {
		// A duplicated label is indistinguishable from a duplicated menu entry from
		// the user's side, which is exactly how ED-6 presented.
		const labelKeys = [...editor.matchAll(/label: t\('([^']+)', lang\)/g)].map((m) => m[1]);
		assert.ok(labelKeys.length > 30, 'the localized action set was found');
		assert.equal(new Set(labelKeys).size, labelKeys.length, 'each action uses a distinct key');

		for (const lang of supported) {
			const labels = labelKeys.map((key) => t(key, lang as LanguageCode));
			const seen = new Map<string, string>();
			for (const [index, label] of labels.entries()) {
				const previous = seen.get(label);
				assert.equal(
					previous,
					undefined,
					`${lang}: "${label}" is used by both ${previous} and ${labelKeys[index]}`,
				);
				seen.set(label, labelKeys[index]);
			}
		}
	});

	test('actions are re-registered when the UI language changes', () => {
		// The labels used to be baked in at mount, so switching language left the
		// editor's context menu in the previous one until the app restarted.
		assert.match(
			editor,
			/function registerLocalizedActions\(lang: LanguageCode\)/,
			'registration is a function of the language, not of mount time',
		);
		assert.match(
			editor,
			/\$effect\(\(\) => \{\s*\n\s*const lang = settings\.language;/,
			'an effect tracks settings.language',
		);
		assert.match(
			editor,
			/registerLocalizedActions\(lang\);\s*\n\s*return disposeLocalizedActions;/,
			'the effect cleanup disposes the previous registration',
		);

		// `addAction` returns an IDisposable; re-registering an id without disposing
		// leaves a duplicate entry in the context menu.
		assert.match(
			editor,
			/function disposeLocalizedActions\(\) \{[\s\S]*?for \(const action of localizedActions\) action\.dispose\(\);/,
			'every disposable is released',
		);
		assert.match(
			editor,
			/function registerLocalizedActions\(lang: LanguageCode\) \{[\s\S]{0,400}?disposeLocalizedActions\(\);/,
			'registration disposes before it rebuilds',
		);
		assert.match(editor, /onDestroy\(disposeLocalizedActions\)/, 'teardown releases them too');

		// The old design read a `uiLanguage` snapshot captured inside onMount. The
		// narrower "no label is still bound to the snapshot" count that used to
		// follow this line is gone: it counted occurrences of a pattern containing
		// `uiLanguage`, so the line above has to pass for it to be reached and,
		// once it has, the count is zero by construction. There is no state of the
		// component in which it, and not the line above, is the failure.
		assert.doesNotMatch(editor, /uiLanguage/, 'no captured language snapshot remains');
	});

	test('no action id is registered more than once', () => {
		const ids = [...editor.matchAll(/addAction\(\{\s*\n\s*id: "([^"]+)"/g)].map((m) => m[1]);
		assert.ok(ids.length > 30, 'the action set was found');
		assert.equal(new Set(ids).size, ids.length, 'action ids are unique');
	});
});

// Editor.svelte translates the settings store into Monaco options and
// keybindings. Every regression locked here came from that translation layer
// being wired to the wrong shape: a string option read as a boolean, a
// modifier that macOS never delivers, one key bound twice, and a native
// behaviour dropped by the action that replaced it.
describe('editor option wiring', () => {
	const editor = readSource('src/lib/components/Editor.svelte');

	const settingsStore = readSource('src/lib/stores/settings.svelte.ts');

	function count(source: string, pattern: RegExp): number {
		return source.match(pattern)?.length ?? 0;
	}

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

	test('an option a setting can change is one `updateOptions` re-applies', () => {
		// `smoothScrolling` used to be a bare `true` in the creation literal, where
		// options that are set once and never re-applied live. Left there, the
		// toggle would have taken effect only on a newly created editor — the same
		// shape as the `fontSize` divergence this file was written for.
		assert.doesNotMatch(
			editor,
			/smoothScrolling/,
			'smoothScrolling is spelled in the component again, outside the set the update effect re-applies',
		);
	});

	test('renderLineHighlight is a Monaco string enum, not a boolean flag', () => {
		// The store holds 'line' / 'none'. Any non-empty string is truthy, so a
		// ternary on it can only ever produce "line" and silently defeats both the
		// line-highlight toggle and Zen mode (which sets it to 'none').
		assert.match(settingsStore, /renderLineHighlight = \$state\('line'\)/);
		assert.match(settingsStore, /this\.renderLineHighlight = this\.renderLineHighlight === 'line' \? 'none' : 'line'/);
		assert.match(settingsStore, /this\.renderLineHighlight = 'none'/, 'zen mode sets the string to none');

		// Both stored values have to survive the trip. A ternary passes for 'line'
		// and fails for 'none', which is why one evaluation cannot judge this.
		for (const stored of ['line', 'none'] as const) {
			assert.equal(
				editorOptionsFromSettings({ ...SETTINGS, renderLineHighlight: stored }, 100).renderLineHighlight,
				stored,
				`the stored string ${stored} is forwarded unchanged`,
			);
			assert.equal(
				(createdEditorOptions({ renderLineHighlight: stored }) as { renderLineHighlight?: string })
					.renderLineHighlight,
				stored,
				`and reaches the created editor as ${stored}`,
			);
		}
	});

	test('editor options are applied by a single updateOptions effect', () => {
		// Two competing effects (one nested in onMount, one top level) wrote the
		// same Monaco options with different values — notably fontSize with and
		// without the zoom factor — so the winner depended on effect ordering.
		assert.equal(count(editor, /editor\.updateOptions\(/g), 1, 'exactly one updateOptions call site');

		// What that one call applies, evaluated rather than read: every option the
		// two effects used to fight over, and the zoom-aware font size that was the
		// value they disagreed on.
		const applied = editorOptionsFromSettings({ ...SETTINGS, editorFontSize: 20, editorMaxWidth: 90 }, 150);
		assert.equal(applied.fontSize, 30, 'the surviving font size carries the zoom factor');
		assert.equal(applied.wordWrapColumn, 90, 'wordWrapColumn survived the merge');
		assert.deepEqual(
			Object.keys(applied).sort(),
			[
				'cursorSmoothCaretAnimation',
				'cursorSurroundingLines',
				'cursorSurroundingLinesStyle',
				'fontFamily',
				'fontSize',
				'lineDecorationsWidth',
				'lineNumbers',
				'minimap',
				'occurrencesHighlight',
				'renderLineHighlight',
				'renderWhitespace',
				'selectionHighlight',
				'smoothScrolling',
				'wordWrap',
				'wordWrapColumn',
				'wrappingStrategy',
			],
			'and the set is exactly the options both call sites share',
		);
	});

	test('the editor has its final layout before anything is placed in it', () => {
		// #799: the view state, the anchor line and Ctrl+E's pending sync are all
		// placed in `onMount`, before the update effect first runs. The editor was
		// created at zoom 100 and with 'simple' wrapping, and the effect then
		// changed the font size or the wrapping under a placed scroll offset.
		// Monaco keeps the pixels, not the line, so every Ctrl+E landed further
		// down (zoom below 100, or a proportional font) or further up (above 100).
		const mount = sliceBetween(editor, 'monaco.editor.create(container', 'editorReady = true;');
		assert.match(mount, /\.\.\.editorOptionsFromSettings\(settings, zoomLevel\)/, 'created at the real zoom');

		const measured = mount.indexOf('if (!fontIsMonospace) applySettingsOptions();');
		const restored = mount.indexOf('editor.restoreViewState(');
		assert.ok(measured !== -1, 'the wrapping for a proportional font is applied in onMount');
		assert.ok(measured < restored, 'and before the view state is restored');
		assert.ok(
			editor.indexOf('editorReady = true;') < editor.indexOf('if (pendingSync) {'),
			'the pending sync is spent after both',
		);
	});

	test('the editor mounts on the cursor the preview placed', () => {
		// #799: a click in the preview moves the tab's shared cursor, and opening
		// split view or Ctrl+E mounts the editor with its own saved view state.
		// The shared cursor goes down over it before the editor reports where it
		// is, or the report would carry the stale position back to the preview.
		const mount = sliceBetween(editor, 'monaco.editor.create(container', 'editorReady = true;');
		const placed = mount.indexOf('if (sharedCursor) editor.setPosition(');
		assert.ok(placed !== -1, 'the shared cursor is put down on mount');
		assert.ok(placed > mount.indexOf('editor.restoreViewState('), 'after the view state is restored');
		assert.ok(placed < mount.indexOf('oncursor?.(asBufferLine(mounted'), 'and before the editor reports its cursor');
	});

	test('a proportional font wraps on measured widths, a monospace font keeps the fast path', () => {
		// #758: 'simple' wrapped Times New Roman and Roboto lines well short of the
		// window edge. Both values are asserted because 'advanced' everywhere would
		// also fix the report, and would make every large file pay for it.
		assert.equal(editorOptionsFromSettings(SETTINGS, 100, true).wrappingStrategy, 'simple');
		assert.equal(editorOptionsFromSettings(SETTINGS, 100, false).wrappingStrategy, 'advanced');

		// The measurement only helps if the update effect passes it: its stub is
		// false, so a call that drops the argument falls back to 'simple' here.
		assert.equal(optionsPassedTo('editor.updateOptions', SETTINGS).wrappingStrategy, 'advanced');
	});

	test('tab cycling avoids Cmd+Tab, which macOS never delivers to the app', () => {
		// Reference frame: VS Code binds Ctrl+Tab / Ctrl+Shift+Tab with
		// KeyMod.WinCtrl on macOS (mac override on
		// workbench.action.quickOpenPreviousRecentlyUsedEditorInGroup) precisely
		// because Cmd+Tab belongs to the system application switcher.
		assert.doesNotMatch(
			editor,
			/monaco\.KeyMod\.CtrlCmd \| monaco\.KeyCode\.Tab/,
			'no unconditional CtrlCmd+Tab binding',
		);
		assert.doesNotMatch(
			editor,
			/monaco\.KeyMod\.CtrlCmd \| monaco\.KeyMod\.Shift \| monaco\.KeyCode\.Tab/,
			'no unconditional CtrlCmd+Shift+Tab binding',
		);

		// Back-reference rather than the literal `tabCycleModifier`: what has to hold
		// is that the binding uses the same value the platform check produced, and
		// the local holding it is free to be renamed.
		assert.match(
			editor,
			/const (\w+) = isMacPlatform\(\)\s*\?\s*monaco\.KeyMod\.WinCtrl\s*:\s*monaco\.KeyMod\.CtrlCmd[\s\S]*?keybindings: \[\1 \| monaco\.KeyCode\.Tab\]/,
			'modifier is chosen per platform (real Ctrl on macOS, CtrlCmd elsewhere) and tab-next uses it',
		);
		assert.match(
			editor,
			/tabCycleModifier \| monaco\.KeyMod\.Shift \| monaco\.KeyCode\.Tab/,
			'tab-prev uses the platform modifier',
		);
	});

	test('platform detection reads settings.osType and never writes it', () => {
		// `platformOf` is the app's one platform answer, including the synchronous
		// `navigator.platform` fallback that lets the keybindings register once, at
		// mount (platformSource.spec.ts tests the fallback).
		const helper = sliceBetween(editor, 'function isMacPlatform', '\n\t}');
		assert.match(helper, /platformOf\(settings\.osType\) === 'macos'/, 'asks platformOf, not a copy of it');
		assert.doesNotMatch(editor, /navigator\.platform/, 'no second platform check in Editor.svelte');

		assert.doesNotMatch(editor, /settings\.osType\s*=[^=]/, 'Editor.svelte must not write to the settings store');
	});

	test('Ctrl+S is registered exactly once, by the command-palette action', () => {
		assert.equal(count(editor, /monaco\.KeyCode\.KeyS/g), 1, 'a single Ctrl+S binding');
		assert.match(
			editor,
			/id: "file-save",[\s\S]*?keybindings: \[monaco\.KeyMod\.CtrlCmd \| monaco\.KeyCode\.KeyS\]/,
			'the surviving binding is the addAction, which also lists in the command palette',
		);
		assert.doesNotMatch(
			editor,
			/addCommand\(monaco\.KeyMod\.CtrlCmd \| monaco\.KeyCode\.KeyS/,
			'the bare addCommand duplicate is gone',
		);
	});

	test('custom copy keeps Monaco\'s whole-line copy on an empty selection', () => {
		// Reference frame: Monaco ships `emptySelectionClipboard` (documented as
		// "Copying without a selection copies the current line") on by default, and
		// its viewmodel builds that text as getLineContent(line) + EOL. VS Code
		// (editor.emptySelectionClipboard) and Sublime Text behave the same. Since
		// custom-copy overrides the native copy action, bailing out on an empty
		// selection deleted the behaviour outright.
		// The rule moved out of the copy action when cut, copy and the context
		// menu were collapsed onto one implementation (#207): all of them need it,
		// and a cut has to remove exactly what a copy would have taken.
		const forSelection = functionSource(editor, 'clipboardTextForSelection');

		assert.doesNotMatch(
			forSelection,
			/if \(!selection \|\| selection\.isEmpty\(\)\) return/,
			'an empty selection is no longer an early return',
		);
		assert.match(
			forSelection,
			/model\.getLineContent\(line\) \+ model\.getEOL\(\)/,
			'empty selection takes the current line plus its line ending',
		);
		assert.match(
			forSelection,
			/model\.getValueInRange\(selection\)/,
			'a real selection takes just the selection',
		);

		// One writer, so cut and copy cannot drift apart, and the whole-line rule
		// above cannot be implemented twice with two different answers. The third
		// call is Vim's `"+` register (#775): it writes the text monaco-vim already
		// chose, so it never derives text from a selection and cannot disagree.
		assert.equal(
			count(editor, /invoke\('clipboard_write_text'/g),
			3,
			'clipboard_write_text is called from copyToClipboard, cutToClipboard and the Vim clipboard register, nowhere else',
		);
		assert.match(
			editor,
			/installVimClipboardRegisters\(VimMode, \(text\) => \{\s*invoke\('clipboard_write_text', \{ text \}\)/,
			'the third call is the Vim register writer',
		);
		assert.match(functionSource(editor, 'copyToClipboard'), /clipboardTextForSelection\(\)/);
		assert.match(functionSource(editor, 'cutToClipboard'), /clipboardTextForSelection\(\)/);
	});

	test('Show Whitespace renders every whitespace run, not just trailing', () => {
		// The setting is labelled without qualification ("Show Whitespace" /
		// "显示空白字符"), so "trailing" left interior spaces unmarked.
		assert.doesNotMatch(editor, /renderWhitespace: settings\.showWhitespace \? "trailing"/);
		assert.doesNotMatch(editor, /"trailing"/, 'no trailing-only whitespace rendering remains');
		assert.equal(editorOptionsFromSettings({ ...SETTINGS, showWhitespace: true }, 100).renderWhitespace, 'all');
		assert.equal(editorOptionsFromSettings({ ...SETTINGS, showWhitespace: false }, 100).renderWhitespace, 'none');
		// Both call sites read the same function now, so agreeing is structural
		// rather than something a count has to police.
		assert.equal(
			(createdEditorOptions({ showWhitespace: true }) as { renderWhitespace?: string }).renderWhitespace,
			'all',
		);
	});

	// ----------------------------------------------------------------- executed
	//
	// Everything above matches Editor.svelte as text, because a keybinding and a
	// settings-driven enum cannot be exercised without a DOM. `unicodeHighlight`
	// can do better, and the weak form would be particularly bad here: asserting
	// that the string "ambiguousCharacters" occurs in the file says nothing about
	// which characters Monaco ends up outlining, which is the entire contract.
	//
	// So the option literal is lifted out of the real `monaco.editor.create` call,
	// evaluated, and pushed through the same two pieces of Monaco the running
	// editor uses — `EditorOptions.unicodeHighlight.applyUpdate` to merge it over
	// the shipped defaults, and `UnicodeTextModelHighlighter` to decide what gets a
	// box. A regression has to survive Monaco's own code to reach the assertions.

	/**
	 * The one option literal Editor.svelte passes to `callee`, evaluated against a
	 * given settings store.
	 *
	 * `settings` is a plain object rather than a fixture of the real store: an
	 * absent key reads as `undefined`, which is what a falsy setting does to every
	 * ternary in these literals anyway, so naming only the keys a test cares about
	 * keeps that test readable. It is a parameter at all because a settings-driven
	 * option cannot be judged from one evaluation — wiring that is right for one
	 * value of a setting and wrong for the other is the defect shape this whole
	 * file exists for.
	 */
	function optionsPassedTo(callee: string, settings: Record<string, unknown> = {}): Record<string, unknown> {
		const script = sliceBetween(editor, '<script lang="ts">', '</script>');
		const source = ts.createSourceFile('Editor.ts', script, ts.ScriptTarget.Latest, true);

		const literals: ts.Expression[] = [];
		const visit = (node: ts.Node): void => {
			if (ts.isCallExpression(node) && node.expression.getText(source) === callee) {
				assert.equal(
					node.arguments.length,
					callee === 'monaco.editor.create' ? 2 : 1,
					`${callee} takes the options object last`,
				);
				literals.push(node.arguments[node.arguments.length - 1]);
			}
			ts.forEachChild(node, visit);
		};
		visit(source);

		// Also the check that this file is looking at the only editor in the app: a
		// second `create` call would need the same options and would not be covered
		// by anything below. The same holds for a second `updateOptions`, which is
		// the effect race #369 removed.
		assert.equal(literals.length, 1, `exactly one ${callee} call site in Editor.svelte`);

		// Bound to a name, not returned as an expression: TypeScript 6 prefixes the
		// output with "use strict", and `return ${js}` would return that string.
		const js = ts.transpileModule(`const options = (${literals[0].getText(source)});`, {
			compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
		}).outputText;

		// The literals close over eight locals and one import, stubbed rather than
		// reconstructed — except the import, which is the real function: the
		// settings-derived options live there now, and stubbing them would leave
		// the evaluated object missing exactly what these tests read.
		// `documentOptions` is the spread that hands the editor the active tab's
		// model (or `value`/`language` when there is no tab); an empty object is the
		// right stub because nothing it can contain is an option this file asserts
		// on. `zoomLevel` is 100, the neutral factor, for the same reason.
		// `fontIsMonospace` is false, the opposite of the parameter's default, so a
		// literal that forgets to pass it is visible. `readOnly` is false, the
		// editor on a whole buffer.
		return new Function(
			'settings',
			'value',
			'language',
			'getTheme',
			'documentOptions',
			'zoomLevel',
			'fontIsMonospace',
			'editorOptionsFromSettings',
			'readOnly',
			`${js}\nreturn options;`,
		)(settings, '', 'markdown', () => 'app-theme-dark', {}, 100, false, editorOptionsFromSettings, false) as Record<
			string,
			unknown
		>;
	}

	/** The options object Editor.svelte hands to `monaco.editor.create`, evaluated. */
	function createdEditorOptions(settings: Record<string, unknown> = {}): Record<string, unknown> {
		return optionsPassedTo('monaco.editor.create', { ...SETTINGS, ...settings });
	}

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
		return option.applyUpdate(option.defaultValue, passed ?? {}).newValue;
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

	test('the editor narrows the Unicode highlighter without switching it off', () => {
		// Reports #186 and #94 are both Monaco outlining fullwidth punctuation.
		// Narrowness is the assertion: `unicodeHighlight: false`, or turning
		// `invisibleCharacters` off, would also make the boxes go away and would
		// take the NBSP warning with it. Two overrides are allowed, and only two:
		// the confusable rule off, and one character exempted from the invisible
		// rule (#393 — U+3000 is the space bar under a CJK IME).
		const options = createdEditorOptions();
		assert.deepEqual(
			Object.keys(options.unicodeHighlight as object).sort(),
			['allowedCharacters', 'ambiguousCharacters'],
			'no third sub-option, and invisibleCharacters is not among them',
		);
		assert.equal((options.unicodeHighlight as UnicodeHighlightOptions).ambiguousCharacters, false);
		assert.deepEqual(
			(options.unicodeHighlight as { allowedCharacters: Record<string, true> }).allowedCharacters,
			{ '　': true },
			'exactly one character is exempted',
		);
	});

	test('no box is drawn on fullwidth CJK punctuation', () => {
		const effective = effectiveUnicodeHighlight(createdEditorOptions().unicodeHighlight);
		const found = outlined(CJK_PROSE, effective);
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
		// after `-` stops a list from parsing — and unlike the punctuation it is
		// never something the author typed on purpose. Turning the whole feature
		// off would have taken it with it.
		const effective = effectiveUnicodeHighlight(createdEditorOptions().unicodeHighlight);
		assert.equal(effective.invisibleCharacters, true, 'left at the Monaco default');

		const found = outlined(['a b', 'x​z'], effective);
		assert.equal(found.invisibleCharacterCount, 2, 'NBSP and zero-width space are still flagged');
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

	test('the space bar under a CJK IME is not outlined', () => {
		const effective = effectiveUnicodeHighlight(createdEditorOptions().unicodeHighlight);
		const found = outlined(CJK_IDEOGRAPHIC_SPACE, effective);
		assert.equal(
			found.ranges.length,
			0,
			`nothing outlined around U+3000, got ${JSON.stringify(
				found.ranges.map((r) => CJK_IDEOGRAPHIC_SPACE[r.startLineNumber - 1]),
			)}`,
		);
	});

	test('exempting U+3000 does not exempt the NBSP that breaks a list', () => {
		// The narrow exemption has to stay narrow: an NBSP after `-` stops the list
		// from parsing, and that is why invisibleCharacters is still on.
		const effective = effectiveUnicodeHighlight(createdEditorOptions().unicodeHighlight);
		const found = outlined(['-\u00a0item', '\u4eca\u5929\u3000\u5929\u6c14'], effective);
		assert.equal(found.invisibleCharacterCount, 1, 'the NBSP is flagged, the U+3000 is not');
		assert.equal(found.ranges[0].startLineNumber, 1, 'and it is the NBSP line');
	});

	// ------------------------------------------------- the defaults left in force
	//
	// Everything above is an option Editor.svelte was passing wrongly. The two
	// below are options it was not passing at all, so `monaco.editor.create`'s
	// default was deciding — and deciding against something the app states
	// elsewhere.
	//
	// Both are read through the option's own `validate`, the function the real
	// `create` runs over what it is handed. That is not ceremony: `validate`
	// silently returns the option's *default* for anything outside its accepted
	// set, so `"Off"`, `0`, or an enum member renamed in a Monaco upgrade would
	// leave the editor exactly as it is today while an `assert.equal` on the
	// literal stayed green.

	/**
	 * What both occurrence-highlighting options resolve to, for one value of the
	 * one setting that is supposed to drive them.
	 */
	function occurrenceHighlighting(
		callee: string,
		occurrencesHighlight: boolean,
	): { occurrencesHighlight: string; selectionHighlight: boolean } {
		// The full fixture, not the one setting under test: `editorOptionsFromSettings`
		// reads the chosen font family now, and a stub missing it is a `string` field
		// that is `undefined` — a shape the type forbids and production cannot hand it.
		const options = optionsPassedTo(callee, { ...SETTINGS, occurrencesHighlight });
		return {
			occurrencesHighlight: EditorOptions.occurrencesHighlight.validate(options.occurrencesHighlight),
			selectionHighlight: EditorOptions.selectionHighlight.validate(options.selectionHighlight),
		};
	}

	test('"Highlight Occurrences" off leaves nothing highlighting occurrences', () => {
		// The setting (`settings.occurrencesHighlight`, default false, labelled
		// "Highlight Occurrences" / 高亮匹配项 / 一致箇所の強調) drove Monaco's
		// `occurrencesHighlight` alone. Monaco splits the feature in two:
		// `SelectionHighlighter` gates itself on `selectionHighlight` and consults
		// `occurrencesHighlight` only to choose which decoration style to draw with.
		// So at the setting's own default, selecting a word still highlighted every
		// other copy of it — the promise the label makes was kept by half the
		// editor.
		//
		// Both call sites, because they can disagree: two effects writing one option
		// with different values is what #369 found in `fontSize`, and an option set
		// only at construction stops tracking the setting the moment a user toggles
		// it.
		for (const callee of ['monaco.editor.create', 'editor.updateOptions']) {
			assert.deepEqual(
				occurrenceHighlighting(callee, false),
				{ occurrencesHighlight: 'off', selectionHighlight: false },
				`${callee}: with the setting off both occurrence highlighters must be off — ` +
					'selectionHighlight is the one SelectionHighlighter actually gates on',
			);
			assert.deepEqual(
				occurrenceHighlighting(callee, true),
				{ occurrencesHighlight: 'singleFile', selectionHighlight: true },
				`${callee}: with the setting on the same one switch must turn both on`,
			);
		}
	});

	test('the editor does not offer to rewrite a document containing U+2028', () => {
		// `unusualLineTerminators` defaults to 'prompt'. On 'prompt',
		// UnusualLineTerminatorsDetector calls IDialogService.confirm, which in a
		// standalone build is StandaloneDialogService — `mainWindow.confirm(...)`,
		// an unstyled browser dialog carrying Monaco's English string, inside an app
		// whose own UI ships 26 locales, offering to delete characters out of the
		// user's file. The guard exists to protect JavaScript string literals, which
		// U+2028 and U+2029 terminate; Markdown has no such hazard.
		//
		// 'auto' is not the alternative: it makes the same edit with no dialog.
		assert.equal(
			EditorOptions.unusualLineTerminators.validate(createdEditorOptions().unusualLineTerminators),
			'off',
			'the detector must return early instead of reaching the dialog',
		);

		// The default this moves away from, and the reason the assertion above is
		// not spelled against the literal: anything Monaco does not recognise
		// resolves straight back to the dialog.
		assert.equal(EditorOptions.unusualLineTerminators.validate(undefined), 'prompt');
		assert.equal(EditorOptions.unusualLineTerminators.validate('never'), 'prompt');
		assert.equal(EditorOptions.unusualLineTerminators.validate('Off'), 'prompt');
	});
});

// The editor's Markdown colours. Two things can make a rule here do nothing at
// all, and neither is visible to the compiler: a token name no grammar emits
// (#676's defect, one layer over), and a colour that has drifted from the one
// the rest of the app resolves through `--color-*`.
describe('editor theme contracts', () => {
	const styles = readSource('src/styles.css');

	/** A `--color-*` value, read out of the block that defines the given appearance. */
	function paletteColor(appearance: 'light' | 'dark', name: string): string {
		const block = appearance === 'dark'
			? styles.slice(styles.indexOf(':root[data-theme="dark"] {'))
			: styles.slice(styles.indexOf(':root {'));
		const match = block.match(new RegExp(`--color-${name}:\\s*(#[0-9a-fA-F]{6})`));
		assert.ok(match, `styles.css must define --color-${name} for ${appearance}`);
		return match[1].slice(1).toLowerCase();
	}

	test('the colours are the app palette, not a second one', () => {
		// One-way duplication: `defineTheme` takes hex strings and never sees the
		// stylesheet, so the literals in editorTheme.ts have to be checked against
		// the custom properties everything else in the app resolves.
		const expected = {
			accent: 'accent-fg',
			code: 'success-fg',
			emphasis: 'attention-fg',
			link: 'done-fg',
			muted: 'fg-muted',
			text: 'fg-default',
		};

		for (const appearance of ['light', 'dark'] as const) {
			const byToken = new Map(markdownTokenRules(appearance).map((rule) => [rule.token, rule.foreground]));
			assert.equal(byToken.get('keyword.md'), paletteColor(appearance, expected.accent));
			assert.equal(byToken.get('string.md'), paletteColor(appearance, expected.code));
			assert.equal(byToken.get('variable.md'), paletteColor(appearance, expected.code));
			assert.equal(byToken.get('strong.md'), paletteColor(appearance, expected.emphasis));
			assert.equal(byToken.get('emphasis.md'), paletteColor(appearance, expected.emphasis));
			assert.equal(byToken.get('string.link.md'), paletteColor(appearance, expected.link));
			assert.equal(byToken.get('escape.md'), paletteColor(appearance, expected.muted));
			assert.equal(byToken.get('variable.source.md'), paletteColor(appearance, expected.text));
			assert.equal(byToken.get('keyword.table.header.md'), paletteColor(appearance, expected.text));
		}
	});

	test('the editor pane and the theme importer are the only writers', () => {
		assert.deepEqual(filesMatching(readSourceFiles('src'), /\.editor\.setTheme\(/), [
			// The widget's owner: it defines `app-theme-*` and it is the only thing
			// on screen a Monaco theme can be seen on.
			'src/lib/components/Editor.svelte',
			// `vscode-custom` does not exist as a theme until this file has read the
			// JSON and called `defineTheme`, so the set has to happen where the
			// define does — `Editor.svelte`'s change effect abstains for `vscode:`.
			'src/lib/utils/theme.ts',
		]);
	});

	test('every name the seam returns is a theme somebody defines', () => {
		const defined = [
			readSource('src/lib/components/Editor.svelte'),
			readSource('src/lib/utils/theme.ts'),
		]
			.flatMap((text) => [...text.matchAll(/\.editor\.defineTheme\(\s*["']([\w-]+)["']/g)])
			.map((match) => match[1]);
		const asked = ['system', 'light', 'dark', 'vscode:whatever'].map((theme) => [
			monacoThemeName(theme, false),
			monacoThemeName(theme, true),
		]);
		for (const name of new Set(asked.flat())) {
			assert.ok(defined.includes(name), `nothing defines ${name}; Monaco would fall back to vs`);
		}
	});
});

/*
 * Every edit the app makes on the user's behalf is its own undo step.
 *
 * `editor.executeEdits` does not close the undo element that typing left open:
 * it goes straight to `model.pushEditOperations`, which appends to it. Typing
 * `hello`, pasting `world` and pressing Cmd+Z therefore took both away. That was
 * checked against the installed Monaco (0.55.1) in jsdom before this was
 * written: without a stop the second undo emptied the buffer, with one it left
 * `hello`. Monaco's own paste and cut push the stop themselves; these are the
 * app's replacements for them, and for the format tools, so they have to as
 * well. The stop goes BEFORE the edit: what is typed after it opens a new
 * element on its own, which the same probe showed.
 */
describe('editor undo stops', () => {
	const EDITOR = 'src/lib/components/Editor.svelte';

	test('the format tools each push an undo stop before they edit', () => {
		for (const name of ['insertTextAtCursor', 'wrapAsCodeBlock', 'insertLink']) {
			const run = runEditorHandler([name], { lines: ['hello'], selections: [[1, 1, 1, 6]] });
			assert.equal(run.edits.length, 1, name);
			assert.equal(run.undoStops, 1, `${name} edits inside the undo step typing left open`);
		}
	});

	test('no executeEdits in the editor runs without an undo stop ahead of it in its function', () => {
		// Paste, cut and the drop handler read the clipboard or the disk through
		// Tauri first, so they cannot be run here; what is pinned for them, and for
		// every site added later, is that the stop comes before the edit.
		const source = readSource(EDITOR);
		const missing: string[] = [];
		let at = -1;
		while ((at = source.indexOf('editor.executeEdits(', at + 1)) !== -1) {
			const name = enclosingFunctionName(source, at);
			assert.ok(name, `an executeEdits outside any named function at offset ${at}`);
			const start = source.lastIndexOf(name, at);
			if (!source.slice(start, at).includes('editor.pushUndoStop()')) {
				missing.push(`${name} (line ${source.slice(0, at).split('\n').length})`);
			}
		}
		assert.deepEqual(missing, []);
	});
});

// The build-time patch to Monaco that stops the IME composition overlay from
// jittering (#724). See the header of monacoImePatch.mjs for the mechanism.
//
// These are text assertions against the INSTALLED Monaco, and they say so:
// the contract being pinned is that the two source lines the patch anchors on
// still exist exactly once in the file it targets. A Monaco bump that moves or
// rewrites either line — including the bump that finally carries the upstream
// fix, microsoft/vscode#333909 — turns this red, which is the signal to delete
// the patch rather than let it silently stop applying.
describe('Monaco IME patch', () => {
	// Through `readSource`, like every other test that reads a file: the anchors
	// are written against `\n`, and it is what keeps them matching on a Windows
	// checkout (see singleImplementationConvention.test.ts).
	const textAreaSource = readSource(
		new URL(`../node_modules/monaco-editor/esm/vs/editor/browser/controller/editContext/textArea/${MONACO_TEXTAREA_FILE}`, import.meta.url),
	);

	test('both anchors match the installed Monaco exactly once', () => {
		for (const { from } of MONACO_IME_PATCH) {
			assert.equal(textAreaSource.split(from).length - 1, 1, `anchor ${JSON.stringify(from.trim())}`);
		}
	});

	test('the patch turns both conditions into "unless a screen reader is attached"', () => {
		const patched = patchMonacoTextAreaForIme(textAreaSource);
		for (const { from, to } of MONACO_IME_PATCH) {
			assert.equal(patched.includes(from), false, 'the original condition is gone');
			assert.equal(patched.split(to).length - 1, 1, 'the replacement is there once');
		}
		// Nothing else moved: the patch is those two lines and no more.
		assert.equal(patched.length, textAreaSource.length + MONACO_IME_PATCH.reduce((n, p) => n + p.to.length - p.from.length, 0));
	});

	test('a Monaco that no longer has the anchors fails the build instead of shipping unpatched', () => {
		assert.throws(
			() => patchMonacoTextAreaForIme(textAreaSource.replace(MONACO_IME_PATCH[0].from, '')),
			/expected exactly one match/,
		);
	});
});

// Monaco is ~86% of Markpad's startup JavaScript (measured: a 4.4 MB chunk out
// of 4.7 MB on first paint, ~360ms of parse+eval, paid once per window because
// every window is its own webview) and a reader who only ever views Markdown
// never touches it. It is therefore loaded with `await import()` from
// Editor.svelte's `onMount`, not with a top-level `import`.
//
// WHAT THIS FILE PROVES: walking only *static* imports from the app's entry
// module (`src/routes/+page.svelte`), no reachable module names `monaco-editor`
// or `monaco-vim` as a static import. That is the property a bundler turns into
// "not in the startup chunk", and it is the property a careless edit destroys —
// re-adding `import * as monaco from 'monaco-editor'` anywhere in the reachable
// graph, in Editor.svelte or in any util it pulls in, fails this test.
//
// WHAT IT DOES NOT PROVE: that Rollup actually emitted a separate chunk. Chunk
// splitting is the bundler's decision, and `vite.config.js` could still be
// changed to inline everything (e.g. a `manualChunks` that merges it, or
// `inlineDynamicImports`). Verifying that needs a real build; the numbers from
// one are recorded in the PR description instead. Source-level reachability is
// the half that can run in CI without a 45-second build, so it is the half
// that is locked here.
//
// Type-only imports (`import type ...`) are deliberately ignored: TypeScript
// erases them, so they cost nothing at runtime and Editor.svelte relies on one.
describe('Monaco startup graph', () => {
	const ENTRY = 'src/routes/+page.svelte';

	const FORBIDDEN = ['monaco-editor', 'monaco-vim'];

	/** `import ... from 'x'`, `export ... from 'x'`, and bare `import 'x'`. */
	const STATIC_IMPORT = /(?:^|[\s;}])(?:import|export)\s+(?!type\s)(?:[^'"();]*?\sfrom\s*)?['"]([^'"]+)['"]/g;

	/** `import type ... from 'x'` / `export type ... from 'x'` — erased at compile time. */
	const TYPE_IMPORT = /\b(?:import|export)\s+type\s[^'"();]*?from\s*['"][^'"]+['"]/g;

	/**
	 * The part of `file` that can carry an import, read through `readSource`.
	 *
	 * A filter on top of the shared reader rather than a reader of its own — it was
	 * spelled `readSource` here first, with its own `readFileSync` inside, which is
	 * how this file ended up with a private copy of the line-ending decision.
	 */
	function importableSource(file: string): string {
		const raw = readSource(file);
		if (!file.endsWith('.svelte')) return raw;
		// Only the <script> blocks can import; the markup and <style> cannot.
		return [...raw.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]).join('\n');
	}

	/**
	 * Specifiers of the statements that survive to runtime.
	 *
	 * Type-only statements are deleted from the text before matching rather than
	 * subtracted from the result set afterwards. Subtracting by specifier string is
	 * what a first draft of this file did, and it had a hole big enough to drive the
	 * regression through: Editor.svelte imports `monaco-editor` for its types, so a
	 * `import * as monaco from "monaco-editor"` added next to it would have been
	 * cancelled out by its own type import and reported clean.
	 */
	function staticSpecifiers(source: string): string[] {
		const runtimeOnly = source.replace(TYPE_IMPORT, '');
		return [...runtimeOnly.matchAll(STATIC_IMPORT)].map((m) => m[1]);
	}

	/**
	 * Resolve a specifier to a file on disk, or `null` for a bare package name.
	 * SvelteKit sources use the `.js` extension for relative TypeScript imports, so
	 * `./x.js` has to be probed as `./x.ts` too.
	 */
	function resolveLocal(specifier: string, fromFile: string): string | null {
		let target: string;
		if (specifier.startsWith('.')) target = resolve(dirname(fromFile), specifier);
		else if (specifier.startsWith('#lib/')) target = resolve('src/lib', specifier.slice('#lib/'.length));
		else if (specifier.startsWith('$app/') || !specifier.startsWith('/')) return null;
		else return null;

		const candidates = [
			target,
			target.replace(/\.js$/, '.ts'),
			target.replace(/\.js$/, '.svelte.ts'),
			`${target}.ts`,
			`${target}.js`,
			`${target}.svelte`,
		];
		return candidates.find((c) => existsSync(c) && !c.endsWith('/')) ?? null;
	}

	function walkStaticGraph(entry: string): Map<string, string[]> {
		const reached = new Map<string, string[]>();
		const queue = [resolve(entry)];

		while (queue.length > 0) {
			const file = queue.pop()!;
			if (reached.has(file)) continue;

			const specifiers = staticSpecifiers(importableSource(file));
			reached.set(file, specifiers);

			for (const specifier of specifiers) {
				const local = resolveLocal(specifier, file);
				if (local) queue.push(local);
			}
		}

		return reached;
	}

	test('the parser sees the imports it is supposed to see', () => {
		// A graph walk that silently resolves nothing would pass this file forever.
		const graph = walkStaticGraph(ENTRY);
		const files = [...graph.keys()].map((f) => relative(process.cwd(), f).replace(/\\/g, '/'));

		assert.ok(files.includes('src/lib/MarkdownViewer.svelte'), 'reached the viewer from the entry');
		assert.ok(files.includes('src/lib/components/Editor.svelte'), 'reached Editor.svelte, which is still statically imported');
		assert.ok(files.includes('src/lib/stores/settings.svelte.ts'), 'followed a #lib specifier with a .js extension');
		assert.ok(files.length > 30, `walked a real graph, not a stub (got ${files.length} files)`);

		// The negative check below is only meaningful if a static Monaco import
		// would in fact be seen. Plant the exact regressions this file exists to
		// catch and prove the matcher reports each one.
		assert.deepEqual(
			staticSpecifiers('import * as monaco from "monaco-editor";'),
			['monaco-editor'],
			'a static Monaco import is detected when present',
		);
		assert.deepEqual(
			staticSpecifiers('import type * as Monaco from "monaco-editor";'),
			[],
			'a type-only import is erased at compile time and does not count',
		);
		assert.deepEqual(
			// The shape Editor.svelte actually has: the type import stays, and a
			// value import of the same module is added beside it.
			staticSpecifiers(
				'import type * as Monaco from "monaco-editor";\nimport * as monaco from "monaco-editor";',
			),
			['monaco-editor'],
			'a value import is not masked by a type import of the same module',
		);
		assert.deepEqual(
			staticSpecifiers('const monaco = await import("monaco-editor");'),
			[],
			'a dynamic import is not a static one',
		);
	});

	test('Monaco is not reachable by static import from the app entry', () => {
		const graph = walkStaticGraph(ENTRY);

		const offenders: string[] = [];
		for (const [file, specifiers] of graph) {
			for (const specifier of specifiers) {
				if (FORBIDDEN.some((pkg) => specifier === pkg || specifier.startsWith(`${pkg}/`))) {
					// Vite's `?worker` imports compile to a URL plus a `new Worker(url)`
					// wrapper and emit the worker bundle as its own file, so they are
					// already lazy — verified against a production build: zero worker
					// requests on first paint.
					if (specifier.endsWith('?worker')) continue;
					offenders.push(`${relative(process.cwd(), file)} -> ${specifier}`);
				}
			}
		}

		assert.deepEqual(
			offenders,
			[],
			'Monaco must be reached with await import(), never a static import, or it lands back in the startup chunk',
		);
	});

	test('Editor.svelte loads Monaco with a dynamic import', () => {
		const editor = readSource('src/lib/components/Editor.svelte');

		assert.match(
			editor,
			/monaco = await import\("monaco-editor"\)/,
			'the module is fetched on mount',
		);
		assert.match(
			editor,
			/import type \* as Monaco from "monaco-editor"/,
			'types come from a type-only import, which is erased',
		);

		// `onMount` must stay synchronous: Svelte only accepts a synchronously
		// returned function as the unmount cleanup, so an `async` callback would
		// hand it a promise and leak the editor and its listeners.
		assert.doesNotMatch(editor, /onMount\(async/, 'onMount is not async');
		assert.match(editor, /cancelled = true;/, 'an in-flight import is cancellable on unmount');
	});

	test('every effect that drives the editor waits for editorReady', () => {
		// `editor` is a plain `let`, assigned after an await. An effect gated on it
		// alone runs once against nothing and is never re-triggered, which silently
		// drops scroll sync, the zoom-aware font size, the theme and Vim mode.
		const editor = readSource('src/lib/components/Editor.svelte');

		// The bodies come from the parsed component, not from
		// `/\$effect\(\(\) => \{([\s\S]*?)\n\t\}\);/`. That pattern needed a
		// tab-indented `});` to end a body, so an effect written on one line had no
		// terminator of its own and the lazy match ran on to the *next* effect's —
		// returning the two as a single body whose text contains the `editorReady`
		// the first half was missing. Measured, by planting
		// `$effect(() => { if (editor) editor.layout(); });` in Editor.svelte: the
		// ungated read passed, and `effects.length >= 5` did not notice because the
		// merge kept the count at six. scripts/sourceTree.test.ts pins that form.
		const effects = callbackBodies(editor, '$effect');

		// Vacuity guard, restated so it cannot be satisfied by a body going missing:
		// the parse must account for every `$effect` the file spells.
		const spelled = (editor.match(/\$effect\s*\(/g) ?? []).length;
		assert.equal(effects.length, spelled, `every $effect(…) yielded a body (spelled ${spelled})`);
		assert.ok(effects.length >= 5, `found the effects (got ${effects.length})`);

		for (const body of effects) {
			if (!/\beditor\b/.test(body)) continue;
			assert.match(
				body,
				/editorReady/,
				`an effect touching the editor is not gated on editorReady:\n${body.slice(0, 160)}`,
			);
		}
	});

	test('no source file outside Editor.svelte reintroduces a static Monaco import', () => {
		// Belt and braces for modules the graph walk cannot reach statically (a file
		// only pulled in through a dynamic import elsewhere): grep the whole tree.
		const offenders: string[] = [];

		for (const path of walkSourceFiles('src')) {
			for (const specifier of staticSpecifiers(importableSource(path))) {
				if (specifier.endsWith('?worker')) continue;
				if (FORBIDDEN.some((pkg) => specifier === pkg || specifier.startsWith(`${pkg}/`))) {
					offenders.push(`${path} -> ${specifier}`);
				}
			}
		}

		assert.deepEqual(offenders, []);
	});

	test("monaco-vim's one import into monaco still resolves", () => {
		// monaco-vim 0.4.4 is the latest release and is unmaintained. It imports
		// exactly one monaco module, and without an extension:
		//
		//   monaco-editor/esm/vs/editor/editor.api
		//
		// monaco-editor 0.55 maps `"./*": "./*"` -- an identity -- so a bundler adds
		// `.js` on the filesystem and finds it. 0.56 changed it to
		// `"./*": "./esm/vs/*.js"`, which prepends a prefix the specifier already
		// carries: the path doubles to `esm/vs/esm/vs/…` and nothing is there. Once a
		// package declares `exports`, a resolver may not fall back to the filesystem
		// path it would otherwise have used, so there is no recovery.
		//
		// The 0.56 bump built clean, passed 976 tests on three platforms, and shipped
		// vim mode dead. Nothing here loads monaco-vim, and no build step resolved it
		// strictly enough to notice. So this applies the map by hand and asks whether
		// the file is there -- which is the whole of what went wrong.
		const monacoPkg = JSON.parse(readSource('node_modules/monaco-editor/package.json'));
		const patterns = Object.entries((monacoPkg.exports ?? {}) as Record<string, unknown>).filter(
			([key]) => key.includes('*'),
		);

		// One build of the package rather than a walk of its dist: the .mjs, .cjs and
		// .umd.js are the same source through three bundlers and name the same import.
		const specifiers = new Set<string>();
		for (const match of readSource('node_modules/monaco-vim/dist/index.mjs').matchAll(
			/['"](monaco-editor\/[^'"]+)['"]/g,
		)) {
			specifiers.add(match[1]);
		}
		assert.ok(specifiers.size > 0, 'found no monaco imports in monaco-vim; this check has nothing to ask about');

		const unresolvable: string[] = [];
		for (const specifier of specifiers) {
			const subpath = `.${specifier.slice('monaco-editor'.length)}`;
			let target: string | null = null;
			for (const [pattern, value] of patterns) {
				const [before, after] = pattern.split('*');
				if (!subpath.startsWith(before) || !subpath.endsWith(after)) continue;
				const star = subpath.slice(before.length, subpath.length - after.length);
				target = String(value).replace('*', star);
				break;
			}
			if (!target) continue;
			const base = `node_modules/monaco-editor/${target.slice(2)}`;
			// The extensions a bundler will try after the map has had its say.
			if (![base, `${base}.js`, `${base}.mjs`].some((candidate) => existsSync(candidate))) {
				unresolvable.push(`${specifier} → ${target}`);
			}
		}
		assert.deepEqual(
			unresolvable,
			[],
			"monaco-editor's exports map sends a monaco-vim import somewhere that does not exist; vim mode will be dead",
		);
	});
});

/*
 * Vim's scroll-cursor family — `zz`, `zt`, `zb`, `z.`, `z-`, `z<CR>` — does
 * nothing in monaco-vim 0.4.4 (#104, #393), and `zb`/`z-` are additionally
 * swapped with respect to `:help scroll-cursor`. `utils/vimScrollCommands.ts`
 * repairs both through the package's own `Vim.defineAction`/`Vim.mapCommand`.
 *
 * WHAT RUNS HERE. The keys are *pressed*. Every test below drives real
 * keystrokes into `Vim.handleKey` on a real `CMAdapter` built from the real
 * `monaco-vim` package — the same `dist/index.mjs` Vite hands the app — and
 * then asks the editor which reveal it was told to perform. Nothing in this
 * file asserts that a source file contains a string; the closest it comes is
 * lifting Editor.svelte's own `import("monaco-vim").then` callback out of the
 * component and *running* it.
 *
 * Only `monaco-editor` is faked, and only because it cannot be imported under
 * Node: it is 4 MB of code that reaches for `document` at module scope.
 * monaco-vim imports it as two ordinary externals (`Range`, `Selection`,
 * `KeyCode`, …) rather than bundling it, so a module hook can answer those two
 * specifiers with the handful of value classes the adapter actually constructs.
 * Everything downstream of that — the keymap, the command dispatcher, the
 * action registry, `CMAdapter` itself — is upstream's own shipped code.
 *
 * WHAT IT DOES NOT ESTABLISH: that Monaco's `revealRangeInCenter` puts the line
 * where a human would call the centre, that focus and key routing reach Vim
 * mode in the running app, or anything about rendering. It establishes which
 * reveal each key sequence asks the editor for, and where the cursor ends up.
 */
describe('vim scroll commands install', () => {
	test('Editor.svelte installs the commands on the module it just imported', async () => {
		// The component's own callback, lifted and run — not read. It has to install
		// before `initVimMode` attaches the adapter, and it has to install even on
		// the disposed path, because the tables it writes to are the package's and
		// outlive this editor.
		const source = readSource('src/lib/components/Editor.svelte');
		const bodies = callbackBodies(source, 'import("monaco-vim").then');
		assert.equal(bodies.length, 1, `expected exactly one monaco-vim import callback, found ${bodies.length}`);

		const run = new Function(
			'installVimScrollCommands',
			'installVimClipboardRegisters',
			'invoke',
			'initVimMode',
			'VimMode',
			'currentEditor',
			'currentStatusNode',
			'disposed',
			`let vim = null; ${bodies[0]} return vim;`,
		) as (...args: unknown[]) => unknown;

		const calls: string[] = [];
		const VimMode = { marker: 'the module export' };
		const install = (mode: unknown) => {
			assert.equal(mode, VimMode, 'the VimMode from the same import must be the one patched');
			calls.push('install');
			return true;
		};
		const initVimMode = () => {
			calls.push('initVimMode');
			return { dispose() {} };
		};

		const written: unknown[] = [];
		const installClipboard = (mode: unknown, write: (text: string) => void) => {
			assert.equal(mode, VimMode, 'the clipboard registers go on the same module');
			calls.push('clipboard');
			write('yanked');
			return true;
		};
		const invoke = (command: string, args: unknown) => {
			written.push([command, args]);
			return Promise.resolve();
		};

		const vim = run(install, installClipboard, invoke, initVimMode, VimMode, {}, {}, false);
		assert.deepEqual(calls, ['install', 'clipboard', 'initVimMode'], 'the commands must be in place before the adapter attaches');
		assert.ok(vim, 'the adapter is still handed back for disposal');
		assert.deepEqual(written, [['clipboard_write_text', { text: 'yanked' }]], '"+ writes through the Rust clipboard');

		calls.length = 0;
		assert.ok(!run(install, installClipboard, invoke, initVimMode, VimMode, {}, {}, true), 'a disposed effect attaches nothing');
		assert.deepEqual(calls, ['install', 'clipboard'], 'a disposed effect still patches the package');
	});
});

describe('status bar height', () => {
	// The status bar sits directly above the editor, and Monaco cancels an
	// in-progress drag-selection whenever the editor's height changes
	// (`MouseHandler.onConfigurationChanged` -> `stopMonitoring`). So anything that
	// lets this bar's height follow its content ends a drag the user is still
	// making: in a narrow window the items wrapped their text the moment a
	// selection added the "N selected" item, and the selection froze two lines in
	// (#762). A rule about a height nothing computes is not a type; this is the
	// only thing that fails when someone drops `nowrap` again.
	const statusBar = sliceBetween(readSource('src/lib/components/Editor.svelte'), '\t.status-bar {', '\t}');

	test('the status bar keeps its items on one line', () => {
		assert.match(statusBar, /white-space:\s*nowrap;/);
	});

	test('the status bar clips what does not fit rather than growing', () => {
		assert.match(statusBar, /overflow:\s*hidden;/);
	});
});

// The layer that colours from the renderer's answer instead of the grammar's
// guess. Three seams, each invisible to the compiler: the kinds Rust emits
// against the legend the encoder indexes, the legend against the theme rules
// that style it, and the delta encoding Monaco decodes.
describe('semantic token contracts', () => {
	test('every kind Rust emits is in the legend', () => {
		// A kind the legend does not know is dropped by the encoder — silently, and
		// only for that construct, which is exactly the kind of gap nobody notices.
		const rust = readRustBackend();
		const emitted = new Set(
			[...rust.matchAll(/"([a-z]+)(?:\.(marker))?"\s*,?\s*out\s*\)/g)].map((match) => match[1]),
		);
		assert.ok(emitted.size > 0, 'the extractor must still name its kinds as literals');
		for (const kind of emitted) {
			assert.ok(
				(TOKEN_TYPES as readonly string[]).includes(kind),
				`semantic.rs emits \`${kind}\`, which the legend does not list`,
			);
		}
	});

	test('the editor turns the layer on, because the default is off', () => {
		// `StandaloneTheme.semanticHighlighting` is hard-coded false, so
		// `'configuredByTheme'` cannot reach it and the provider is never asked.
		const editor = readSource('src/lib/components/Editor.svelte');
		assert.match(editor, /'semanticHighlighting\.enabled': true/);
		assert.match(editor, /registerDocumentSemanticTokensProvider\(/);
	});

	test('no kind falls through to an imported theme that has nothing to say', () => {
		// The failure this guards is silent and total. A semantic token whose type
		// the theme does not name resolves to the theme's *root* rule, whose
		// foreground is a real colour id rather than "none"
		// (`semanticTokensProviderStyling.js`, the `if (tokenStyle.foreground)`
		// branch), and `sparseTokensStore` then masks the grammar's colour out and
		// paints that plain default over it. An imported theme lost its heading,
		// link, quote and inline-code colours to this path the moment the semantic
		// layer shipped, and nothing in either file said so.
		const rust = readRustBackend();
		const emitted = [
			...new Set([...rust.matchAll(/"([a-z]+(?:\.marker)?)"\s*,?\s*out\s*\)/g)].map((match) => match[1])),
		];
		assert.ok(emitted.length > 0, 'the extractor must still name its kinds as literals');

		const rules = importedThemeRules(
			[{ scope: 'markup.bold', settings: { foreground: '#e06c75', fontStyle: 'bold' } }],
			true,
		);
		// `base: 'vs-dark'` with `inherit: true` contributes the default foreground
		// that every unmatched token resolves to.
		const theme = TokenTheme.createFromParsedTokenTheme(
			parseTokenTheme([{ token: '', foreground: '#d4d4d4', background: '#1e1e1e' }, ...rules]),
			[],
		);
		const fallthrough = theme._match('a-token-no-rule-names').metadata;

		const unstyled = emitted.filter((kind) => theme._match(kind).metadata === fallthrough);
		assert.deepEqual(unstyled, [], 'these repaint an imported theme with its own default foreground');
	});
});

// #676: an imported VS Code theme colours TextMate scopes, Monaco's markdown
// tokenizer emits names of its own, and until now nothing renamed one into the
// other — so `markup.bold` reached `defineTheme` and matched nothing.
describe('markdown token colour variables', () => {
	test('every construct colour the importer writes is read by the stylesheet', () => {
		// The two halves are joined by a variable name and nothing else: the
		// importer writes `--md-strong`, `styles.css` reads it, and no type or
		// import holds them together. Renaming one silently drops the colour.
		const styles = readSource('src/styles.css');

		for (const [kind, cssVar] of PREVIEW_KIND_VARS) {
			// The comma is the fallback. Without one, a construct the theme does not
			// name renders with no colour at all rather than with the value the rule
			// carried before the import.
			assert.ok(styles.includes(`var(${cssVar},`), `${cssVar} is written for \`${kind}\` and read by no rule with a fallback`);
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
describe('image embed wiring', () => {
	test('Editor.svelte writes an image link through this module only', () => {
		// The two call sites — paste (`save_image`) and drop (`copy_file_to_img`) —
		// carried verbatim copies of this logic 300 lines apart, and the space-only
		// escape had to be fixed in both. singleImplementationConvention.test.ts
		// keeps the embed string itself single; this keeps the pre-fix escape from
		// coming back next to it.
		const source = readSource('src/lib/components/Editor.svelte');
		assert.equal(source.includes('%20'), false, 'a hand-rolled space escape is back');
		assert.match(source, /imageEmbed\(relPath\)/);
		assert.equal(source.includes(`|| "${DEFAULT_IMAGE_DIRECTORY}"`), false);
		// Three call sites read the image directory — paste, drop, and the path
		// completion that lists the folder's contents. Expanding `${filename}` at
		// two of them and not the third would offer completions out of a folder
		// named after the literal token, which exists nowhere.
		assert.equal(
			source.includes('settings.imageDirectory ||'),
			false,
			'a call site resolves the image directory itself',
		);
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
describe('paste URL guard wiring', () => {
	test('the paste path consults the context guard before building a link', () => {
		// Source-text only: this proves Editor.svelte reads this way, not that it
		// behaves this way at runtime.
		const editor = readSource('src/lib/components/Editor.svelte');

		assert.match(
			editor,
			/if \(!isUrl \|\| isMultiLine \|\| !isLinkifyPasteTarget\(model, selections\[0\]\)\) \{/,
			'the raw-text paste branch is taken when the caret is not in prose',
		);
		assert.match(
			editor,
			/tokenize: \(text\) => monaco\.editor\.tokenize\(text, MARKDOWN_LANGUAGE_ID\)/,
			'classification runs Monaco\'s own tokenizer, not a hand-rolled scan',
		);
		assert.match(
			editor,
			/linesUpToCaret: model\.getLinesContent\(\)\.slice\(0, selection\.startLineNumber\)/,
			'only the lines above the caret are tokenized',
		);
	});
});

describe('X11 clipboard ownership', () => {
	// #729: on Debian XFCE, everything copied out of Markpad reached an empty
	// clipboard, while pasting into it worked. X11 has no clipboard store — the
	// copying process owns the CLIPBOARD selection and serves the bytes on
	// request — and arboard tears that ownership down when the last `Clipboard`
	// handle drops, which was the moment `clipboard_write_text` returned.
	//
	// A source-shape assertion because the proposition cannot be run: the failure
	// needs an X server and a desktop without a clipboard manager, and CI has
	// neither. It names the helper on purpose; nothing but the call connects the
	// two, and the function exists for no other reason.
	test('the copy command keeps X11 clipboard ownership past its own return', () => {
		const body = sliceBetween(
			readSource('src-tauri/src/commands.rs'),
			'pub fn clipboard_write_text',
			'\n}',
		);
		assert.match(body, /retain_clipboard_ownership\(\)/);
	});

	test('the retained handle is never dropped', () => {
		// `retain_clipboard_ownership` holding a `Clipboard` in a local would be a
		// no-op: the point is that the handle outlives the call, so the invisible
		// window arboard serves selection requests from is never destroyed.
		const helper = sliceBetween(
			readSource('src-tauri/src/commands.rs'),
			'fn retain_clipboard_ownership',
			'\n}',
		);
		assert.match(helper, /std::mem::forget\(/);
	});
});

describe('editor context menu (#261)', () => {
	const viewer = readSource('src/lib/MarkdownViewer.svelte');

	test('a right-click in the editor gets the editor menu, before any other rule claims it', () => {
		// #261/#266 was the document menu swallowing this event: it called
		// `preventDefault()` before checking where the click was, and its
		// full-viewport overlay then covered Monaco's menu, so Paste hit the
		// overlay. The fix then was to hand the event to Monaco.
		//
		// Markpad draws this menu itself now (#207), because Monaco's Paste reads
		// the clipboard through the webview and cannot work here. So the invariant
		// is no longer "Monaco gets the event first" — it is that the editor's own
		// branch runs before every other rule in the handler.
		//
		// The ordering matters for a reason that is easy to miss: Monaco takes
		// input through a hidden `<textarea>`, so the carve-out that leaves real
		// text fields their native menu would claim every right-click in the
		// editor if it came first.
		const handler = sliceBetween(viewer, 'function handleContextMenu(e: MouseEvent)', '\n\tfunction handleMouseOver');
		const editorBranch = offsetOf(handler, "closest('.editor-container')");
		const textFieldCarveOut = offsetOf(handler, "closest('input, textarea,");
		const documentMenu = offsetOf(handler, 'e.preventDefault();');

		assert.ok(editorBranch < textFieldCarveOut, "the hidden textarea must not claim the editor's right-click");
		assert.ok(editorBranch < documentMenu, 'the editor branch runs before the document menu');
		assert.match(handler, /showEditorContextMenu\(e\);\s*\n\s*return;/, 'and it shows a menu rather than bailing out');
	});

	test('the editor menu runs the same three functions the keyboard runs', () => {
		// One implementation per operation is the whole point: six entry points
		// (three keys, three menu items) and three functions. A menu item wired to
		// its own inline implementation would drift from the shortcut silently.
		const menu = functionSource(viewer, 'showEditorContextMenu');

		for (const fn of ['cutToClipboard', 'copyToClipboard', 'pasteFromClipboard']) {
			assert.match(menu, new RegExp(`editorPane\\?\\.${fn}\\(\\)`), `${fn} is what the menu item runs`);
		}
	});

	test('the two Monaco entries this app can use survive drawing our own menu', () => {
		// Drawing the menu ourselves means every item Monaco used to contribute is
		// gone unless it is put back, and two of them work without a language
		// provider — so they were there, and vanished, and were noticed only
		// because someone went looking for them.
		//
		// The rest (Go to Symbol, Quick Fix, Refactor, Format, Rename) are gated on
		// providers Markdown has none of and never appeared in this app.
		const menu = functionSource(viewer, 'showEditorContextMenu');

		assert.match(menu, /editor\.action\.quickCommand/, 'Command Palette');
		assert.match(menu, /editor\.action\.changeAll/, 'Change All Occurrences');

		// Through the app's own translations, which is a gain rather than parity:
		// Monaco's menu is English whatever language the app is in.
		assert.match(menu, /t\('menu\.commandPalette', settings\.language\)/);
		assert.match(menu, /t\('menu\.changeAllOccurrences', settings\.language\)/);
	});

	test('every label the editor menu asks for exists in every language', () => {
		// A missing key does not throw — `t()` falls back to English and then to
		// the key itself, so a forgotten locale ships the string
		// "menu.changeAllOccurrences" to the user.
		const i18n = readDictionarySource();
		const locales = (i18n.match(/\n\s+menu: \{/g) ?? []).length;
		assert.ok(locales >= 6, `expected at least six locales, found ${locales}`);

		const menu = functionSource(viewer, 'showEditorContextMenu');
		for (const key of [...menu.matchAll(/t\('menu\.(\w+)', settings\.language\)/g)].map((m) => m[1])) {
			assert.equal(
				(i18n.match(new RegExp(`\\b${key}:`, 'g')) ?? []).length >= locales,
				true,
				`menu.${key} is missing from at least one language`,
			);
		}
	});
});
