<script lang="ts">
	import { onMount, onDestroy } from "svelte";
	import { tabManager } from "../stores/tabs.svelte.js";
	import { settings } from "../stores/settings.svelte.js";
	import { t } from '../utils/i18n.js';
	import * as editorEdits from '../utils/editorEdits.js';
	import {
		INLINE_WRAP_LOOKAROUND,
		inlineWrapEdit,
		inlineWrapSelectionAfter,
		toggleLineMarker,
		type InlineWrapToolId,
		type LineMarkerToolId,
	} from '../utils/editorToolbar.js';
	import { editorFrontMatterScrollEnd } from '../utils/editorFrontMatter.js';
	import type { ViewerCommand } from '../utils/viewerKeymap.js';
	import { platformOf } from '../utils/platform.js';
	import { editorKeyHandlers } from '../utils/editorKeyHandlers.js';
	import type { TableOperation } from '../utils/tableEditing.js';
	import { updatedEditorOptions } from '../utils/editorOptions.js';
	import { monacoThemeName } from '../utils/editorTheme.js';
	import { paragraphAround } from '../utils/focusParagraph.js';
	import { EditorDocument } from '../utils/editorDocument.svelte.js';
	import { bindScrollSync, EditorJumps, type RevealPlacement } from '../utils/editorJumps.js';
	import { attachVimMode } from '../utils/vimAttach.js';
	import { mountAfterLoad } from '../utils/editorMount.js';
	import { mountEditor } from '../utils/mountEditor.js';
	import {
		getLineAtVerticalOffset,
		getScrollSyncPositionFromPixels,
		getScrollTopForSyncPosition,
		getVerticalOffsetForLine,
		type ScrollSyncPosition,
	} from '../utils/scrollSync.js';
	import {
		asBufferLine,
		lineCoordinates,
		type BufferLine,
	} from '../utils/lineCoordinates.js';
	import { editorActions } from '../utils/editorActions.js';
	import * as editorClipboard from '../utils/editorClipboard.js';
	import { localizedEditorActions } from '../utils/editorLocalizedActions.svelte.js';
	import type { EditorClipboardDeps } from '../utils/editorClipboard.js';

	// Monaco is ~86% of the startup JavaScript (a 4.4 MB chunk, ~360ms of
	// parse+eval, paid once per window because every window is its own webview)
	// and a reader who only ever views Markdown never touches a line of it. So
	// the module is pulled in from `onMount` below instead of here: a static
	// `import` would put it back in the startup graph no matter how rarely this
	// component mounts. Only the *types* are imported statically — `import type`
	// is erased entirely, so it costs nothing at runtime.
	//
	// The `?worker` imports below stay static on purpose. Vite compiles each of
	// them to a URL string plus a `new Worker(url)` wrapper and emits the worker
	// bundle as its own file, so they are already lazy: nothing is fetched until
	// Monaco actually asks `getWorker()` for one. Making them dynamic would move
	// a few hundred bytes and buy nothing.
	import type * as Monaco from "monaco-editor";
	import editorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker";
	import jsonWorker from "monaco-editor/esm/vs/language/json/json.worker?worker";
	import cssWorker from "monaco-editor/esm/vs/language/css/css.worker?worker";
	import htmlWorker from "monaco-editor/esm/vs/language/html/html.worker?worker";
	import tsWorker from "monaco-editor/esm/vs/language/typescript/ts.worker?worker";

	let {
		value,
		language = "markdown",
		oncommand,
		onscrollsync,
		oncursor,
		sharedCursor = null,
		// Read-only now: the wheel handler below changes the zoom through the
		// settings store, which is what persists it and syncs it across windows,
		// so there is no longer a value for the parent to bind back to.
		zoomLevel = 100,
		theme = "system",
		readOnly = false,
	} = $props<{
		value: string;
		language?: string;
		/**
		 * The app commands the editor binds a chord to (save, close, new file, …),
		 * run through the same `runViewerCommand` the document keyboard and the
		 * menu use, so a chord means the same thing with the caret in here.
		 */
		oncommand?: (command: ViewerCommand) => void;
		onscrollsync?: (position: ScrollSyncPosition) => void;
		/** Where the cursor is, whenever it moves and once on mount. `column` is Monaco's, 1-based. */
		oncursor?: (line: BufferLine, column: number) => void;
		/**
		 * Where the other pane left the tab's cursor (#799), put down on mount
		 * over the view state's. Opening split view and Ctrl+E both mount the
		 * editor, so a click in the preview reaches it either way.
		 */
		sharedCursor?: { line: number; column: number } | null;
		zoomLevel?: number;
		theme?: string;
		/**
		 * The buffer is not the whole file — a restored tab not read yet, a
		 * file that could not be read. Typing there could never be saved, so
		 * it is refused at the keyboard instead of at the save.
		 */
		readOnly?: boolean;
	}>();

	let container: HTMLDivElement;
	let vimStatusNode = $state<HTMLDivElement>();
	// Assigned by the dynamic `import()` in `onMount`, before anything reads it:
	// every use of a Monaco *value* in this file sits behind an `editor` /
	// `editorReady` guard, and `editor` only exists once the module has landed.
	let monaco: typeof Monaco;
	let editor: Monaco.editor.IStandaloneCodeEditor;
	let isApplyingExternalScroll = false;

	let cursorPosition = $state<Monaco.Position | null>(null);
	let selectionCount = $state(0);
	let cursorCount = $state(0);
	// Which document the editor shows, the keystroke-to-tab route, and the
	// status-bar readings of the document; see `utils/editorDocument.svelte.ts`.
	const doc = new EditorDocument({
		monaco: () => monaco,
		editor: () => editor,
		tabs: tabManager,
		value: () => value,
		showWordCount: () => settings.wordCount,
	});

	// `editorReady` has to be `$state` rather than a plain `if (editor)` guard:
	// `editor` is assigned inside `onMount` and is not reactive, so an effect
	// that bailed out on it would never re-run once the editor appeared. That
	// was already true when the editor was built synchronously on mount; now
	// that `onMount` first awaits the Monaco chunk, *every* effect that touches
	// the editor has to gate on this flag, or it runs once against a missing
	// editor and never runs again.
	let editorReady = $state(false);
	// Syncs and reveals asked for before Monaco loaded; see `utils/editorJumps.ts`.
	const jumps = new EditorJumps({
		monaco: () => monaco,
		editor: () => editor,
		ready: () => editorReady,
		scrollTo: scrollToSyncPosition,
	});
	let fontIsMonospace = $state(true);

	// Synchronous, so the keybindings can be registered once at mount; see
	// `platformOf` for why its fallback cannot disagree with `settings.osType`.
	function isMacPlatform(): boolean {
		return platformOf(settings.osType) === 'macos';
	}

	self.MonacoEnvironment = {
		getWorker: function (_moduleId: string, label: string) {
			if (label === "json") {
				return new jsonWorker();
			}
			if (label === "css" || label === "scss" || label === "less") {
				return new cssWorker();
			}
			if (label === "html" || label === "handlebars" || label === "razor") {
				return new htmlWorker();
			}
			if (label === "typescript" || label === "javascript") {
				return new tsWorker();
			}
			return new editorWorker();
		},
	};

	// `onMount` itself stays synchronous; see utils/editorMount.ts.
	onMount(() => mountAfterLoad(async () => (monaco = await import("monaco-editor")), createEditor));

	function createEditor() {
		return mountEditor({
			monaco,
			container,
			doc,
			jumps,
			tabs: tabManager,
			settings,
			value,
			language,
			theme: () => theme,
			zoomLevel,
			readOnly,
			sharedCursor,
			oncursor: (line, column) => oncursor?.(line, column),
			keyHandlers: {
				cutToClipboard,
				pasteFromClipboard,
				continueListOnEnter,
				handleTabKey,
				handleShiftTabKey,
				handleModEnterKey,
				handleModShiftEnterKey,
			},
			applySettingsOptions,
			setEditor: (created) => (editor = created),
			setFontIsMonospace: (monospace) => (fontIsMonospace = monospace),
			setCursorPosition: (position) => (cursorPosition = position),
			setSelectionCount: (count) => (selectionCount = count),
			setCursorCount: (count) => (cursorCount = count),
			setEditorReady: (ready) => (editorReady = ready),
		});
	}

	// Editing primitives used by the context-menu actions. They live at
	// component scope, not inside `onMount`, because the actions that call them
	// are torn down and rebuilt whenever the UI language changes.

	// Which markers each of these tools writes and which it accepts back lives in
	// `utils/editorToolbar.ts`, beside the line-marker table and keyed by the same
	// ids — so the button, the shortcut and the context-menu entry cannot disagree
	// about what Bold means, and neither can two markers that share a prefix.
	const toggleInlineWrapTool = (id: InlineWrapToolId) => {
		const selection = editor.getSelection();
		const model = editor.getModel();
		if (!selection || !model) return;

		// Markers the user did not select are still the user's markers: double
		// clicking a word inside `~~word~~` selects `word`. `inlineWrapEdit` reads
		// the few characters on either side and says how far the edit has to grow
		// to reach them — 0 whenever growing would break a neighbouring pair.
		const selected = model.getValueInRange(selection);
		const { reach, text } = inlineWrapEdit(
			id,
			model.getValueInRange({
				startLineNumber: selection.startLineNumber,
				startColumn: Math.max(1, selection.startColumn - INLINE_WRAP_LOOKAROUND),
				endLineNumber: selection.startLineNumber,
				endColumn: selection.startColumn,
			}),
			selected,
			model.getValueInRange({
				startLineNumber: selection.endLineNumber,
				startColumn: selection.endColumn,
				endLineNumber: selection.endLineNumber,
				endColumn: selection.endColumn + INLINE_WRAP_LOOKAROUND,
			}),
		);

		// The edit has to say where the selection goes. Left to Monaco, the old
		// selection is adjusted against the new text, and that is wrong as soon
		// as the range is wider than the selection was: `~~word~~` -> `word`
		// clamps columns 3-7 to 3-5, leaving `rd` selected, and a second click
		// wraps that instead — `wo~~rd~~`.
		const startColumn = selection.startColumn - reach;
		const after = inlineWrapSelectionAfter(id, startColumn, selected, text);

		editor.pushUndoStop();
		editor.executeEdits(
			"toggle-format",
			[
				{
					range: {
						startLineNumber: selection.startLineNumber,
						startColumn,
						endLineNumber: selection.endLineNumber,
						endColumn: selection.endColumn + reach,
					},
					text,
				},
			],
			[
				new monaco.Selection(
					selection.startLineNumber,
					after.startColumn,
					selection.startLineNumber + after.lineOffset,
					after.endColumn,
				),
			],
		);
	};

	// Underline is an HTML tag rather than a Markdown marker, and its two ends
	// are different strings, so none of the prefix reasoning above applies to it.
	const toggleTagFormat = (marker: string) => {
		const selection = editor.getSelection();
		if (!selection) return;

		const model = editor.getModel();
		if (!model) return;

		const text = model.getValueInRange(selection);
		const [startTag, endTag] = marker.split("|");
		const newText =
			text.startsWith(startTag) && text.endsWith(endTag)
				? text.slice(startTag.length, -endTag.length)
				: `${startTag}${text}${endTag}`;

		// Nothing selected: the caret goes between the tags, as it does between
		// the Markdown markers above (#778).
		const caret = startTag.length + selection.startColumn;
		editor.pushUndoStop();
		editor.executeEdits(
			"toggle-format",
			[{ range: selection, text: newText }],
			selection.isEmpty()
				? [new monaco.Selection(selection.startLineNumber, caret, selection.startLineNumber, caret)]
				: undefined,
		);
	};

	const transformSelectedLines = (
		source: string,
		transform: (lines: string[]) => string[],
	) => {
		const selection = editor.getSelection();
		const model = editor.getModel();
		if (!selection || !model) return;

		let endLine = selection.endLineNumber;
		if (selection.endColumn === 1 && endLine > selection.startLineNumber) {
			endLine -= 1;
		}

		const range = new monaco.Range(
			selection.startLineNumber,
			1,
			endLine,
			model.getLineMaxColumn(endLine),
		);
		const lines = model.getValueInRange(range).split(/\r?\n/);
		editor.pushUndoStop();
		editor.executeEdits(source, [
			{
				range,
				text: transform(lines).join(model.getEOL()),
				forceMoveMarkers: true,
			},
		]);
	};

	// Which marker each of these tools owns, and what it replaces, lives in
	// `utils/editorToolbar.ts` — one table, keyed by the same ids the toolbar
	// renders, so a list toggle cannot forget to displace a competing marker.
	const toggleLineMarkerTool = (id: LineMarkerToolId) => {
		transformSelectedLines(id, (lines) => toggleLineMarker(id, lines));
	};

	// Enter, Tab, Shift+Tab and the two Mod+Enter keys: utils/editorKeyHandlers.ts.
	const keyHandlers = () => editorKeyHandlers(editor, monaco);
	const continueListOnEnter = () => keyHandlers().continueListOnEnter();
	const editTable = (operation: TableOperation) => keyHandlers().editTable(operation);
	const handleTabKey = () => keyHandlers().handleTabKey();
	const handleShiftTabKey = () => keyHandlers().handleShiftTabKey();
	const handleModEnterKey = () => keyHandlers().handleModEnterKey();
	const handleModShiftEnterKey = () => keyHandlers().handleModShiftEnterKey();

	// utils/editorEdits.ts.
	const wrapAsCodeBlock = () => editorEdits.wrapAsCodeBlock(editor);
	const insertLink = () => editorEdits.insertLink(editor);

	/**
	 * Every action whose label comes from `t()`, rebuilt when the UI language
	 * changes: utils/editorLocalizedActions.svelte.ts. Actions with no
	 * user-visible label (the Ctrl+V command) stay in `onMount`.
	 */
	const disposeLocalizedActions = localizedEditorActions({
		language: () => settings.language,
		ready: () => editorReady,
		editor: () => editor,
		descriptors: (lang) => editorActions(
			{
				monaco,
				isMac: isMacPlatform(),
				settings,
				oncommand: (command) => oncommand?.(command),
				copyToClipboard,
				toggleInlineWrapTool,
				toggleTagFormat,
				toggleLineMarkerTool,
				wrapAsCodeBlock,
				insertLink,
				insertSimpleTable,
				editTable,
			},
			lang,
		),
	});

	const insertSimpleTable = () => {
		const selection = editor.getSelection();
		if (!selection) return;

		const cols = 3;
		const rows = 2;
		let table = "\n";
		table += "| " + Array(cols).fill("Header").join(" | ") + " |\n";
		table += "| " + Array(cols).fill("---").join(" | ") + " |\n";
		for (let i = 0; i < rows; i++) {
			table += "| " + Array(cols).fill("Cell").join(" | ") + " |\n";
		}
		table += "\n";

		editor.pushUndoStop();
		editor.executeEdits("insert-table", [
			{
				range: selection,
				text: table,
				forceMoveMarkers: true,
			},
		]);
	};

	onDestroy(disposeLocalizedActions);

	function getEditorContentScrollMax() {
		if (!editor) return 0;

		const layout = editor.getLayoutInfo();
		return Math.max(0, editor.getContentHeight() - layout.height);
	}

	const getEditorFrontMatterScrollEnd = editorFrontMatterScrollEnd(() => editor, getEditorContentScrollMax);

	// Monaco's own line -> pixel measurement, which already accounts for folded
	// regions, wrapped lines and view zones. `getLineAtVerticalOffset` inverts it
	// by binary search, so this is called ~log2(lineCount) times per sync.
	function getEditorLineTop(line: number) {
		return editor ? editor.getTopForLineNumber(line) : 0;
	}

	/** Where the editor is, in split view's terms; null before Monaco has loaded. */
	export function scrollSyncPosition(): ScrollSyncPosition | null {
		return editorReady && editor ? getEditorScrollSyncPosition() : null;
	}

	function getEditorScrollSyncPosition() {
		if (!editor) {
			return { section: 'body', ratio: 0 } satisfies ScrollSyncPosition;
		}

		const position = getScrollSyncPositionFromPixels(
			editor.getScrollTop(),
			getEditorContentScrollMax(),
			getEditorFrontMatterScrollEnd(),
		);

		// Front matter renders as a panel in the preview with no source range, so
		// there is nothing for a line to resolve against there; the section ratio
		// carries it, exactly as before.
		const model = position.section === 'body' ? editor.getModel() : null;
		if (!model) return position;

		// Monaco counts from the first line of the FILE, so what comes back is a
		// buffer line. Saying so here is what obliges the preview to convert:
		// everything it answers with counts from the first line of the body.
		const line = asBufferLine(getLineAtVerticalOffset(editor.getScrollTop(), model.getLineCount(), getEditorLineTop));

		return Number.isFinite(line) ? { ...position, line } : position;
	}

	// Cut, copy, paste and the drop handler: utils/editorClipboard.ts.
	const clipboard: EditorClipboardDeps = {
		editor: () => editor,
		monaco: () => monaco,
		tabs: tabManager,
		settings,
	};
	export function pasteFromClipboard() {
		return editorClipboard.pasteFromClipboard(clipboard);
	}
	export function copyToClipboard() {
		return editorClipboard.copyToClipboard(clipboard);
	}
	export function cutToClipboard() {
		return editorClipboard.cutToClipboard(clipboard);
	}

	/**
	 * `cursorIntoView` is Ctrl+E's, with the outline following the cursor: an
	 * outline that marks the cursor's heading while the page shows another one
	 * reads as wrong, so a cursor left off screen is moved to the top of it.
	 * Split view's live sync never passes it, and never moves the cursor.
	 */
	export function syncScrollToPosition(position: ScrollSyncPosition, { cursorIntoView = false } = {}) {
		jumps.syncScrollToPosition(position, { cursorIntoView });
	}

	/** `syncScrollToPosition` once the editor is ready. */
	function scrollToSyncPosition(position: ScrollSyncPosition, { cursorIntoView }: { cursorIntoView: boolean }) {
		const scrollMax = getEditorContentScrollMax();
		let targetScroll: number | null = null;

		if (position.section === 'body' && position.line !== undefined) {
			const model = editor.getModel();
			if (model) {
				const offset = getVerticalOffsetForLine(position.line, model.getLineCount(), getEditorLineTop);
				if (Number.isFinite(offset)) targetScroll = offset;
			}
		}

		if (targetScroll === null) {
			targetScroll = getScrollTopForSyncPosition(position, scrollMax, getEditorFrontMatterScrollEnd());
		}

		// Clamp before the threshold: a line near the end of the document resolves
		// to an offset the editor cannot reach, and an unreachable target produces
		// no scroll event — which would leave `isApplyingExternalScroll` to be
		// spent on the reader's next real scroll instead of on this one.
		targetScroll = Math.max(0, Math.min(scrollMax, targetScroll));

		if (Math.abs(editor.getScrollTop() - targetScroll) > 5) {
			isApplyingExternalScroll = true;
			editor.setScrollTop(targetScroll, monaco.editor.ScrollType.Immediate);

			requestAnimationFrame(() => {
				isApplyingExternalScroll = false;
			});
		}

		if (cursorIntoView) moveCursorOnScreen();
	}

	/**
	 * A click in the split view's preview (#799). The position only: revealing
	 * it would scroll the editor, and with sync on that scrolls the preview out
	 * from under the click.
	 */
	export function setCursor(line: number, column: number) {
		if (editorReady && editor) editor.setPosition({ lineNumber: line, column });
	}

	function moveCursorOnScreen() {
		const cursor = editor.getPosition();
		const ranges = editor.getVisibleRanges();
		if (!cursor || ranges.length === 0) return;

		const first = ranges[0].startLineNumber;
		const last = ranges[ranges.length - 1].endLineNumber;
		if (cursor.lineNumber >= first && cursor.lineNumber <= last) return;

		// Below the margin Monaco itself keeps above a cursor it reveals
		// (`viewLines.ts`, `_computeScrollTopToRevealRange`): enough rows for
		// the most lines sticky scroll can pin, or `cursorSurroundingLines`.
		// Placed higher, the sticky heading can cover it, and the first
		// keystroke scrolls the page to make that room.
		const option = monaco.editor.EditorOption;
		const lineHeight = editor.getOption(option.lineHeight);
		const sticky = editor.getOption(option.stickyScroll);
		const rows = Math.max(editor.getOption(option.cursorSurroundingLines), sticky.enabled ? sticky.maxLineCount : 0);
		const margin = Math.min(editor.getLayoutInfo().height / lineHeight / 2, rows) * lineHeight;
		const clear = editor.getScrollTop() + margin;

		let line = first;
		while (line < last && editor.getTopForLineNumber(line) < clear) line++;
		editor.setPosition({ lineNumber: line, column: 1 });
	}

	// Every effect below reads `editorReady` first, and only then `editor`. See
	// the declaration of `editorReady`: `editor` is a plain `let`, so an effect
	// gated on it alone would run once before the Monaco chunk resolves, find
	// nothing, and never be re-triggered — losing scroll sync, the zoom-aware
	// font size, the theme and Vim mode for the whole life of the editor.
	$effect(() => {
		if (editorReady && editor && onscrollsync) {
			const emitSync = () => {
				if (isApplyingExternalScroll) return;

				onscrollsync?.(getEditorScrollSyncPosition());
			};

			const scrollListener = bindScrollSync(editor, emitSync);
			return () => {
				scrollListener.dispose();
			};
		}
	});

	// Tab activation. A switch swaps the editor's MODEL; it does not overwrite
	// one shared buffer any more, which is the whole of #391: `setValue` is
	// defined to clear the undo stack (`TextModel._setValueFromTextBuffer` →
	// `_commandManager.clear()`), so every switch away and back used to cost the
	// user their undo history. Undo now lives on the document, which is Monaco's
	// intended usage and how VS Code works.
	//
	// `setValue` is still here, and still clears undo, for the case it is
	// actually right for: the tab's buffer was REPLACED behind the editor's back
	// — a reload from disk, an external change the user accepted, a truncated
	// buffer completed, a link followed inside this tab, a task checkbox toggled
	// from the preview. Those hand the model a different document, and an undo
	// stack from the old one would splice two texts together. The `getValue()`
	// comparison is what tells the two apart: an ordinary tab switch finds the
	// model already holding its own text and touches nothing.
	//
	// Making external writes undoable instead (`pushEditOperation`) is a real
	// option and #391 suggests it, but it is a second behaviour change — it
	// would let Ctrl+Z resurrect a buffer that the truncation and lossy-decode
	// guards (#374, #379) exist to keep away from the file — so it is
	// deliberately not part of this one.
	$effect(() => {
		const activeTabId = tabManager.activeTabId;
		const content = value;
		const languageId = language;

		if (!editorReady || !editor) return;

		doc.activate(activeTabId, content, languageId);
	});

	/** The one place the settings, and `readOnly`, reach Monaco after creation: the effect below, and `onMount` once the font is measured. */
	function applySettingsOptions() {
		editor.updateOptions(updatedEditorOptions(settings, zoomLevel, fontIsMonospace, readOnly));
	}

	$effect(() => {
		if (editorReady && editor) applySettingsOptions();
	});

	// The count is not kept while hidden, so showing it has to take one.
	$effect(() => {
		if (editorReady && editor && settings.wordCount) doc.syncStatus();
	});

	// Focus Mode (#819): the paragraph the cursor is in keeps full strength and
	// the rest of the document dims.
	let focusDecorations: Monaco.editor.IEditorDecorationsCollection | null = null;

	$effect(() => {
		if (!editorReady || !editor) return;
		void value;
		const line = cursorPosition?.lineNumber ?? 1;
		const model = editor.getModel();
		focusDecorations ??= editor.createDecorationsCollection();
		if (!settings.focusMode || !model) {
			focusDecorations.clear();
			return;
		}
		const count = model.getLineCount();
		const { start, end } = paragraphAround((n) => model.getLineContent(n), count, Math.min(line, count));
		const dim = (from: number, to: number) => ({
			range: new monaco.Range(from, 1, to, model.getLineMaxColumn(to)),
			options: { inlineClassName: 'focus-mode-dim' },
		});
		focusDecorations.set([...(start > 1 ? [dim(1, start - 1)] : []), ...(end < count ? [dim(end + 1, count)] : [])]);
	});


	// The only place a theme CHANGE reaches Monaco. `setTheme` is global to the
	// page rather than per-editor, so a second effect writing it from anywhere
	// else is not a redundancy, it is a coin toss — see `monacoThemeName`.
	//
	// `vscode:` is the one theme this pane cannot ask for on a change: its rules
	// are read off disk, so it does not exist as a Monaco theme until
	// `parseAndApplyVscodeTheme` has defined it, and asking for an undefined
	// name gets `vs`. That function sets it itself the moment it can.
	$effect(() => {
		if (editorReady && editor && theme) {
			if (theme.startsWith("vscode:")) return;
			monaco.editor.setTheme(
				monacoThemeName(
					theme,
					window.matchMedia("(prefers-color-scheme: dark)").matches,
				),
			);
		}
	});

	$effect(() => {
		if (editorReady && editor && settings.vimMode && vimStatusNode) {
			let disposed = false;
			let vim: { dispose: () => void } | null = null;
			const currentEditor = editor;
			const currentStatusNode = vimStatusNode;
			import("monaco-vim").then((module) => {
				vim = attachVimMode(module, currentEditor, currentStatusNode, () => disposed);
			});
			return () => {
				disposed = true;
				vim?.dispose();
			};
		}
	});
	export function handleDroppedFile(path: string, x: number, y: number) {
		return editorClipboard.handleDroppedFile(clipboard, path, x, y);
	}

	let dragCaretDecoration: string[] = [];
	export function updateDragCaret(x: number, y: number) {
		if (!editor) return;
		const target = (editor as any).getTargetAtClientPoint(x, y);
		const position = target?.position;
		if (!position) {
			hideDragCaret();
			return;
		}
		dragCaretDecoration = editor.deltaDecorations(dragCaretDecoration, [
			{
				range: new monaco.Range(
					position.lineNumber,
					position.column,
					position.lineNumber,
					position.column,
				),
				options: {
					className: "ghost-caret",
					isWholeLine: false,
				},
			},
		]);
	}
	export function hideDragCaret() {
		if (!editor) return;
		dragCaretDecoration = editor.deltaDecorations(dragCaretDecoration, []);
	}

	export function revealSourceRange(startLine: number, endLine: number, placement: RevealPlacement = 'center') {
		jumps.revealSourceRange(startLine, endLine, placement);
	}

	export function revealHeader(sourceLine: BufferLine | null, text: string) {
		jumps.revealHeader(sourceLine, text);
	}

	export const undo = () => {
		editor?.focus();
		editor?.trigger("keyboard", "undo", null);
	}

	export const redo = () => {
		editor?.focus();
		editor?.trigger("keyboard", "redo", null);
	}

	export const selectAll = () => {
		editor?.focus();
		editor?.trigger("keyboard", "editor.action.selectAll", null);
	}

	export const triggerFind = () => {
		if (!editor) return;
		editor.focus();
		editor.getAction("actions.find")?.run();
	}

	export function insertTableCustom(rows: number, cols: number) {
		if (!editor) return;
		editor.focus();
		const selection = editor.getSelection();
		if (!selection) return;

		const c = Math.max(1, cols);
		const r = Math.max(1, rows);

		let table = "\n";
		const headers = Array.from({ length: c }, (_, i) => `Header ${i + 1}`);
		table += "| " + headers.join(" | ") + " |\n";

		const dividers = Array(c).fill("---");
		table += "| " + dividers.join(" | ") + " |\n";

		const dataRowCount = Math.max(1, r - 1);
		for (let row = 0; row < dataRowCount; row++) {
			const cells = Array.from({ length: c }, (_, col) => `Cell ${row + 1}.${col + 1}`);
			table += "| " + cells.join(" | ") + " |\n";
		}
		table += "\n";

		editor.pushUndoStop();
		editor.executeEdits("insert-table", [
			{
				range: selection,
				text: table,
				forceMoveMarkers: true,
			},
		]);
	}

	export function runEditorAction(actionId: string, payload?: any) {
		if (!editor) return;
		editor.focus();
		if (actionId === 'insert-table-grid' && payload && typeof payload === 'object') {
			insertTableCustom(payload.rows ?? 2, payload.cols ?? 3);
			return;
		}
		editor.getAction(actionId)?.run();
	}

	/**
	 * Bring `tabId`'s recorded reading position up to date with what the editor
	 * is showing right now.
	 *
	 * Reading mode never needs this: `handleScroll` in MarkdownViewer writes the
	 * same fields through on every scroll event, so a tab in the preview is
	 * always current. Edit mode writes them once, when the editor comes down —
	 * which is cheap, and which leaves anything that reads a tab's position
	 * while the editor is still up reading the position from the LAST teardown,
	 * or 0 for a tab that was opened straight into edit mode and never left it.
	 * Those callers ask here first.
	 *
	 * A no-op unless this editor is up AND holding `tabId`. There is one Editor
	 * per window and it swaps models between tabs (`utils/tabModels.ts`), so an
	 * unguarded flush would copy the ACTIVE tab's position onto whichever record
	 * the caller named — a wrong position on two tabs instead of one.
	 */
	export function flushPositionTo(tabId: string) {
		if (!editorReady || !editor) return;
		doc.flushPositionTo(tabId);
	}
