import type * as Monaco from 'monaco-editor';
import { openUrl } from '@tauri-apps/plugin-opener';
import { invoke } from '@tauri-apps/api/core';
import { wheelZoomFactor, type settings as SettingsStore } from '../stores/settings.svelte.js';
import { MARKDOWN_LANGUAGE_ID } from './pasteContext.js';
import { isAltGraphChord } from './viewerKeymap.js';
import { createdEditorOptions } from './editorOptions.js';
import { defineAppThemes, monacoThemeName } from './editorTheme.js';
import { createMarkdownSemanticTokensProvider } from './semanticTokens.js';
import type { Tab } from '../stores/tabs.svelte.js';
import type { EditorDocument } from './editorDocument.svelte.js';
import type { EditorJumps } from './editorJumps.js';
import {
	createDocumentOutline,
	MARKDOWN_COMPLETION_TRIGGERS,
	provideMarkdownCompletionItems,
} from './markdownCompletion.js';
import { headingFoldRanges, headingSymbols } from './headingSymbols.js';
import { asBufferLine, editorTopLineForTabAnchor, lineCoordinates, type BufferLine } from './lineCoordinates.js';
import { editorKeyCommands, type EditorKeyHandler } from './editorActions.js';

type MountedTab = Pick<Tab, 'editorViewState' | 'anchorLine' | 'scrollPercentage' | 'path'>;

/**
 * What Editor.svelte's mount reaches: the loaded Monaco module and the host
 * element, the component's document and jump queue, the props as they are
 * at mount (`theme` and `oncursor` are read later, hence functions), and a
 * setter for each piece of component state the mount writes.
 */
export type MountEditorDeps = {
	monaco: typeof Monaco;
	container: HTMLElement;
	doc: EditorDocument;
	jumps: Pick<EditorJumps, 'spendPending'>;
	tabs: { readonly activeTabId: string | null; readonly activeTab: MountedTab | null | undefined };
	settings: typeof SettingsStore;
	value: string;
	language: string;
	theme: () => string;
	zoomLevel: number;
	readOnly: boolean;
	sharedCursor: { line: number; column: number } | null;
	oncursor: (line: BufferLine, column: number) => void;
	keyHandlers: Record<EditorKeyHandler, () => unknown>;
	applySettingsOptions: () => void;
	setEditor: (editor: Monaco.editor.IStandaloneCodeEditor) => void;
	setFontIsMonospace: (monospace: boolean) => void;
	setCursorPosition: (position: Monaco.Position) => void;
	setSelectionCount: (count: number) => void;
	setCursorCount: (count: number) => void;
	setEditorReady: (ready: boolean) => void;
};

