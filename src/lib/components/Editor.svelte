<script lang="ts">
	import { onMount, onDestroy } from "svelte";
	import { tabManager } from "../stores/tabs.svelte.js";
	import { settings } from "../stores/settings.svelte.js";
	import { t, type LanguageCode } from '../utils/i18n.js';
	import { MARKDOWN_LANGUAGE_ID, shouldLinkifyPastedUrl } from '../utils/pasteContext.js';
	import {
		toggleInlineWrap,
		toggleLineMarker,
		type InlineWrapToolId,
		type LineMarkerToolId,
	} from '../utils/editorToolbar.js';
	import { editorOptionsFromSettings } from '../utils/editorOptions.js';
	import { getTabModel, lineEndingLabel, tabModelUri } from '../utils/tabModels.js';
	import { installVimScrollCommands } from '../utils/vimScrollCommands.js';
	import {
		headingLinkContext,
		headingQueryStart,
		type HeadingAnchor,
	} from '../utils/headingCompletion.js';
	import {
		getLineAtVerticalOffset,
		getScrollSyncPositionFromPixels,
		getScrollTopForSyncPosition,
		getVerticalOffsetForLine,
		type ScrollSyncPosition,
	} from '../utils/scrollSync.js';
	import { asBufferLine, type BufferLine } from '../utils/lineCoordinates.js';
	import {
		DEFAULT_IMAGE_DIRECTORY,
		documentParentDir,
		imageEmbed,
	} from '../utils/imageEmbed.js';

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
	import { openUrl } from "@tauri-apps/plugin-opener";
	import { invoke } from "@tauri-apps/api/core";

	let {
		value,
		language = "markdown",
		onsave,
		onnew,
		onopen,
		onclose,
		onreveal,
		ontoggleEdit,
		ontoggleLive,
		ontoggleSplit,
		onhome,
		onnextTab,
		onprevTab,
		onundoClose,
		onscrollsync,
		// Read-only now: the wheel handler below changes the zoom through the
		// settings store, which is what persists it and syncs it across windows,
		// so there is no longer a value for the parent to bind back to.
		zoomLevel = 100,
		theme = "system",
	} = $props<{
		value: string;
		language?: string;
		onsave?: () => void;
		onnew?: () => void;
		onopen?: () => void;
		onclose?: () => void;
		onreveal?: () => void;
		ontoggleEdit?: () => void;
		ontoggleLive?: () => void;
		ontoggleSplit?: () => void;
		onhome?: () => void;
		onnextTab?: () => void;
		onprevTab?: () => void;
		onundoClose?: () => void;
		onscrollsync?: (position: ScrollSyncPosition) => void;
		zoomLevel?: number;
		isSplit?: boolean;
		theme?: string;
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
	let wordCount = $state(0);
	let currentLanguage = $state("markdown");
	let lineEnding = $state<"LF" | "CRLF">("LF");
	/**
	 * The encoding the document was decoded from, and the one a save writes it
	 * back as (#372).
	 *
	 * Derived from the tab rather than synced from the model like `lineEnding`
	 * is: a line ending is a property of the Monaco buffer, an encoding is a
	 * property of the file that buffer came from. The store already holds it,
	 * so a copy kept in sync here could only go stale.
	 *
	 * This slot used to be the literal string `UTF-8`, which was true of every
	 * file Markpad could open. Detection made it a lie for exactly the
	 * documents the indicator matters most for — a GBK file now opens, reads
	 * correctly and saves back as GBK, and the status bar was still claiming
	 * UTF-8.
	 */
	let encoding = $derived(tabManager.activeTab?.encoding ?? 'UTF-8');
	let currentTabId = tabManager.activeTabId;

	// A Monaco action captures its label when it is registered, so actions built
	// once at mount keep whatever language they were built with — switching the
	// UI language used to leave the editor's context menu in the old one until
	// the app was restarted. `addAction` returns an `IDisposable` for exactly
	// this case: the registration below is re-run on every language change, and
	// the previous disposables are released first so ids are never registered
	// twice (a duplicate id leaves a duplicate context-menu entry behind).
	//
	// `editorReady` has to be `$state` rather than a plain `if (editor)` guard:
	// `editor` is assigned inside `onMount` and is not reactive, so an effect
	// that bailed out on it would never re-run once the editor appeared. That
	// was already true when the editor was built synchronously on mount; now
	// that `onMount` first awaits the Monaco chunk, *every* effect that touches
	// the editor has to gate on this flag, or it runs once against a missing
	// editor and never runs again.
	let editorReady = $state(false);
	let localizedActions: Monaco.IDisposable[] = [];

	// `settings.osType` is resolved asynchronously from the Rust side, so it can
	// still be 'unknown' while the editor registers its keybindings. Fall back to
	// the synchronous browser hint in that window.
	//
	// The fallback reads a deprecated API on purpose, and the deprecation is
	// precisely what makes it reliable here: we are asking "is this macOS?", not
	// "which architecture is this?". `navigator.platform` still reports
	// "MacIntel" on Apple silicon — measured on an M5 (arm64), where the user
	// agent likewise still claims "Intel Mac OS X 10_15_7". Both values are
	// frozen deliberately by WebKit and Chromium: years of sites compare
	// `navigator.platform === 'MacIntel'` exactly, so changing it during the 2020
	// ARM transition would have made every Mac look like an unknown platform
	// overnight, and the capped Catalina version exists to limit fingerprinting.
	// So the string lies about the CPU while staying permanently correct about
	// the vendor — the only axis this function queries. The fallback therefore
	// cannot reach a different macOS verdict than `settings.osType` does, and the
	// keybindings never need re-registering once `osType` resolves.
	//
	// `navigator.userAgentData` is not used instead: only its coarse `platform`
	// field is synchronous, and architecture and platform version sit behind the
	// asynchronous high-entropy request. Waiting on that would reintroduce the
	// very delay `settings.osType` already has, which defeats the point of
	// having a synchronous fallback at all.
	function isMacPlatform(): boolean {
		if (settings.osType !== 'unknown') return settings.osType === 'macos';
		return /^(Mac|iPhone|iPad|iPod)/i.test(navigator.platform || '');
	}

	/**
	 * The `ITextModel` belonging to a tab — Monaco's document object, and the
	 * thing that owns the undo stack.
	 *
	 * One per tab, created here because this component holds the dynamically
	 * imported Monaco namespace, and reaped by `TabManager` because that is
	 * what knows a tab is gone; see `utils/tabModels.ts` for both halves.
	 *
	 * The language is re-applied on every call rather than only at creation.
	 * `language` is derived from the ACTIVE TAB'S PATH, and a tab can be
	 * repointed at a file of another type without being recreated — following a
	 * link, back/forward, Save As. The model outlives all of those, so a
	 * language fixed at creation would be the extension of whatever file the tab
	 * held the first time it was edited. `setModelLanguage` is a no-op when the
	 * id already matches.
	 */
	function acquireTabModel(tabId: string, seed: string, languageId: string) {
		const model = getTabModel(tabId, () =>
			monaco.editor.createModel(seed, languageId, monaco.Uri.parse(tabModelUri(tabId))),
		);
		if (model.getLanguageId() !== languageId) monaco.editor.setModelLanguage(model, languageId);
		return model;
	}

	/**
	 * The status-bar readings that are properties of the DOCUMENT rather than of
	 * an edit: the language, the word count and the line ending.
	 *
	 * They used to be refreshed only by `onDidChangeModelContent`, which was
	 * enough while a tab switch went through `setValue` — that fires a content
	 * change (a flush) as a side effect. `setModel` does not, because no content
	 * changed: a different document arrived. So switching tabs has to ask for
	 * these explicitly, or the status bar keeps the previous document's numbers.
	 */
	function syncStatusFromModel() {
		const model = editor.getModel();
		if (!model) return;
		currentLanguage = model.getLanguageId();
		lineEnding = lineEndingLabel(model);
		const text = model.getValue();
		wordCount = (text.match(/\S+/g) || []).filter((w) => /\w/.test(w)).length;
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

	onMount(() => {
		let cancelled = false;
		let teardown: (() => void) | null = null;

		// `onMount` itself stays synchronous: Svelte only treats a *synchronously*
		// returned function as the unmount cleanup, so an `async` callback would
		// hand it a promise and silently leak the editor, its listeners and the
		// `window.open` patch. The await lives in this inner task instead, and the
		// synchronous return closes over both the cancel flag (the component can
		// be destroyed while the chunk is still in flight — Ctrl+E then Ctrl+E
		// again) and whatever cleanup `createEditor` produced.
		void (async () => {
			monaco = await import("monaco-editor");
			if (cancelled) return;
			teardown = createEditor();
		})();

		return () => {
			cancelled = true;
			teardown?.();
		};
	});

	function createEditor() {
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

		const defineThemes = () => {
			monaco.editor.defineTheme("app-theme-dark", {
				base: "vs-dark",
				inherit: true,
				rules: [],
				colors: {
					"editor.background": "#181818",
					"menu.background": "#181818",
					"menu.foreground": "#cccccc",
					"menu.selectionBackground": "#2a2d2e",
					"menu.selectionForeground": "#ffffff",
					"menu.separatorBackground": "#454545",
					"editorWidget.background": "#181818",
					"editorWidget.border": "#454545",
				},
			});

			monaco.editor.defineTheme("app-theme-light", {
				base: "vs",
				inherit: true,
				rules: [],
				colors: {
					"editor.background": "#FDFDFD",
					"menu.background": "#FDFDFD",
					"menu.foreground": "#333333",
					"menu.selectionBackground": "#eeeeee",
					"menu.selectionForeground": "#000000",
					"menu.separatorBackground": "#cccccc",
					"editorWidget.background": "#FDFDFD",
					"editorWidget.border": "#cccccc",
				},
			});
		};

		defineThemes();

		// The active tab can change while the Monaco chunk is downloading (open a
		// document in edit mode, then Ctrl+Tab before it lands). The effect that
		// normally handles a tab switch bailed out on the missing editor, so
		// re-read the id here: the view state saved on unmount has to be filed
		// against the tab the editor is really showing, not the one that was
		// active when this component was created.
		currentTabId = tabManager.activeTabId;

		const getTheme = () => {
			if (theme && theme.startsWith("vscode:")) return "vscode-custom";
			if (theme === "system") {
				return window.matchMedia("(prefers-color-scheme: dark)").matches
					? "app-theme-dark"
					: "app-theme-light";
			}
			return theme === "dark" ? "app-theme-dark" : "app-theme-light";
		};

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
		const documentOptions = currentTabId
			? { model: acquireTabModel(currentTabId, value, language) }
			: { value, language };

		editor = monaco.editor.create(container, {
			...documentOptions,
			theme: getTheme(),
			dragAndDrop: true,
			automaticLayout: true,
			// The settings-derived options, shared with the updateOptions
			// effect below. Zoom is 100 here and not `zoomLevel`: that is
			// what this literal has always passed, and the effect re-applies
			// the real factor on the tick after creation.
			...editorOptionsFromSettings(settings, 100),
			scrollBeyondLastLine: true,
			stickyScroll: { enabled: settings.stickyScroll },
			smoothScrolling: true,
			cursorSmoothCaretAnimation: 'on',
			wordBasedSuggestions: "off",
			quickSuggestions: false,
			// Monaco's Unicode highlighter is built for source code, where a
			// character that looks like ASCII but is not is an attack vector. In
			// prose it fires on the punctuation CJK authors type all day: `，`
			// `！` `？` `（` `）` `；` `：` are all confusables of an ASCII
			// counterpart, so Monaco outlines each one (#186, #94).
			//
			// It only fires when the confusable shares a word with basic ASCII —
			// shouldHighlightNonBasicASCII() suppresses the box when the
			// surrounding word is entirely non-ASCII — which is why pure CJK
			// looks fine and `使用 Monaco，然后保存。` or `安装依赖（npm ci）` does
			// not. Latin technical terms inside CJK prose are the normal case,
			// and `**粗体**，` triggers it with no Latin word at all.
			//
			// invisibleCharacters stays on, but not for the reason first written
			// here. That comment claimed it "never fires on something typed on
			// purpose"; measured against this Monaco build, U+3000 IDEOGRAPHIC
			// SPACE — the space bar under every CJK IME — is in the invisible
			// set and gets outlined, which is the same complaint as #186/#94 one
			// option over. The set is the flattened union of every locale bucket
			// (`strings.js` getData()), 465 code points, so `allowedLocales`
			// cannot exclude it; only `allowedCharacters` can.
			//
			// The rest stays on because the NBSP hazard is real: an NBSP after
			// `-` stops a list from parsing. Worth recording that the other
			// stated hazard does NOT hold — a zero-width space inside CJK text
			// is not flagged at all, because shouldHighlightNonBasicASCII()
			// suppresses it when the surrounding word has no basic ASCII.
			//
			// nonBasicASCII needs no setting — it defaults to
			// `inUntrustedWorkspace` and standalone Monaco's workspace-trust
			// service returns true unconditionally, so it is already off; were it
			// on, every ideograph would be boxed rather than the punctuation.
			unicodeHighlight: {
				ambiguousCharacters: false,
				allowedCharacters: { "　": true },
			},
			// Word-wise navigation — ⌥←/→, double-click-to-select, ⌥⌫ — splits on
			// `wordSeparators`, and a language that does not put spaces between
			// its words has none. So a whole Chinese clause counts as one word:
			// ⌥→ jumps the sentence, double-click selects it, ⌥⌫ deletes it.
			//
			// A non-empty list switches on `Intl.Segmenter` (see
			// `wordCharacterClassifier.js`), which knows where the words are.
			//
			// It is closer to a switch than to a whitelist, and the naming hides
			// that: ICU dispatches its dictionary breaking by SCRIPT, not by this
			// list. Thai, Khmer, Lao, Burmese and Tibetan get segmented too and
			// none of them are named here, while `['zh']`, `['ja']` and
			// `['zh','ja']` all produce identical output — even on Han text,
			// where the two dictionaries might have been expected to disagree.
			// Written as the two the app has locales for, rather than a longer
			// list that would read as a claim about coverage it does not make.
			//
			// Nothing is taken from space-delimited languages: Korean,
			// Vietnamese, Russian and English segment word-for-word identically
			// to splitting on whitespace. An unsupported tag is dropped by
			// Monaco's own `validate()`, so this cannot fail closed.
			wordSegmenterLocales: ['zh', 'ja'],
			// Markpad draws the editor's context menu itself, in
			// MarkdownViewer.svelte, beside the one the preview already had.
			//
			// Not a style choice. Monaco's menu offers Cut, Copy and Paste, and
			// its Paste cannot work here: it reads the clipboard through the
			// webview, which wry leaves switched off and which Tauri has no
			// answer for (tauri-apps/tauri#12007). Everything else Monaco would
			// contribute to that menu — Go to Definition, Go to References,
			// inlay hints — needs a language provider this app does not
			// register, so nothing is lost by drawing our own.
			//
			// #266 fixed the overlay that used to cover this menu, which was
			// the right fix for that bug and left the reader pointed at a menu
			// whose Paste silently did nothing (#207).
			contextmenu: false,
			// Monaco writes a styled `text/html` flavour beside the plain text on a
			// copy. Everything Markpad produces IS plain text, so pasting into Word
			// or Outlook gave coloured monospace instead of the Markdown that was
			// copied — the styled flavour has no audience here (#393).
			//
			// Still needed after cut/copy/paste were collapsed onto three functions
			// of our own, which is easy to get wrong: those cover ⌘C and the context
			// menu, and macOS has a third way in. Edit > Copy in the menu bar is a
			// `PredefinedMenuItem::copy` (#527), which asks the webview to perform
			// its own copy — Monaco's, not ours. Without this the menu bar would put
			// a different clipboard on the pasteboard than the other two routes.
			copyWithSyntaxHighlighting: false,
			// The same argument one option over. U+2028 (LINE SEPARATOR) and
			// U+2029 (PARAGRAPH SEPARATOR) break a JavaScript string literal,
			// which is what Monaco's guard is for; in Markdown they are just
			// characters, and they arrive by ordinary means — several word
			// processors and PDF text extractors emit U+2028 for a soft line
			// break, so pasting one in is normal here.
			//
			// The default is 'prompt', and in standalone Monaco that prompt is
			// `StandaloneDialogService.doConfirm`, i.e. a bare
			// `mainWindow.confirm()`: an unstyled browser dialog inside a Tauri
			// window, carrying Monaco's English string in an app translated
			// into 26 locales, offering to rewrite the user's bytes. 'auto'
			// would rewrite them without asking, which is worse.
			//
			// 'off' loses no visibility: the line renderer substitutes U+FFFD
			// for LINE_SEPARATOR and PARAGRAPH_SEPARATOR unconditionally, so
			// they stay as visible as they ever were. Only the dialog goes.
			unusualLineTerminators: "off",
			padding: { top: 20 },
			scrollbar: {
				vertical: "visible",
				horizontal: "visible",
				useShadows: false,
				verticalHasArrows: false,
				horizontalHasArrows: false,
				verticalScrollbarSize: 10,
				horizontalScrollbarSize: 10,
			},
		});

		if (tabManager.activeTab?.editorViewState) {
			editor.restoreViewState(tabManager.activeTab.editorViewState);
		} else if (tabManager.activeTab) {
			let scrolled = false;
			if (tabManager.activeTab.anchorLine > 0) {
				editor.revealLineNearTop(
					Math.max(1, tabManager.activeTab.anchorLine - 2),
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

		// The one route from a keystroke to the document. `value` is a plain
		// prop — it reads the active tab's `rawContent` and nothing here writes
		// it back — so this call is not a second opinion about the buffer, it is
		// the only opinion. It used to be a `bind:value` writing the field
		// directly PLUS this call, and the tab only stayed dirty-tracked because
		// Svelte's assignment happened to run first: deleting this line left the
		// text on screen correct and the dirty flag, the auto-save trigger and
		// the close prompt silently dead. Delete it now and the editor stops
		// editing the document at all, which is a bug you can see.
		//
		// The guard is what stops the loop: the effect below pushes an external
		// buffer replacement in with `setValue`, which fires this listener with
		// text `value` already holds, and writing that back to the store would
		// be a write the user did not make.
		editor.onDidChangeModelContent(() => {
			const newValue = editor.getValue();
			if (value !== newValue && tabManager.activeTabId) {
				tabManager.updateTabRawContent(tabManager.activeTabId, newValue);
			}

			syncStatusFromModel();
		});

		editor.onDidChangeCursorPosition((e) => {
			cursorPosition = e.position;
		});

		editor.onDidChangeCursorSelection((e) => {
			const selections = editor.getSelections() || [];
			cursorCount = selections.length;
			const model = editor.getModel();

			if (model && selections.length > 0) {
				selectionCount = selections.reduce(
					(acc: number, selection: Monaco.Selection) => {
						return acc + model.getValueInRange(selection).length;
					},
					0,
				);
			} else {
				selectionCount = 0;
			}
		});

		syncStatusFromModel();

		const wheelListener = (e: WheelEvent) => {
			if (e.ctrlKey || e.metaKey) {
				e.preventDefault();
				e.stopPropagation();
				if (e.deltaY < 0) {
					settings.zoomIn();
				} else {
					settings.zoomOut();
				}
			}
		};

		container.addEventListener("wheel", wheelListener, { capture: true });

		/**
	 * This document's headings, from the Rust side that renders them.
	 *
	 * Cached on the model's version, which changes on every edit: a completion
	 * fires per keystroke once the dropdown is open, and re-parsing a
	 * 3,000-line document for each of them would be paid for nothing — the
	 * headings cannot have moved between two keystrokes of the same edit.
	 *
	 * Asked of Rust rather than derived here: the ids come out of comrak's
	 * anchorizer, and a second implementation in TypeScript would drift from
	 * it silently, producing links that look right and land nowhere.
	 */
	let anchorCache: { version: number; anchors: HeadingAnchor[] } | null = null;

	async function headingAnchors(model: Monaco.editor.ITextModel): Promise<HeadingAnchor[]> {
		const version = model.getVersionId();
		if (anchorCache?.version === version) return anchorCache.anchors;

		try {
			const anchors = (await invoke("list_heading_anchors", {
				markdown: model.getValue(),
			})) as HeadingAnchor[];
			anchorCache = { version, anchors };
			return anchors;
		} catch {
			return [];
		}
	}

	const completionProvider = monaco.languages.registerCompletionItemProvider(
			"markdown",
			{
				triggerCharacters: ["(", "/", "\\", '"', "#"],
				provideCompletionItems: async (model, position) => {
					const lineContent = model.getLineContent(position.lineNumber);
					const prefix = lineContent.substring(0, position.column - 1);

					// #200: this document's headings, as link targets. Asked
					// first because `](#` is also the tail of the embed context
					// below — once a `#` is typed the answer is headings, not
					// files.
					const headingContext = headingLinkContext(prefix);
					if (headingContext) {
						const anchors = await headingAnchors(model);
						const range = new monaco.Range(
							position.lineNumber,
							headingQueryStart(prefix) + 1,
							position.lineNumber,
							position.column,
						);

						return {
							suggestions: anchors.map((anchor, index) => ({
								// Labelled by what it reads as, inserted as
								// whatever that context needs. Monaco filters on
								// the label, so typing "mermaid" finds
								// "11. Mermaid Diagrams" and writes the slug.
								label: anchor.text,
								detail: `#${anchor.slug}`,
								kind: monaco.languages.CompletionItemKind.Reference,
								insertText:
									headingContext === "slug" ? anchor.slug : anchor.text,
								// Document order, not alphabetical: a heading's
								// neighbours are what the writer is thinking in.
								sortText: String(index).padStart(5, "0"),
								range,
							})),
						};
					}

					const isEmbedContext = /(!?\[.*\]\(|<img.*src=["']|src=["'])$/.test(
						prefix,
					);
					if (!isEmbedContext) return { suggestions: [] };

					const tab = tabManager.activeTab;
					if (!tab?.path) return { suggestions: [] };

					const lastSlash = Math.max(
						tab.path.lastIndexOf("\\"),
						tab.path.lastIndexOf("/"),
					);
					const parentDir = tab.path.substring(0, lastSlash);
					const imgDirName =
						settings.imageDirectory || DEFAULT_IMAGE_DIRECTORY;

					try {
						const [currentEntries, imgEntries] = await Promise.all([
							invoke("list_directory_contents", { path: parentDir })
								.then((r) => r as string[])
								.catch(() => []),
							invoke("list_directory_contents", { path: `${parentDir}/${imgDirName}` })
								.then((r) => r as string[])
								.catch(() => []),
						]);

						const word = model.getWordUntilPosition(position);
						const range = new monaco.Range(
							position.lineNumber,
							word.startColumn,
							position.lineNumber,
							word.endColumn,
						);

						const suggestions: Monaco.languages.CompletionItem[] = [
							...currentEntries.map((e) => ({
								label: e,
								kind: e.endsWith("/")
									? monaco.languages.CompletionItemKind.Folder
									: monaco.languages.CompletionItemKind.File,
								insertText: e,
								range,
							})),
							...imgEntries.map((e) => ({
								label: `${imgDirName}/${e}`,
								kind: e.endsWith("/")
									? monaco.languages.CompletionItemKind.Folder
									: monaco.languages.CompletionItemKind.File,
								insertText: `${imgDirName}/${e}`,
								range,
							})),
						];

						return { suggestions };
					} catch (err) {
						return { suggestions: [] };
					}
				},
			},
		);

		// ⌘X. Monaco leaves all three of these keys unbound in a browser
		// ("Do not bind cut keybindings in the browser, since browsers do that
		// for us" — clipboard.js), so the slots are free and binding them is
		// what makes the keyboard and the context menu run the same code.
		editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyX, cutToClipboard, "editorTextFocus");

		// clipboard handling: Ctrl+C is a localized action (see
		// `registerLocalizedActions`) so its label can follow the UI language;
		// Ctrl+V is a plain command with no label, so it has nothing to
		// re-register on a language change.
		editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyV, pasteFromClipboard, "editorTextFocus");

		editorReady = true;

		// After the view-state / anchor-line restore above, deliberately: an
		// explicit "edit this fragment" beats the position the tab was left at.
		if (pendingReveal) {
			const { startLine, endLine } = pendingReveal;
			pendingReveal = null;
			revealSourceRange(startLine, endLine);
		}

		return () => {
			editorReady = false;
			window.open = originalOpen;
			mediaQuery.removeEventListener("change", updateTheme);
			container.removeEventListener("wheel", wheelListener, { capture: true });
			completionProvider.dispose();

			if (editor && currentTabId) {
				const state = editor.saveViewState();
				tabManager.updateTabEditorState(currentTabId, state);

				const scrollHeight = editor.getScrollHeight();
				const clientHeight = editor.getLayoutInfo().height;
				if (scrollHeight > clientHeight) {
					const percentage =
						editor.getScrollTop() / (scrollHeight - clientHeight);
					tabManager.updateTabScrollPercentage(currentTabId, percentage);
				}

				const ranges = editor.getVisibleRanges();
				if (ranges.length > 0) {
					const startLine = ranges[0].startLineNumber;
					const anchorLine = startLine + 2;
					tabManager.updateTabAnchorLine(currentTabId, anchorLine);
				}
			}

			editor.dispose();
		};
	}

	// Editing primitives used by the context-menu actions. They live at
	// component scope, not inside `onMount`, because the actions that call them
	// are torn down and rebuilt whenever the UI language changes.

	const insertTextAtCursor = (text: string) => {
		const selection = editor.getSelection();
		if (!selection) return;
		const op = { range: selection, text: text, forceMoveMarkers: true };
		editor.executeEdits("my-source", [op]);
	};

	// Which markers each of these tools writes and which it accepts back lives in
	// `utils/editorToolbar.ts`, beside the line-marker table and keyed by the same
	// ids — so the button, the shortcut and the context-menu entry cannot disagree
	// about what Bold means, and neither can two markers that share a prefix.
	const toggleInlineWrapTool = (id: InlineWrapToolId) => {
		const selection = editor.getSelection();
		const model = editor.getModel();
		if (!selection || !model) return;

		editor.executeEdits("toggle-format", [
			{
				range: selection,
				text: toggleInlineWrap(id, model.getValueInRange(selection)),
			},
		]);
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

		editor.executeEdits("toggle-format", [{ range: selection, text: newText }]);
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

	const wrapAsCodeBlock = () => {
		const selection = editor.getSelection();
		const model = editor.getModel();
		if (!selection || !model) return;

		const text = model.getValueInRange(selection);
		const block = text.startsWith("```\n") && text.endsWith("\n```")
			? text.slice(4, -4).replace(/\n$/, "")
			: `\`\`\`\n${text}\n\`\`\``;
		editor.executeEdits("fmt-code-block", [
			{ range: selection, text: block, forceMoveMarkers: true },
		]);
	};

	const insertLink = () => {
		const selection = editor.getSelection();
		const model = editor.getModel();
		if (!selection || !model) return;

		const text = model.getValueInRange(selection);
		const label = text || "link text";
		const link = `[${label}](url)`;
		editor.executeEdits("fmt-link", [
			{ range: selection, text: link, forceMoveMarkers: true },
		]);
	};

	/**
	 * Pasting a URL only turns into `[label](url)` where markdown links mean
	 * something. Inside a fenced or indented code block, inside inline code, or
	 * inside YAML front matter, the user wants the bare URL they copied.
	 *
	 * The decision is taken once per paste, from the primary selection: a paste
	 * is a single user action, and re-tokenizing for every cursor of a large
	 * multi-cursor selection would cost far more than the edge case is worth.
	 */
	function isLinkifyPasteTarget(
		model: Monaco.editor.ITextModel,
		selection: Monaco.Selection,
	): boolean {
		return shouldLinkifyPastedUrl({
			languageId: model.getLanguageId(),
			content: model.getValue(),
			linesUpToCaret: model.getLinesContent().slice(0, selection.startLineNumber),
			column: selection.startColumn,
			tokenize: (text) => monaco.editor.tokenize(text, MARKDOWN_LANGUAGE_ID),
		});
	}

	function disposeLocalizedActions() {
		for (const action of localizedActions) action.dispose();
		localizedActions = [];
	}

	/**
	 * Every action whose label comes from `t()` is registered here, so the whole
	 * set can be rebuilt in one place when the UI language changes. Actions with
	 * no user-visible label (the Ctrl+V command) stay in `onMount`.
	 */
	function registerLocalizedActions(lang: LanguageCode) {
		// Belt and braces: Svelte runs the effect cleanup before a re-run, but
		// re-registering an id without disposing the old action would leave a
		// duplicate entry in the context menu, so never assume it happened.
		disposeLocalizedActions();

		// macOS reserves Cmd+Tab for the system application switcher, so a
		// CtrlCmd-based binding never reaches the editor there. VS Code binds the
		// real Ctrl key (KeyMod.WinCtrl) on macOS for its own Tab cycling.
		const tabCycleModifier = isMacPlatform()
			? monaco.KeyMod.WinCtrl
			: monaco.KeyMod.CtrlCmd;

		localizedActions = [
			// ⌘C. Keeps its label so the command palette can show it
			// translated; the work itself is the shared function.
			editor.addAction({
				id: "custom-copy",
				label: t('menu.copy', lang),
				keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyC],
				keybindingContext: "editorTextFocus",
				run: copyToClipboard,
			}),

			editor.addAction({
				id: "toggle-minimap",
				label: t('settings.minimap', lang),
				run: () => {
					settings.toggleMinimap();
				},
			}),

			editor.addAction({
				id: "toggle-word-wrap",
				label: t('settings.wordWrap', lang),
				run: () => {
					settings.toggleWordWrap();
				},
			}),

			editor.addAction({
				id: "toggle-line-numbers",
				label: t('settings.lineNumbers', lang),
				run: () => {
					settings.toggleLineNumbers();
				},
			}),

			editor.addAction({
				id: "toggle-vim-mode",
				label: t('settings.vimMode', lang),
				run: () => {
					settings.toggleVimMode();
				},
			}),

			editor.addAction({
				id: "toggle-status-bar",
				label: t('settings.statusBar', lang),
				run: () => {
					settings.toggleStatusBar();
				},
			}),

			editor.addAction({
				id: "toggle-word-count",
				label: t('settings.wordCount', lang),
				run: () => {
					settings.toggleWordCount();
				},
			}),

			editor.addAction({
				id: "toggle-line-highlight",
				label: t('settings.lineHighlight', lang),
				run: () => {
					settings.toggleLineHighlight();
				},
			}),

			editor.addAction({
				id: "toggle-occurrences-highlight",
				label: t('settings.occurrencesHighlight', lang),
				run: () => {
					settings.toggleOccurrencesHighlight();
				},
			}),

			editor.addAction({
				id: "toggle-whitespace",
				label: t('settings.showWhitespace', lang),
				run: () => {
					settings.toggleShowWhitespace();
				},
			}),

			editor.addAction({
				id: "toggle-tabs",
				label: t('settings.showTabs', lang),
				keybindings: [
					monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.KeyB,
				],
				run: () => {
					settings.toggleTabs();
				},
			}),

			editor.addAction({
				id: "toggle-zen-mode",
				label: t('settings.zenMode', lang),
				keybindings: [
					monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.KeyZ,
				],
				run: () => {
					settings.toggleZenMode();
				},
			}),

			editor.addAction({
				id: "fmt-bold",
				label: t('menu.bold', lang),
				keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyB],
				run: () => toggleInlineWrapTool("fmt-bold"),
			}),

			editor.addAction({
				id: "fmt-italic",
				label: t('menu.italic', lang),
				keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyI],
				run: () => toggleInlineWrapTool("fmt-italic"),
			}),

			editor.addAction({
				id: "fmt-underline",
				label: t('menu.underline', lang),
				keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyU],
				run: () => toggleTagFormat("<u>|</u>"),
			}),

			editor.addAction({
				id: "fmt-strikethrough",
				label: t('menu.strikethrough', lang),
				// GitHub's chord for this button, and free here: the Ctrl/Cmd+Shift
				// row is otherwise B, E, F, M, R, S, T and Z. Chosen against the whole
				// keymap for the reasons the block below sets out, and checked by the
				// same test.
				keybindings: [
					monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.KeyX,
				],
				run: () => toggleInlineWrapTool("fmt-strikethrough"),
			}),

			// The six bindings below were chosen against the whole keymap, not
			// against VS Code's: standalone Monaco and VS Code do not ship the
			// same defaults, and the chords the mainstream Markdown editors use
			// for these actions are the ones Monaco is most likely to be sitting
			// on. `addAction` registers at weight 1000, above every Monaco
			// default, so a clash is silent — our action simply wins and the
			// Monaco command loses its key. The reasoning per binding is below,
			// and `formatShortcutKeymap.test.ts` is what stops the next one from
			// landing on an occupied chord.

			editor.addAction({
				id: "fmt-inline-code",
				label: t('menu.inlineCode', lang),
				// GitHub's Markdown editor binds inline code to Ctrl/Cmd+E, but
				// plain Ctrl/Cmd+E is already `view-toggle-edit` here — which is
				// itself the mainstream reading (Obsidian and Mark Text both use
				// it for edit/read). So: same letter, plus Shift. Typora's
				// Ctrl+Shift+` and Mark Text's Ctrl+` are rejected on purpose —
				// #121 is *about* the backtick being a dead key on QWERTZ.
				keybindings: [
					monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.KeyE,
				],
				run: () => toggleInlineWrapTool("fmt-inline-code"),
			}),

			editor.addAction({
				id: "fmt-code-block",
				label: t('menu.codeBlock', lang),
				// No mainstream chord survives contact with Monaco. Typora and
				// Mark Text both use Ctrl+Shift+K on Windows/Linux, which is
				// `editor.action.deleteLines` on BOTH platforms, and both switch
				// to Cmd+Option+C on macOS, which is `toggleFindCaseSensitive`.
				// F is for the fences ("Code Fences" is Typora's own name for
				// the command); it is free everywhere.
				keybindings: [
					monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.KeyF,
				],
				run: () => wrapAsCodeBlock(),
			}),

			editor.addAction({
				id: "fmt-quote",
				label: t('menu.quote', lang),
				// GitHub's documented blockquote chord, and the only one that is
				// the same on both platforms in any editor surveyed: Shift+. is
				// `>` on a US layout, the blockquote marker itself. Typora and
				// Mark Text use Ctrl+Shift+Q, which macOS cannot deliver —
				// Shift+Cmd+Q is the system Log Out — which is why both of them
				// fall back to Cmd+Option+Q there.
				keybindings: [
					monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.Period,
				],
				run: () => toggleLineMarkerTool("fmt-quote"),
			}),

			// Typora binds Ctrl/Cmd+1..6 and Mark Text binds Cmd+1..6; Markpad
			// has only three heading actions, so it binds three. 4, 5 and 6 are
			// left unbound rather than given to something else, so completing
			// the range later moves nothing.
			editor.addAction({
				id: "fmt-heading-1",
				label: t('menu.heading1', lang),
				keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.Digit1],
				run: () => toggleLineMarkerTool("fmt-heading-1"),
			}),

			editor.addAction({
				id: "fmt-heading-2",
				label: t('menu.heading2', lang),
				keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.Digit2],
				run: () => toggleLineMarkerTool("fmt-heading-2"),
			}),

			editor.addAction({
				id: "fmt-heading-3",
				label: t('menu.heading3', lang),
				keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.Digit3],
				run: () => toggleLineMarkerTool("fmt-heading-3"),
			}),

			editor.addAction({
				id: "fmt-bullet-list",
				label: t('menu.bulletList', lang),
				run: () => toggleLineMarkerTool("fmt-bullet-list"),
			}),

			editor.addAction({
				id: "fmt-numbered-list",
				label: t('menu.numberedList', lang),
				run: () => toggleLineMarkerTool("fmt-numbered-list"),
			}),

			editor.addAction({
				id: "fmt-checklist",
				label: t('menu.checklist', lang),
				run: () => toggleLineMarkerTool("fmt-checklist"),
			}),

			editor.addAction({
				id: "fmt-link",
				label: t('menu.link', lang),
				run: () => insertLink(),
			}),

			editor.addAction({
				id: "insert-table-simple",
				label: t('menu.insertTable', lang),
				keybindings: [
					monaco.KeyMod.chord(
						monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyK,
						monaco.KeyCode.KeyT,
					),
				],
				run: () => {
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

					editor.executeEdits("insert-table", [
						{
							range: selection,
							text: table,
							forceMoveMarkers: true,
						},
					]);
				},
			}),

			editor.addAction({
				id: "file-new",
				label: t('menu.newFile', lang),
				keybindings: [
					monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyN,
					monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyT,
				],
				run: () => onnew?.(),
			}),

			editor.addAction({
				id: "file-open",
				label: t('menu.openFile', lang),
				keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyO],
				run: () => onopen?.(),
			}),

			editor.addAction({
				id: "file-save",
				label: t('menu.save', lang),
				keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS],
				run: () => onsave?.(),
			}),

			editor.addAction({
				id: "file-close",
				label: t('menu.closeFile', lang),
				keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyW],
				run: () => onclose?.(),
			}),

			editor.addAction({
				id: "file-reveal",
				label: t('menu.openLocation', lang),
				keybindings: [
					monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.KeyR,
				],
				run: () => onreveal?.(),
			}),

			editor.addAction({
				id: "view-toggle-edit",
				label: t('menu.toggleEditMode', lang),
				keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyE],
				run: () => ontoggleEdit?.(),
			}),

			editor.addAction({
				id: "view-toggle-live",
				label: t('menu.toggleLiveMode', lang),
				keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyL],
				run: () => ontoggleLive?.(),
			}),

			editor.addAction({
				id: "view-toggle-split",
				label: t('menu.toggleSplitView', lang),
				keybindings: [
					monaco.KeyMod.CtrlCmd | monaco.KeyCode.Backslash,
					monaco.KeyMod.CtrlCmd | monaco.KeyCode.IntlBackslash,
				],
				run: () => ontoggleSplit?.(),
			}),

			editor.addAction({
				id: "tab-next",
				label: t('menu.nextTab', lang),
				keybindings: [tabCycleModifier | monaco.KeyCode.Tab],
				run: () => onnextTab?.(),
			}),

			editor.addAction({
				id: "tab-prev",
				label: t('menu.previousTab', lang),
				keybindings: [
					tabCycleModifier | monaco.KeyMod.Shift | monaco.KeyCode.Tab,
				],
				run: () => onprevTab?.(),
			}),

			editor.addAction({
				id: "tab-undo-close",
				label: t('menu.undoCloseTab', lang),
				keybindings: [
					monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.KeyT,
				],
				run: () => onundoClose?.(),
			}),

			editor.addAction({
				id: "app-command-palette",
				label: t('menu.commandPalette', lang),
				keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyP],
				run: (ed) => {
					ed.trigger("keyboard", "editor.action.quickCommand", {});
				},
			}),

		];
	}

	$effect(() => {
		const lang = settings.language;
		if (!editorReady) return;

		registerLocalizedActions(lang);
		return disposeLocalizedActions;
	});

	onDestroy(disposeLocalizedActions);

	function getFrontMatterBodyStartLine(content: string) {
		const lines = content.split(/\r\n|\n|\r/);
		if (lines.length === 0 || lines[0].replace(/^\uFEFF/, '').trim() !== '---') return 1;

		for (let index = 1; index < lines.length; index += 1) {
			if (lines[index].trim() !== '---') continue;

			let bodyStartLine = index + 2;
			if (lines[bodyStartLine - 1]?.trim() === '') bodyStartLine += 1;
			return bodyStartLine;
		}

		return 1;
	}

	function getEditorContentScrollMax() {
		if (!editor) return 0;

		const layout = editor.getLayoutInfo();
		return Math.max(0, editor.getContentHeight() - layout.height);
	}

	function getEditorFrontMatterScrollEnd() {
		if (!editor) return 0;

		const model = editor.getModel();
		if (!model) return 0;

		const bodyStartLine = getFrontMatterBodyStartLine(model.getValue());
		if (bodyStartLine <= 1) return 0;

		const safeBodyStartLine = Math.max(1, Math.min(model.getLineCount(), bodyStartLine));
		return Math.max(0, Math.min(getEditorContentScrollMax(), editor.getTopForLineNumber(safeBodyStartLine)));
	}

	// Monaco's own line -> pixel measurement, which already accounts for folded
	// regions, wrapped lines and view zones. `getLineAtVerticalOffset` inverts it
	// by binary search, so this is called ~log2(lineCount) times per sync.
	function getEditorLineTop(line: number) {
		return editor ? editor.getTopForLineNumber(line) : 0;
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

	/**
	 * Cut, copy and paste — one implementation each, reached from the keyboard
	 * and from the context menu alike.
	 *
	 * All three go through Rust (`arboard`) rather than through the webview's
	 * `navigator.clipboard`, which is the only thing that works everywhere:
	 * wry leaves the webview's clipboard permission off by default, and turning
	 * it on does not help — tauri-apps/tauri#12007 is open on exactly this, and
	 * the official answer is the clipboard plugin, which is the same Rust route
	 * Markpad already had for ⌘V. Verified by hand on Windows: with the wry
	 * permission enabled, the webview's own paste still does nothing.
	 *
	 * Six entry points, three functions. Before this there were six
	 * implementations: ⌘X was the browser's, ⌘C and ⌘V were ours, and the three
	 * menu items were Monaco's — of which Paste could not work in a webview at
	 * all (#207) and Cut and Copy are dead on Linux, where the same wry default
	 * gates `set_javascript_can_access_clipboard`.
	 */
	function clipboardTextForSelection(): { text: string; range: Monaco.Range | null } {
		const selection = editor?.getSelection();
		const model = editor?.getModel();
		if (!selection || !model) return { text: '', range: null };

		if (!selection.isEmpty()) {
			return { text: model.getValueInRange(selection), range: selection };
		}

		// Nothing selected copies the whole line, line ending included —
		// Monaco's `emptySelectionClipboard` default, and VS Code's and Sublime
		// Text's. Kept because it is what this editor has always done; whether
		// an app that calls itself the Notepad equivalent should do it at all
		// is a separate question (#393).
		const line = selection.startLineNumber;
		const lastLine = model.getLineCount();
		return {
			text: model.getLineContent(line) + model.getEOL(),
			// Cutting that line has to take its line ending with it, so the
			// range runs to the start of the next one. The last line has no
			// next, and the range stops at its end.
			range:
				line < lastLine
					? new monaco.Range(line, 1, line + 1, 1)
					: new monaco.Range(line, 1, line, model.getLineMaxColumn(line)),
		};
	}

	export async function pasteFromClipboard() {
		// Focus first, as `runEditorAction` does, and for the same reason: this
		// runs from the context menu as well as from ⌘V, and a menu item leaves
		// the focus on itself. Paste then inserted the text and left no caret —
		// no blink, and the next ⌘Z went nowhere, which reads as "undo is
		// broken" rather than "the editor is not focused".
		//
		// A no-op on the ⌘V path, where the editor is focused by definition.
		editor?.focus();
			try {
				// check for image in clipboard via Rust
				const base64Image = await invoke("clipboard_read_image", { macosImageScaling: settings.macosImageScaling }).catch(() => null) as string | null;
				if (base64Image && tabManager.activeTab?.path) {
					const ext = "png"; // output of Rust command is always PNG
					const filename = `paste_${Date.now()}.${ext}`;

					const tabPath = tabManager.activeTab.path;
					const parentDir = documentParentDir(tabPath);
					if (parentDir !== null) {
						const imgDirName =
							settings.imageDirectory || DEFAULT_IMAGE_DIRECTORY;
						const relPath = (await invoke("save_image", {
							parentDir,
							filename,
							base64Data: base64Image,
							imageDirectory: imgDirName,
						})) as string;
						const embed = imageEmbed(relPath);

						const position = editor.getPosition();
						if (position) {
							const selection = editor.getSelection();
							const range =
								selection && !selection.isEmpty()
									? selection
									: new monaco.Range(
											position.lineNumber,
											position.column,
											position.lineNumber,
											position.column,
										);

							editor.executeEdits("paste-image", [
								{
									range,
									text: embed,
									forceMoveMarkers: true,
								},
							]);

							return;
						}
					}
				}

				// fall through to text paste via Rust
				const rawText = await invoke("clipboard_read_text").catch(() => "") as string;
				if (!rawText) return;
				
				const text = rawText.trim();
				const urlRegex = /^(?:(?:https?|file|tauri):\/\/|www\.)[^\s]{2,}$/i;
				const isUrl = urlRegex.test(text);

				const selections = editor.getSelections();
				const model = editor.getModel();
				if (!selections || selections.length === 0 || !model) {
					insertTextAtCursor(rawText);
					return;
				}

				// if it's not a URL or we have no multi-line selection/complex case, just insert
				const hasSelection = selections.some((s) => !s.isEmpty());
				const isMultiLine = selections.some((s) => s.startLineNumber !== s.endLineNumber);

				if (!isUrl || isMultiLine || !isLinkifyPasteTarget(model, selections[0])) {
					const edits = selections.map(s => ({
						range: s,
						text: rawText,
						forceMoveMarkers: true
					}));
					editor.executeEdits("paste-text", edits);
					return;
				}

				if (hasSelection) {
					const edits = selections.map((selection) => {
						const selectedText = model.getValueInRange(selection);
						// Pasting a URL over a URL replaces it. Wrapping would
						// nest the old URL as the link text — and inside
						// existing link syntax like ![](url) it produces
						// broken nesting: ![]([old](new)).
						if (urlRegex.test(selectedText.trim())) {
							return {
								range: selection,
								text,
								forceMoveMarkers: true,
							};
						}
						const linkUrl = text.toLowerCase().startsWith("www.")
							? `http://${text}`
							: text;
						return {
							range: selection,
							text: `[${selectedText}](${linkUrl})`,
							forceMoveMarkers: true,
						};
					});
					editor.executeEdits("paste-link", edits);
				} else {
					const displayText = text.replace(
						/^(?:https?|file|tauri):\/\/|www\./i,
						"",
					);
					const linkUrl = text.toLowerCase().startsWith("www.")
						? `http://${text}`
						: text;
					const template = `[${displayText}](${linkUrl})`;
					const edits = selections.map((selection) => {
						return {
							range: selection,
							text: template,
							forceMoveMarkers: true,
						};
					});

					editor.executeEdits("paste-link", edits);

					let accumulatedShift = 0;
					let lastLine = -1;
					const newSelections = selections.map((s) => {
						if (s.startLineNumber !== lastLine) {
							accumulatedShift = 0;
							lastLine = s.startLineNumber;
						}
						const startColumn = s.startColumn + accumulatedShift + 1;
						const endColumn = startColumn + displayText.length;
						accumulatedShift += template.length;
						return new monaco.Selection(
							s.startLineNumber,
							startColumn,
							s.startLineNumber,
							endColumn,
						);
					});
					editor.setSelections(newSelections);
				}
			} catch (err) {
				console.error("Paste failed:", err);
			}
	}

	export async function copyToClipboard() {
		editor?.focus();
		const { text } = clipboardTextForSelection();
		if (text) await invoke('clipboard_write_text', { text }).catch(console.error);
	}

	export async function cutToClipboard() {
		editor?.focus();
		const { text, range } = clipboardTextForSelection();
		if (!text || !range || !editor) return;
		await invoke('clipboard_write_text', { text }).catch(console.error);
		editor.executeEdits('cut', [{ range, text: '', forceMoveMarkers: true }]);
	}

	export function syncScrollToPosition(position: ScrollSyncPosition) {
		if (!editor) return;

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

		if (Math.abs(editor.getScrollTop() - targetScroll) <= 5) return;

		isApplyingExternalScroll = true;
		editor.setScrollTop(targetScroll, monaco.editor.ScrollType.Immediate);

		requestAnimationFrame(() => {
			isApplyingExternalScroll = false;
		});
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

			const scrollListener = editor.onDidScrollChange((e) => {
				if (e.scrollTopChanged) {
					emitSync();
				}
			});
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

		const switched = activeTabId !== currentTabId;

		if (switched && currentTabId) {
			const state = editor.saveViewState();
			tabManager.updateTabEditorState(currentTabId, state);
		}

		currentTabId = activeTabId;

		if (activeTabId) {
			const model = acquireTabModel(activeTabId, content, languageId);
			if (editor.getModel() !== model) editor.setModel(model);
		}

		if (editor.getValue() !== content) {
			editor.setValue(content);
		}

		if (switched) {
			// The view state is the editor's, not the model's — cursor, scroll,
			// selections and the folding contribution — so it still has to be
			// restored by hand, and only after the model it describes is
			// attached.
			if (tabManager.activeTab?.editorViewState) {
				editor.restoreViewState(tabManager.activeTab.editorViewState);
			} else {
				editor.setScrollTop(0);
				editor.setPosition({ lineNumber: 1, column: 1 });
			}
		}

		// Cheap on the hot path: this effect re-runs on every keystroke (it
		// reads `value`), and on a keystroke neither test holds.
		if (switched || currentLanguage !== languageId) syncStatusFromModel();
	});

	$effect(() => {
		if (editorReady && editor) {
			editor.updateOptions(editorOptionsFromSettings(settings, zoomLevel));
		}
	});


	$effect(() => {
		if (editorReady && editor && theme) {
			if (theme.startsWith("vscode:")) return;
			const targetTheme =
				theme === "system"
					? window.matchMedia("(prefers-color-scheme: dark)").matches
						? "app-theme-dark"
						: "app-theme-light"
					: theme === "dark"
						? "app-theme-dark"
						: "app-theme-light";
			monaco.editor.setTheme(targetTheme);
		}
	});

	$effect(() => {
		if (editorReady && editor && settings.vimMode && vimStatusNode) {
			let disposed = false;
			let vim: { dispose: () => void } | null = null;
			const currentEditor = editor;
			const currentStatusNode = vimStatusNode;
			import("monaco-vim").then(({ initVimMode, VimMode }) => {
				// Before the adapter is attached, and unconditionally: it patches
				// monaco-vim's own module-level command tables, which outlive this
				// effect, and it is idempotent. See vimScrollCommands.ts for what
				// 0.4.4 does to `zz`, `zt`, `zb`, `z.`, `z-` and `z<CR>` (#104).
				installVimScrollCommands(VimMode);
				if (disposed) return;
				vim = initVimMode(currentEditor, currentStatusNode);
			});
			return () => {
				disposed = true;
				vim?.dispose();
			};
		}
	});
	export async function handleDroppedFile(path: string, x: number, y: number) {
		if (!editor || !tabManager.activeTab?.path) return;

		const target = (editor as any).getTargetAtClientPoint(x, y);
		const position = target?.position || editor.getPosition();
		if (!position) return;

		const tabPath = tabManager.activeTab.path;
		const parentDir = documentParentDir(tabPath);
		if (parentDir === null) return;

		try {
			const imgDirName = settings.imageDirectory || DEFAULT_IMAGE_DIRECTORY;
			const relPath = (await invoke("copy_file_to_img", {
				srcPath: path,
				parentDir,
				imageDirectory: imgDirName,
			})) as string;
			const embed = imageEmbed(relPath);

			editor.executeEdits(
				"drop-image",
				[
					{
						range: new monaco.Range(
							position.lineNumber,
							position.column,
							position.lineNumber,
							position.column,
						),
						text: embed,
						forceMoveMarkers: true,
					},
				],
				[
					new monaco.Selection(
						position.lineNumber,
						position.column + embed.length,
						position.lineNumber,
						position.column + embed.length,
					),
				],
			);
		} catch (err) {
			console.error("Failed to copy dropped file:", err);
		}
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

	/**
	 * A jump asked for before the editor existed. `monaco-editor` is imported
	 * dynamically, so `bind:this` on this component resolves — and the preview
	 * can call in — several frames before `editor` does; without somewhere to
	 * put it, a jump issued in the same turn as the switch into edit mode is
	 * simply dropped. `onMount` spends it once the editor is up.
	 */
	let pendingReveal: { startLine: number; endLine: number } | null = null;

	/**
	 * Put the reader on `startLine`..`endLine` of the buffer.
	 *
	 * The one line-to-editor jump in this component. The outline reaches it
	 * through `revealHeader`, and the preview's context-menu "Edit" calls it
	 * with the source range of whatever the reader had selected (#90).
	 *
	 * The selection IS the highlight #90 asks for: Monaco draws it in the
	 * theme's own selection colour, so it needs no decoration, no CSS and no
	 * timer — and it clears itself on the reader's next click or keystroke,
	 * which is precisely when it has stopped being useful. A decoration that
	 * fades on a timer would be a second highlighting mechanism doing what this
	 * one already does, and would leave the caret at the top of the file.
	 */
	export function revealSourceRange(startLine: number, endLine: number) {
		if (!editorReady || !editor) {
			pendingReveal = { startLine, endLine };
			return;
		}

		const model = editor.getModel();
		if (!model) return;

		// Clamp before `getLineMaxColumn`, which throws on a line past the end
		// of the buffer. Both callers can hand one over: the preview's HTML is
		// the render of a buffer that may since have been replaced by a shorter
		// one (an external change, a session restored around a file edited
		// elsewhere), and the outline carries the same lines.
		const lastLine = model.getLineCount();
		const start = Math.min(Math.max(1, Math.trunc(startLine)), lastLine);
		const end = Math.min(Math.max(start, Math.trunc(endLine)), lastLine);

		editor.revealLineInCenterIfOutsideViewport(start, monaco.editor.ScrollType.Smooth);
		editor.setSelection({
			startLineNumber: start,
			startColumn: 1,
			endLineNumber: end,
			endColumn: model.getLineMaxColumn(end),
		});
		editor.focus();
	}

	/**
	 * `sourceLine` is a BUFFER line, and the type is the whole point: the
	 * outline reads `data-sourcepos`, which counts from the first line of the
	 * body, and handed it over unshifted for as long as both features existed.
	 * The caller now has to go through `lineCoordinates` to produce one.
	 */
	export function revealHeader(sourceLine: BufferLine | null, text: string) {
		if (!editor) return;
		const model = editor.getModel();
		if (!model) return;
		const lineNumber = sourceLine ?? 0;
		if (Number.isInteger(lineNumber) && lineNumber > 0) {
			revealSourceRange(lineNumber, lineNumber);
			return;
		}

		const escapedText = text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
		const regex = new RegExp(`^#+\\s+.*${escapedText}.*$`, "m");
		
		const match = model.findNextMatch(regex.source, { lineNumber: 1, column: 1 }, true, false, null, true);
		
		if (match) {
			editor.revealLineInCenterIfOutsideViewport(match.range.startLineNumber, monaco.editor.ScrollType.Smooth);
			editor.setSelection(match.range);
			editor.focus();
		} else {
			const fallbackMatch = model.findNextMatch(escapedText, { lineNumber: 1, column: 1 }, false, false, null, false);
			if (fallbackMatch) {
				editor.revealLineInCenterIfOutsideViewport(fallbackMatch.range.startLineNumber, monaco.editor.ScrollType.Smooth);
				editor.setSelection(fallbackMatch.range);
				editor.focus();
			}
		}
	}

	export const undo = () => {
		editor?.focus();
		editor?.trigger("keyboard", "undo", null);
	}

	export const redo = () => {
		editor?.focus();
		editor?.trigger("keyboard", "redo", null);
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

	export const getValue = () => editor?.getValue() || "";
	export const setValue = (val: string) => editor?.setValue(val);
	export const focus = () => editor?.focus();
	export const restoreViewState = (state: any) => editor?.restoreViewState(state);
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
				{t('editor.status.words', settings.language).replace('{{count}}', wordCount.toString())}
			</div>
		{/if}
		<div class="status-item">
			{zoomLevel}%
		</div>
		<div class="status-item">
			{currentLanguage}
		</div>
		<!-- Not translated, like the language id and the zoom level above it:
		     "LF" and "CRLF" are acronyms, and the `crlf` key they replace held
		     the same ASCII in all five locales that bothered to define it. -->
		<div class="status-item">{lineEnding}</div>
		<!-- Still hardcoded, and still the only thing here that is: the document's
		     real encoding is detected in `fix/non-utf8-documents` (#372), which
		     puts it on `Tab.encoding`. Wire this to that field when it lands —
		     duplicating the detection to make the label true sooner would leave
		     two answers to one question. -->
		<div class="status-item">{encoding}</div>
	</div>
{/if}

<style>
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

	.status-bar {
		padding: 0 10px;
		font-family: "Segoe UI", Tahoma, Geneva, Verdana, sans-serif;
		font-size: 12px;
		background: var(--bg-tertiary);
		border-top: 1px solid var(--color-border-muted);
		color: var(--text-primary);
		display: flex;
		align-items: center;
		justify-content: flex-end;
		min-height: 22px;
		gap: 20px;
		user-select: none;
	}

	.status-item {
		opacity: 0.8;
	}
</style>
