import type * as Monaco from 'monaco-editor';

/** The part of a Monaco editor the format tools touch. */
export type EditingEditor = Pick<Monaco.editor.ICodeEditor, 'getSelection' | 'getModel' | 'pushUndoStop' | 'executeEdits'>;

/**
 * What cut and copy take from `editor`: the selection, or with nothing
 * selected the caret's whole line. `monaco` supplies the `Range` constructor,
 * which lives on the lazily imported module.
 */
export function clipboardTextForSelection(
	editor: Pick<Monaco.editor.ICodeEditor, 'getSelection' | 'getModel'> | undefined,
	monaco: Pick<typeof Monaco, 'Range'>,
): { text: string; range: Monaco.Range | null } {
	const selection = editor?.getSelection();
	const model = editor?.getModel();
	if (!selection || !model) return { text: '', range: null };

	if (!selection.isEmpty()) {
		return { text: model.getValueInRange(selection), range: selection };
	}

	// Nothing selected copies the whole line, line ending included —
	// Monaco's `emptySelectionClipboard` default, and VS Code's and Sublime
	// Text's. Kept because it is what this editor has always done; whether
	// an app that calls itself the Notepad equivalent should do it at all
	// is a separate question (#393).
	const line = selection.startLineNumber;
	const lastLine = model.getLineCount();
	return {
		text: model.getLineContent(line) + model.getEOL(),
		// Cutting that line has to take its line ending with it, so the
		// range runs to the start of the next one. The last line has no
		// next, and the range stops at its end.
		range:
			line < lastLine
				? new monaco.Range(line, 1, line + 1, 1)
				: new monaco.Range(line, 1, line, model.getLineMaxColumn(line)),
	};
}

export function insertTextAtCursor(editor: EditingEditor, text: string) {
	const selection = editor.getSelection();
	if (!selection) return;
	const op = { range: selection, text: text, forceMoveMarkers: true };
	editor.pushUndoStop();
	editor.executeEdits("my-source", [op]);
}

export function wrapAsCodeBlock(editor: EditingEditor) {
	const selection = editor.getSelection();
	const model = editor.getModel();
	if (!selection || !model) return;

	const text = model.getValueInRange(selection);
	const block = text.startsWith("```\n") && text.endsWith("\n```")
		? text.slice(4, -4).replace(/\n$/, "")
		: `\`\`\`\n${text}\n\`\`\``;
	editor.pushUndoStop();
	editor.executeEdits("fmt-code-block", [
		{ range: selection, text: block, forceMoveMarkers: true },
	]);
}

export function insertLink(editor: EditingEditor) {
	const selection = editor.getSelection();
	const model = editor.getModel();
	if (!selection || !model) return;

	const text = model.getValueInRange(selection);
	const label = text || "link text";
	const link = `[${label}](url)`;
	editor.pushUndoStop();
	editor.executeEdits("fmt-link", [
		{ range: selection, text: link, forceMoveMarkers: true },
	]);
}
