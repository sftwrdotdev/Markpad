import type * as Monaco from 'monaco-editor';
import { clipboardTextForSelection, insertTextAtCursor } from './editorEdits.js';
import { routeDroppedFile } from './fileDrop.js';
import { documentParentDir, imageEmbed, resolveImageDirectory } from './imageEmbed.js';
import { isLinkifyPasteTarget } from './pasteContext.js';

/**
 * What the editor's clipboard and drop handlers reach: the editor and the
 * Monaco module (both assigned once Monaco has loaded, hence getters), the
 * Tauri bridge, the active tab and the image settings.
 */
export type EditorClipboardDeps = {
	editor: () => Monaco.editor.IStandaloneCodeEditor;
	monaco: () => typeof Monaco;
	invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;
	tabs: { readonly activeTab: { readonly path?: string } | null | undefined };
	settings: { readonly imageDirectory: string; readonly macosImageScaling: boolean };
};

/**
 * Cut, copy and paste — one implementation each, reached from the keyboard
 * and from the context menu alike.
 *
 * All three go through Rust (`arboard`) rather than through the webview's
 * `navigator.clipboard`, which is the only thing that works everywhere:
 * wry leaves the webview's clipboard permission off by default, and turning
 * it on does not help — tauri-apps/tauri#12007 is open on exactly this, and
 * the official answer is the clipboard plugin, which is the same Rust route
 * Markpad already had for ⌘V. Verified by hand on Windows: with the wry
 * permission enabled, the webview's own paste still does nothing.
 *
 * Six entry points, three functions. Before this there were six
 * implementations: ⌘X was the browser's, ⌘C and ⌘V were ours, and the three
 * menu items were Monaco's — of which Paste could not work in a webview at
 * all (#207) and Cut and Copy are dead on Linux, where the same wry default
 * gates `set_javascript_can_access_clipboard`.
 *
 * What cut and copy take: `clipboardTextForSelection` in utils/editorEdits.ts.
 */
export async function pasteFromClipboard(deps: EditorClipboardDeps) {
	const editor = deps.editor();
	const monaco = deps.monaco();
	// Focus first, as `runEditorAction` does, and for the same reason: this
	// runs from the context menu as well as from ⌘V, and a menu item leaves
	// the focus on itself. Paste then inserted the text and left no caret —
	// no blink, and the next ⌘Z went nowhere, which reads as "undo is
	// broken" rather than "the editor is not focused".
	//
	// A no-op on the ⌘V path, where the editor is focused by definition.
	editor?.focus();
		try {
			// The image is written before it is linked, and the reader can
			// switch tabs while it is: the link then belongs to no other model.
			const pasteModel = editor.getModel();
			const tabPath = deps.tabs.activeTab?.path;
			const parentDir = tabPath ? documentParentDir(tabPath) : null;
			if (tabPath && parentDir !== null) {
				const imgDirName = resolveImageDirectory(
					deps.settings.imageDirectory,
					tabPath,
				);
				const embeds: string[] = [];

				// A file copied in Explorer or Finder is a path on the clipboard,
				// not pixels (#768). Read it first and copy it as a drop does, so
				// it keeps its own name and bytes rather than whatever preview the
				// file manager put beside it.
				const files = await deps.invoke("clipboard_read_file_list").catch(() => null) as string[] | null;
				for (const srcPath of files ?? []) {
					if (routeDroppedFile(srcPath, "editor") !== "insert") continue;
					const relPath = (await deps.invoke("copy_file_to_img", {
						srcPath,
						parentDir,
						imageDirectory: imgDirName,
					})) as string;
					embeds.push(imageEmbed(relPath));
				}

				if (embeds.length === 0) {
					// check for image in clipboard via Rust
					const base64Image = await deps.invoke("clipboard_read_image", { macosImageScaling: deps.settings.macosImageScaling }).catch(() => null) as string | null;
					if (base64Image) {
						const filename = `paste_${Date.now()}.png`; // output of Rust command is always PNG
						const relPath = (await deps.invoke("save_image", {
							parentDir,
							filename,
							base64Data: base64Image,
							imageDirectory: imgDirName,
						})) as string;
						embeds.push(imageEmbed(relPath));
					}
				}

				// The written file stays: it is in the first tab's folder, where
				// the reader can see it, and deleting on a guess is what #368 removed.
				if (editor.getModel() !== pasteModel) return;
				const position = editor.getPosition();
				if (embeds.length > 0 && position) {
					const selection = editor.getSelection();
					const range =
						selection && !selection.isEmpty()
							? selection
							: new monaco.Range(
									position.lineNumber,
									position.column,
									position.lineNumber,
									position.column,
								);

					editor.pushUndoStop();
					editor.executeEdits("paste-image", [
						{
							range,
							text: embeds.join("\n"),
							forceMoveMarkers: true,
						},
					]);

					return;
				}
			}

			// fall through to text paste via Rust
			const rawText = await deps.invoke("clipboard_read_text").catch(() => "") as string;
			if (!rawText) return;
			// Every edit below is a paste, and a paste is its own undo step:
			// `executeEdits` appends to the step typing left open, so without
			// this one Cmd+Z takes back the paste AND the words before it.
			editor.pushUndoStop();
			
			const text = rawText.trim();
			const urlRegex = /^(?:(?:https?|file|tauri):\/\/|www\.)[^\s]{2,}$/i;
			const isUrl = urlRegex.test(text);

			const selections = editor.getSelections();
			const model = editor.getModel();
			if (!selections || selections.length === 0 || !model) {
				insertTextAtCursor(editor, rawText);
				return;
			}

			// if it's not a URL or we have no multi-line selection/complex case, just insert
			const hasSelection = selections.some((s) => !s.isEmpty());
			const isMultiLine = selections.some((s) => s.startLineNumber !== s.endLineNumber);

			if (!isUrl || isMultiLine || !isLinkifyPasteTarget(model, selections[0], monaco.editor)) {
				const edits = selections.map(s => ({
					range: s,
					text: rawText,
					forceMoveMarkers: true
				}));
				editor.executeEdits("paste-text", edits);
				return;
			}

			if (hasSelection) {
				const edits = selections.map((selection) => {
					const selectedText = model.getValueInRange(selection);
					// Pasting a URL over a URL replaces it. Wrapping would
					// nest the old URL as the link text — and inside
					// existing link syntax like ![](url) it produces
					// broken nesting: ![]([old](new)).
					if (urlRegex.test(selectedText.trim())) {
						return {
							range: selection,
							text,
							forceMoveMarkers: true,
						};
					}
					const linkUrl = text.toLowerCase().startsWith("www.")
						? `http://${text}`
						: text;
					return {
						range: selection,
						text: `[${selectedText}](${linkUrl})`,
						forceMoveMarkers: true,
					};
				});
				editor.executeEdits("paste-link", edits);
			} else {
				const displayText = text.replace(
					/^(?:https?|file|tauri):\/\/|www\./i,
					"",
				);
				const linkUrl = text.toLowerCase().startsWith("www.")
					? `http://${text}`
					: text;
				const template = `[${displayText}](${linkUrl})`;
				const edits = selections.map((selection) => {
					return {
						range: selection,
						text: template,
						forceMoveMarkers: true,
					};
				});

				editor.executeEdits("paste-link", edits);

				let accumulatedShift = 0;
				let lastLine = -1;
				const newSelections = selections.map((s) => {
					if (s.startLineNumber !== lastLine) {
						accumulatedShift = 0;
						lastLine = s.startLineNumber;
					}
					const startColumn = s.startColumn + accumulatedShift + 1;
					const endColumn = startColumn + displayText.length;
					accumulatedShift += template.length;
					return new monaco.Selection(
						s.startLineNumber,
						startColumn,
						s.startLineNumber,
						endColumn,
					);
				});
				editor.setSelections(newSelections);
			}
		} catch (err) {
			console.error("Paste failed:", err);
		}
}

