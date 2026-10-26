/**
 * The dialog backdrop's right-click: no webview menu over a dialog, except in
 * a text field, where the prompt input needs the webview's Cut/Copy/Paste.
 */
export function handleModalBackdropContextMenu(e: MouseEvent) {
	if ((e.target as HTMLElement).closest('input, textarea')) return;
	e.preventDefault();
	e.stopPropagation();
}
