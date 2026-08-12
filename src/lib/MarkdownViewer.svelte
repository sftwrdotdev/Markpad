<script lang="ts">
	import { invoke, convertFileSrc } from '@tauri-apps/api/core';
	import { emitTo } from '@tauri-apps/api/event';
	import { getCurrentWindow } from '@tauri-apps/api/window';
	import { onMount, tick, untrack } from 'svelte';
	import { fade, fly, slide } from 'svelte/transition';
	import { cubicOut } from 'svelte/easing';
	import { openPath, openUrl } from '@tauri-apps/plugin-opener';
	import { open, save, ask } from '@tauri-apps/plugin-dialog';
	import Settings from './components/Settings.svelte';
	import TitleBar from './components/TitleBar.svelte';
	import Editor from './components/Editor.svelte';
	import EditorToolbar from './components/EditorToolbar.svelte';
	import Modal from './components/Modal.svelte';
	import UpdateDialog from './components/UpdateDialog.svelte';
	import { updateStore } from './stores/update.svelte.js';
	import ContextMenu, { type ContextMenuItem } from './components/ContextMenu.svelte';
	import Toc from './components/Toc.svelte';
	import Toast from './components/Toast.svelte';
	import FindBar from './components/FindBar.svelte';
	import { reviewDirtyTabs } from './sessions/closeReview.js';
	import { exportAsHtml as _exportHtml, exportAsPdf as _exportPdf } from './utils/export';
	import { askToOpenExportedFile } from './utils/openExportedFile.js';
	import { isHomePath } from './utils/homeTab.js';
	import { hasRealFilePath } from './utils/tabFileActions.js';
	import ZoomOverlay from './components/ZoomOverlay.svelte';
import { processMarkdownHtml } from './utils/markdown';
import { MARKDOWN_LINK_EXTENSIONS, sanitizeMarkdownHtml } from './utils/sanitize.js';
import {
	renderDiagramsForPrint,
	resolveMermaidTheme,
} from './utils/mermaidPrint.js';
import {
	loadRichContentLibraries,
	renderRichContent as renderRichContentInto,
	sanitizeDiagramSvg,
	type RichContentLibraries,
} from './utils/richContent.js';
import { observeFoldLayout } from './utils/foldLayout.js';
import {
	applyFold,
	flipFold,
	foldRegionAt,
	foldRegionByKey,
	isFoldCollapsed,
} from './utils/foldState.js';
import { routeDroppedFile, type DropPane } from './utils/fileDrop.js';
import { headingReference, preferredReferenceStyle } from './utils/headingReference.js';
import {
	findAnchorElement,
	findSourceLineRange,
	getAnchorScrollTop,
	getSourceLineAtPreviewOffset,
	measureAnchorBox,
	mergeSourceLineRanges,
	PREVIEW_ANCHOR_OFFSET,
	type AnchorBox,
	type AnchorNode,
	type LineRange,
	type OffsetLayoutNode,
} from './utils/previewAnchor.js';
import {
	asRendererLine,
	lineCoordinates,
	type BufferLine,
	type BufferLineRange,
	type RendererLine,
} from './utils/lineCoordinates.js';
import {
	addFrontMatterListItems,
	getMarkdownBodyWithoutFrontMatter,
	getFrontMatterListItems,
	parseFrontMatter,
	parseFrontMatterEditableValue,
	removeFrontMatterListItem,
	updateFrontMatterListItem,
	updateFrontMatterField,
	type FrontMatterField,
} from './utils/frontMatter.js';
import {
	decodeLinkPath,
	getMarkdownLinkTarget as getRelativeMarkdownTarget,
	hasMarkdownLinkExtension,
	normalizeComparableMarkdownPath,
	resolveMarkdownTargetPath,
	type MarkdownLinkTarget as RelativeMarkdownTarget,
} from './utils/markdownLinks.js';
import { resolveLocalFileLinkPath } from './utils/localFileLinks.js';
import { findSeedFromSelection } from './utils/findSeed.js';
import { normalizeAssetPath } from './utils/exportHtml.js';
import {
	dropRecentFile,
	isRecentFilesStorageEvent,
	promoteRecentFile,
	readStoredRecentFiles,
	renameRecentFile,
	updateStoredRecentFiles,
} from './utils/recentFiles.js';

	const appWindow = getCurrentWindow();

	import HomePage from './components/HomePage.svelte';
