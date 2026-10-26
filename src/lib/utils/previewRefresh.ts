/**
 * Whether the viewer keeps `tab.content` (the rendered preview HTML) current
 * while the tab is being edited: only when a preview is on screen to need it —
 * split view, or the outline open beside the editor. Otherwise `tab.content`
 * goes stale while editing, so nothing may read it as "the document".
 */
export function refreshesPreviewCache(
	tab: { isSplit: boolean; rawContent?: string },
	isEditing: boolean,
	showToc: boolean,
): boolean {
	return (tab.isSplit || (isEditing && showToc)) && tab.rawContent !== undefined;
}
