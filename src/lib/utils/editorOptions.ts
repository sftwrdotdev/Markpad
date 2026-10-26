import type { editor as MonacoEditor } from "monaco-editor";

import { fontFamilyValue } from "./fontFamily.js";

/**
 * The strip between the line numbers and the text, in pixels.
 *
 * Zoom is the font size here, and two things in the gutter did not agree with
 * it. Monaco sizes the line-number column in digits, so the blank column #812
 * kept for the floating TOC button pushed the text right by five digit widths
 * on every zoom step, for nothing drawn. And Monaco draws the folding chevron
 * at 140% of the font size in a strip that stays 26px wide, so past about
 * 17px the chevron spilled onto the text.
 *
 * So "off" collapses the column with a real `'off'` and puts a fixed
 * `TOC_BUTTON_CLEARANCE` back in this strip: the button is 28px wide at 8px
 * from the pane, and 42px is what five digits came to at the default 14px, so
 * the default layout is unchanged. The strip also grows with the chevron, and
 * only with it. `styles.css` keeps the chevron at the strip's right end,
 * against the text rather than under the button.
 *
 * Monaco adds 16px to this option itself while folding controls show, which
 * is why that is taken off the chevron's width. The chevron is its
 * `font-size: 140%` plus a 2px `margin-left`, both from Monaco's folding.css.
 */
const TOC_BUTTON_CLEARANCE = 42;
const MONACO_FOLDING_WIDTH = 16;
const MONACO_DEFAULT_DECORATIONS_WIDTH = 10;
const TYPEWRITER_SURROUNDING_LINES = 10_000;

function lineDecorationsWidth(fontSize: number, lineNumbersOff: boolean): number {
	const chevron = Math.ceil(fontSize * 1.4) + 2;
	const strip = Math.max(MONACO_DEFAULT_DECORATIONS_WIDTH, chevron - MONACO_FOLDING_WIDTH);
	return lineNumbersOff ? strip + TOC_BUTTON_CLEARANCE : strip;
}

/**
 * The Monaco options derived from the settings store, in one place.
 *
 * Used by both `monaco.editor.create()` and the `updateOptions` effect, so the
 * two cannot disagree.
 *
 * The rest of the creation literal stays where it is: those options are set
 * once and never re-applied, so they are not duplicated and moving them here
 * would only put distance between an option and the paragraph explaining it.
 *
 * An option a setting can change must be here, or `updateOptions` never
 * re-applies it and the toggle reaches only the next editor.
 *
 * `zoomPercent` is a parameter rather than another settings field because the
 * two call sites genuinely pass different things — see the note at the
 * creation site. `fontIsMonospace` is Monaco's own measurement of the chosen
 * font, which only exists once an editor has rendered with it.
 */
export function editorOptionsFromSettings(
	settings: EditorOptionSettings,
	zoomPercent: number,
	fontIsMonospace = true,
): MonacoEditor.IEditorOptions {
	const fontSize = settings.editorFontSize * (zoomPercent / 100);
	return {
		minimap: { enabled: settings.minimap },
		wordWrap: settings.wordWrap as "on" | "off" | "wordWrapColumn" | "bounded",
		wordWrapColumn: settings.editorMaxWidth,
		// 'simple' counts every character as wide as `n`, which only holds for a
		// monospace font: in Times New Roman or Roboto a line wrapped well short
		// of the window edge (#758). 'advanced' measures in the DOM and is slow
		// on large files, so only a proportional font pays for it.
		wrappingStrategy: fontIsMonospace ? "simple" : "advanced",
		lineNumbers: settings.lineNumbers as "on" | "off" | "relative" | "interval",
		lineDecorationsWidth: lineDecorationsWidth(fontSize, settings.lineNumbers === "off"),
		// A Monaco string enum, not a flag. Any non-empty string is truthy, so
		// a ternary on it can only ever produce "line" — which defeats both the
		// line-highlight toggle and Zen mode, whose whole effect is 'none'.
		renderLineHighlight: settings.renderLineHighlight as "line" | "none",
		occurrencesHighlight: settings.occurrencesHighlight ? "singleFile" : "off",
		// The other half of "Highlight Occurrences". Monaco splits the feature
		// across two options, and `SelectionHighlighter` gates itself on
		// `selectionHighlight` — it reads `occurrencesHighlight` only to choose
		// which decoration style to draw with. Left unset, `selectionHighlight`
		// defaults to true, so with the setting off — its default — selecting a
		// word still highlighted every other copy of it, from a switch the app
		// never exposed. Same shape as the defects #369 fixed: a setting that
		// does not control the thing its label names.
		selectionHighlight: settings.occurrencesHighlight,
		fontSize,
		fontFamily: fontFamilyValue(settings.editorFont, "monospace"),
		renderWhitespace: settings.showWhitespace ? "all" : "none",
		// Monaco animates the scroll when it is sent to a position — a find
		// match, a go-to-line, the scroll sync. That is the same jump the
		// preview animates, so it answers the same preference rather than a
		// second one of its own.
		smoothScrolling: settings.animateJumpScroll,
		// The caret's glide between positions.
		cursorSmoothCaretAnimation: settings.animateCursor ? "on" : "off",
		// Typewriter Mode: Monaco keeps this many lines around a revealed cursor,
		// capped at half the viewport, so a number past any screen centres the
		// cursor line. 'all' applies it to clicks too, not only to keyboard moves.
		cursorSurroundingLines: settings.typewriterMode ? TYPEWRITER_SURROUNDING_LINES : 0,
		cursorSurroundingLinesStyle: settings.typewriterMode ? "all" : "default",
	};
}