export async function copyToClipboard(deps: EditorClipboardDeps) {
	const editor = deps.editor();
	const monaco = deps.monaco();
	editor?.focus();
	const { text } = clipboardTextForSelection(editor, monaco);
	if (text) await deps.invoke('clipboard_write_text', { text }).catch(console.error);
}

export async function cutToClipboard(deps: EditorClipboardDeps) {
	const editor = deps.editor();
	const monaco = deps.monaco();
	editor?.focus();
	const { text, range } = clipboardTextForSelection(editor, monaco);
	if (!text || !range || !editor) return;
	const model = editor.getModel();
	await deps.invoke('clipboard_write_text', { text }).catch(console.error);
	// `range` is in this model's coordinates; after a tab switch it would
	// delete text from the other document.
	if (editor.getModel() !== model) return;
	editor.pushUndoStop();
	editor.executeEdits('cut', [{ range, text: '', forceMoveMarkers: true }]);
}

export async function handleDroppedFile(deps: EditorClipboardDeps, path: string, x: number, y: number) {
	const editor = deps.editor();
	const monaco = deps.monaco();
	if (!editor || !deps.tabs.activeTab?.path) return;

	const target = (editor as any).getTargetAtClientPoint(x, y);
	const position = target?.position || editor.getPosition();
	if (!position) return;

	const tabPath = deps.tabs.activeTab.path;
	const parentDir = documentParentDir(tabPath);
	if (parentDir === null) return;
	const dropModel = editor.getModel();

	try {
		const imgDirName = resolveImageDirectory(
			deps.settings.imageDirectory,
			tabPath,
		);
		const relPath = (await deps.invoke("copy_file_to_img", {
			srcPath: path,
			parentDir,
			imageDirectory: imgDirName,
		})) as string;
		// As in `pasteFromClipboard`: a tab switch during the copy leaves the
		// file where it was copied and the link out of the other document.
		if (editor.getModel() !== dropModel) return;
		const embed = imageEmbed(relPath);

		editor.pushUndoStop();
		editor.executeEdits(
			"drop-image",
			[
				{
					range: new monaco.Range(
						position.lineNumber,
						position.column,
						position.lineNumber,
						position.column,
					),
					text: embed,
					forceMoveMarkers: true,
				},
			],
			[
				new monaco.Selection(
					position.lineNumber,
					position.column + embed.length,
					position.lineNumber,
					position.column + embed.length,
				),
			],
		);
	} catch (err) {
		console.error("Failed to copy dropped file:", err);
	}
}