</script>

<div class="editor-outer">
	<div
		class="editor-container"
		bind:this={container}
	></div>
	<!--
		Measured: fetching, parsing and evaluating the Monaco chunk takes ~390ms
		on an Apple-silicon Mac (~360ms of that is parse+eval, not transfer), so
		the first switch into edit mode leaves this pane blank long enough to read
		as a dropped keypress. Same wordless spinner the app already shows while
		it boots, so there is no new string to translate and nothing to mistake
		for an error. It costs nothing after the first mount in a window: the
		chunk is in the module cache, `editorReady` flips in the same tick, and
		this never paints again.
	-->
	{#if !editorReady}
		<div class="editor-loading">
			<svg class="spinner" viewBox="0 0 50 50">
				<circle class="path" cx="25" cy="25" r="20" fill="none" stroke-width="4"></circle>
			</svg>
		</div>
	{/if}
</div>

{#if settings.vimMode}
	<div class="vim-status-bar" bind:this={vimStatusNode}></div>
{/if}

{#if settings.statusBar}
	<div class="status-bar">
		<div class="status-item">
								{t('editor.status.lineCol', settings.language).replace('{{line}}', (cursorPosition?.lineNumber ?? 1).toString()).replace('{{col}}', (cursorPosition?.column ?? 1).toString())}
							</div>
		{#if selectionCount > 0}
			<div class="status-item">
				{t('editor.status.selected', settings.language).replace('{{count}}', selectionCount.toString())}
			</div>
		{:else if cursorCount > 1}
			<div class="status-item">
				{t('editor.status.selections', settings.language).replace('{{count}}', cursorCount.toString())}
			</div>
		{/if}
		{#if settings.wordCount}
			<div class="status-item">
				{t('editor.status.words', settings.language).replace('{{count}}', doc.wordCount.toString())}
			</div>
		{/if}
		<div class="status-item">
			{zoomLevel}%
		</div>
		<div class="status-item">
			{doc.language}
		</div>
		<!-- Not translated, like the language id and the zoom level above it:
		     "LF" and "CRLF" are acronyms, and the `crlf` key they replace held
		     the same ASCII in all five locales that bothered to define it. -->
		<div class="status-item">{doc.lineEnding}</div>
		<div class="status-item">{doc.encoding}</div>
	</div>
{/if}

<style>
	:global(.focus-mode-dim) {
		opacity: 0.35;
	}

	.editor-outer {
		position: relative;
		flex: 1;
		height: 100%;
		width: 100%;
		display: flex;
		background-color: var(--color-canvas-default);
		overflow: hidden;
	}

	.editor-loading {
		position: absolute;
		inset: 0;
		display: flex;
		align-items: center;
		justify-content: center;
		background: var(--color-canvas-default);
	}

	.spinner {
		width: 50px;
		height: 50px;
		animation: rotate 2s linear infinite;
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

	.editor-container {
		height: 100%;
		width: 100%;
		min-width: 0;
	}

	/* Monaco sizes the slider inline. Grow it under the pointer the way the
	   preview's thumb does. */
	.editor-container :global(.monaco-scrollable-element > .scrollbar > .slider) {
		border-radius: 10px;
	}

	.editor-container :global(.monaco-scrollable-element > .scrollbar.vertical > .slider:hover),
	.editor-container :global(.monaco-scrollable-element > .scrollbar.vertical > .slider.active) {
		width: 12px !important;
		left: 1px !important;
	}

	.editor-container :global(.monaco-scrollable-element > .scrollbar.horizontal > .slider:hover),
	.editor-container :global(.monaco-scrollable-element > .scrollbar.horizontal > .slider.active) {
		height: 12px !important;
		top: 1px !important;
	}

	:global(.ghost-caret) {
		border-left: 2px solid var(--color-accent-fg);
		margin-left: -1px;
		opacity: 0.6;
	}

	.vim-status-bar {
		padding: 0 10px;
		font-family: monospace;
		font-size: 12px;
		background: var(--bg-tertiary);
		border-top: 1px solid var(--color-border-muted);
		color: var(--text-primary);
		display: flex;
		align-items: center;
		min-height: 20px;
	}

	/* This bar's height must not depend on its content. Monaco cancels an
	   in-progress drag-selection whenever the editor's height changes
	   (`MouseHandler.onConfigurationChanged` -> `stopMonitoring`), and the bar
	   sits directly above the editor. Without `nowrap` the items wrapped their
	   text in a narrow window the moment a selection added the "N selected"
	   item, the bar grew a line, the editor lost one, and the drag the user was
	   still making died where it stood (#762). */
	.status-bar {
		padding: 0 10px;
		font-family: "Segoe UI", Tahoma, Geneva, Verdana, sans-serif;
		font-size: 12px;
		background: var(--bg-tertiary);
		border-top: 1px solid var(--color-border-muted);
		color: var(--text-primary);
		display: flex;
		align-items: center;
		min-height: 22px;
		gap: 20px;
		user-select: none;
		white-space: nowrap;
		overflow: hidden;
	}

	/* Right-aligns the row while it fits, and drops the overflow off the right
	   end when it does not. `justify-content: flex-end` would clip the other
	   end, taking the cursor position — the one reading that changes as you
	   work — before the encoding, which never changes at all. */
	.status-bar > .status-item:first-child {
		margin-left: auto;
	}

	.status-item {
		opacity: 0.8;
	}
</style>