/** Build the editor, place it, wire it up; returns the unmount cleanup. */
export function mountEditor(deps: MountEditorDeps): () => void {
	const {
		monaco,
		container,
		doc,
		jumps,
		tabs: tabManager,
		settings,
		value,
		language,
		zoomLevel,
		readOnly,
		sharedCursor,
		oncursor,
		keyHandlers,
		applySettingsOptions,
	} = deps;

	const originalOpen = window.open;
	window.open = function (
		url?: string | URL,
		target?: string,
		features?: string,
	) {
		if (
			typeof url === "string" &&
			(url.startsWith("http://") || url.startsWith("https://"))
		) {
			openUrl(url);
			return null;
		}
		return originalOpen.apply(this, arguments as any);
	};

	defineAppThemes(monaco);

	// The active tab can change while the Monaco chunk is downloading (open a
	// document in edit mode, then Ctrl+Tab before it lands). The effect that
	// normally handles a tab switch bailed out on the missing editor, so
	// re-read the id here: the view state saved on unmount has to be filed
	// against the tab the editor is really showing, not the one that was
	// active when this component was created.
	doc.currentTabId = tabManager.activeTabId;

	const getTheme = () =>
		monacoThemeName(
			deps.theme(),
			window.matchMedia("(prefers-color-scheme: dark)").matches,
		);

	// The editor is a VIEW; the document it shows is the active tab's model.
	// Passing `model` rather than `value`/`language` also settles ownership:
	// `StandaloneEditor` only sets `_ownsModel` when it had to build the
	// model itself, and `_postDetachModelCleanup` disposes the model on
	// `editor.dispose()` only when it owns it. So a model handed in here
	// SURVIVES the editor — which is the point, because this component is
	// unmounted every time the user switches a tab to reading mode.
	//
	// With no active tab there is nothing to key a model by, so the editor
	// builds and owns a throwaway one, exactly as it did before. That state
	// is not reachable from the markup (the pane renders under
	// `tabManager.activeTab`); it is the honest fallback for the window
	// between the Monaco chunk resolving and this function running.
	const documentOptions = doc.currentTabId
		? { model: doc.acquireTabModel(doc.currentTabId, value, language) }
		: { value, language };

	const editor = monaco.editor.create(container, {
		...documentOptions,
		theme: getTheme(),
		// The real zoom, not 100: the view state, the anchor line and a
		// pending sync are all placed before the update effect runs, and a
		// font size changed under them afterwards keeps the pixel offset, not
		// the line (#799).
		...createdEditorOptions(settings, zoomLevel, readOnly),
	});
	deps.setEditor(editor);

	// Feeds the wrapping strategy in `editorOptionsFromSettings`. `fontInfo`
	// changes with the font setting and when Monaco remeasures after a font
	// finishes loading. Read before anything is placed, for the same
	// reason as the zoom above: a proportional font rewraps every line.
	const fontIsMonospace = editor.getOption(monaco.editor.EditorOption.fontInfo).isMonospace;
	deps.setFontIsMonospace(fontIsMonospace);
	if (!fontIsMonospace) applySettingsOptions();

	if (tabManager.activeTab?.editorViewState) {
		editor.restoreViewState(tabManager.activeTab.editorViewState);
	} else if (tabManager.activeTab) {
		let scrolled = false;
		if (tabManager.activeTab.anchorLine > 0) {
			// The anchor is a RENDERER line, whoever recorded it — this pane
			// or the preview — and Monaco can only be aimed with a buffer
			// line. The conversion is the whole point of the crossing: a tab
			// last scrolled in the preview used to open here the height of
			// its front matter too far up the document.
			editor.revealLineNearTop(
				editorTopLineForTabAnchor(lineCoordinates(value), tabManager.activeTab.anchorLine),
				monaco.editor.ScrollType.Immediate,
			);
			scrolled = true;
		}

		if (!scrolled) {
			const scrollHeight = editor.getScrollHeight();
			const clientHeight = editor.getLayoutInfo().height;
			if (scrollHeight > clientHeight) {
				const targetScroll =
					tabManager.activeTab.scrollPercentage *
					(scrollHeight - clientHeight);
				editor.setScrollTop(targetScroll);
			}
		}
	}

	const updateTheme = () => {
		monaco.editor.setTheme(getTheme());
	};

	const mediaQuery = window.matchMedia("(prefers-color-scheme: dark)");
	mediaQuery.addEventListener("change", updateTheme);

	editor.focus();

	editor.onDidChangeModelContent(() => doc.contentChanged());

	editor.onDidChangeCursorPosition((e) => {
		deps.setCursorPosition(e.position);
		oncursor(asBufferLine(e.position.lineNumber), e.position.column);
	});
	// The view state above put the cursor back without an event, and a
	// Ctrl+E into the editor wants the outline on it straight away.
	if (sharedCursor) editor.setPosition({ lineNumber: sharedCursor.line, column: sharedCursor.column });
	const mounted = editor.getPosition();
	oncursor(asBufferLine(mounted?.lineNumber ?? 1), mounted?.column ?? 1);

	editor.onDidChangeCursorSelection((e) => {
		const selections = editor.getSelections() || [];
		deps.setCursorCount(selections.length);
		const model = editor.getModel();

		if (model && selections.length > 0) {
			deps.setSelectionCount(
				selections.reduce(
					(acc: number, selection: Monaco.Selection) => {
						return acc + model.getValueInRange(selection).length;
					},
					0,
				),
			);
		} else {
			deps.setSelectionCount(0);
		}
	});

	editor.onDidChangeConfiguration((e) => {
		if (e.hasChanged(monaco.editor.EditorOption.fontInfo)) {
			deps.setFontIsMonospace(editor.getOption(monaco.editor.EditorOption.fontInfo).isMonospace);
		}
	});

	doc.syncStatus();

	const wheelListener = (e: WheelEvent) => {
		if (e.ctrlKey || e.metaKey) {
			e.preventDefault();
			e.stopPropagation();
			settings.zoomBy(wheelZoomFactor(e.deltaY));
		}
	};

	container.addEventListener("wheel", wheelListener, { capture: true });

	// This document's headings and block folds, from Rust, cached per model
	// version: utils/markdownCompletion.ts.
	const { documentOutline, headingAnchors } = createDocumentOutline(invoke);

	// The colours that come from the renderer rather than from the grammar's
	// regexes (`utils/semanticTokens.ts`). Registered once per editor, beside the
	// completion provider, and disposed with it.
	const { provider: semanticTokensProvider } = createMarkdownSemanticTokensProvider(monaco);
	const semanticTokens = monaco.languages.registerDocumentSemanticTokensProvider(
	MARKDOWN_LANGUAGE_ID,
	semanticTokensProvider,
	);

	// What sticky scroll pins (#759), from the same heading list link completion
	// uses.
	const documentSymbols = monaco.languages.registerDocumentSymbolProvider(MARKDOWN_LANGUAGE_ID, {
	provideDocumentSymbols: async (model) => {
		const lineCount = model.getLineCount();
		return headingSymbols(await headingAnchors(model), lineCount, monaco.languages.SymbolKind.String);
	},
	});

	// Headings, plus the list items, code blocks, quotes and tables that
	// indentation folding covered: registering this turns that fallback off (#777).
	const foldingRanges = monaco.languages.registerFoldingRangeProvider(MARKDOWN_LANGUAGE_ID, {
	provideFoldingRanges: async (model) => {
		const { anchors, folds } = await documentOutline(model);
		return [...headingFoldRanges(anchors, model.getLineCount(), (n) => model.getLineContent(n)), ...folds];
	},
	});

	const completionProvider = monaco.languages.registerCompletionItemProvider(
		"markdown",
		{
			triggerCharacters: MARKDOWN_COMPLETION_TRIGGERS,
			provideCompletionItems: (model, position) =>
				provideMarkdownCompletionItems(model, position, {
					monaco,
					headingAnchors,
					invoke,
					activeTabPath: () => tabManager.activeTab?.path,
					imageDirectory: () => settings.imageDirectory,
				}),
		},
	);

	// The nameless key commands (clipboard, and Enter/Tab/Shift+Tab/Mod+Enter
	// in lists and tables): which key, which handler, behind which `when`
	// clause, is `editorKeyCommands` in utils/editorActions.ts.
	for (const command of editorKeyCommands(monaco)) {
		editor.addCommand(command.binding, keyHandlers[command.handler], command.when);
	}

	// AltGr on Windows arrives as Ctrl+Alt, and Monaco resolves a keystroke
	// from Ctrl/Alt and the key code without looking at AltGraph, so Polish
	// AltGr+Z matched Ctrl+Alt+Z and ż was never typed. The editor's own
	// keydown fires before the keybinding service dispatches (see the vim
	// note in Editor.svelte), so this key is set in time for the Ctrl+Alt actions'
	// `keybindingContext` to refuse it. `editor.spec.ts` shows both.
	const altGraphChord = editor.createContextKey<boolean>("altGraphChord", false);
	editor.onKeyDown((e) => altGraphChord.set(isAltGraphChord(e.browserEvent)));

	deps.setEditorReady(true);

	// After the view-state / anchor-line restore above, deliberately: an
	// explicit "edit this fragment" beats the position the tab was left at.
	jumps.spendPending();

	return () => {
		deps.setEditorReady(false);
		doc.cancelPendingWordCount();
		window.open = originalOpen;
		mediaQuery.removeEventListener("change", updateTheme);
		container.removeEventListener("wheel", wheelListener, { capture: true });
		completionProvider.dispose();
		semanticTokens.dispose();
		documentSymbols.dispose();
		foldingRanges.dispose();

		if (editor && doc.currentTabId) doc.writePosition(doc.currentTabId);

		editor.dispose();
	};
}
