/**
 * The home screen is not a document, but it lives in a tab — and a tab
 * identifies itself by `path`. So the home tab carries a sentinel string where
 * every other tab carries a filesystem path.
 *
 * The sentinel is spelled here and nowhere else. It used to be spelled at ten
 * separate comparison sites, and the one place that mattered most — the render
 * gate in MarkdownViewer.svelte — was not among them: it recognised the home
 * tab as `path === '' && title === 'Recents'`, which described the home tab as
 * it was first written and nothing since (#392). A literal that only some of
 * its readers know about is a literal that can fall out of step in silence, so
 * the `home-tab-sentinel` lint rule pins the string to this file.
 *
 * A tab kind is not really a path, and nothing stops a document from being
 * opened at a relative path spelled exactly `HOME`. Neither is fixed here, but
 * both are now a single edit rather than a search-and-replace.
 */
export const HOME_TAB_PATH = 'HOME';

/**
 * True for the tab that holds the home screen.
 *
 * Distinct from `!hasRealFilePath(path)`, which is also true of an untitled
 * buffer: an untitled tab has no file but is still a document, and every
 * document surface — the editor, the preview, saving — applies to it.
 */
export function isHomePath(path: string): boolean {
	return path === HOME_TAB_PATH;
}

/**
 * Whether the window draws the home screen instead of a document: an empty
 * window, the home tab, or the Home button's overlay over any tab. Decided by
 * tab kind, never by the localised title (#392).
 *
 * `activeTab` is a getter, read only when `showHome` is false: an effect that
 * calls this must not re-run on a tab switch while the Home overlay is up.
 */
export function showsHomeScreen(activeTab: () => { path: string } | undefined, showHome: boolean): boolean {
	if (showHome) return true;
	const tab = activeTab();
	return !tab || isHomePath(tab.path);
}
