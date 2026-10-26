import type { settings as Settings } from '../stores/settings.svelte.js';
import type { Tab, tabManager as TabManager } from '../stores/tabs.svelte.js';
import type { LanguageCode } from '../utils/i18n.js';
import {
	asBufferLine,
	tabAnchorForEditorTopLine,
	type BufferLine,
	type BufferLineRange,
	type LineCoordinates,
	type RendererLine,
} from '../utils/lineCoordinates.js';
import { findSourceLineRange, mergeSourceLineRanges, type LineRange } from '../utils/previewAnchor.js';
import { sourceAtPoint, type SourceLineReader } from '../utils/previewCursor.js';
import type { ScrollSyncPosition } from '../utils/scrollSync.js';
import { type ViewMode, viewModeOf } from '../utils/titlebarToolbar.js';
import { claimTabForRead } from './documentSession.svelte.js';

export type ViewModeEditorPane = {
	syncScrollToPosition: (position: ScrollSyncPosition, options?: { cursorIntoView?: boolean }) => void;
	setCursor: (line: number, column: number) => void;
	scrollSyncPosition: () => ScrollSyncPosition | null;
};

export type ViewModeOptions = {
	tabManager: typeof TabManager;
	settings: typeof Settings;
	documentSession: { ensureFullContent: (tabId: string) => Promise<boolean> };
	flushBeforeLeavingEditableMode: (tab: Tab) => Promise<unknown>;
	/** `read_file_content_checked`: the file and the fidelity of its decode. */
	readFile: (path: string) => Promise<[string, boolean, string]>;
	renderTabPreviewFromRaw: (tab: Tab) => Promise<void>;
	tick: () => Promise<void>;
	addToast: (message: string, type?: 'info' | 'error' | 'warning') => unknown;
	t: (key: string, language: LanguageCode) => string;
	// The viewer's panes and measurements, read when a handler runs.
	readonly editorPane: ViewModeEditorPane | null | undefined;
	readonly markdownBody: HTMLElement | null | undefined;
	readonly previewBlocks: HTMLElement | null | undefined;
	readonly lineCoords: LineCoordinates;
	readRendererLine: SourceLineReader;
	getPreviewScrollSyncPosition: (target: HTMLElement) => ScrollSyncPosition;
	scrollPreviewToSyncPosition: (position: ScrollSyncPosition) => void;
	getPreviewScrollAnchor: (target: HTMLElement) => RendererLine | null;
};

/**
 * The viewer's three modes and what moves between them: the view toggles
 * (Ctrl+E, ⌘\, the title bar's mode buttons), scroll sync between the panes,
 * the outline's current entry, and the cursor the two panes share.
 */
