import { invoke } from '@tauri-apps/api/core';
import { save } from '@tauri-apps/plugin-dialog';
import { settings } from '../stores/settings.svelte.js';
import { tabManager, type Tab } from '../stores/tabs.svelte.js';
import { getMarkdownBodyWithoutFrontMatter } from '../utils/frontMatter.js';
import { t } from '../utils/i18n.js';
import { LIST_MARKER, LIST_MARKER_PREFIX, TASK_BOX } from '../utils/listSyntax.js';
import { hasMarkdownLinkExtension } from '../utils/markdownLinks.js';
import { canonicalizePath, isSameFilePath } from '../utils/pathIdentity.js';

export type LoadMarkdownOptions = {
	navigate?: boolean;
	skipTabManagement?: boolean;
	preserveEditState?: boolean;
	resetScrollHistory?: boolean;
	/**
	 * Read the file even though the tab that will receive it holds unsaved
	 * edits, discarding them. This is a REVERT, not an open, and only a caller
	 * acting on an explicit user decision may ask for it — the "Reload" answer
	 * to the external-change conflict, or "Reload from disk" after the close
	 * dialog has already resolved the buffer.
	 *
	 * Defaults to false, which is what makes `loadMarkdown` safe to call from
	 * every "open this file" entry point (recent files, drag-and-drop, a link
	 * opened in a new tab, the OS handing us a path) without each of them
	 * having to know whether that file is already open and edited.
	 */
	discardUnsavedBuffer?: boolean;
};

/**
 * What to do about a file the watcher reported as changed on disk.
 * `conflict` means the owning tab has unsaved edits, so the choice belongs
 * to the user rather than to a background reload.
 */
type ExternalChangeOutcome =
	| { action: 'ignore' }
	| { action: 'reload'; tabId: string; path: string }
	| { action: 'conflict'; tabId: string; path: string };

type DocumentSessionOptions = {
	setShowHome: (value: boolean) => void;
	currentFile: () => string;
	resetScrollHistory: () => void;
	renderMarkdown: (raw: string, path: string, foldOverrides: Set<string>) => Promise<string>;
	afterLoad: () => Promise<unknown>;
	saveRecentFile: (path: string) => void;
	deleteRecentFile: (path: string) => void;
	setLoadingTabs: (tabIds: string[]) => void;
	measureInitialViewport: () => void;
	isScrolling: () => boolean;
	renderRichContent: () => void;
	onError: (message: string, error: unknown) => void;
	/** The disk moved under a save, which was refused. Raise the conflict bar. */
	onDiskChangedUnderSave: (tabId: string) => void;
	cancelPendingAutoSave: (tabId: string) => void;
	askClose: (title: string) => Promise<'save' | 'discard' | 'cancel'>;
	onCloseSaveNewerEdits: () => void;
	onCloseAutoSaveFailed: () => void;
	/**
	 * A Save As wrote a copy that stops where the load did. Not a failure — the
	 * copy is the way out of a partial buffer — but the reader has to be told
	 * what is in the file they just made.
	 */
	onPartialCopySaved: () => void;
};

/**
 * Which folds the tab being loaded has flipped from the opening position its
 * own source asks for, read at render time rather than captured up front. A
 * large file is rendered twice — the 5MB preview, then the whole document once
 * the background read lands — and the user can fold something in between; the
 * second render has to honour that. An unknown tab flips nothing, which is what
 * a load of a tab that has since been closed should hand a renderer.
 */
function foldsForTab(tabId: string): Set<string> {
	return tabManager.tabs.find((item) => item.id === tabId)?.foldOverrides ?? new Set<string>();
}

