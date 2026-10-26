import type * as Monaco from 'monaco-editor';

/**
 * Builds the read-only side-by-side diff for `DiffOverlay.svelte` and returns
 * its teardown.
 *
 * Models of its own rather than the tab's: this view must not be able to touch
 * the document, and handing it the live model would put a second editor on a
 * buffer that `Editor.svelte` owns. The teardown disposes both models too, or
 * opening the view repeatedly leaks one document's worth of text each time.
 */
export function openDiffView(
	monaco: Pick<typeof Monaco, 'editor'>,
	element: HTMLElement,
	original: string,
	modified: string,
	languageId: string,
): () => void {
	const left = monaco.editor.createModel(original, languageId);
	const right = monaco.editor.createModel(modified, languageId);
	const models = [left, right];
	const editor = monaco.editor.createDiffEditor(element, {
		readOnly: true,
		originalEditable: false,
		automaticLayout: true,
		renderSideBySide: true,
		scrollBeyondLastLine: false,
		minimap: { enabled: false },
	});
	editor.setModel({ original: left, modified: right });
	return () => {
		editor.dispose();
		for (const model of models) model.dispose();
	};
}
