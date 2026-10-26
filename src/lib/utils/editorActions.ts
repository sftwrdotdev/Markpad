import type * as Monaco from 'monaco-editor';

import type { InlineWrapToolId, LineMarkerToolId } from './editorToolbar.js';
import { t, type LanguageCode } from './i18n.js';
import type { TableOperation } from './tableEditing.js';
import type { ViewerCommand } from './viewerKeymap.js';

/**
 * The editor's keymap: every action it registers (id, translated label,
 * keybindings, `run`) and every nameless key command, as data.
 *
 * `Editor.svelte` hands these to `editor.addAction` / `editor.addCommand`. They
 * live here rather than in the component so a test can ask what a chord is bound
 * to, and what running it does, without Monaco or a mounted component. Monaco is
 * passed in for its `KeyMod`/`KeyCode` numbers, because the component loads it
 * with a dynamic `import()` and this module must not pull it into the startup
 * graph.
 */

/** The two Monaco namespaces a keybinding number is built from. */
export type MonacoKeys = { KeyMod: typeof Monaco.KeyMod; KeyCode: typeof Monaco.KeyCode };

/** What the actions' `run` reaches: the editing primitives and settings the component owns. */
export type EditorActionDeps = {
	monaco: MonacoKeys;
	isMac: boolean;
	settings: {
		minimap: boolean;
		vimMode: boolean;
		statusBar: boolean;
		wordCount: boolean;
		occurrencesHighlight: boolean;
		showWhitespace: boolean;
		toggleWordWrap(): void;
		toggleLineNumbers(): void;
		toggleLineHighlight(): void;
	};
	oncommand?: (command: ViewerCommand) => void;
	copyToClipboard: () => Promise<void>;
	toggleInlineWrapTool: (id: InlineWrapToolId) => void;
	toggleTagFormat: (marker: string) => void;
	toggleLineMarkerTool: (id: LineMarkerToolId) => void;
	wrapAsCodeBlock: () => void;
	insertLink: () => void;
	insertSimpleTable: () => void;
	editTable: (operation: TableOperation) => boolean;
};

/**
 * Every action whose label comes from `t()`, labelled in `lang`. The component
 * re-registers the whole set when the UI language changes.
 */