/**
 * The options `monaco.editor.create()` gets, minus the model and the theme.
 *
 * Everything outside `editorOptionsFromSettings` is set once here and never
 * re-applied.
 */
export function createdEditorOptions(
	settings: EditorOptionSettings & { stickyScroll: boolean },
	zoomPercent: number,
	readOnly: boolean,
): MonacoEditor.IStandaloneEditorConstructionOptions {
	return {
		dragAndDrop: true,
		automaticLayout: true,
		// Off by default, and `'configuredByTheme'` cannot turn it on here:
		// `StandaloneTheme.semanticHighlighting` is hard-coded false, so the
		// switch has to be explicit or the semantic tokens provider is never asked.
		'semanticHighlighting.enabled': true,
		...editorOptionsFromSettings(settings, zoomPercent),
		readOnly,
		scrollBeyondLastLine: true,
		stickyScroll: { enabled: settings.stickyScroll },
		wordBasedSuggestions: "off",
		quickSuggestions: false,
		// Monaco's Unicode highlighter is built for source code, where a
		// character that looks like ASCII but is not is an attack vector. In
		// prose it fires on the punctuation CJK authors type all day: `，`
		// `！` `？` `（` `）` `；` `：` are all confusables of an ASCII
		// counterpart, so Monaco outlines each one (#186, #94).
		//
		// It only fires when the confusable shares a word with basic ASCII —
		// shouldHighlightNonBasicASCII() suppresses the box when the
		// surrounding word is entirely non-ASCII — which is why pure CJK
		// looks fine and `使用 Monaco，然后保存。` or `安装依赖（npm ci）` does
		// not. Latin technical terms inside CJK prose are the normal case,
		// and `**粗体**，` triggers it with no Latin word at all.
		//
		// invisibleCharacters stays on, but not for the reason first written
		// here. That comment claimed it "never fires on something typed on
		// purpose"; measured against this Monaco build, U+3000 IDEOGRAPHIC
		// SPACE — the space bar under every CJK IME — is in the invisible
		// set and gets outlined, which is the same complaint as #186/#94 one
		// option over. The set is the flattened union of every locale bucket
		// (`strings.js` getData()), 465 code points, so `allowedLocales`
		// cannot exclude it; only `allowedCharacters` can.
		//
		// The rest stays on because the NBSP hazard is real: an NBSP after
		// `-` stops a list from parsing. Worth recording that the other
		// stated hazard does NOT hold — a zero-width space inside CJK text
		// is not flagged at all, because shouldHighlightNonBasicASCII()
		// suppresses it when the surrounding word has no basic ASCII.
		//
		// nonBasicASCII needs no setting — it defaults to
		// `inUntrustedWorkspace` and standalone Monaco's workspace-trust
		// service returns true unconditionally, so it is already off; were it
		// on, every ideograph would be boxed rather than the punctuation.
		unicodeHighlight: {
			ambiguousCharacters: false,
			allowedCharacters: { "　": true },
		},
		// Word-wise navigation — ⌥←/→, double-click-to-select, ⌥⌫ — splits on
		// `wordSeparators`, and a language that does not put spaces between
		// its words has none. So a whole Chinese clause counts as one word:
		// ⌥→ jumps the sentence, double-click selects it, ⌥⌫ deletes it.
		//
		// A non-empty list switches on `Intl.Segmenter` (see
		// `wordCharacterClassifier.js`), which knows where the words are.
		//
		// It is closer to a switch than to a whitelist, and the naming hides
		// that: ICU dispatches its dictionary breaking by SCRIPT, not by this
		// list. Thai, Khmer, Lao, Burmese and Tibetan get segmented too and
		// none of them are named here, while `['zh']`, `['ja']` and
		// `['zh','ja']` all produce identical output — even on Han text,
		// where the two dictionaries might have been expected to disagree.
		// Written as the two the app has locales for, rather than a longer
		// list that would read as a claim about coverage it does not make.
		//
		// Nothing is taken from space-delimited languages: Korean,
		// Vietnamese, Russian and English segment word-for-word identically
		// to splitting on whitespace. An unsupported tag is dropped by
		// Monaco's own `validate()`, so this cannot fail closed.
		wordSegmenterLocales: ['zh', 'ja'],
		// Markpad draws the editor's context menu itself, in
		// MarkdownViewer.svelte, beside the one the preview already had.
		//
		// Not a style choice. Monaco's menu offers Cut, Copy and Paste, and
		// its Paste cannot work here: it reads the clipboard through the
		// webview, which wry leaves switched off and which Tauri has no
		// answer for (tauri-apps/tauri#12007). Everything else Monaco would
		// contribute to that menu — Go to Definition, Go to References,
		// inlay hints — needs a language provider this app does not
		// register, so nothing is lost by drawing our own.
		contextmenu: false,
		// Monaco writes a styled `text/html` flavour beside the plain text on a
		// copy. Everything Markpad produces IS plain text, so pasting into Word
		// or Outlook gave coloured monospace instead of the Markdown that was
		// copied — the styled flavour has no audience here (#393).
		//
		// Still needed after cut/copy/paste were collapsed onto three functions
		// of our own, which is easy to get wrong: those cover ⌘C and the context
		// menu, and macOS has a third way in. Edit > Copy in the menu bar is a
		// predefined Copy item (#527), which asks the webview to perform
		// its own copy — Monaco's, not ours. Without this the menu bar would put
		// a different clipboard on the pasteboard than the other two routes.
		copyWithSyntaxHighlighting: false,
		// The same argument one option over. U+2028 (LINE SEPARATOR) and
		// U+2029 (PARAGRAPH SEPARATOR) break a JavaScript string literal,
		// which is what Monaco's guard is for; in Markdown they are just
		// characters, and they arrive by ordinary means — several word
		// processors and PDF text extractors emit U+2028 for a soft line
		// break, so pasting one in is normal here.
		//
		// The default is 'prompt', and in standalone Monaco that prompt is
		// `StandaloneDialogService.doConfirm`, i.e. a bare
		// `mainWindow.confirm()`: an unstyled browser dialog inside a Tauri
		// window, carrying Monaco's English string in an app translated
		// into 26 locales, offering to rewrite the user's bytes. 'auto'
		// would rewrite them without asking, which is worse.
		//
		// 'off' loses no visibility: the line renderer substitutes U+FFFD
		// for LINE_SEPARATOR and PARAGRAPH_SEPARATOR unconditionally, so
		// they stay as visible as they ever were. Only the dialog goes.
		unusualLineTerminators: "off",
		padding: { top: 20 },
		// The overview ruler sits under the vertical scrollbar, and its
		// border drew a 1px line down the track's left edge.
		overviewRulerBorder: false,
		scrollbar: {
			vertical: "visible",
			horizontal: "visible",
			useShadows: false,
			verticalHasArrows: false,
			horizontalHasArrows: false,
			// Same track and thumb as the preview's ::-webkit-scrollbar in styles.css.
			verticalScrollbarSize: 14,
			horizontalScrollbarSize: 14,
			verticalSliderSize: 8,
			horizontalSliderSize: 8,
		},
	};
}

/** What the update effect re-applies: the settings-derived options, and `readOnly`. */
export function updatedEditorOptions(
	settings: EditorOptionSettings,
	zoomPercent: number,
	fontIsMonospace: boolean,
	readOnly: boolean,
): MonacoEditor.IEditorOptions {
	return { ...editorOptionsFromSettings(settings, zoomPercent, fontIsMonospace), readOnly };
}

/**
 * Whether the editor on `tab` refuses typing. An unread or unreadable tab in
 * edit mode shows a buffer that is not the whole file, and no save will ever
 * accept it: read-only at the keyboard, not a toast at the save.
 */
export function editorReadOnly(tab: { isTruncated?: boolean }): boolean {
	return tab.isTruncated === true;
}

/** The slice of the settings store the options above are derived from. */
export type EditorOptionSettings = {
	minimap: boolean;
	wordWrap: string;
	editorMaxWidth: number;
	lineNumbers: string;
	renderLineHighlight: string;
	occurrencesHighlight: boolean;
	editorFontSize: number;
	editorFont: string;
	animateJumpScroll: boolean;
	animateCursor: boolean;
	showWhitespace: boolean;
	typewriterMode: boolean;
};
