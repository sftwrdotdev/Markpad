import { t } from '../utils/i18n.js';
import { nextUntitledTitle } from '../utils/untitledTitle.js';
import { settings } from './settings.svelte.js';
import { hasRealFilePath } from '../utils/tabFileActions.js';
import { HOME_TAB_PATH, isHomePath } from '../utils/homeTab.js';
import { buildTransferredTab, type TransferableTab } from '../utils/tabTransfer.js';
import { canonicalizePath, isSameFilePath } from '../utils/pathIdentity.js';
import { asRendererLine, type RendererLine } from '../utils/lineCoordinates.js';
import { outgoingTabAnchorLine } from '../utils/editorPosition.js';
import { retainTabModels } from '../utils/tabModels.js';
import {
	canGoBackInHistory,
	canGoForwardInHistory,
	createFileHistory,
	goBackInHistory,
	goForwardInHistory,
	navigateFileHistory,
	replaceCurrentHistoryEntry,
} from '../utils/tabHistory.js';

export interface Tab {
	id: string;
	path: string;
	/**
	 * What the tab strip, the window title and the per-tab close dialog call
	 * this tab. Derived from `path` at every site that points a tab at a
	 * document — `addTab`, `restoreState`, `updateTabPath`, `renameTab`,
	 * `navigate`, `goBack`, `goForward` — as the last segment of the path, and
	 * chosen by `nextUntitledTitle` when there is no path to take a segment
	 * from.
	 *
	 * Five of those sites spell the derivation `path.split(/[/\\]/).pop() ||
	 * 'Untitled'`, and that English literal is dead code, not an i18n hole. It
	 * is there because `Array.prototype.pop` is typed `string | undefined`; the
	 * arm needs a path that is empty or ends in a separator, and every route
	 * into those five is guarded against both upstream:
	 *
	 * - `navigate` is only ever handed a link target, and `getMarkdownLinkTarget`
	 *   refuses an href whose path does not end in one of
	 *   `MARKDOWN_LINK_EXTENSIONS`, so what `resolveMarkdownTargetPath` returns
	 *   always ends in a filename.
	 * - `goBack`/`goForward` return on `!result.path` before the title is
	 *   touched, so an empty entry cannot reach it — and every non-empty entry
	 *   in `history` was put there by one of the other sites.
	 * - `renameTab` replaces the last segment of a non-empty `tab.path` with a
	 *   non-empty typed name, and only runs once `fs::rename` has SUCCEEDED on
	 *   the result, which a destination ending in a separator cannot do.
	 * - `updateTabPath` is reached from the Save/Save As dialog, which returns
	 *   a file the user named, and from `loadMarkdown` — and there only when
	 *   the active tab is an empty untitled one. The app's one unvalidated path
	 *   source, `send_markdown_path`, hands back raw argv filtered only on a
	 *   leading `-`, so `markpad ~/notes/` really does reach `loadMarkdown`
	 *   with a trailing separator; it cannot reach THIS branch, because
	 *   untitled tabs are not persisted (`serializeState` filters on
	 *   `hasRealFilePath`) and so no empty untitled tab exists at startup for
	 *   argv to repoint. That path lands on `addTab`, which resolves a nameless
	 *   path through `nextUntitledTitle` and `t('tabs.untitled', …)`.
	 *
	 * If a route ever does hand one of them a directory or an empty string, the
	 * fallback to reach for is `t('tabs.untitled', settings.language)` and NOT
	 * `nextUntitledTitle`: numbering exists to tell several NEW untitled buffers
	 * apart, and a tab that got here has a path — calling it "Untitled 3" would
	 * claim otherwise.
	 */
	title: string;
	/**
	 * The three buffers. They are the same shape, they usually hold the same
	 * document, and picking the wrong one loses the user's work.
	 *
	 * `rawContent` IS the document — the Markdown as it stands right now. The
	 * editor shows it and writes every keystroke back through
	 * `updateTabRawContent`, the preview and the HTML export render from it,
	 * and it is the exact string `saveContent` hands to `save_file_content`.
	 * Anything that reads or changes the user's text wants this one.
	 *
	 * `originalContent` is that same buffer as it last came off, or last went
	 * onto, disk. It exists only to answer "changed?": `isDirty` IS
	 * `rawContent !== originalContent` — a getter, not a field, so the two
	 * cannot disagree — and discarding edits is `rawContent = originalContent`
	 * (`canCloseTab`). Write it to a file and you save the last-saved text over
	 * the user's unsaved edits; overwrite it and the edits stop even looking
	 * unsaved, which is why `resolveExternalChange` refuses to reload a dirty
	 * tab.
	 *
	 * `content` is not Markdown at all. It is the rendered preview HTML, cached
	 * per tab and re-sanitized at the sink (`sanitizedHtml`). It is allowed to
	 * lag `rawContent`, and routinely does — nothing re-renders in plain edit
	 * mode with the TOC closed, which is what `syncPreviewForPrint` exists to
	 * repair. So it answers "what is on screen", never "what does the document
	 * say", and it must never reach a file.
	 *
	 * A clean tab is not necessarily a copy of its file: a partial or failed
	 * read puts the same prefix — or `''` — in BOTH buffers, so "not dirty"
	 * means "no unsaved edits", not "matches disk". See `isTruncated`.
	 */
	content: string;
	rawContent: string;
	originalContent: string;
	/** Preview pixels — the coarsest of three position fields. See `scrollPercentage`. */
	scrollTop: number;
	/**
	 * Derived, never assigned: exactly `rawContent !== originalContent`, read
	 * off the two buffers every time. Each construction site below spells it as
	 * a getter, which is why this is `readonly` — `tab.isDirty = false` is now
	 * a compile error rather than a fourth opinion about what "changed" means.
	 *
	 * It used to be a plain field that nine sites maintained by hand, in three
	 * different ways, and every one of them was really saying one of two
	 * things: "this text is the saved text now" (`originalContent = rawContent`,
	 * which the navigation routes below still say) or nothing at all, because
	 * the buffers already agreed. A flag that can be set independently of the
	 * buffers it summarises can be wrong about them, and the tab close dialog,
	 * the auto-save trigger and the reload guard all believe it.
	 */
	readonly isDirty: boolean;
	isEditing: boolean;
	/**
	 * Back/forward navigation, not undo — despite sitting next to three text
	 * buffers. The entries are file PATHS this tab has shown (see
	 * `navigate` below and tabHistory.ts), and `historyIndex` is the current
	 * position in them. Text undo belongs to Monaco's model, not to the tab.
	 */
	history: string[];
	historyIndex: number;
	editorViewState: any; // monaco.editor.ICodeEditorViewState | null
	/**
	 * Where the reader was, written down three ways because none of them
	 * survives everything. Re-activating a tab tries them in that order and
	 * stops at the first that resolves; the editor tries `editorViewState`,
	 * then `anchorLine`, then `scrollPercentage`, and never reads `scrollTop`.
	 *
	 * `anchorLine` is a SOURCE line, so it is the only one that still means
	 * anything once the layout changes — a re-render, a fold, a resize, a swap
	 * between the two panes. Reach for it first.
	 *
	 * A RENDERER line specifically, which is why it carries the brand. It is
	 * written by `getPreviewScrollAnchor`, whose numbers come straight off
	 * `data-sourcepos`, and read back by `findAnchorElement` against the same
	 * attributes — both sides count from the first line of the BODY, not of the
	 * file. Anything that wants to aim the EDITOR with it owes a
	 * `lineCoordinates(raw).toBufferLine(...)` first, and the brand is what
	 * makes forgetting that a type error instead of a document that opens the
	 * height of its own front matter off (#607).
	 *
	 * The editor writes it too, and pays that toll in both directions:
	 * `tabAnchorForEditorTopLine` on the way in, `editorTopLineForTabAnchor` on
	 * the way out. It used to write a raw Monaco line here, which is why the
	 * paragraph above is worth reading twice.
	 *
	 * `scrollPercentage` is a 0-1 fraction of the scrollable range. It survives
	 * a container of some other height, but it drifts with the content: the
	 * "rough percentage of the document instead of where you left off" that
	 * #420 added `anchorLine` to fix.
	 *
	 * `scrollTop` is raw pixels in the preview container, exact only while that
	 * DOM is still that size. It also drives `isScrolled` (the title bar
	 * shadow), which is why a programmatic scroll updates it and nothing else.
	 *
	 * They are not three views of one value. Each writer updates a different
	 * subset — a user scroll of the preview writes all three, a programmatic
	 * one only `scrollTop`, closing the editor only the other two — so the most
	 * recently written is not the most precise, and one of them can be current
	 * while its neighbours are not. None of them scrolls anything when
	 * assigned: the restore runs on tab activation, not on write.
	 *
	 * Because a cascade stops at its first resolved entry, they can only be
	 * INVALIDATED as a set — pointing the tab at another document clears all of
	 * them, and `editorViewState`, through `clearReadingPosition`.
	 */
	scrollPercentage: number;
	anchorLine: RendererLine;
	/**
	 * Where the reader was standing before each in-page jump, and where they
	 * came back from — the two stacks the mouse's back and forward buttons
	 * walk. Raw preview pixels, in the same space as `scrollTop`: pushed by
	 * every anchor jump (a heading in the outline, a link into the same
	 * document), popped by `popScrollHistoryBack` / `popScrollHistoryForward`.
	 *
	 * Nothing to do with `history` / `historyIndex` above, which are the FILE
	 * this tab points at. These two never leave the current document.
	 *
	 * Per tab for the reason the position fields above are per tab: an offset
	 * only means anything in the document it was measured in. One window-wide
	 * pair meant a back click in a short document scrolled it to an offset
	 * recorded in a long one, because a tab switch reloads nothing and so reset
	 * nothing.
	 *
	 * Cleared with the rest of the reading position when the tab is repointed
	 * at another file — see `clearReadingPosition`. A reload of the SAME
	 * document in place is a separate trigger and clears them separately; see
	 * `resetScrollHistory` in documentSession.
	 *
	 * Neither persisted nor carried between windows: pixels measured in one
	 * container are wrong in a container of another height, which is already
	 * why `scrollTop` is the last resort of the restore cascade. A stack of
	 * them is not worth a schema entry. See `serializeState` and tabTransfer.ts.
	 *
	 * Required, like `foldOverrides`: every consumer pushes and pops, so a
	 * construction site that forgot one would hand them `undefined`.
	 */
	scrollHistory: number[];
	scrollFuture: number[];
	isSplit: boolean;
	splitRatio: number;
	isScrollSynced: boolean;
	/**
	 * Which folds in THIS document the reader has changed their mind about.
	 * The entries are the fold keys `foldState.ts` assigns while the preview
	 * markup is built — a heading's id (comrak's slug) falling back to its
	 * trimmed text, and `callout:<title>` for a foldable callout.
	 *
	 * Deviations, not closures. A heading always starts open, so for headings
	 * the two readings are the same set. A callout does not: `> [!note]-` opens
	 * folded, and a set of "what is closed" cannot tell a callout the reader
	 * OPENED from one they never touched — the next render would shut it again.
	 * `isFolded` is the one place the two are combined.
	 *
	 * Per tab, not per window, because a fold key only identifies a fold WITHIN
	 * a document. Every file with an `## Introduction` gets the key
	 * `introduction`, so a single window-wide set folded that section in all of
	 * them at once, kept the key after the document it was folded in was
	 * closed, and pre-folded the next document to contain that heading with
	 * nothing on screen to say why. It is the same class of state as
	 * `scrollTop` / `anchorLine` / `editorViewState`, which live here for the
	 * same reason.
	 *
	 * A tab field also covers untitled buffers, which have no path to key by.
	 *
	 * Per tab is not the same as per document, because a tab can be repointed at
	 * another file without a tab switch — following a link, and back/forward.
	 * Those routes clear this set, together with the reading position above; see
	 * `forgetPreviousDocument`.
	 *
	 * Replace the set to change it — never mutate in place. The preview render
	 * reads this value, and Svelte cannot see a mutation of a Set it is already
	 * holding.
	 *
	 * Required, like `hasReplacementChars`: every consumer calls `.has()` on
	 * it, so a construction site that forgot it would hand them `undefined`.
	 */
	foldOverrides: Set<string>;
	/**
	 * True while `rawContent` holds only the leading slice of a large file
	 * (the >5MB preview read) instead of the whole document. Such a buffer
	 * looks clean and authoritative but writing it back truncates the file,
	 * so every path that can reach disk must complete it first — see
	 * `ensureFullContent` in documentSession. Optional because tabs built
	 * from a cross-window transfer payload always arrive complete.
	 */
	isTruncated?: boolean;
	/**
	 * The `rawContent` the preview in `content` was rendered from — the answer
	 * to "is what is on screen still this document?".
	 *
	 * Its whole job is to let the render effect skip work: a re-render rebuilds
	 * the article and takes the reader's scroll position, fold state and find
	 * highlights with it, so the effect renders only when this does not match
	 * `rawContent`. Which also makes it a claim anyone may make on the
	 * preview's behalf: `toggleTaskCheckbox` updates the DOM by hand and then
	 * says so here, and that is the one place outside the viewer allowed to.
	 *
	 * Not the same question as `content !== ''`. `content` is the rendered
	 * HTML and is allowed to lag; this says whether it lags.
	 *
	 * Optional, and absent is the safe direction: "nothing has been rendered
	 * from this buffer", which costs one render. It lived on the tab as an
	 * undeclared `_lastRenderedRawContent` reached through `as any` from two
	 * files, which is the same field with nothing to check the spelling of it.
	 */
	previewedRawContent?: string;
	/**
	 * `rawContent` was decoded with U+FFFD substitutions because NO encoding
	 * could read the file: a truncated multi-byte tail, or bytes that are not
	 * text at all. Not merely "not UTF-8" — a legacy codepage is detected and
	 * decoded (see `encoding`), which is what #372 was about. The buffer is
	 * NOT a copy of the file and the original bytes cannot be recovered from
	 * it, so writing it back over that file destroys the document —
	 * documentSession.saveContent refuses to. Required, not optional: unlike
	 * `isTruncated` above, this one
	 * DOES travel through a transfer payload, and a construction site that
	 * forgets it would default to "safe to overwrite" — the failure mode here
	 * is a destroyed document, so the compiler asks every one of them.
	 */
	hasReplacementChars: boolean;
	/**
	 * The encoding `rawContent` was decoded from, and the one a save writes it
	 * back as: `UTF-8` (the default, and everything Markpad creates itself),
	 * `UTF-8-BOM`, `UTF-16LE`, `UTF-16BE`, or a WHATWG label for a legacy
	 * codepage — `GBK`, `Big5`, `Shift_JIS`, `windows-1252`. Set by whichever
	 * read filled the buffer; the Rust `decode_text` decides it.
	 *
	 * Required for the same reason as `hasReplacementChars`: a construction
	 * site that forgot it would silently rewrite a legacy document as UTF-8 —
	 * not the data loss #372 reported, but still a change to the user's file
	 * that nobody asked for and that other tools would notice.
	 */
	encoding: string;
	/**
	 * `path` as the FILESYSTEM identifies it: case folded, Unicode normalized
	 * and symlinks resolved, the way the volume itself does those (see the Rust
	 * `canonical_identity`). This is what "same file" means; `path` stays
	 * exactly what the user opened.
	 *
	 * The two are separate fields rather than one canonical `path` because
	 * canonicalization is lossy in a way the user can see: it would retitle a
	 * tab opened through a symlink after the link's target, rewrite the recent
	 * files list and "Copy path" with a name the user never typed, and mutate
	 * `path` on its own whenever a file is deleted and recreated under another
	 * spelling. A path also cannot always be canonicalized — Save As names a
	 * file that does not exist yet — so a single field would be canonical only
	 * *sometimes*, which is worse than a second field that is explicitly either
	 * known or not.
	 *
	 * Optional, and the safe direction: absent means "not resolved", and every
	 * comparison then falls back to exact path equality — what it did before.
	 * A construction site that forgets it therefore loses the improvement and
	 * nothing else, which is why this is `?` where `hasReplacementChars`, whose
	 * missing value would read as "safe to overwrite", is not.
	 */
	pathKey?: string;
}

