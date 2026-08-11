/**
 * The query the preview's find bar should open with, given what the reader has
 * selected. Empty means "leave the box alone" — which is what a repeated
 * Cmd/Ctrl+F with nothing selected expects.
 *
 * `selection.toString()` deliberately, rather than the text of one node: a
 * selection crossing `**bold**`, a link or inline code spans several nodes, and
 * those are the words a reader is most likely to have highlighted.
 *
 * Single-line selections only. That is Monaco's rule — its
 * `seedSearchStringFromSelection` seeds from a selection while it stays on one
 * line — so the editor pane already behaves this way, and the app agrees with
 * itself about one keystroke instead of inventing a second rule. A paragraph in
 * the search box matches nothing and buries the query the user was about to type.
 */
export function findSeedFromSelection(selection: Selection | null, root: Node | null): string {
	if (!root || !selection || selection.isCollapsed) return '';
	if (!root.contains(selection.anchorNode) || !root.contains(selection.focusNode)) return '';
	const text = selection.toString().trim();
	return text.includes('\n') ? '' : text;
}
