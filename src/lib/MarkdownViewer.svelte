<script lang="ts">
	import { invoke, convertFileSrc } from '@tauri-apps/api/core';
	import { emitTo, type EventCallback } from '@tauri-apps/api/event';
	import { getAllWindows, getCurrentWindow } from '@tauri-apps/api/window';
	import { onMount, tick, untrack } from 'svelte';
	import { fade, fly, slide } from 'svelte/transition';
	import { cubicOut } from 'svelte/easing';
	import { openPath, openUrl } from '@tauri-apps/plugin-opener';
	import { open, save, ask } from '@tauri-apps/plugin-dialog';
	import Settings from './components/Settings.svelte';
	import TitleBar from './components/TitleBar.svelte';
	import Sidebar from './components/Sidebar.svelte';
	import { folderManager, snapshotFolder, type FolderEntry } from './stores/folder.svelte.js';
	import DiffOverlay from './components/DiffOverlay.svelte';
	import Editor from './components/Editor.svelte';
	import EditorToolbar from './components/EditorToolbar.svelte';
	import Modal from './components/Modal.svelte';
	import UpdateDialog from './components/UpdateDialog.svelte';
	import { updateStore } from './stores/update.svelte.js';
	import ContextMenu, { type ContextMenuItem } from './components/ContextMenu.svelte';
	import Toc from './components/Toc.svelte';
	import Toast from './components/Toast.svelte';
	import FindBar from './components/FindBar.svelte';
	import { createWindowExit } from './sessions/windowExit.js';
	import { createExternalChange } from './sessions/externalChange.svelte.js';
	import { createViewMode } from './sessions/viewMode.svelte.js';
import { createFrontMatterEdit } from './sessions/frontMatterEdit.js';
import { createColdEnrichmentRestore } from './sessions/coldEnrichmentRestore.js';
	import { autoSaveFailureNeedsToast, isAutoSaveEligible } from './utils/autoSaveTimer.js';
	import { exportAsHtml as _exportHtml, exportAsPdf as _exportPdf } from './utils/export';
	import { askToOpenExportedFile } from './utils/openExportedFile.js';
	import { showsHomeScreen } from './utils/homeTab.js';
	import { handleCopy as handlePreviewCopy } from './utils/previewCopy.js';
	import { hasExportableDocument } from './utils/tabFileActions.js';
	import { editorLanguageFor } from './utils/editorLanguage.js';
	import { editorReadOnly } from './utils/editorOptions.js';
	import { viewModeOf } from './utils/titlebarToolbar.js';
	import { buildMenuModel, installAppMenu, type MenuAction } from './utils/appMenu.js';
	import ZoomOverlay from './components/ZoomOverlay.svelte';
import { MARKDOWN_OPEN_FILTERS } from './utils/markdownLinks.js';
import {
	resolveMermaidTheme,
} from './utils/mermaidPrint.js';
import {
	flashCopiedLabel,
	renderRichContent as renderRichContentInto,
} from './utils/richContent.js';
import { type FoldLayoutObservation } from './utils/foldLayout.js';
import { followFoldLayout, previewPaneShown } from './utils/foldLayoutEffect.svelte.js';
import { followPreviewPatch } from './utils/previewPatchEffect.svelte.js';
import { patchHost } from './utils/previewPatch.js';
import { refreshesPreviewCache } from './utils/previewRefresh.js';
import {
	revealFold,
	toggleFold,
	toggleFoldFromClick,
	type FoldHost,
} from './utils/foldState.js';
import { dropPaneFor, dropZoneLabel, handleDrop } from './utils/fileDrop.js';
import { headingSlug, headingText, referenceForTab } from './utils/headingReference.js';
import {
	measureAnchorBox,
	restorePreviewReadingPosition,
	anchorScrollTop,
	type AnchorBox,
	type AnchorNode,
	type OffsetLayoutNode,
} from './utils/previewAnchor.js';
import { pointAtSource, sourceAtPoint, type SourceLineReader } from './utils/previewCursor.js';
import { annotationOf, hitAt, occurrenceRanges, overlapping, rangeOf, type Annotation } from './utils/previewAnnotations.js';
import {
	asRendererLine,
	lineCoordinates,
	type BufferLine,
	type RendererLine,
} from './utils/lineCoordinates.js';
import {
	addFrontMatterListItems,
	getMarkdownBodyWithoutFrontMatter,
	getFrontMatterListItems,
	parseFrontMatter,
	removeFrontMatterListItem,
	updateFrontMatterListItem,
	updateFrontMatterField,
	type FrontMatterField,
} from './utils/frontMatter.js';
import { FrontMatterFieldState } from './utils/frontMatterFieldState.svelte.js';
import {
	anchorIdCandidates,
	getMarkdownLinkTarget as getRelativeMarkdownTarget,
	hasMarkdownLinkExtension,
	resolveMarkdownTargetPath,
	type MarkdownLinkTarget as RelativeMarkdownTarget,
} from './utils/markdownLinks.js';
import { followDocumentLink, handlePreviewClick, linkTooltipFor, openRelativeMarkdownTarget as openRelativeTarget, openWithSystem as openPathWithSystem } from './utils/previewLinks.js';
import { canonicalizePath } from './utils/pathIdentity.js';
import { ChoiceDialog } from './utils/choiceDialog.svelte.js';
import { contextMenuFor, editorContextMenuItems, imageMenuItems, saveImageAs as saveImageAsFile } from './utils/viewerContextMenu.js';
import { seedFindBar } from './utils/findSeed.js';
import { createRecentFiles } from './utils/recentFiles.js';

	const appWindow = getCurrentWindow();

	import HomePage from './components/HomePage.svelte';
	import { openNewWindow, pinnedTagFromWindowLabel } from './utils/pinnedTagWindow.js';