/** How many in-page jumps back a tab remembers. See `Tab.scrollHistory`. */
const SCROLL_HISTORY_LIMIT = 50;

class TabManager {
	tabs = $state<Tab[]>([]);
	activeTabId = $state<string | null>(null);
	windowTag = $state<{ name: string; color: string; pinned: boolean } | null>(null);

	/**
	 * The sticky "does a new split start scroll-locked" answer, stored as
	 * `settings.splitScrollSync` and named here for the tab code that seeds a
	 * split from it — `Tab.isScrollSynced` is the per-tab value, and the two
	 * names being different is the point.
	 *
	 * It used to be a `$state` here with a bare `localStorage.setItem` beside
	 * it. One key and one write, so it could not clobber its neighbours the way
	 * the three writers #618 collected did — but nothing listened for `storage`,
	 * so a second window kept its own answer until it was restarted, while every
	 * other preference synced live. Reaching through the settings store is what
	 * makes it a persisted entry like the rest: compare-and-set on write, and
	 * the store's own `storage` listener folding in what the siblings did.
	 */
	get splitScrollSyncPreference(): boolean {
		return settings.splitScrollSync;
	}

	set splitScrollSyncPreference(value: boolean) {
		settings.splitScrollSync = value;
	}

	get activeTab() {
		return this.tabs.find((t) => t.id === this.activeTabId);
	}

