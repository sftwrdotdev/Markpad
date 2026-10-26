import { invoke } from '@tauri-apps/api/core';

import { reviewDirtyTabs } from './closeReview.js';
import { isHomePath } from '../utils/homeTab.js';
import { pinnedTagHolder, pinnedWindowToken } from '../utils/pinnedTagWindow.js';
import { hasRealFilePath } from '../utils/tabFileActions.js';

type ExitTab = { id: string; path: string; isDirty: boolean };
type WindowTag = { name: string; color: string; pinned: boolean };
export type PinnedTag = { name: string; color: string; files: string[] };

export type WindowExitOptions = {
	tabManager: {
		readonly tabs: ExitTab[];
		readonly windowTag: WindowTag | null;
		closeTab: (id: string) => void;
		setActive: (id: string) => void;
		setWindowTag: (tag: { name: string; color: string; pinned?: boolean } | null) => void;
	};
	settings: {
		readonly autoSave: boolean;
		readonly restoreStateOnReopen: boolean;
		readonly closeWindowWithLastTab: boolean;
		readonly persistOpenEditors: boolean;
	};
	appWindow: { readonly label: string; close: () => Promise<void>; destroy: () => Promise<void> };
	/** Every window of the app, this one included (`getAllWindows`). */
	allWindows: () => Promise<{ readonly label: string; close: () => Promise<void> }[]>;
	/** The unsaved-change backup: whether it was restored, and its two writes. */
	recovery: {
		isReady: () => boolean;
		/** Write the current buffers. False when the backup could not be written. */
		keep: () => Promise<boolean>;
		/** Write an empty backup, so a discarded buffer stays gone. */
		drop: () => Promise<boolean>;
	};
	persistWindowState: (remember: boolean) => Promise<void>;
	canCloseTab: (id: string) => Promise<boolean>;
	saveSilently: (id: string) => Promise<boolean>;
	hasExternalChangeConflict: (id: string) => boolean;
	onAutoSaveFailed: () => void;
	/** Let an activation paint before a dialog covers it — `tick()` in the app. */
	settle: () => Promise<void>;
	loadMarkdown: (path: string) => Promise<unknown>;
	setShowHome: (value: boolean) => void;
	moveTabToWindow: (tabId: string, targetLabel: string) => Promise<unknown>;
};

/**
 * Every way a window ends: the red button, quit, the in-app update, the last
 * tab's ×, and a merge into another window. Each one resolves unsaved tabs,
 * saves a pinned tag's files and writes the window snapshot, in that order.
 */
