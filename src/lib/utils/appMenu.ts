import type { Resource } from '@tauri-apps/api/core';
import { CheckMenuItem, Menu, MenuItem, Submenu, type PredefinedMenuItemOptions } from '@tauri-apps/api/menu';

import { t, type LanguageCode } from './i18n.js';
import { SHORTCUTS } from './shortcuts.js';
import type { ViewMode } from './titlebarToolbar.js';
import type { ViewerCommand } from './viewerKeymap.js';

/*
 * The macOS menu bar, as data.
 *
 * Every window builds this from its own state and installs it when it gains
 * focus, so a click always reaches the window the user is looking at. The
 * accelerators come from `SHORTCUTS`, the same rows the shortcuts panel prints
 * and `shortcutRegistry.test.ts` holds to the handlers.
 *
 * NO DOUBLE FIRING. WKWebView offers a key equivalent to the page first and
 * only hands it to the menu if the page did not `preventDefault` it. The page
 * prevents every chord it answers (`handleKeyDown`, Monaco's keybindings), so
 * an accelerator below fires from the menu only where the page left it alone:
 * an editor chord outside the editor, ⌘Q, ⌘M, or any chord while a dialog is
 * up, which `MarkdownViewer`'s menu handler refuses.
 */

/** What a menu click runs that `ViewerCommand` has no name for. */
export type AppMenuCommand =
	| 'check-updates'
	| 'open-folder'
	| 'close-folder'
	| 'export-html'
	| 'toggle-toc'
	| 'toggle-tabs'
	| 'toggle-editor-toolbar'
	| 'toggle-full-width'
	| 'merge-windows'
	| 'set-window-tag';

export type MenuAction =
	| { readonly viewer: ViewerCommand }
	| { readonly editor: string }
	| { readonly app: AppMenuCommand };

type PredefinedItem = Exclude<PredefinedMenuItemOptions['item'], 'Separator'>;

export type MenuNode =
	| { readonly kind: 'item'; readonly text: string; readonly action: MenuAction; readonly accelerator?: string; readonly enabled?: boolean }
	| { readonly kind: 'check'; readonly text: string; readonly action: MenuAction; readonly accelerator?: string; readonly checked: boolean; readonly enabled?: boolean }
	| { readonly kind: 'predefined'; readonly item: PredefinedItem; readonly text?: string }
	| { readonly kind: 'separator' }
	| { readonly kind: 'submenu'; readonly text: string; readonly items: readonly MenuNode[]; readonly windowsMenu?: true };

export type MenuState = {
	readonly language: LanguageCode;
	/** The active tab's mode, or null with no tab open. */
	readonly viewMode: ViewMode | null;
	readonly liveMode: boolean;
	/** The editor is on screen, so the Format items have somewhere to act. */
	readonly hasEditorPane: boolean;
	readonly showToc: boolean;
	readonly showTabs: boolean;
	readonly showEditorToolbar: boolean;
	readonly previewFullWidth: boolean;
};

/**
 * The accelerator for a registry row, in Tauri's spelling. `chord` picks which
 * of the row's chords when it has several (New File is ⌘T and ⌘N; macOS menus
 * print ⌘N).
 */
function acceleratorOf(shortcutId: string, chord = 0): string {
	const entry = SHORTCUTS.find((row) => row.id === shortcutId);
	if (!entry?.chords[chord]) throw new Error(`no chord ${chord} for ${shortcutId}`);
	return entry.chords[chord].replace(/\bMod\b/, 'CmdOrCtrl');
}

const separator: MenuNode = { kind: 'separator' };