	setWindowTag(tag: { name: string; color: string; pinned?: boolean } | null) {
		this.windowTag = tag ? { ...tag, pinned: tag.pinned === true } : null;
	}

	/**
	 * Serialize WINDOW state only: which files are open, the active tab, and
	 * per-tab UI (edit mode, split, scroll). Document content always lives on
	 * disk — the snapshot never carries rawContent, so unsaved changes are
	 * handled exclusively by the close dialogs, never smuggled through here.
	 * Untitled tabs have no disk backing and are resolved at close, so they
	 * are not persisted.
	 *
	 * The filter is `hasRealFilePath`, not `path !== ''`: the home screen sits
	 * in a tab whose path is `HOME_TAB_PATH`, which passes the non-empty test
	 * and used to be written into the snapshot. Restoring it then asked the
	 * backend to read a file under that name, and the failure left a
	 * permanently unreadable phantom tab — or, when the home tab was the only
	 * one, a window that came back empty.
	 *
	 * `foldOverrides` is deliberately NOT in here. Every other field written
	 * below describes the window and survives whatever happened to the file
	 * while Markpad was closed; a fold key describes a heading in a particular
	 * revision of the document. The restore reads the file fresh from disk, so
	 * a document edited in the meantime would come back with sections hidden
	 * that the user never folded in the text now on screen — the failure this
	 * per-tab state exists to remove. Scroll degrades (you scroll); a fold
	 * hides text.
	 *
	 * Nor are `scrollHistory`/`scrollFuture`. Those are pixels too, but unlike
	 * `scrollTop` they are not a position to approximate — they are a record of
	 * jumps the reader made in a session that has ended, in a window that may
	 * come back a different size. Restoring them would arm the back button with
	 * offsets nobody in this session created.
	 */
	serializeState(): string {
		const stateData = {
			version: 2,
			windowTag: this.windowTag,
			activeTabId: this.activeTabId,
			tabs: this.tabs
				.filter((t) => hasRealFilePath(t.path))
				.map((t) => ({
					id: t.id,
					path: t.path,
					title: t.title,
					isEditing: t.isEditing,
					isSplit: t.isSplit,
					splitRatio: t.splitRatio,
					isScrollSynced: t.isScrollSynced,
					scrollTop: t.scrollTop,
					scrollPercentage: t.scrollPercentage,
					// Not `t.anchorLine`: a tab left in edit-only mode in the
					// background has had no writer since it stopped being active,
					// and its Monaco view state — which knows where it was, and
					// which is not in the object above — is about to be dropped.
					// `outgoingTabAnchorLine` recovers the line from it for that
					// population and hands back `t.anchorLine` for every other.
					anchorLine: outgoingTabAnchorLine(t, this.activeTabId)
				}))
		};
		return JSON.stringify(stateData);
	}

