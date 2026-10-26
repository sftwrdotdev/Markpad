import type { ContextMenuItem } from '../components/ContextMenu.svelte';
import { t, type LanguageCode } from './i18n.js';
import { normalizeAssetPath } from './exportHtml.js';
import { formatChord, modifierFor } from './shortcuts.js';

/**
 * Which menu a right-click opens: none while a dialog is up or outside the app
 * view, the editor's own, the webview's native one for a text field, or the
 * document menu.
 */
export function contextMenuFor(target: Element, state: { modalOpen: boolean; inApp: boolean }): 'none' | 'editor' | 'native' | 'document' {
	if (state.modalOpen) return 'none';
	if (!state.inApp) return 'none';
	// The editor gets its own menu, and this branch has to come first:
	// Monaco takes input through a hidden `<textarea>`, so the text-field
	// carve-out below would otherwise claim every right-click in it.
	if (target.closest('.editor-container')) return 'editor';
	// Text fields keep the webview's own editing menu (Cut/Copy/Paste);
	// the document menu is about the rendered preview and has no edit
	// items, so swallowing the native one leaves no way to paste.
	if (target.closest('input, textarea, [contenteditable="true"]')) return 'native';
	return 'document';
}

/** What the editor menu calls on the editor pane: the functions its shortcuts run. */
export interface EditorMenuPane {
	undo(): void;
	redo(): void;
	cutToClipboard(): void;
	copyToClipboard(): void;
	pasteFromClipboard(): void;
	selectAll(): void;
	runEditorAction(actionId: string): void;
}

/**
 * The editor pane's context menu. `pane` is read when an item is clicked,
 * not when the menu is drawn.
 */
export function editorContextMenuItems(
	pane: () => EditorMenuPane | null | undefined,
	language: LanguageCode,
	osType: string,
): ContextMenuItem[] {
	// Chords only for the items people learn the shortcut from. Undo is
	// listed because Windows has no menu bar to find it in (#997).
	const modifier = modifierFor(osType);
	const chord = (c: string) => formatChord(c, modifier);
	return [
		{ label: t('menu.undo', language), shortcut: chord('Mod+Z'), onClick: () => pane()?.undo() },
		{
			label: t('menu.redo', language),
			shortcut: chord(modifier === 'Cmd' ? 'Mod+Shift+Z' : 'Mod+Y'),
			onClick: () => pane()?.redo(),
		},
		{ separator: true },
		{ label: t('menu.cut', language), onClick: () => pane()?.cutToClipboard() },
		{ label: t('menu.copy', language), onClick: () => pane()?.copyToClipboard() },
		{ label: t('menu.paste', language), onClick: () => pane()?.pasteFromClipboard() },
		{ label: t('menu.selectAll', language), onClick: () => pane()?.selectAll() },
		{ separator: true },
		// Monaco's other items need a language provider Markdown lacks.
		{
			label: t('menu.commandPalette', language),
			shortcut: 'F1',
			onClick: () => pane()?.runEditorAction('editor.action.quickCommand'),
		},
		{
			label: t('menu.changeAllOccurrences', language),
			shortcut: chord('Mod+F2'),
			onClick: () => pane()?.runEditorAction('editor.action.changeAll'),
		},
	];
}

export interface SaveImageDeps {
	save(options: { defaultPath: string; filters: { name: string; extensions: string[] }[] }): Promise<string | null>;
	copyFile(src: string, dest: string): Promise<unknown>;
	toast(message: string, type?: 'info' | 'error'): void;
	/** Read when the toast is shown, after the Save dialog closes. */
	language(): LanguageCode;
}

/**
 * `src` is an asset URL, a remote URL or a `data:` URL.
 * `normalizeAssetPath` recognises both asset URL forms (Windows
 * `http://asset.localhost/…`, others `asset://localhost/…`) and rejects
 * lookalike hosts (#363).
 */
export async function saveImageAs(src: string, deps: SaveImageDeps): Promise<void> {
	const realPath = normalizeAssetPath(src) ?? '';

	if (!realPath) {
		// The webview cannot fetch the bytes of a remote image at all: the
		// app's CSP is `connect-src 'self'`, so a cross-origin `fetch` is
		// refused before it leaves the page. (`img-src ... https:` is a
		// different directive; it only governs what an `<img>` may
		// display.) The download has to happen in Rust, and there is no
		// command for it yet, so say that rather than reporting a network
		// failure that never happened.
		deps.toast(t('toast.remoteImageNotSupported', deps.language()), 'error');
		return;
	}

	const ext = realPath.split('.').pop() || 'png';
	const dest = await deps.save({
		defaultPath: `image.${ext}`,
		filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'svg'] }]
	});
	if (dest) {
		try {
			await deps.copyFile(realPath, dest);
			deps.toast(t('toast.imageSavedSuccessfully', deps.language()));
		} catch (e) {
			deps.toast(`${t('toast.failedToSaveImage', deps.language())}: ${e}`, 'error');
		}
	}
}

/** Save Image As, for a right-click on a local image. Only a local file can be saved: see `saveImageAs`. */
export function imageMenuItems(target: Element, language: LanguageCode, saveImage: (src: string) => void): ContextMenuItem[] {
	const img = target.closest('img');
	if (!img || !normalizeAssetPath(img.src)) return [];
	return [
		{ label: t('menu.saveImageAs', language), onClick: () => saveImage(img.src) },
		{ separator: true }
	];
}
