import type * as Monaco from 'monaco-editor';

import { frontMatterLineOffset } from './frontMatter.js';

type ScrollEditor = Pick<Monaco.editor.ICodeEditor, 'getModel' | 'getTopForLineNumber'>;

/**
 * The editor's scroll offset where the front matter ends, or 0 when there is
 * none: what split view hands across as "inside the front matter".
 */
export function editorFrontMatterScrollEnd(
	getEditor: () => ScrollEditor | undefined,
	getEditorContentScrollMax: () => number,
): () => number {
	let frontMatterOffsetCache: { model: unknown; version: number; offset: number } | null = null;

	return function getEditorFrontMatterScrollEnd() {
		const editor = getEditor();
		if (!editor) return 0;

		const model = editor.getModel();
		if (!model) return 0;

		// The preview's rule, not a second one: a leading `---` block that is not
		// a YAML mapping is body there, and the two panes must agree on where the
		// front matter ends or every position above it syncs to the top. Cached on
		// the model's version because this runs on every scroll event.
		const version = model.getVersionId();
		if (frontMatterOffsetCache?.model !== model || frontMatterOffsetCache.version !== version) {
			frontMatterOffsetCache = { model, version, offset: frontMatterLineOffset(model.getValue()) };
		}
		const bodyStartLine = frontMatterOffsetCache.offset + 1;
		if (bodyStartLine <= 1) return 0;

		const safeBodyStartLine = Math.max(1, Math.min(model.getLineCount(), bodyStartLine));
		return Math.max(0, Math.min(getEditorContentScrollMax(), editor.getTopForLineNumber(safeBodyStartLine)));
	};
}
