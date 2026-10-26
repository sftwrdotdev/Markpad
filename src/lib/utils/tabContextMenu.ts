import type { ContextMenuItem } from '../components/ContextMenu.svelte';
import { isHomePath } from './homeTab.js';
import { type LanguageCode, t } from './i18n.js';
import { modifierFor, shortcutLabel } from './shortcuts.js';
import { hasRealFilePath } from './tabFileActions.js';
import type { WindowEventName } from '../windowEvents.js';

/** Sends a tab-menu event to this window. */
type Emit = (event: WindowEventName, payload?: string) => void;

// ContextMenu prints `shortcut` into the same `<span class="menu-shortcut">`
// the app menu uses, so a literal here sits a keystroke away from the app
// menu's registry-derived chord and disagrees with it on macOS.

/** The menu on the empty part of the tab strip. */
export function tabListMenuItems(language: LanguageCode, osType: string, emit: Emit): ContextMenuItem[] {
	const modifier = modifierFor(osType);
	return [
		{ label: t('menu.newFile', language), shortcut: shortcutLabel('file-new', modifier), onClick: () => emit('menu-tab-new') },
		{ label: t('menu.undoCloseTab', language), shortcut: shortcutLabel('tab-undo-close', modifier), onClick: () => emit('menu-tab-undo') },
	];
}

/** The menu on one tab. */
export function tabMenuItems(menu: {
	tab: { id: string; path: string };
	language: LanguageCode;
	osType: string;
	tabCount: number;
	fileActionItems: ContextMenuItem[];
	moveToWindowItems: ContextMenuItem[];
	emit: Emit;
}): ContextMenuItem[] {
	const { tab, language: currentLang, emit } = menu;
	const modifier = modifierFor(menu.osType);
	return [
		{ label: t('menu.newFile', currentLang), shortcut: shortcutLabel('file-new', modifier), onClick: () => emit('menu-tab-new') },
		{ label: t('menu.undoCloseTab', currentLang), shortcut: shortcutLabel('tab-undo-close', modifier), onClick: () => emit('menu-tab-undo') },
		{
			label: t('menu.rename', currentLang),
			// Rename renames the file on disk; untitled and home tabs have
			// no file.
			disabled: !hasRealFilePath(tab.path),
			onClick: () => emit('menu-tab-rename', tab.id),
		},
		{ separator: true },
		...menu.fileActionItems,
		{ separator: true },
		{
			label: t('menu.moveToNewWindow', currentLang),
			// Moving the only tab would just churn windows, and the home
			// tab is recreatable anywhere; both stay in place.
			disabled: isHomePath(tab.path) || menu.tabCount < 2,
			onClick: () => emit('menu-tab-detach', tab.id),
		},
		...menu.moveToWindowItems,
		{ separator: true },
		{ label: t('menu.closeFile', currentLang), shortcut: shortcutLabel('file-close', modifier), onClick: () => emit('menu-tab-close', tab.id) },
		{ label: t('menu.closeOtherTabs', currentLang), onClick: () => emit('menu-tab-close-others', tab.id) },
		{ label: t('menu.closeTabsToRight', currentLang), onClick: () => emit('menu-tab-close-right', tab.id) },
	];
}