export function editorActions(deps: EditorActionDeps, lang: LanguageCode): Monaco.editor.IActionDescriptor[] {
	const {
		monaco,
		settings,
		oncommand,
		copyToClipboard,
		toggleInlineWrapTool,
		toggleTagFormat,
		toggleLineMarkerTool,
		wrapAsCodeBlock,
		insertLink,
		insertSimpleTable,
		editTable,
	} = deps;

	// macOS reserves Cmd+Tab for the system application switcher, so a
	// CtrlCmd-based binding never reaches the editor there. VS Code binds the
	// real Ctrl key (KeyMod.WinCtrl) on macOS for its own Tab cycling.
	const tabCycleModifier = deps.isMac
		? monaco.KeyMod.WinCtrl
		: monaco.KeyMod.CtrlCmd;

	return [
		// ⌘C. Keeps its label so the command palette can show it
		// translated; the work itself is the shared function.
		{
			id: "custom-copy",
			label: t('menu.copy', lang),
			keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyC],
			keybindingContext: "editorTextFocus",
			run: copyToClipboard,
		},

		{
			id: "toggle-minimap",
			label: t('settings.minimap', lang),
			run: () => {
				settings.minimap = !settings.minimap;
			},
		},

		{
			id: "toggle-word-wrap",
			label: t('settings.wordWrap', lang),
			run: () => {
				settings.toggleWordWrap();
			},
		},

		{
			id: "toggle-line-numbers",
			label: t('settings.lineNumbers', lang),
			run: () => {
				settings.toggleLineNumbers();
			},
		},

		{
			id: "toggle-vim-mode",
			label: t('settings.vimMode', lang),
			run: () => {
				settings.vimMode = !settings.vimMode;
			},
		},

		{
			id: "toggle-status-bar",
			label: t('settings.statusBar', lang),
			run: () => {
				settings.statusBar = !settings.statusBar;
			},
		},

		{
			id: "toggle-word-count",
			label: t('settings.wordCount', lang),
			run: () => {
				settings.wordCount = !settings.wordCount;
			},
		},

		{
			id: "toggle-line-highlight",
			label: t('settings.lineHighlight', lang),
			run: () => {
				settings.toggleLineHighlight();
			},
		},

		{
			id: "toggle-occurrences-highlight",
			label: t('settings.occurrencesHighlight', lang),
			run: () => {
				settings.occurrencesHighlight = !settings.occurrencesHighlight;
			},
		},

		{
			id: "toggle-whitespace",
			label: t('settings.showWhitespace', lang),
			run: () => {
				settings.showWhitespace = !settings.showWhitespace;
			},
		},

		{
			id: "toggle-tabs",
			label: t('settings.showTabs', lang),
			keybindings: [
				monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.KeyB,
			],
			run: () => oncommand?.("toggle-tabs"),
		},

		{
			id: "toggle-zen-mode",
			label: t('settings.zenMode', lang),
			// THE THIRD ADDRESS THIS COMMAND HAS HAD, and the first two are why
			// the note is this long. It was Ctrl/Cmd+Shift+Z, which is REDO — on
			// macOS redo's ONLY key, because Monaco's mac override replaces the
			// default rule rather than adding to it, so Cmd+Y (the escape hatch
			// Windows and Linux keep) does not exist there. `addAction` registers
			// at weight 1000, so zen mode did not share that key, it took it, and
			// a mac user had no way to redo from the keyboard at all.
			//
			// Then Ctrl/Cmd+Shift+D, which was free — but the Ctrl/Cmd+Shift row
			// is where the formatting verbs live (B, E, F, X and now the digits),
			// and a view mode is not one of them. Ctrl/Cmd+Alt+Z is unclaimed in
			// Monaco on all three platforms, Z is for zen, and it sits with the
			// other Alt-modified commands rather than among the formatters.
			// `editor.chords.spec.ts` reads Monaco's real keymap and is
			// what refuses the next such landing.
			keybindings: [
				monaco.KeyMod.CtrlCmd | monaco.KeyMod.Alt | monaco.KeyCode.KeyZ,
			],
			keybindingContext: "!altGraphChord",
			run: () => oncommand?.("toggle-zen-mode"),
		},

		{
			id: "fmt-bold",
			label: t('menu.bold', lang),
			keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyB],
			run: () => toggleInlineWrapTool("fmt-bold"),
		},

		{
			id: "fmt-italic",
			label: t('menu.italic', lang),
			keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyI],
			run: () => toggleInlineWrapTool("fmt-italic"),
		},

		{
			id: "fmt-underline",
			label: t('menu.underline', lang),
			keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyU],
			run: () => toggleTagFormat("<u>|</u>"),
		},

		{
			id: "fmt-strikethrough",
			label: t('menu.strikethrough', lang),
			// GitHub's chord. editor.chords.spec.ts checks Monaco binds
			// nothing on it.
			keybindings: [
				monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.KeyX,
			],
			run: () => toggleInlineWrapTool("fmt-strikethrough"),
		},

		// The six bindings below were chosen against the whole keymap, not
		// against VS Code's: standalone Monaco and VS Code do not ship the
		// same defaults, and the chords the mainstream Markdown editors use
		// for these actions are the ones Monaco is most likely to be sitting
		// on. `addAction` registers at weight 1000, above every Monaco
		// default, so a clash is silent — our action simply wins and the
		// Monaco command loses its key. The reasoning per binding is below,
		// and `shortcuts.checks.test.ts` is what stops the next one from
		// landing on an occupied chord.

		{
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
		},

		{
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
		},

		{
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
		},

		// Typora binds Ctrl/Cmd+1..6 and Mark Text binds Cmd+1..6; Markpad
		// has only three heading actions, so it binds three. 4, 5 and 6 are
		// left unbound rather than given to something else, so completing
		// the range later moves nothing.
		{
			id: "fmt-heading-1",
			label: t('menu.heading1', lang),
			keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.Digit1],
			run: () => toggleLineMarkerTool("fmt-heading-1"),
		},

		{
			id: "fmt-heading-2",
			label: t('menu.heading2', lang),
			keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.Digit2],
			run: () => toggleLineMarkerTool("fmt-heading-2"),
		},

		{
			id: "fmt-heading-3",
			label: t('menu.heading3', lang),
			keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.Digit3],
			run: () => toggleLineMarkerTool("fmt-heading-3"),
		},

		// The three list buttons, which had actions and no keys at all.
		// Ctrl/Cmd+Shift+7 and +8 are GitHub's documented chords, the same on
		// both its platforms, and Monaco leaves the whole Ctrl/Cmd+Shift digit
		// row alone except for `1` (replaceOne). Numbered is 7 and bulleted is
		// 8 because that is the way round GitHub has them.
		{
			id: "fmt-bullet-list",
			label: t('menu.bulletList', lang),
			keybindings: [
				monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.Digit8,
			],
			run: () => toggleLineMarkerTool("fmt-bullet-list"),
		},

		{
			id: "fmt-numbered-list",
			label: t('menu.numberedList', lang),
			keybindings: [
				monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.Digit7,
			],
			run: () => toggleLineMarkerTool("fmt-numbered-list"),
		},

		// 9 HAS NO PRECEDENT, and this says so rather than implying one:
		// GitHub documents no task-list chord, nor do Typora and Obsidian, and
		// the two editors that do bind one disagree and are both occupied here
		// (Bear's Cmd+T is New File; iA Writer's Opt+Cmd+L is Monaco's
		// `toggleFindInSelection` on macOS). So the third list button takes the
		// digit next to the two above it.
		{
			id: "fmt-checklist",
			label: t('menu.checklist', lang),
			keybindings: [
				monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.Digit9,
			],
			run: () => toggleLineMarkerTool("fmt-checklist"),
		},

		{
			id: "fmt-link",
			label: t('menu.link', lang),
			// ⌘K / Ctrl+K. Typora, Bear, iA Writer and GitHub all document this
			// for Insert Link — the only command in the survey where four
			// independent sources agree exactly — and the button had no key at
			// all.
			//
			// Monaco binds no COMPLETE keybinding on Ctrl/Cmd+K; what it binds is
			// 31 chord SEQUENCES behind it. Claiming the key as a whole chord
			// ends that namespace, which is deliberate and argued in
			// editor.chords.spec.ts rather than here, because the loss is
			// keymap-wide rather than one command's.
			keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyK],
			run: () => insertLink(),
		},

		{
			id: "insert-table-simple",
			label: t('menu.insertTable', lang),
			// ONE STROKE, not a sequence. This was `Mod+K T` (in both its
			// released and modifier-held forms, the way VS Code registers its own
			// Mod+K chords); Mod+K is Insert Link now, and a two-key gesture was
			// awkward enough to press that it is what started this rework.
			// Ctrl+Alt+T / ⌥⌘T is Typora's and Bear's chord for the same command,
			// and Monaco binds nothing on it on any of the three platforms.
			keybindings: [
				monaco.KeyMod.CtrlCmd | monaco.KeyMod.Alt | monaco.KeyCode.KeyT,
			],
			keybindingContext: "!altGraphChord",
			run: () => insertSimpleTable(),
		},

		// The rest of the table verbs. Actions rather than bare commands, so the
		// command palette and the shortcuts panel can list them. Which verbs get
		// a chord: TABLE_VERBS_WITHOUT_A_CHORD in shortcuts.test.ts.
		{
			id: "table-insert-row",
			label: t('menu.insertTableRow', lang),
			run: () => {
				editTable("insert-row");
			},
		},

		{
			id: "table-delete-row",
			label: t('menu.deleteTableRow', lang),
			run: () => {
				editTable("delete-row");
			},
		},

		{
			id: "table-insert-column",
			label: t('menu.insertTableColumn', lang),
			// C for Column, and one of the "insert a structure" family: it sits
			// with Ctrl/Cmd+Shift+7, +8 and +9, which insert the three list
			// kinds. Monaco binds nothing on Ctrl/Cmd+Shift+C on any of the three
			// platforms, as a whole chord or as a prefix.
			//
			// It was on `Mod+K C`, which cannot be typed any more: `Mod+K` is
			// Insert Link and is no longer a prefix. `Mod+Alt+C` was the obvious
			// replacement and had to be refused — see the note above
			// DELIBERATE_OVERRIDES in editor.chords.spec.ts. Palette-only
			// was tried first and is too weak for a verb people reach for while
			// building a table: Mod+P, type the name, Enter.
			keybindings: [
				monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.KeyC,
			],
			run: () => {
				editTable("insert-column");
			},
		},

		{
			id: "table-delete-column",
			label: t('menu.deleteTableColumn', lang),
			// Backspace, not D: D sits next to Insert Column's C, and one slip
			// would delete a column. Monaco binds nothing on this chord.
			keybindings: [
				monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.Backspace,
			],
			run: () => {
				editTable("delete-column");
			},
		},

		{
			id: "file-new",
			label: t('menu.newFile', lang),
			keybindings: [
				monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyN,
				monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyT,
			],
			run: () => oncommand?.("new-file"),
		},

		{
			id: "file-open",
			label: t('menu.openFile', lang),
			keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyO],
			run: () => oncommand?.("open-file"),
		},

		{
			id: "file-save",
			label: t('menu.save', lang),
			keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS],
			run: () => oncommand?.("save"),
		},

		{
			id: "file-close",
			label: t('menu.closeFile', lang),
			keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyW],
			run: () => oncommand?.("close-file"),
		},

		{
			id: "app-home",
			label: t('menu.home', lang),
			keybindings: [
				monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.KeyH,
			],
			run: () => oncommand?.("toggle-home"),
		},

		{
			id: "file-reveal",
			label: t('menu.openFileLocation', lang),
			keybindings: [
				monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.KeyR,
			],
			run: () => oncommand?.("reveal-file"),
		},

		{
			id: "file-export-pdf",
			label: t('menu.exportPdf', lang),
			keybindings: [
				monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.KeyP,
			],
			run: () => oncommand?.("export-pdf"),
		},

		{
			id: "view-toggle-edit",
			label: t('menu.editMode', lang),
			keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyE],
			run: () => oncommand?.("toggle-edit-view"),
		},

		{
			id: "view-toggle-live",
			label: t('menu.autoReload', lang),
			keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyL],
			run: () => oncommand?.("toggle-live-mode"),
		},

		{
			id: "view-toggle-split",
			label: t('menu.toggleSplitView', lang),
			keybindings: [
				monaco.KeyMod.CtrlCmd | monaco.KeyCode.Backslash,
				monaco.KeyMod.CtrlCmd | monaco.KeyCode.IntlBackslash,
			],
			run: () => oncommand?.("toggle-split-view"),
		},

		{
			id: "tab-next",
			label: t('menu.nextTab', lang),
			keybindings: [tabCycleModifier | monaco.KeyCode.Tab],
			run: () => oncommand?.("next-tab"),
		},

		{
			id: "tab-prev",
			label: t('menu.previousTab', lang),
			keybindings: [
				tabCycleModifier | monaco.KeyMod.Shift | monaco.KeyCode.Tab,
			],
			run: () => oncommand?.("previous-tab"),
		},

		{
			id: "tab-undo-close",
			label: t('menu.undoCloseTab', lang),
			keybindings: [
				monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.KeyT,
			],
			run: () => oncommand?.("undo-close-tab"),
		},

		{
			id: "app-command-palette",
			label: t('menu.commandPalette', lang),
			keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyP],
			run: (ed) => {
				ed.trigger("keyboard", "editor.action.quickCommand", {});
			},
		},

	];
}

