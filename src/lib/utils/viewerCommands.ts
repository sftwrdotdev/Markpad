import { adjustPreviewMaxWidth } from './previewWidth.js';
import type { ViewerCommand } from './viewerKeymap.js';

/**
 * What the viewer hands the command table: the settings and tabs it mutates,
 * and the component's own functions for everything else. Read at run time, so
 * `tabManager.activeTabId` is the active tab when the key is pressed.
 */
export type ViewerCommandHost = {
	settings: {
		previewFullWidth: boolean;
		previewMaxWidth: number;
		showTabs: boolean;
		toggleZenMode(): void;
		zoomIn(): void;
		zoomOut(): void;
		resetZoom(): void;
	};
	tabManager: { readonly activeTabId: string | null; cycleTab(direction: 'next' | 'prev'): void };
	reloadFromDisk(): unknown;
	carryActiveTabToNextWindow(): unknown;
	closeFile(): unknown;
	handleNewFile(): unknown;
	openNewWindow(): Promise<unknown>;
	selectFile(): unknown;
	appExit(): unknown;
	toggleSplitView(tabId: string): unknown;
	toggleLiveMode(): unknown;
	toggleEditView(): unknown;
	saveContentAs(): unknown;
	saveActiveTab(): unknown;
	handleUndoCloseTab(): unknown;
	navigateFileHistory(direction: 'back' | 'forward'): unknown;
	openSettings(): void;
	toggleHome(): void;
	exportAsPdf(): unknown;
	openFileLocation(): unknown;
	triggerFindAction(): void;
};

/**
 * `viewerKeymap.ts` decides which command a keystroke means. This maps each
 * command to what runs it. A `Record` over the union, so a command with no
 * entry does not compile.
 */
export function viewerCommandTable(host: ViewerCommandHost): Record<ViewerCommand, () => void> {
	const { settings, tabManager } = host;
	const previewWidth = (delta: number) => () => {
		settings.previewFullWidth = false;
		settings.previewMaxWidth = adjustPreviewMaxWidth(settings.previewMaxWidth, delta);
	};
	return {
		'preview-width-narrower': previewWidth(-40),
		'preview-width-wider': previewWidth(40),
		'reload-from-disk': () => void host.reloadFromDisk(),
		'move-tab-to-next-window': () => void host.carryActiveTabToNextWindow(),
		'close-file': () => void host.closeFile(),
		'new-file': () => void host.handleNewFile(),
		'new-window': () => void host.openNewWindow().catch(console.error),
		'open-file': () => void host.selectFile(),
		'app-exit': () => void host.appExit(),
		'toggle-split-view': () => {
			if (tabManager.activeTabId) host.toggleSplitView(tabManager.activeTabId);
		},
		'toggle-live-mode': () => void host.toggleLiveMode(),
		'toggle-zen-mode': () => settings.toggleZenMode(),
		'toggle-tabs': () => {
			settings.showTabs = !settings.showTabs;
		},
		'toggle-edit-view': () => void host.toggleEditView(),
		'save-as': () => void host.saveContentAs(),
		// Save from any mode; see `saveActiveTab`.
		save: () => void host.saveActiveTab(),
		'undo-close-tab': () => void host.handleUndoCloseTab(),
		'next-tab': () => tabManager.cycleTab('next'),
		'previous-tab': () => tabManager.cycleTab('prev'),
		'history-back': () => void host.navigateFileHistory('back'),
		'history-forward': () => void host.navigateFileHistory('forward'),
		'zoom-in': () => settings.zoomIn(),
		'zoom-out': () => settings.zoomOut(),
		'zoom-reset': () => settings.resetZoom(),
		'open-settings': () => host.openSettings(),
		'toggle-home': () => host.toggleHome(),
		'export-pdf': () => void host.exportAsPdf(),
		'reveal-file': () => void host.openFileLocation(),
		find: () => host.triggerFindAction(),
	};
}