export function createDocumentSession(options: DocumentSessionOptions) {
	const loadRevisionByTab = new Map<string, number>();
	const loadingTabs = new Set<string>();
	// Tabs whose next save is authorised to overwrite a changed file, set by
	// answering the conflict bar with "keep mine". One save each.
	const overwriteAllowed = new Set<string>();

	/**
	 * Per tab: a promise that settles once every save queued for it so far has
	 * finished. Absent means nothing is in flight.
	 */
	const writeChainByTab = new Map<string, Promise<void>>();

	/**
	 * Run `write` only once the tab's previous write has settled.
	 *
	 * Two saves can be aimed at one tab at the same instant. #436 stopped an
	 * *armed* auto-save debounce from firing during an explicit save, but the
	 * timer callback drops itself from the timer map as its first statement and
	 * only then calls `saveContent` — so a debounce that has ALREADY fired is
	 * past cancelling, and its write is free to race a Cmd+S that arrives while
	 * it awaits. `atomic_write` (also #436) makes two concurrent writers safe
	 * for the file, but that is a safety property, not an ordering one: the
	 * older snapshot can still rename last and publish itself over the newer.
	 *
	 * Waiting, rather than handing the in-flight promise back to the second
	 * caller — those are different answers. The second caller pressed Cmd+S
	 * *after* typing more, so returning the running write would report success
	 * for a file that does not contain those keystrokes. Waiting costs one disk
	 * write and ends with the text the user actually asked to save on disk.
	 *
	 * Keyed by tab rather than by path: the state these writes corrupt is the
	 * tab's own (`originalContent`, `isDirty`, its path), the two racers are by
	 * construction one tab's, and an untitled tab has no path to key on until
	 * its Save dialog closes. Two tabs pointing at one file still write
	 * concurrently — that is last-writer-wins between two documents, which this
	 * app permits by allowing the second tab at all, and is not this race.
	 *
	 * A chain and not a bare `await inFlight`, because several callers awaiting
	 * one promise all wake together and then all write at once — the race again.
	 */
	function writeExclusively<T>(tabId: string, write: () => Promise<T>): Promise<T> {
		const previous = writeChainByTab.get(tabId);
		const result = previous ? previous.then(write) : write();
		// Outcome-free by design: a save that fails must not strand the queue
		// behind it, and nothing here is the owner of that rejection.
		const settled = result.then(
			() => {},
			() => {},
		);
		writeChainByTab.set(tabId, settled);
		void settled.then(() => {
			// Only the tail clears the entry. An earlier link finishing must not
			// drop a chain that later callers are still queued behind.
			if (writeChainByTab.get(tabId) === settled) writeChainByTab.delete(tabId);
		});
		return result;
	}

	/**
	 * Has this file changed from the version the tab believes is on disk?
	 *
	 * The one question both halves of the external-change guard are asking,
	 * which is why they are one function. `originalContent` IS the text last
	 * known to be in the file — every load sets it, every successful save sets
	 * it — so "different" means somebody has written since, and "equal" means
	 * nobody has, whoever ran the write.
	 *
	 * It replaces a 400ms window opened at each of our own writes, inside which
	 * every event for that path was discarded as ours. A clock cannot answer a
	 * question about identity, and it was wrong in both directions:
	 *
	 * - too early — another program writing inside the window had its event
	 *   DROPPED, with nothing re-queued. The buffer then held our text and the
	 *   disk held theirs, with the tab looking clean, so the next keystroke's
	 *   auto-save put ours back over theirs. Silent loss of someone else's
	 *   edit, which is the exact thing this guard exists to prevent.
	 * - too late — an event arriving after the window (a network share, a
	 *   synced folder, any watcher latency over 400ms) read as external, and if
	 *   the user had typed since, the conflict bar asked about their own save.
	 *   Zed is disliked for precisely this (zed-industries/zed#42108): a
	 *   question that is sometimes false teaches people to dismiss it,
	 *   including the times it is true.
	 *
	 * A truncated tab (the >5MB preview slice) always answers "changed" and
	 * needs no better answer: `ensureFullContent` gates every path that can
	 * write, so a tab we have never written has no write of ours to recognise.
	 */
	async function fileDiffersFromBaseline(tab: Tab, path: string): Promise<boolean> {
		if (!path || tab.isTruncated) return true;
		try {
			// The same read the reload does, so the two strings are comparable:
			// decoded with the file's own encoding rather than assumed UTF-8.
			const [content] = (await invoke('read_file_content_checked', { path })) as [string, boolean, string];
			return content !== tab.originalContent;
		} catch {
			// Unreadable right now — mid-write, or gone. "Changed" is the safe
			// answer: it stops a save and asks, instead of quietly deciding that
			// nothing happened.
			return true;
		}
	}

	/**
	 * "Keep my version" — the next save of this tab may overwrite a file that
	 * has changed underneath it.
	 *
	 * One save, not a mode: the answer was given about the change the user was
	 * shown, and a third program writing a minute later is a new question.
	 */
	function allowOverwriteOnce(tabId: string) {
		overwriteAllowed.add(tabId);
	}

	/**
	 * Decide what a `file-changed` event should do. The event names the file
	 * that changed, so the tab that OWNS that path is the one affected —
	 * reloading "the active tab" would pull one document's disk content over
	 * a different document's buffer.
	 *
	 * A tab with unsaved edits is never reloaded: `setTabRawContent` replaces
	 * `originalContent` too, so the overwrite would also erase the evidence
	 * that anything was lost. The caller offers the user the choice instead.
	 */
	async function resolveExternalChange(changedPath: string): Promise<ExternalChangeOutcome> {
		if (!changedPath) return { action: 'ignore' };

		const active = tabManager.activeTab;
		const owner =
			active && active.path === changedPath
				? active
				: tabManager.tabs.find((tab) => tab.path === changedPath);
		// Ahead of the read, so an event for a file no tab holds costs no I/O.
		if (!owner) return { action: 'ignore' };

		if (!(await fileDiffersFromBaseline(owner, changedPath))) return { action: 'ignore' };

		if (owner.isDirty) return { action: 'conflict', tabId: owner.id, path: changedPath };

		// `loadMarkdown` always writes into the active tab, so a background
		// owner cannot be refreshed through it. The watcher only ever follows
		// the active file, so this is a guard against a stale in-flight event,
		// not a dropped update.
		if (owner.id !== tabManager.activeTabId) return { action: 'ignore' };

		return { action: 'reload', tabId: owner.id, path: changedPath };
	}

	/**
	 * Replace a partial buffer (the >5MB preview read) with the whole file.
	 * Must be awaited by every path that can lead to a write — entering the
	 * editor or split view, editing front matter, toggling a task checkbox,
	 * moving the tab to another window — because writing the partial buffer
	 * back permanently truncates the document.
	 *
	 * Returns false when the buffer is still partial afterwards. A partial
	 * buffer that already carries edits is left alone: replacing it would
	 * trade the file's tail for the user's typing, so the caller has to stop
	 * instead. Every editing entry point calls this first, which is what makes
	 * that state unreachable in practice.
	 */
	async function ensureFullContent(tabId: string): Promise<boolean> {
		const tab = tabManager.tabs.find((item) => item.id === tabId);
		if (!tab) return false;
		if (!tab.isTruncated) return true;
		if (!tab.path) return true;
		if (tab.isDirty) return false;
		try {
			// Checked, like every other read that ends in a writable buffer.
			// The bare command was safe here only because this re-reads a file
			// whose tab `loadMarkdown` had already flagged — an invariant held
			// by two call sites agreeing, not by anything in the code. Reading
			// the fidelity again costs nothing and makes the flag a property of
			// the buffer instead of a memory of how it was obtained; it also
			// CLEARS the flag for a file converted to UTF-8 since the load.
			const [full, lossy, encoding] = (await invoke('read_file_content_checked', { path: tab.path })) as [string, boolean, string];
			tabManager.setTabDecodedLossy(tabId, lossy);
			// The preview's answer came from the first 5MB; this one is the
			// whole file's, and it is the one every save from here on uses.
			tabManager.setTabEncoding(tabId, encoding);
			tabManager.setTabRawContent(tabId, full);
			return true;
		} catch (error) {
			options.onError('Error loading the rest of the file', error);
			return false;
		}
	}

	// Tabs already told about a refused save. Auto-save re-arms on every
	// edit, so an undeduplicated toast would fire every 1.5s while typing.
	const lossySaveWarnedTabs = new Set<string>();

	/**
	 * Refuse to write a buffer back over the file it was decoded from when
	 * that decode was lossy: no encoding could read the file, the bytes
	 * nothing could read are already U+FFFD in the buffer, and the original is
	 * unrecoverable from it. Every writer — Ctrl+S, the auto-save timer in
	 * MarkdownViewer.svelte, the close dialogs in canCloseTab, the task
	 * checkbox — funnels through saveContent/saveContentAs, so this is the
	 * one place that has to hold.
	 *
	 * Only the SOURCE file is protected. Save As to any other path writes a
	 * genuine UTF-8 file, which is correct and is the user's way out; an
	 * untitled buffer (path === '') has no source file to destroy.
	 *
	 * Detection (#372) narrowed this a great deal without replacing it: GBK,
	 * Big5, Shift-JIS and the rest are now read properly and written back as
	 * themselves, so the everyday legacy document never reaches here. What is
	 * left is the file nothing can read, and no decoder makes that go away.
	 *
	 * "The same file" is the filesystem's judgement, not the string's: a Save As
	 * typed as `/notes/Legacy.md` for a tab opened as `/notes/legacy.md` is the
	 * source file on macOS and Windows, and letting it through is the exact
	 * destruction this guard exists to stop. The caller resolves the target once
	 * — it has just come out of a dialog — and passes its identity here.
	 * `targetPath !== tab.path` stays as the cheap first test so the common
	 * Ctrl+S case never consults anything further.
	 */
	/**
	 * The prefix `encode_text` refuses with when the document's encoding has no
	 * representation for something the buffer now holds — an emoji pasted into
	 * a GBK file being the way most people will meet it.
	 */
	const UNMAPPABLE_CODE = 'ENCODING_UNMAPPABLE';

	/**
	 * A save failure, said in a way the user can act on, and what to show
	 * beside it.
	 *
	 * The translation that matters here is not English-to-Chinese. It is
	 * `ENCODING_UNMAPPABLE` — a fact about the program — turned into "this
	 * document is GBK, GBK cannot hold that character, write a UTF-8 copy
	 * instead": a fact about what the user should do next. That the result then
	 * exists in six languages is the cheap half, and it rides on machinery the
	 * app already has.
	 *
	 * Which is also the rule for what belongs here. A failure the user can act
	 * on gets a code and a sentence this side writes. A failure they cannot —
	 * the 91 places that hand back an OS error — keeps the OS's own words,
	 * because those words are the whole of the information and the only string
	 * worth searching for. "Permission denied (os error 13)", translated, is a
	 * sentence nobody can look up.
	 *
	 * `onError` renders `${message}: ${detail}`, so `detail` is in front of the
	 * user too: the document's path for a refusal we explained, the raw error
	 * for one we did not. Returning the marker here printed it to the user,
	 * which is the failure this shape exists to prevent.
	 */
	function describeSaveFailure(error: unknown, tab: Tab): { message: string; detail: unknown } {
		if (!String(error).includes(UNMAPPABLE_CODE)) {
			return { message: 'Failed to save file', detail: error };
		}

		// `tab.encoding` is what was handed to the command that just refused,
		// so it is the encoding that could not hold the character. Rust used to
		// send the label back and this read it off the error; the round trip
		// was telling us something we had said ourselves a moment earlier.
		return {
			message: t('toast.encodingUnmappable', settings.language).replace('{{encoding}}', tab.encoding),
			detail: tab.path,
		};
	}

	function refuseIfLossilyDecoded(tab: Tab, targetPath: string, targetKey?: string): boolean {
		if (!tab.hasReplacementChars || targetPath === '') return false;
		if (targetPath !== tab.path && !isSameFilePath({ path: targetPath, pathKey: targetKey }, tab)) return false;
		console.warn('Refusing to overwrite a file that was decoded lossily', tab.path);
		if (!lossySaveWarnedTabs.has(tab.id)) {
			lossySaveWarnedTabs.add(tab.id);
			options.onError(t('toast.lossySaveBlocked', settings.language), tab.path);
		}
		return true;
	}

	/**
	 * True when this tab's saves are being refused for the lossy-decode reason
	 * RIGHT NOW, and it has already been told so in words.
	 *
	 * The explanation is deduplicated per tab above, but the callers' own
	 * failure reporting was not: `saveContent` returns `false` for a refusal
	 * exactly as it does for a failed write, so the auto-save timer added its
	 * generic "auto-save failed" on top — and, because auto-save re-arms on
	 * every keystroke, repeated it every 1.5s for as long as the user kept
	 * typing. A refusal is not a failure to report again; it is a standing
	 * condition the user has already been told about and given an exit from.
	 *
	 * Both halves are needed, and the second is why set membership alone was
	 * not enough. `lossySaveWarnedTabs` records what was SAID; whether the
	 * refusal still stands is a property of the tab, decided fresh by every
	 * read that fills the buffer — `ensureFullContent`, entering the editor,
	 * entering split view, a cross-window arrival. Any of those clears
	 * `hasReplacementChars` for a file converted to UTF-8 since the load, and
	 * none of them goes through `loadMarkdown`, the only place that empties the
	 * set. A tab that had once been refused therefore went on suppressing the
	 * generic message for the rest of its life, including for a genuine write
	 * failure — a full disk, a revoked permission, a network volume that went
	 * away — which is the opposite of "already explained".
	 *
	 * Asking the tab also answers for one that is gone: `closeTab` splices with
	 * no dispose hook, so the set keeps closed ids, and a tab nobody can find
	 * is refusing nothing.
	 */
	function isLossySaveRefused(tabId: string): boolean {
		if (!lossySaveWarnedTabs.has(tabId)) return false;
		const tab = tabManager.tabs.find((item) => item.id === tabId);
		return tab?.hasReplacementChars === true;
	}

	function updateLoading(tabId: string, loading: boolean) {
		if (loading) loadingTabs.add(tabId);
		else loadingTabs.delete(tabId);
		options.setLoadingTabs([...loadingTabs]);
	}

	async function loadMarkdown(filePath: string, loadOptions: LoadMarkdownOptions = {}) {
		options.setShowHome(false);
		let existing = null;
		let pendingNavigateTabId: string | null = null;
		try {
			if (loadOptions.resetScrollHistory || filePath !== options.currentFile()) {
				options.resetScrollHistory();
			}
			// Ask the filesystem what file this path names, ONCE, before any of
			// the decisions below. Every one of them is really a "same file?"
			// question — is it already open, does it belong to the tab holding
			// unsaved edits — and on macOS and Windows the string cannot answer
			// it: `/notes/A.md` and `/notes/a.md` are one file, and so are the
			// NFC and NFD spellings of an accented name.
			//
			// This is the only I/O added to the open path, and it is why the
			// comparisons themselves can stay synchronous: the answer is put on
			// the tab and reused. On failure `canonicalizePath` returns the path
			// unchanged, so an unreachable volume degrades to today's behaviour
			// rather than blocking the open.
			const pathKey = await canonicalizePath(filePath);
			const target = { path: filePath, pathKey };

			if (loadOptions.navigate && tabManager.activeTab) {
				pendingNavigateTabId = tabManager.activeTab.id;
			} else if (!loadOptions.skipTabManagement) {
				existing = tabManager.tabs.find((tab) => isSameFilePath(tab, target));
				if (existing) tabManager.setActive(existing.id);
				else if (tabManager.activeTab && tabManager.activeTab.path === '' && !tabManager.activeTab.isDirty && tabManager.activeTab.rawContent.trim() === '') {
					tabManager.updateTabPath(tabManager.activeTab.id, filePath, pathKey);
				} else tabManager.addTab(filePath, '', pathKey);
			}
			const activeId = tabManager.activeTabId;
			if (!activeId) return;
			// Callers that manage tabs themselves — back/forward, a link opened
			// in a new tab — put the path on the tab before getting here, so
			// this is where those tabs learn their identity. Cheap and idempotent
			// for the tabs that already have it.
			tabManager.setTabPathKey(activeId, filePath, pathKey);

			// Opening a file that is already open, in a tab that has unsaved
			// edits, must not re-read it: the load below replaces rawContent AND
			// originalContent, so the edits would be gone and the tab would not
			// even look dirty afterwards — the same silent loss
			// `resolveExternalChange` refuses for a watcher event, reached
			// through the ordinary open path instead.
			//
			// The whole request is answered by activating that tab, which every
			// mainstream editor does: VS Code reveals the existing editor over
			// its dirty `ITextModel`, Sublime Text focuses the view that already
			// holds the buffer, and Vim's `:e` refuses outright without `!`.
			// Discarding a buffer is a separate, explicit command everywhere —
			// here, "Reload from disk" and the external-change "Reload", and both
			// declare it by passing `discardUnsavedBuffer`. Authorization is
			// something a caller states, never something this function infers
			// from surrounding state.
			//
			// Note the tab is found by `activeTabId`: whether the caller reached
			// it by `setActive` on an already-open file, by `addTab` resolving to
			// it, or by never having left it, the buffer at risk is the same one.
			//
			// The match is by file, not by string: reopening `/notes/A.md` while
			// `/notes/a.md` sits here with unsaved edits is reopening THIS file,
			// and comparing the spellings would miss it and overwrite the buffer.
			const receiving = tabManager.tabs.find((item) => item.id === activeId);
			if (receiving && receiving.isDirty && isSameFilePath(receiving, target) && !loadOptions.discardUnsavedBuffer) {
				if (filePath) options.saveRecentFile(filePath);
				await options.afterLoad();
				return;
			}

			const fullLoadRevision = (loadRevisionByTab.get(activeId) ?? 0) + 1;
			loadRevisionByTab.set(activeId, fullLoadRevision);
			// #547: every read below is an await, and this load may be overtaken
			// while one is in flight — the startup path is delivered on two
			// channels that nothing dedupes (`RunEvent::Opened` both stashes the
			// path for `send_markdown_path` and emits `file-path`; argv is read by
			// both as well), so two loads can run on one tab. The full-load stage
			// already refuses to apply a stale result; the first stage did not, and
			// an older preview landing last overwrote the winner's complete buffer
			// with its 5MB slice, re-raising `isTruncated` — after which every save
			// is refused and nothing retries. Same revision test, applied to every
			// write a load makes.
			const isCurrentLoad = () => loadRevisionByTab.get(activeId) === fullLoadRevision;
			const isMarkdown = hasMarkdownLinkExtension(filePath);
			const tab = tabManager.tabs.find((item) => item.id === activeId);

			if (isMarkdown) {
				if (tab && !loadOptions.preserveEditState && !existing) {
					// #183: the reporter turns split view on for every file he
					// opens, so what a picked file opens as is one preference with
					// three answers (`openFileMode.ts`).
					//
					// Split goes through `setSplitEnabled` rather than assigning
					// the flag, so the tab carries the scroll-sync preference the
					// toggle would have given it — a fresh tab is created
					// `isScrollSynced: false` and would otherwise silently drop it.
					//
					// And both are applied BEFORE `initialIsSplit` is read, so a
					// document opening into either editable mode takes the
					// full-read branch below: those panes can write, and an editor
					// bound to the 5MB preview slice is one keystroke away from
					// auto-saving it back over the whole file.
					tab.isEditing = settings.openFileMode === 'editor';
					if (settings.openFileMode === 'split') tabManager.setSplitEnabled(tab.id, true);
				}
				const initialIsEditing = tab?.isEditing ?? false;
				const initialIsSplit = tab?.isSplit ?? false;
				// `open_markdown_preview` returns only the first 5MB of a large
				// file, which is fine behind a read-only preview because the
				// background read below completes it. An editor bound to that
				// partial buffer is one keystroke away from auto-saving it back
				// over the whole document, so a pane that can write always gets
				// the complete file up front — this is the path F5 and "reload
				// from disk" take while edit or split mode is preserved.
				let content: string;
				let isFull: boolean;
				let lossy: boolean;
				let encoding: string;
				if (initialIsEditing || initialIsSplit) {
					[content, lossy, encoding] = (await invoke('read_file_content_checked', { path: filePath })) as [string, boolean, string];
					isFull = true;
				} else {
					[, content, isFull, lossy, encoding] = (await invoke('open_markdown_preview', { path: filePath, maxBytes: 5_000_000 })) as [string, string, boolean, boolean, string];
				}
				// Ahead of the encoding verdict, not just the buffer: a prefix's
				// detected encoding can differ from the whole file's, and
				// `tab.encoding` is what the save writes with.
				if (!isCurrentLoad()) return;
				// Decided on every load, before the buffer can reach a writer.
				// Both branches report both, so this also CLEARS the flag on a
				// file the user has since converted to UTF-8 — and repoints the
				// save at the encoding it converted to.
				tabManager.setTabDecodedLossy(activeId, lossy);
				tabManager.setTabEncoding(activeId, encoding);
				lossySaveWarnedTabs.delete(activeId);
				if (pendingNavigateTabId) tabManager.navigate(pendingNavigateTabId, filePath, pathKey);
				const processed = await options.renderMarkdown(content, filePath, foldsForTab(activeId));
				if (!isCurrentLoad()) return;
				tabManager.updateTabContent(activeId, processed);
				// `isFull === false` means this is only the leading slice of a
				// large file. Marking the tab keeps anything downstream from
				// mistaking it for the whole document and writing it back.
				tabManager.setTabRawContent(activeId, content, !isFull);

				if (!isFull) {
					const canApplyFullLoad = () => {
						const targetTab = tabManager.tabs.find((item) => item.id === activeId);
						return targetTab?.path === filePath && loadRevisionByTab.get(activeId) === fullLoadRevision && !targetTab.isDirty && targetTab.isEditing === initialIsEditing && targetTab.isSplit === initialIsSplit;
					};
					updateLoading(activeId, true);
					options.measureInitialViewport();
					(invoke('read_file_content_checked', { path: filePath }) as Promise<[string, boolean, string]>)
						.then(([fullContent, fullLossy, fullEncoding]) => {
							const applyFull = () => {
								try {
									if (options.isScrolling()) return void setTimeout(applyFull, 100);
									if (!canApplyFullLoad()) return updateLoading(activeId, false);
									options.renderMarkdown(fullContent, filePath, foldsForTab(activeId))
										.then((fullProcessed) => {
											if (!canApplyFullLoad()) return updateLoading(activeId, false);
											tabManager.updateTabContent(activeId, fullProcessed);
											tabManager.setTabRawContent(activeId, fullContent);
											// This buffer REPLACES the preview's, so it
											// carries its own verdict — the preview only
											// saw the first 5MB, and both the fidelity
											// and the detected encoding of a prefix can
											// differ from the whole file's.
											tabManager.setTabDecodedLossy(activeId, fullLossy);
											tabManager.setTabEncoding(activeId, fullEncoding);
											updateLoading(activeId, false);
											if (tabManager.activeTabId === activeId) setTimeout(options.renderRichContent, 10);
										})
										.catch((error) => {
											options.onError('Error processing full markdown', error);
											updateLoading(activeId, false);
										});
								} catch (error) {
									options.onError('Error processing full markdown', error);
									updateLoading(activeId, false);
								}
							};
							if ('requestIdleCallback' in window) (window as any).requestIdleCallback(applyFull, { timeout: 2000 });
							else setTimeout(applyFull, 100);
						})
						.catch((error) => {
							options.onError('Backend Error loading full markdown', error);
							updateLoading(activeId, false);
						});
				}
			} else {
				const [content, lossy, encoding] = (await invoke('read_file_content_checked', { path: filePath })) as [string, boolean, string];
				// Same race, same guard: this branch reads the whole file, so it
				// cannot strand a slice, but a stale one still overwrites the
				// winner's buffer and encoding and flips the tab into the editor.
				if (!isCurrentLoad()) return;
				tabManager.setTabDecodedLossy(activeId, lossy);
				tabManager.setTabEncoding(activeId, encoding);
				lossySaveWarnedTabs.delete(activeId);
				if (pendingNavigateTabId) tabManager.navigate(pendingNavigateTabId, filePath, pathKey);
				if (tab) tab.isEditing = true;
				tabManager.setTabRawContent(activeId, content);
			}
			await options.afterLoad();
			if (filePath) options.saveRecentFile(filePath);
		} catch (error) {
			console.error('Error loading file:', error);
			// A watcher can observe a transient gap while another process replaces
			// the file. Keep the already-open buffer and recent-file entry instead
			// of closing the tab and discarding the user's recovery path.
			options.onError('Error loading file', error);
		}
	}

	async function saveContent(tabId?: string): Promise<boolean> {
		const tab = tabId ? tabManager.tabs.find((item) => item.id === tabId) : tabManager.activeTab;
		if (!tab) return false;
		// Backstop, not the main defence: every path that lets the user change
		// a large file completes its buffer first. If one is ever missed, the
		// write must fail loudly rather than silently truncate the document.
		if (tab.isTruncated) {
			options.onError(t('toast.partialSaveBlocked', settings.language), tab.path);
			return false;
		}
		let targetPath = tab.path;
		// The tab's own path is already resolved, so the ordinary save — Ctrl+S,
		// and the auto-save timer every 1.5s — adds no I/O here. Only the dialog
		// branch below produces a path nobody has resolved yet.
		let targetKey = tab.pathKey;
		if (!targetPath) {
			const selected = await save({
				filters: [
					{ name: 'Markdown', extensions: ['md'] },
					{ name: 'All Files', extensions: ['*'] },
				],
				defaultPath: tab.title,
			});
			if (!selected) return false;
			targetPath = selected;
			targetKey = await canonicalizePath(selected);
		}
		// The pending debounce exists to write a tab that nobody is writing.
		// This call is that writer, so the timer has nothing left to do — and
		// leaving it armed is not merely redundant: it can fire *during* the
		// await below and put a second write on the same file, racing this one
		// to the rename. The loser publishes the older snapshot while the tab
		// records the newer one as saved, so the buffer reads clean while the
		// disk holds the earlier text.
		//
		// It belongs here rather than at the call sites: two of the five
		// explicit saves remembered to cancel and three did not, and a sixth
		// entry point would have had to remember too. Placed after the Save
		// dialog above, so it never runs before a modal the user can still
		// cancel — an untitled tab has no timer to cancel anyway, since the
		// auto-save effect only arms tabs that already have a path.
		options.cancelPendingAutoSave(tab.id);
		if (refuseIfLossilyDecoded(tab, targetPath, targetKey)) return false;
		return writeExclusively(tab.id, async () => {
			// Snapshot taken on the far side of the wait. Anything typed while
			// the previous write drained is part of what this save is for.
			const snapshot = tab.rawContent;
			// The second line of defence, and the only one that does not rest on
			// the watcher. Live Mode is off by default, its events can be
			// dropped, and until recently a watch armed on a file did not
			// survive that file being renamed over — which is how `atomic_write`
			// and most other editors save. None of that reaches this check,
			// because it asks the file itself at the moment of writing.
			//
			// Every editor with a claim to not losing work has one. VS Code
			// refuses the save ("The content of the file is newer"), Vim
			// re-stats before each write ("WARNING: The file has been changed
			// since reading it!!!"), Emacs raises `file-supersession` as soon as
			// you type into a superseded buffer. Vim has no watcher at all and
			// is still safe, which is the argument for the check living here and
			// not only on the event.
			//
			// A refusal, not a merge and not a retry: the user is shown the bar
			// and answers it. "Keep mine" authorises exactly the next save,
			// which is what `overwriteAllowed` carries.
			//
			// The gap between this read and the rename is real, and is the same
			// gap Vim and VS Code have. It narrows the exposure from "the whole
			// time the document is open" to "the length of one write".
			if (!overwriteAllowed.delete(tab.id) && (await fileDiffersFromBaseline(tab, targetPath))) {
				options.onDiskChangedUnderSave(tab.id);
				return false;
			}
			try {
				// The tab's own encoding, so a GBK or Shift-JIS document is
				// written back as the file it was opened from rather than
				// silently converted to UTF-8 by every auto-save. An untitled
				// buffer saved through the dialog above still carries the
				// `UTF-8` it was created with, which is what it should be.
				await invoke('save_file_content', { path: targetPath, content: snapshot, encoding: tab.encoding });
				if (tab.path === '') {
					tabManager.updateTabPath(tab.id, targetPath, targetKey);
					options.saveRecentFile(targetPath);
				}
				// The baseline is the text that reached the file, not the buffer:
				// anything typed while the write was in flight is still unsaved,
				// and `isDirty` reads that off these two by itself.
				tab.originalContent = snapshot;
				return true;
			} catch (error) {
				const { message, detail } = describeSaveFailure(error, tab);
				options.onError(message, detail);
				return false;
			}
		});
	}

	async function saveContentAs(): Promise<boolean> {
		const tab = tabManager.activeTab;
		if (!tab) return false;
		// A copy is a NEW file at a path the user chose, so unlike the ordinary
		// save it cannot destroy anything they already have. That is what makes
		// it the one write a partial buffer may make — and refusing it too, as
		// this did, left a buffer that could go nowhere: not over the original,
		// correctly, and not beside it either, so edits made in that state had
		// no exit but the clipboard. The lossy-decode guard reasons the same way
		// and has always pointed at Save As for the same reason.
		//
		// Completed first where that is possible, so the copy is whole whenever
		// it can be. `ensureFullContent` declines on a dirty buffer — reading the
		// file over unsaved edits would discard the very thing this rescue is
		// for — and that is exactly the case where the copy really is short, so
		// the user is told once it is written.
		if (tab.isTruncated) await ensureFullContent(tab.id);
		const copyIsPartial = tab.isTruncated === true;
		const selected = await save({
			filters: [
				{ name: 'Markdown', extensions: ['md'] },
				{ name: 'All Files', extensions: ['*'] },
			],
			defaultPath: tab.path || undefined,
		});
		if (!selected) return false;
		// Picking the source file again in the dialog is the same destructive
		// overwrite, just reached another way — and "again" includes naming it
		// in a different case, or with the accents composed differently, both of
		// which land on the very same file.
		const selectedKey = await canonicalizePath(selected);
		if (refuseIfLossilyDecoded(tab, selected, selectedKey)) return false;
		// Shares the tab's guard with `saveContent`. The target is usually a
		// different file, so the renames need not collide — but both
		// continuations write the same tab's `originalContent`, `isDirty` and
		// path, and picking the tab's own file in the dialog is an allowed
		// overwrite that collides outright.
		return writeExclusively(tab.id, async () => {
			const snapshot = tab.rawContent;
			try {
				// Deliberately UTF-8, not `tab.encoding`. Save As is the way out
				// of both failure modes this file guards: a buffer nothing could
				// decode, and one holding a character its own encoding cannot
				// represent. Writing the copy in the encoding that caused the
				// problem would take the exit away.
				await invoke('save_file_content', { path: selected, content: snapshot, encoding: 'UTF-8' });
				tabManager.updateTabPath(tab.id, selected, selectedKey);
				// The buffer now has a UTF-8 file of its own that it matches
				// exactly, so it is safe to save from here on — and every save
				// from here on has to agree about what that file is.
				tabManager.setTabDecodedLossy(tab.id, false);
				tabManager.setTabEncoding(tab.id, 'UTF-8');
				lossySaveWarnedTabs.delete(tab.id);
				// And the same for the truncation flag, for the same reason: it
				// described the file this tab used to point at. Whatever the buffer
				// was a slice OF, it is the whole of what was just written, and the
				// tab now points at that. Leaving it on would refuse every save from
				// a tab holding a complete document — the rescue would free the text
				// and then trap it again. Assigned rather than going through
				// `setTabRawContent`, which would also reset the baseline the two
				// lines below set on purpose.
				tab.isTruncated = false;
				options.saveRecentFile(selected);
				// Same as the ordinary save: the baseline is what was written,
				// and edits made during the write stay dirty against it.
				tab.originalContent = snapshot;
				// Said after the write rather than before the dialog: nothing is lost
				// by proceeding, and a reader who came here to rescue unsaved text
				// still has to know that what landed on disk stops where the load did.
				if (copyIsPartial) options.onPartialCopySaved();
				return true;
			} catch (error) {
				const { message, detail } = describeSaveFailure(error, tab);
				options.onError(message === 'Failed to save file' ? 'Failed to save file as' : message, detail);
				return false;
			}
		});
	}

	async function toggleTaskCheckbox(sourceLine: number, nowChecked: boolean) {
		const tab = tabManager.activeTab;
		if (!tab || !tab.path) return false;
		// Reading mode can reach a large file before its full buffer arrives.
		// Editing and saving the preview slice would drop everything past it.
		if (!(await ensureFullContent(tab.id))) return false;
		const raw = tab.rawContent;
		const body = getMarkdownBodyWithoutFrontMatter(raw);
		// The marker grammar comes from `listSyntax.ts`, shared with the editor
		// toolbar's line-marker toggles; what surrounds it does not. Here the
		// prefix is *captured* and written back out, because this rewrite replaces
		// the box in the middle of the line rather than the head of it.
		//
		// Horizontal whitespace only, and it has to stay that way. `\s` matches
		// `\r` as well as `\n`, and JavaScript's `/m` `^` also matches at the
		// position *between* a `\r` and its `\n`. With `\s*` greedy, every match
		// in a CRLF buffer began one character early — on the previous line's
		// `\n` — so `body.slice(0, offset)` held one `\n` too few and every task
		// resolved to line N-1. On the last task that is a no-op the user reads
		// as "the checkbox does not work" (#148); anywhere else the off-by-one
		// lands on a *real* task line and silently toggles the wrong one. Every
		// CRLF document was affected, which is to say every Windows author.
		const updatedBody = body.replace(
			new RegExp(String.raw`^(${LIST_MARKER_PREFIX}${LIST_MARKER}[ \t]+)${TASK_BOX}`, 'gm'),
			(match, prefix, offset) => {
				const line = body.slice(0, offset).split('\n').length;
				if (line === sourceLine) return `${prefix}[${nowChecked ? 'x' : ' '}]`;
				return match;
			},
		);
		const updated = `${raw.slice(0, raw.length - body.length)}${updatedBody}`;
		if (updated === raw) return false;
		tabManager.updateTabRawContent(tab.id, updated);
		// The preview is already showing this content: the browser has drawn
		// the native checkbox, and the caller adds `task-done` to the item. A
		// re-render would rebuild the whole article to arrive at the DOM that
		// is on screen, and rebuilding it drops the reader's scroll position —
		// ticking something in a long document threw the view somewhere else
		// entirely, which is worse than the missing render would be.
		//
		// In the same synchronous block as the write, deliberately. The render
		// effect reads `previewedRawContent` and, if it does not match, arms a
		// 16ms timer BEFORE anything can be awaited — so marking this after an
		// `await` would be too late to stop the render it schedules. This is
		// the one place outside the viewer that may claim the preview is
		// current, because it is the one place that knows the DOM was updated
		// by hand.
		tab.previewedRawContent = updated;
		await saveContent(tab.id);
		return true;
	}

	async function canCloseTab(tabId: string): Promise<boolean> {
		const tab = tabManager.tabs.find((item) => item.id === tabId);
		if (!tab || (!tab.isDirty && tab.path !== '')) return true;
		if (!tab.isDirty) return true;
		if (settings.autoSave && tab.path !== '') {
			const success = await saveContent(tabId);
			if (success && !tab.isDirty) return true;
			if (success) options.onCloseSaveNewerEdits();
			else options.onCloseAutoSaveFailed();
		}
		const response = await options.askClose(tab.title);
		if (response === 'cancel') return false;
		if (response === 'save') {
			return saveContent(tabId);
		}
		// Kept, but not because the timer would otherwise fire: the two lines
		// below are synchronous, so nothing can run between them, and the
		// auto-save effect drops the timer on its own once `isDirty` is false.
		// That route rests on the effect flushing ahead of a pending macrotask
		// and on the effect running at all — neither is obvious while a window
		// is tearing down on the quit path. A synchronous cancel rests on
		// neither, and unlike the branches above there is no `saveContent` here
		// to do it on this path's behalf.
		options.cancelPendingAutoSave(tabId);
		tab.rawContent = tab.originalContent;
		return true;
	}

	return { loadMarkdown, saveContent, saveContentAs, toggleTaskCheckbox, allowOverwriteOnce, resolveExternalChange, ensureFullContent, canCloseTab, isLossySaveRefused };
}