/** The component functions a nameless key command can run. */
export type EditorKeyHandler =
	| 'cutToClipboard'
	| 'pasteFromClipboard'
	| 'continueListOnEnter'
	| 'handleTabKey'
	| 'handleShiftTabKey'
	| 'handleModEnterKey'
	| 'handleModShiftEnterKey';

/** One `editor.addCommand(binding, handler, when)` call. */
export type EditorKeyCommand = { binding: number; handler: EditorKeyHandler; when: string };

/**
 * The keys the editor binds with no action id: no label, no menu entry, so
 * `editorActions` cannot carry them.
 *
 * ⌘X and ⌘V. Monaco leaves cut and paste unbound in a browser ("Do not bind cut
 * keybindings in the browser, since browsers do that for us" — clipboard.js), so
 * the slots are free and binding them is what makes the keyboard and the
 * context menu run the same code. Ctrl+C is a localized action instead, so its
 * label can follow the UI language; Ctrl+V has no label, so it has nothing to
 * re-register on a language change.
 *
 * Enter, Tab and Shift+Tab inside a list item or a table (#604). Bare commands
 * rather than actions for the same reason Ctrl+V is one: they carry no label and
 * appear in no menu — they are what those three keys already mean, one Markdown
 * rule further on. The shortcuts panel does list them (group `context` in
 * utils/shortcuts.ts), because a behaviour nobody is told about is a behaviour
 * nobody uses.
 *
 * ONE HANDLER PER KEY, dispatching inside. Tab is a table key, a list key and a
 * Tab, in that order of specificity; two commands on one chord would leave which
 * of them wins to Monaco's registration order.
 *
 * THE `when` CLAUSES ARE THE WHOLE RISK HERE.
 *
 * `addCommand` registers at weight 1000, above every Monaco default including
 * the suggest widget's — so a binding with no condition does not merely add a
 * meaning to Enter, it TAKES Enter away from whatever else wanted it. Each
 * clause below names something that owns the key first:
 *
 *   editorTextFocus      the caret is in the text, not in the find box or
 *                        the rename input (both of which take Enter);
 *   !editorReadonly      reading mode types nothing;
 *   !suggestWidgetVisible  the completion popup is open, where Enter
 *                        accepts and Tab accepts — this app has a heading
 *                        and a file-path completion provider, so it is a
 *                        live case, not a hypothetical one;
 *   !inSnippetMode       Tab jumps to the next placeholder;
 *   !editorTabMovesFocus the accessibility toggle, whose entire purpose is
 *                        that Tab leaves the editor.
 *
 * Neither handler is a dead end: when the caret is not on a list item they
 * re-trigger the ordinary command, so a non-list Enter is a plain Enter and a
 * non-list Tab is a plain Tab, auto-indent and all.
 *
 * VIM MODE NEEDS NO CLAUSE OF ITS OWN. monaco-vim listens on `editor.onKeyDown`,
 * which fires on the textarea — inside the container the keybinding service
 * listens on — and it calls `stopPropagation()` on every key its keymap claims.
 * So in normal mode vim's Enter (move down a line) runs and this command never
 * sees the key; in insert mode vim passes the key through and continuation
 * happens, which is what a vim user writing a list wants. The order is DOM
 * nesting, not luck.
 */