import { tabManager, type Tab } from './stores/tabs.svelte.js';
import { snapshotTab } from './utils/tabTransfer.js';
import { adjustPreviewMaxWidth, getPreviewContentWidth, getStoredPreviewFullWidth } from './utils/previewWidth.js';
import { isTocOverhanging } from './utils/tocOverlay.js';
import {
	getScrollSyncPositionFromPixels,
	getScrollTopForSyncPosition,
	type ScrollSyncPosition,
} from './utils/scrollSync.js';
import { settings, TOC_WIDTH_RANGE } from './stores/settings.svelte.js';
import { t } from './utils/i18n.js';
import { formatChord } from './utils/shortcuts.js';
import { createWindowSession } from './sessions/windowSession.svelte.js';
import { createDocumentSession, type LoadMarkdownOptions } from './sessions/documentSession.svelte.js';

	// syntax highlighting & latex — loaded through the shared module so the
	// preview and the HTML export cannot end up with different libraries.
	let richLibraries = $state<RichContentLibraries | null>(null);
	let hljs = $derived(richLibraries ? richLibraries.hljs : null);
	let renderMathInElement = $derived(richLibraries ? richLibraries.renderMathInElement : null);
	let mermaid = $derived(richLibraries ? richLibraries.mermaid : null);

	import 'highlight.js/styles/github-dark.css';
	import 'katex/dist/katex.min.css';

	let mode = $state<'loading' | 'app'>('loading');
	let isDisposed = false;

	let showSettings = $state(false);

	let recentFiles = $state<string[]>([]);
	let isFocused = $state(true);
	
	let markdownBody: HTMLElement | null = $state(null);
	let stopObservingFoldLayout: (() => void) | null = null;
	
	const highlightColorMap: Record<string, string> = {
		default: 'color-mix(in srgb, var(--color-accent-fg) 40%, transparent)',
		yellow: 'rgba(255, 208, 0, 0.4)',
		orange: 'rgba(255, 140, 0, 0.4)',
		red: 'rgba(255, 60, 60, 0.4)',
		pink: 'rgba(255, 105, 180, 0.4)',
		purple: 'rgba(164, 108, 244, 0.4)',
		blue: 'rgba(67, 138, 243, 0.4)',
		cyan: 'rgba(43, 185, 178, 0.4)',
		green: 'rgba(77, 177, 88, 0.4)',
	};

	let editorPane = $state<{ 
		syncScrollToPosition: (position: ScrollSyncPosition) => void;
		handleDroppedFile: (path: string, x: number, y: number) => Promise<void>;
		updateDragCaret: (x: number, y: number) => void;
		hideDragCaret: () => void;
		runEditorAction: (actionId: string, payload?: any) => void;
		undo: () => void;
		redo: () => void;
		revealHeader: (sourceLine: BufferLine | null, text: string) => void;
		revealSourceRange: (startLine: number, endLine: number) => void;
		triggerFind: () => void;
		// The three the editor's context menu runs, which are the three its
		// keyboard shortcuts run (#207).
		cutToClipboard: () => Promise<void>;
		copyToClipboard: () => Promise<void>;
		pasteFromClipboard: () => Promise<void>;
	} | null>(null);
	let liveMode = $state(false);

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
		const previewVisible = !isEditing || !!tabManager.activeTab?.isSplit;
		if (editorHasFocus || !previewVisible) {
			editorPane?.triggerFind?.();
		} else if (markdownBody) {
			// Seed BEFORE opening, so the bar that appears already holds the query.
			// Nothing to seed leaves the previous query alone, which is what a
			// repeated Cmd/Ctrl+F expects.
			const seed = findSeedFromSelection(window.getSelection(), markdownBody);
			if (seed) findBar?.setQuery(seed);
			// Focus explicitly: once the bar is open, `findOpen = true` changes
			// nothing, so a repeated shortcut after clicking into the document
			// used to be swallowed (#559).
			findOpen = true;
			findBar?.focusInput();
		}
	}

	let isDragging = $state(false);
	let dragTarget = $state<'editor' | 'preview' | null>(null);

	/**
	 * The reference for a heading of THIS document, in the spelling this
	 * document is written in. See `headingReference.ts` — the inference falls
	 * back to what the menu has always produced.
	 */
	function copyHeadingReference(text: string, slug: string) {
		const tab = tabManager.activeTab;
		const fileName = tab?.path ? tab.path.split(/[/\\]/).pop() || null : null;
		const reference = headingReference({
			text,
			slug,
			fileName,
			style: preferredReferenceStyle(tab?.rawContent ?? ''),
		});
		invoke('clipboard_write_text', { text: reference });
	}

	function reportUnsupportedDrop(path: string) {
		const filename = path.split(/[/\\]/).pop() || 'File';
		addToast(t('toast.unsupportedFile', settings.language).replace('{{filename}}', filename), 'error');
	}
	let editorPaneEl = $state<HTMLElement>();
	let viewerPaneEl = $state<HTMLElement>();
	let isProgrammaticScroll = false;

	let toasts = $state<{ id: string; message: string; type: 'info' | 'error' | 'warning' }[]>([]);
	function addToast(message: string, type: 'info' | 'error' | 'warning' = 'info') {
		const id = crypto.randomUUID();
		toasts.push({ id, message, type });
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
	// Suppress the file-watcher reload that fires when we ourselves write the file.
	// Maps absolute path -> wall-clock ms after which an event for that path is real again.
	const SELF_WRITE_GRACE_MS = 400;
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

	// in-page scroll position history for mouse 4/5 nav
	let scrollHistory: number[] = [];
	let scrollFuture: number[] = [];
	let zoomData = $state<{ src?: string; html?: string } | null>(null);

	// What a document with no tab behind it has folded. Never written to — every
	// write goes through `setFoldOverrides`, which needs an active tab.
	const NO_FOLD_OVERRIDES = new Set<string>();

	// derived from tab manager
	let activeTab = $derived(tabManager.activeTab);
	// Fold state belongs to the document, so it lives on the tab (see
	// `Tab.foldOverrides`). Reading it through a derived is what makes a tab
	// switch swap the whole set: the preview render, the table of contents and
	// find all see the folds of the document on screen and no other document's.
	let foldOverrides = $derived(activeTab?.foldOverrides ?? NO_FOLD_OVERRIDES);
	let isEditing = $derived(activeTab?.isEditing ?? false);
	let rawContent = $derived(activeTab?.rawContent ?? '');
	let isSplit = $derived(activeTab?.isSplit ?? false);
	let frontMatterInfo = $derived(parseFrontMatter(rawContent));

	// derived from tab manager
	let currentFile = $derived(tabManager.activeTab?.path ?? '');
	let frontMatterPanelKey = $derived(currentFile || tabManager.activeTabId || 'untitled');
	let frontMatterCollapsedByKey = $state<Record<string, boolean>>({});
	let frontMatterEditErrors = $state<Record<string, string>>({});
	let frontMatterTagDrafts = $state<Record<string, string>>({});
	let frontMatterTagEditIndexes = $state<Record<string, number | null>>({});
	let frontMatterTagEditDrafts = $state<Record<string, string>>({});
	let isFrontMatterCollapsed = $derived(frontMatterCollapsedByKey[frontMatterPanelKey] ?? true);
	let isMarkdown = $derived(hasMarkdownLinkExtension(currentFile));
	let editorLanguage = $derived(getLanguage(currentFile));
	let htmlContent = $derived(tabManager.activeTab?.content ?? '');
	// This string is injected into the app's own document, so it runs the same
	// policy the export runs — the one place a document is untrusted must not
	// have its own private copy of the rules. The preview used to inline a
	// duplicate of the URI pattern and nothing else, which left a `style` tag (on
	// DOMPurify's default allowlist, CSS unfiltered) live inside the app's
	// document: an author stylesheet is not scoped to the article, so it could
	// hide the title bar and beacon out through `background-image: url(https://…)`,
	// neither of which the app CSP blocks (`style-src 'unsafe-inline'`,
	// `img-src … https:`). See ./utils/sanitize.ts for the policy itself, and
	// renderMarkdownPreview below for why this path sanitizes last.
	let sanitizedHtml = $derived(sanitizeMarkdownHtml(htmlContent));
	let scrollTop = $derived(tabManager.activeTab?.scrollTop ?? 0);
	let isScrolled = $derived(scrollTop > 0);
	let windowTitle = $derived(tabManager.activeTab?.title ?? 'Markpad');
	let isScrollSynced = $derived(tabManager.activeTab?.isScrollSynced ?? false);
	let canGoBackInFileHistory = $derived(tabManager.activeTabId ? tabManager.canGoBack(tabManager.activeTabId) : false);
	let canGoForwardInFileHistory = $derived(tabManager.activeTabId ? tabManager.canGoForward(tabManager.activeTabId) : false);

	let loadingTabs = $state<string[]>([]);
	let isAtBottom = $state(false);

	let showHome = $state(false);
	let isFullWidth = $state(getStoredPreviewFullWidth(
		localStorage.getItem('preview.fullWidth'),
		localStorage.getItem('isFullWidth'),
	));
	let viewerWidth = $state(0);
	// The bounds come from TOC_WIDTH_RANGE, the same object settings.setTocWidth
	// clamps against, so the handle cannot offer a width persistence would shrink.
	// The keyboard increment stays local: TOC_WIDTH_RANGE.step is 1, the spin-button
	// granularity of the numeric settings input, and arrow keys move the splitter 16px.
	const TOC_RESIZE_STEP = 16;
	let isTocResizing = $state(false);
	let tocWrapperEl = $state<HTMLElement | null>(null);
	let tocToggleEl = $state<HTMLElement | null>(null);
	let previewContentWidth = $derived(getPreviewContentWidth(settings.previewMaxWidth, isFullWidth));
	let isOverhanging = $derived(
		isTocOverhanging({
			isEditing,
			isSplit,
			tocSide: settings.tocSide,
			isFullWidth,
			viewerWidth,
			previewContentWidth,
			tocWidth: settings.tocWidth,
		}),
	);

	$effect(() => {
		localStorage.setItem('preview.fullWidth', String(isFullWidth));
		localStorage.removeItem('isFullWidth');
	});

	/**
	 * Reaching past a floating outline to touch what it is covering is a request
	 * for it to move. Only while it IS covering something: pinned it is a
	 * sidebar, and one sitting in the margin is not in anybody's way.
	 */
	$effect(() => {
		if (!settings.showToc || settings.pinnedToc || !isOverhanging) return;
		const dismiss = (e: PointerEvent) => {
			const target = e.target as Node | null;
			if (!target) return;
			// The toggle button owns its own click; closing here as well would
			// open and shut the panel in one gesture. Anything inside the panel —
			// the resize handle included — is use, not dismissal.
			if (tocWrapperEl?.contains(target) || tocToggleEl?.contains(target)) return;
			settings.showToc = false;
		};
		// Capture, so a handler that stops propagation on its way up cannot leave
		// the outline stranded over the text.
		window.addEventListener('pointerdown', dismiss, { passive: true, capture: true });
		return () => window.removeEventListener('pointerdown', dismiss, { capture: true });
	});

	import { parseAndApplyVscodeTheme, clearVscodeTheme } from './utils/theme';

	// Theme State
	let theme = $state<string>('system');

	onMount(() => {
		const storedTheme = localStorage.getItem('theme');
		if (storedTheme) theme = storedTheme;
		// Clear the forced background color from app.html
		document.documentElement.style.removeProperty('background-color');
	});

	$effect(() => {
		localStorage.setItem('theme', theme);
		invoke('save_theme', { theme }).catch(console.error);

		if (theme === 'system' || theme === 'light' || theme === 'dark') {
			if (theme === 'system') {
				delete document.documentElement.dataset.theme;
				delete document.documentElement.dataset.themeType;
			} else {
				document.documentElement.dataset.theme = theme;
				document.documentElement.dataset.themeType = theme;
			}
			clearVscodeTheme();
			const monaco = (window as any).monaco;
			if (monaco && monaco.editor) {
				const isSystemDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
				const effectiveTheme = theme === 'system' ? (isSystemDark ? 'dark' : 'light') : theme;
				monaco.editor.setTheme(effectiveTheme === 'dark' ? 'vs-dark' : 'vs');
			}
		} else if (theme.startsWith('vscode:')) {
			const name = theme.replace('vscode:', '');
			invoke('read_vscode_theme', { name }).then((json: any) => {
				parseAndApplyVscodeTheme(json, name);
			}).catch(e => {
				console.error("Failed to load vscode theme", e);
				theme = 'system';
			});
		}

		// Re-initialize mermaid or trigger update if needed
		// Note: Mermaid 10+ usually doesn't support dynamic re-init easily but we can try re-rendering rich content
		if (markdownBody && !isEditing) renderRichContent();
	});

	// ui state
	let tooltip = $state({ show: false, text: '', shortcut: '', html: '', isFootnote: false, x: 0, y: 0, align: 'top' as 'top' | 'right' | 'left' | 'below' });
	let modalState = $state<{
		show: boolean;
		title: string;
		message: string;
		kind: 'info' | 'warning' | 'error';
		showSave: boolean;
		resolve: ((v: 'save' | 'discard' | 'cancel') => void) | null;
	}>({
		show: false,
		title: '',
		message: '',
		kind: 'info',
		showSave: false,
		resolve: null,
	});

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
		return new Promise((resolve) => {
			modalState = {
				show: true,
				title: options.title,
				message,
				kind: options.kind,
				showSave: options.showSave ?? false,
				resolve,
			};
		});
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

	function handlePromptConfirm() {
		if (promptModal.resolve) promptModal.resolve(promptModal.value);
		promptModal.show = false;
	}

	function handlePromptCancel() {
		if (promptModal.resolve) promptModal.resolve(null);
		promptModal.show = false;
	}

	function handleModalSave() {
		if (modalState.resolve) modalState.resolve('save');
		modalState.show = false;
	}

	function handleModalConfirm() {
		if (modalState.resolve) modalState.resolve('discard');
		modalState.show = false;
	}

	function handleModalCancel() {
		if (modalState.resolve) modalState.resolve('cancel');
		modalState.show = false;
	}

	function handleSplitterKeyDown(e: KeyboardEvent) {
		const activeTab = tabManager.activeTab;
		if (!activeTab || !tabManager.activeTabId) return;

		if (e.key === 'ArrowLeft') {
			tabManager.setSplitRatio(tabManager.activeTabId, Math.max(0.1, activeTab.splitRatio - 0.05));
		} else if (e.key === 'ArrowRight') {
			tabManager.setSplitRatio(tabManager.activeTabId, Math.min(0.9, activeTab.splitRatio + 0.05));
		}
	}

	function setTocWidth(width: number) {
		settings.setTocWidth(Math.min(TOC_WIDTH_RANGE.max, Math.max(TOC_WIDTH_RANGE.min, width)));
	}

	function handleTocResizeKeyDown(e: KeyboardEvent) {
		const keyDelta = e.key === 'ArrowRight' ? TOC_RESIZE_STEP : e.key === 'ArrowLeft' ? -TOC_RESIZE_STEP : 0;
		if (keyDelta !== 0) {
			e.preventDefault();
			const widthDelta = settings.tocSide === 'left' ? keyDelta : -keyDelta;
			setTocWidth(settings.tocWidth + widthDelta);
			return;
		}

		if (e.key === 'Home') {
			e.preventDefault();
			setTocWidth(TOC_WIDTH_RANGE.min);
		} else if (e.key === 'End') {
			e.preventDefault();
			setTocWidth(TOC_WIDTH_RANGE.max);
		}
	}

	let isForceExiting = $state(false);
	// True while the window-close walk is showing per-tab dialogs; the native
	// red button is not blocked by the dialog overlay, so this keeps a second
	// close request from starting a competing walk.
	let isCloseWalkActive = false;
	let identifyFlash = $state('');
	let identifyFlashTimer: ReturnType<typeof setTimeout> | undefined;

	// v2 window-state snapshots live under their own key, and the legacy key
	// is removed on every write: an older Markpad build restoring a v2
	// snapshot it cannot understand ends up with undefined tab content, and
	// its editor then attributes a stale buffer to the wrong tab — which
	// auto-save happily writes to disk. Keeping the formats on separate keys
	// makes old and new builds invisible to each other.
	const WINDOW_STATE_KEY = 'savedTabsDataV2';
	const LEGACY_STATE_KEY = 'savedTabsData';
	const RESTORE_IN_PROGRESS_KEY = 'markpad-window-restore-in-progress';

	// localStorage is origin-scoped, so every window shares the one snapshot
	// slot. Only the main window persists and restores tabs: secondary window
	// labels carry a per-session token, so a snapshot of theirs could never
	// be restored under the same label again, and letting N windows write the
	// shared key means the last window closed overwrites everyone else.
	const isMainWindow = appWindow.label === 'main';
	const windowSession = createWindowSession({
		isMainWindow,
		windowStateKey: WINDOW_STATE_KEY,
		legacyStateKey: LEGACY_STATE_KEY,
		restoreInProgressKey: RESTORE_IN_PROGRESS_KEY,
		serializeState: () => tabManager.serializeState(),
		shouldRestoreState: () => settings.restoreStateOnReopen,
		isDisposed: () => isDisposed,
		restoreState: (json) => tabManager.restoreState(json),
		restoredTabs: () => tabManager.tabs.map((tab) => ({ id: tab.id, path: tab.path })),
		applyRestoredContent: async (tabId, raw) => {
			const tab = tabManager.tabs.find((item) => item.id === tabId);
			if (!tab) return;
			// Through the store, not by assigning the two buffers here: this is
			// a whole file read from disk, so it also settles `isTruncated` —
			// and a tab whose earlier restore attempt was deferred arrives here
			// carrying `true` from `markTabContentUnavailable`, which would have
			// gone on refusing every save of a buffer that is now complete.
			tabManager.setTabRawContent(tabId, raw);
			const processed = await renderMarkdownPreview(raw, tab.path, tab.foldOverrides);
			if (isDisposed) return;
			tabManager.updateTabContent(tab.id, processed);
			if (tabManager.activeTabId === tab.id) tick().then(renderRichContent);
		},
		dropRestoredTab: (tabId) => tabManager.closeTab(tabId),
		// A partially loaded buffer must never be handed to another window.
		// The transfer payload has no field for "incomplete" (see
		// tabTransfer.ts) and the destination rebuilds the tab from the
		// payload alone, so the arriving copy would look authoritative and its
		// auto-save would truncate the file. handleDetach and moveTabToWindow
		// complete the buffer first; these predicates are the backstop.
		canTransfer: (tabId) => {
			const tab = tabManager.tabs.find((item) => item.id === tabId);
			return !isCloseWalkActive && tab !== undefined && !isHomePath(tab.path) && !tab.isTruncated;
		},
		canDetach: (tabId) => {
			const tab = tabManager.tabs.find((item) => item.id === tabId);
			return !isCloseWalkActive && tab !== undefined && !isHomePath(tab.path) && !tab.isTruncated && tabManager.tabs.length >= 2;
		},
		transferPayload: (tabId) => {
			const tab = tabManager.tabs.find((item) => item.id === tabId);
			if (!tab) throw new Error('Tab disappeared before transfer');
			return JSON.stringify(snapshotTab(tab));
		},
		onTransferClaimed: (tabId) => tabManager.closeTab(tabId),
		acceptTransferredTab: async (snapshot) => {
			// The tab has to exist before it can be rendered, which leaves a
			// window where this side owns a document the source still shows.
			// Anything that goes wrong from here must undo the insert, or the
			// same file stays open in both windows with two auto-save timers
			// writing over each other.
			const id = tabManager.insertTransferredTab(snapshot);
			try {
				const transferred = tabManager.tabs.find((tab) => tab.id === id);
				if (!transferred) return false;
				await renderTabPreviewFromRaw(transferred);
				if (isDisposed) {
					tabManager.closeTab(id);
					return false;
				}
				return true;
			} catch (error) {
				tabManager.closeTab(id);
				throw error;
			}
		},
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

	$effect(() => {
		invoke('set_window_meta', {
			tagName: tabManager.windowTag?.name ?? null,
			tagColor: tabManager.windowTag?.color ?? null,
			activeTabTitle: tabManager.activeTab?.title ?? '',
			tabCount: tabManager.tabs.length,
		}).catch(() => {});
	});

	$effect(() => {
		const tag = tabManager.windowTag;
		appWindow.setTitle(tag ? `${tag.name} — ${windowTitle}` : windowTitle).catch(() => {});
	});

	let pinnedTags = $state<Array<{ name: string; color: string; files: string[] }>>([]);

	async function refreshPinnedTags() {
		pinnedTags = (await invoke('list_pinned_tags')) as typeof pinnedTags;
	}

	async function savePinnedTagIfNeeded() {
		const tag = tabManager.windowTag;
		if (!tag?.pinned) return;
		const files = tabManager.tabs.filter((tab) => hasRealFilePath(tab.path)).map((tab) => tab.path);
		await invoke('save_pinned_tag', { name: tag.name, color: tag.color, files });
	}

	async function openPinnedTag(tag: { name: string; color: string; files: string[] }) {
		tabManager.setWindowTag({ ...tag, pinned: true });
		for (const file of tag.files) await loadMarkdown(file);
		showHome = false;
	}

	async function unpinTagFromHome(name: string) {
		await invoke('remove_pinned_tag', { name });
		if (tabManager.windowTag?.name === name) tabManager.setWindowTag({ ...tabManager.windowTag, pinned: false });
		await refreshPinnedTags();
	}

	$effect(() => {
		if (showHome) refreshPinnedTags().catch(console.error);
	});

	const documentSession = createDocumentSession({
		setShowHome: (value) => (showHome = value),
		currentFile: () => currentFile,
		resetScrollHistory: () => {
			scrollHistory = [];
			scrollFuture = [];
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
		renderRichContent,
		onError: (message, error) => {
			console.error(message, error);
			addToast(`${message}: ${String(error)}`, 'error');
		},
		selfWriteGraceMs: SELF_WRITE_GRACE_MS,
		cancelPendingAutoSave,
		askClose: (title) =>
			askCustom(t('modal.youHaveUnsavedChanges', settings.language).replace('{title}', title), {
				title: t('modal.unsavedChanges', settings.language),
				kind: 'warning',
				showSave: true,
			}),
		onCloseSaveNewerEdits: () => addToast(t('toast.savedNewerEdits', settings.language), 'info'),
		onCloseAutoSaveFailed: () => addToast(t('toast.autoSaveFailed', settings.language), 'error'),
		// Not an error: the copy is the way out of a partial buffer, and it was
		// written. What the reader needs is to know where it stops.
		onPartialCopySaved: () => addToast(t('toast.partialCopySaved', settings.language), 'info'),
	});

	async function discardPersistedWindowState() {
		await windowSession.discardPersistedState();
	}

	// Persisted through Rust, not localStorage: setItem is an async message
	// to the WebKit storage process that dies in transit when the last
	// window's close ends the process (reproduced in QA as "close secondary
	// first, then main → snapshot gone"). An awaited invoke keeps the close
	// handler — and the process — alive until the bytes are on disk, so one
	// deterministic write at close replaces any keep-writing-while-running
	// scheme. The localStorage keys are read once for migration and removed
	// after the first successful Rust write; a downgraded build then starts
	// a fresh session instead of misreading anything.
	async function persistWindowState() {
		await windowSession.persistState();
	}

	// Exit discards the snapshot on purpose — it is how "quit" differs from
	// closing the window — but only once startup is over. Until `init` sets
	// `mode` to 'app', the file on disk is still the only complete record of
	// the session: `restore()` has rebuilt the tab list but is partway through
	// reading those files back. That window is short unless a restored path is
	// unreachable, and then it is the share timeout, once per tab, serially —
	// which is exactly when the user starts looking for a way out. The loading
	// screen renders the ☰ menu while every keyboard shortcut is inert
	// (`handleKeyDown` returns on `mode !== 'app'`), so Exit is the control
	// they reach. Discarding there costs them the session they were waiting
	// for; falling through to a plain close writes it back instead.
	async function appExit() {
		await savePinnedTagIfNeeded();
		if (settings.restoreStateOnReopen && mode === 'app') {
			const hasUnsaved = tabManager.tabs.some((t) => t.isDirty || (t.path === '' && t.rawContent.trim() !== ''));
			if (hasUnsaved) {
				const response = await askCustom(t('modal.areYouSureYouWantToExit', settings.language), {
					title: t('modal.confirmExit', settings.language),
					kind: 'warning',
					showSave: false,
				});
				if (response !== 'discard') return;
			}
			await discardPersistedWindowState();
			isForceExiting = true;
		}
		appWindow.close();
	}

	function getLanguage(path: string) {
		if (!path) return 'markdown';
		const ext = path.split('.').pop()?.toLowerCase();
		switch (ext) {
			case 'js':
			case 'jsx':
				return 'javascript';
			case 'ts':
			case 'tsx':
				return 'typescript';
			case 'html':
				return 'html';
			case 'css':
				return 'css';
			case 'json':
				return 'json';
			case 'md':
			case 'markdown':
			case 'mdown':
			case 'mkd':
				return 'markdown';
			default:
				return 'plaintext';
		}
	}

	$effect(() => {
		const _ = tabManager.activeTabId;
		showHome = false;
		findOpen = false;
	});

	$effect(() => {
		if (liveMode && currentFile) {
			invoke('watch_file', { path: currentFile }).catch(console.error);
		} else {
			invoke('unwatch_file').catch(console.error);
		}
	});

	// The preview and the export run the same filter in opposite orders, on
	// purpose. The export sanitizes the renderer output first and processes
	// afterwards, because the bytes it writes are read by another program and
	// running the filter over Markpad's own generated markup would let a future
	// tightening of the policy silently delete parts of the exported file; the
	// exported document carries a CSP as the second line of defence.
	//
	// The preview has no second line: what it produces is injected straight into
	// the live application document by `{@html sanitizedHtml}`. So the filter runs
	// last, on exactly the string that gets injected — the processed HTML is
	// cached in `tab.content` and re-sanitized at the sink (see `sanitizedHtml`),
	// which means no parse/serialize round trip happens after the sanitizer has
	// had its say. Moving the call here instead would inject a string the
	// sanitizer never saw.
	//
	// `folds` is a parameter rather than a read of the active tab because this
	// renders documents that are NOT on screen: a window restore renders every
	// restored tab, a cross-window arrival renders itself, and the background
	// completion of a large file lands long after the user may have switched
	// away. Each of those must fold the document it is rendering, not whichever
	// one happens to be active when the promise resolves.
	async function renderMarkdownPreview(raw: string, filePath: string, folds: Set<string>) {
		const body = getMarkdownBodyWithoutFrontMatter(raw);
		const html = (await invoke('render_markdown', { content: body })) as string;
		return processMarkdownHtml(html, filePath, folds);
	}

	async function renderTabPreviewFromRaw(tab: Tab) {
		const processed = await renderMarkdownPreview(tab.rawContent, tab.path, tab.foldOverrides);
		tabManager.updateTabContent(tab.id, processed);
		tab.previewedRawContent = tab.rawContent;
		await tick();
		renderRichContent();
	}

	function frontMatterFieldId(key: string) {
		return `frontmatter-${key.replace(/[^a-zA-Z0-9_-]/g, '-')}`;
	}

	function frontMatterFieldStateKey(field: FrontMatterField) {
		return `${frontMatterPanelKey}:${field.key}`;
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
		frontMatterCollapsedByKey = {
			...frontMatterCollapsedByKey,
			[frontMatterPanelKey]: collapsed,
		};
	}

	function clearFrontMatterEditError(key: string) {
		if (!frontMatterEditErrors[key]) return;
		const next = { ...frontMatterEditErrors };
		delete next[key];
		frontMatterEditErrors = next;
	}

	async function handleFrontMatterEdit(field: FrontMatterField, value: string) {
		const tab = tabManager.activeTab;
		if (!tab) return;
		// Front matter is editable from reading mode, which a large file can
		// reach while its buffer is still the preview slice. Rewriting that
		// slice and saving it would drop the rest of the document.
		if (!(await documentSession.ensureFullContent(tab.id))) {
			addToast(t('toast.partialDocument', settings.language), 'error');
			return;
		}

		try {
			const nextValue = parseFrontMatterEditableValue(field, value);
			const nextRaw = updateFrontMatterField(tab.rawContent, field.key, nextValue);
			tabManager.updateTabRawContent(tab.id, nextRaw);
			clearFrontMatterEditError(field.key);
			await renderTabPreviewFromRaw(tab);
		} catch (error) {
			frontMatterEditErrors = {
				...frontMatterEditErrors,
				[field.key]: String(error),
			};
		}
	}

	function getFrontMatterTagDraft(field: FrontMatterField) {
		return frontMatterTagDrafts[frontMatterFieldStateKey(field)] ?? '';
	}

	function setFrontMatterTagDraft(field: FrontMatterField, value: string) {
		frontMatterTagDrafts = {
			...frontMatterTagDrafts,
			[frontMatterFieldStateKey(field)]: value,
		};
		clearFrontMatterEditError(field.key);
	}

	function clearFrontMatterTagDraft(field: FrontMatterField) {
		const key = frontMatterFieldStateKey(field);
		if (!frontMatterTagDrafts[key]) return;

		const next = { ...frontMatterTagDrafts };
		delete next[key];
		frontMatterTagDrafts = next;
	}

	function getFrontMatterTagEditIndex(field: FrontMatterField) {
		return frontMatterTagEditIndexes[frontMatterFieldStateKey(field)] ?? null;
	}

	function getFrontMatterTagEditDraft(field: FrontMatterField, fallback: string) {
		return frontMatterTagEditDrafts[frontMatterFieldStateKey(field)] ?? fallback;
	}

	function setFrontMatterTagEditDraft(field: FrontMatterField, value: string) {
		frontMatterTagEditDrafts = {
			...frontMatterTagEditDrafts,
			[frontMatterFieldStateKey(field)]: value,
		};
		clearFrontMatterEditError(field.key);
	}

	function startFrontMatterTagEdit(field: FrontMatterField, index: number, value: string) {
		const key = frontMatterFieldStateKey(field);
		frontMatterTagEditIndexes = {
			...frontMatterTagEditIndexes,
			[key]: index,
		};
		frontMatterTagEditDrafts = {
			...frontMatterTagEditDrafts,
			[key]: value,
		};
		clearFrontMatterEditError(field.key);
	}

	function clearFrontMatterTagEdit(field: FrontMatterField) {
		const key = frontMatterFieldStateKey(field);
		const nextIndexes = { ...frontMatterTagEditIndexes };
		const nextDrafts = { ...frontMatterTagEditDrafts };
		delete nextIndexes[key];
		delete nextDrafts[key];
		frontMatterTagEditIndexes = nextIndexes;
		frontMatterTagEditDrafts = nextDrafts;
	}

	async function handleFrontMatterListChange(field: FrontMatterField, nextItems: string[]) {
		const tab = tabManager.activeTab;
		if (!tab) return;
		// Same partial-buffer guard as handleFrontMatterEdit.
		if (!(await documentSession.ensureFullContent(tab.id))) {
			addToast(t('toast.partialDocument', settings.language), 'error');
			return;
		}

		try {
			const nextRaw = updateFrontMatterField(tab.rawContent, field.key, nextItems);
			tabManager.updateTabRawContent(tab.id, nextRaw);
			clearFrontMatterEditError(field.key);
			await renderTabPreviewFromRaw(tab);
		} catch (error) {
			frontMatterEditErrors = {
				...frontMatterEditErrors,
				[field.key]: String(error),
			};
		}
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
			theme,
			datasetThemeType: document.documentElement.dataset.themeType,
			systemPrefersDark: window.matchMedia('(prefers-color-scheme: dark)').matches,
		});
	}

	/**
	 * The preview half of the shared renderer: same function the HTML export
	 * calls, pointed at the live preview element and given the copy-to-clipboard
	 * behaviour an exported file cannot have.
	 */
	async function renderRichContent() {
		if (!markdownBody || !richLibraries) return;

		await renderRichContentInto({
			root: markdownBody,
			libraries: richLibraries,
			mermaidTheme: currentMermaidTheme(),
			onCopyCode: (code, label) => {
				invoke('clipboard_write_text', { text: code.replace(/\n$/, '') })
					.then(() => {
						const originalContent = label.innerHTML;
						label.innerHTML = 'Copied!';
						label.classList.add('copied');
						setTimeout(() => {
							label.innerHTML = originalContent;
							label.classList.remove('copied');
						}, 1500);
					})
					.catch((err) => {
						console.error('Failed to copy code:', err);
					});
			},
		});
	}

	$effect(() => {
		if (sanitizedHtml && markdownBody && !isEditing && hljs && renderMathInElement && mermaid) renderRichContent();
	});

	$effect(() => {
		const html = sanitizedHtml;
		const body = markdownBody;
		if (!html || !body || (isEditing && !isSplit)) return;

		let cancelled = false;
		tick().then(() => {
			if (cancelled || body !== markdownBody) return;
			stopObservingFoldLayout?.();
			stopObservingFoldLayout = observeFoldLayout(body);
		});

		return () => {
			cancelled = true;
			stopObservingFoldLayout?.();
			stopObservingFoldLayout = null;
		};
	});

	// Re-apply find highlights after the preview HTML is replaced. The
	// `bind:innerHTML={sanitizedHtml}` on the article wipes the DOM on every
	// edit/render pass; without this, highlights vanish until the user
	// re-types in the find bar.
	$effect(() => {
		const _ = sanitizedHtml;
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
				if (tab) {
					let scrolled = false;

					if (tab.anchorLine > 0) {
						// Interpolated restore: find the rendered element that owns the
						// saved source line and put that line back under the anchor
						// offset. This has to descend — `processMarkdownHtml` re-parents
						// every block after a heading into a `.foldable-content-wrapper`
						// with no `data-sourcepos`, so a scan of `body.children` only
						// ever matched an anchor sitting exactly on a top-level heading
						// line (see scripts/previewAnchorRestore.test.ts for the rate).
						const match = findAnchorElement(body, tab.anchorLine);
						if (match) {
							// Through the same measurement the sync path uses: an anchor
							// inside a table or a code block resolves to an element whose
							// `offsetTop` is measured from that table or that block's shell,
							// and restoring to it would open the tab at the top instead.
							const box = measurePreviewBox(match.element);
							body.scrollTop = getAnchorScrollTop(
								box.top,
								box.height,
								match,
								tab.anchorLine,
								PREVIEW_ANCHOR_OFFSET,
							);
							scrolled = true;
						}
					}

					if (!scrolled) {
						if (body.scrollHeight > body.clientHeight && tab.scrollPercentage > 0) {
							const targetScroll = tab.scrollPercentage * (body.scrollHeight - body.clientHeight);
							body.scrollTop = targetScroll;
						} else {
							body.scrollTop = tab.scrollTop;
						}
					}
				}
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

	function getPreviewFrontMatterScrollEnd(target: HTMLElement) {
		const panel = target.querySelector<HTMLElement>('.frontmatter' + '-panel');
		if (!panel) return 0;

		// In the same space as `target.scrollTop`, which is what it is compared
		// against — see `measurePreviewBox`.
		const box = measurePreviewBox(panel);
		return Math.max(0, Math.min(getPreviewScrollMax(target), box.top + box.height));
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
		const position = getScrollSyncPositionFromPixels(
			target.scrollTop,
			getPreviewScrollMax(target),
			getPreviewFrontMatterScrollEnd(target),
		);

		// Front matter is a rendered panel with no source range, so there is no
		// line to send and the section ratio is the only thing that can carry it.
		// This is the carve-out `scrollSync.ts` exists for, unchanged.
		if (position.section !== 'body') return position;

		const line = lineCoords.bufferLineAtPreviewOffset(target, target.scrollTop, measurePreviewBox);

		return line === null ? position : { ...position, line };
	}

	function scrollPreviewToSyncPosition(position: ScrollSyncPosition) {
		if (!markdownBody) return;

		const scrollMax = getPreviewScrollMax(markdownBody);
		let targetScroll: number | null = null;

		if (position.section === 'body' && position.line !== undefined) {
			const offset = lineCoords.previewOffsetForBufferLine(
				markdownBody,
				position.line,
				measurePreviewBox,
			);
			if (offset !== null) targetScroll = offset;
		}

		if (targetScroll === null) {
			targetScroll = getScrollTopForSyncPosition(
				position,
				scrollMax,
				getPreviewFrontMatterScrollEnd(markdownBody),
			);
		}

		// The line mapping can point past either end — the last block interpolates
		// beyond the bottom of a preview that has no room left to scroll. Clamping
		// before the threshold check is what keeps `isProgrammaticScroll` honest:
		// an unreachable target fires no scroll event, and the flag would then be
		// spent swallowing the reader's next real scroll instead.
		targetScroll = Math.max(0, Math.min(scrollMax, targetScroll));

		if (Math.abs(markdownBody.scrollTop - targetScroll) <= 5) return;

		isProgrammaticScroll = true;
		markdownBody.scrollTop = targetScroll;
	}

	/**
	 * The source line the reader is on, for the outline to follow (#169).
	 *
	 * BOTH panes answer here, which is the point: the outline used to decide by
	 * rendered box, and only the preview has those. A source line is something
	 * either pane can produce — the editor sends one on every scroll (the same
	 * position scroll sync uses, whether or not sync is on), and the preview
	 * already computes one for the tab's reading position. One rule then picks
	 * the entry, so the two panes cannot disagree about which heading is
	 * current while both are on screen.
	 */
	let tocActiveLine = $state<RendererLine | null>(null);

	function handleEditorScrollSync(position: ScrollSyncPosition) {
		// The outline is built from `data-sourcepos`, so it counts from the body.
		if (position.line !== undefined) tocActiveLine = lineCoords.toRendererLine(position.line);

		if (tabManager.activeTab?.isScrollSynced) {
			scrollPreviewToSyncPosition(position);
		}
	}

	/**
	 * The source line to save as this tab's reading position: the one rendered
	 * `PREVIEW_ANCHOR_OFFSET` below the top of the viewport, which is where the
	 * restore puts it back.
	 *
	 * This used to be its own scan — `querySelectorAll('[data-sourcepos]')` over
	 * the whole preview, then `offsetTop` and `offsetHeight` on every element it
	 * returned, on every scroll event. Two things were wrong with that beyond the
	 * cost (8.3ms per event on a 13,000-line document, measured in Chrome). It
	 * took the FIRST element covering the offset in document order, which is the
	 * outermost, while the restore's `findAnchorElement` takes the narrowest — so
	 * capture and restore disagreed about which block a position belonged to. And
	 * it had no opinion about `<br>`, which carries a source range and no box, so
	 * an anchor at the top of the document could resolve to one (#464).
	 */
	function getPreviewScrollAnchor(target: HTMLElement): RendererLine | null {
		const line = getSourceLineAtPreviewOffset(
			target,
			target.scrollTop + PREVIEW_ANCHOR_OFFSET,
			measurePreviewBox,
		);

		// Straight off `data-sourcepos`, so it is already a renderer line: the
		// two consumers — the tab's saved reading position and the outline —
		// both count from the first line of the body.
		return line === null ? null : asRendererLine(Math.round(line));
	}

	function syncEditorToPreviewScroll(target: HTMLElement) {
		if (!tabManager.activeTab?.isScrollSynced || !editorPane) return;

		const position = getPreviewScrollSyncPosition(target);
		editorPane.syncScrollToPosition(position);
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

		if (isProgrammaticScroll) {
			isProgrammaticScroll = false;
			if (tabManager.activeTabId) {
				tabManager.updateTabScroll(tabManager.activeTabId, target.scrollTop);
			}
			return;
		}

		if (tabManager.activeTabId) {
			// Update raw scroll pos
			tabManager.updateTabScroll(tabManager.activeTabId, target.scrollTop);

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
				tocActiveLine = anchorLine;
			}
		}

		syncEditorToPreviewScroll(target);
	}

	// The one place fold state is written. It goes to the tab the user is
	// looking at, which is the document the fold is a fold OF — every toggle
	// path below acts on the preview or the table of contents of that tab.
	function setFoldOverrides(next: Set<string>) {
		if (tabManager.activeTabId) tabManager.setTabFoldOverrides(tabManager.activeTabId, next);
	}

	/**
	 * The single write path for a fold, whichever of the three drivers asked:
	 * the preview chevron and the callout title (`handleLinkClick`), the
	 * outline's fold button, and find opening what hides a match (`revealFold`).
	 *
	 * Both halves happen here, and that is the point. The stored deviation is
	 * what the NEXT render reads; the two class writes are what the current DOM
	 * shows. A driver that did only the second — which is what the callout title
	 * used to do — folds something that springs open again on the next
	 * keystroke, and there is nothing on screen to say why.
	 *
	 * The state is flipped even when the fold is not in the DOM (the preview is
	 * hidden in editor-only mode, and the outline is still there to click), so
	 * the fold is honoured by the render that brings it back.
	 */
	function toggleFold(key: string) {
		setFoldOverrides(flipFold(foldOverrides, key));

		const region = markdownBody ? foldRegionByKey(markdownBody, key) : null;
		if (region) applyFold(region, !isFoldCollapsed(region));
	}

	/** Open this fold if it is shut — what FindBar asks for on the way to a match. */
	function revealFold(key: string) {
		const region = markdownBody ? foldRegionByKey(markdownBody, key) : null;
		if (region && isFoldCollapsed(region)) toggleFold(key);
	}

	function scrollToAnchor(anchor: string, options: { pushHistory?: boolean } = {}) {
		let id = decodeLinkPath(anchor);
		if (id.startsWith('^')) {
			id = id.substring(1);
		}
		const el =
			(markdownBody?.querySelector(`[id="${CSS.escape(id)}"]`) as HTMLElement | null) ||
			(markdownBody?.querySelector(`[name="${CSS.escape(id)}"]`) as HTMLElement | null);
		if (el && markdownBody) {
			if (options.pushHistory !== false) pushScrollHistory();
			const containerRect = markdownBody.getBoundingClientRect();
			const elRect = el.getBoundingClientRect();
			const targetScrollTop = elRect.top - containerRect.top + markdownBody.scrollTop - PREVIEW_ANCHOR_OFFSET;
			markdownBody.scrollTo({ top: targetScrollTop, behavior: 'smooth' });
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

	async function openRelativeMarkdownTarget(target: RelativeMarkdownTarget) {
		const resolved = resolveMarkdownTargetPath(currentFile, target);
		if (!resolved) return;
		if (normalizeComparableMarkdownPath(resolved, settings.osType) === normalizeComparableMarkdownPath(currentFile, settings.osType)) {
			if (target.hash) {
				await scrollToAnchorWhenReady(target.hash);
			} else if (markdownBody) {
				pushScrollHistory();
				markdownBody.scrollTo({ top: 0, behavior: 'smooth' });
			}
			return;
		}
		if (tabManager.activeTabId && !(await canCloseTab(tabManager.activeTabId))) return;
		await loadMarkdown(resolved, { navigate: true });
		if (target.hash) {
			await scrollToAnchorWhenReady(target.hash, { pushHistory: false }, resolved);
		}
	}

	async function openMarkdownTargetInNewTab(target: RelativeMarkdownTarget) {
		const resolved = resolveMarkdownTargetPath(currentFile, target);
		if (!resolved) return;

		tabManager.addTab(resolved);
		await loadMarkdown(resolved, { skipTabManagement: true, resetScrollHistory: true });
		if (target.hash) {
			await scrollToAnchorWhenReady(target.hash, { pushHistory: false }, resolved);
		}
	}

	async function handleLinkClick(e: MouseEvent) {
		const target = e.target as HTMLElement;

		// Fold toggle: the heading's chevron, or a foldable callout's whole title
		// bar. One branch for both, because they are one feature — the callout's
		// own branch used to toggle the classes and stop there, so a folded
		// callout re-opened on the next render while a folded heading did not.
		const foldControl = target.closest('.header-fold-icon, .callout-toggle');
		if (foldControl) {
			if (e.detail > 1) e.preventDefault(); // prevent double-click selection
			e.stopPropagation();
			const region = foldRegionAt(foldControl);
			if (region) toggleFold(region.key);
			return;
		}

		const a = target.closest('a');
		if (a) {
			const href = a.getAttribute('href');
			if (href?.startsWith('#') && href.length > 1) {
				e.preventDefault();
				await scrollToAnchorWhenReady(href.substring(1));
				return;
			}

			const relativeMarkdownTarget = href ? getRelativeMarkdownTarget(href) : null;
			if (relativeMarkdownTarget) {
				e.preventDefault();
				e.stopPropagation();
				await openRelativeMarkdownTarget(relativeMarkdownTarget);
				return;
			}

			return;
		}

        // media zoom handling
        const img = target.closest('img');
        if (img) {
            zoomData = { src: img.src };
            return;
        }

        const mermaidDiv = target.closest('.mermaid-diagram');
        if (mermaidDiv) {
            const svg = mermaidDiv.querySelector('svg');
            if (svg) {
                // clone and strip fixed dimensions so viewBox governs scaling
                const clone = svg.cloneNode(true) as SVGElement;
                clone.removeAttribute('width');
                clone.removeAttribute('height');
                clone.style.width = '';
                clone.style.height = '';
                zoomData = { html: clone.outerHTML };
                return;
            }
        }
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



	/*
	 * All three mutations go through `updateStoredRecentFiles`, which re-reads
	 * the stored list first. Writing `JSON.stringify(recentFiles)` from this
	 * window's copy published a snapshot from whenever this window last looked,
	 * so with two windows open the later write erased the other's entries.
	 */
	function saveRecentFile(path: string) {
		recentFiles = updateStoredRecentFiles((current) => promoteRecentFile(current, path));
	}

	function loadRecentFiles() {
		recentFiles = readStoredRecentFiles();
	}

	function deleteRecentFile(path: string) {
		recentFiles = updateStoredRecentFiles((current) => dropRecentFile(current, path));
	}

	/*
	 * localStorage fires `storage` in every *other* same-origin document, so
	 * this is how a window learns that a sibling opened or removed a file. Home
	 * screens in other windows used to keep showing a stale list until restart,
	 * and — worse — that stale list was what their next write published.
	 */
	$effect(() => {
		if (typeof window === 'undefined') return;
		const onStorage = (event: StorageEvent) => {
			if (isRecentFilesStorageEvent(event)) recentFiles = readStoredRecentFiles();
		};
		window.addEventListener('storage', onStorage);
		return () => window.removeEventListener('storage', onStorage);
	});

	function removeRecentFile(path: string, event: MouseEvent) {
		event.stopPropagation();
		deleteRecentFile(path);
		if (currentFile === path) tabManager.closeTab(tabManager.activeTabId!);
	}

	async function canCloseTab(tabId: string): Promise<boolean> {
		return documentSession.canCloseTab(tabId);
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
	async function flushBeforeLeavingEditableMode(tab: Tab) {
		if (!tab.isDirty || tab.path === '') return;
		// Auto-save off means edits are kept until the user saves them, so
		// leaving the pane must not write either — the close dialog asks.
		if (!settings.autoSave) return;

		const success = await saveContent(tab.id);
		if (!success) {
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

	/**
	 * Reading mode's HTML, rendered from the tab's own buffer and its own path.
	 * Writes through the tab id, so a tab switch during the render cannot land
	 * one document's HTML on another — and, unlike the `loadMarkdown` call this
	 * replaces, it neither activates the tab nor re-reads the file.
	 */
	async function renderPreviewLeavingEditableMode(tab: Tab) {
		try {
			await renderTabPreviewFromRaw(tab);
		} catch (e) {
			console.error('Failed to render markdown', e);
		}
	}

	/**
	 * Move the active tab between reading and editing. Just the mode — where
	 * the reader LANDS is `editSourceRange`'s business, and `toggleEditView`
	 * is what decides which of the two a ⌘E means.
	 */
	async function toggleEdit() {
		const tab = tabManager.activeTab;
		if (!tab || tab.path === undefined) return;

		if (isEditing) {
			// Switch back to view.
			//
			// Reading mode renders THIS TAB'S BUFFER, never the file on disk, so
			// leaving the editor no longer depends on a save. The old code
			// re-read `tab.path` here, which is the only reason a dirty tab had
			// to be flushed first — silently, or through a modal — and that
			// flush is what #168 reports as "no way to see rendered view until
			// file is saved". Rendering the buffer is also what every editor the
			// user is likely to have open does: VS Code's Markdown preview
			// follows the in-memory document (it works on an untitled buffer and
			// updates as you type), Typora's rendered view IS the buffer, and
			// Obsidian switches to Reading view with no save step.
			//
			// Nothing is at risk. The buffer stays in memory, the tab keeps its
			// dirty dot, and the two places where the buffer really is about to
			// disappear — closing the tab (`canCloseTab`) and closing the window
			// (`appExit`) — still ask. A view toggle is not one of them.
			await flushBeforeLeavingEditableMode(tab);
			tab.isEditing = false;
			await renderPreviewLeavingEditableMode(tab);
		} else {
			// Switch to edit
			if (tab.path !== '') {
				if (tab.isDirty) {
					// Already have unsaved in-memory edits (e.g. from an
					// earlier session restored from localStorage, or from
					// post-save TOCTOU). Reading from disk would clobber
					// them, so just flip into edit mode without a reload.
					tab.isEditing = true;
				} else {
					try {
						// This buffer is about to be handed to the editor, and
						// the editor arms auto-save. The checked command is what
						// says whether the decode was lossy, so the tab carries
						// its own verdict instead of relying on the one
						// `loadMarkdown` left behind — a file can be converted
						// to UTF-8 (or away from it) between the two reads.
						const [content, lossy, encoding] = (await invoke('read_file_content_checked', { path: tab.path })) as [string, boolean, string];
						tabManager.setTabDecodedLossy(tab.id, lossy);
						tabManager.setTabEncoding(tab.id, encoding);
						// Goes through the store so a tab that held only the
						// large-file preview slice stops being flagged partial.
						tabManager.setTabRawContent(tab.id, content);
						tab.isEditing = true;
					} catch (e) {
						console.error('Failed to read file for editing', e);
					}
				}
			} else {
				tab.isEditing = true;
			}
		}
	}

	/**
	 * A jump the editor has not been asked for yet, because it does not exist
	 * yet: `toggleEdit` only flips a flag, and the `Editor` it mounts — and the
	 * `editorPane` binding that reaches it — arrive on the next render. The
	 * effect below spends it the moment they do, and immediately when the
	 * editor is already on screen (split view).
	 */
	let pendingEditReveal = $state<BufferLineRange | null>(null);

	$effect(() => {
		const range = pendingEditReveal;
		if (!range || !editorPane) return;

		pendingEditReveal = null;
		editorPane.revealSourceRange(range.startLine, range.endLine);
	});

	/**
	 * Which source lines the reader means by right-clicking here (#90).
	 *
	 * The selection when there is one, so a range spanning several blocks opens
	 * the editor on all of them; a caret or a click with nothing selected falls
	 * through to whatever is under the pointer, which is how a click on an
	 * image lands on the image.
	 *
	 * `null` when nothing under the pointer came from the document: the front
	 * matter panel, the outline, the window chrome. The caller then leaves the
	 * "Edit" entry doing exactly what it did before.
	 */
	function getContextMenuSourceRange(e: MouseEvent): LineRange | null {
		return getSelectionSourceRange() ?? findSourceLineRange(e.target as Node | null);
	}

	/**
	 * The source lines the reader has selected in the preview, or null when
	 * nothing is selected or the selection came from outside the document.
	 *
	 * Both ends resolve independently and are merged, so a selection spanning
	 * several blocks answers with all of them, and one end landing somewhere
	 * with no range (the front matter panel, the outline) leaves the other end
	 * in charge. Direction-independent: `startContainer` is the range's start,
	 * not the point the drag began at.
	 */
	function getSelectionSourceRange(): LineRange | null {
		const selection = window.getSelection();
		if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return null;
		return mergeSourceLineRanges(
			findSourceLineRange(selection.getRangeAt(0).startContainer),
			findSourceLineRange(selection.getRangeAt(selection.rangeCount - 1).endContainer),
		);
	}

	/**
	 * The preview's "Edit": open the editor on what the reader pointed at.
	 *
	 * With a range in hand this stops being a toggle. In split view the editor
	 * is already on screen and the old behaviour — leave edit mode — is the one
	 * thing "edit this fragment" cannot mean, so the toggle is skipped and only
	 * the jump happens. With no range (right-click outside the document) the
	 * entry is untouched.
	 */
	/**
	 * What ⌘E means, from every entry point that offers it — the hotkey, the
	 * toolbar, the title bar, and Monaco's own command.
	 *
	 * One function so the chord cannot mean two things depending on where the
	 * caret happens to be (`formatShortcutKeymap.test.ts` holds the two layers
	 * together), and so "take me to the editor" behaves the same whether the
	 * reader asked for it with a key or with a menu item.
	 */
	async function toggleEditView() {
		const selected = getSelectionSourceRange();

		if (isEditing && !isSplit) {
			// The editor is already the whole window: nowhere further to take
			// the reader, so this is the toggle back out.
			await toggleEdit();
			return;
		}

		if (isSplit && !selected) {
			// Deliberately nothing.
			//
			// What ⌘E is asked for is the ability to edit, and split view
			// already grants it — the editor is on screen. With no selection
			// there is no fragment to travel to either, so every remaining
			// reading of the chord is a LAYOUT change nobody asked for: closing
			// the preview on a mistyped ⌘E costs the reader the pane and a
			// second keystroke to get it back, while doing nothing costs
			// nothing. ⌘\ opens and closes the split, and stays the only way.
			return;
		}

		// Reading, or split with something selected — identical to the context
		// menu's "Edit". In split view the editor is already on screen, so
		// `editSourceRange` skips the toggle and only jumps, which is what
		// gives the highlight there too.
		await editSourceRange(selected);
	}

	async function editSourceRange(range: LineRange | null) {
		if (!isEditing) await toggleEdit();
		// `toggleEdit` swallows a failed read and stays in reading mode. Arming
		// the jump anyway would fire it at whatever document is edited next.
		if (range && tabManager.activeTab?.isEditing) pendingEditReveal = lineCoords.toBufferRange(range);
	}

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

	async function saveContent(tabId?: string): Promise<boolean> {
		const saved = await documentSession.saveContent(tabId);
		// Every route into here is an explicit decision — Cmd+S, the close
		// dialog, a mode-toggle dialog — and the background debounce is held
		// back entirely while a conflict is open (see the auto-save effect).
		// So a save that lands here IS the answer "keep my version": our text
		// is now the newest on disk and the bar has nothing left to ask.
		if (saved) clearExternalChangeConflict(tabId ?? tabManager.activeTabId ?? '');
		return saved;
	}

	async function saveContentAs(): Promise<boolean> {
		return documentSession.saveContentAs();
	}

	// --- External change conflicts ---
	// A file changed on disk while the tab holding it had unsaved edits. The
	// reload is NOT performed: `setTabRawContent` replaces originalContent
	// too, so an automatic reload would erase the edits and the fact that
	// there were any. The tab is flagged instead and the user picks.
	let externalChangeConflicts = $state<Record<string, true>>({});
	let activeExternalChangeConflict = $derived(
		tabManager.activeTabId ? externalChangeConflicts[tabManager.activeTabId] === true : false,
	);

	function noteExternalChangeConflict(tabId: string) {
		if (externalChangeConflicts[tabId]) return;
		externalChangeConflicts = { ...externalChangeConflicts, [tabId]: true };
	}

	function clearExternalChangeConflict(tabId: string) {
		if (!externalChangeConflicts[tabId]) return;
		const next = { ...externalChangeConflicts };
		delete next[tabId];
		externalChangeConflicts = next;
	}

	/** "Reload": the user chose the disk version over their own edits. */
	async function resolveExternalChangeByReloading() {
		const tab = tabManager.activeTab;
		if (!tab?.path) return;
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

	/** "Keep my version": dismiss. The buffer stays dirty and saveable. */
	function resolveExternalChangeByKeepingBuffer() {
		if (tabManager.activeTabId) clearExternalChangeConflict(tabManager.activeTabId);
	}

	/**
	 * Auto-save effect.
	 *
	 * Watches every tab in the tab manager. For each tab that is dirty, has a
	 * non-empty path (untitled files require an explicit Save dialog), and is
	 * currently editable (edit-mode or split-mode), arms a per-tab debounce
	 * timer that calls saveContent(tabId) when the typing pause exceeds
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
		// With auto-save off, saves happen only via Cmd+S or via the
		// close/toggle modals, so every armed timer is dropped.
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
			hasPendingConflict: externalChangeConflicts[tab.id] === true,
			// Reactive as well, and that is the point: "Save As" to a new file
			// clears the flag, so the tab becomes eligible again on the next
			// pass without anything having to remember to re-arm it.
			decodedLossily: tab.hasReplacementChars,
		}));

		untrack(() => {
			const seenIds = new Set<string>();
			for (const s of snapshot) {
				seenIds.add(s.id);
				// A tab with an unanswered external-change conflict is NOT
				// eligible: the debounce would fire while the bar is still
				// asking "reload or keep mine", write the buffer, and destroy
				// the disk version the question was about — leaving the user to
				// answer a question whose "reload" branch no longer exists.
				// Only the silent background timer is held back. Every explicit
				// save (Cmd+S, the close and mode-toggle dialogs) still goes
				// through: pressing Save IS the answer "keep mine", and the
				// `saveContent` wrapper clears the conflict so the bar comes
				// down instead of re-asking.
				// A tab whose buffer was decoded lossily is dropped once the
				// guard has refused it and said why. The first attempt is what
				// produces that explanation, so it is deliberately allowed
				// through; re-arming after it would only reach the same refusal
				// every 1.5s for as long as the user keeps typing.
				const eligible = s.isDirty && s.path !== '' && s.editable && !s.hasPendingConflict
					&& !(s.decodedLossily && documentSession.isLossySaveRefused(s.id));
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
					// `saveContent` resolves with a boolean; it does not
					// reject on save failure, so `.catch` alone hid errors.
					// Surface failures via toast + console.
					saveContent(s.id).then(
						(ok) => {
							if (!ok) {
								console.error('Auto-save failed for tab', s.id);
								// A refusal already explained itself, naming the
								// file and the way out. "Auto-save failed" on top
								// of that says nothing new.
								if (documentSession.isLossySaveRefused(s.id)) return;
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
		const result = await _exportHtml({
			rawContent,
			tabTitle: tab?.title || '',
			tabPath: tab?.path || '',
			// The exported page carries the appearance it was made in (see
			// `exportThemeAttribute`), and Mermaid bakes its theme into the SVG,
			// so the diagrams have to be rendered for the same appearance.
			mermaidTheme: currentMermaidTheme(),
			libraries: richLibraries,
			// The same value the live preview is wearing as `--preview-max-width`,
			// so the exported file is read at the measure it was written at
			// instead of the 900px the exporter used to hard-code (#467).
			contentWidth: previewContentWidth,
		});
		if (result?.missingImages) {
			addToast(`Exported HTML, but ${result.missingImages} local image(s) could not be embedded.`, 'warning');
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

	/**
	 * Bring the preview DOM up to date with the buffer before it is printed.
	 *
	 * The effect that keeps `tab.content` in step with `tab.rawContent` only
	 * runs while the preview is on screen — split view, or the editor with the
	 * TOC open, because the TOC is built from the rendered headings. In plain
	 * edit mode with the TOC closed nothing re-renders, so `tab.content` is
	 * still whatever was rendered when the file was opened.
	 *
	 * Export PDF prints the live DOM. Revealing the pane (see the `#app
	 * .pane.viewer-pane` rule in styles.css) without this would export the
	 * document as it was before the editing session — a worse failure than the
	 * blank page it replaces, because it looks like it worked. Rendering here
	 * pays the cost once per export instead of once per keystroke, which is
	 * what the narrow effect condition exists to avoid.
	 *
	 * Reading mode is left alone: its DOM came from `renderTabPreviewFromRaw`
	 * rendering this same buffer, and re-rendering would throw away the scroll
	 * position and the fold/find state the user is looking at.
	 */
	async function syncPreviewForPrint() {
		const tab = tabManager.activeTab;
		if (!tab || !(tab.isEditing || tab.isSplit)) return;
		const tabId = tab.id;
		const rawContent = tab.rawContent;
		if (rawContent === undefined) return;
		if (tab.previewedRawContent === rawContent) return;
		try {
			const processed = await renderMarkdownPreview(rawContent, tab.path, tab.foldOverrides);
			const current = tabManager.activeTab;
			if (tabManager.activeTabId !== tabId || current?.rawContent !== rawContent) return;
			tabManager.updateTabContent(tabId, processed);
			current.previewedRawContent = rawContent;
			await tick();
			// Awaited, unlike the on-screen path: Mermaid, KaTeX and
			// highlight.js all replace nodes asynchronously, and the diagram
			// re-theming below reads the nodes this produces.
			await renderRichContent();
			await tick();
		} catch (error) {
			// Printing the stale DOM is still better than not printing, but the
			// user must not be told a fresh export happened.
			console.error('Failed to refresh the preview before export', error);
			addToast('Exported PDF may not include the latest edits', 'warning');
		}
	}

	async function exportAsPdf() {
		await syncPreviewForPrint();
		const tab = tabManager.activeTab;
		// Mermaid bakes the screen theme into the SVG it emits, so a dark
		// preview exports unreadable diagrams. Rebuild them light for the
		// duration of the export rather than trying to recolour the output.
		const restoreDiagrams = await renderDiagramsForPrint({
			root: markdownBody,
			mermaid,
			sanitizeSvg: sanitizeDiagramSvg,
			screenTheme: currentMermaidTheme(),
			onError: (error) => console.error('Failed to re-render diagram for export', error),
		});
		try {
			await _exportPdf({
				tabPath: tab?.path || '',
				osType: settings.osType,
			});
		} catch (error) {
			console.error('Failed to export PDF', error);
			addToast('Failed to export PDF', 'error');
		} finally {
			restoreDiagrams();
		}
	}

	function handleNewFile() {
		tabManager.addNewTab();
		showHome = false;
	}

	async function selectFile() {
		const selected = await open({
			multiple: true,
			filters: [
				// The one list every other part of the app already treats as a
				// Markpad document — including `.txt`, which loads, renders and
				// saves like any other note (#535). Hardcoding a shorter list here
				// only hid those files behind "All Files".
				{ name: 'Markdown', extensions: MARKDOWN_LINK_EXTENSIONS },
				{ name: 'All Files', extensions: ['*'] },
			],
		});
		if (!selected) return;
		const paths = Array.isArray(selected) ? selected : [selected];
		for (const path of paths) await loadMarkdown(path);
	}

	async function reloadFromDisk() {
		const activeId = tabManager.activeTabId;
		const tab = tabManager.activeTab;
		if (!activeId || !tab?.path) return;
		if (!(await canCloseTab(activeId))) return;

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
		addToast('Reloaded from disk', 'info');
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

	async function closeTabAndWindowIfLast(tabId: string) {
		if (!(await canCloseTab(tabId))) return;

		tabManager.closeTab(tabId);
		if (tabManager.tabs.length > 0) return;

		if (liveMode) invoke('unwatch_file').catch(console.error);
		await destroyWindowAfterTabsClosed();
	}

	async function closeTabsWithConfirmation(tabIds: string[]) {
		for (const tabId of tabIds) {
			if (!(await canCloseTab(tabId))) return;
			tabManager.closeTab(tabId);
		}
	}

	async function destroyWindowAfterTabsClosed() {
		await savePinnedTagIfNeeded();
		if (settings.restoreStateOnReopen) {
			await persistWindowState();
		}

		await appWindow.destroy();
	}

	async function openFileLocation() {
		if (currentFile) await invoke('open_file_folder', { path: currentFile });
	}

	function toggleLiveMode() {
		liveMode = !liveMode;
	}

	/**
	 * Every image in the preview whose source is a local file has already been
	 * turned into an asset URL by `processMarkdownHtml`, so `img.src` is one of
	 * three things: an asset URL, a remote `http(s)` URL, or a `data:` URL.
	 *
	 * `convertFileSrc` does not spell the first one the same way everywhere:
	 * Windows gets `http://asset.localhost/<encoded path>`, everything else
	 * gets `asset://localhost/<encoded path>`. The old `src.startsWith('asset:')`
	 * test only recognised the second, so on Windows every local image fell
	 * into the remote branch — which could never work either (see below).
	 * `normalizeAssetPath` (#363) knows both shapes and, unlike a
	 * `startsWith('http://asset.localhost')` test, does not accept a lookalike
	 * host such as `http://asset.localhost.evil.test/`.
	 */
	async function saveImageAs(src: string) {
		const realPath = normalizeAssetPath(src) ?? '';

		if (!realPath) {
			// The webview cannot fetch the bytes of a remote image at all: the
			// app's CSP is `connect-src 'self'`, so a cross-origin `fetch` is
			// refused before it leaves the page. (`img-src ... https:` is a
			// different directive; it only governs what an `<img>` may
			// display.) The download has to happen in Rust, and there is no
			// command for it yet, so say that rather than reporting a network
			// failure that never happened.
			addToast('Saving a remote image is not supported yet', 'error');
			return;
		}

		const ext = realPath.split('.').pop() || 'png';
		const dest = await save({
			defaultPath: `image.${ext}`,
			filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'svg'] }]
		});
		if (dest) {
			try {
				await invoke('copy_file', { src: realPath, dest });
				addToast('Image saved successfully');
			} catch (e) {
				addToast(`Failed to save image: ${e}`, 'error');
			}
		}
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
				addToast('Diagram saved as SVG');
			} catch (e) {
				addToast(`Failed to save diagram: ${e}`, 'error');
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

		// Monaco's menu printed a chord beside every item. Kept for the two
		// below, where the menu entry is most of how anyone finds out the
		// shortcut exists, and dropped for cut/copy/paste, which nobody needs
		// told.
		//
		// `formatChord` rather than two literals, so the Mac and Windows
		// spellings cannot drift apart. F1 has no modifier and is the same
		// everywhere.
		const chord = (c: string) => formatChord(c, settings.osType === 'macos' ? 'Cmd' : 'Ctrl');

		docContextMenu = {
			show: true,
			x: e.clientX,
			y: e.clientY,
			items: [
				// No chord printed beside these three: ⌘X/⌘C/⌘V are the one set of
				// shortcuts nobody needs told, and the reminder costs a column of
				// width in every language.
				{ label: t('menu.cut', settings.language), onClick: () => editorPane?.cutToClipboard() },
				{ label: t('menu.copy', settings.language), onClick: () => editorPane?.copyToClipboard() },
				{ label: t('menu.paste', settings.language), onClick: () => editorPane?.pasteFromClipboard() },
				{ separator: true },
				// The two Monaco put here that this app can actually use, and
				// that drawing our own menu would otherwise have taken away.
				// Everything else it contributes — Go to Symbol, Quick Fix,
				// Format, Rename — needs a language provider Markdown has none
				// of, and never appeared.
				//
				// Translated here, which they were not before: Monaco's menu is
				// English whatever the app's language is.
				{
					label: t('menu.commandPalette', settings.language),
					shortcut: 'F1',
					onClick: () => editorPane?.runEditorAction('editor.action.quickCommand'),
				},
				{
					label: t('menu.changeAllOccurrences', settings.language),
					shortcut: chord('Mod+F2'),
					onClick: () => editorPane?.runEditorAction('editor.action.changeAll'),
				},
			],
		};
	}

	/**
	 * Every copy in this app puts plain text on the clipboard, and #548 gave the
	 * editor one implementation for all six of its entry points. Two entry points
	 * were left outside it, both reading a DOM selection rather than the editor's:
	 * ⌘C in the preview, and Edit ▸ Copy in the menu bar (a
	 * `PredefinedMenuItem::copy`, which asks the WEBVIEW to copy). Those two ended
	 * up plain text as well, but by accident rather than by decision — WebKit's
	 * own copy writes a WebArchive beside the text, and the only reason ours has
	 * none is that `LegacyWebArchive` skips its subresource sweep when the page's
	 * origin is not in the http family, which `tauri://localhost` is not. Under
	 * `tauri dev` the same selection carries 19MB (#549): the sweep embeds every
	 * cached script for the origin, so ten words of prose arrive with the whole
	 * unbundled module graph attached.
	 *
	 * Cancelling the copy event is what WebKit checks first (`Editor::copy` →
	 * `tryDHTMLCopy`), before it builds any of that, and it is checked whatever
	 * the origin — so this makes the plain-text result ours on both, instead of
	 * a property of the scheme that an upstream change could take back.
	 *
	 * The carve-out mirrors WebKit's own (`Editor::performCutOrCopy`): a selection
	 * inside an input or textarea already gets plain text and no archive, and
	 * `window.getSelection()` cannot read it, so cancelling there would copy an
	 * empty string. Monaco takes input through a hidden textarea and is covered by
	 * the same test — as it should be, since the editor has its own path.
	 */
	function handleCopyPlainText(e: ClipboardEvent) {
		const active = document.activeElement;
		if (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement) return;
		const selection = window.getSelection();
		if (!selection || selection.isCollapsed || !e.clipboardData) return;
		e.clipboardData.setData('text/plain', selection.toString());
		e.preventDefault();
	}

	function handleContextMenu(e: MouseEvent) {
		if (modalState.show) return;
		if (mode !== 'app') return;
		// The editor gets its own menu, and this branch has to come first:
		// Monaco takes input through a hidden `<textarea>`, so the text-field
		// carve-out below would otherwise claim every right-click in it.
		if ((e.target as HTMLElement).closest('.editor-container')) {
			showEditorContextMenu(e);
			return;
		}
		// Text fields keep the webview's own editing menu (Cut/Copy/Paste);
		// the document menu below is about the rendered preview and has no
		// edit items, so swallowing the native one leaves no way to paste.
		if ((e.target as HTMLElement).closest('input, textarea, [contenteditable="true"]')) return;
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

		// detect heading for copy ref
		const heading = (e.target as HTMLElement).closest('h1, h2, h3, h4, h5, h6');
		let copyRefItem: any[] = [];
		if (heading) {
			const text = heading.textContent?.trim() || '';
			// The rendered id, straight off the element: comrak wrote it, and
			// the outline reads it the same way — it can be on an anchor comrak
			// nests inside the heading rather than on the heading itself.
			const slug = heading.id || heading.querySelector('a.anchor')?.id || '';
			copyRefItem = [
				{ label: t('menu.copyReference', settings.language), onClick: () => copyHeadingReference(text, slug) },
				{ separator: true },
			];
		}

		const img = (e.target as HTMLElement).closest('img');
		let mediaItems: any[] = [];
		if (img) {
			mediaItems = [
				{ label: t('menu.saveImageAs', settings.language), onClick: () => saveImageAs(img.src) },
				{ separator: true }
			];
		}

		// Resolved now rather than inside the "Edit" handler: by the time that
		// runs the reader has clicked a menu item, and a click is how a
		// selection goes away.
		const editSourceTarget = getContextMenuSourceRange(e);

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
				{ label: t('menu.selectAll', settings.language), onClick: () => {
					if (!markdownBody) return;
					const range = document.createRange();
					range.selectNodeContents(markdownBody);
					const selection = window.getSelection();
					selection?.removeAllRanges();
					selection?.addRange(range);
				} },
				{ separator: true },
				{ label: t('menu.openLocation', settings.language), onClick: openFileLocation, disabled: !currentFile },
				{ label: t('menu.edit', settings.language), onClick: () => editSourceRange(editSourceTarget) },
				{ separator: true },
				{ label: t('menu.closeFile', settings.language), onClick: closeFile },
			],
		};
	}

	function handleMouseOver(event: MouseEvent) {
		if (mode !== 'app') return;
		let target = event.target as HTMLElement;
		while (target && target.tagName !== 'A' && target !== document.body) target = target.parentElement as HTMLElement;
		if (target?.tagName === 'A') {
			const anchor = target as HTMLAnchorElement;
			const rawHref = anchor.getAttribute('href') || '';

			// tooltip for same-page anchor links: show text of target header
			if (rawHref.startsWith('#')) {
				let id = rawHref.substring(1);
				if (id.startsWith('^')) id = id.substring(1);
				const el = markdownBody?.querySelector(`[id="${CSS.escape(id)}"]`) as HTMLElement | null;
				if (el) {
					// Use data-label if it's a block anchor, otherwise use textContent
					let text = el.getAttribute('data-label') || el.textContent || '';
					text = text.replace(/↩.*$/, '').trim(); // remove backrefs if any
					if (text) {
						const rect = anchor.getBoundingClientRect();
						tooltip = { show: true, text, shortcut: '', html: '', isFootnote: false, x: rect.left + rect.width / 2, y: rect.top - 8, align: 'top' };
						return;
					}
				}
				return;
			}

			// footnote references: show footnote content instead of URL
			if (anchor.hasAttribute('data-footnote-ref') || anchor.closest('[data-footnote-ref]') || rawHref.match(/#fn-|#fnref-|#user-content-fn/)) {
				const fnId = rawHref.replace(/^#/, '');
				const fnLi = markdownBody?.querySelector(`#${CSS.escape(fnId)}`) ||
				              markdownBody?.querySelector(`li#${CSS.escape(fnId)}`);
				if (fnLi) {
					// clone to remove backref arrow from tooltip
					const clone = fnLi.cloneNode(true) as HTMLElement;
					const backrefs = clone.querySelectorAll('.footnote-backref, a[href^="#fnref-"]');
					backrefs.forEach(b => b.remove());
					
					let fnHtml = clone.innerHTML.trim();
					if (fnHtml) {
						const rect = anchor.getBoundingClientRect();
						tooltip = { show: true, text: '', shortcut: '', html: fnHtml, isFootnote: true, x: rect.left + rect.width / 2, y: rect.top - 8, align: 'top' };
						return;
					}
				}
			}

			if (anchor.href) {
				const rect = anchor.getBoundingClientRect();
				tooltip = { show: true, text: anchor.href, shortcut: '', html: '', isFootnote: false, x: rect.left + rect.width / 2, y: rect.top - 8, align: 'top' };
			}
		}
	}

	function handleMouseOut(event: MouseEvent) {
		let target = event.target as HTMLElement;
		while (target && target.tagName !== 'A' && target !== document.body) target = target.parentElement as HTMLElement;
		if (target?.tagName === 'A') tooltip.show = false;
	}

	async function handleDocumentClick(event: MouseEvent) {
		if (mode !== 'app') return;
		let target = event.target as HTMLElement;
		while (target && target.tagName !== 'A' && target !== document.body) target = target.parentElement as HTMLElement;
		if (target?.tagName === 'A') {
			const anchor = target as HTMLAnchorElement;
			const rawHref = anchor.getAttribute('href');
			if (!rawHref) return;

			if (rawHref.startsWith('#')) return;

			const relativeMarkdownTarget = getRelativeMarkdownTarget(rawHref);
			if (relativeMarkdownTarget) {
				event.preventDefault();
				await openRelativeMarkdownTarget(relativeMarkdownTarget);
				return;
			}

			// A link to a local non-markdown file (`[data](./data.csv)`) is a
			// path, and `anchor.href` is not: the DOM resolved it against the
			// webview origin. Hand the OS the resolved disk path instead.
			const localFilePath = resolveLocalFileLinkPath(rawHref, currentFile);
			if (localFilePath) {
				event.preventDefault();
				try {
					await openPath(localFilePath);
				} catch (error) {
					console.error('Failed to open local file link', localFilePath, error);
					addToast(`Failed to open ${localFilePath}`, 'error');
				}
				return;
			}

			if (anchor.href) {
				event.preventDefault();
				// `openUrl` rejects anything outside the opener plugin's scope
				// (`mailto:`, `tel:`, `http://*`, `https://*`). Without this the
				// rejection was unhandled: the click did nothing, said nothing,
				// and left an uncaught promise rejection behind.
				try {
					await openUrl(anchor.href);
				} catch (error) {
					console.error('Failed to open link', anchor.href, error);
					addToast(`Failed to open ${rawHref}`, 'error');
				}
			}
		}
	}

	let zoomLevel = $state(parseInt(localStorage.getItem('zoomLevel') || '100', 10));

	$effect(() => {
		localStorage.setItem('zoomLevel', String(zoomLevel));
	});

	function handleWheel(e: WheelEvent) {
		if (e.ctrlKey || e.metaKey) {
			if (e.deltaY < 0) {
				zoomLevel = Math.min(zoomLevel + 10, 500);
			} else {
				zoomLevel = Math.max(zoomLevel - 10, 25);
			}
		}
	}

	let previewRenderRevision = 0;

	$effect(() => {
		const tab = tabManager.activeTab;
		const renderRevision = ++previewRenderRevision;
		if (tab && (tab.isSplit || (isEditing && settings.showToc)) && tab.rawContent !== undefined) {
			const tabId = tab.id;
			const rawContent = tab.rawContent;
			if (tab.previewedRawContent === rawContent) return;

			const timer = setTimeout(() => {
				renderMarkdownPreview(rawContent, tab.path, tab.foldOverrides)
					.then((processed) => {
						const currentTab = tabManager.activeTab;
						if (
							previewRenderRevision !== renderRevision ||
							tabManager.activeTabId !== tabId ||
							currentTab?.rawContent !== rawContent
						) return;
						tabManager.updateTabContent(tabId, processed);
						currentTab.previewedRawContent = rawContent;
						tick().then(renderRichContent);
					})
					.catch(console.error);
			}, 16);

			return () => clearTimeout(timer);
		}
	});

	async function toggleSplitView(tabId: string) {
		const tab = tabManager.tabs.find((t) => t.id === tabId);
		if (!tab) return;

		if (!tab.isSplit) {
			// Split view puts an editor on the buffer, and the first keystroke
			// arms auto-save. Two buffers must never reach that point: an empty
			// one (restored tab whose content was never read) and a partial one
			// (large file whose background read has not landed, or was dropped
			// because the user entered split during the ~2s window). The old
			// guard was `!tab.rawContent`, which a partial buffer satisfies —
			// so split view edited the truncated text and auto-save wrote it
			// back over the whole file. `toggleEdit` always re-reads, which is
			// why the same bug never reached the full editor.
			if (tab.path && !tab.isEditing && !tab.rawContent) {
				try {
					// Checked, like every other read that fills an editable
					// buffer: split view is an editor, so this tab must carry
					// the fidelity of its own decode rather than inherit one.
					const [content, lossy, encoding] = (await invoke('read_file_content_checked', { path: tab.path })) as [string, boolean, string];
					tabManager.setTabDecodedLossy(tab.id, lossy);
					tabManager.setTabEncoding(tab.id, encoding);
					tabManager.setTabRawContent(tab.id, content);
				} catch (e) {
					console.error('Failed to load raw content for split view', e);
				}
			}
			if (!(await documentSession.ensureFullContent(tab.id))) {
				addToast(t('toast.partialDocument', settings.language), 'error');
				return;
			}
			tabManager.setSplitEnabled(tab.id, true);
			if (liveMode) toggleLiveMode();
		} else {
			// Closing split view is the same move as leaving edit mode, and it
			// gets the same treatment: the surviving pane renders the buffer,
			// so no save has to happen first and nothing is asked. The split
			// preview was already rendering that buffer on every keystroke —
			// the old `loadMarkdown` here swapped it for the disk version at
			// the last moment, which is why the dirty tab had to be flushed.
			await flushBeforeLeavingEditableMode(tab);
			tabManager.setSplitEnabled(tab.id, false);
			await renderPreviewLeavingEditableMode(tab);
		}
	}

	function canUsePreviewWidthShortcut(target: EventTarget | null, isSplit: boolean) {
		if (showSettings || modalState.show || promptModal.show || showHome || (isEditing && !isSplit)) return false;
		const element = target instanceof Element ? target : null;
		return !element?.closest('input, textarea, select, [contenteditable="true"], [role="textbox"]');
	}

	function handleKeyDown(e: KeyboardEvent) {
		if (mode !== 'app') return;

		const cmdOrCtrl = e.ctrlKey || e.metaKey;
		const key = e.key.toLowerCase();
		const code = e.code;

		// The macOS application menu owns ⌘Q. Document shortcuts remain in the
		// in-window controls, so they continue to act on the current webview.
		if (settings.osType === 'macos' && cmdOrCtrl && !e.shiftKey) {
			if (key === 'q') return; // → menu-app-quit
		}

		const isSplit = tabManager.activeTab?.isSplit;

		if (cmdOrCtrl && e.altKey && !e.shiftKey && (code === 'BracketLeft' || code === 'BracketRight')) {
			if (!canUsePreviewWidthShortcut(e.target, !!isSplit)) return;
			e.preventDefault();
			isFullWidth = false;
			settings.previewMaxWidth = adjustPreviewMaxWidth(settings.previewMaxWidth, code === 'BracketLeft' ? -40 : 40);
			return;
		}

		if (!cmdOrCtrl && !e.shiftKey && !e.altKey && code === 'F5') {
			e.preventDefault();
			reloadFromDisk();
			return;
		}
		if (cmdOrCtrl && e.shiftKey && key === 'm') {
			e.preventDefault();
			carryActiveTabToNextWindow();
			return;
		}
		if (cmdOrCtrl && key === 'w') {
			e.preventDefault();
			closeFile();
		}
		if (cmdOrCtrl && e.code === 'F4') {
			e.preventDefault();
			closeFile();
		}
		// New file, both keys, whether or not the editor has focus (#392).
		//
		// Monaco resolves its own keybindings on the editor container and calls
		// stopPropagation() when it consumes one, so this handler only ever runs
		// for keystrokes the editor did not claim. That is how Ctrl+T came to
		// mean two things: inside Monaco the `file-new` action answered it and
		// opened an Untitled buffer, outside it this branch opened a Home tab.
		// Both of the app's own labels already promised the first one — the tab
		// strip's + button is titled "New Tab (Ctrl+T)" and the app menu prints
		// Ctrl/Cmd+T beside "New File" — so the branch, not the labels, was the
		// odd one out.
		//
		// `file-new` binds Ctrl/Cmd+N as well, and this handler used to know
		// about only one of the two, which left Ctrl+N doing nothing at all
		// outside the editor. Both are listed here so the two paths cannot
		// drift again; `formatShortcutKeymap.test.ts` holds them equal.
		if (cmdOrCtrl && !e.shiftKey && !e.altKey && (key === 't' || key === 'n')) {
			e.preventDefault();
			handleNewFile();
		}
		if (cmdOrCtrl && !e.shiftKey && !e.altKey && key === 'o') {
			e.preventDefault();
			selectFile();
		}
			if (cmdOrCtrl && key === 'q') {
				e.preventDefault();
				getCurrentWindow().close();
			}
		if (cmdOrCtrl && !e.shiftKey && !e.altKey && (code === 'Backslash' || code === 'IntlBackslash')) {
			e.preventDefault();
			if (tabManager.activeTabId) toggleSplitView(tabManager.activeTabId);
		}
		if (cmdOrCtrl && key === 'e') {
			e.preventDefault();
			// The `silentSave` argument these two used to pass meant "suppress
			// the unsaved-changes modal on the hotkey path". There is no modal
			// on a view toggle any more, and a keystroke that says "show me the
			// other pane" is not a request to write the file: whether a dirty
			// tab is flushed is now decided by the user's auto-save setting
			// alone, identically for the hotkey and the toolbar button.
			//
			toggleEditView();
		}
		if (cmdOrCtrl && e.shiftKey && !e.altKey && key === 's') {
			// Save As. The app menu advertised this chord for as long as the menu has
			// existed, but nothing ever bound it: the branch below matched on
			// `cmdOrCtrl && key === 's'` with no Shift guard, so the advertised
			// keystroke fell through to a plain Save and silently overwrote the file
			// the user was asking to write somewhere else. `saveContentAs` had no
			// keyboard path at all — its only caller was the menu button.
			e.preventDefault();
			saveContentAs();
			return;
		}
		if (cmdOrCtrl && !e.shiftKey && key === 's') {
			// Reading mode used to swallow the shortcut entirely. An untitled
			// buffer reaches it with content still unsaved — `toggleEdit`
			// only runs its save flow for tabs that already have a path — so
			// the only way to keep that text was to switch back to the
			// editor first. Saving is never mode-specific; the guard now
			// asks whether there is anything to write, not which pane is
			// visible. A saved, unmodified document stays a no-op so the
			// shortcut cannot churn its mtime and wake the file watcher.
			e.preventDefault();
			const saveTarget = tabManager.activeTab;
			if (saveTarget && (saveTarget.isDirty || saveTarget.path === '')) saveContent();
		}

		if (cmdOrCtrl && e.shiftKey && key === 't') {
			e.preventDefault();
			handleUndoCloseTab();
		}
		if (cmdOrCtrl && code === 'Tab') {
			e.preventDefault();
			tabManager.cycleTab(e.shiftKey ? 'prev' : 'next');
		}
		if (cmdOrCtrl && code === 'PageUp') {
			e.preventDefault();
			tabManager.cycleTab('prev');
		}
		if (cmdOrCtrl && code === 'PageDown') {
			e.preventDefault();
			tabManager.cycleTab('next');
		}
		if (e.metaKey && e.altKey && code === 'ArrowLeft') {
			e.preventDefault();
			tabManager.cycleTab('prev');
		}
		if (e.metaKey && e.altKey && code === 'ArrowRight') {
			e.preventDefault();
			tabManager.cycleTab('next');
		}
		if (e.altKey && !cmdOrCtrl && code === 'ArrowLeft') {
			e.preventDefault();
			navigateFileHistory('back');
		}
		if (e.altKey && !cmdOrCtrl && code === 'ArrowRight') {
			e.preventDefault();
			navigateFileHistory('forward');
		}
		if (cmdOrCtrl && (key === '=' || key === '+')) {
			e.preventDefault();
			zoomLevel = Math.min(zoomLevel + 10, 500);
		}
		if (cmdOrCtrl && key === '-') {
			e.preventDefault();
			zoomLevel = Math.max(zoomLevel - 10, 25);
		}
		if (cmdOrCtrl && key === '0') {
			e.preventDefault();
			zoomLevel = 100;
		}
		if (cmdOrCtrl && key === ',') {
			e.preventDefault();
			showSettings = true;
		}
		// Ctrl/Cmd+F: route to either Monaco's built-in find or the preview
		// FindBar depending on focus and which panes are visible. We only
		// preventDefault when we actually take the action ourselves —
		// otherwise we let Monaco's own keybinding fire.
		if (cmdOrCtrl && !e.shiftKey && !e.altKey && key === 'f') {
			const active = document.activeElement as Node | null;
			const editorHasFocus = !!editorPaneEl && !!active && editorPaneEl.contains(active);
			if (!editorHasFocus) {
				e.preventDefault();
				triggerFindAction();
			}
		}
	}

	async function navigateFileHistory(direction: 'back' | 'forward') {
		const activeTabId = tabManager.activeTabId;
		if (!activeTabId) return;
		if (!(await canCloseTab(activeTabId))) return;

		const path = direction === 'back'
			? tabManager.goBack(activeTabId)
			: tabManager.goForward(activeTabId);

		if (path) {
			await loadMarkdown(path, { skipTabManagement: true, resetScrollHistory: true });
		}
	}

	function pushScrollHistory() {
		if (markdownBody) {
			scrollHistory.push(markdownBody.scrollTop);
			scrollFuture = [];
			if (scrollHistory.length > 50) scrollHistory.shift();
		}
	}

	async function handleMouseUp(e: MouseEvent) {
		if (e.button === 3) {
			// Back
			e.preventDefault();
			// try in-page scroll history first
			if (scrollHistory.length > 0 && markdownBody) {
				scrollFuture.push(markdownBody.scrollTop);
				const pos = scrollHistory.pop()!;
				isProgrammaticScroll = true;
				markdownBody.scrollTo({ top: pos, behavior: 'smooth' });
			} else {
				await navigateFileHistory('back');
			}
		} else if (e.button === 4) {
			// Forward
			e.preventDefault();
			if (scrollFuture.length > 0 && markdownBody) {
				scrollHistory.push(markdownBody.scrollTop);
				const pos = scrollFuture.pop()!;
				isProgrammaticScroll = true;
				markdownBody.scrollTo({ top: pos, behavior: 'smooth' });
			} else {
				await navigateFileHistory('forward');
			}
		}
	}

	async function handleUndoCloseTab() {
		const path = tabManager.popRecentlyClosed();
		if (path) {
			await loadMarkdown(path);
		}
	}

	// Moving a tab to a new window preserves its state as-is — dirty content,
	// edit/split mode, history — so there is deliberately no canCloseTab()
	// save prompt here: movement is not closing. The content travels through
	// the Rust broker (never disk, never localStorage), and the source tab is
	// deleted only after the destination confirms the claim, so any failure —
	// window creation error, timeout — leaves the tab exactly where it was.
	// A large file may still be holding only its preview slice. The receiving
	// window cannot tell, so the buffer is completed here, before the payload
	// is built — otherwise the document arrives short and gets written back
	// that way.
	async function handleDetach(tabId: string) {
		if (!(await documentSession.ensureFullContent(tabId))) {
			addToast(t('toast.partialDocument', settings.language), 'error');
			return false;
		}
		return windowSession.detach(tabId);
	}

	async function moveTabToWindow(tabId: string, targetLabel: string, focusAfter = false) {
		if (!(await documentSession.ensureFullContent(tabId))) {
			addToast(t('toast.partialDocument', settings.language), 'error');
			return false;
		}
		const moved = await windowSession.transfer(tabId, (token) => invoke('offer_tab_to_window', { targetLabel, token }));
		if (moved && focusAfter) await invoke('focus_window', { label: targetLabel });
		return moved;
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

	async function mergeSelfInto(targetLabel: string) {
		if (isCloseWalkActive) return;
		for (const tab of [...tabManager.tabs]) {
			if (isHomePath(tab.path)) {
				tabManager.closeTab(tab.id);
				continue;
			}
			await moveTabToWindow(tab.id, targetLabel);
		}
		if (tabManager.tabs.length === 0) await appWindow.destroy();
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
			const deltaX = moveEvent.clientX - startX;
			const deltaRatio = deltaX / containerWidth;
			tabManager.setSplitRatio(tabId, startRatio + deltaRatio);
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
			setTocWidth(startWidth + widthDelta);
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

		loadRichContentLibraries()
			.then((libraries) => {
				if (isDisposed) return;
				richLibraries = libraries;
			})
			.catch((error) => console.error('Failed to load rich content libraries', error));

		let unlisteners: (() => void)[] = [];

			invoke('show_window').catch(console.error);

			const init = async () => {
				const appWindow = getCurrentWindow();
				if (isDisposed) return;

			await windowSession.restore();
			if (isDisposed) return;
			await windowSession.claimTransferredTab();
			if (isDisposed) return;

			const urlParams = new URLSearchParams(window.location.search);

			const fileParam = urlParams.get('file');
			if (fileParam) {
				const decodedPath = decodeURIComponent(fileParam);
				if (isDisposed) return;
				await loadMarkdown(decodedPath);
				if (isDisposed) return;
			}

			unlisteners.push(
				await appWindow.onFocusChanged(({ payload: focused }) => {
					isFocused = focused;
				}),
			);
			unlisteners.push(
				await appWindow.listen('file-changed', (event) => {
					const changedPath = event.payload as string;
					if (!liveMode) return;
					// The event names the changed file. Which tab that touches —
					// and whether it may be reloaded at all — is decided by the
					// session: it owns the self-write grace window (so our own
					// auto-save does not bounce back) and it refuses to reload a
					// tab with unsaved edits.
					const outcome = documentSession.resolveExternalChange(changedPath);
					if (outcome.action === 'ignore') return;
					if (outcome.action === 'conflict') {
						noteExternalChangeConflict(outcome.tabId);
						return;
					}
					loadMarkdown(outcome.path);
				}),
			);

			unlisteners.push(
				await appWindow.listen('file-path', (event) => {
					const filePath = event.payload as string;
					if (filePath) loadMarkdown(filePath);
				}),
			);
			unlisteners.push(
				await appWindow.listen('menu-close-file', () => {
					closeFile();
				}),
			);
			unlisteners.push(
				await appWindow.listen('menu-tab-rename', async (event) => {
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
							await invoke('rename_file', { oldPath, newPath });
							tabManager.renameTab(tabId, newPath);
							// Update recent files if needed
							recentFiles = updateStoredRecentFiles((current) => renameRecentFile(current, oldPath, newPath));
						} catch (e) {
							console.error('Failed to rename file', e);
							await askCustom(`Failed to rename file: ${e}`, { title: 'Error', kind: 'error' });
						}
					}
				}),
			);
			unlisteners.push(
				await appWindow.listen('menu-tab-new', () => {
					tabManager.addNewTab();
				}),
			);
			unlisteners.push(
				await appWindow.listen('menu-tab-undo', () => {
					handleUndoCloseTab();
				}),
			);
			unlisteners.push(
				await appWindow.listen('menu-tab-close', async (event) => {
					const tabId = event.payload as string;
					await closeTabAndWindowIfLast(tabId);
				}),
			);
			unlisteners.push(
				await appWindow.listen('menu-tab-detach', (event) => {
					handleDetach(event.payload as string);
				}),
			);
			unlisteners.push(
				await appWindow.listen('menu-tab-move', (event) => {
					const { tabId, targetLabel } = event.payload as { tabId: string; targetLabel: string };
					moveTabToWindow(tabId, targetLabel).catch((error) => console.error('Failed to move tab', error));
				}),
			);
			unlisteners.push(
				await appWindow.listen<string>('tab-transfer-offer', (event) => {
					if (isCloseWalkActive) return;
					windowSession.acceptOfferedTransfer(event.payload);
				}),
			);
			unlisteners.push(
				await appWindow.listen<string>('merge-into', (event) => {
					mergeSelfInto(event.payload).catch((error) => console.error('Failed to merge window', error));
				}),
			);
			unlisteners.push(
				await appWindow.listen<string>('window-identify', (event) => {
					identifyFlash = event.payload;
					clearTimeout(identifyFlashTimer);
					identifyFlashTimer = setTimeout(() => (identifyFlash = ''), 700);
				}),
			);
			unlisteners.push(
				await appWindow.listen('menu-tab-close-others', async (event) => {
					const tabId = event.payload as string;
					const tabsToClose = tabManager.tabs.filter((t) => t.id !== tabId).map((t) => t.id);
					await closeTabsWithConfirmation(tabsToClose);
				}),
			);
			unlisteners.push(
				await appWindow.listen('menu-tab-close-right', async (event) => {
					const tabId = event.payload as string;
					const index = tabManager.tabs.findIndex((t) => t.id === tabId);
					if (index !== -1) {
						const tabsToClose = tabManager.tabs.slice(index + 1).map((t) => t.id);
						await closeTabsWithConfirmation(tabsToClose);
					}
				}),
			);
			unlisteners.push(
				await appWindow.listen('menu-app-settings', () => {
					showSettings = true;
				}),
			);
			unlisteners.push(
				await appWindow.listen('menu-check-updates', () => {
					updateStore.openDialog();
				}),
			);
			// Native macOS application menu only owns application-level actions.
			unlisteners.push(await appWindow.listen('menu-app-quit',         () => appExit()));
			unlisteners.push(
				await appWindow.onCloseRequested(async (event) => {
					if (isForceExiting) return;

					// The red button is a native control, so it is NOT blocked
					// by the in-app dialog overlay: a second click while the
					// walk below is showing a dialog would re-enter this handler
					// and start a competing walk whose setActive calls fight the
					// first one — the highlighted tab stops matching the dialog.
					// One walk at a time.
					if (isCloseWalkActive) {
						event.preventDefault();
						return;
					}

					// Unsaved content and session restore are separate concerns:
					// dirty tabs are resolved FIRST through the per-tab dialogs,
					// then the restore snapshot records window state only (open
					// files, active tab, edit mode, split, scroll) — it never
					// carries document content.
					const dirtyTabs = tabManager.tabs.filter((t) => t.isDirty);
					if (dirtyTabs.length > 0) {
						event.preventDefault();
						isCloseWalkActive = true;
						// The walk's dialogs are in-app modals inside THIS
						// window: with multiple windows, another window may be
						// covering it and the review would be invisible. Bring
						// the reviewing window to the front first.
						invoke('show_window').catch(console.error);
						try {
							// Auto-save without confirmation: silently save every
							// dirty tab that has a real path. Untitled tabs need a
							// Save dialog, so the walk below handles them. A failed
							// silent save is surfaced and its tab also goes to the
							// walk. `saveContent` cancels each tab's pending timer
							// itself, so no writer here can be raced by its own
							// debounce.
							if (settings.autoSave) {
								for (const tab of dirtyTabs.filter((t) => t.path !== '')) {
									const ok = await saveContent(tab.id);
									if (!ok) {
										addToast(t('toast.autoSaveFailed', settings.language), 'error');
										break;
									}
								}
							}

							// Close review (issue #189): walk the remaining dirty
							// tabs one at a time — activate each and run the same
							// localized unsaved-changes dialog a single tab close
							// shows. Cancel stops the walk and keeps the window
							// open. Strict tab-strip order (left to right) so the
							// sequence is predictable; numbered untitled titles
							// let the dialog name each tab. Re-find every round —
							// a save can leave a tab dirty again (TOCTOU) and
							// tabs can change while a dialog is up.
							const resolved = await reviewDirtyTabs({
								nextDirtyTab: () => tabManager.tabs.find((t) => t.isDirty),
								setActive: (id) => tabManager.setActive(id),
								settle: tick,
								canCloseTab,
								closeTab: (id) => tabManager.closeTab(id),
								// Resolved tabs (saved, or reverted by Don't Save)
								// stay open for the window-state snapshot when
								// restore is enabled; untitled tabs have nothing to
								// restore, and with restore off the red button
								// closes tabs one by one.
								shouldCloseAfterResolving: (tab) =>
									!settings.restoreStateOnReopen || tab.path === '',
							});
							if (!resolved) return;
						} finally {
							isCloseWalkActive = false;
						}
					}

					// Session is clean now; record the window state for restore.
					// Awaited: the close-requested handler holds the close open
					// until the Rust write returns, so the process cannot exit
					// under the snapshot.
					await savePinnedTagIfNeeded();
					if (settings.restoreStateOnReopen) {
						await persistWindowState();
					}

					// If we intercepted the close to run the review, re-trigger
					// it: the handler re-enters, finds nothing dirty, and the
					// close proceeds.
					if (dirtyTabs.length > 0) appWindow.close();
				}),
			);

			unlisteners.push(
				await appWindow.onDragDropEvent((event) => {
					if (event.payload.type === 'enter' || event.payload.type === 'over') {
						const { x, y } = event.payload.position;
						isDragging = true;
						
						if (editorPaneEl) {
							const rect = editorPaneEl.getBoundingClientRect();
							if (x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom) {
								dragTarget = 'editor';
								if (editorPane) editorPane.updateDragCaret(x, y);
							} else if (viewerPaneEl) {
								const vRect = viewerPaneEl.getBoundingClientRect();
								if (x >= vRect.left && x <= vRect.right && y >= vRect.top && y <= vRect.bottom) {
									dragTarget = 'preview';
									if (editorPane) editorPane.hideDragCaret();
								} else {
									dragTarget = null;
									if (editorPane) editorPane.hideDragCaret();
								}
							} else {
								dragTarget = null;
								if (editorPane) editorPane.hideDragCaret();
							}
						}
					} else if (event.payload.type === 'drop') {
						const { x, y } = event.payload.position;
						const paths = event.payload.paths;
						const currentEditor = editorPane;
						if (currentEditor) currentEditor.hideDragCaret();
						// Both panes route through `routeDroppedFile`. The editor's
						// branch used to look for an image and silently discard
						// everything else, so a `.md` dropped there did nothing at
						// all while the same drop on the preview opened it.
						const pane: DropPane | null =
							dragTarget === 'editor' && currentEditor
								? 'editor'
								: dragTarget === 'preview' || (!isSplit && !isEditing)
									? 'preview'
									: null;

						if (pane) {
							paths.forEach(path => {
								switch (routeDroppedFile(path, pane)) {
									case 'insert':
										currentEditor?.handleDroppedFile(path, x, y);
										break;
									case 'open':
										loadMarkdown(path);
										break;
									case 'unsupported':
										reportUnsupportedDrop(path);
										break;
								}
							});
						}
						
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

			// Startup-file delivery (argv / macOS Opened-before-ready stash) is
			// a boot-time channel that belongs to the FIRST window only. It is
			// process-global state: letting every window consume it meant each
			// detached window re-opened the file the app was launched with.
			if (isMainWindow) {
				try {
					const args: string[] = await invoke('send_markdown_path');
					if (!isDisposed && args?.length > 0) {
						for (const path of args) await loadMarkdown(path);
					}
				} catch (error) {
					console.error('Error receiving Markdown file path:', error);
				}
			}

			if (!isDisposed) mode = 'app';
		};

		init();

		return () => {
			isDisposed = true;
			clearTimeout(identifyFlashTimer);
			unlisteners.forEach((u) => u());
		};
	});
</script>

<svelte:document
	onclick={handleDocumentClick}
	oncopy={handleCopyPlainText}
	oncontextmenu={handleContextMenu}
	onmouseover={handleMouseOver}
	onmouseout={handleMouseOut}
	onkeydown={handleKeyDown}
	onmouseup={handleMouseUp} />

{#if mode === 'loading'}
	<TitleBar
		{isFocused}
		isScrolled={false}
		currentFile={''}
		{liveMode}
		windowTitle="Markpad"
		showHome={false}
		{zoomLevel}
		onselectFile={selectFile}
		onnewFile={handleNewFile}
		onopenFile={selectFile}
		onmergeAllWindows={mergeAllWindowsHere}
		onsaveFile={saveContent}
		onsaveFileAs={saveContentAs}
		onreloadFromDisk={reloadFromDisk}
		onexportHtml={exportAsHtml}
		onexportPdf={exportAsPdf}
		onexit={appExit}
		ontoggleHome={toggleHome}
		ononpenFileLocation={openFileLocation}
		ontoggleLiveMode={toggleLiveMode}
		ontoggleEdit={() => toggleEditView()}
		ontoggleSplit={() => tabManager.activeTabId && toggleSplitView(tabManager.activeTabId)}
		{isEditing}
		ondetach={handleDetach}
		ontabclick={() => (showHome = false)}
		onresetZoom={() => (zoomLevel = 100)}
		{isFullWidth}
		ontoggleFullWidth={() => (isFullWidth = !isFullWidth)}
		{theme}
		onSetTheme={(t) => (theme = t)}
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
		{isFocused}
		{isScrolled}
		{currentFile}
		{liveMode}
		{windowTitle}
		{showHome}
		{zoomLevel}
		onselectFile={selectFile}
		onnewFile={handleNewFile}
		onopenFile={selectFile}
		onmergeAllWindows={mergeAllWindowsHere}
		onsaveFile={saveContent}
		onsaveFileAs={saveContentAs}
		onreloadFromDisk={reloadFromDisk}
		onexportHtml={exportAsHtml}
		onexportPdf={exportAsPdf}
		onexit={appExit}
		ontoggleHome={toggleHome}
		ononpenFileLocation={openFileLocation}
		ontoggleLiveMode={toggleLiveMode}
		ontoggleEdit={() => toggleEditView()}
		ontoggleEditorToolbar={() => settings.toggleEditorToolbar()}
		ontoggleSplit={() => tabManager.activeTabId && toggleSplitView(tabManager.activeTabId)}
		{isEditing}
		ondetach={handleDetach}
		ontabclick={() => (showHome = false)}
		onresetZoom={() => (zoomLevel = 100)}
		{isScrollSynced}
		ontoggleSync={() => tabManager.activeTabId && tabManager.toggleScrollSync(tabManager.activeTabId)}
		{isFullWidth}
		ontoggleFullWidth={() => (isFullWidth = !isFullWidth)}
		{theme}
		onSetTheme={(t) => (theme = t)}
		onopenSettings={() => (showSettings = true)}
		onfind={triggerFindAction}
		canGoBack={canGoBackInFileHistory}
		canGoForward={canGoForwardInFileHistory}
		onback={() => navigateFileHistory('back')}
		onforward={() => navigateFileHistory('forward')}
		oncloseTab={closeTabAndWindowIfLast} />

	<Settings show={showSettings} {theme} onSetTheme={(t) => (theme = t)} onclose={() => (showSettings = false)} />

	{#if activeExternalChangeConflict && !showHome}
		<div class="external-change-bar" role="status">
			<span class="external-change-text">{t('externalChange.message', settings.language)}</span>
			<button class="external-change-action" onclick={resolveExternalChangeByReloading}>
				{t('externalChange.reload', settings.language)}
			</button>
			<button class="external-change-action primary" onclick={resolveExternalChangeByKeepingBuffer}>
				{t('externalChange.keepMine', settings.language)}
			</button>
		</div>
	{/if}

	{#if tabManager.activeTab && !isHomePath(tabManager.activeTab.path) && !showHome}
			<div
				class="markdown-container"
				style="zoom: {isEditing && !isSplit ? 1 : zoomLevel / 100}; --code-font: {settings.codeFont}, monospace; --code-font-size: {settings.codeFontSize}px; --highlight-color: {highlightColorMap[settings.highlightColor] || highlightColorMap.yellow};"
				onwheel={handleWheel}
				role="presentation">
				<div class="layout-container" 
					class:split={isSplit} 
					class:editing={isEditing} 
					class:has-pinned-toc={isMarkdown && settings.pinnedToc && settings.showToc}
					class:toc-on-left={isMarkdown && settings.tocSide === 'left'}
					class:toc-on-right={isMarkdown && settings.tocSide === 'right'}
					class:toc-resizing={isTocResizing}
					style="--toc-width: {settings.tocWidth}px;">
					<!-- Editor Pane -->
					<div bind:this={editorPaneEl} class="pane editor-pane" class:active={isEditing || isSplit} style="flex: {isSplit ? tabManager.activeTab.splitRatio : isEditing ? 1 : 0}">
						{#if isEditing || isSplit}
							{#if settings.showEditorToolbar}
								<div transition:slide={{ duration: 150 }}>
									<EditorToolbar
										modifier={settings.osType === 'macos' ? 'Cmd' : 'Ctrl'}
										toolbarOrder={settings.editorToolbarOrder}
										toolbarHidden={settings.editorToolbarHidden}
										onaction={(actionId, payload) => editorPane?.runEditorAction(actionId, payload)}
										ontoggleHide={() => settings.toggleEditorToolbar()}
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
								language={editorLanguage}
								{theme}
								onsave={saveContent}
								bind:zoomLevel
								onnew={handleNewFile}
								onopen={selectFile}
								onclose={closeFile}
								onreveal={openFileLocation}
								ontoggleEdit={() => toggleEditView()}
								ontoggleLive={toggleLiveMode}
								ontoggleSplit={() => tabManager.activeTabId && toggleSplitView(tabManager.activeTabId)}
								onhome={() => (showHome = true)}
								onnextTab={() => tabManager.cycleTab('next')}
								onprevTab={() => tabManager.cycleTab('prev')}
								onundoClose={handleUndoCloseTab}
								onscrollsync={handleEditorScrollSync} />
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
						class:active={!isEditing || isSplit} 
						style="flex: {isSplit ? 1 - tabManager.activeTab.splitRatio : (!isEditing) ? 1 : 0}">

						<FindBar
							bind:this={findBar}
							bind:open={findOpen}
							{markdownBody}
							onunfold={revealFold}
							language={settings.language} />

							<div class="viewer-content">
								<article
									bind:this={markdownBody}
									contenteditable="false"
									class="markdown-body {isFullWidth ? 'full-width' : ''} {settings.showToc ? 'toc-active' : ''}"
									onscroll={handleScroll}
									onclick={handleLinkClick}
									onchange={handleTaskCheckboxChange}
									onkeydown={(e) => {
										const target = e.target as HTMLElement;
										if (target.closest('.frontmatter-panel')) return;
										if(e.key === 'Enter' || e.key === ' ') handleLinkClick(e as unknown as MouseEvent);
									}}
									tabindex="-1"
									style="outline: none; font-family: {settings.previewFont}, sans-serif; font-size: {settings.previewFontSize}px; flex: 1; --preview-max-width: {previewContentWidth === null ? '100%' : `${previewContentWidth}px`};">
									{#if frontMatterInfo.exists}
										<details
											class="frontmatter-panel"
											class:is-collapsed={isFrontMatterCollapsed}
											open={!isFrontMatterCollapsed}
											ontoggle={(e) => setFrontMatterCollapsed(!(e.currentTarget as HTMLDetailsElement).open)}>
											<summary class="frontmatter-summary">
												<span class="frontmatter-chevron" aria-hidden="true">›</span>
												<span class="frontmatter-title">Properties</span>
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
																		<div class="frontmatter-tag-list" role="list" aria-label={`${field.key} tags`}>
																			{#each getFrontMatterListItems(field) as tag, index (`${tag}-${index}`)}
																				<span class="frontmatter-tag" role="listitem">
																					{#if getFrontMatterTagEditIndex(field) === index}
																						<input
																							class="frontmatter-tag-edit-input"
																							type="text"
																							value={getFrontMatterTagEditDraft(field, tag)}
																							aria-label={`Edit ${field.key} tag ${tag}`}
																							use:focusAndSelect
																							oninput={(e) => setFrontMatterTagEditDraft(field, (e.currentTarget as HTMLInputElement).value)}
																							onkeydown={(e) => handleFrontMatterTagEditKeydown(e, field, index)}
																							onblur={() => commitFrontMatterTagEdit(field, index)} />
																					{:else}
																						<button
																							class="frontmatter-tag-text"
																							type="button"
																							aria-label={`Edit ${field.key} tag ${tag}`}
																							onclick={() => startFrontMatterTagEdit(field, index, tag)}>
																							{tag}
																						</button>
																						<button
																							class="frontmatter-tag-remove"
																							type="button"
																							aria-label={`Remove ${tag} from ${field.key}`}
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
																				placeholder="Add tag"
																				autocomplete="off"
																				enterkeyhint="done"
																				oninput={(e) => setFrontMatterTagDraft(field, (e.currentTarget as HTMLInputElement).value)}
																				onkeydown={(e) => handleFrontMatterTagAddKeydown(e, field)} />
																			<button
																				class="frontmatter-tag-add-button"
																				type="button"
																				aria-label={`Add ${field.key} tag`}
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
															{#if frontMatterEditErrors[field.key]}
																<div class="frontmatter-field-error" role="status">{frontMatterEditErrors[field.key]}</div>
															{/if}
														</div>
													{/each}
												</div>
											{:else}
												<div class="frontmatter-error" role="status">{frontMatterInfo.error}</div>
											{/if}

										</details>
									{/if}
									{@html sanitizedHtml}
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
							class:in-edit-mode={isEditing && !settings.showToc}
							onclick={() => settings.toggleToc()}
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
									activeLine={tocActiveLine} 
										{markdownBody} 
										htmlContent={sanitizedHtml}
										onBeforeJump={pushScrollHistory} 
										{foldOverrides} 
										ontoggleFold={toggleFold} 
										oncopyref={(text: string, slug: string) => copyHeadingReference(text, slug)}
										onjump={(id: string, text: string, sourceLine: RendererLine | null) => {
											// A floating outline that is covering the text has done its
											// job the moment you pick an entry: it exists to be called
											// up, used once and dismissed. Pinned it is a permanent
											// sidebar and stays; not overhanging it is sitting in the
											// margin harming nothing, and closing it would take away a
											// behaviour that was already fine.
											if (isOverhanging && !settings.pinnedToc) settings.showToc = false;
											if (isEditing && editorPane) {
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

	<Modal
		show={modalState.show}
		title={modalState.title}
		message={modalState.message}
		kind={modalState.kind}
		showSave={modalState.showSave}
		onconfirm={handleModalConfirm}
		onsave={handleModalSave}
		oncancel={handleModalCancel} />

	<Modal
		show={promptModal.show}
		title={promptModal.title}
		message={promptModal.message}
		kind="info"
		showInput={true}
		bind:inputValue={promptModal.value}
		onconfirm={handlePromptConfirm}
		oncancel={handlePromptCancel} />

	<UpdateDialog />

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
				onremove={() => toasts = toasts.filter(t => t.id !== toast.id)} />
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
			<div class="drag-zones" class:split={isSplit}>
				{#if isSplit || isEditing}
					<div class="drag-zone editor-zone" class:active={dragTarget === 'editor'}>
								<div class="drag-message">
									<span>{t('dragAndDrop.embed', settings.language)}</span>
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

<style>
	:root {
		--animation: cubic-bezier(0.05, 0.95, 0.05, 0.95);
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

	.markdown-body {
		box-sizing: border-box;
		min-width: 200px;
		margin: 0 auto;
		padding: 50px clamp(24px, 5vw, 50px);
		height: 100%;
		overflow-y: auto;
		overflow-x: hidden;
		transform: translate3d(0, 0, 0);
		max-width: var(--preview-max-width, 880px);
		text-align: left;
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

	.markdown-container :global(.markdown-body pre),
	.markdown-container :global(.markdown-body pre code),
	.markdown-container :global(.markdown-body pre tt),
	.markdown-container :global(.markdown-body code) {
		font-family: var(--code-font, Consolas, monospace) !important;
		font-size: var(--code-font-size, 14px) !important;
	}

	.markdown-body.full-width {
		max-width: 100%;
		margin: 0;
	}



	@keyframes slideIn {
		from {
			opacity: 0;
			transform: translateY(12px);
		}
		to {
			opacity: 1;
			transform: translateY(0);
		}
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

	@keyframes fadeIn {
		from {
			opacity: 0;
			transform: scale(0.98);
		}
		to {
			opacity: 1;
			transform: scale(1);
		}
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

	.pane {
		display: flex;
		flex-direction: column;
		overflow: hidden;
		transition:
			flex 0.3s cubic-bezier(0.16, 1, 0.3, 1),
			transform 0.3s cubic-bezier(0.16, 1, 0.3, 1);
		min-width: 0;
	}

	.pane.editor-pane {
		background: var(--color-canvas-default);
	}

	.pane.viewer-pane {
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

	/* Split Mode Transition Logic */
	/* Editor slides in from left */
	/* Viewer slides right */

	.pane {
		height: 100%;
		position: relative;
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
	 * normal flow would end up underneath it. Pinned just below the 36px
	 * title bar instead, the way editors surface file-changed-on-disk notices.
	 */
	.external-change-bar {
		position: fixed;
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
		transition: box-shadow 0.3s ease, border-color 0.3s ease, left 0.3s ease, right 0.3s ease, width 0.2s ease;
		order: -1;
	}

	.toc-overlay-wrapper.is-pinned {
		position: relative;
		top: 0 !important;
		height: 100%;
		z-index: 10;
		background-color: transparent;
		backdrop-filter: none;
		-webkit-backdrop-filter: none;
		box-shadow: none !important;
	}
	.layout-container.editing.has-pinned-toc.toc-on-left .editor-pane {
		padding-left: 40px;
	}
	
	.layout-container.editing.has-pinned-toc.toc-on-right .editor-pane {
		padding-right: 40px;
	}

	.editor-pane {
		transition: padding 0.3s cubic-bezier(0.4, 0, 0.2, 1);
	}

	.toc-overlay-wrapper.on-right {
		left: auto;
		right: 0;
		order: 2;
	}

	.toc-overlay-wrapper.is-pinned.on-right {
		border-left-color: var(--color-border-default);
	}
	
	.toc-overlay-wrapper.is-pinned:not(.on-right) {
		border-right-color: var(--color-border-default);
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
		top: 48px;
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

	.toc-toggle-floating.expanded {
		left: 24px;
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

	.layout-container {
		transition: padding 0.3s cubic-bezier(0.16, 1, 0.3, 1);
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
		position: absolute; /* Keep it absolute but it will stay in the padded area */
		top: 36px !important;
		left: 0;
		height: calc(100% - 36px);
		background-color: var(--color-canvas-default);
		border-right: 1px solid var(--color-border-default);
	}

	.toc-overlay-wrapper.is-pinned.on-right {
		left: auto;
		right: 0;
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