export function buildMenuModel(state: MenuState): MenuNode[] {
	const lang = state.language;
	const item = (text: string, action: MenuAction, shortcutId?: string, chord?: number): MenuNode => ({
		kind: 'item',
		text,
		action,
		...(shortcutId ? { accelerator: acceleratorOf(shortcutId, chord) } : {}),
	});
	const viewer = (text: string, command: ViewerCommand, shortcutId?: string, chord?: number) =>
		item(text, { viewer: command }, shortcutId, chord);
	const app = (text: string, command: AppMenuCommand, shortcutId?: string) => item(text, { app: command }, shortcutId);
	// The toolbar's buttons run the same action ids through the same call.
	const format = (text: string, actionId: string): MenuNode => ({
		kind: 'item',
		text,
		action: { editor: actionId },
		accelerator: acceleratorOf(actionId),
		enabled: state.hasEditorPane,
	});
	// Named after the state, checked while it is on (macOS convention).
	const check = (text: string, action: MenuAction, checked: boolean, shortcutId?: string, enabled = true): MenuNode => ({
		kind: 'check',
		text,
		action,
		checked,
		enabled,
		...(shortcutId ? { accelerator: acceleratorOf(shortcutId) } : {}),
	});
	const split = state.viewMode === 'split';

	return [
		{
			kind: 'submenu',
			text: 'Markpad',
			items: [
				{ kind: 'predefined', item: { About: null }, text: t('menu.about', lang) },
				separator,
				viewer(t('menu.settings', lang), 'open-settings', 'app-settings'),
				app(t('menu.checkForUpdates', lang), 'check-updates'),
				separator,
				{ kind: 'predefined', item: 'Services', text: t('menu.services', lang) },
				separator,
				{ kind: 'predefined', item: 'Hide', text: t('menu.hideApp', lang) },
				separator,
				viewer(t('menu.quit', lang), 'app-exit', 'app-exit'),
			],
		},
		{
			kind: 'submenu',
			text: t('menu.file', lang),
			items: [
				viewer(t('menu.newFile', lang), 'new-file', 'file-new', 1),
				viewer(t('menu.newWindow', lang), 'new-window', 'file-new-window'),
				viewer(t('menu.openFile', lang), 'open-file', 'file-open'),
				app(t('folder.openFolder', lang), 'open-folder'),
				app(t('folder.closeFolder', lang), 'close-folder'),
				separator,
				viewer(t('menu.closeFile', lang), 'close-file', 'file-close'),
				viewer(t('menu.undoCloseTab', lang), 'undo-close-tab', 'tab-undo-close'),
				separator,
				viewer(t('menu.save', lang), 'save', 'file-save'),
				viewer(t('menu.saveAs', lang), 'save-as', 'file-save-as'),
				// F5 is the Windows reload key; a Mac menu prints no accelerator for it.
				viewer(t('menu.reloadFromDisk', lang), 'reload-from-disk'),
				viewer(t('menu.openFileLocation', lang), 'reveal-file', 'file-reveal'),
				separator,
				app(t('menu.exportHtml', lang), 'export-html'),
				viewer(t('menu.exportPdf', lang), 'export-pdf', 'file-export-pdf'),
			],
		},
		{
			kind: 'submenu',
			text: t('menu.edit', lang),
			// WKWebView hands ⌘X/⌘C/⌘V/⌘A/⌘Z in plain inputs to the main menu, so
			// without these every native field loses them (#526). Monaco
			// preventDefaults the keys first and keeps its own handlers.
			items: [
				{ kind: 'predefined', item: 'Undo', text: t('menu.undo', lang) },
				{ kind: 'predefined', item: 'Redo', text: t('menu.redo', lang) },
				separator,
				{ kind: 'predefined', item: 'Cut', text: t('menu.cut', lang) },
				{ kind: 'predefined', item: 'Copy', text: t('menu.copy', lang) },
				{ kind: 'predefined', item: 'Paste', text: t('menu.paste', lang) },
				{ kind: 'predefined', item: 'SelectAll', text: t('menu.selectAll', lang) },
				separator,
				viewer(t('menu.find', lang), 'find', 'app-find'),
				{
					kind: 'submenu',
					text: t('menu.format', lang),
					items: [
						format(t('menu.bold', lang), 'fmt-bold'),
						format(t('menu.italic', lang), 'fmt-italic'),
						format(t('menu.underline', lang), 'fmt-underline'),
						format(t('menu.strikethrough', lang), 'fmt-strikethrough'),
						format(t('menu.inlineCode', lang), 'fmt-inline-code'),
						format(t('menu.codeBlock', lang), 'fmt-code-block'),
						format(t('menu.quote', lang), 'fmt-quote'),
						separator,
						format(t('menu.heading1', lang), 'fmt-heading-1'),
						format(t('menu.heading2', lang), 'fmt-heading-2'),
						format(t('menu.heading3', lang), 'fmt-heading-3'),
						separator,
						format(t('menu.bulletList', lang), 'fmt-bullet-list'),
						format(t('menu.numberedList', lang), 'fmt-numbered-list'),
						format(t('menu.checklist', lang), 'fmt-checklist'),
						separator,
						format(t('menu.link', lang), 'fmt-link'),
						format(t('menu.insertTable', lang), 'insert-table-simple'),
					],
				},
			],
		},
		{
			kind: 'submenu',
			text: t('menu.view', lang),
			items: [
				// ⌘E does nothing in split view (`toggleEditView`), so neither does this.
				check(t('menu.editMode', lang), { viewer: 'toggle-edit-view' }, split || state.viewMode === 'edit', 'view-toggle-edit', !split),
				check(t('menu.splitView', lang), { viewer: 'toggle-split-view' }, split, 'view-toggle-split'),
				check(t('menu.autoReload', lang), { viewer: 'toggle-live-mode' }, state.liveMode, 'view-toggle-live'),
				separator,
				check(t('menu.tableOfContents', lang), { app: 'toggle-toc' }, state.showToc),
				check(t('menu.tabBar', lang), { app: 'toggle-tabs' }, state.showTabs, 'toggle-tabs'),
				check(t('tooltip.editorToolbar', lang), { app: 'toggle-editor-toolbar' }, state.showEditorToolbar),
				check(t('menu.fullWidth', lang), { app: 'toggle-full-width' }, state.previewFullWidth),
				// ⌘⌥[ and ⌘⌥] stay text-field keys inside a field, where the page
				// lets them through; an accelerator here would catch them there.
				viewer(t('menu.previewNarrower', lang), 'preview-width-narrower'),
				viewer(t('menu.previewWider', lang), 'preview-width-wider'),
				separator,
				viewer(t('menu.zoomIn', lang), 'zoom-in', 'view-zoom-in'),
				viewer(t('menu.zoomOut', lang), 'zoom-out', 'view-zoom-out'),
				viewer(t('menu.resetZoom', lang), 'zoom-reset', 'view-zoom-reset'),
				viewer(t('menu.zenMode', lang), 'toggle-zen-mode', 'toggle-zen-mode'),
				{ kind: 'predefined', item: 'Fullscreen', text: t('menu.toggleFullScreen', lang) },
			],
		},
		{
			kind: 'submenu',
			text: t('menu.window', lang),
			windowsMenu: true,
			items: [
				{ kind: 'predefined', item: 'Minimize', text: t('common.minimize', lang) },
				{ kind: 'predefined', item: 'Maximize', text: t('menu.zoomWindow', lang) },
				separator,
				// No accelerators: ⌥←/→ and ⌘[/] are caret and indent keys in the editor.
				viewer(t('menu.back', lang), 'history-back'),
				viewer(t('menu.forward', lang), 'history-forward'),
				viewer(t('menu.home', lang), 'toggle-home', 'app-home'),
				separator,
				// Ctrl+Tab is not a reliable menu key equivalent; the page answers it.
				viewer(t('menu.nextTab', lang), 'next-tab'),
				viewer(t('menu.previousTab', lang), 'previous-tab'),
				viewer(t('menu.moveToNextWindow', lang), 'move-tab-to-next-window', 'tab-move-window'),
				app(t('menu.mergeAllWindows', lang), 'merge-windows'),
				app(t('menu.setWindowTag', lang), 'set-window-tag'),
			],
		},
	];
}