export function editorKeyCommands(monaco: MonacoKeys): EditorKeyCommand[] {
	const EDITING_KEY_CONTEXT =
		"editorTextFocus && !editorReadonly && !suggestWidgetVisible && !inSnippetMode";
	return [
		{ binding: monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyX, handler: 'cutToClipboard', when: "editorTextFocus" },
		{ binding: monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyV, handler: 'pasteFromClipboard', when: "editorTextFocus" },
		{ binding: monaco.KeyCode.Enter, handler: 'continueListOnEnter', when: EDITING_KEY_CONTEXT },
		{
			binding: monaco.KeyCode.Tab,
			handler: 'handleTabKey',
			when: `${EDITING_KEY_CONTEXT} && !editorTabMovesFocus`,
		},
		{
			binding: monaco.KeyMod.Shift | monaco.KeyCode.Tab,
			handler: 'handleShiftTabKey',
			when: `${EDITING_KEY_CONTEXT} && !editorTabMovesFocus`,
		},
		// The same two keys Monaco binds to Insert Line Below / Above, which is why
		// they need no guard of their own beyond the shared one: the only other
		// claimants on Mod+Enter in the bundle are the find widget's Replace All and
		// the references peek, and `editorTextFocus` is false in both.
		{
			binding: monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter,
			handler: 'handleModEnterKey',
			when: EDITING_KEY_CONTEXT,
		},
		{
			binding: monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.Enter,
			handler: 'handleModShiftEnterKey',
			when: EDITING_KEY_CONTEXT,
		},
	];
}