	/**
	 * Rebuild clean tabs from a window-state snapshot. Content starts empty —
	 * the caller reads each file from disk afterwards. Also accepts the legacy
	 * full-tab format, from which only the window-state fields are taken
	 * (legacy untitled entries are dropped).
	 *
	 * Entries are accepted only for real file paths. Snapshots written by
	 * earlier builds can still contain `HOME_TAB_PATH`, so the read side has to
	 * reject it too — otherwise those users keep restoring a tab that can never
	 * be read.
	 */
	restoreState(jsonBuffer: string) {
		try {
			const data = JSON.parse(jsonBuffer);
			if (!data || !Array.isArray(data.tabs)) return;
			if (
				data.windowTag &&
				typeof data.windowTag.name === 'string' &&
				data.windowTag.name !== '' &&
				typeof data.windowTag.color === 'string'
			) {
				this.setWindowTag({
					name: data.windowTag.name,
					color: data.windowTag.color,
					pinned: data.windowTag.pinned === true,
				});
			}

			const restored: Tab[] = [];
			for (const saved of data.tabs) {
				if (!saved || typeof saved.path !== 'string' || !hasRealFilePath(saved.path)) continue;
				const filename = saved.path.split('\\').pop()?.split('/').pop() || saved.path;
				const fileHistory = createFileHistory(saved.path);
				restored.push({
					id: typeof saved.id === 'string' ? saved.id : crypto.randomUUID(),
					path: saved.path,
					title: typeof saved.title === 'string' && saved.title !== '' ? saved.title : filename,
					content: '',
					rawContent: '',
					originalContent: '',
					scrollTop: typeof saved.scrollTop === 'number' ? saved.scrollTop : 0,
					get isDirty() {
						return this.rawContent !== this.originalContent;
					},
					isEditing: saved.isEditing === true,
					history: fileHistory.history,
					historyIndex: fileHistory.historyIndex,
					editorViewState: null,
					scrollPercentage: typeof saved.scrollPercentage === 'number' ? saved.scrollPercentage : 0,
					// The brand is phantom, so nothing of it survives JSON — which is
					// exactly why the read side has to re-declare what came back.
					// `serializeState` wrote a renderer line; this says so again.
					anchorLine: asRendererLine(typeof saved.anchorLine === 'number' ? saved.anchorLine : 0),
					// Not persisted — see serializeState.
					scrollHistory: [],
					scrollFuture: [],
					isSplit: saved.isSplit === true,
					splitRatio: typeof saved.splitRatio === 'number' ? saved.splitRatio : 0.5,
					isScrollSynced: saved.isScrollSynced === true,
					// Not persisted — see serializeState.
					foldOverrides: new Set<string>(),
					isTruncated: false,
					hasReplacementChars: false,
					encoding: 'UTF-8'
				});
			}

			this.tabs = restored;
			this.activeTabId = restored.some((t) => t.id === data.activeTabId)
				? data.activeTabId
				: restored[0]?.id ?? null;
			// Every tab that was open is gone, replaced wholesale — the one tab
			// removal in this file that never calls `closeTab`.
			this.releaseModelsOfRemovedTabs();
			// Snapshots store paths as they were typed, and the restore reads
			// each file directly rather than through `loadMarkdown`, so nothing
			// else would ever resolve these. Without this a restored window sits
			// outside the one-tab-per-file rule until every tab happens to be
			// reopened. Resolving in the background is safe because it only ever
			// ADDS an identity — no tab is closed or reassigned here.
			for (const tab of restored) {
				void canonicalizePath(tab.path).then((key) => this.setTabPathKey(tab.id, tab.path, key));
			}
		} catch (e) {
			console.error('Failed to restore tab state', e);
		}
	}

	/**
	 * A file path identifies a tab: at most one tab per window may hold a given
	 * path. Two tabs on the same file are two independent buffers with two
	 * independent dirty flags and two auto-save timers writing the same file in
	 * turn, so whichever lands last silently overwrites the other's work — and
	 * the store is the only place that can rule it out, because every duplicate
	 * arrives through a different caller (a link opened in a new tab, Save As
	 * onto an open file, a tab moved in from another window).
	 *
	 * Mainstream editors make this state unrepresentable rather than merely
	 * unlikely: VS Code keys one `ITextModel` per file URI and points every
	 * editor at it, and Sublime Text's Open File links to the view that already
	 * holds the buffer (`clone_file` makes a second VIEW of the SAME buffer,
	 * never a second buffer). Markpad has no buffer/view split — a tab is the
	 * buffer — so the equivalent invariant is one tab per path.
	 *
	 * Resolving a conflict must not cost the user anything, so the loser is
	 * handled by what it has to lose:
	 * - clean: closed, since its buffer is a copy of the file the winner now
	 *   holds. It lands on the reopen-closed-tab stack like any other close.
	 * - dirty: kept, with its buffer intact, but its claim on the path is
	 *   released (it becomes untitled). Nothing is discarded and nothing can
	 *   auto-save over the file behind the user's back; saving it asks where to
	 *   put it, which is the one decision only the user can make.
	 *
	 * Only real file paths are exclusive: untitled tabs (`''`) and the home
	 * sentinel are not files, and several untitled tabs are normal.
	 *
	 * "The same path" means the same FILE, not the same string: `/notes/A.md`
	 * and `/notes/a.md` are one file on macOS and Windows, and two tabs on them
	 * are exactly the two auto-save timers this rule exists to prevent. The
	 * caller supplies `pathKey` — the filesystem's own answer, resolved once
	 * when the path entered the app — and `isSameFilePath` falls back to exact
	 * equality when either side does not have one, which is what the callers
	 * that cannot resolve a path yet get.
	 */
	private claimPath(path: string, claimantId: string, pathKey?: string) {
		if (!hasRealFilePath(path)) return;
		const incoming = { path, pathKey };
		for (const other of this.tabs.filter((t) => t.id !== claimantId && isSameFilePath(t, incoming))) {
			if (!other.isDirty) {
				this.closeTab(other.id);
				continue;
			}
			other.path = '';
			// The buffer no longer claims a file, so it must not keep the file's
			// identity either — a stale key would make this tab collide with the
			// next tab to open that file.
			other.pathKey = undefined;
			// The title still names the file the buffer came from — that is what
			// makes the tab recognizable, and `saveContent` offers it as the
			// default filename when the user places it.
			// It has no path now, so it has no history entry: the tab is untitled,
			// and `''` is not somewhere Back can take the reader.
			other.history = [];
			other.historyIndex = 0;
		}
	}

