import type * as Monaco from 'monaco-editor';

export type DiffView = {
	/**
	 * The right side's text if the user changed it in the view, else `null`.
	 * Compared with what the model held when the view opened, not with the
	 * string it was given: the model normalises line endings, so an untouched
	 * mixed-ending buffer would otherwise read as an edit.
	 */
	editedMine: () => string | null;
	close: () => void;
};

/**
 * Builds the side-by-side diff for `DiffOverlay.svelte`.
 *
 * The left side (on disk) is read-only. The right side (the buffer) is
 * editable so Monaco draws its revert arrow beside each changed block: one
 * click copies that block from disk into the right side. Nothing reaches the
 * tab until the user picks "Keep my version", which reads `editedMine()`.
 * The arrow needs all of `readOnly: false`, side-by-side rendering and the
 * gutter menu off (monaco-editor 0.55.1, `shouldRenderOldRevertArrows`), so
 * the view also stays side by side in a narrow window. It is drawn in the
 * right side's glyph margin, which the standalone build turns off by default
 * and the diff editor only turns back on for the left side, so `glyphMargin`
 * has to be asked for here or the arrows are laid out zero pixels wide.
 *
 * Models of its own rather than the tab's: handing it the live model would
 * put a second editor on a buffer that `Editor.svelte` owns, and closing the
 * view without choosing has to throw its edits away. The teardown disposes
 * both models too, or opening the view repeatedly leaks one document's worth
 * of text each time.
 */
export function openDiffView(
	monaco: Pick<typeof Monaco, 'editor'>,
	element: HTMLElement,
	original: string,
	modified: string,
	languageId: string,
): DiffView {
	const left = monaco.editor.createModel(original, languageId);
	const right = monaco.editor.createModel(modified, languageId);
	const opened = right.getValue();
	const models = [left, right];
	const editor = monaco.editor.createDiffEditor(element, {
		readOnly: false,
		originalEditable: false,
		renderMarginRevertIcon: true,
		renderGutterMenu: false,
		useInlineViewWhenSpaceIsLimited: false,
		automaticLayout: true,
		renderSideBySide: true,
		glyphMargin: true,
		scrollBeyondLastLine: false,
		minimap: { enabled: false },
	});
	editor.setModel({ original: left, modified: right });
	return {
		editedMine: () => {
			const text = right.getValue();
			return text === opened ? null : text;
		},
		close: () => {
			editor.dispose();
			for (const model of models) model.dispose();
		},
	};
}
