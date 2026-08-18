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
 * True when there is a document worth exporting: a file on disk, or an untitled
 * buffer someone has typed into.
 *
 * Shared by the Export menu items, which are hidden without it, and by the
 * Export as PDF chord (#673), which would otherwise print a blank page for a
 * document the menu says cannot be exported. Two spellings of one condition is
 * how the menu and the keyboard come to disagree.
 *
 * `currentFile` rather than the tab's path because that is what both call
 * sites already hold, and it is the same string.
 */
export function hasExportableDocument(currentFile: string, rawContent: string | undefined): boolean {
	return currentFile !== '' || !!rawContent;
}

export function getTabFileActions(path: string): TabFileAction[] {
	const disabled = !hasRealFilePath(path);

	return [
		{ id: 'copy-path', labelKey: 'menu.copyFullPath', disabled },
		{ id: 'open-location', labelKey: 'menu.openFileLocation', disabled },
	];
}
