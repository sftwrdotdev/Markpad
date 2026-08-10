import type { editor as MonacoEditor } from "monaco-editor";

/**
 * The Monaco options derived from the settings store, in one place.
 *
 * These ten were written twice: once in the `monaco.editor.create()` literal
 * and once in the `updateOptions` effect that re-applies them when a setting
 * changes. Both copies had to agree, and nothing made them — the divergence
 * that actually happened was `fontSize`, carrying the zoom factor in one copy
 * and not the other. `editorOptionWiring.test.ts` had an assertion whose whole
 * job was to count one expression and require the count to be 2, which is what
 * policing a duplicate looks like when the duplicate is not removable.
 *
 * The rest of the creation literal stays where it is: those options are set
 * once and never re-applied, so they are not duplicated and moving them here
 * would only put distance between an option and the paragraph explaining it.
 *
 * `zoomPercent` is a parameter rather than another settings field because the
 * two call sites genuinely pass different things — see the note at the
 * creation site.
 */
export function editorOptionsFromSettings(
	settings: EditorOptionSettings,
	zoomPercent: number,
): MonacoEditor.IEditorOptions {
	return {
		minimap: { enabled: settings.minimap },
		wordWrap: settings.wordWrap as "on" | "off" | "wordWrapColumn" | "bounded",
		wordWrapColumn: settings.editorMaxWidth,
		lineNumbers: settings.lineNumbers as "on" | "off" | "relative" | "interval",
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
		fontSize: settings.editorFontSize * (zoomPercent / 100),
		fontFamily: settings.editorFont,
		renderWhitespace: settings.showWhitespace ? "all" : "none",
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
	showWhitespace: boolean;
};
