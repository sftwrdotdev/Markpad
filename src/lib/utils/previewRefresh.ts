/**
 * Whether the viewer keeps `tab.content` (the rendered preview HTML) current
 * while the tab is being edited: only when a preview is on screen to need it —
 * split view, or the outline open beside the editor. Otherwise `tab.content`
 * goes stale while editing, so nothing may read it as "the document".
 *
 * `isEditing` and `showToc` are getters, read only when `isSplit` is false:
 * an effect that calls this must not re-run on an outline toggle in split view.
 */
export function refreshesPreviewCache(
	tab: { isSplit: boolean; rawContent?: string },
	isEditing: () => boolean,
	showToc: () => boolean,
): boolean {
	return (tab.isSplit || (isEditing() && showToc())) && tab.rawContent !== undefined;
}
