import { invoke } from '@tauri-apps/api/core';

import { tabManager, type Tab } from '../stores/tabs.svelte.js';
import { outgoingTabAnchorLine } from '../utils/editorPosition.js';
import { isHomePath } from '../utils/homeTab.js';
import { snapshotTab } from '../utils/tabTransfer.js';

type EditorPane = { flushPositionTo(tabId: string): void } | null | undefined;

/**
 * The viewer's half of the window session's options: what this window
 * sends when a tab leaves it, and how it takes one in.
 */
export function createTransferOptions(options: {
	editorPane: () => EditorPane;
	windowStateJson: () => string;
	isCloseWalkActive: () => boolean;
	isDisposed: () => boolean;
	renderPreview: (tab: Tab) => Promise<void>;
	/** Puts the preview back at the tab's reading position. */
	restoreReadingPosition: (tab: Tab) => void;
}) {
	const find = (tabId: string) => tabManager.tabs.find((item) => item.id === tabId);

	return {
		serializeState: () => {
			// Same reason as `transferPayload` below, at a different moment: this
			// runs at close and at each checkpoint with the editor still mounted,
			// so the tab being edited would be persisted at the position it held
			// when the editor last came down. Only the active tab can be the one
			// the editor holds.
			if (tabManager.activeTabId) options.editorPane()?.flushPositionTo(tabManager.activeTabId);
			return options.windowStateJson();
		},
		// A partially loaded buffer must never be handed to another window.
		// The transfer payload has no field for "incomplete" (see
		// tabTransfer.ts) and the destination rebuilds the tab from the
		// payload alone, so the arriving copy would look authoritative and its
		// auto-save would truncate the file. handleDetach and moveTabToWindow
		// complete the buffer first; these predicates are the backstop.
		canTransfer: (tabId: string) => {
			const tab = find(tabId);
			return !options.isCloseWalkActive() && tab !== undefined && !isHomePath(tab.path) && !tab.isTruncated;
		},
		canDetach: (tabId: string) => {
			const tab = find(tabId);
			return !options.isCloseWalkActive() && tab !== undefined && !isHomePath(tab.path) && !tab.isTruncated && tabManager.tabs.length >= 2;
		},
		transferPayload: (tabId: string) => {
			const tab = find(tabId);
			if (!tab) throw new Error('Tab disappeared before transfer');
			// The snapshot carries the reading position and is taken here,
			// synchronously, with the editor still mounted — so a tab being
			// edited would travel with the position from its last teardown, and a
			// tab opened straight into edit mode with 0. The preview writes its
			// own fields on every scroll and needs nothing; this is edit mode's
			// equivalent, and it is a no-op for any tab the editor is not on.
			options.editorPane()?.flushPositionTo(tabId);
			// The other half of the same problem: the flush can only speak for
			// the tab the editor is holding, and any other tab can be sent from
			// here too — the tab context menu names one, and `mergeSelfInto`
			// walks all of them. `editorViewState` is what covers a background
			// edit-mode tab in memory and it is excluded from the payload, so
			// the anchor is recovered from it before it is dropped.
			return JSON.stringify({
				...snapshotTab(tab),
				anchorLine: outgoingTabAnchorLine(tab, tabManager.activeTabId),
			});
		},
		acceptTransferredTab: async (snapshot: Parameters<typeof tabManager.insertTransferredTab>[0]) => {
			// The tab has to exist before it can be rendered, which leaves a
			// window where this side owns a document the source still shows.
			// Anything that goes wrong from here must undo the insert, or the
			// same file stays open in both windows with two auto-save timers
			// writing over each other.
			const id = tabManager.insertTransferredTab(snapshot);
			try {
				const transferred = find(id);
				if (!transferred) return null;
				await options.renderPreview(transferred);
				if (options.isDisposed()) {
					tabManager.closeTab(id);
					return null;
				}
				// The reading position travels with the tab, and until here nothing
				// put it back. `insertTransferredTab` activates the tab
				// synchronously, while its `content` is still `''`; the restore
				// effect runs on that activation against a host with no document in
				// it, finds no anchor and no scroll range, and the document the
				// reader left arrives afterwards at the top. That effect cannot
				// cover this by depending on the render — it also runs while the
				// reader is typing in split view, where a per-render dependency
				// would drag the preview back on every debounce — so the arrival
				// asks again, now that the render has awaited the patch and the
				// host holds the document.
				//
				// Guarded on the tab still being the active one: only the active
				// host is displayed, and the article all of them share would move
				// somebody else's document.
				if (tabManager.activeTabId === id) options.restoreReadingPosition(transferred);
				return id;
			} catch (error) {
				tabManager.closeTab(id);
				throw error;
			}
		},
	};
}

/**
 * Moving a tab out of this window preserves its state as-is — dirty content,
 * edit/split mode, history — so there is deliberately no canCloseTab() save
 * prompt here: movement is not closing. The content travels through the Rust
 * broker (never disk, never localStorage), and the source tab is deleted only
 * after the destination confirms the claim, so any failure — window creation
 * error, timeout — leaves the tab exactly where it was.
 *
 * A large file may still be holding only its preview slice. The receiving
 * window cannot tell, so the buffer is completed here, before the payload is
 * built — otherwise the document arrives short and gets written back that way.
 */
export function createTabMovers(options: {
	ensureFullContent: (tabId: string) => Promise<boolean>;
	onPartialDocument: () => void;
	session: {
		detach: (tabId: string) => Promise<boolean>;
		transfer: (tabId: string, deliver: (token: string) => Promise<void>) => Promise<boolean>;
	};
}) {
	return {
		async handleDetach(tabId: string) {
			if (!(await options.ensureFullContent(tabId))) {
				options.onPartialDocument();
				return false;
			}
			return options.session.detach(tabId);
		},
		async moveTabToWindow(tabId: string, targetLabel: string, focusAfter = false) {
			if (!(await options.ensureFullContent(tabId))) {
				options.onPartialDocument();
				return false;
			}
			const moved = await options.session.transfer(tabId, (token) => invoke('offer_tab_to_window', { targetLabel, token }));
			if (moved && focusAfter) await invoke('focus_window', { label: targetLabel });
			return moved;
		},
	};
}