	/**
	 * `rawContent` is the Markdown this tab starts with — the file's text, or
	 * `''` for a tab whose file is read afterwards, which is what both callers
	 * in the app do. It is NOT the rendered `content`: that starts empty here
	 * as it does at every other construction site (`addNewTab`, `restoreState`,
	 * `addHomeTab`, `buildTransferredTab`), and the first preview render fills
	 * it. Seeding it from this argument put Markdown in the field that is
	 * injected via `{@html}` — sanitized at the sink, so it showed as escaped
	 * source rather than being a hole, but it is not what that field means.
	 */
	addTab(path: string, rawContent: string = '', pathKey?: string) {
		// Opening a file that is already open activates that tab instead of
		// building a second buffer for it — VS Code and Sublime Text both
		// resolve an open request to the existing view. `rawContent` is ignored
		// in that case on purpose: the open tab may hold unsaved edits, and a
		// freshly read copy of the file would erase them.
		if (hasRealFilePath(path)) {
			const existing = this.tabs.find((t) => isSameFilePath(t, { path, pathKey }));
			if (existing) {
				this.activeTabId = existing.id;
				return;
			}
		}

		const id = crypto.randomUUID();
		const filename =
			path.split('\\').pop()?.split('/').pop() ||
			nextUntitledTitle(
				this.tabs.map((tab) => tab.title),
				t('tabs.untitled', settings.language),
			);
		const fileHistory = createFileHistory(path);

		this.tabs.push({
			id,
			path,
			title: filename,
			content: '',
			rawContent,
			originalContent: rawContent,
			scrollTop: 0,
			get isDirty() {
				return this.rawContent !== this.originalContent;
			},
			isEditing: false,
			history: fileHistory.history,
			historyIndex: fileHistory.historyIndex,
			editorViewState: null,
			scrollPercentage: 0,
			anchorLine: asRendererLine(0),
			scrollHistory: [],
			scrollFuture: [],
			isSplit: false,
			splitRatio: 0.5,
			isScrollSynced: false,
			foldOverrides: new Set<string>(),
			isTruncated: false,
			hasReplacementChars: false,
			encoding: 'UTF-8',
			pathKey
		});

		this.activeTabId = id;
	}

	addNewTab() {
		const id = crypto.randomUUID();
		const content = '';

		this.tabs.push({
			id,
			path: '',
			title: nextUntitledTitle(
				this.tabs.map((tab) => tab.title),
				t('tabs.untitled', settings.language),
			),
			content,
			rawContent: content,
			originalContent: content,
			scrollTop: 0,
			get isDirty() {
				return this.rawContent !== this.originalContent;
			},
			isEditing: settings.newFileDefaultMode,
			// Empty, as `addHomeTab` below already had it. This used to be
			// `[content]` — a PATH list seeded with the new buffer's text, which
			// is `''` and so looked harmless, and was not: see
			// `navigateFileHistory`.
			history: [],
			historyIndex: 0,
			editorViewState: null,
			scrollPercentage: 0,
			anchorLine: asRendererLine(0),
			scrollHistory: [],
			scrollFuture: [],
			isSplit: false,
			splitRatio: 0.5,
			isScrollSynced: false,
			foldOverrides: new Set<string>(),
			isTruncated: false,
			hasReplacementChars: false,
			encoding: 'UTF-8'
		});

		this.activeTabId = id;
	}

	addHomeTab() {
		const homeTab = this.tabs.find(t => isHomePath(t.path));
		if (homeTab) {
			this.activeTabId = homeTab.id;
			return;
		}

		const id = crypto.randomUUID();
		this.tabs.push({
			id,
			path: HOME_TAB_PATH,
			title: t('tabs.home', settings.language),
			content: '',
			rawContent: '',
			originalContent: '',
			scrollTop: 0,
			get isDirty() {
				return this.rawContent !== this.originalContent;
			},
			isEditing: false,
			history: [],
			historyIndex: 0,
			editorViewState: null,
			scrollPercentage: 0,
			anchorLine: asRendererLine(0),
			scrollHistory: [],
			scrollFuture: [],
			isSplit: false,
			splitRatio: 0.5,
			isScrollSynced: false,
			foldOverrides: new Set<string>(),
			isTruncated: false,
			hasReplacementChars: false,
			encoding: 'UTF-8'
		});

		this.activeTabId = id;
	}

	/**
	 * Insert a tab that arrived from another window (cross-window transfer).
	 * The snapshot carries the unsaved buffer — see tabTransfer.ts. Rendered
	 * content starts empty (the caller re-renders); untitled arrivals are
	 * re-numbered against THIS window's tabs. Independent of serializeState/
	 * restoreState, which persist window shape only.
	 */
	insertTransferredTab(snap: TransferableTab): string {
		const tab = buildTransferredTab(
			snap,
			this.tabs.map((tab) => tab.title),
			t('tabs.untitled', settings.language),
		);
		// The destination window may already have this file open, which would
		// leave the arriving buffer and the resident one saving over each other.
		// The payload carries the path as the source window had it, not its
		// identity, so this first claim compares literally.
		this.claimPath(tab.path, tab.id);
		this.tabs.push(tab);
		this.activeTabId = tab.id;
		// A transferred tab is never read from disk here — its buffer came with
		// it — so nothing else would ever resolve its path, and it would sit out
		// the one-tab-per-file rule for as long as it stayed open. Resolving it
		// in the background cannot undo the claim above, but it does let every
		// LATER open of the same file recognise this tab.
		void canonicalizePath(tab.path).then((key) => this.setTabPathKey(tab.id, tab.path, key));
		return tab.id;
	}

	/**
	 * Release the Monaco models of tabs that no longer exist.
	 *
	 * Called after every removal rather than paired with each one, because the
	 * question it asks — "which models have no tab?" — is answered from the tab
	 * list, so a route that removes a tab in some way not listed below is still
	 * covered. A model that is dropped without `dispose()` is not collected:
	 * Monaco registers it with the model service, and its buffer, tokenization
	 * state and worker-side copy stay alive for the life of the window. See
	 * `utils/tabModels.ts`.
	 *
	 * The three call sites are the three places a tab stops existing: `closeTab`
	 * (the close button, ⌘W, close-others/close-to-the-right, a clean tab losing
	 * its path in `claimPath`, a tab moved to another window, a rolled-back
	 * transfer), `closeAll`, and `restoreState`, which replaces the whole array.
	 *
	 * Whether the model being disposed is the one on screen does not matter
	 * here: Monaco's editor detaches itself from a model that is disposed
	 * (`_attachModel` registers `model.onWillDispose(() => this.setModel(null))`),
	 * and `Editor.svelte` attaches the newly active tab's model in the same
	 * flush.
	 */
	private releaseModelsOfRemovedTabs() {
		retainTabModels(this.tabs.map((tab) => tab.id));
	}

