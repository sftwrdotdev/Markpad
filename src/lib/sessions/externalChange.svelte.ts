import type { LanguageCode } from '../utils/i18n.js';
import type { LoadMarkdownOptions } from './documentSession.svelte.js';

type ConflictTab = { id: string; path: string; originalContent: string; rawContent: string; isDirty: boolean };

export type ExternalChangeOptions = {
	tabManager: {
		readonly tabs: ConflictTab[];
		readonly activeTab: ConflictTab | null | undefined;
		readonly activeTabId: string | null | undefined;
	};
	settings: { readonly autoSave: boolean; readonly language: LanguageCode };
	documentSession: {
		saveContent: (tabId: string) => Promise<boolean>;
		allowOverwriteOnce: (tabId: string) => void;
		resolveExternalChange: (
			changedPath: string,
		) => Promise<{ action: 'ignore' } | { action: 'reload' | 'conflict'; tabId: string; path: string }>;
	};
	loadMarkdown: (path: string, options: LoadMarkdownOptions) => Promise<unknown>;
	canCloseTab: (tabId: string) => Promise<boolean>;
	/** `read_file_content_checked`: the file as it is on disk now. */
	readFile: (path: string) => Promise<[string, boolean, string]>;
	editorLanguageFor: (path: string) => string;
	addToast: (message: string, type?: 'info' | 'error' | 'warning') => unknown;
	t: (key: string, language: LanguageCode) => string;
};

export type Comparison = { tabId: string; onDisk: string; mine: string; language: string };

/**
 * The viewer's saves and the external-change conflict bar they answer to:
 * Cmd+S, the saves nobody asked for, Reload, Compare and Keep mine.
 */
