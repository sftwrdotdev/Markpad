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