	closeTab(id: string) {
		const index = this.tabs.findIndex((t) => t.id === id);
		if (index === -1) return;

		if (this.activeTabId === id) {
			const fallback = this.tabs[index + 1] || this.tabs[index - 1];
			this.activeTabId = fallback ? fallback.id : null;
		}

		const tab = this.tabs[index];
		if (hasRealFilePath(tab.path)) {
			this.recentlyClosed.push(tab.path);
		}
		this.tabs.splice(index, 1);
		this.releaseModelsOfRemovedTabs();
	}

	closeAll() {
		this.tabs = [];
		this.activeTabId = null;
		this.releaseModelsOfRemovedTabs();
	}

	setActive(id: string) {
		this.activeTabId = id;
	}

	updateTabContent(id: string, content: string) {
		const tab = this.tabs.find((t) => t.id === id);
		if (tab) {
			tab.content = content;
		}
	}

	updateTabRawContent(id: string, raw: string) {
		const tab = this.tabs.find((t) => t.id === id);
		if (tab) {
			tab.rawContent = raw;
		}
	}

	/**
	 * Replace a tab's buffer with what was just read from disk: the new text
	 * becomes both the buffer and the saved baseline, so the tab is clean.
	 *
	 * `isTruncated` says whether that read covered the whole file. It defaults
	 * to false because every caller but the large-file preview read supplies a
	 * complete document, and a stale `true` is the dangerous direction: it
	 * would block saving a file that is actually intact. The opposite mistake
	 * — a partial buffer that claims to be whole — is what truncates files, so
	 * the preview read must pass it explicitly.
	 */
	setTabRawContent(id: string, raw: string, isTruncated = false) {
		const tab = this.tabs.find((t) => t.id === id);
		if (tab) {
			tab.rawContent = raw;
			tab.originalContent = raw;
			tab.isTruncated = isTruncated;
		}
	}

	/**
	 * The tab's file could not be read. The tab stays open with its path — the
	 * file may be on a share that is temporarily down, a drive that is not
	 * plugged in, or a file another program has locked, and none of those are
	 * the user's decision to close a document — but its empty buffer is flagged
	 * incomplete so nothing can mistake it for the document and write it back.
	 *
	 * This is the same flag the large-file preview read uses, deliberately: it
	 * already means "this buffer is not the whole file", every writer already
	 * refuses it, and `documentSession.ensureFullContent` already re-reads the
	 * file and clears the flag the next time the user opens the tab for
	 * editing — which is how a tab recovers once the drive is plugged back in.
	 *
	 * A dirty buffer is never touched: unsaved text the user typed outranks a
	 * failed read of the file it came from.
	 */
	markTabContentUnavailable(id: string) {
		const tab = this.tabs.find((t) => t.id === id);
		if (!tab || tab.isDirty) return;
		tab.rawContent = '';
		tab.originalContent = '';
		tab.isTruncated = true;
	}

	/**
	 * Record whether this buffer came from a lossy decode. Set on every load,
	 * both ways: a file the user has since converted to UTF-8 must clear the
	 * flag, and Save As clears it once the buffer has a UTF-8 file of its own.
	 */
	setTabDecodedLossy(id: string, lossy: boolean) {
		const tab = this.tabs.find((t) => t.id === id);
		if (tab) {
			tab.hasReplacementChars = lossy;
		}
	}

	/**
	 * Record which encoding this buffer was decoded from, so the save writes
	 * the file back as itself. Set by the same reads that set the flag above,
	 * and for the same reason: it is a property of the buffer in hand, not a
	 * memory of how the tab was first opened — a file converted to UTF-8 since
	 * the load must stop being written as GBK.
	 *
	 * Separate from `setTabDecodedLossy` rather than an argument to it: they
	 * answer different questions ("could this be read?" and "what was it read
	 * as?"), and every caller that has one has the other, so folding them
	 * together would buy a line and cost the name.
	 */
	setTabEncoding(id: string, encoding: string) {
		const tab = this.tabs.find((t) => t.id === id);
		if (tab) {
			tab.encoding = encoding;
		}
	}

	/**
	 * Record the filesystem's answer for a tab whose path arrived through a
	 * route that could not resolve it — back/forward, a link opened in a new
	 * tab, a cross-window move, a restored window. `loadMarkdown` reads the
	 * file anyway, so it resolves the path in the same breath and reports it
	 * here, which is what turns those tabs from "unresolved, compared
	 * literally" into full participants in the one-tab-per-file rule.
	 *
	 * Guarded on the path still matching: the tab may have been navigated
	 * elsewhere while the resolution was in flight, and a key describing a file
	 * the tab no longer holds is worse than no key at all.
	 */
	setTabPathKey(id: string, path: string, pathKey: string) {
		const tab = this.tabs.find((t) => t.id === id);
		if (tab && tab.path === path) tab.pathKey = pathKey;
	}

	updateTabScroll(id: string, scrollTop: number) {
		const tab = this.tabs.find((t) => t.id === id);
		if (tab) {
			tab.scrollTop = scrollTop;
		}
	}

	updateTabEditorState(id: string, viewState: any) {
		const tab = this.tabs.find((t) => t.id === id);
		if (tab) {
			tab.editorViewState = viewState;
		}
	}

	updateTabScrollPercentage(id: string, percentage: number) {
		const tab = this.tabs.find((t) => t.id === id);
		if (tab) {
			tab.scrollPercentage = percentage;
		}
	}

	/**
	 * The in-page back/forward stacks — see `Tab.scrollHistory`. Three methods
	 * rather than a field the viewer reaches into, because the tab they belong
	 * to is the thing that used to be got wrong: the viewer holds the offsets
	 * of the document ON SCREEN, and the only way to be sure of that is to name
	 * the tab on every push and every pop.
	 *
	 * `from` is where the reader is standing right now, which the caller has
	 * and this file does not. Popping records it on the opposite stack, so back
	 * and forward walk the same path in both directions.
	 */
	pushScrollHistory(id: string, from: number) {
		const tab = this.tabs.find((t) => t.id === id);
		if (!tab) return;
		tab.scrollHistory.push(from);
		tab.scrollFuture = [];
		// A reader who has jumped fifty times is not going back to the first
		// one, and the stack is per tab now — a window full of documents would
		// otherwise keep every offset any of them ever had.
		if (tab.scrollHistory.length > SCROLL_HISTORY_LIMIT) tab.scrollHistory.shift();
	}

	/**
	 * Where to scroll back to, or null if this tab has no in-page jump to undo
	 * — which is the caller's cue to fall through to the FILE history
	 * (`goBack`), a different thing entirely.
	 */
	popScrollHistoryBack(id: string, from: number): number | null {
		const tab = this.tabs.find((t) => t.id === id);
		if (!tab || tab.scrollHistory.length === 0) return null;
		tab.scrollFuture.push(from);
		return tab.scrollHistory.pop()!;
	}

