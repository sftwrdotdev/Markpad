import assert from 'node:assert/strict';
import test from 'node:test';

import { containsUnusualLineTerminators } from 'monaco-editor/esm/vs/base/common/strings.js';
import {
	EditorOptions,
	inUntrustedWorkspace,
	type UnicodeHighlightOptions,
} from 'monaco-editor/esm/vs/editor/common/config/editorOptions.js';
import {
	UnicodeTextModelHighlighter,
	type UnicodeHighlightResult,
} from 'monaco-editor/esm/vs/editor/common/services/unicodeTextModelHighlighter.js';
import ts from 'typescript';

import { editorOptionsFromSettings } from '../src/lib/utils/editorOptions.js';
import { functionSource, readSource, sliceBetween } from './sourceTree.js';

// Editor.svelte translates the settings store into Monaco options and
// keybindings. Every regression locked here came from that translation layer
// being wired to the wrong shape: a string option read as a boolean, a
// modifier that macOS never delivers, one key bound twice, and a native
// behaviour dropped by the action that replaced it.

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
};

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
			'fontFamily',
			'fontSize',
			'lineNumbers',
			'minimap',
			'occurrencesHighlight',
			'renderLineHighlight',
			'renderWhitespace',
			'selectionHighlight',
			'wordWrap',
			'wordWrapColumn',
		],
		'and the set is exactly the options both call sites share',
	);
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
	// The `navigator.platform` fallback is deprecated but load-bearing, and it is
	// asserted here so nobody "modernises" it away. The value is frozen at
	// "MacIntel" on every Mac, arm64 included (verified on an Apple M5), so it is
	// wrong about the CPU and permanently right about the vendor — which is the
	// only thing asked of it. That is why the helper may stay synchronous and why
	// the keybindings are registered once, at mount, rather than re-registered
	// when settings.osType resolves. Full argument: the comment on
	// isMacPlatform() in Editor.svelte.
	const helper = sliceBetween(editor, 'function isMacPlatform', '\n\t}');
	assert.match(helper, /settings\.osType !== 'unknown'/, 'prefers the resolved Tauri os type');
	assert.match(helper, /settings\.osType === 'macos'/);
	assert.match(helper, /navigator\.platform/, 'falls back while osType is still resolving');

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
	// above cannot be implemented twice with two different answers.
	assert.equal(
		count(editor, /invoke\('clipboard_write_text'/g),
		2,
		'clipboard_write_text is called from copyToClipboard and cutToClipboard, nowhere else',
	);
	assert.match(functionSource(editor, 'copyToClipboard'), /clipboardTextForSelection\(\)/);
	assert.match(functionSource(editor, 'cutToClipboard'), /clipboardTextForSelection\(\)/);
});

test('Show Whitespace renders every whitespace run, not just trailing', () => {
	// The setting is labelled without qualification ("Show Whitespace" /
	// "显示空白"), so "trailing" left interior spaces unmarked.
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

	const js = ts.transpileModule(`(${literals[0].getText(source)})`, {
		compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
	}).outputText;

	// The literals close over six locals and one import, stubbed rather than
	// reconstructed — except the import, which is the real function: the
	// settings-derived options live there now, and stubbing them would leave
	// the evaluated object missing exactly what these tests read.
	// `documentOptions` is the spread that hands the editor the active tab's
	// model (or `value`/`language` when there is no tab); an empty object is the
	// right stub because nothing it can contain is an option this file asserts
	// on. `zoomLevel` is 100, the neutral factor, for the same reason.
	return new Function(
		'settings',
		'value',
		'language',
		'getTheme',
		'documentOptions',
		'zoomLevel',
		'editorOptionsFromSettings',
		`return ${js};`,
	)(settings, '', 'markdown', () => 'app-theme-dark', {}, 100, editorOptionsFromSettings) as Record<
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
	const options = optionsPassedTo(callee, { occurrencesHighlight });
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

const { getMapForWordSeparators } = await import(
	'monaco-editor/esm/vs/editor/common/core/wordCharacterClassifier.js'
);
// Monaco's own default — the editor does not set `wordSeparators`, so this is
// what the classifier is built with in the app.
const { USUAL_WORD_SEPARATORS } = await import(
	'monaco-editor/esm/vs/editor/common/core/wordHelper.js'
);

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
