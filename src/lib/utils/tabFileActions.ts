import { isHomePath } from './homeTab.js';

type TabFileActionId = 'copy-path' | 'open-location';

type TabFileAction = {
	id: TabFileActionId;
	labelKey: string;
	disabled: boolean;
};

/**
 * True when `path` names a file on disk — false for an untitled buffer and for
 * the home tab's sentinel. Expressed in terms of `isHomePath` rather than
 * repeating the sentinel, so the two predicates cannot disagree about what the
 * home tab is.
 */
export function hasRealFilePath(path: string): boolean {
	return path !== '' && !isHomePath(path);
}

/**
 * True when there is a document worth exporting: a buffer with something in it,
 * saved or not.
 *
 * Shared by the Export menu items, which are hidden without it, by the Export as
 * PDF chord (#673), and by the HTML export itself, so the menu and the exports
 * cannot disagree. A path alone does not count: a saved empty file has nothing
 * to print or export.
 */
export function hasExportableDocument(rawContent: string | undefined): boolean {
	return !!rawContent;
}

/**
 * The Home menu's export gate for a tab. It reads the Markdown buffer, not
 * `content`: that is the rendered-preview HTML, refreshed only while the
 * preview is on screen, so in plain edit mode with the TOC closed — the
 * default state of a new file — it is still empty for a buffer that exports
 * fine.
 */
export function canExportTab(tab: { rawContent: string } | null | undefined): boolean {
	return hasExportableDocument(tab?.rawContent);
}

export function getTabFileActions(path: string): TabFileAction[] {
	const disabled = !hasRealFilePath(path);

	return [
		{ id: 'copy-path', labelKey: 'menu.copyFullPath', disabled },
		{ id: 'open-location', labelKey: 'menu.openFileLocation', disabled },
	];
}