	/** The mirror of `popScrollHistoryBack`; falls through to `goForward`. */
	popScrollHistoryForward(id: string, from: number): number | null {
		const tab = this.tabs.find((t) => t.id === id);
		if (!tab || tab.scrollFuture.length === 0) return null;
		tab.scrollHistory.push(from);
		return tab.scrollFuture.pop()!;
	}

	/**
	 * This tab still holds the same document, but its text has been replaced
	 * from disk — a reload, or the "Reload" answer to an external change. The
	 * offsets describe a document that is gone, so they go with it.
	 *
	 * Separate from `clearReadingPosition`, which answers a different question
	 * (the tab now holds a DIFFERENT document) and is reached from the three
	 * navigation routes rather than from a load.
	 */
	clearScrollHistory(id: string) {
		const tab = this.tabs.find((t) => t.id === id);
		if (!tab) return;
		tab.scrollHistory = [];
		tab.scrollFuture = [];
	}

	/**
	 * Replace this tab's fold overrides. Callers build a NEW set rather
	 * than mutating the old one — see `Tab.foldOverrides`.
	 */
	setTabFoldOverrides(id: string, foldOverrides: Set<string>) {
		const tab = this.tabs.find((t) => t.id === id);
		if (tab) {
			tab.foldOverrides = foldOverrides;
		}
	}

	/**
	 * The one place this tab's anchor is written, in the one numbering it is in.
	 *
	 * `line` is a `RendererLine` because that is what the field is — the restore
	 * reads it back with `findAnchorElement` against `data-sourcepos`, which
	 * counts from the first line of the body. Two components write here and they
	 * used to disagree: `MarkdownViewer.svelte` hands over
	 * `getPreviewScrollAnchor`, already a renderer line, while
	 * `components/Editor.svelte` handed over a MONACO line, which counts from
	 * the first line of the file. Both round-tripped their own writes, so
	 * neither pane looked broken alone and every cross-pane switch landed the
	 * height of the front matter away.
	 *
	 * The brand is what stops that being writable: the editor now converts at
	 * its own edge (`tabAnchorForEditorTopLine`), and a caller that forgets is a
	 * type error rather than a document that opens in the wrong place.
	 */
	updateTabAnchorLine(id: string, line: RendererLine) {
		const tab = this.tabs.find((t) => t.id === id);
		if (tab) {
			tab.anchorLine = line;
		}
	}

	toggleSplit(id: string) {
		const tab = this.tabs.find((t) => t.id === id);
		if (tab) {
			this.setSplitEnabled(id, !tab.isSplit);
		}
	}

	setSplitEnabled(id: string, enabled: boolean) {
		const tab = this.tabs.find((t) => t.id === id);
		if (!tab) return;

		tab.isSplit = enabled;
		if (enabled) {
			tab.isScrollSynced = this.splitScrollSyncPreference;
		} else {
			this.splitScrollSyncPreference = tab.isScrollSynced;
		}
	}

	setSplitRatio(id: string, ratio: number) {
		const tab = this.tabs.find((t) => t.id === id);
		if (tab) {
			tab.splitRatio = Math.max(0.1, Math.min(0.9, ratio));
		}
	}

	toggleScrollSync(id: string) {
		const tab = this.tabs.find((t) => t.id === id);
		if (tab) {
			tab.isScrollSynced = !tab.isScrollSynced;
			this.splitScrollSyncPreference = tab.isScrollSynced;
		}
	}


	reorderTabs(fromIndex: number, toIndex: number) {
		if (fromIndex === toIndex) return;
		const [moved] = this.tabs.splice(fromIndex, 1);
		this.tabs.splice(toIndex, 0, moved);
	}

	cycleTab(direction: 'next' | 'prev') {
		if (this.tabs.length < 2) return;
		const currentIndex = this.tabs.findIndex(t => t.id === this.activeTabId);
		if (currentIndex === -1) return;

		let nextIndex: number;
		if (direction === 'next') {
			nextIndex = (currentIndex + 1) % this.tabs.length;
		} else {
			nextIndex = (currentIndex - 1 + this.tabs.length) % this.tabs.length;
		}
		this.activeTabId = this.tabs[nextIndex].id;
	}

	updateTabPath(id: string, path: string, pathKey?: string) {
		const tab = this.tabs.find((t) => t.id === id);
		if (tab) {
			// Save As can name a file that is already open here; the write has
			// happened by the time this runs, so the other tab's buffer is
			// already stale and must stop claiming the path.
			this.claimPath(path, id, pathKey);
			tab.path = path;
			tab.pathKey = pathKey;
			tab.title = path.split(/[/\\]/).pop() || 'Untitled';
			// The buffer is not touched here, so nothing about "changed?" changed
			// either. This used to clear a dirty flag by hand, which was only ever
			// right because both callers reach here mid-save and set
			// `originalContent` to the text they just wrote a line later — and
			// wrong in the window between, where a keystroke landing during the
			// write would have been marked saved. The other caller repoints an
			// untitled, empty, already-clean tab at the file it is about to load.
			const fileHistory = replaceCurrentHistoryEntry({
				targetPath: path,
				history: tab.history,
				historyIndex: tab.historyIndex,
			});
			tab.history = fileHistory.history;
			tab.historyIndex = fileHistory.historyIndex;
		}
	}

	renameTab(id: string, newPath: string, pathKey?: string) {
		const tab = this.tabs.find((t) => t.id === id);
		if (tab) {
			this.claimPath(newPath, id, pathKey);
			tab.path = newPath;
			// The old key described the old name, so keeping it would make this
			// tab answer "same file" for a file it no longer holds. Unset is the
			// honest state until something resolves the new path.
			tab.pathKey = pathKey;
			tab.title = newPath.split(/[/\\]/).pop() || 'Untitled';
			const fileHistory = replaceCurrentHistoryEntry({
				targetPath: newPath,
				history: tab.history,
				historyIndex: tab.historyIndex,
			});
			tab.history = fileHistory.history;
			tab.historyIndex = fileHistory.historyIndex;
		}
	}

	/**
	 * This tab now shows a DIFFERENT document, so everything the TAB records
	 * about the one it was showing is void. The three routes that repoint a tab
	 * — `navigate` (following a link), `goBack` and `goForward` — call this and
	 * nothing else, so a fourth route has one question to answer ("does this
	 * change which document the tab holds?") rather than one per field group.
	 *
	 * The two helpers stay separate because they are separate concerns with
	 * separate reasons: a stale reading position moves the viewport, a stale
	 * fold hides text, and each needs its own explanation. What they share is
	 * this trigger — both doc comments below used to open by restating it, which
	 * is what an unnamed shared concept looks like. This is its name.
	 *
	 * Not the buffer's TEXT: `rawContent`, `originalContent` and `content` are
	 * overwritten by the load that follows, not cleared here. Only the saved
	 * baseline moves, and only so the tab stops reading dirty — see
	 * `clearUnsavedEdits` below.
	 *
	 * Only a change of DOCUMENT gets here. Save As and rename (`updateTabPath`,
	 * `renameTab`) change the tab's path while the text on screen stays put: the
	 * reader has not moved, and the folds they put in that text still describe
	 * it. Tests guard both directions.
	 */
	private forgetPreviousDocument(tab: Tab) {
		this.clearUnsavedEdits(tab);
		this.clearReadingPosition(tab);
		this.clearFoldOverrides(tab);
	}