import { tabManager, type Tab } from './stores/tabs.svelte.js';
import { createTabMovers, createTransferOptions } from './sessions/windowTransfer.js';
import { createPaneSlider, planPaneSlide, type PanesShown } from './utils/paneSlide.js';
import { viewerCommandTable } from './utils/viewerCommands.js';
import { dismissesToc, tocAutoCollapses } from './utils/tocOverlay.js';
import { exportContextFrom, previewAppearanceFrom, previewLayout } from './utils/previewLayout.js';
import { splitRatioAfterDrag, splitRatioAfterKey } from './utils/splitPanes.js';
import { dispatchViewerKey, type KeyContext, type ViewerCommand } from './utils/viewerKeymap.js';
import {
	getPreviewScrollAnchor as previewScrollAnchor,
	getPreviewScrollSyncPosition as previewScrollSyncPosition,
	getPreviewScrollTopForSyncPosition,
} from './utils/previewScrollSync.js';
import { type ScrollSyncPosition } from './utils/scrollSync.js';
import { resolveTheme, settings, TOC_WIDTH_RANGE, wheelZoomFactor } from './stores/settings.svelte.js';
import { t } from './utils/i18n.js';
import { formatChord, modifierFor, opensInNewTab } from './utils/shortcuts.js';
import { commitWithoutTransitions, jumpScrollBehavior } from './utils/motion.js';
import { createWindowSession } from './sessions/windowSession.svelte.js';
import { reportWindowMeta } from './sessions/windowMeta.svelte.js';
import { createBoundedWriter, restoreRecords, recoverySnapshot } from './sessions/unsavedRecovery.js';
import { createDocumentSession, type LoadMarkdownOptions } from './sessions/documentSession.svelte.js';
import { followActiveFile } from './sessions/fileWatch.svelte.js';

	import 'highlight.js/styles/github-dark.css';
	import 'katex/dist/katex.min.css';

	let mode = $state<'loading' | 'app'>('loading');
	let isDisposed = false;

	let showSettings = $state(false);

	let recentFiles = $state<string[]>([]);
	const recentFileList = createRecentFiles((files) => (recentFiles = files));
	let isFocused = $state(true);
	
	let markdownBody: HTMLElement | null = $state(null);
	let layoutContainerEl: HTMLElement | null = $state(null);
	/**
	 * One host per tab, holding that tab's rendered document. `previewPatch.ts`
	 * owns their children, not Svelte: an `{@html}` here would rebuild the
	 * article on every keystroke.
	 *
	 * One per tab so a tab switch patches nothing: the host still holds that
	 * document, so no nodes are replaced or re-enriched.
	 *
	 * Only the active host is patched or observed. A hidden host is
	 * `display: none`, so everything in it measures 0, and `updateFoldHeights`
	 * would write that into `--fold-content-height` and collapse its folds. A
	 * background tab catches up when it is next shown.
	 */
	let previewHosts = $state<Record<string, HTMLElement | null>>({});
	// Filled by `exportAsPdf` for the duration of a print and emptied again;
	// `@media print` reveals it and hides everything else under `#app`.
	let printRootEl = $state<HTMLElement | null>(null);

	let previewBlocks = $derived(
		tabManager.activeTabId ? (previewHosts[tabManager.activeTabId] ?? null) : null,
	);
	const foldLayout: { current: FoldLayoutObservation | null } = { current: null };
	
	let editorPane = $state<{ 
		syncScrollToPosition: (position: ScrollSyncPosition, options?: { cursorIntoView?: boolean }) => void;
		setCursor: (line: number, column: number) => void;
		scrollSyncPosition: () => ScrollSyncPosition | null;
		handleDroppedFile: (path: string, x: number, y: number) => Promise<void>;
		updateDragCaret: (x: number, y: number) => void;
		hideDragCaret: () => void;
		runEditorAction: (actionId: string, payload?: any) => void;
		undo: () => void;
		redo: () => void;
		selectAll: () => void;
		revealHeader: (sourceLine: BufferLine | null, text: string) => void;
		revealSourceRange: (startLine: number, endLine: number) => void;
		triggerFind: () => void;
		flushPositionTo: (tabId: string) => void;
		// The three the editor's context menu runs, which are the three its
		// keyboard shortcuts run (#207).
		cutToClipboard: () => Promise<void>;
		copyToClipboard: () => Promise<void>;
		pasteFromClipboard: () => Promise<void>;
	} | null>(null);
	// On by default, as in VS Code: a clean tab follows the file on disk.
	let liveMode = $state(true);

	// One decision, asked by the four jumps below and handed to `FindBar` and
	// `Editor` for theirs. See `utils/motion.ts`.
	const jumpBehavior = $derived(jumpScrollBehavior(settings.animateJumpScroll));

	let findOpen = $state(false);
	let findBar = $state<{
		reapply: () => void;
		clearHighlights: () => void;
		focusInput: () => void;
		setQuery: (value: string) => void;
	} | null>(null);

	// Decide where Cmd/Ctrl+F should land based on what's visible and where
	// focus is. The in-window shortcut remains the canonical route on every
	// platform.
	function triggerFindAction() {
		const active = document.activeElement as Node | null;
		const editorHasFocus = !!editorPaneEl && !!active && editorPaneEl.contains(active);
		const previewVisible = hasPreviewPane;
		if (editorHasFocus || !previewVisible) {
			editorPane?.triggerFind?.();
		} else if (markdownBody) {
			seedFindBar(findBar, window.getSelection(), markdownBody);
			// Focus explicitly: `findOpen = true` is a no-op once open.
			findOpen = true;
			findBar?.focusInput();
		}
	}

	let isDragging = $state(false);
	let dragTarget = $state<'editor' | 'preview' | null>(null);
	let dragPaths = $state<string[]>([]);

	/**
	 * The reference for a heading of THIS document, in the spelling this
	 * document is written in. See `headingReference.ts` — the inference falls
	 * back to what the menu has always produced.
	 */
	function copyHeadingReference(text: string, slug: string) {
		invoke('clipboard_write_text', { text: referenceForTab(text, slug, tabManager.activeTab) });
	}

	function reportUnsupportedDrop(path: string) {
		const filename = path.split(/[/\\]/).pop() || 'File';
		addToast(t('toast.unsupportedFile', settings.language).replace('{{filename}}', filename), 'error');
	}
	let editorPaneEl = $state<HTMLElement>();
	let viewerPaneEl = $state<HTMLElement>();
	let isProgrammaticScroll = false;

	let toasts = $state<{ id: string; message: string; type: 'info' | 'error' | 'warning'; sticky?: boolean }[]>([]);
	function addToast(message: string, type: 'info' | 'error' | 'warning' = 'info', sticky = false): string {
		const id = crypto.randomUUID();
		toasts.push({ id, message, type, sticky });
		return id;
	}
	function removeToast(id: string) {
		toasts = toasts.filter((toast) => toast.id !== id);
	}

	// --- Auto-save bookkeeping (see saveContent + auto-save $effect below) ---
	// Per-tab debounce timers so switching tabs cannot kill another tab's pending save.
	const autoSaveTimers = new Map<string, ReturnType<typeof setTimeout>>();
	// Per-tab last-seen rawContent value, used by the auto-save effect to
	// detect which tab actually changed in this run. JS string `===` is a
	// value compare, so any edit yields a different value — including
	// same-length ones (overwriting characters, formatting toggles) that
	// a length-based tick would miss.
	const lastContentRefByTab = new Map<string, string>();
	const AUTO_SAVE_DEBOUNCE_MS = 1500;

	// Cancel a pending auto-save for a tab. Call this only on paths that
	// COMMIT to a save or discard outcome — never before showing a modal,
	// because if the user picks Cancel, the timer is gone forever and
	// background auto-save is silently disabled for that tab until the
	// next keystroke.
	//
	// The *save* half is no longer a call-site duty: `saveContent` cancels the
	// tab's timer itself, past the point where it can still bail out. Only the
	// discard path still calls this directly, because nothing saves on its
	// behalf. Do not re-add a cancel before a `saveContent` — it is redundant,
	// and reintroduces the question of whether every new entry point remembered.
	function cancelPendingAutoSave(tabId: string) {
		const t = autoSaveTimers.get(tabId);
		if (t) {
			clearTimeout(t);
			autoSaveTimers.delete(tabId);
		}
	}

	let zoomData = $state<{ src?: string; html?: string } | null>(null);

	// What a document with no tab behind it has folded. Never written to — every
	// write goes through `foldHost.setFolds`, which needs an active tab.
	const NO_FOLD_OVERRIDES = new Set<string>();

	let activeTab = $derived(tabManager.activeTab);
	// Fold state belongs to the document, so it lives on the tab (see
	// `Tab.foldOverrides`). Reading it through a derived is what makes a tab
	// switch swap the whole set: the preview render, the table of contents and
	// find all see the folds of the document on screen and no other document's.
	let foldOverrides = $derived(activeTab?.foldOverrides ?? NO_FOLD_OVERRIDES);
	let isEditing = $derived(activeTab?.isEditing ?? false);
	let rawContent = $derived(activeTab?.rawContent ?? '');
	let isSplit = $derived(activeTab?.isSplit ?? false);
	/**
	 * Is there an editor on screen? The two flags are independent — split
	 * view is `isSplit` alone when entered from reading mode — so anything
	 * that hands the reader over to the editor has to ask both. The outline
	 * asked only `isEditing`, and a click on it in split view moved the
	 * preview but not the editor beside it (#744).
	 */
	let hasEditorPane = $derived(isEditing || isSplit);
	let hasPreviewPane = $derived(previewPaneShown(isEditing, isSplit));
	let frontMatterInfo = $derived(parseFrontMatter(rawContent));

	let currentFile = $derived(tabManager.activeTab?.path ?? '');
	let frontMatterPanelKey = $derived(currentFile || tabManager.activeTabId || 'untitled');
	let frontMatterCollapsedByKey = $state<Record<string, boolean>>({});
	const frontMatterFields = new FrontMatterFieldState(() => frontMatterPanelKey);
	let isFrontMatterCollapsed = $derived(frontMatterCollapsedByKey[frontMatterPanelKey] ?? true);
	// An untitled tab is Markdown until saved under another name; see `editorLanguageFor`.
	let isMarkdown = $derived(currentFile === '' || hasMarkdownLinkExtension(currentFile));
	let editorLanguage = $derived(editorLanguageFor(currentFile));
	let htmlContent = $derived(tabManager.activeTab?.content ?? '');
	let scrollTop = $derived(tabManager.activeTab?.scrollTop ?? 0);
	let isScrolled = $derived(scrollTop > 0);
	let windowTitle = $derived(tabManager.activeTab?.title ?? 'Markpad');
	let isScrollSynced = $derived(tabManager.activeTab?.isScrollSynced ?? false);
	let canGoBackInFileHistory = $derived(tabManager.activeTabId ? tabManager.canGoBack(tabManager.activeTabId) : false);
	let canGoForwardInFileHistory = $derived(tabManager.activeTabId ? tabManager.canGoForward(tabManager.activeTabId) : false);

	let loadingTabs = $state<string[]>([]);
	let isAtBottom = $state(false);

	let showHome = $state(false);
	// Which side the tab column is on, or null while the tabs are across the
	// title bar or hidden (#884). Zen mode clears `showTabs`, so it hides the
	// column through the same switch it uses for the strip, and hides the folder too.
	const tabColumnSide = $derived(
		tabManager.tabs.length > 0 && settings.tabPlacement !== 'top' ? settings.tabPlacement : null,
	);
	const folderShown = $derived(folderManager.root !== null && !settings.zenMode);
	// With the tabs in a column the folder stacks into it; otherwise it takes its own side.
	const sidebarSide = $derived(tabColumnSide ?? (folderShown ? settings.folderSide : null));
	let viewerWidth = $state(0);
	// The bounds come from TOC_WIDTH_RANGE, the same object settings.setTocWidth
	// clamps against, so the handle cannot offer a width persistence would shrink.
	// The keyboard increment stays local: TOC_WIDTH_RANGE.step is 1, the spin-button
	// granularity of the numeric settings input, and arrow keys move the splitter 16px.
	const TOC_RESIZE_STEP = 16;
	let isTocResizing = $state(false);
	let tocWrapperEl = $state<HTMLElement | null>(null);
	let tocToggleEl = $state<HTMLElement | null>(null);

	/*
	 * How tall the editor toolbar currently is, measured rather than assumed.
	 *
	 * The floating table-of-contents toggle is absolutely positioned against
	 * `.layout-container`, and its `top` used to be the literal 48px — the 36px
	 * title bar plus a 12px inset. That is the right answer only in preview,
	 * where the title bar is the whole of the chrome above the document. In edit
	 * mode the toolbar occupies exactly that strip, so the toggle landed on top
	 * of its first button.
	 *
	 * Reading the height keeps one answer to "where does the chrome end": the
	 * toolbar's own layout. A second literal here would have to be re-derived
	 * every time its padding, border or font changed, and nothing would fail
	 * when it was not — the toggle would just start overlapping again.
	 *
	 * The `{#if}` around the toolbar is mirrored rather than the height: a
	 * `clientHeight` binding keeps its last value when the element it measured
	 * goes away, so the toggle would stay pushed down after the toolbar was
	 * hidden or the tab returned to preview.
	 */
	let editorToolbarHeight = $state(0);
	let paneTopChrome = $derived(
		hasEditorPane && settings.showEditorToolbar ? editorToolbarHeight : 0,
	);
	let previewAppearance = $derived(previewAppearanceFrom(settings));
	let layout = $derived(previewLayout(settings, { isEditing, isSplit, viewerWidth }));
	let isOverhanging = $derived(layout.isOverhanging);

	/**
	 * Reaching past a floating outline to touch what it is covering is a request
	 * for it to move. Only while it IS covering something: pinned it is a
	 * sidebar, and one sitting in the margin is not in anybody's way.
	 */
	$effect(() => {
		if (!settings.showToc || !tocAutoCollapses(isOverhanging, settings.pinnedToc)) return;
		const dismiss = (e: PointerEvent) => {
			if (dismissesToc(e.target as Node | null, tocWrapperEl, tocToggleEl)) settings.showToc = false;
		};
		// Capture, so a handler that stops propagation on its way up cannot leave
		// the outline stranded over the text.
		window.addEventListener('pointerdown', dismiss, { passive: true, capture: true });
		return () => window.removeEventListener('pointerdown', dismiss, { capture: true });
	});

	import { followTheme } from './utils/themeEffect.svelte.js';

	onMount(() => {
		// Clear the forced background color from app.html
		document.documentElement.style.removeProperty('background-color');
	});

	/**
	 * What Rust should paint the next window's background before any webview
	 * exists — the appearance, not the theme.
	 *
	 * `theme.txt` is read in exactly one place (`app.rs`, at window creation) and
	 * for exactly one purpose, and its vocabulary there is "dark", "light" and
	 * "anything else means ask the OS". A `vscode:` name fell into that last
	 * branch, so choosing a dark VS Code theme on a light desktop flashed a white
	 * window on every launch. Whether such a theme is dark is knowable only after
	 * its JSON has been parsed — which happens here — so the resolved answer is
	 * what gets stored, instead of a name Rust would have to learn to parse.
	 */
	function saveStartupAppearance(appearance: 'system' | 'light' | 'dark') {
		invoke('save_theme', { theme: appearance }).catch(console.error);
	}

	followTheme(() => settings.theme, {
		saveStartupAppearance,
		readVscodeTheme: (name) => invoke<string>('read_vscode_theme', { name }),
		recolourDiagrams: () => { if (markdownBody) renderRichContent(); },
		onLoadFailed: (e) => {
			console.error("Failed to load vscode theme", e);
			settings.theme = 'system';
		},
	});

	let tooltip = $state({ show: false, text: '', shortcut: '', html: '', isFootnote: false, x: 0, y: 0, align: 'top' as 'top' | 'right' | 'left' | 'below' });
	const modalState = new ChoiceDialog();

	let docContextMenu = $state<{
		show: boolean;
		x: number;
		y: number;
		items: ContextMenuItem[];
	}>({
		show: false,
		x: 0,
		y: 0,
		items: [],
	});

	function askCustom(message: string, options: { title: string; kind: 'info' | 'warning' | 'error'; showSave?: boolean }): Promise<'save' | 'discard' | 'cancel'> {
		return modalState.ask(message, options);
	}

	// window.prompt() is a silent no-op inside the webview (wry does not
	// implement the native JS dialogs), so text input goes through our own
	// modal. Resolves with the entered string, or null on cancel.
	let promptModal = $state<{
		show: boolean;
		title: string;
		message: string;
		value: string;
		resolve: ((v: string | null) => void) | null;
	}>({ show: false, title: '', message: '', value: '', resolve: null });

	function promptCustom(message: string, options: { title: string; initial?: string }): Promise<string | null> {
		return new Promise((resolve) => {
			promptModal = {
				show: true,
				title: options.title,
				message,
				value: options.initial ?? '',
				resolve,
			};
		});
	}

	function closePrompt(value: string | null) {
		promptModal.resolve?.(value);
		promptModal.show = false;
	}

	function closeModal(choice: 'save' | 'cancel') {
		modalState.close(choice);
	}

	function handleModalConfirm() {
		modalState.close('discard');
	}

	function handleSplitterKeyDown(e: KeyboardEvent) {
		const activeTab = tabManager.activeTab;
		if (!activeTab || !tabManager.activeTabId) return;

		const next = splitRatioAfterKey(activeTab.splitRatio, e.key, settings.splitEditorSide);
		if (next === null) return;
		tabManager.setSplitRatio(tabManager.activeTabId, next);
	}

	function handleTocResizeKeyDown(e: KeyboardEvent) {
		const keyDelta = e.key === 'ArrowRight' ? TOC_RESIZE_STEP : e.key === 'ArrowLeft' ? -TOC_RESIZE_STEP : 0;
		if (keyDelta !== 0) {
			e.preventDefault();
			const widthDelta = settings.tocSide === 'left' ? keyDelta : -keyDelta;
			settings.setTocWidth(settings.tocWidth + widthDelta);
			return;
		}

		if (e.key === 'Home') {
			e.preventDefault();
			settings.setTocWidth(TOC_WIDTH_RANGE.min);
		} else if (e.key === 'End') {
			e.preventDefault();
			settings.setTocWidth(TOC_WIDTH_RANGE.max);
		}
	}

	let identifyFlash = $state('');
	let identifyFlashTimer: ReturnType<typeof setTimeout> | undefined;

	// Old localStorage snapshot keys. The snapshot is written through Rust now;
	// these are read once for migration and removed after the first Rust write.
	const WINDOW_STATE_KEY = 'savedTabsDataV2';
	const LEGACY_STATE_KEY = 'savedTabsData';
	const RESTORE_IN_PROGRESS_KEY = 'markpad-window-restore-in-progress';

	// Each window persists and restores its own snapshot, keyed by its label.
	// Windows are equal: whichever starts first reopens the others of the last
	// session under the labels they had.
	let recoveryReady = $state(false);
	let recoveryErrorShown = false;
	function reportRecoveryError(error: unknown) {
		console.error('Unsaved-change recovery failed', error);
		if (!recoveryErrorShown) {
			recoveryErrorShown = true;
			addToast(t('toast.recoveryFailed', settings.language), 'error');
		}
	}
	const unsavedRecovery = createBoundedWriter({
		write: (json) => invoke('save_unsaved_recovery', { json }),
		onError: reportRecoveryError,
		initial: '[]',
	});
	$effect(() => {
		if (!recoveryReady) return;
		if (!settings.persistOpenEditors) return void unsavedRecovery.update('[]');
		// The snapshot is built later, outside this effect, so its inputs are
		// read here: only what it keeps, so scrolling does not mark it stale.
		for (const tab of tabManager.tabs) void [tab.path, tab.isDirty, tab.rawContent, tab.originalContent, tab.encoding];
		unsavedRecovery.update(() => recoverySnapshot(tabManager.tabs));
	});

	// Startup, setting on. Without it nothing is read, written or removed.
	// Rust hands over this window's own backup and any orphan no other window
	// has taken (see `claim_unsaved_recovery`).
	async function restoreUnsavedChanges() {
		try {
			const records = await invoke<Array<[string, string]>>('claim_unsaved_recovery');
			const consumed = restoreRecords(tabManager, records, appWindow.label, reportRecoveryError);
			// Publish the new owner before removing stale window copies.
			await invoke('save_unsaved_recovery', { json: recoverySnapshot(tabManager.tabs) });
			await invoke('clear_unsaved_recovery', { labels: consumed });
			for (const id of await documentSession.dirtyTabsChangedOnDisk()) noteExternalChangeConflict(id);
			recoveryReady = true;
		} catch (error) {
			// Not ready: nothing overwrites the record, and close asks as usual.
			reportRecoveryError(error);
		}
	}

	// The snapshot: window shape only, never document content. `folderRoot`
	// rides along so each window gets its own folder back.
	const windowStateJson = () => tabManager.serializeState({ folderRoot: folderManager.root });
	let restoredFolder: string | null = null;

	const transferOptions = createTransferOptions({
		editorPane: () => editorPane,
		windowStateJson,
		isCloseWalkActive: () => windowExit.isCloseWalkActive(),
		isDisposed: () => isDisposed,
		renderPreview: renderTabPreviewFromRaw,
		restoreReadingPosition: (tab) => {
			if (markdownBody) restorePreviewReadingPosition(markdownBody, tab, getPreviewScrollMax(markdownBody), measurePreviewBox);
		},
	});

	const windowSession = createWindowSession({
		windowStateKey: WINDOW_STATE_KEY,
		legacyStateKey: LEGACY_STATE_KEY,
		restoreInProgressKey: RESTORE_IN_PROGRESS_KEY,
		serializeState: transferOptions.serializeState,
		shouldRestoreState: () => settings.restoreStateOnReopen,
		isDisposed: () => isDisposed,
		restoreState: (json) => {
			tabManager.restoreState(json);
			restoredFolder = snapshotFolder(json);
		},
		restoredTabs: () => tabManager.tabs.map((tab) => ({ id: tab.id, path: tab.path })),
		loadRestoredTab: (tabId) => documentSession.readRestoredTab(tabId),
		dropRestoredTab: (tabId) => tabManager.closeTab(tabId),
		canTransfer: transferOptions.canTransfer,
		canDetach: transferOptions.canDetach,
		transferPayload: transferOptions.transferPayload,
		onTransferClaimed: (tabId) => tabManager.closeTab(tabId),
		acceptTransferredTab: transferOptions.acceptTransferredTab,
		onError: (message, error) => {
			console.error(message, error);
			addToast(`${message}: ${String(error)}`, 'error');
		},
		onWarning: (message, error) => console.warn(message, error),
		// The console line above says the same thing in more detail, but in a
		// packaged build nobody can open that console: the recovery mechanism
		// was diagnosing itself and writing the answer where no one could read
		// it. A document missing its content needs an explanation on screen.
		onInterrupted: ({ deferredPath }) =>
			addToast(
				deferredPath
					? t('toast.restoreInterruptedDeferred', settings.language).replace('{path}', deferredPath)
					: t('toast.restoreInterrupted', settings.language),
				'warning',
			),
	});
	const { handleDetach, moveTabToWindow } = createTabMovers({
		ensureFullContent: (tabId) => documentSession.ensureFullContent(tabId),
		onPartialDocument: () => addToast(t('toast.partialDocument', settings.language), 'error'),
		session: windowSession,
	});

	// The session is recorded as it changes, so a crash or kill brings this
	// window back as it was. Tracks the window's shape only: which tabs, in
	// what order, which is active, how each is viewed, the tag and the folder.
	// Scroll and editor position are not tracked, so scrolling writes nothing;
	// they are written with the next tracked change and at every checkpoint
	// (focus loss, hide, close, quit).
	$effect(() => {
		for (const tab of tabManager.tabs) {
			void [tab.id, tab.path, tab.title, tab.isEditing, tab.isSplit, tab.splitRatio, tab.isScrollSynced];
		}
		const tag = tabManager.windowTag;
		void [tabManager.activeTabId, tag?.name, tag?.color, tag?.pinned, folderManager.root];
		// Not `serializeState`: its editor flush is only sound when no tab
		// switch is under way, and this runs on one.
		windowSession.record(untrack(windowStateJson));
	});

	const windowMeta = reportWindowMeta(tabManager, pinnedTagFromWindowLabel(appWindow.label) === null);

	$effect(() => {
		const tag = tabManager.windowTag;
		appWindow.setTitle(tag ? `${tag.name} — ${windowTitle}` : windowTitle).catch(() => {});
	});

	let pinnedTags = $state<Array<{ name: string; color: string; files: string[] }>>([]);

	async function refreshPinnedTags() {
		pinnedTags = (await invoke('list_pinned_tags')) as typeof pinnedTags;
	}

	async function unpinTagFromHome(name: string) {
		await invoke('remove_pinned_tag', { name });
		if (tabManager.windowTag?.name === name) tabManager.setWindowTag({ ...tabManager.windowTag, pinned: false });
		await refreshPinnedTags();
	}

	// The template's HomePage gate: an empty window or the home tab shows Home
	// without `showHome`, which is the cold-start case.
	// Reading the window tag re-runs this when the title bar pins or unpins it.
	// The pin's IPC is sent first and sync commands run in order, so the list sees it.
	$effect(() => {
		void tabManager.windowTag?.pinned;
		if (showsHomeScreen(tabManager.activeTab, showHome)) refreshPinnedTags().catch(console.error);
	});

	const documentSession = createDocumentSession({
		setShowHome: (value) => (showHome = value),
		currentFile: () => currentFile,
		resetScrollHistory: () => {
			if (tabManager.activeTabId) tabManager.clearScrollHistory(tabManager.activeTabId);
		},
		renderMarkdown: renderMarkdownPreview,
		afterLoad: tick,
		saveRecentFile,
		deleteRecentFile,
		setLoadingTabs: (tabIds) => (loadingTabs = tabIds),
		measureInitialViewport: () => {
			tick().then(() => {
				if (markdownBody) isAtBottom = markdownBody.scrollHeight <= markdownBody.clientHeight + 100;
			});
		},
		isScrolling: () => isScrolling,
		onError: (message, error) => {
			console.error(message, error);
			addToast(`${message}: ${String(error)}`, 'error');
		},
		onDiskChangedUnderSave: (id) => externalChange.noteExternalChangeConflict(id),
		cancelPendingAutoSave,
		// Two questions, one dialog. With the file untouched, Save means "write
		// what I typed" and the ordinary wording is right. With the disk moved
		// under the buffer, Save means "overwrite what somebody else wrote", and
		// saying "you have unsaved changes" would hide the half that matters.
		// The changed-on-disk sentence is the same one the conflict bar uses,
		// because it is the same news.
		askClose: (title, diskMoved) =>
			askCustom(
				diskMoved
					? t('externalChange.message', settings.language)
					: t('modal.youHaveUnsavedChanges', settings.language).replace('{title}', title),
				{
					title: t('modal.unsavedChanges', settings.language),
					kind: 'warning',
					showSave: true,
				},
			),
		onCloseSaveNewerEdits: () => addToast(t('toast.savedNewerEdits', settings.language), 'info'),
		onCloseAutoSaveFailed: () => addToast(t('toast.autoSaveFailed', settings.language), 'error'),
		// Not an error: the copy is the way out of a partial buffer, and it was
		// written. What the reader needs is to know where it stops.
		onPartialCopySaved: () => addToast(t('toast.partialCopySaved', settings.language), 'info'),
	});

	const externalChange = createExternalChange({
		tabManager,
		settings,
		documentSession,
		loadMarkdown,
		canCloseTab,
		readFile: (path) => invoke('read_file_content_checked', { path }),
		editorLanguageFor,
		addToast,
		t,
	});
	const {
		saveContent,
		saveActiveTab,
		saveSilently,
		flushBeforeLeavingEditableMode,
		hasExternalChangeConflict,
		noteExternalChangeConflict,
		resolveExternalChangeByReloading,
		reloadFromDisk,
		compareExternalChange,
		resolveExternalChangeByKeepingBuffer,
	} = externalChange;

	const viewMode = createViewMode({
		tabManager,
		settings,
		documentSession,
		flushBeforeLeavingEditableMode,
		readFile: (path) => invoke('read_file_content_checked', { path }),
		renderTabPreviewFromRaw,
		tick,
		addToast,
		t,
		get editorPane() {
			return editorPane;
		},
		get markdownBody() {
			return markdownBody;
		},
		get previewBlocks() {
			return previewBlocks;
		},
		get lineCoords() {
			return lineCoords;
		},
		readRendererLine: (line) => readRendererLine(line),
		getPreviewScrollSyncPosition,
		scrollPreviewToSyncPosition,
		getPreviewScrollAnchor,
	});
	const {
		followToc,
		handleEditorCursor,
		placePreviewCursor,
		handleEditorScrollSync,
		syncEditorToPreviewScroll,
		toggleEdit,
		toggleEditView,
		editSourceRangeAt,
		toggleSplitView,
		setViewMode,
	} = viewMode;

	// Persisted through Rust, not localStorage: setItem is an async message
	// to the WebKit storage process that dies in transit when the last
	// window's close ends the process (reproduced in QA as "close secondary
	// first, then main → snapshot gone"). An awaited invoke keeps the close
	// handler — and the process — alive until the bytes are on disk. The
	// localStorage keys are read once for migration and removed after the
	// first successful Rust write; a downgraded build then starts
	// a fresh session instead of misreading anything.
	//
	// `remember` false: this window closed on its own while others stay, so it
	// is forgotten — even with restore off, or a later quit with it back on
	// would reopen it from a stale snapshot.
	async function persistWindowState(remember: boolean) {
		if (!remember) await windowSession.persistState(false);
		else if (settings.restoreStateOnReopen) await windowSession.persistState(true);
	}

	const windowExit = createWindowExit({
		tabManager,
		settings,
		appWindow,
		allWindows: getAllWindows,
		recovery: {
			isReady: () => recoveryReady,
			keep: () => unsavedRecovery.flush(recoverySnapshot(tabManager.tabs)),
			drop: () => unsavedRecovery.flush('[]'),
		},
		persistWindowState,
		canCloseTab,
		saveSilently,
		hasExternalChangeConflict,
		onAutoSaveFailed: () => addToast(t('toast.autoSaveFailed', settings.language), 'error'),
		settle: tick,
		loadMarkdown,
		setShowHome: (value) => (showHome = value),
		moveTabToWindow,
	});
	const {
		savePinnedTagIfNeeded,
		openPinnedTag,
		settleForUpdate,
		appExit,
		destroyWindowAfterTabsClosed,
		closeTabAndWindowIfLast,
		mergeSelfInto,
	} = windowExit;

	/**
	 * A tab switch must not animate. Switching to a tab in another mode changes
	 * the values a mode toggle changes, so the outline's shadow and the toggle
	 * button's position would transition. Add `tab-switching` (transitions off,
	 * see styles.css), force a style recompute, remove it: the new values commit
	 * without animating. It must happen here, before the browser recomputes
	 * style; a `class:` directive would land a flush too late. The pane slide
	 * skips tab switches itself.
	 */
	$effect(() => {
		const _ = tabManager.activeTabId;
		const container = untrack(() => layoutContainerEl);
		if (container) commitWithoutTransitions(container);
		showHome = false;
		findOpen = false;
	});

	/*
	 * A view mode switch slides its panes; `utils/paneSlide.ts` says how. The
	 * boxes and the editor's content are read before the DOM update, the slide
	 * starts after it. A tab switch is not a mode switch and does not slide
	 * (see the effect above).
	 */
	const paneSlider = createPaneSlider();
	let panesShown: { tabId: string | null; shown: PanesShown } | null = null;

	$effect.pre(() => {
		const now = { tabId: tabManager.activeTabId, shown: { editor: hasEditorPane, viewer: hasPreviewPane } };
		untrack(() => {
			const last = panesShown;
			panesShown = now;
			if (!last || last.tabId !== now.tabId) return paneSlider.settle();
			const plan = planPaneSlide(last.shown, now.shown);
			if (plan && layoutContainerEl && editorPaneEl && viewerPaneEl)
				paneSlider.capture({ container: layoutContainerEl, editor: editorPaneEl, viewer: viewerPaneEl }, plan);
		});
	});

	$effect(() => {
		void isEditing;
		void isSplit;
		untrack(() => {
			if (layoutContainerEl && editorPaneEl && viewerPaneEl)
				paneSlider.play({ container: layoutContainerEl, editor: editorPaneEl, viewer: viewerPaneEl });
		});
	});

	followActiveFile(() => currentFile);

	// The preview and the export run the same filter in opposite orders, on
	// purpose. The export sanitizes the renderer output first and processes
	// afterwards, because the bytes it writes are read by another program and
	// running the filter over Markpad's own generated markup would let a future
	// tightening of the policy silently delete parts of the exported file; the
	// exported document carries a CSP as the second line of defence.
	//
	// The preview has no second line: what it produces becomes nodes in the live
	// application document, so the filter runs last. `tab.content` holds the
	// renderer's own output, split into top-level blocks, and the patch effect
	// hands it to `patchPreview`, which processes and sanitizes only the blocks
	// that changed and moves DOMPurify's own nodes into the article. No
	// parse/serialize round trip happens after the sanitizer has had its say.
	//
	// The document's path and folds are read when the patch runs, from the tab
	// on screen, which is the document being patched: a navigation has already
	// moved the tab to the new file and cleared its folds by then.
	async function renderMarkdownPreview(raw: string) {
		const body = getMarkdownBodyWithoutFrontMatter(raw);
		return (await invoke('render_markdown', { content: body, splitBlocks: true })) as string;
	}

	async function renderTabPreviewFromRaw(tab: Tab) {
		const rendered = await renderMarkdownPreview(tab.rawContent);
		tabManager.updateTabContent(tab.id, rendered);
		tab.previewedRawContent = tab.rawContent;
		// The patch effect turns the new `tab.content` into DOM and enriches what
		// it changed, so this only has to wait for the flush. It used to call
		// `renderRichContent()` here as well, over the whole article — a second
		// pass that now competes with the first one for the same nodes.
		await tick();
	}

	function frontMatterFieldId(key: string) {
		return `frontmatter-${key.replace(/[^a-zA-Z0-9_-]/g, '-')}`;
	}

	function tagsEqual(left: string[], right: string[]) {
		return left.length === right.length && left.every((value, index) => value === right[index]);
	}

	function focusAndSelect(node: HTMLInputElement) {
		requestAnimationFrame(() => {
			node.focus();
			node.select();
		});
	}

	function setFrontMatterCollapsed(collapsed: boolean) {
		frontMatterCollapsedByKey[frontMatterPanelKey] = collapsed;
	}

	function clearFrontMatterEditError(field: FrontMatterField) {
		frontMatterFields.clearEditError(field);
	}

	// `nextValue` runs inside the try so a parse error lands on the field.
	async function applyFrontMatter(tab: Tab, field: FrontMatterField, nextValue: () => unknown) {
		try {
			const nextRaw = updateFrontMatterField(tab.rawContent, field.key, nextValue());
			tabManager.updateTabRawContent(tab.id, nextRaw);
			clearFrontMatterEditError(field);
			await renderTabPreviewFromRaw(tab);
		} catch (error) {
			frontMatterFields.setEditError(field, error);
		}
	}

	const { handleFrontMatterEdit, handleFrontMatterListChange } = createFrontMatterEdit({
		tabManager,
		settings,
		documentSession,
		addToast,
		t,
		applyFrontMatter,
	});

	function getFrontMatterTagDraft(field: FrontMatterField) {
		return frontMatterFields.tagDraft(field);
	}

	function setFrontMatterTagDraft(field: FrontMatterField, value: string) {
		frontMatterFields.setTagDraft(field, value);
	}

	function clearFrontMatterTagDraft(field: FrontMatterField) {
		frontMatterFields.clearTagDraft(field);
	}

	function getFrontMatterTagEditIndex(field: FrontMatterField) {
		return frontMatterFields.tagEditIndex(field);
	}

	function getFrontMatterTagEditDraft(field: FrontMatterField, fallback: string) {
		return frontMatterFields.tagEditDraft(field, fallback);
	}

	function setFrontMatterTagEditDraft(field: FrontMatterField, value: string) {
		frontMatterFields.setTagEditDraft(field, value);
	}

	function startFrontMatterTagEdit(field: FrontMatterField, index: number, value: string) {
		frontMatterFields.startTagEdit(field, index, value);
	}

	function clearFrontMatterTagEdit(field: FrontMatterField) {
		frontMatterFields.clearTagEdit(field);
	}

	async function commitFrontMatterTagAdd(field: FrontMatterField) {
		const draft = getFrontMatterTagDraft(field);
		if (!draft.trim()) return;

		const currentItems = getFrontMatterListItems(field);
		const nextItems = addFrontMatterListItems(currentItems, [draft]);
		if (tagsEqual(currentItems, nextItems)) {
			clearFrontMatterTagDraft(field);
			return;
		}

		await handleFrontMatterListChange(field, nextItems);
		clearFrontMatterTagDraft(field);
	}

	async function removeFrontMatterTag(field: FrontMatterField, index: number) {
		const currentItems = getFrontMatterListItems(field);
		const nextItems = removeFrontMatterListItem(currentItems, index);
		if (tagsEqual(currentItems, nextItems)) return;

		await handleFrontMatterListChange(field, nextItems);
	}

	async function commitFrontMatterTagEdit(field: FrontMatterField, index: number) {
		if (getFrontMatterTagEditIndex(field) !== index) return;

		const draft = getFrontMatterTagEditDraft(field, '');
		const currentItems = getFrontMatterListItems(field);
		const nextItems = updateFrontMatterListItem(currentItems, index, draft);

		clearFrontMatterTagEdit(field);
		if (tagsEqual(currentItems, nextItems)) return;

		await handleFrontMatterListChange(field, nextItems);
	}

	function handleFrontMatterTagAddKeydown(event: KeyboardEvent, field: FrontMatterField) {
		if (event.key === 'Enter' || event.key === ',') {
			event.preventDefault();
			void commitFrontMatterTagAdd(field);
			return;
		}

		if (event.key === 'Escape') {
			event.preventDefault();
			clearFrontMatterTagDraft(field);
		}
	}

	function handleFrontMatterTagEditKeydown(event: KeyboardEvent, field: FrontMatterField, index: number) {
		if (event.key === 'Enter') {
			event.preventDefault();
			void commitFrontMatterTagEdit(field, index);
			return;
		}

		if (event.key === 'Escape') {
			event.preventDefault();
			clearFrontMatterTagEdit(field);
		}
	}

	async function loadMarkdown(filePath: string, options: LoadMarkdownOptions = {}) {
		return documentSession.loadMarkdown(filePath, options);
	}

	function currentMermaidTheme() {
		return resolveMermaidTheme({
			theme: settings.theme,
			datasetThemeType: document.documentElement.dataset.themeType,
			systemPrefersDark: window.matchMedia('(prefers-color-scheme: dark)').matches,
		});
	}

	/**
	 * The preview half of the shared renderer: same function the HTML export
	 * calls, pointed at the live preview element and given the copy-to-clipboard
	 * behaviour an exported file cannot have.
	 *
	 * `roots` is what the block patch just inserted. Omitting it means the whole
	 * article, which is what a theme change (Mermaid bakes its colours into the
	 * SVG) and the pre-export refresh need; passing it is what makes a keystroke
	 * typeset one paragraph.
	 */
	async function renderRichContent(roots?: HTMLElement[]) {
		if (!markdownBody) return;
		const targets = roots ?? [markdownBody];
		if (targets.length === 0) return;

		await renderRichContentInto({
			roots: targets,
			mermaidTheme: currentMermaidTheme(),
			onCopyCode: (code, label) => {
				invoke('clipboard_write_text', { text: code.replace(/\n$/, '') })
					.then(() => flashCopiedLabel(label))
					.catch((err) => {
						console.error('Failed to copy code:', err);
					});
			},
		});
	}

	/**
	 * The one place a rendered document becomes preview DOM: patch, then enrich
	 * only what the patch inserted.
	 *
	 * Cold start: the rich-content libraries a document needs are imported by
	 * its first enrichment, which lands after the first patch, so that one
	 * restores the reading position again, because KaTeX and Mermaid can push
	 * the anchor down by hundreds of pixels.
	 */
	const previewPatch = followPreviewPatch(() => previewBlocks, () => htmlContent, (host, htmlContent) => {
		// This document is injected into the app's own document, so it runs the
		// same policy the export runs — the one place a document is untrusted
		// must not have its own private copy of the rules. The preview used to
		// inline a duplicate of the URI pattern and nothing else, which left a
		// `style` tag (on DOMPurify's default allowlist, CSS unfiltered) live
		// inside the app's document: an author stylesheet is not scoped to the
		// article, so it could hide the title bar and beacon out through
		// `background-image: url(https://…)`, neither of which the app CSP blocks
		// (`style-src 'unsafe-inline'`, `img-src … https:`). See
		// ./utils/sanitize.ts for the policy itself, and renderMarkdownPreview
		// for why this path sanitizes last.
		//
		// Untracked: a fold toggle or a rename is not a new document.
		const patch = patchHost(
			host,
			htmlContent,
			() => untrack(() => {
				const tab = tabManager.activeTab;
				return { filePath: tab?.path ?? '', foldOverrides: tab?.foldOverrides ?? NO_FOLD_OVERRIDES };
			}),
			(scope) => foldLayout.current?.observe(scope),
		);
		// A host's first enrichment is the cold start above: see `coldRestore`.
		coldRestore.afterEnrichment(host, patch.inserted.length, renderRichContent(patch.inserted));
	});

	const coldRestore = createColdEnrichmentRestore({
		tabManager,
		tick,
		get markdownBody() {
			return markdownBody;
		},
		restore: (body, tab) => restorePreviewReadingPosition(body, tab, getPreviewScrollMax(body), measurePreviewBox),
	});

	// A hidden host is not observed: its boxes measure 0 (see `previewHosts`).
	followFoldLayout(foldLayout, () => previewBlocks, () => hasPreviewPane);

	// Re-apply find highlights after a render. The patch only replaces the blocks
	// that changed, so most highlights now survive on their own nodes — but the
	// ones inside a replaced block do not, and without this they vanish until the
	// user re-types in the find bar.
	$effect(() => {
		const _ = htmlContent;
		if (!findOpen || !findBar) return;
		tick().then(() => findBar?.reapply());
	});

	$effect(() => {
		// Depend on the ID and body existence to trigger restore
		const id = tabManager.activeTabId;
		const body = markdownBody;
		// ...and on WHICH DOCUMENT that tab holds. Following a link, and
		// back/forward, keep the tab and swap the document under it, and
		// `clearReadingPosition` puts the tab at the top of the new one. This
		// effect is the only thing that moves the preview to a tab's recorded
		// position, so without this dependency that reset reaches nothing: the
		// container keeps the pixel offset the reader had in the PREVIOUS
		// document, and the new document opens part-way down.
		void currentFile;

		if (id && body) {
			untrack(() => {
				const tab = tabManager.tabs.find((t) => t.id === id);
				// The cascade itself is `restorePreviewReadingPosition` in
				// previewAnchor.ts, next to the three measurements it runs. It is a
				// function and not this block because the arrival of a transferred
				// tab has to run the SAME cascade after its document lands (see
				// `acceptTransferredTab`), and two copies consulting the same three
				// fields in different orders would be two answers for one tab.
				if (tab) restorePreviewReadingPosition(body, tab, getPreviewScrollMax(body), measurePreviewBox);
			});
		}
	});

	$effect(() => {
		if (markdownBody && !isEditing && tabManager.activeTabId) {
			tick().then(() => {
				markdownBody?.focus({ preventScroll: true });
			});
		}
	});

	function getPreviewScrollMax(target: HTMLElement) {
		return Math.max(0, target.scrollHeight - target.clientHeight);
	}

	// Not `element.offsetTop`: that is measured from the element's offset parent,
	// and the preview is full of them — every `<table>` is the offset parent of
	// its own rows and cells, and `.code-block-shell` is positioned. See
	// `measureAnchorBox` for what reading those raw does to the mapping.
	function measurePreviewBox(node: AnchorNode): AnchorBox {
		if (!markdownBody) return { top: Number.NaN, height: Number.NaN };
		return measureAnchorBox(
			node as unknown as OffsetLayoutNode,
			markdownBody as unknown as OffsetLayoutNode,
		);
	}

	function getPreviewScrollSyncPosition(target: HTMLElement): ScrollSyncPosition {
		return previewScrollSyncPosition(target, getPreviewScrollMax(target), lineCoords, measurePreviewBox);
	}

	function scrollPreviewToSyncPosition(position: ScrollSyncPosition) {
		if (!markdownBody) return;
		const targetScroll = getPreviewScrollTopForSyncPosition(
			markdownBody,
			getPreviewScrollMax(markdownBody),
			position,
			lineCoords,
			measurePreviewBox,
		);
		if (targetScroll === null) return;

		isProgrammaticScroll = true;
		markdownBody.scrollTop = targetScroll;
	}

	let bufferLines = $derived(rawContent.split('\n'));
	const readRendererLine: SourceLineReader = (line) => bufferLines[lineCoords.toBufferLine(asRendererLine(line)) - 1];

	/** The drawn cursor, in the article's scroll content; null while it isn't shown. */
	let previewCursorBox = $state<{ top: number; left: number; height: number } | null>(null);

	/**
	 * Bumped whenever the document on screen changes size: a rewrap when split
	 * view narrows the pane, a fold, an image arriving. The drawn cursor is
	 * measured in that layout, so it has to be measured again.
	 */
	let previewLayoutVersion = $state(0);

	$effect(() => {
		const host = previewBlocks;
		if (!host) return;
		const observer = new ResizeObserver(() => previewLayoutVersion++);
		observer.observe(host);
		return () => observer.disconnect();
	});

	$effect(() => {
		const cursor = viewMode.activeCursor;
		const shown = settings.previewCursor && cursor !== null && hasPreviewPane;
		void htmlContent;
		void previewLayoutVersion;
		if (!shown) {
			previewCursorBox = null;
			return;
		}
		tick().then(() => {
			previewCursorBox = measurePreviewCursor(cursor);
		});
	});

	function measurePreviewCursor(cursor: { line: BufferLine; column: number }) {
		if (!previewBlocks || !markdownBody) return null;
		const at = pointAtSource(previewBlocks, { line: lineCoords.toRendererLine(cursor.line), column: cursor.column }, readRendererLine);
		if (!at) return null;

		const range = document.createRange();
		range.setStart(at.node, at.offset);
		const rect = range.getClientRects()[0] ?? (at.node instanceof Element ? at.node : at.node.parentElement)?.getBoundingClientRect();
		if (!rect || rect.height === 0) return null;

		const body = markdownBody.getBoundingClientRect();
		return {
			top: rect.top - body.top + markdownBody.scrollTop,
			left: rect.left - body.left + markdownBody.scrollLeft,
			height: rect.height,
		};
	}

	/**
	 * The reader's highlights, per tab, for this session only. Each list is
	 * tied to the source it was made on: once the text changes its points no
	 * longer name the same words, so the list is dropped rather than drawn on
	 * the wrong ones.
	 */
	let annotationsByTab = $state.raw<Record<string, { source: string; marks: Annotation[] }>>({});
	let activeAnnotations = $derived.by(() => {
		const entry = tabManager.activeTabId ? annotationsByTab[tabManager.activeTabId] : undefined;
		return settings.previewAnnotations && entry && entry.source === rawContent ? entry.marks : [];
	});
	const canAnnotate = typeof CSS !== 'undefined' && 'highlights' in CSS;

	function setAnnotations(marks: Annotation[]) {
		const tabId = tabManager.activeTabId;
		if (tabId) annotationsByTab = { ...annotationsByTab, [tabId]: { source: rawContent, marks } };
	}

	/** The preview selection as source points, or null when it is empty or outside the document. */
	function selectionAnnotation(): Annotation | null {
		const selection = window.getSelection();
		if (!previewBlocks || !selection || selection.isCollapsed || !selection.rangeCount) return null;
		const range = selection.getRangeAt(0);
		return previewBlocks.contains(range.commonAncestorContainer) ? annotationOf(previewBlocks, range, readRendererLine) : null;
	}

	function annotationPointAt(e: MouseEvent) {
		const caret = previewBlocks && document.caretRangeFromPoint(e.clientX, e.clientY);
		return caret ? sourceAtPoint(previewBlocks!, { node: caret.startContainer, offset: caret.startOffset }, readRendererLine) : null;
	}

	/**
	 * One Highlight per kind, kept and refilled. WebKit repaints when a
	 * Highlight's ranges change, but not when the registry entry is swapped
	 * for a new one: a removed highlight stayed on screen until the next click.
	 */
	const annotationHighlight = canAnnotate ? new Highlight() : null;
	const occurrenceHighlight = canAnnotate ? new Highlight() : null;
	if (annotationHighlight && occurrenceHighlight) {
		CSS.highlights.set('markpad-annotation', annotationHighlight);
		CSS.highlights.set('markpad-occurrence', occurrenceHighlight);
	}

	function refill(highlight: Highlight, ranges: Range[]) {
		highlight.clear();
		for (const range of ranges) highlight.add(range);
	}

	$effect(() => {
		if (!annotationHighlight) return;
		const marks = activeAnnotations;
		const host = previewBlocks;
		void htmlContent;
		tick().then(() => {
			refill(annotationHighlight, host ? marks.map((mark) => rangeOf(host, mark, readRendererLine)).filter((range) => range !== null) : []);
		});
	});

	/** Longer selections are passages, not words to look for. */
	const OCCURRENCE_MAX_LENGTH = 100;
	const OCCURRENCE_LIMIT = 1000;

	/** The preview selection's text when it is one to look for copies of, else null. */
	function occurrenceText(): string | null {
		const selection = window.getSelection();
		if (!previewBlocks || !selection || selection.isCollapsed || !selection.rangeCount) return null;
		if (!previewBlocks.contains(selection.getRangeAt(0).commonAncestorContainer)) return null;
		const text = selection.toString();
		return text.trim() !== '' && !text.includes('\n') && text.length <= OCCURRENCE_MAX_LENGTH ? text : null;
	}

	/** Every copy of `text` not already highlighted, as annotations. */
	function occurrenceAnnotations(text: string): Annotation[] {
		if (!previewBlocks) return [];
		const found: Annotation[] = [];
		for (const range of occurrenceRanges(previewBlocks, text, OCCURRENCE_LIMIT)) {
			const mark = annotationOf(previewBlocks, range, readRendererLine);
			if (mark && !overlapping([...activeAnnotations, ...found], mark).length) found.push(mark);
		}
		return found;
	}

	$effect(() => {
		if (!occurrenceHighlight || !settings.previewOccurrences) return;
		const update = () => {
			const text = occurrenceText();
			refill(occurrenceHighlight, text ? occurrenceRanges(previewBlocks!, text, OCCURRENCE_LIMIT) : []);
		};
		document.addEventListener('selectionchange', update);
		return () => {
			document.removeEventListener('selectionchange', update);
			occurrenceHighlight.clear();
		};
	});

	function getPreviewScrollAnchor(target: HTMLElement): RendererLine | null {
		return previewScrollAnchor(target, measurePreviewBox);
	}

	let isScrolling = $state(false);
	let scrollIdleTimer: ReturnType<typeof setTimeout>;

	function handleScroll(e: Event) {
		const target = e.target as HTMLElement;

		isAtBottom = Math.abs(target.scrollHeight - target.scrollTop - target.clientHeight) < 100;

		isScrolling = true;
		clearTimeout(scrollIdleTimer);
		scrollIdleTimer = setTimeout(() => {
			isScrolling = false;
		}, 300);

		if (tabManager.activeTabId) tabManager.updateTabScroll(tabManager.activeTabId, target.scrollTop);

		if (isProgrammaticScroll) {
			isProgrammaticScroll = false;
			return;
		}

		if (tabManager.activeTabId) {
			// Percentage fallback
			if (target.scrollHeight > target.clientHeight) {
				const percentage = target.scrollTop / (target.scrollHeight - target.clientHeight);
				tabManager.updateTabScrollPercentage(tabManager.activeTabId, percentage);
			}

			// One descent, two consumers: the tab's reading position, and the
			// outline. Both want the line at the top of the preview, and this is
			// already the only place it is measured.
			const anchorLine = getPreviewScrollAnchor(target);
			if (anchorLine !== null) {
				tabManager.updateTabAnchorLine(tabManager.activeTabId, anchorLine);
				followToc('preview', anchorLine);
			}
		}

		syncEditorToPreviewScroll(target);
	}

	/**
	 * What the fold drivers in `foldState.ts` act on: the document on screen,
	 * and the tab that document belongs to.
	 *
	 * The write goes to the tab the user is looking at, which is the document
	 * the fold is a fold OF — a fold is per document (see `Tab.foldOverrides`),
	 * and the read above is what makes a tab switch swap the whole set.
	 */
	const foldHost: FoldHost = {
		// The active tab's host, not the article. `foldState` answers both of its
		// questions with `root.querySelectorAll('[data-fold-key]')`, and the
		// article holds a host per open tab — so from there a fold key would
		// resolve against whichever document happened to be earlier in the DOM.
		get root() {
			return previewBlocks ?? null;
		},
		get folds() {
			return foldOverrides;
		},
		setFolds(next) {
			if (tabManager.activeTabId) tabManager.setTabFoldOverrides(tabManager.activeTabId, next);
		},
	};

	// Looked up in the visible host, not the article. Heading ids are minted per
	// document, so with a host per open tab the same `#id` exists once per tab
	// that has that heading; the article would hand back whichever came first in
	// the DOM, which is not the document on screen.
	function findAnchorTarget(anchor: string): HTMLElement | null {
		for (const id of anchorIdCandidates(anchor)) {
			const el =
				(previewBlocks?.querySelector(`[id="${CSS.escape(id)}"]`) as HTMLElement | null) ||
				(previewBlocks?.querySelector(`[name="${CSS.escape(id)}"]`) as HTMLElement | null);
			if (el) return el;
		}
		return null;
	}

	function scrollToAnchor(anchor: string, options: { pushHistory?: boolean } = {}) {
		const el = findAnchorTarget(anchor);
		if (el && markdownBody) {
			if (options.pushHistory !== false) pushScrollHistory();
			markdownBody.scrollTo({ top: anchorScrollTop(markdownBody, el), behavior: jumpBehavior });
			return true;
		}
		return false;
	}

	async function scrollToAnchorWhenReady(anchor: string, options: { pushHistory?: boolean } = {}, expectedFile = currentFile) {
		const baseAttempts = 20;
		const maxAttempts = 60;
		for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
			if (expectedFile && currentFile !== expectedFile) return false;
			await tick();
			if (scrollToAnchor(anchor, options)) return true;
			const isFullDocumentLoading = tabManager.activeTabId ? loadingTabs.includes(tabManager.activeTabId) : false;
			if (attempt >= baseAttempts && !isFullDocumentLoading) return false;
			await new Promise((resolve) => setTimeout(resolve, attempt < 5 ? 50 : 250));
		}
		return false;
	}

	function openRelativeMarkdownTarget(target: RelativeMarkdownTarget) {
		return openRelativeTarget(target, {
			currentFile,
			canonicalizePath,
			scrollToAnchorWhenReady,
			scrollToTop: () => {
				if (!markdownBody) return;
				pushScrollHistory();
				markdownBody.scrollTo({ top: 0, behavior: jumpBehavior });
			},
			get activeTabId() { return tabManager.activeTabId; },
			canCloseTab,
			loadMarkdown: (path) => loadMarkdown(path, { navigate: true }),
		});
	}

	async function openMarkdownTargetInNewTab(target: RelativeMarkdownTarget) {
		const resolved = resolveMarkdownTargetPath(currentFile, target);
		if (!resolved) return;

		await documentSession.openInNewTab(resolved);
		if (target.hash) {
			await scrollToAnchorWhenReady(target.hash, { pushHistory: false }, tabManager.activeTab?.path);
		}
	}

	function handleLinkClick(e: MouseEvent) {
		return handlePreviewClick(e, {
			hideTooltip: () => { tooltip.show = false; },
			toggleFold: (target) => toggleFoldFromClick(foldHost, target),
			scrollToAnchor: (id) => scrollToAnchorWhenReady(id),
			opensInNewTab: (event) => opensInNewTab(settings.osType, event, settings.linksOpenInNewTab),
			openInNewTab: openMarkdownTargetInNewTab,
			openHere: openRelativeMarkdownTarget,
			zoom: (data) => { zoomData = data; },
			placeCursor: placePreviewCursor,
		});
	}

	async function handleTaskCheckboxChange(event: Event) {
		const checkbox = event.target as HTMLInputElement;
		if (checkbox.tagName !== 'INPUT' || checkbox.type !== 'checkbox' || !checkbox.hasAttribute('data-task-checkbox')) return;

		const nowChecked = checkbox.checked;
		if (!(await toggleTaskCheckbox(checkbox, nowChecked))) {
			checkbox.checked = !nowChecked;
		}
	}

	async function toggleTaskCheckbox(checkbox: HTMLInputElement, nowChecked: boolean): Promise<boolean> {
		const sourcePosition = checkbox.closest('li')?.getAttribute('data-sourcepos');
		const sourceLine = Number(sourcePosition?.match(/^(\d+):/)?.[1]);
		if (!Number.isInteger(sourceLine) || sourceLine < 1) return false;
		if (!(await documentSession.toggleTaskCheckbox(sourceLine, nowChecked))) return false;
		const li = checkbox.closest('li');
		if (li) {
			li.classList.toggle('task-done', nowChecked);
		}
		return true;
	}



	function saveRecentFile(path: string) {
		recentFileList.save(path);
	}

	function loadRecentFiles() {
		recentFileList.load();
	}

	function deleteRecentFile(path: string) {
		recentFileList.remove(path);
	}

	$effect(() => {
		if (typeof window === 'undefined') return;
		return recentFileList.listen(window);
	});

	function removeRecentFile(path: string, event: MouseEvent) {
		event.stopPropagation();
		// Forgets the entry, not the document: an open tab stays open, the way
		// "Remove from Recently Opened" works in VS Code.
		deleteRecentFile(path);
	}

	async function canCloseTab(tabId: string): Promise<boolean> {
		return documentSession.canCloseTab(tabId);
	}

	// `viewMode.pendingEditReveal`, spent the moment the editor exists.
	$effect(() => {
		const range = viewMode.pendingEditReveal;
		if (!range || !editorPane) return;

		viewMode.pendingEditReveal = null;
		editorPane.revealSourceRange(range.startLine, range.endLine);
	});

	/**
	 * This document's two line numberings, and the only thing that converts
	 * between them.
	 *
	 * `data-sourcepos` counts from the first line of the BODY, because that is
	 * what `renderMarkdownPreview` hands comrak — front matter is stripped
	 * first. The editor holds the whole file. The shift between the two used to
	 * be spelled out by hand at each of the five places they meet, and a place
	 * that forgot it landed every jump that many lines early — which the outline
	 * did for as long as it existed. `lineCoordinates.ts` owns the shift now,
	 * and the two numberings are different TYPES, so a crossing that forgets to
	 * convert no longer compiles.
	 *
	 * Derived from `rawContent`, which is the buffer: measuring the render would
	 * answer 0 forever, since the render is what the front matter was stripped
	 * out of.
	 */
	let lineCoords = $derived(lineCoordinates(rawContent));

	async function saveContentAs(): Promise<boolean> {
		return documentSession.saveContentAs();
	}

	let activeExternalChangeConflict = $derived(
		tabManager.activeTabId ? hasExternalChangeConflict(tabManager.activeTabId) : false,
	);

	$effect(() => externalChange.closeStaleComparison());

	/**
	 * Auto-save effect.
	 *
	 * Watches every tab in the tab manager. For each tab that is dirty, has a
	 * non-empty path (untitled files require an explicit Save dialog), and is
	 * currently editable (edit-mode or split-mode), arms a per-tab debounce
	 * timer that calls saveSilently(tabId) when the typing pause exceeds
	 * AUTO_SAVE_DEBOUNCE_MS.
	 *
	 * Per-tab timers (instead of a single timer keyed off the active tab) mean
	 * a dirty background tab can still be flushed without the user revisiting
	 * it — typical scenario when you switch tabs mid-edit.
	 *
	 * If `settings.autoSave` flips to false at runtime, all pending timers are
	 * cancelled and a manual Cmd+S becomes the only path again.
	 */
	$effect(() => {
		// With auto-save off, only Cmd+S and the close dialog save, so drop
		// every armed timer.
		if (!settings.autoSave) {
			untrack(() => {
				for (const t of autoSaveTimers.values()) clearTimeout(t);
				autoSaveTimers.clear();
				lastContentRefByTab.clear();
			});
			return;
		}

		// Reactive reads — every keystroke flows through updateTabRawContent,
		// which assigns a new immutable string to `tab.rawContent`. Capturing
		// the reference here triggers re-runs on any edit (including
		// same-length ones like overwrite or formatting toggles).
		const snapshot = tabManager.tabs.map((tab) => ({
			id: tab.id,
			path: tab.path,
			isDirty: tab.isDirty,
			editable: tab.isEditing || tab.isSplit,
			contentRef: tab.rawContent,
			// Reactive too: clearing a conflict re-arms the timer on the next
			// keystroke, so answering the bar resumes normal auto-save.
			hasPendingConflict: hasExternalChangeConflict(tab.id),
			// Reactive as well, and that is the point: "Save As" to a new file
			// clears the flag, so the tab becomes eligible again on the next
			// pass without anything having to remember to re-arm it.
			decodedLossily: tab.hasReplacementChars,
		}));

		untrack(() => {
			const seenIds = new Set<string>();
			for (const s of snapshot) {
				seenIds.add(s.id);
				const eligible = isAutoSaveEligible(s, documentSession.isLossySaveRefused);
				const prevRef = lastContentRefByTab.get(s.id);
				const refChanged = prevRef !== s.contentRef;

				if (!eligible) {
					// Tab is no longer dirty / editable / has a path — drop
					// any pending timer and forget its tick.
					const existing = autoSaveTimers.get(s.id);
					if (existing) {
						clearTimeout(existing);
						autoSaveTimers.delete(s.id);
					}
					lastContentRefByTab.delete(s.id);
					continue;
				}

				if (!refChanged && autoSaveTimers.has(s.id)) {
					// Eligible but no new edit AND a timer is already armed —
					// leave it alone so background tabs don't get their
					// debounce reset by foreground typing.
					continue;
				}

				// Either content changed, or the tab just became eligible
				// (e.g. user pressed Save As). (Re)arm the debounce.
				const existing = autoSaveTimers.get(s.id);
				if (existing) clearTimeout(existing);
				lastContentRefByTab.set(s.id, s.contentRef);
				const timer = setTimeout(() => {
					autoSaveTimers.delete(s.id);
					// `saveSilently` resolves false on failure instead of
					// rejecting, so failures are surfaced here.
					saveSilently(s.id).then(
						(ok) => {
							if (!ok) {
								console.error('Auto-save failed for tab', s.id);
								if (!autoSaveFailureNeedsToast(s.id, { isLossySaveRefused: documentSession.isLossySaveRefused, hasExternalChangeConflict })) return;
								addToast(
									t('toast.autoSaveFailed', settings.language),
									'error',
								);
							}
						},
						(e) => {
							console.error('Auto-save threw for tab', s.id, e);
							addToast(
								t('toast.autoSaveFailed', settings.language),
								'error',
							);
						},
					);
				}, AUTO_SAVE_DEBOUNCE_MS);
				autoSaveTimers.set(s.id, timer);
			}
			// Tabs that were closed: drop their timers and tick records.
			for (const id of [...autoSaveTimers.keys()]) {
				if (!seenIds.has(id)) {
					clearTimeout(autoSaveTimers.get(id)!);
					autoSaveTimers.delete(id);
				}
			}
			for (const id of [...lastContentRefByTab.keys()]) {
				if (!seenIds.has(id)) lastContentRefByTab.delete(id);
			}
		});
	});

	async function exportAsHtml() {
		const tab = tabManager.activeTab;
		const result = await _exportHtml(
			exportContextFrom(settings, {
				rawContent,
				tabTitle: tab?.title || '',
				tabPath: tab?.path || '',
				// The exported page carries the appearance it was made in (see
				// `exportThemeAttribute`), and Mermaid bakes its theme into the SVG,
				// so the diagrams have to be rendered for the same appearance.
				mermaidTheme: currentMermaidTheme(),
			}),
		);
		if (result?.missingImages) {
			addToast(
				t('toast.exportedHtmlMissingImages', settings.language).replace(
					'{{count}}',
					String(result.missingImages),
				),
				'warning',
			);
		}
		if (result?.path) {
			const openResult = await askToOpenExportedFile(result.path, 'HTML', {
				ask,
				openPath,
				labels: {
					title: t('modal.openExportedFileTitle', settings.language),
					message: t('modal.openExportedHtmlMessage', settings.language),
				},
				onError: (error) => {
					console.error('Failed to open exported HTML file', result.path, error);
				},
			});
			if (openResult === 'failed') {
				addToast(t('toast.openExportedFileFailed', settings.language), 'error');
			}
		}
	}

	// One export at a time: a second would refill `#print-root` under the first.
	let pdfExporting = false;
	async function exportAsPdf() {
		// The gate belongs here rather than at each caller: the menu hides its
		// item behind the same condition, but the chord reaches this function
		// through two different layers — the document handler in reading mode
		// and the editor's own action in edit mode — and a guard on one of them
		// still printed a blank page from the other (#673).
		if (!hasExportableDocument(tabManager.activeTab?.rawContent)) return;
		const tab = tabManager.activeTab;
		if (!printRootEl || pdfExporting) return;
		pdfExporting = true;
		let progressToast: string | null = null;
		let path: string | null = null;
		try {
			// The same context the HTML export is given: the PDF is now rendered
			// from the buffer through the same path, so neither the preview's
			// state nor the window's has anything to do with what prints (#668).
			path = await _exportPdf({
				...exportContextFrom(settings, {
					rawContent,
					tabTitle: tab?.title || '',
					tabPath: tab?.path || '',
					mermaidTheme: currentMermaidTheme(),
				}),
				osType: settings.osType,
				printRoot: printRootEl,
				onStart: () => {
					progressToast = addToast(t('toast.exportingPdf', settings.language), 'info', true);
				},
			});
		} catch (error) {
			console.error('Failed to export PDF', error);
			addToast(t('toast.exportPdfFailed', settings.language), 'error');
		} finally {
			if (progressToast) removeToast(progressToast);
			pdfExporting = false;
		}
		if (!path) return;
		const openResult = await askToOpenExportedFile(path, 'PDF', {
			ask,
			openPath,
			labels: {
				title: t('modal.openExportedFileTitle', settings.language),
				message: t('modal.openExportedPdfMessage', settings.language),
			},
			onError: (error) => {
				console.error('Failed to open exported PDF file', path, error);
			},
		});
		if (openResult === 'failed') {
			addToast(t('toast.openExportedFileFailed', settings.language), 'error');
		}
	}

	function handleNewFile() {
		tabManager.addNewTab();
		showHome = false;
	}

	function openWithSystem(path: string) {
		return openPathWithSystem(path, {
			isLaunchable: (p) => invoke<boolean>('is_launchable_path', { path: p }),
			reveal: (p) => invoke('open_file_folder', { path: p }),
			openPath,
			revealed: (p) => addToast(t('toast.launchableLinkRevealed', settings.language).replace('{{target}}', p), 'info'),
			openFailed: (p) => addToast(t('toast.openFailed', settings.language).replace('{{target}}', p), 'error'),
		});
	}

	async function selectFolder() {
		const selected = await open({ directory: true, multiple: false });
		if (typeof selected === 'string') await folderManager.open(selected);
	}

	function openFolderEntry(entry: FolderEntry, openable: boolean) {
		if (openable) {
			showHome = false;
			void loadMarkdown(entry.path);
		} else {
			void openWithSystem(entry.path);
		}
	}

	async function selectFile() {
		const selected = await open({
			multiple: true,
			filters: MARKDOWN_OPEN_FILTERS,
		});
		if (!selected) return;
		const paths = Array.isArray(selected) ? selected : [selected];
		for (const path of paths) await loadMarkdown(path);
	}

	function toggleHome() {
		showHome = !showHome;
	}

	async function closeFile() {
		if (!tabManager.activeTabId) {
			await destroyWindowAfterTabsClosed();
			return;
		}

		await closeTabAndWindowIfLast(tabManager.activeTabId);
	}

	async function closeTabsWithConfirmation(tabIds: string[]) {
		for (const tabId of tabIds) {
			if (!(await canCloseTab(tabId))) return;
			tabManager.closeTab(tabId);
		}
	}

	/**
	 * Close the tag's files and leave an empty window on Home. The pin is saved
	 * first, so a pinned tag keeps its files and can be reopened from Home or
	 * the app menu. A dirty tab the user keeps open keeps the tag too.
	 */
	async function closeWindowTag() {
		await savePinnedTagIfNeeded();
		await closeTabsWithConfirmation(tabManager.tabs.map((tab) => tab.id));
		if (tabManager.tabs.length === 0) tabManager.setWindowTag(null);
	}

	async function openFileLocation() {
		if (currentFile) await invoke('open_file_folder', { path: currentFile });
	}

	function toggleLiveMode() {
		liveMode = !liveMode;
	}

	async function saveImageAs(src: string) {
		await saveImageAsFile(src, {
			save,
			copyFile: (from, dest) => invoke('copy_file', { src: from, dest }),
			toast: addToast,
			language: settings.language,
		});
	}

	async function saveDiagramAs(container: HTMLElement) {
		const svg = container.querySelector('svg')?.outerHTML;
		if (!svg) return;
		const dest = await save({ 
			defaultPath: 'diagram.svg',
			filters: [{ name: 'SVG Image', extensions: ['svg'] }]
		});
		if (dest) {
			try {
				await invoke('save_file_content', { path: dest, content: svg, encoding: 'UTF-8' });
				addToast(t('toast.diagramSavedAsSVG', settings.language));
			} catch (e) {
				addToast(`${t('toast.failedToSaveDiagram', settings.language)}: ${e}`, 'error');
			}
		}
	}

	/**
	 * Cut, Copy and Paste for the editor pane.
	 *
	 * Markpad draws this rather than letting Monaco draw its own, because
	 * Monaco's Paste reads the clipboard through the webview and cannot work
	 * here (#207) — see `contextmenu: false` in Editor.svelte for the whole of
	 * that reasoning. Each item runs the same function its keyboard shortcut
	 * runs, so there is one implementation per operation rather than one per
	 * entry point.
	 *
	 * Cut and Copy are always enabled: with nothing selected they take the
	 * current line, which is what ⌘X and ⌘C already do here.
	 */
	function showEditorContextMenu(e: MouseEvent) {
		if (!editorPane) return;
		e.preventDefault();

		docContextMenu = {
			show: true,
			x: e.clientX,
			y: e.clientY,
			items: editorContextMenuItems(() => editorPane, settings.language, settings.osType),
		};
	}

	/**
	 * The preview's copy: plain text plus HTML, from `copyableFlavours`.
	 * Cancelling the native copy stops WebKit from also writing a WebArchive,
	 * which measured 19 MB under `tauri dev` (#549). Text fields and Monaco's
	 * hidden textarea are skipped: `getSelection()` cannot read their
	 * selection, so cancelling there would copy an empty string.
	 */
	function handleCopy(e: ClipboardEvent) {
		handlePreviewCopy(e, currentFile);
	}

	function handleContextMenu(e: MouseEvent) {
		const menu = contextMenuFor(e.target as HTMLElement, { modalOpen: modalState.show, inApp: mode === 'app' });
		if (menu === 'editor') {
			showEditorContextMenu(e);
			return;
		}
		if (menu !== 'document') return;
		e.preventDefault();

		const selection = window.getSelection();
		const hasSelection = selection ? selection.toString().length > 0 : false;
		const link = (e.target as HTMLElement).closest('a') as HTMLAnchorElement | null;
		const linkTarget = link ? getRelativeMarkdownTarget(link.getAttribute('href') || '') : null;
		const linkItems: ContextMenuItem[] =
			linkTarget && resolveMarkdownTargetPath(currentFile, linkTarget)
				? [
						{ label: t('menu.openInNewTab', settings.language), onClick: () => openMarkdownTargetInNewTab(linkTarget) },
						{ separator: true },
					]
				: [];

		const heading = (e.target as HTMLElement).closest('h1, h2, h3, h4, h5, h6');
		let copyRefItem: any[] = [];
		if (heading) {
			const text = headingText(heading);
			const slug = headingSlug(heading);
			copyRefItem = [
				{ label: t('menu.copyReference', settings.language), onClick: () => copyHeadingReference(text, slug) },
				{ separator: true },
			];
		}

		let mediaItems: any[] = imageMenuItems(e.target as HTMLElement, settings.language, saveImageAs);

		// Resolved now: see `editSourceRangeAt`.
		const editAtTarget = editSourceRangeAt(e);

		// Read now for the same reason: the click on the item clears the selection.
		const selected = canAnnotate && settings.previewAnnotations ? selectionAnnotation() : null;
		const selectedText = selected ? occurrenceText() : null;
		const hit = !canAnnotate || !settings.previewAnnotations ? [] : selected ? overlapping(activeAnnotations, selected) : (() => {
			const at = annotationPointAt(e);
			return at ? hitAt(activeAnnotations, at) : [];
		})();
		// The highlights reading the same as the one clicked, when there is more than it.
		const textOf = (mark: Annotation) => (previewBlocks && rangeOf(previewBlocks, mark, readRendererLine)?.toString()) ?? null;
		const hitText = hit.length === 1 ? textOf(hit[0]) : null;
		const sameText = hitText ? activeAnnotations.filter((mark) => textOf(mark) === hitText) : [];
		const annotationItems: ContextMenuItem[] = hit.length
			? [{ label: t('menu.removeTemporaryHighlight', settings.language), onClick: () => {
				setAnnotations(activeAnnotations.filter((mark) => !hit.includes(mark)));
				window.getSelection()?.removeAllRanges();
			} }, ...(sameText.length > 1 ? [{ label: t('menu.removeTemporaryHighlightAll', settings.language), onClick: () => {
				setAnnotations(activeAnnotations.filter((mark) => !sameText.includes(mark)));
				window.getSelection()?.removeAllRanges();
			} }] : [])]
			: selected
				? [{ label: t('menu.temporaryHighlight', settings.language), onClick: () => {
					setAnnotations([...activeAnnotations, selected]);
					window.getSelection()?.removeAllRanges();
				} }, ...(selectedText ? [{ label: t('menu.temporaryHighlightAll', settings.language), onClick: () => {
					setAnnotations([...activeAnnotations, ...occurrenceAnnotations(selectedText)]);
					window.getSelection()?.removeAllRanges();
				} }] : [])]
				: [];

		const mermaidDiag = (e.target as HTMLElement).closest('.mermaid-diagram');
		if (mermaidDiag) {
			mediaItems = [
				{ label: t('menu.saveDiagramAsSvg', settings.language), onClick: () => saveDiagramAs(mermaidDiag as HTMLElement) },
				{ separator: true }
			];
		}

		docContextMenu = {
			show: true,
			x: e.clientX,
			y: e.clientY,
			items: [
				...linkItems,
				...copyRefItem,
				...mediaItems,
				...(hasSelection ? [{ label: t('menu.copy', settings.language), onClick: () => {
					const selection = window.getSelection()?.toString();
					if (selection) invoke('clipboard_write_text', { text: selection });
				} }] : []),
				...annotationItems,
				{ label: t('menu.selectAll', settings.language), onClick: () => {
					// The document on screen. Selecting the article would select
					// every open tab's text, including the hosts that are hidden.
					if (!previewBlocks) return;
					const range = document.createRange();
					range.selectNodeContents(previewBlocks);
					const selection = window.getSelection();
					selection?.removeAllRanges();
					selection?.addRange(range);
				} },
				{ separator: true },
				{ label: t('menu.openFileLocation', settings.language), onClick: openFileLocation, disabled: !currentFile },
				{ label: t('menu.edit', settings.language), onClick: editAtTarget },
				{ separator: true },
				{ label: t('menu.closeFile', settings.language), onClick: closeFile },
			],
		};
	}

	// HTML links only: an SVG `<a>` (inside a diagram) is not handled.
	function linkAt(target: EventTarget | null): HTMLAnchorElement | null {
		const link = target instanceof Element ? target.closest('a') : null;
		return link instanceof HTMLAnchorElement ? link : null;
	}

	function handleMouseOver(event: MouseEvent) {
		if (mode !== 'app') return;
		const anchor = linkAt(event.target);
		if (!anchor) return;
		const label = linkTooltipFor(anchor, { findAnchorTarget, footnoteRoot: previewBlocks });
		if (label) {
			const rect = anchor.getBoundingClientRect();
			tooltip = { show: true, ...label, shortcut: '', x: rect.left + rect.width / 2, y: rect.top - 8, align: 'top' };
		}
	}

	function handleMouseOut(event: MouseEvent) {
		if (linkAt(event.target)) tooltip.show = false;
	}

	async function handleDocumentClick(event: MouseEvent) {
		if (mode !== 'app') return;
		const anchor = linkAt(event.target);
		if (!anchor) return;
		await followDocumentLink(event, anchor, {
			currentFile,
			openHere: openRelativeMarkdownTarget,
			openWithSystem,
			openUrl,
			openFailed: (rawHref) => addToast(t('toast.openFailed', settings.language).replace('{{target}}', rawHref), 'error'),
		});
	}

	function handleWheel(e: WheelEvent) {
		if (e.ctrlKey || e.metaKey) {
			settings.zoomBy(wheelZoomFactor(e.deltaY));
		}
	}

	let previewRenderRevision = 0;

	$effect(() => {
		const tab = tabManager.activeTab;
		const renderRevision = ++previewRenderRevision;
		if (tab && refreshesPreviewCache(tab, isEditing, settings.showToc)) {
			const tabId = tab.id;
			const rawContent = tab.rawContent;
			if (tab.previewedRawContent === rawContent) return;

			// 120ms: above the gap between keys in a fast burst (60-80ms), so a
			// word costs one render, and below the pause before a reader looks at
			// the preview.
			const timer = setTimeout(() => {
				renderMarkdownPreview(rawContent)
					.then((rendered) => {
						const currentTab = tabManager.activeTab;
						if (
							previewRenderRevision !== renderRevision ||
							tabManager.activeTabId !== tabId ||
							currentTab?.rawContent !== rawContent
						) return;
						tabManager.updateTabContent(tabId, rendered);
						currentTab.previewedRawContent = rawContent;
						// No `tick().then(renderRichContent)`: the new content is a
						// dependency of the patch effect, which patches the blocks
						// that changed and enriches exactly those. Calling it from
						// here as well would re-run the whole document — the work
						// this path exists to stop doing.
					})
					.catch(console.error);
			}, 120);

			return () => clearTimeout(timer);
		}
	});

	// Lazy restore: a restored tab is read when it is first shown (`Tab.unread`).
	$effect(() => {
		if (tabManager.activeTab?.unread) untrack(() => void documentSession.readActiveIfUnread());
	});

	/*
	 * `viewerKeymap.ts` decides which command a keystroke means. This maps each
	 * command to the function that runs it. Every command is preventDefaulted
	 * here. An unbound chord, macOS ⌘Q, or Mod+F inside Monaco comes back null
	 * and is not prevented.
	 */
	function keyContext(): KeyContext {
		const active = document.activeElement as Node | null;
		return {
			mode,
			osType: settings.osType,
			isSplit: !!tabManager.activeTab?.isSplit,
			overlayOpen: showSettings || modalState.show || promptModal.show || showHome,
			dialogOpen: modalState.show || promptModal.show,
			isEditing,
			editorHasFocus: !!editorPaneEl && !!active && editorPaneEl.contains(active),
		};
	}

	const viewerCommands = viewerCommandTable({
		settings,
		tabManager,
		reloadFromDisk,
		carryActiveTabToNextWindow,
		closeFile,
		handleNewFile,
		openNewWindow,
		selectFile,
		appExit,
		toggleSplitView,
		toggleLiveMode,
		toggleEditView,
		saveContentAs,
		saveActiveTab,
		handleUndoCloseTab,
		navigateFileHistory,
		openSettings: () => (showSettings = true),
		toggleHome,
		exportAsPdf,
		openFileLocation,
		triggerFindAction,
	});

	function runViewerCommand(command: ViewerCommand) {
		viewerCommands[command]();
	}

	/*
	 * The macOS menu bar. The focused window installs its own, so every click
	 * lands here. Rebuilt whenever what it shows changes, and after every click:
	 * AppKit flips a check item itself, and a click that changes nothing (one
	 * the dialog guard below refuses) would otherwise leave its mark wrong.
	 */
	let menuRevision = $state(0);
	// `isFocused` starts out true; the menu waits for the real answer.
	let focusKnown = $state(false);
	let titleBar = $state<{ openTagEditor: () => void } | undefined>();

	$effect(() => {
		if (settings.osType !== 'macos' || !focusKnown || !isFocused) return;
		void menuRevision;
		const model = buildMenuModel({
			language: settings.language,
			viewMode: activeTab ? viewModeOf(activeTab) : null,
			liveMode,
			hasEditorPane,
			showToc: settings.showToc,
			showTabs: settings.showTabs,
			showEditorToolbar: settings.showEditorToolbar,
			previewFullWidth: settings.previewFullWidth,
		});
		void installAppMenu(model, runMenuAction, () => isFocused);
	});

	function runMenuAction(action: MenuAction) {
		menuRevision++;
		if ('viewer' in action && action.viewer === 'app-exit') return void appExit();
		// A dialog leaves its chords unprevented, so they reach the menu.
		const context = keyContext();
		if (context.mode !== 'app' || context.dialogOpen) return;
		if ('viewer' in action) return runViewerCommand(action.viewer);
		if ('editor' in action) return editorPane?.runEditorAction(action.editor);
		switch (action.app) {
			case 'check-updates':
				return updateStore.openDialog();
			case 'open-folder':
				return void selectFolder();
			case 'close-folder':
				return void folderManager.close();
			case 'export-html':
				return void exportAsHtml();
			case 'toggle-toc':
				settings.showToc = !settings.showToc;
				return;
			case 'toggle-editor-toolbar':
				settings.showEditorToolbar = !settings.showEditorToolbar;
				return;
			case 'toggle-full-width':
				settings.previewFullWidth = !settings.previewFullWidth;
				return;
			case 'merge-windows':
				return void mergeAllWindowsHere();
			case 'set-window-tag':
				return titleBar?.openTagEditor();
		}
	}

	function handleKeyDown(e: KeyboardEvent) {
		dispatchViewerKey(e, keyContext(), runViewerCommand);
	}

	async function navigateFileHistory(direction: 'back' | 'forward') {
		const activeTabId = tabManager.activeTabId;
		if (!activeTabId) return;
		if (!(await canCloseTab(activeTabId))) return;

		const path = direction === 'back'
			? tabManager.goBack(activeTabId)
			: tabManager.goForward(activeTabId);

		if (path) {
			// No `resetScrollHistory` here: goBack/goForward repoint the tab, so
			// `clearReadingPosition` has already dropped its in-page stacks along
			// with the rest of the position.
			await loadMarkdown(path, { skipTabManagement: true });
		}
	}

	// The in-page jump stacks belong to the tab the offsets were measured in —
	// see `Tab.scrollHistory`. These three wrappers exist only to name that tab
	// and to read the offset off the preview, which the store cannot see.
	function pushScrollHistory() {
		if (markdownBody && tabManager.activeTabId) {
			tabManager.pushScrollHistory(tabManager.activeTabId, markdownBody.scrollTop);
		}
	}

	/**
	 * Where an in-page back/forward would land, or null if this tab has no jump
	 * to walk — the caller then falls through to the FILE history.
	 */
	function popScrollHistory(direction: 'back' | 'forward'): number | null {
		if (!markdownBody || !tabManager.activeTabId) return null;
		return direction === 'back'
			? tabManager.popScrollHistoryBack(tabManager.activeTabId, markdownBody.scrollTop)
			: tabManager.popScrollHistoryForward(tabManager.activeTabId, markdownBody.scrollTop);
	}

	async function handleMouseUp(e: MouseEvent) {
		if (e.button !== 3 && e.button !== 4) return;
		const direction = e.button === 3 ? 'back' : 'forward';
		e.preventDefault();
		// In-page scroll history first; only a tab with no jump left to undo
		// moves to another document.
		const pos = popScrollHistory(direction);
		if (pos !== null && markdownBody) {
			isProgrammaticScroll = true;
			markdownBody.scrollTo({ top: pos, behavior: jumpBehavior });
		} else {
			await navigateFileHistory(direction);
		}
	}

	async function handleUndoCloseTab() {
		const path = tabManager.popRecentlyClosed();
		if (path) {
			await loadMarkdown(path);
		}
	}

	async function carryActiveTabToNextWindow() {
		const activeId = tabManager.activeTabId;
		if (!activeId) return;
		const windows = (await invoke('list_viewer_windows')) as Array<{ label: string; number: number }>;
		const ordered = windows.slice().sort((a, b) => a.number - b.number);
		const selfIndex = ordered.findIndex((window) => window.label === appWindow.label);
		if (selfIndex === -1 || ordered.length === 1) {
			await handleDetach(activeId);
			return;
		}
		await moveTabToWindow(activeId, ordered[(selfIndex + 1) % ordered.length].label, true);
	}

	async function mergeAllWindowsHere() {
		const windows = (await invoke('list_viewer_windows')) as Array<{ label: string }>;
		const others = windows.filter((window) => window.label !== appWindow.label);
		if (others.length === 0) {
			addToast(t('toast.noOtherWindows', settings.language), 'info');
			return;
		}
		await Promise.all(others.map((window) => emitTo(window.label, 'merge-into', appWindow.label)));
	}

	function startDrag(e: MouseEvent, tabId: string | null) {
		if (!tabId) return;
		e.preventDefault();
		const startX = e.clientX;
		const tab = tabManager.tabs.find((t) => t.id === tabId);
		if (!tab) return;

		const startRatio = tab.splitRatio ?? 0.5;
		const containerWidth = window.innerWidth;

		const onMove = (moveEvent: MouseEvent) => {
			tabManager.setSplitRatio(
				tabId,
				splitRatioAfterDrag(startRatio, startX, moveEvent.clientX, containerWidth, settings.splitEditorSide),
			);
		};

		const onUp = () => {
			window.removeEventListener('mousemove', onMove);
			window.removeEventListener('mouseup', onUp);
			document.body.style.cursor = '';
		};

		window.addEventListener('mousemove', onMove);
		window.addEventListener('mouseup', onUp);
		document.body.style.cursor = 'col-resize';
	}

	function startTocResize(e: PointerEvent) {
		e.preventDefault();
		const target = e.currentTarget as HTMLElement;
		target.setPointerCapture?.(e.pointerId);

		const startX = e.clientX;
		const startWidth = settings.tocWidth;
		const side = settings.tocSide;
		isTocResizing = true;
		document.body.style.cursor = 'col-resize';
		document.body.style.userSelect = 'none';

		const onMove = (moveEvent: PointerEvent) => {
			const deltaX = moveEvent.clientX - startX;
			const widthDelta = side === 'left' ? deltaX : -deltaX;
			settings.setTocWidth(startWidth + widthDelta);
		};

		const onUp = (upEvent: PointerEvent) => {
			window.removeEventListener('pointermove', onMove);
			window.removeEventListener('pointerup', onUp);
			window.removeEventListener('pointercancel', onUp);
			try {
				target.releasePointerCapture?.(upEvent.pointerId);
			} catch {
				// Pointer capture may already be gone after a cancel path.
			}
			document.body.style.cursor = '';
			document.body.style.userSelect = '';
			isTocResizing = false;
		};

		window.addEventListener('pointermove', onMove);
		window.addEventListener('pointerup', onUp);
		window.addEventListener('pointercancel', onUp);
	}

	onMount(() => {
		loadRecentFiles();
		isDisposed = false;

		let unlisteners: (() => void)[] = [];

			invoke('show_window').catch(console.error);

			const init = async () => {
				const appWindow = getCurrentWindow();
				if (isDisposed) return;
				// Before the restore below: the macOS menu follows focus from here on.
				unlisteners.push(
					await appWindow.onFocusChanged(({ payload: focused }) => {
						isFocused = focused;
						if (!focused) windowSession.checkpoint();
					}),
				);
				isFocused = await appWindow.isFocused();
				focusKnown = true;

			const restoredOwnState = await windowSession.restore();
			if (isDisposed) return;
			void folderManager.restore(restoredFolder);
			// After this window's own restore, which discards every snapshot when
			// restore is off. Only the first window of a launch reopens anything.
			if (settings.restoreStateOnReopen) {
				await invoke('reopen_remembered_windows').catch((error) => console.error('Failed to reopen windows', error));
			}
			if (settings.persistOpenEditors) await restoreUnsavedChanges();
			if (isDisposed) return;
			// A reopened window's snapshot owns its tabs, a pinned one's included:
			// opening the pinned group as well would open its files twice.
			if (!restoredOwnState) {
				const pinnedName = pinnedTagFromWindowLabel(appWindow.label);
				if (pinnedName === null) await windowSession.claimTransferredTab();
				else {
					const tags = (await invoke('list_pinned_tags')) as typeof pinnedTags;
					const tag = tags.find((pinned) => pinned.name === pinnedName);
					if (tag) await openPinnedTag(tag);
				}
			}
			windowMeta.markReady();
			if (isDisposed) return;

			const urlParams = new URLSearchParams(window.location.search);

			const fileParam = urlParams.get('file');
			if (fileParam) {
				const decodedPath = decodeURIComponent(fileParam);
				if (isDisposed) return;
				await loadMarkdown(decodedPath);
				if (isDisposed) return;
			}

			const checkpointWhenHidden = () => {
				if (document.visibilityState === 'hidden') windowSession.checkpoint();
			};
			document.addEventListener('visibilitychange', checkpointWhenHidden);
			unlisteners.push(() => document.removeEventListener('visibilitychange', checkpointWhenHidden));
			unlisteners.push(
				await appWindow.listen('file-changed', (event) => externalChange.handleFileChanged(event.payload as string, liveMode)),
			);

			const listeners: [string, EventCallback<any>][] = [
				['file-path', (event) => {
					const filePath = event.payload as string;
					if (filePath) loadMarkdown(filePath);
				}],
				['menu-tab-rename', async (event) => {
					const tabId = event.payload as string;
					const tab = tabManager.tabs.find((t) => t.id === tabId);
					if (!tab || !tab.path) return;

					const newName = await promptCustom(t('menu.renameFile', settings.language), {
						title: t('menu.rename', settings.language),
						initial: tab.title,
					});
					if (newName && newName !== tab.title) {
						const oldPath = tab.path;
						const newPath = oldPath.replace(/[/\\][^/\\]+$/, (m) => m.charAt(0) + newName);
						try {
							await documentSession.renameFile(tabId, newPath);
							recentFileList.rename(oldPath, newPath);
						} catch (e) {
							console.error('Failed to rename file', e);
							await askCustom(`Failed to rename file: ${e}`, { title: 'Error', kind: 'error' });
						}
					}
				}],
				['menu-tab-new', () => {
					tabManager.addNewTab();
				}],
				['menu-tab-undo', () => {
					handleUndoCloseTab();
				}],
				['menu-tab-close', async (event) => {
					const tabId = event.payload as string;
					await closeTabAndWindowIfLast(tabId);
				}],
				['menu-tab-detach', (event) => {
					handleDetach(event.payload as string);
				}],
				['menu-tab-move', (event) => {
					const { tabId, targetLabel } = event.payload as { tabId: string; targetLabel: string };
					moveTabToWindow(tabId, targetLabel).catch((error) => console.error('Failed to move tab', error));
				}],
				['tab-transfer-offer', (event) => {
					if (windowExit.isCloseWalkActive()) return;
					windowSession.acceptOfferedTransfer(event.payload);
				}],
				['merge-into', (event) => {
					mergeSelfInto(event.payload).catch((error) => console.error('Failed to merge window', error));
				}],
				['window-identify', (event) => {
					identifyFlash = event.payload;
					clearTimeout(identifyFlashTimer);
					identifyFlashTimer = setTimeout(() => (identifyFlash = ''), 700);
				}],
				['menu-tab-close-others', async (event) => {
					const tabId = event.payload as string;
					const tabsToClose = tabManager.tabs.filter((t) => t.id !== tabId).map((t) => t.id);
					await closeTabsWithConfirmation(tabsToClose);
				}],
				['menu-tab-close-right', async (event) => {
					const tabId = event.payload as string;
					const index = tabManager.tabs.findIndex((t) => t.id === tabId);
					if (index !== -1) {
						const tabsToClose = tabManager.tabs.slice(index + 1).map((t) => t.id);
						await closeTabsWithConfirmation(tabsToClose);
					}
				}],
			];
			for (const [event, handler] of listeners) unlisteners.push(await appWindow.listen(event, handler));
			unlisteners.push(
				await appWindow.onCloseRequested(windowExit.handleCloseRequested),
			);

			unlisteners.push(
				await appWindow.onDragDropEvent((event) => {
					if (event.payload.type === 'enter' || event.payload.type === 'over') {
						const { x, y } = event.payload.position;
						isDragging = true;
						// Only `enter` carries the paths; `over` repeats the position.
						if (event.payload.type === 'enter') dragPaths = event.payload.paths;
						
						const contains = (el: HTMLElement) => {
							const rect = el.getBoundingClientRect();
							return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
						};
						if (editorPaneEl) {
							if (contains(editorPaneEl)) {
								dragTarget = 'editor';
								if (editorPane) editorPane.updateDragCaret(x, y);
							} else {
								dragTarget = viewerPaneEl && contains(viewerPaneEl) ? 'preview' : null;
								if (editorPane) editorPane.hideDragCaret();
							}
						}
					} else if (event.payload.type === 'drop') {
						const { x, y } = event.payload.position;
						const paths = event.payload.paths;
						const currentEditor = editorPane;
						if (currentEditor) currentEditor.hideDragCaret();
						handleDrop(paths, dragTarget, !!currentEditor, {
							insert: (path) => currentEditor?.handleDroppedFile(path, x, y),
							open: (path) => loadMarkdown(path),
							unsupported: reportUnsupportedDrop,
						});
						
						isDragging = false;
						dragTarget = null;
					} else if (event.payload.type === 'leave') {
						isDragging = false;
						dragTarget = null;
						if (editorPane) editorPane.hideDragCaret();
					}
				}),
			);

			if (isDisposed) {
				unlisteners.forEach((unlisten) => unlisten());
				return;
			}

			// Startup-file delivery (argv / macOS Opened-before-ready stash).
			// Every window asks; Rust hands the launch's files out once, to the
			// launch window, so a detached window never re-opens them.
			try {
				const args: string[] = await invoke('send_markdown_path');
				if (!isDisposed && args?.length > 0) {
					await documentSession.openFiles(args);
				}
			} catch (error) {
				console.error('Error receiving Markdown file path:', error);
			}

			if (!isDisposed) mode = 'app';
		};

		init();

		return () => {
			isDisposed = true;
			unsavedRecovery.dispose();
			clearTimeout(identifyFlashTimer);
			unlisteners.forEach((u) => u());
		};
	});