type NativeItem = PredefinedMenuItemOptions | { text: string; items: NativeItem[] } | MenuItem | CheckMenuItem | Submenu;

/*
 * Every clickable item is created on its own (`MenuItem.new`) and held here
 * until the next install. Tauri keeps an item's click channel only while its
 * Rust wrapper lives (`tauri/src/menu/mod.rs:98` drops the channel with it),
 * and an item written inline into `Menu.new({ items })` has no owner once the
 * menu is built (`menu/menu.rs:264` hands AppKit only the native item), so its
 * clicks went nowhere.
 */
type Built = { owned: Resource[]; windowsMenu?: Submenu };

async function toNative(node: MenuNode, run: (action: MenuAction) => void, built: Built): Promise<NativeItem> {
	switch (node.kind) {
		case 'separator':
			return { item: 'Separator' };
		case 'predefined':
			return { item: node.item, text: node.text };
		case 'item': {
			const item = await MenuItem.new({ text: node.text, accelerator: node.accelerator, enabled: node.enabled ?? true, action: () => run(node.action) });
			built.owned.push(item);
			return item;
		}
		case 'check': {
			const item = await CheckMenuItem.new({ text: node.text, accelerator: node.accelerator, checked: node.checked, enabled: node.enabled ?? true, action: () => run(node.action) });
			built.owned.push(item);
			return item;
		}
		case 'submenu': {
			const items = await Promise.all(node.items.map((child) => toNative(child, run, built)));
			const submenu = await Submenu.new({ text: node.text, items: items as never });
			built.owned.push(submenu);
			if (node.windowsMenu) built.windowsMenu = submenu;
			return submenu;
		}
	}
}

let generation = 0;
let installed: Resource[] = [];
let queue: Promise<void> = Promise.resolve();

const closeAll = (resources: Resource[]) => Promise.all(resources.map((resource) => resource.close()));

/**
 * Build `model` and make it the app menu, unless a newer call came in behind
 * it or `stillWanted` says the window lost focus meanwhile. Installs run one
 * at a time, so `installed` is always what this window last set.
 *
 * Ids are left to Tauri on purpose: its click channels are keyed by item id
 * app-wide and dropped when an item is, so fixed ids would let one window's
 * old menu, freed late, unregister another window's live items.
 */
export function installAppMenu(model: MenuNode[], run: (action: MenuAction) => void, stillWanted: () => boolean): Promise<void> {
	const mine = ++generation;
	queue = queue.then(async () => {
		if (mine !== generation) return;
		const built: Built = { owned: [] };
		const items = await Promise.all(model.map((node) => toNative(node, run, built)));
		const menu = await Menu.new({ items: items as never });
		built.owned.push(menu);
		// Building takes round trips, in which another window may have taken focus.
		if (mine !== generation || !stillWanted()) return void (await closeAll(built.owned));
		const previous = await menu.setAsAppMenu();
		await built.windowsMenu?.setAsWindowsMenuForNSApp();
		await previous?.close();
		await closeAll(installed);
		installed = built.owned;
	}).catch(console.error);
	return queue;
}