	/**
	 * The tab no longer holds the document its buffer came from, so it has no
	 * unsaved edits to that document any more — and it must not look as if it
	 * has, because `path` is already the NEW file. The auto-save effect arms on
	 * `isDirty && path !== ''`, so a tab left dirty across a navigation would
	 * write the document it just left into the file it just moved to, during
	 * the await before the load lands.
	 *
	 * Moving the baseline rather than the text: the load that follows replaces
	 * both buffers within the same user action, and clearing `rawContent` here
	 * would blank the editor for that frame. This is what the three navigation
	 * routes were each saying with `isDirty = false` while it was still a field
	 * anyone could assign — one place now, because they ask one question.
	 */
	private clearUnsavedEdits(tab: Tab) {
		tab.originalContent = tab.rawContent;
	}

	/**
	 * Everything that says where the reader was in the document this tab has
	 * just left. Called only from `forgetPreviousDocument`; the fields have to
	 * be cleared as a set.
	 *
	 * Clearing one of them is not enough and reads as if it were. Both restore
	 * paths are fallback cascades that stop at the first entry that resolves
	 * (see `scrollPercentage` above): the preview tries `anchorLine`, then
	 * `scrollPercentage`, then `scrollTop`, and the editor tries
	 * `editorViewState`, then `anchorLine`, then `scrollPercentage`. So a reset
	 * of only the last entry is unreachable for any tab that had been scrolled,
	 * and the tab restores the OLD document's position — `anchorLine` is a
	 * source line, and the line the reader left in one file names an unrelated
	 * block in the next one.
	 *
	 * `scrollHistory`/`scrollFuture` are here for the same reason one step
	 * removed: they are not where the reader IS but where they were standing
	 * before each jump, and an offset recorded in the document the tab has just
	 * left is no more meaningful than the position it left. Left behind, the
	 * next back click in the incoming document scrolls it somewhere the reader
	 * has never been.
	 *
	 * Nothing here scrolls anything; a restore runs on tab activation and on
	 * editor mount, which is why the symptom of getting this wrong shows up on
	 * a later tab switch rather than at the moment of the navigation.
	 *
	 * Which routes reach here, and which deliberately do not, is stated once in
	 * `forgetPreviousDocument` rather than in each helper.
	 */
	private clearReadingPosition(tab: Tab) {
		tab.editorViewState = null;
		tab.anchorLine = asRendererLine(0);
		tab.scrollPercentage = 0;
		tab.scrollTop = 0;
		tab.scrollHistory = [];
		tab.scrollFuture = [];
	}

	/**
	 * The fold overrides of the document this tab has just left. Called only
	 * from `forgetPreviousDocument`.
	 *
	 * A fold key is a heading slug or a callout title (see `Tab.foldOverrides`), which is only
	 * unique WITHIN a document, so carrying the set across means the incoming
	 * document is rendered with any section whose slug happens to match already
	 * shut. `loadMarkdown` reads the set on the line after the `navigate` call,
	 * so nothing is deferred: the HTML that first appears already carries
	 * `is-collapsed`, and the outline hides the same section's children on the
	 * same render, with nothing on screen to explain either. That is #425's
	 * failure reached through the navigation route instead of a window-wide set.
	 *
	 * Replaces the set rather than emptying it, as every other writer does — the
	 * viewer holds it through a `$derived`, and Svelte cannot see a `.clear()`
	 * of a Set it is already holding.
	 */
	private clearFoldOverrides(tab: Tab) {
		tab.foldOverrides = new Set<string>();
	}

	navigate(id: string, path: string, pathKey?: string) {
		const tab = this.tabs.find(t => t.id === id);
		if (tab) {
			if (tab.path === path) return;

			// Following a link to a file another tab already holds. The caller
			// has read that file and is about to put its text in THIS tab, so
			// declining the navigation is not an option: the tab would keep its
			// old path and get the other document's content, and the next save
			// would write it to the wrong file.
			this.claimPath(path, id, pathKey);

			const fileHistory = navigateFileHistory({
				currentPath: tab.path,
				targetPath: path,
				history: tab.history,
				historyIndex: tab.historyIndex,
			});
			tab.history = fileHistory.history;
			tab.historyIndex = fileHistory.historyIndex;

			tab.path = path;
			tab.pathKey = pathKey;
			tab.title = path.split(/[/\\]/).pop() || 'Untitled';
			this.forgetPreviousDocument(tab);
		}
	}

	canGoBack(id: string): boolean {
		const tab = this.tabs.find(t => t.id === id);
		return tab ? canGoBackInHistory(tab) : false;
	}

	canGoForward(id: string): boolean {
		const tab = this.tabs.find(t => t.id === id);
		return tab ? canGoForwardInHistory(tab) : false;
	}

	goBack(id: string): string | null {
		const tab = this.tabs.find(t => t.id === id);
		if (tab) {
			const result = goBackInHistory(tab);
			if (!result.path) return null;
			const path = result.path;
			// Back/forward walk this tab's own history, which can lead to a file
			// that has since been opened in another tab. History holds the paths
			// as they were typed, not their identities, so this claim compares
			// literally; the caller loads the file straight afterwards and
			// `loadMarkdown` resolves the key then.
			this.claimPath(path, id);
			tab.historyIndex = result.historyIndex;
			tab.path = path;
			tab.pathKey = undefined;
			tab.title = path.split(/[/\\]/).pop() || 'Untitled';
			this.forgetPreviousDocument(tab);
			return path;
		}
		return null;
	}

	goForward(id: string): string | null {
		const tab = this.tabs.find(t => t.id === id);
		if (tab) {
			const result = goForwardInHistory(tab);
			if (!result.path) return null;
			const path = result.path;
			this.claimPath(path, id);
			tab.historyIndex = result.historyIndex;
			tab.path = path;
			tab.pathKey = undefined;
			tab.title = path.split(/[/\\]/).pop() || 'Untitled';
			this.forgetPreviousDocument(tab);
			return path;
		}
		return null;
	}

	recentlyClosed = $state<string[]>([]);

	popRecentlyClosed() {
		return this.recentlyClosed.pop();
	}
}

export const tabManager = new TabManager();
