import type { editor as MonacoEditor } from "monaco-editor";

import { fontFamilyValue } from "./fontFamily.js";
import { allowsMotion } from "./motion.js";

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
		// second one of its own; `utils/motion.ts` is where the two meet.
		smoothScrolling: allowsMotion(settings.animateJumpScroll, settings.systemReducedMotion),
		// The caret's glide between positions.
		cursorSmoothCaretAnimation: allowsMotion(settings.animateCursor, settings.systemReducedMotion)
			? "on"
			: "off",
	};
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
	systemReducedMotion: boolean;
	showWhitespace: boolean;
};