export function createExternalChange(options: ExternalChangeOptions) {
	const { tabManager, settings, documentSession, loadMarkdown, addToast, t } = options;

	async function saveContent(tabId?: string): Promise<boolean> {
		const id = tabId ?? tabManager.activeTabId ?? '';
		// Only the saves the user asked for come here — Cmd+S, the menu and
		// title bar Save. Saves nobody asked for go through `saveSilently`.
		// So a save that lands here IS the answer "keep my version": it both
		// authorises the write the session would otherwise refuse, and leaves
		// the bar with nothing to ask.
		//
		// Without the first half the bar became a trap: the disk really has
		// changed, so the guard in `saveContent` refuses, so the bar goes back
		// up, and Cmd+S can never get the user out of it.
		if (hasExternalChangeConflict(id)) documentSession.allowOverwriteOnce(id);
		return saveSilently(id);
	}

	/**
	 * Ctrl+S from any mode. An untitled buffer has content to write. A clean
	 * saved file is a no-op, so its mtime does not wake the watcher.
	 */
	function saveActiveTab(): Promise<boolean> | undefined {
		const saveTarget = tabManager.activeTab;
		if (saveTarget && (saveTarget.isDirty || saveTarget.path === '')) return saveContent();
	}

	/**
	 * A save nobody asked for: the debounce, leaving an editable pane, the
	 * exit's auto-save. It never authorises overwriting a changed file, so on
	 * a conflicted tab the session's guard refuses it and the bar stays up.
	 */
	async function saveSilently(tabId: string): Promise<boolean> {
		const saved = await documentSession.saveContent(tabId);
		if (saved) clearExternalChangeConflict(tabId);
		return saved;
	}

	/**
	 * The last auto-save a tab gets before it stops being auto-saveable.
	 *
	 * Shared by the two ways out of an editable pane (leaving edit mode,
	 * closing split view). It is NOT a condition of the switch: the view
	 * changes whether or not the write succeeds, and nothing here asks the
	 * user anything. The only reason it exists is that the background debounce
	 * requires `isEditing || isSplit` (see the auto-save effect), so the tab is
	 * about to lose its scheduled writer while still dirty — a user who asked
	 * for "save automatically" would otherwise be left with edits that no timer
	 * is going to flush.
	 *
	 * Untitled tabs are excluded on purpose: `saveContent` would open the Save
	 * dialog for them, which is exactly the forced save decision this stopped
	 * making.
	 */
	async function flushBeforeLeavingEditableMode(tab: ConflictTab) {
		if (!tab.isDirty || tab.path === '') return;
		// Auto-save off means edits are kept until the user saves them, so
		// leaving the pane must not write either — closing keeps or asks.
		if (!settings.autoSave) return;

		const success = await saveSilently(tab.id);
		if (!success) {
			// Refused because the file changed underneath: the edit stays in
			// the buffer and the conflict bar is already asking about it.
			if (hasExternalChangeConflict(tab.id)) return;
			// Reported, not obeyed. A file that cannot be written — read-only
			// path, a buffer the lossy-decode guard refuses — used to trap the
			// user in the editor with no way to look at their own text.
			addToast(t('toast.autoSaveFailed', settings.language), 'error');
			return;
		}
		if (tab.isDirty) {
			// TOCTOU: the user typed during the await, so the file is one
			// revision behind and the debounce is about to be dropped. The
			// preview shows those newest edits, so nothing is lost or wrong on
			// screen; the disk is what the user should hear about.
			addToast(t('toast.savedNewerEdits', settings.language), 'info');
		}
	}

	// --- External change conflicts ---
	// A file changed on disk while the tab holding it had unsaved edits. The
	// reload is NOT performed: `setTabRawContent` replaces originalContent
	// too, so an automatic reload would erase the edits and the fact that
	// there were any. The tab is flagged instead and the user picks.
	//
	// The question is about one file at one baseline, so that is what is
	// recorded. Anything that puts another document in the tab — a link, back
	// and forward, Reload, Save As, the close dialog's Save or Don't Save —
	// moves the path or the baseline, and the conflict is void without each of
	// them having to remember to clear it.
	const externalChangeConflicts = $state<Record<string, { path: string; baseline: string }>>({});

	function hasExternalChangeConflict(tabId: string): boolean {
		const conflict = externalChangeConflicts[tabId];
		const tab = tabManager.tabs.find((item) => item.id === tabId);
		return !!conflict && !!tab && tab.path === conflict.path && tab.originalContent === conflict.baseline;
	}

	function noteExternalChangeConflict(tabId: string) {
		const tab = tabManager.tabs.find((item) => item.id === tabId);
		if (tab) externalChangeConflicts[tabId] = { path: tab.path, baseline: tab.originalContent };
	}

	function clearExternalChangeConflict(tabId: string) {
		delete externalChangeConflicts[tabId];
	}

	/** "Reload": the user chose the disk version over their own edits. */
	async function resolveExternalChangeByReloading(tabId: string) {
		// The reload lands in the active tab, so it is refused for any other.
		const tab = tabManager.activeTab;
		if (!tab?.path || tab.id !== tabId) return;
		comparison = null;
		clearExternalChangeConflict(tab.id);
		await loadMarkdown(tab.path, {
			preserveEditState: true,
			skipTabManagement: true,
			resetScrollHistory: true,
			// The user answered "the file changed under your edits" with the
			// disk version. Every other caller of loadMarkdown is an OPEN and
			// must leave an edited buffer alone; this one is the revert, and
			// says so rather than leaving the session to infer it.
			discardUnsavedBuffer: true,
		});
	}

	async function reloadFromDisk() {
		const activeId = tabManager.activeTabId;
		const tab = tabManager.activeTab;
		if (!activeId || !tab?.path) return;
		if (!(await options.canCloseTab(activeId))) return;

		await loadMarkdown(tab.path, {
			preserveEditState: true,
			skipTabManagement: true,
			resetScrollHistory: true,
			// canCloseTab has already resolved the buffer, so normally there is
			// nothing left to discard — but the user can type during that await,
			// and a reload that silently did nothing would be worse than one
			// that does what its menu item says.
			discardUnsavedBuffer: true,
		});
		addToast(t('toast.reloadedFromDisk', settings.language), 'info');
	}

	/**
	 * The two versions the conflict bar is asking about, once the user has
	 * asked to see them.
	 *
	 * Read on demand rather than kept alongside the flag: the bar can stand for
	 * a while, and what matters is what the file says when the question is
	 * actually being answered, not what it said when it was raised.
	 */
	let comparison = $state<Comparison | null>(null);

	// The overlay answers for the tab it was opened on. Switching tabs, or that
	// tab's conflict going void, closes it rather than letting its buttons land
	// on whatever is in front. The viewer runs this in an `$effect`.
	function closeStaleComparison() {
		if (comparison && (comparison.tabId !== tabManager.activeTabId || !hasExternalChangeConflict(comparison.tabId))) {
			comparison = null;
		}
	}

	/** "Compare": show what Reload would replace, before it is irreversible. */
	async function compareExternalChange() {
		const tab = tabManager.activeTab;
		if (!tab?.path) return;
		try {
			const [onDisk] = await options.readFile(tab.path);
			if (tabManager.activeTabId !== tab.id) return;
			comparison = {
				tabId: tab.id,
				onDisk,
				mine: tab.rawContent,
				language: options.editorLanguageFor(tab.path),
			};
		} catch (error) {
			console.error('Failed to read the file for comparison', error);
			addToast(`${t('externalChange.compare', settings.language)}: ${String(error)}`, 'error');
		}
	}

	/** "Keep my version": dismiss. The buffer stays dirty and saveable. */
	function resolveExternalChangeByKeepingBuffer(id: string) {
		// The answer is about a write, not about a bar: the next save has to be
		// allowed past the guard that would otherwise refuse to overwrite the
		// changed file. One save only — a third program writing a minute later
		// is a new question, and the user has not answered that one.
		documentSession.allowOverwriteOnce(id);
		comparison = null;
		clearExternalChangeConflict(id);
	}

	/**
	 * A `file-changed` event from the watcher. The event names the changed
	 * file. Which tab that touches — and whether it may be reloaded at all —
	 * is decided by the session: it owns the self-write grace window (so our
	 * own auto-save does not bounce back) and it refuses to reload a tab with
	 * unsaved edits. A conflict is noted with Live Mode off too; Live Mode
	 * gates only the reload.
	 */
	async function handleFileChanged(changedPath: string, liveMode: boolean) {
		const outcome = await options.documentSession.resolveExternalChange(changedPath);
		if (outcome.action === 'ignore') return;
		if (outcome.action === 'conflict') {
			noteExternalChangeConflict(outcome.tabId);
			return;
		}
		if (liveMode) options.loadMarkdown(outcome.path, {});
	}

	return {
		get comparison() {
			return comparison;
		},
		closeComparison: () => void (comparison = null),
		closeStaleComparison,
		saveContent,
		saveActiveTab,
		saveSilently,
		flushBeforeLeavingEditableMode,
		hasExternalChangeConflict,
		noteExternalChangeConflict,
		clearExternalChangeConflict,
		resolveExternalChangeByReloading,
		reloadFromDisk,
		compareExternalChange,
		resolveExternalChangeByKeepingBuffer,
		handleFileChanged,
	};
}
