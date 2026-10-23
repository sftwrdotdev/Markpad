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
 * PDF chord (#673), and by the HTML export itself. Two spellings of one
 * condition is how the menu and the exports come to disagree: the menu used to
 * offer a saved file's exports on its path alone, so a saved empty file printed
 * a blank PDF page and its HTML export silently did nothing.
 */
export function hasExportableDocument(rawContent: string | undefined): boolean {
	return !!rawContent;
}

export function getTabFileActions(path: string): TabFileAction[] {
	const disabled = !hasRealFilePath(path);

	return [
		{ id: 'copy-path', labelKey: 'menu.copyFullPath', disabled },
		{ id: 'open-location', labelKey: 'menu.openFileLocation', disabled },
	];
}