export function createWindowExit(options: WindowExitOptions) {
	const { tabManager, settings, appWindow } = options;

	// True while the window-close walk is showing per-tab dialogs; the native
	// red button is not blocked by the dialog overlay, so this keeps a second
	// close request from starting a competing walk.
	let closeWalkActive = false;

	// The files the close review started from. It can close tabs, and the
	// close it re-triggers settles again, so both saves use this list.
	let pinFilesAtClose: string[] | null = null;

	function openFilePaths() {
		return tabManager.tabs.filter((tab) => hasRealFilePath(tab.path)).map((tab) => tab.path);
	}

	/**
	 * Every path that ends a window saves the pin before it closes tabs. An
	 * empty window says nothing about the group, so it never overwrites it.
	 * It only refreshes the entry: another window may have unpinned the tag.
	 */
	async function savePinnedTagIfNeeded() {
		const tag = tabManager.windowTag;
		if (!tag?.pinned) return;
		const files = pinFilesAtClose ?? openFilePaths();
		if (files.length === 0) return;
		const pinned = await invoke('update_pinned_tag', { name: tag.name, color: tag.color, files });
		if (!pinned) tabManager.setWindowTag({ ...tag, pinned: false });
	}

	async function openPinnedTag(tag: PinnedTag) {
		// Two windows sharing a tag share one pin entry, and the last to save wins.
		const holder = await pinnedTagHolder(tag.name, appWindow.label);
		if (holder) {
			await invoke('focus_window', { label: holder });
			return;
		}
		// Tabs already here belong to this window's own group. The pinned one
		// opens in a window of its own, which adopts it from its label.
		if (tabManager.tabs.some((tab) => !isHomePath(tab.path))) {
			await invoke('create_transfer_window', { token: pinnedWindowToken(tag.name, Date.now()), tagName: tag.name });
			return;
		}
		tabManager.setWindowTag({ ...tag, pinned: true });
		for (const file of tag.files) await options.loadMarkdown(file);
		options.setShowHome(false);
	}

	/**
	 * Hot exit: keep unsaved buffers instead of asking. Pending auto-saves write
	 * their files first; a refused or failed save stays dirty and is kept. False
	 * when the backup cannot be written or `applies` says no, and the caller asks
	 * as usual. `applies` runs inside the walk guard, so a second close is refused meanwhile.
	 */
	async function keepUnsavedForExit(applies = async () => true): Promise<boolean> {
		if (!options.recovery.isReady()) return false;
		closeWalkActive = true;
		try {
			if (!(await applies())) return false;
			if (settings.autoSave) {
				for (const tab of tabManager.tabs.filter((t) => t.isDirty && t.path !== '')) await options.saveSilently(tab.id);
			}
			if (!(await options.recovery.keep())) return false;
		} finally {
			closeWalkActive = false;
		}
		await savePinnedTagIfNeeded();
		await options.persistWindowState(true);
		return true;
	}

	/**
	 * The save/discard close, used when "Restore unsaved changes on launch" is off, when
	 * closing one of several windows, or when the backup cannot be written
	 * (`keepUnsavedForExit` runs first otherwise).
	 * Resolve this window's unsaved tabs, then write the restore snapshot: the
	 * work that has to happen before the window goes away. False when the reader
	 * cancelled, and nothing has been written.
	 *
	 * The close button and the in-app update both run it. An update ends the
	 * process without closing a window — the Windows updater exits inside
	 * `downloadAndInstall`, `relaunch()` requests an exit elsewhere — so
	 * CloseRequested never fires, and both jobs used to go down with it (#761).
	 */
	async function settleForExit(remember: () => Promise<boolean>): Promise<boolean> {
		// Unsaved content and session restore are separate concerns: dirty tabs
		// are resolved FIRST through the per-tab dialogs, then the restore
		// snapshot records window state only (open files, active tab, edit mode,
		// split, scroll) — it never carries document content.
		const dirtyTabs = tabManager.tabs.filter((t) => t.isDirty);
		if (dirtyTabs.length > 0) {
			closeWalkActive = true;
			pinFilesAtClose ??= openFilePaths();
			// The walk's dialogs are in-app modals inside THIS window: with
			// multiple windows, another window may be covering it and the review
			// would be invisible. Bring the reviewing window to the front first.
			invoke('show_window').catch(console.error);
			try {
				// Auto-save without confirmation: silently save every dirty tab
				// that has a real path. Untitled tabs need a Save dialog, so the
				// walk below handles them. A failed silent save is surfaced and its
				// tab also goes to the walk. `saveContent` cancels each tab's pending
				// timer itself, so no writer here can be raced by its own debounce.
				// A tab whose file changed underneath is refused rather than
				// overwritten, and the walk asks the changed-on-disk question.
				if (settings.autoSave) {
					for (const tab of dirtyTabs.filter((t) => t.path !== '')) {
						const ok = await options.saveSilently(tab.id);
						if (!ok && options.hasExternalChangeConflict(tab.id)) continue;
						if (!ok) {
							options.onAutoSaveFailed();
							break;
						}
					}
				}

				// Close review (issue #189): walk the remaining dirty tabs one at a
				// time — activate each and run the same localized unsaved-changes
				// dialog a single tab close shows. Cancel stops the walk and keeps
				// the window open. Strict tab-strip order (left to right) so the
				// sequence is predictable; numbered untitled titles let the dialog
				// name each tab. Re-find every round — a save can leave a tab dirty
				// again (TOCTOU) and tabs can change while a dialog is up.
				const resolved = await reviewDirtyTabs({
					nextDirtyTab: () => tabManager.tabs.find((t) => t.isDirty),
					setActive: (id) => tabManager.setActive(id),
					settle: options.settle,
					canCloseTab: options.canCloseTab,
					closeTab: (id) => tabManager.closeTab(id),
					// Resolved tabs (saved, or reverted by Don't Save) stay open for
					// the window-state snapshot when restore is enabled; untitled
					// tabs have nothing to restore, and with restore off the red
					// button closes tabs one by one.
					shouldCloseAfterResolving: (tab) => !settings.restoreStateOnReopen || tab.path === '',
				});
				if (!resolved) {
					pinFilesAtClose = null;
					return false;
				}
			} finally {
				closeWalkActive = false;
			}
		}

		// Session is clean now; record the window state for restore. Awaited:
		// the caller holds the exit until the Rust write returns, so the process
		// cannot exit under the snapshot.
		await savePinnedTagIfNeeded();
		// The re-triggered close finds nothing to review and uses the list last.
		if (dirtyTabs.length === 0) pinFilesAtClose = null;
		// Asked now, not when the close began: the review above can take minutes.
		await options.persistWindowState(await remember());
		return true;
	}

	/**
	 * The update's settle. No re-triggered close follows it: the process exits,
	 * or the install fails and the window stays. Either way the review's list
	 * has been saved, and kept it would outlive a failed install into the next
	 * last-tab close, merge or Close Tag.
	 */
	async function settleForUpdate(): Promise<boolean> {
		if (settings.persistOpenEditors && (await keepUnsavedForExit())) return true;
		try {
			// The process exits with every window, so this one is remembered.
			return await settleForExit(async () => true);
		} finally {
			pinFilesAtClose = null;
		}
	}

	/** `appWindow.onCloseRequested`'s handler. */
	async function handleCloseRequested(event: { preventDefault: () => void }) {
		// The red button is a native control, so it is NOT blocked
		// by the in-app dialog overlay: a second click while the
		// walk below is showing a dialog would re-enter this handler
		// and start a competing walk whose setActive calls fight the
		// first one — the highlighted tab stops matching the dialog.
		// One walk at a time.
		if (closeWalkActive) {
			event.preventDefault();
			return;
		}

		// Hot exit on quit or when the app exits with this window: the
		// backup is written, nothing to ask, close proceeds. Closing one
		// of several windows asks below. Decided before `hadDirtyTabs`:
		// the buffers stay dirty, and a re-triggered close would only
		// find them again. If unsure, ask.
		const keepsUnsaved = () => invoke<boolean>('keeps_unsaved_on_close').catch(() => false);
		if (settings.persistOpenEditors && (await keepUnsavedForExit(keepsUnsaved))) return;

		// With tabs to review the close is held open while their
		// dialogs are up, then re-triggered: the handler re-enters,
		// finds nothing dirty, and the close proceeds.
		const hadDirtyTabs = tabManager.tabs.some((t) => t.isDirty);
		if (hadDirtyTabs) event.preventDefault();
		// Closing one of several windows forgets it; quit or the last window remembers.
		const endsSession = () => invoke<boolean>('keeps_unsaved_on_close').catch(() => true);
		if (!(await settleForExit(endsSession))) {
			// A cancelled close cancels the quit, so the windows left ask again.
			invoke('set_quitting', { quitting: false }).catch(console.error);
			return;
		}
		// Resolved: drop the backup, so a discarded buffer stays gone.
		if (options.recovery.isReady()) await options.recovery.drop();
		if (hadDirtyTabs) appWindow.close();
	}

	/**
	 * Quit is the red button applied to every window. Each one runs its own
	 * `onCloseRequested`: reviews its unsaved tabs, writes its own restore
	 * snapshot, and closes.
	 *
	 * It used to discard the snapshot instead, so ⌘Q and the red button
	 * disagreed about whether the session came back — and the dialog that
	 * explained the difference only appeared when a tab was dirty, which is
	 * not the path most people take (#390). It also closed nothing but the
	 * focused window, so quitting with two windows open did not quit.
	 *
	 * Every other window is asked at once rather than one after another:
	 * `close()` resolves when the request is sent, not when the window is
	 * gone, and there is no reply saying whether the reader cancelled. Two
	 * windows with unsaved work therefore show their own dialogs side by side,
	 * each still guarding its own buffers.
	 */
	async function appExit() {
		// Quit keeps unsaved changes in every window, not only the last one.
		await invoke('set_quitting', { quitting: true }).catch(console.error);
		for (const other of await options.allWindows()) {
			if (other.label !== appWindow.label) await other.close();
		}
		await appWindow.close();
	}

	async function destroyWindowAfterTabsClosed() {
		// No tabs left: drop this window's backup so a discarded buffer stays gone.
		if (options.recovery.isReady()) await options.recovery.drop();
		await options.persistWindowState(false);

		await appWindow.destroy();
	}

	async function closeTabAndWindowIfLast(tabId: string) {
		if (!(await options.canCloseTab(tabId))) return;

		if (tabManager.tabs.length === 1) await savePinnedTagIfNeeded();
		tabManager.closeTab(tabId);
		if (tabManager.tabs.length > 0) return;

		invoke('unwatch_file').catch(console.error);
		// Off, the empty window stays and renders Home.
		if (settings.closeWindowWithLastTab) await destroyWindowAfterTabsClosed();
	}

	async function mergeSelfInto(targetLabel: string) {
		if (closeWalkActive) return;
		await savePinnedTagIfNeeded();
		for (const tab of [...tabManager.tabs]) {
			if (isHomePath(tab.path)) {
				tabManager.closeTab(tab.id);
				continue;
			}
			await options.moveTabToWindow(tab.id, targetLabel);
		}
		if (tabManager.tabs.length === 0) {
			if (options.recovery.isReady()) await options.recovery.drop();
			await options.persistWindowState(false);
			await appWindow.destroy();
		}
	}

	return {
		isCloseWalkActive: () => closeWalkActive,
		savePinnedTagIfNeeded,
		openPinnedTag,
		keepUnsavedForExit,
		settleForExit,
		settleForUpdate,
		handleCloseRequested,
		appExit,
		destroyWindowAfterTabsClosed,
		closeTabAndWindowIfLast,
		mergeSelfInto,
	};
}