export function createViewMode(o: ViewModeOptions) {
	const { tabManager, settings, documentSession, flushBeforeLeavingEditableMode, readFile, renderTabPreviewFromRaw, tick, addToast, t } = o;

	const isEditing = () => tabManager.activeTab?.isEditing ?? false;
	const isSplit = () => tabManager.activeTab?.isSplit ?? false;
	const hasEditorPane = () => isEditing() || isSplit();
	const hasPreviewPane = () => !isEditing() || isSplit();

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

	/**
	 * The one gate on `tocActiveLine`. With `settings.tocFollows` set to
	 * 'cursor' and a cursor the reader can see (the editor is on screen, or
	 * `settings.previewCursor` draws one the reader placed in the preview), only
	 * the cursor moves the outline, and scrolling either pane leaves it where it
	 * is. Otherwise the pane that scrolled last decides. In the preview alone
	 * with `previewCursor` off, the editor's last cursor is kept for Ctrl+E but
	 * not followed: nothing on screen would say why the outline stopped.
	 *
	 * A preview that is not on screen never decides: in the editor alone it is
	 * still mounted at zero width, and its scroll events report lines from that
	 * layout, which put the outline on the wrong heading after Ctrl+E (#799).
	 * Nor does a preview Ctrl+E has just brought back, until
	 * `restoreAfterLeavingEditor` has placed it: its scroll events before that
	 * report the first headings.
	 */
	function followToc(from: 'cursor' | 'editor' | 'preview', line: RendererLine) {
		const cursorLeads = settings.tocFollows === 'cursor' && (hasEditorPane() || (settings.previewCursor && activeCursor() !== null));
		const previewSettled = hasPreviewPane() && !previewPlacing;
		const accepted = from === 'cursor' ? cursorLeads : !cursorLeads && (from === 'editor' || previewSettled);
		if (accepted) tocActiveLine = line;
	}

	/** True from Ctrl+E out of the editor until the preview is placed. */
	let previewPlacing = false;

	/**
	 * Each tab's cursor, shared by its two panes (#799): the editor's while it
	 * is on screen, and with `settings.previewCursor` a click in the preview
	 * moves it too. With that setting the preview draws it, and Ctrl+E puts the
	 * editor's cursor on it. A tab only read so far has none.
	 */
	let cursorByTab = $state<Record<string, { line: BufferLine; column: number }>>({});
	const activeCursor = () => (tabManager.activeTabId && cursorByTab[tabManager.activeTabId]) || null;

	function handleEditorCursor(line: BufferLine, column: number) {
		if (tabManager.activeTabId) cursorByTab[tabManager.activeTabId] = { line, column };
		followToc('cursor', o.lineCoords.toRendererLine(line));
	}

	function placePreviewCursor(e: MouseEvent) {
		const tabId = tabManager.activeTabId;
		const previewBlocks = o.previewBlocks;
		if (!tabId || !previewBlocks || !settings.previewCursor || e.detail !== 1) return;
		if (!window.getSelection()?.isCollapsed) return;

		const caret = document.caretRangeFromPoint(e.clientX, e.clientY);
		const point = caret && sourceAtPoint(previewBlocks, { node: caret.startContainer, offset: caret.startOffset }, o.readRendererLine);
		if (!point) return;

		const line = o.lineCoords.toBufferLine(point.line);
		cursorByTab[tabId] = { line, column: point.column };
		followToc('cursor', point.line);
		if (isSplit()) o.editorPane?.setCursor(line, point.column);
	}

	function handleEditorScrollSync(position: ScrollSyncPosition) {
		// The line the tab would record as its reading position, not the line
		// the viewport cuts in half: `tabAnchorForEditorTopLine` is the one
		// crossing from a Monaco top line into the outline's numbering (it
		// counts from the body, and sits `EDITOR_ANCHOR_LINE_OFFSET` lines
		// down). Handing over the raw top line left the outline one entry
		// behind whenever a heading was the first line on screen (#744).
		if (position.line !== undefined) {
			followToc('editor', tabAnchorForEditorTopLine(o.lineCoords, asBufferLine(position.line)));
		}

		if (splitScrollSyncOn()) {
			o.scrollPreviewToSyncPosition(position);
		}
	}

	/**
	 * Scroll sync is a split-view feature, and `isScrollSynced` outlives the
	 * split: it is the tab's remembered choice for the next one. Out of split
	 * the other pane is still mounted at zero width, so a position mapped
	 * through it drags the visible pane off the line Ctrl+E put it on (#799).
	 */
	function splitScrollSyncOn() {
		const tab = tabManager.activeTab;
		return !!tab?.isSplit && tab.isScrollSynced;
	}

	function syncEditorToPreviewScroll(target: HTMLElement) {
		const editorPane = o.editorPane;
		if (!splitScrollSyncOn() || !editorPane) return;

		const position = o.getPreviewScrollSyncPosition(target);
		editorPane.syncScrollToPosition(position);
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
		if (!tab) return;

		if (isEditing()) {
			// Back to reading. The preview renders the buffer, not the file, so no
			// save is needed (#168). The tab stays dirty, and closing it or the
			// window (`settleForExit`) still asks.
			await flushBeforeLeavingEditableMode(tab);
			// Ctrl+E lands on the line the other pane was showing, mapped the way
			// split view maps it (#799).
			const position = o.editorPane?.scrollSyncPosition() ?? null;
			previewPlacing = position !== null;
			tab.isEditing = false;
			await renderPreviewLeavingEditableMode(tab);
			if (position) void restoreAfterLeavingEditor(tab.id, position);
		} else {
			// Switch to edit
			const markdownBody = o.markdownBody;
			const position = markdownBody ? o.getPreviewScrollSyncPosition(markdownBody) : null;
			if (tab.path !== '') {
				if (tab.isDirty) {
					// Unsaved edits are already in memory (made in reading
					// mode, or kept when leaving the editor with auto-save
					// off). Reading from disk would overwrite them, so only
					// switch.
					tab.isEditing = true;
				} else {
					const mayApply = claimTabForRead(tab.id);
					try {
						// This buffer is about to be handed to the editor, and
						// the editor arms auto-save. The checked command is what
						// says whether the decode was lossy, so the tab carries
						// its own verdict instead of relying on the one
						// `loadMarkdown` left behind — a file can be converted
						// to UTF-8 (or away from it) between the two reads.
						const [content, lossy, encoding] = await readFile(tab.path);
						// A task ticked, or the tab closed, while this was out.
						if (!mayApply()) return;
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
			if (position && tab.isEditing) {
				await tick();
				o.editorPane?.syncScrollToPosition(position, { cursorIntoView: settings.tocFollows === 'cursor' });
			}
		}
	}

	/**
	 * The preview half of #799. The restore effect cannot do it: the article
	 * stays mounted at zero width in edit mode, so nothing it depends on changes
	 * with the mode. The pane takes its real width in the same frame (its slide
	 * is a `transform`, see `utils/paneSlide.ts`), so the line is placed right
	 * after the render, before the old position is ever painted.
	 */
	async function restoreAfterLeavingEditor(tabId: string, position: ScrollSyncPosition) {
		await tick();
		previewPlacing = false;
		const body = o.markdownBody;
		if (!body || tabManager.activeTab?.id !== tabId || tabManager.activeTab.isEditing) return;
		o.scrollPreviewToSyncPosition(position);
		// That scroll is marked programmatic, so the tab's anchor and the
		// outline's current entry are written here.
		const anchorLine = o.getPreviewScrollAnchor(body);
		if (anchorLine !== null) {
			tabManager.updateTabAnchorLine(tabId, anchorLine);
			followToc('preview', anchorLine);
		}
	}

	/**
	 * A jump the editor has not been asked for yet, because it does not exist
	 * yet: `toggleEdit` only flips a flag, and the `Editor` it mounts — and the
	 * `editorPane` binding that reaches it — arrive on the next render. The
	 * viewer's effect spends it the moment they do, and immediately when the
	 * editor is already on screen (split view).
	 */
	let pendingEditReveal = $state<BufferLineRange | null>(null);

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
	 * What ⌘E means, from every entry point that offers it — the hotkey, the
	 * toolbar, the title bar, and Monaco's own command.
	 *
	 * One function so the chord cannot mean two things depending on where the
	 * caret happens to be (`shortcuts.checks.test.ts` holds the two layers
	 * together), and so "take me to the editor" behaves the same whether the
	 * reader asked for it with a key or with a menu item.
	 */
	async function toggleEditView() {
		const selected = getSelectionSourceRange();

		if (!hasPreviewPane()) {
			// The editor is already the whole window: nowhere further to take
			// the reader, so this is the toggle back out.
			await toggleEdit();
			return;
		}

		if (isSplit() && !selected) {
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

		// Reading, or split with a selection: same as the context menu's "Edit".
		await editSourceRange(selected);
	}

	/**
	 * Open the editor on `range`. Toggles into edit mode when `isEditing` is
	 * false, including split view entered from reading mode.
	 */
	async function editSourceRange(range: LineRange | null) {
		if (!isEditing()) await toggleEdit();
		// `toggleEdit` swallows a failed read and stays in reading mode. Arming
		// the jump anyway would fire it at whatever document is edited next.
		if (range && tabManager.activeTab?.isEditing) pendingEditReveal = o.lineCoords.toBufferRange(range);
	}

	/**
	 * The context menu's "Edit" for the right-click `e`. The target is resolved
	 * now rather than inside the click handler: by the time that runs the
	 * reader has clicked a menu item, and a click is how a selection goes away.
	 */
	function editSourceRangeAt(e: MouseEvent) {
		const target = getContextMenuSourceRange(e);
		return () => editSourceRange(target);
	}

	async function toggleSplitView(tabId: string) {
		const tab = tabManager.tabs.find((t) => t.id === tabId);
		if (!tab) return;

		if (!tab.isSplit) {
			// Split view is an editor, and its first keystroke arms auto-save.
			// The buffer must be complete first (not empty, not a large file's
			// partial read), or auto-save writes a truncated file.
			if (tab.path && !tab.isEditing && !tab.rawContent) {
				const mayApply = claimTabForRead(tab.id);
				try {
					// Checked, like every other read that fills an editable
					// buffer: split view is an editor, so this tab must carry
					// the fidelity of its own decode rather than inherit one.
					const [content, lossy, encoding] = await readFile(tab.path);
					if (!mayApply()) return;
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
		} else {
			// Like leaving edit mode: the surviving pane renders the buffer, so
			// nothing is saved or asked.
			await flushBeforeLeavingEditableMode(tab);
			tabManager.setSplitEnabled(tab.id, false);
			await renderPreviewLeavingEditableMode(tab);
		}
	}

	/** The title bar's three mode buttons (#806): go straight to one, from any. */
	async function setViewMode(target: ViewMode) {
		const tab = tabManager.activeTab;
		if (!tab || viewModeOf(tab) === target) return;
		if (target === 'split') return toggleSplitView(tab.id);
		if (!tab.isSplit) return target === 'edit' ? toggleEditView() : toggleEdit();
		// Leaving split: the editor is already on screen and holds the full
		// buffer, so Edit only drops the preview. Preview goes through the
		// normal close, which flushes and renders.
		if (target === 'edit') {
			tab.isEditing = true;
			tabManager.setSplitEnabled(tab.id, false);
			return;
		}
		tab.isEditing = false;
		await toggleSplitView(tab.id);
	}

	return {
		get tocActiveLine() {
			return tocActiveLine;
		},
		get activeCursor() {
			return activeCursor();
		},
		get pendingEditReveal() {
			return pendingEditReveal;
		},
		set pendingEditReveal(range: BufferLineRange | null) {
			pendingEditReveal = range;
		},
		followToc,
		handleEditorCursor,
		placePreviewCursor,
		handleEditorScrollSync,
		syncEditorToPreviewScroll,
		toggleEdit,
		restoreAfterLeavingEditor,
		getContextMenuSourceRange,
		toggleEditView,
		editSourceRange,
		editSourceRangeAt,
		toggleSplitView,
		setViewMode,
	};
}