</script>

<svelte:document
	onclick={handleDocumentClick}
	oncopy={handleCopy}
	oncontextmenu={handleContextMenu}
	onmouseover={handleMouseOver}
	onmouseout={handleMouseOut}
	onkeydown={handleKeyDown}
	onmouseup={handleMouseUp} />

{#if mode === 'loading'}
	<TitleBar
		bind:this={titleBar}
		{isFocused}
		isScrolled={false}
		currentFile={''}
		{liveMode}
		windowTitle="Markpad"
		showHome={false}
		zoomLevel={settings.zoomLevel}
		onnewFile={handleNewFile}
		onopenFile={selectFile}
		onopenFolder={selectFolder}
		onmergeAllWindows={mergeAllWindowsHere}
		onclosetag={closeWindowTag}
		onsaveFile={saveContent}
		onsaveFileAs={saveContentAs}
		onreloadFromDisk={reloadFromDisk}
		onexportHtml={exportAsHtml}
		onexportPdf={exportAsPdf}
		onexit={appExit}
		ontoggleHome={toggleHome}
		ononpenFileLocation={openFileLocation}
		ontoggleLiveMode={toggleLiveMode}
		onsetViewMode={setViewMode}
		onswapPanes={() => settings.toggleSplitEditorSide()}
		{isEditing}
		ontabclick={() => (showHome = false)}
		onresetZoom={() => settings.resetZoom()}
		isFullWidth={settings.previewFullWidth}
		ontoggleFullWidth={() => { settings.previewFullWidth = !settings.previewFullWidth; }}
		theme={settings.theme}
		onSetTheme={(t: string) => (settings.theme = resolveTheme(t))}
		onopenSettings={() => (showSettings = true)}
		onfind={triggerFindAction}
		oncloseTab={closeTabAndWindowIfLast} />
	<div class="loading-screen">
		<svg class="spinner" viewBox="0 0 50 50">
			<circle class="path" cx="25" cy="25" r="20" fill="none" stroke-width="4"></circle>
		</svg>
	</div>
{:else}
	<TitleBar
		bind:this={titleBar}
		{isFocused}
		{isScrolled}
		{currentFile}
		{liveMode}
		{windowTitle}
		{showHome}
		zoomLevel={settings.zoomLevel}
		onnewFile={handleNewFile}
		onopenFile={selectFile}
		onopenFolder={selectFolder}
		onmergeAllWindows={mergeAllWindowsHere}
		onclosetag={closeWindowTag}
		onsaveFile={saveContent}
		onsaveFileAs={saveContentAs}
		onreloadFromDisk={reloadFromDisk}
		onexportHtml={exportAsHtml}
		onexportPdf={exportAsPdf}
		onexit={appExit}
		ontoggleHome={toggleHome}
		ononpenFileLocation={openFileLocation}
		ontoggleLiveMode={toggleLiveMode}
		ontoggleEditorToolbar={() => { settings.showEditorToolbar = !settings.showEditorToolbar; }}
		onsetViewMode={setViewMode}
		onswapPanes={() => settings.toggleSplitEditorSide()}
		{isEditing}
		ontabclick={() => (showHome = false)}
		onresetZoom={() => settings.resetZoom()}
		{isScrollSynced}
		ontoggleSync={() => tabManager.activeTabId && tabManager.toggleScrollSync(tabManager.activeTabId)}
		isFullWidth={settings.previewFullWidth}
		ontoggleFullWidth={() => { settings.previewFullWidth = !settings.previewFullWidth; }}
		theme={settings.theme}
		onSetTheme={(t: string) => (settings.theme = resolveTheme(t))}
		onopenSettings={() => (showSettings = true)}
		onfind={triggerFindAction}
		canGoBack={canGoBackInFileHistory}
		canGoForward={canGoForwardInFileHistory}
		onback={() => navigateFileHistory('back')}
		onforward={() => navigateFileHistory('forward')}
		oncloseTab={closeTabAndWindowIfLast} />

	<Settings show={showSettings} theme={settings.theme} onSetTheme={(t) => (settings.theme = t)} onclose={() => (showSettings = false)} />

	<DiffOverlay
		show={externalChange.comparison !== null}
		onDisk={externalChange.comparison?.onDisk ?? ''}
		mine={externalChange.comparison?.mine ?? ''}
		language={externalChange.comparison?.language ?? 'markdown'}
		labels={{
			onDisk: t('externalChange.onDisk', settings.language),
			mine: t('externalChange.mine', settings.language),
			reload: t('externalChange.reload', settings.language),
			keepMine: t('externalChange.keepMine', settings.language),
			close: t('externalChange.close', settings.language),
		}}
		onclose={externalChange.closeComparison}
		onreload={() => externalChange.comparison && resolveExternalChangeByReloading(externalChange.comparison.tabId)}
		onkeep={() => externalChange.comparison && resolveExternalChangeByKeepingBuffer(externalChange.comparison.tabId)} />

	{#if sidebarSide}
		<Sidebar
			side={sidebarSide}
			showOpenFiles={tabColumnSide !== null}
			showFolder={folderShown}
			{showHome}
			ontabclick={() => (showHome = false)}
			oncloseTab={closeTabAndWindowIfLast}
			onopenEntry={openFolderEntry} />
	{/if}

	<!--
		Plain block with the tabs across the top. With a tab column (#884) it
		becomes the box the document is laid out in, inset by the column's width,
		so the absolutely positioned layout, the outline and the home page all
		measure from the column's edge without each learning about it.
	-->
	<div
		class="content-area"
		class:beside-tab-column={sidebarSide !== null}
		style:left={sidebarSide === 'left' ? `${settings.tabColumnWidth}px` : null}
		style:right={sidebarSide === 'right' ? `${settings.tabColumnWidth}px` : null}>
	{#if activeExternalChangeConflict && !showHome}
		<div class="external-change-bar" role="status" style:top="{36 + paneTopChrome}px">
			<span class="external-change-text">{t('externalChange.message', settings.language)}</span>
			<button class="external-change-action" onclick={compareExternalChange}>
				{t('externalChange.compare', settings.language)}
			</button>
			<button class="external-change-action" onclick={() => resolveExternalChangeByReloading(tabManager.activeTabId ?? '')}>
				{t('externalChange.reload', settings.language)}
			</button>
			<button class="external-change-action primary" onclick={() => resolveExternalChangeByKeepingBuffer(tabManager.activeTabId ?? '')}>
				{t('externalChange.keepMine', settings.language)}
			</button>
		</div>
	{/if}
	{#if tabManager.activeTab && !showsHomeScreen(tabManager.activeTab, showHome)}
			<div
				class="markdown-container"
				style="zoom: {hasPreviewPane ? settings.zoomLevel / 100 : 1}; --code-font: {previewAppearance.codeFontFamily}; --code-font-size: {previewAppearance.codeFontSize}px; --highlight-color: {previewAppearance.highlightColor};"
				onwheel={handleWheel}
				role="presentation">
				<div class="layout-container" 
					bind:this={layoutContainerEl}
					class:split={isSplit} 
					class:editor-on-right={isSplit && settings.splitEditorSide === 'right'} 
					class:editing={isEditing} 
					class:has-pinned-toc={isMarkdown && settings.pinnedToc && settings.showToc}
					class:toc-on-left={isMarkdown && settings.tocSide === 'left'}
					class:toc-on-right={isMarkdown && settings.tocSide === 'right'}
					class:toc-resizing={isTocResizing}
					style="--toc-width: {settings.tocWidth}px; --pane-top-chrome: {paneTopChrome}px;">
					<!-- Editor Pane -->
					<div bind:this={editorPaneEl} class="pane editor-pane" style:flex={isSplit ? tabManager.activeTab.splitRatio : null}>
						{#if hasEditorPane}
							{#if settings.showEditorToolbar}
								<div bind:clientHeight={editorToolbarHeight} transition:slide={{ duration: 150 }}>
									<EditorToolbar
										modifier={modifierFor(settings.osType)}
										toolbarOrder={settings.editorToolbarOrder}
										toolbarHidden={settings.editorToolbarHidden}
										onaction={(actionId, payload) => editorPane?.runEditorAction(actionId, payload)}
										ontoggleHide={() => { settings.showEditorToolbar = !settings.showEditorToolbar; }}
										onshowTooltip={(e, text, shortcut, align) => {
											const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
											tooltip = {
												show: true,
												text,
												shortcut: shortcut || '',
												html: '',
												isFootnote: false,
												x: align === 'right' ? rect.right + 8 : (align === 'left' ? rect.left - 8 : rect.left + rect.width / 2),
												y: align === 'below' ? rect.bottom + 8 : rect.top - 8,
												align: (align as any) || 'below'
											};
										}}
										onhideTooltip={() => (tooltip.show = false)} />
								</div>
							{/if}
							<Editor
								bind:this={editorPane}
								value={tabManager.activeTab.rawContent}
								readOnly={editorReadOnly(tabManager.activeTab)}
								language={editorLanguage}
								theme={settings.theme}
								zoomLevel={settings.zoomLevel}
								oncommand={runViewerCommand}
								onscrollsync={handleEditorScrollSync}
								oncursor={handleEditorCursor}
								sharedCursor={settings.previewCursor ? viewMode.activeCursor : null} />
						{/if}
					</div>

					<!-- Splitter -->
					{#if isSplit}
						<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
						<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
						<div class="split-bar" onmousedown={(e) => startDrag(e, tabManager.activeTabId)} onkeydown={handleSplitterKeyDown} role="separator" aria-orientation="vertical" tabindex="0"></div>
					{/if}

					<!-- Viewer Pane -->
					<div 
						bind:this={viewerPaneEl} 
						bind:clientWidth={viewerWidth}
						class="pane viewer-pane" 
						style:flex={isSplit ? 1 - tabManager.activeTab.splitRatio : null}>

						<FindBar
							bind:this={findBar}
							bind:open={findOpen}
							contentRoot={previewBlocks}
							onunfold={(key: string) => revealFold(foldHost, key)}
							language={settings.language} />

							<div class="viewer-content">
								<article
									bind:this={markdownBody}
									contenteditable="false"
									class="markdown-body {settings.previewFullWidth ? 'full-width' : ''}"
									class:toc-in-gutter={settings.showToc && !settings.pinnedToc && !isOverhanging}
									class:table-breakout={settings.previewTableBreakout}
									class:table-fit={!settings.previewTableScroll}
									class:soft-breaks={!settings.previewNewlineBreaks}
									onscroll={handleScroll}
									onclick={handleLinkClick}
									onchange={handleTaskCheckboxChange}
									onkeydown={(e) => {
										const target = e.target as HTMLElement;
										if (target.closest('.frontmatter-panel')) return;
										if(e.key === 'Enter' || e.key === ' ') handleLinkClick(e as unknown as MouseEvent);
									}}
									tabindex="-1"
									style="outline: none; font-family: {previewAppearance.fontFamily}; font-size: {previewAppearance.fontSize}px; flex: 1; --preview-max-width: {layout.maxWidthCss};">
									{#if frontMatterInfo.exists}
										<details
											class="frontmatter-panel"
											class:is-collapsed={isFrontMatterCollapsed}
											open={!isFrontMatterCollapsed}
											ontoggle={(e) => setFrontMatterCollapsed(!(e.currentTarget as HTMLDetailsElement).open)}>
											<summary class="frontmatter-summary">
												<span class="frontmatter-chevron" aria-hidden="true">›</span>
												<span class="frontmatter-title">{t('frontMatter.properties', settings.language)}</span>
												<span class="frontmatter-count">{frontMatterInfo.valid ? frontMatterInfo.fields.length : 0}</span>
											</summary>

											{#if frontMatterInfo.valid}
												<div class="frontmatter-grid">
													{#each frontMatterInfo.fields as field (field.key)}
														<label class="frontmatter-key" for={frontMatterFieldId(field.key)}>{field.key}</label>
														<div class="frontmatter-value">
															{#if field.editable}
																{#if field.kind === 'boolean'}
																	<select
																		id={frontMatterFieldId(field.key)}
																		value={String(field.value)}
																		onchange={(e) => handleFrontMatterEdit(field, (e.currentTarget as HTMLSelectElement).value)}>
																		<option value="true">true</option>
																		<option value="false">false</option>
																	</select>
																{:else if field.kind === 'list'}
																	<div class="frontmatter-tags">
																		<div class="frontmatter-tag-list" role="list" aria-label={t('frontMatter.tagList', settings.language).replace('{{field}}', field.key)}>
																			{#each getFrontMatterListItems(field) as tag, index (`${tag}-${index}`)}
																				<span class="frontmatter-tag" role="listitem">
																					{#if getFrontMatterTagEditIndex(field) === index}
																						<input
																							class="frontmatter-tag-edit-input"
																							type="text"
																							value={getFrontMatterTagEditDraft(field, tag)}
																							aria-label={t('frontMatter.editTag', settings.language).replace('{{field}}', field.key).replace('{{tag}}', tag)}
																							use:focusAndSelect
																							oninput={(e) => setFrontMatterTagEditDraft(field, (e.currentTarget as HTMLInputElement).value)}
																							onkeydown={(e) => handleFrontMatterTagEditKeydown(e, field, index)}
																							onblur={() => commitFrontMatterTagEdit(field, index)} />
																					{:else}
																						<button
																							class="frontmatter-tag-text"
																							type="button"
																							aria-label={t('frontMatter.editTag', settings.language).replace('{{field}}', field.key).replace('{{tag}}', tag)}
																							onclick={() => startFrontMatterTagEdit(field, index, tag)}>
																							{tag}
																						</button>
																						<button
																							class="frontmatter-tag-remove"
																							type="button"
																							aria-label={t('frontMatter.removeTag', settings.language).replace('{{field}}', field.key).replace('{{tag}}', tag)}
																							onclick={() => removeFrontMatterTag(field, index)}>
																							×
																						</button>
																					{/if}
																				</span>
																			{/each}
																		</div>
																		<div class="frontmatter-tag-add">
																			<input
																				id={frontMatterFieldId(field.key)}
																				type="text"
																				value={getFrontMatterTagDraft(field)}
																				placeholder={t('frontMatter.addTag', settings.language)}
																				autocomplete="off"
																				enterkeyhint="done"
																				oninput={(e) => setFrontMatterTagDraft(field, (e.currentTarget as HTMLInputElement).value)}
																				onkeydown={(e) => handleFrontMatterTagAddKeydown(e, field)} />
																			<button
																				class="frontmatter-tag-add-button"
																				type="button"
																				aria-label={t('frontMatter.addTagTo', settings.language).replace('{{field}}', field.key)}
																				onclick={() => commitFrontMatterTagAdd(field)}>
																				+
																			</button>
																		</div>
																	</div>
																{:else}
																	<input
																		id={frontMatterFieldId(field.key)}
																		type={field.kind === 'number' ? 'number' : 'text'}
																		value={field.displayValue}
																		onchange={(e) => handleFrontMatterEdit(field, (e.currentTarget as HTMLInputElement).value)} />
																{/if}
															{:else}
																<code>{field.displayValue}</code>
															{/if}
															{#if frontMatterFields.editError(field)}
																<div class="frontmatter-field-error" role="status">{frontMatterFields.editError(field)}</div>
															{/if}
														</div>
													{/each}
												</div>
											{:else}
												<div class="frontmatter-error" role="status">{frontMatterInfo.error}</div>
											{/if}

										</details>
									{/if}
									<!--
										One host per tab, all mounted, only the active one displayed:
										see `previewHosts`. The children are filled by the block patch,
										not by Svelte.

										`display`, not `visibility` or a zero height: a hidden host must
										cost no layout.
									-->
									{#each tabManager.tabs as tab (tab.id)}
										<div
											class="markdown-blocks"
											style:display={tab.id === tabManager.activeTabId ? null : 'none'}
											bind:this={previewHosts[tab.id]}></div>
									{/each}
									{#if previewCursorBox}
										<div class="preview-cursor" aria-hidden="true" style:top="{previewCursorBox.top}px" style:height="{previewCursorBox.height}px">
											{#if settings.renderLineHighlight === 'line'}
												<div class="preview-cursor-line"></div>
											{/if}
											<div class="preview-cursor-caret" style:left="{previewCursorBox.left}px"></div>
										</div>
									{/if}
								</article>
								{#if tabManager.activeTabId && loadingTabs.includes(tabManager.activeTabId) && isAtBottom}
								<div class="loading-chip" transition:fly={{ y: 20, duration: 300, easing: cubicOut }}>
									<div class="loading-spinner"></div>
									<span>{t('common.loadingFullDocument', settings.language)}</span>
								</div>
							{/if}
						</div>
					</div>

					<!-- Unified TOC Support -->
					{#if isMarkdown && !showHome}
						<div class="top-fade-mask" style="{settings.tocSide === 'left' ? 'left: 0;' : 'right: 0; left: auto;'}"></div>
						<button
							bind:this={tocToggleEl}
							class="toc-toggle-floating {settings.showToc ? 'expanded' : ''}"
							class:on-right={settings.tocSide === 'right'}
								onclick={() => { settings.showToc = !settings.showToc; }}
							aria-label={settings.showToc ? t('tooltip.hideTableOfContents', settings.language) : t('tooltip.showTableOfContents', settings.language)}
							onmouseenter={(e) => {
								const rect = e.currentTarget.getBoundingClientRect();
								tooltip = { 
									show: true, 
									text: settings.showToc ? t('tooltip.hideTableOfContents', settings.language) : t('tooltip.showTableOfContents', settings.language), 
									shortcut: '',
									html: '', 
									isFootnote: false, 
									x: settings.tocSide === 'left' ? rect.right + 8 : rect.left - 8, 
									y: rect.top + rect.height / 2,
									align: settings.tocSide === 'left' ? 'right' : 'left'
								};
							}}
							onmouseleave={() => tooltip.show = false}>
							<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
								<polyline points="9 18 15 12 9 6"></polyline>
							</svg>
						</button>

						{#if settings.showToc}
							<div
								bind:this={tocWrapperEl}
								transition:fly={{ x: settings.tocSide === 'left' ? -settings.tocWidth : settings.tocWidth, duration: 300, opacity: 1, easing: cubicOut }}
								class="toc-overlay-wrapper"
								class:is-overhanging={isOverhanging} 
								class:is-pinned={settings.pinnedToc}
								class:is-resizing={isTocResizing}
								class:on-right={settings.tocSide === 'right'}>
								<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
								<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
								<div
									class="toc-resize-handle"
									class:on-right={settings.tocSide === 'right'}
									role="separator"
									aria-label={t('toc.resizeTableOfContents', settings.language)}
									aria-orientation="vertical"
									aria-valuemin={TOC_WIDTH_RANGE.min}
									aria-valuemax={TOC_WIDTH_RANGE.max}
									aria-valuenow={settings.tocWidth}
									tabindex="0"
									onpointerdown={startTocResize}
									onkeydown={handleTocResizeKeyDown}></div>
								<Toc
									activeLine={viewMode.tocActiveLine} 
										{markdownBody} 
										contentRoot={previewBlocks}
										previewRevision={previewPatch.revision}
										onBeforeJump={pushScrollHistory} 
										{foldOverrides} 
										ontoggleFold={(key: string) => toggleFold(foldHost, key)} 
										oncopyref={(text: string, slug: string) => copyHeadingReference(text, slug)}
										onjump={(id: string, text: string, sourceLine: RendererLine | null) => {
											// A floating outline that is covering the text has done its
											// job the moment you pick an entry: it exists to be called
											// up, used once and dismissed. Pinned it is a permanent
											// sidebar and stays; not overhanging it is sitting in the
											// margin harming nothing, and closing it would take away a
											// behaviour that was already fine.
											if (tocAutoCollapses(isOverhanging, settings.pinnedToc)) settings.showToc = false;
											if (hasEditorPane && editorPane) {
												// Same renderer-to-buffer shift as the context menu: the
												// outline reads `data-sourcepos` too, and has been landing
												// short by the front matter's height for as long as both
												// have existed.
												editorPane.revealHeader(
													sourceLine === null ? null : lineCoords.toBufferLine(sourceLine),
													text,
												);
											}
										}}
										oncontext={(e, item) => {
											docContextMenu = {
												show: true,
												x: e.clientX,
												y: e.clientY,
												items: [
													{ 
														label: t('menu.copyReference', settings.language),
														onClick: () => {
															copyHeadingReference(item.text, item.id);
															docContextMenu.show = false;
														} 
													}
												]
											};
										}}
										onshowTooltip={(e, text, shortcut, align) => {
											const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
											tooltip = {
												show: true,
												text,
												shortcut: shortcut || '',
												html: '',
												isFootnote: false,
												x: align === 'right' ? rect.right + 8 : (align as any === 'left' ? rect.left - 8 : rect.left + rect.width / 2),
												y: align === 'right' || align as any === 'left' ? rect.top + rect.height / 2 : (align === 'below' ? rect.bottom + 8 : rect.top - 8),
												align: align || 'top'
											};
										}}
										onhideTooltip={() => tooltip.show = false}
								/>
							</div>
						{/if}
					{/if}
				</div>
			</div>
	{:else}
		<HomePage {recentFiles} {pinnedTags} onselectFile={selectFile} onloadFile={loadMarkdown} onremoveRecentFile={removeRecentFile} onnewFile={handleNewFile} onopenPinnedTag={openPinnedTag} onunpinTag={unpinTagFromHome} />
	{/if}
	</div>

	<div 
		class="tooltip align-{tooltip.align} {tooltip.show ? 'visible' : ''}" 
		class:footnote-tooltip={tooltip.isFootnote} 
		style="left: {tooltip.x}px; top: {tooltip.y}px;">
		{#if tooltip.isFootnote}
			{@html tooltip.html}
		{:else}
			<span class="tooltip-text">{tooltip.text}</span>
			{#if tooltip.shortcut}
				<span class="tooltip-shortcut">{tooltip.shortcut}</span>
			{/if}
		{/if}
	</div>

	<!-- Before the modals: installing runs the unsaved-tab review, whose dialogs
	     share this z-index, so they have to come later to be on top. -->
	<UpdateDialog settleForExit={settleForUpdate} />

	<Modal
		show={modalState.show}
		title={modalState.title}
		message={modalState.message}
		kind={modalState.kind}
		showSave={modalState.showSave}
		onconfirm={handleModalConfirm}
		onsave={() => closeModal('save')}
		oncancel={() => closeModal('cancel')} />

	<Modal
		show={promptModal.show}
		title={promptModal.title}
		message={promptModal.message}
		kind="info"
		showInput={true}
		bind:inputValue={promptModal.value}
		onconfirm={() => closePrompt(promptModal.value)}
		oncancel={() => closePrompt(null)} />

	{#if identifyFlash}
		<div class="identify-flash" transition:fade={{ duration: 150 }}>
			<span>{identifyFlash}</span>
		</div>
	{/if}

	<div class="toast-container">
		{#each toasts as toast (toast.id)}
			<Toast 
				message={toast.message} 
				type={toast.type} 
				sticky={toast.sticky}
				onremove={() => removeToast(toast.id)} />
		{/each}
	</div>

	{#if zoomData}
		<ZoomOverlay 
			src={zoomData.src} 
			html={zoomData.html} 
			onclose={() => zoomData = null} 
		/>
	{/if}

	{#if isDragging}
		<div class="drag-overlay" role="presentation">
			<div class="drag-zones" class:split={isSplit} class:editor-on-right={isSplit && settings.splitEditorSide === 'right'}>
				{#if hasEditorPane}
					<div class="drag-zone editor-zone" class:active={dragTarget === 'editor'}>
								<div class="drag-message">
									<span>{dropZoneLabel(dragPaths, 'editor') === 'embed' ? t('dragAndDrop.embed', settings.language) : t('dragAndDrop.open', settings.language)}</span>
								</div>
							</div>
				{/if}
				{#if isSplit || !isEditing}
					<div class="drag-zone viewer-zone" class:active={dragTarget === 'preview'}>
								<div class="drag-message">
									<span>{t('dragAndDrop.open', settings.language)}</span>
								</div>
							</div>
				{/if}
			</div>
		</div>
	{/if}
{/if}

<ContextMenu {...docContextMenu} onhide={() => (docContextMenu.show = false)} />

<!-- What a PDF is rendered from: empty on screen, filled for the duration of a
     print by `exportAsPdf`. It is a sibling of the app's own markup so that the
     print sheet can hide everything else under `#app` in one rule, rather than
     naming each part of the interface (#668). -->
<article id="print-root" class="markdown-body" bind:this={printRootEl}></article>

<style>
	:root {
		scroll-behavior: smooth !important;
		background-color: var(--color-canvas-default);
	}

	:global(body) {
		background-color: var(--color-canvas-default);
		margin: 0;
		padding: 0;
		color: var(--color-fg-default);
		overflow: hidden;
	}

	/*
	 * The article is the scroller, so anything it clips cannot be wider than it.
	 * It fills the pane and its padding centres the text column instead of a
	 * `max-width` doing so; that leaves the side margins inside the article for
	 * a wide table to extend into (#811).
	 */
	.viewer-content {
		container-type: inline-size;
	}

	.markdown-body {
		--gutter: clamp(24px, 5vw, 50px);
		--measure: min(100cqi, var(--preview-max-width, 880px));
		--breakout-inset: var(--gutter);
		box-sizing: border-box;
		min-width: 200px;
		padding: 50px max(var(--gutter), (100cqi - var(--measure)) / 2 + var(--gutter));
		height: 100%;
		overflow-y: auto;
		overflow-x: hidden;
		transform: translate3d(0, 0, 0);
		text-align: left;
		overflow-wrap: anywhere;
	}

	/* An outline floating in the margin keeps a wide table from sliding under it. */
	.markdown-body.toc-in-gutter {
		--breakout-inset: calc(var(--toc-width) + var(--gutter));
	}

	/*
	 * With Wide Tables Can Exceed Max Width on, a table wider than the column
	 * grows into the margins, centred on the column, up to `--breakout-inset`
	 * from the pane edge; past that it scrolls.
	 * `translate` because only it can use the table's own width: the shift is
	 * half of what the table exceeds the column by, and 0 for one that fits.
	 * Nested tables are left out, since their column does not start where the
	 * text column does. With the setting off, the base rule in styles.css
	 * keeps the table in the column.
	 */
	.viewer-content :global(.markdown-body.table-breakout table:not(:is(li, blockquote, td, th, details, .markdown-alert, .footnotes) table)) {
		max-width: max(100%, 100cqi - 2 * var(--breakout-inset));
		translate: min(0px, (var(--measure) - 2 * var(--gutter)) / 2 - 50%);
	}

	/*
	 * With Scroll Wide Tables off, a cell may break inside a word, so the table
	 * shrinks to fit instead of scrolling. A short column next to a long one
	 * can then break mid-word too (#927).
	 */
	.viewer-content :global(.markdown-body.table-fit table :is(td, th)) {
		overflow-wrap: anywhere;
	}

	.loading-chip {
		position: absolute;
		bottom: 30px;
		left: 50%;
		transform: translateX(-50%);
		background: var(--color-canvas-overlay);
		border: 1px solid var(--color-border-default);
		border-radius: 20px;
		padding: 8px 16px;
		display: flex;
		align-items: center;
		gap: 10px;
		box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
		z-index: 100;
		color: var(--color-fg-muted);
		font-size: 13px;
		font-family: var(--win-font), sans-serif;
	}

	.loading-spinner {
		width: 14px;
		height: 14px;
		border: 2px solid var(--color-border-muted);
		border-top-color: var(--color-accent-fg);
		border-radius: 50%;
		animation: spin 1s linear infinite;
	}

	@keyframes spin {
		to {
			transform: rotate(360deg);
		}
	}

	/* Not under `.markdown-container`: the exported article is outside it. */
	:global(.markdown-body pre),
	:global(.markdown-body pre code),
	:global(.markdown-body pre tt),
	:global(.markdown-body code) {
		font-family: var(--code-font, Consolas, monospace) !important;
		font-size: var(--code-font-size, 14px) !important;
	}

	/*
	 * The Code Font Size setting is an absolute px, which is what a reader wants
	 * for code sitting in prose — and wrong for code sitting in a heading, where
	 * it does not scale with the words around it: 14px inside a 24px `##` (#681),
	 * 14px inside a 32px `#`. GitHub sizes inline code at 85% of whatever
	 * contains it, and that is the rule the setting was overriding here.
	 *
	 * Scoped to headings so the setting keeps meaning what it says everywhere a
	 * reader actually reads code, and `!important` because the rule above is —
	 * specificity alone cannot answer it.
	 */
	:global(.markdown-body :is(h1, h2, h3, h4, h5, h6) code) {
		font-size: 0.85em !important;
	}

	/*
	 * The shared cursor in the preview (#799), drawn like the editor's: a caret
	 * and a faint current-line band. It does not blink, which is what says the
	 * preview is not the place to type.
	 */
	.preview-cursor {
		position: absolute;
		left: 0;
		right: 0;
		pointer-events: none;
	}

	.preview-cursor-line {
		position: absolute;
		inset: 0;
		background: color-mix(in srgb, var(--color-fg-default) 7%, transparent);
	}

	.preview-cursor-caret {
		position: absolute;
		top: 0;
		bottom: 0;
		width: 2px;
		margin-left: -1px;
		background: var(--color-accent-fg);
	}

	@media print {
		.preview-cursor {
			display: none;
		}
	}

	.markdown-body.full-width {
		--measure: 100cqi;
	}



	:global(.youtube-link) {
		display: block;
		max-width: 100%;
		margin: 1em 0;
	}

	:global(.youtube-link img) {
		display: block;
		width: 100%;
		aspect-ratio: 16 / 9;
		object-fit: cover;
		border-radius: 8px;
	}

	/*
	 * A measurable position for a soft line break, so split-view scroll sync
	 * can resolve a line inside a long paragraph instead of interpolating
	 * across the whole block. See `processSoftLineAnchors`.
	 *
	 * `inline-block` is the point — it is what gives the element a CSS box, and
	 * therefore an `offsetTop` the anchor lookup can read. Everything else here
	 * is about taking that box back out of the layout: no width, no height, and
	 * `vertical-align: top` so a zero-height box cannot sit on the baseline and
	 * push the line it is on. It holds no text, so selection and copy step over
	 * it.
	 */
	:global(.source-line-anchor) {
		display: inline-block;
		width: 0;
		height: 0;
		vertical-align: top;
	}

	:global(.mermaid-diagram) {
		margin: 1em 0;
		display: flex;
		justify-content: center;
		overflow-x: auto;
	}

	:global(.mermaid-diagram svg) {
		max-width: 100%;
		height: auto;
	}

	.tooltip {
		position: fixed;
		background: var(--color-canvas-overlay);
		color: var(--color-fg-default);
		padding: 4px 8px;
		border-radius: 6px;
		font-size: 11px;
		pointer-events: none;
		z-index: 10007;
		box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
		border: 1px solid var(--color-border-default);
		font-family: var(--win-font), 'Segoe UI', sans-serif;
		white-space: nowrap;
		max-width: 400px;
		overflow: hidden;
		text-overflow: ellipsis;
		transform: translateX(-50%) translateY(calc(-100% + 4px));
		opacity: 0;
		transition: 
			opacity 0.15s ease,
			transform 0.15s ease,
			left 0.15s ease,
			top 0.15s ease;
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 2px;
	}

	.tooltip.visible {
		opacity: 1;
		transform: translateX(-50%) translateY(-100%);
	}

	.tooltip.align-below {
		transform: translateX(-50%) translateY(-4px);
	}

	.tooltip.align-below.visible {
		transform: translateX(-50%) translateY(0);
	}

	.tooltip-text {
		display: block;
	}

	.tooltip-shortcut {
		color: var(--color-fg-muted);
		font-size: 10px;
		font-family: inherit;
	}

	.tooltip.align-right {
		transform: translateX(4px) translateY(-50%);
	}

	.tooltip.align-right.visible {
		transform: translateX(0) translateY(-50%);
		align-items: flex-start;
	}

	.tooltip.align-left {
		transform: translateX(calc(-100% - 4px)) translateY(-50%);
	}

	.tooltip.align-left.visible {
		transform: translateX(-100%) translateY(-50%);
		align-items: flex-end;
	}


	.tooltip.footnote-tooltip {
		white-space: normal;
		max-width: 500px;
		text-align: left;
		line-height: 1.5;
		padding: 10px 14px;
		box-shadow: 0 8px 24px rgba(0, 0, 0, 0.2);
		transform: translate(-50%, calc(-100% + 4px));
		margin-top: -8px;
		display: block; /* reset flex for footnotes */
	}

	.tooltip.footnote-tooltip.visible {
		transform: translate(-50%, -100%);
	}
	
	:global(.tooltip.footnote-tooltip p) {
		margin: 0;
		padding: 0;
	}

    :global(.tooltip.footnote-tooltip p + p) {
        margin-top: 8px;
    }

	.tooltip.footnote-tooltip::after {
		content: '';
		position: absolute;
		bottom: -6px;
		left: 50%;
		transform: translateX(-50%);
		border-left: 6px solid transparent;
		border-right: 6px solid transparent;
		border-top: 6px solid var(--color-canvas-overlay);
	}


	.drag-overlay {
		position: fixed;
		top: 36px;
		left: 0;
		right: 0;
		bottom: 0;
		pointer-events: none;
		z-index: 40000;
		animation: fadeIn 0.1s ease-out;
	}

	.drag-message {
		display: flex;
		flex-direction: column;
		align-items: center;
		color: #ffffff;
		font-family: var(--win-font);
		font-weight: 500;
		font-size: 13px;
		position: absolute;
		bottom: 40px;
		left: 50%;
		transform: translateX(-50%);
		white-space: nowrap;
		background: var(--color-accent-fg);
		padding: 6px 14px;
		border-radius: 20px;
		box-shadow: 0 4px 12px rgba(0, 0, 0, 0.2);
		pointer-events: none;
	}

	.drag-zones {
		display: flex;
		width: 100%;
		height: 100%;
		gap: 12px;
	}

	.drag-zone {
		flex: 1;
		display: flex;
		align-items: center;
		justify-content: center;
		background: transparent;
		transition: background 0.2s, border-color 0.2s, opacity 0.2s;
		border: 2px dashed transparent;
		opacity: 0;
		position: relative;
		margin: 8px;
		border-radius: 12px;
	}

	.drag-zone.active {
		background: color-mix(in srgb, var(--color-accent-fg) 8%, transparent);
		border-color: color-mix(in srgb, var(--color-accent-fg) 30%, transparent);
		opacity: 1;
	}

	.loading-screen {
		position: fixed;
		top: 36px;
		left: 0;
		width: 100%;
		height: calc(100% - 36px);
		display: flex;
		align-items: center;
		justify-content: center;
		background: var(--color-canvas-default);
		z-index: 5000;
	}

	.spinner {
		animation: rotate 2s linear infinite;
		z-index: 2;
		width: 50px;
		height: 50px;
	}

	.spinner .path {
		stroke: var(--color-accent-fg);
		stroke-linecap: round;
		animation: dash 1.5s ease-in-out infinite;
	}

	@keyframes rotate {
		100% {
			transform: rotate(360deg);
		}
	}

	@keyframes dash {
		0% {
			stroke-dasharray: 1, 150;
			stroke-dashoffset: 0;
		}
		50% {
			stroke-dasharray: 90, 150;
			stroke-dashoffset: -35;
		}
		100% {
			stroke-dasharray: 90, 150;
			stroke-dashoffset: -124;
		}
	}
	/* Layout System */
	/* Absolute, not fixed: with no z-index it opens no stacking context, so
	   menus inside it still stack against the title bar and the tab column. */
	.content-area.beside-tab-column {
		position: absolute;
		top: 0;
		bottom: 0;
		left: 0;
		right: 0;
	}

	.layout-container {
		display: flex;
		width: 100%;
		height: 100%;
		position: absolute;
		top: 0;
		left: 0;
		padding-top: 36px;
		box-sizing: border-box;
		overflow: hidden;
	}

	/**
	 * Swapping the panes reverses the row rather than reordering the markup
	 * (#184). The editor keeps its place in the DOM, so focus order, the drag
	 * hit test — which reads each pane's own `getBoundingClientRect()` — and
	 * every `.editor-pane` / `.viewer-pane` rule carry over untouched. The
	 * padding that a pinned outline adds is on the container and is unaffected
	 * by the direction, so the outline stays on the side it is pinned to.
	 */
	.layout-container.editor-on-right,
	.drag-zones.editor-on-right {
		flex-direction: row-reverse;
	}

	.pane {
		display: flex;
		flex-direction: column;
		overflow: hidden;
		min-width: 0;
		height: 100%;
		position: relative;
		background: var(--color-canvas-default);
	}

	.viewer-content {
		display: flex;
		flex-direction: row;
		width: 100%;
		height: 100%;
		overflow: hidden;
	}

	/* View Mode */
	.layout-container:not(.split):not(.editing) .editor-pane {
		width: 0 !important;
		flex: 0 !important;
		opacity: 0;
	}

	.layout-container:not(.split):not(.editing) .viewer-pane {
		width: 100%;
		flex: 1 !important;
	}

	/* Edit Mode */
	.layout-container:not(.split).editing .editor-pane {
		width: 100%;
		flex: 1 !important;
	}

	.layout-container:not(.split).editing .viewer-pane {
		width: 0 !important;
		flex: 0 !important;
		opacity: 0;
	}

	.split-bar {
		width: 4px;
		background: var(--color-border-default);
		cursor: col-resize;
		position: relative;
		z-index: 100;
		transition: background 0.2s;
	}

	.split-bar:hover {
		background: var(--color-accent-fg);
	}

	@keyframes fadeIn {
		from { opacity: 0; }
		to { opacity: 1; }
	}

	.identify-flash {
		position: fixed;
		inset: 0;
		z-index: 40000;
		pointer-events: none;
		display: flex;
		align-items: center;
		justify-content: center;
		box-shadow: inset 0 0 0 3px var(--color-accent-fg);
		border-radius: 8px;
		font-family: var(--win-font);
	}

	.identify-flash span {
		padding: 10px 22px;
		border-radius: 10px;
		background: var(--color-accent-fg);
		color: #fff;
		font-size: 20px;
		font-weight: 600;
		box-shadow: 0 8px 30px rgba(0, 0, 0, 0.25);
		font-family: var(--win-font);
	}

	/*
	 * `.layout-container` is absolutely positioned from top: 0, so a bar in
	 * normal flow would end up underneath it. Pinned below the 36px title bar
	 * and the pane's top chrome (`style:top`), the way editors surface
	 * file-changed-on-disk notices.
	 * Absolute inside `.content-area`, so it spans the document beside a tab column.
	 */
	.external-change-bar {
		position: absolute;
		top: 36px;
		left: 0;
		right: 0;
		z-index: 40000;
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 8px 14px;
		background: color-mix(in srgb, var(--color-attention-fg, #9a6700) 14%, var(--color-canvas-overlay));
		border-bottom: 1px solid var(--color-border-default);
		box-shadow: 0 2px 8px rgba(0, 0, 0, 0.12);
		color: var(--color-fg-default);
		font-family: var(--win-font), sans-serif;
		font-size: 13px;
	}
	.external-change-text {
		flex: 1;
		min-width: 0;
	}
	.external-change-action {
		flex: none;
		padding: 4px 10px;
		border: 1px solid var(--color-border-default);
		border-radius: 6px;
		background: var(--color-canvas-default);
		color: var(--color-fg-default);
		font-family: inherit;
		font-size: 12px;
		cursor: pointer;
	}
	.external-change-action:hover {
		background: color-mix(in srgb, var(--color-accent-fg) 8%, var(--color-canvas-default));
	}
	.external-change-action.primary {
		border-color: color-mix(in srgb, var(--color-accent-fg) 40%, transparent);
	}
	.toast-container {
		position: fixed;
		bottom: 24px;
		right: 24px;
		z-index: 50000;
		display: flex;
		flex-direction: column;
		align-items: flex-end;
		pointer-events: none;
	}
	.top-fade-mask {
		position: absolute;
		top: 0;
		left: 0;
		width: 60px;
		height: 52px;
		background: linear-gradient(to bottom, var(--color-canvas-default) 40%, transparent 100%);
		pointer-events: none;
		z-index: 50;
	}

	.toc-overlay-wrapper {
		position: absolute;
		top: 36px;
		left: 0;
		bottom: 0;
		z-index: 1000;
		height: calc(100% - 36px);
		width: var(--toc-width);
		background-color: var(--color-canvas-default);
		border-right: 1px solid transparent;
		border-left: 1px solid transparent;
		box-shadow: 10px 0 30px rgba(0, 0, 0, 0);
		transition: box-shadow 0.3s ease, border-color 0.3s ease;
	}

	.layout-container.editing.has-pinned-toc.toc-on-left .editor-pane {
		padding-left: 40px;
	}
	
	.layout-container.editing.has-pinned-toc.toc-on-right .editor-pane {
		padding-right: 40px;
	}

	.toc-overlay-wrapper.on-right {
		left: auto;
		right: 0;
	}

	.toc-overlay-wrapper.is-overhanging:not(.is-pinned) {
		border-right-color: var(--color-border-default);
		box-shadow: 10px 0 30px rgba(0, 0, 0, 0.12);
	}
	
	.toc-overlay-wrapper.is-overhanging.on-right:not(.is-pinned) {
		border-left-color: var(--color-border-default);
		box-shadow: -10px 0 30px rgba(0, 0, 0, 0.12);
	}

	.toc-toggle-floating {
		position: absolute;
		/*
		 * 36px of title bar, a 12px inset, and however tall the editor toolbar
		 * is right now — 0 when there isn't one. See `paneTopChrome`: the last
		 * term is measured because the toolbar's height is the toolbar's to
		 * decide, and a copy of it here would silently go stale.
		 */
		top: calc(48px + var(--pane-top-chrome, 0px));
		left: 8px;
		width: 28px;
		height: 28px;
		display: flex;
		align-items: center;
		justify-content: center;
		background-color: color-mix(in srgb, var(--color-canvas-default) 82%, transparent);
		border: 1px solid var(--color-border-default);
		border-radius: 4px;
		box-shadow: 0 2px 8px rgba(0, 0, 0, 0.12);
		backdrop-filter: blur(8px);
		-webkit-backdrop-filter: blur(8px);
		color: var(--color-fg-muted);
		cursor: pointer;
		z-index: 1001;
		transition: 
			left 0.3s cubic-bezier(0.4, 0, 0.2, 1),
			background-color 0.2s ease,
			border-color 0.2s ease,
			box-shadow 0.2s ease,
			color 0.2s ease,
			opacity 0.2s ease,
			transform 0.3s cubic-bezier(0.4, 0, 0.2, 1);
		opacity: 0.6;
		padding: 0;
	}

	/**
	 * Expanded, the button floats over the OUTLINE, which has no editor toolbar
	 * on it — so the offset that clears one has nothing to clear and pushes the
	 * button down onto the outline's first entry instead. 48px puts it back in
	 * the panel's own header band, whose buttons sit at the far end (right when
	 * the outline is on the left, left when it is on the right), leaving this
	 * end of that band empty.
	 *
	 * Collapsed it keeps the offset, because there it really is floating over
	 * the editor pane and the toolbar really is above it.
	 */
	.toc-toggle-floating.expanded {
		left: 24px;
		top: 48px;
	}

	.toc-toggle-floating.on-right {
		left: auto;
		right: 8px;
	}

	.toc-toggle-floating.on-right.expanded {
		right: 24px;
	}

	.layout-container:hover .toc-toggle-floating,
	.toc-toggle-floating:hover {
		background-color: color-mix(in srgb, var(--color-canvas-default) 90%, transparent);
		color: var(--color-fg-default);
		opacity: 1;
	}

	.toc-toggle-floating:focus-visible {
		outline: 2px solid var(--color-accent-fg);
		outline-offset: 2px;
		opacity: 1;
	}

	.toc-toggle-floating:active {
		background-color: var(--color-border-muted);
	}

	.toc-toggle-floating svg {
		transition: transform 0.3s cubic-bezier(0.4, 0, 0.2, 1);
		transform: rotate(0deg);
	}
	
	.toc-toggle-floating.on-right svg {
		transform: rotate(180deg);
	}

	.toc-toggle-floating.expanded svg {
		transform: rotate(180deg);
	}
	
	.toc-toggle-floating.on-right.expanded svg {
		transform: rotate(0deg);
	}

	.layout-container.toc-resizing,
	.layout-container.toc-resizing .toc-overlay-wrapper,
	.layout-container.toc-resizing .toc-toggle-floating {
		transition: none !important;
	}


	.layout-container.has-pinned-toc.toc-on-left {
		padding-left: var(--toc-width);
	}

	.layout-container.has-pinned-toc.toc-on-right {
		padding-right: var(--toc-width);
	}

	.toc-overlay-wrapper.is-pinned {
		z-index: 10;
		box-shadow: none !important;
		border-right: 1px solid var(--color-border-default);
	}

	.toc-overlay-wrapper.is-pinned.on-right {
		border-right: none;
		border-left: 1px solid var(--color-border-default);
	}

	.layout-container.editing .toc-overlay-wrapper:not(.on-right) {
		border-right-color: var(--color-border-default);
	}

	.layout-container.editing .toc-overlay-wrapper.on-right {
		border-left-color: var(--color-border-default);
	}

	.toc-resize-handle {
		position: absolute;
		top: 0;
		right: -5px;
		bottom: 0;
		width: 10px;
		z-index: 80;
		cursor: col-resize;
		touch-action: none;
		outline: none;
	}

	.toc-resize-handle.on-right {
		right: auto;
		left: -5px;
	}

	.toc-resize-handle::after {
		content: '';
		position: absolute;
		top: 10px;
		bottom: 10px;
		left: 50%;
		width: 1px;
		transform: translateX(-50%);
		background-color: var(--color-accent-fg);
		opacity: 0;
		transition: opacity 0.15s ease;
	}

	.toc-resize-handle:hover::after,
	.toc-resize-handle:focus-visible::after,
	.toc-overlay-wrapper.is-resizing .toc-resize-handle::after {
		opacity: 0.85;
	}
</style>
