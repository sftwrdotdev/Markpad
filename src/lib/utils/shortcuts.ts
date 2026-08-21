/**
 * The keyboard shortcuts the app advertises, in one place.
 *
 * WHY THIS FILE EXISTS
 *
 * "What is the shortcut for X" used to be answered in three places that nothing
 * held together: `editorToolbar.ts` (the button tooltip), `TitleBar.svelte`
 * (fourteen hard-coded literals in markup) and the handlers themselves
 * (`editor.addAction` keybindings in `Editor.svelte`, the document-level
 * `keydown` branch in `MarkdownViewer.svelte`). Only the first was ever tested,
 * and only since #480. A shortcuts panel that carried its own list would have
 * been a fourth copy — and the one users would trust most.
 *
 * So this is the single copy the display layers read, and
 * `scripts/shortcutRegistry.test.ts` ties it to the handlers: every chord below
 * is fired at the real code and has to run the command it is labelled with.
 * The registry is not a source of truth about behaviour — the handlers are —
 * it is a claim about them that a test refuses to let drift.
 *
 * WHAT IS NOT HERE
 *
 * The clipboard chords (`Mod+C`, `Mod+V`). They are OS conventions rather than
 * app shortcuts, and `Mod+V` is registered as a bare `addCommand` with no id,
 * so listing Copy without Paste would be the more confusing half-answer.
 */

/**
 * Which menu the command would live under. Four of the five labels are the
 * existing menu-bar categories, so grouping the panel cost no new translations.
 *
 * `keys` is the fifth and is not a menu. Enter, Tab, Shift+Tab and the two
 * Mod+Enter keys do different things depending on what the caret is sitting on —
 * continue a list, move to the next table cell, add a table row — and a
 * behaviour attached to a CONTEXT rather than to a command has no menu entry to
 * live under and no command name to be listed as.
 * It was invisible in the app until this group existed: #636 shipped list
 * continuation and nothing anywhere told a user it was there.
 */
import type { ViewerCommand } from './viewerKeymap.js';

type ShortcutGroup = 'file' | 'edit' | 'keys' | 'view' | 'window';

/** Display order of the groups, and the i18n key that titles each one. */
export const SHORTCUT_GROUPS: ReadonlyArray<{ group: ShortcutGroup; labelKey: string }> = [
	{ group: 'file', labelKey: 'menu.file' },
	{ group: 'edit', labelKey: 'menu.edit' },
	{ group: 'keys', labelKey: 'keys.group' },
	{ group: 'view', labelKey: 'menu.view' },
	{ group: 'window', labelKey: 'menu.window' },
];

/** The platforms the app distinguishes, spelled the way `settings.osType` does. */
type ShortcutPlatform = 'macos' | 'windows' | 'linux';

export type ShortcutEntry = {
	/**
	 * Stable id. Where `editorAction` is true this IS the Monaco action id, which
	 * is also the toolbar tool id — that is what lets one row serve the panel and
	 * the toolbar tooltip at once.
	 */
	readonly id: string;
	/**
	 * An i18n key that already exists and is already translated. New user-visible
	 * strings were deliberately not minted for the command names: every one of
	 * these labels was already in the dictionary for a menu entry or a context
	 * menu, in all 26 locales.
	 */
	readonly labelKey: string;
	/**
	 * The chords, most-advertised first. Written in the spelling the CODE uses,
	 * which is not always the spelling a user reads: `Mod` renders as `Cmd` on
	 * macOS and `Ctrl` elsewhere, and `Alt` renders as `Opt` on macOS. A
	 * literal `Ctrl` stays `Ctrl` on every platform, which is what tab cycling
	 * actually binds.
	 *
	 * Consumers with room for one chord (the app menu, the toolbar tooltip) show
	 * `chords[0]`; the panel shows all of them.
	 */
	readonly chords: readonly string[];
	readonly group: ShortcutGroup;
	/** `Editor.svelte` registers this chord on a Monaco action whose id is `id`. */
	readonly editorAction?: true;
	/**
	 * The name of the handler `Editor.svelte` binds this chord to with a bare
	 * `editor.addCommand` — no action id, no label, no menu entry.
	 *
	 * The `keys` group needs this because there is no action id to check against:
	 * a contextual key IS a nameless command. Recording the handler's name keeps
	 * the row as verifiable as every other one — `shortcutRegistry.test.ts` reads
	 * the component's `addCommand` calls, evaluates the keybinding with Monaco's
	 * own `KeyMod`/`KeyCode`, and requires that this chord be bound to this
	 * function.
	 */
	readonly editorCommand?: string;
	/**
	 * The command the document-level dispatcher means by this row's chords when
	 * the editor does not have focus.
	 *
	 * One entry means every chord in the row runs it (`file-new` binds both
	 * `Mod+T` and `Mod+N`); otherwise there is one per chord, in `chords` order,
	 * which is how `view-preview-width`'s `[` and `]` say which way each goes.
	 *
	 * A `ViewerCommand` rather than a function name, now that the dispatcher has
	 * a module of its own: the compiler now rejects a row naming a
	 * command that does not exist, where the old free-text spellings
	 * (`showSettings=true`, `settings.previewMaxWidth=`, `toggleEdit` for a
	 * function called `toggleEditView`) were matched by prefix and could only be
	 * checked at runtime — and `tab-next` and `tab-prev` both said
	 * `tabManager.cycleTab`, so nothing could tell them apart.
	 */
	readonly documentCommands?: readonly ViewerCommand[];
	/**
	 * Platforms where the document handler deliberately stays out of the way.
	 * Only Quit uses this: on macOS the native Tauri menu owns `Cmd+Q` and the
	 * handler returns early, so the chord is real but answered somewhere else.
	 */
	readonly documentExempt?: readonly ShortcutPlatform[];
	/** The accelerator the native macOS menu claims, for the same reason. */
	readonly nativeMenuAccelerator?: string;
};

/**
 * Every user-visible shortcut, grouped for display.
 *
 * Each row is checked against the code that implements it. Adding a row without
 * a matching binding fails `scripts/shortcutRegistry.test.ts`, which is the
 * whole point: the panel cannot advertise a chord the app does not answer.
 */
export const SHORTCUTS: readonly ShortcutEntry[] = [
	// ---------------------------------------------------------------- file
	{
		id: 'file-new',
		labelKey: 'menu.newFile',
		// Both are bound. `Mod+T` first because that is what the tab strip's `+`
		// button and the app menu have always printed.
		chords: ['Mod+T', 'Mod+N'],
		group: 'file',
		editorAction: true,
		documentCommands: ['new-file'],
	},
	{
		id: 'file-open',
		labelKey: 'menu.openFile',
		chords: ['Mod+O'],
		group: 'file',
		editorAction: true,
		documentCommands: ['open-file'],
	},
	{
		id: 'file-save',
		labelKey: 'menu.save',
		chords: ['Mod+S'],
		group: 'file',
		editorAction: true,
		documentCommands: ['save'],
	},
	{
		id: 'file-save-as',
		labelKey: 'menu.saveAs',
		// The chord the app menu has always printed. It is bound for the first
		// time here: until now the save branch matched `cmdOrCtrl && key === 's'`
		// with no Shift guard, so the advertised keystroke ran a plain Save.
		chords: ['Mod+Shift+S'],
		group: 'file',
		documentCommands: ['save-as'],
	},
	{
		id: 'file-reload',
		labelKey: 'menu.reloadFromDisk',
		chords: ['F5'],
		group: 'file',
		documentCommands: ['reload-from-disk'],
	},
	{
		id: 'file-close',
		labelKey: 'menu.closeFile',
		chords: ['Mod+W'],
		group: 'file',
		editorAction: true,
		documentCommands: ['close-file'],
	},
	{
		id: 'file-export-pdf',
		labelKey: 'menu.exportPdf',
		// `Mod+Shift+E`, as #673 suggested, is Inline Code — bound since the
		// formatting chords went in, and printed on the editor toolbar. `P` is
		// the print mnemonic, and the app's `Mod+P` is the command palette, so
		// the shifted spelling is both free and the nearest thing to what every
		// other app calls Print.
		chords: ['Mod+Shift+P'],
		group: 'file',
		editorAction: true,
		documentCommands: ['export-pdf'],
	},
	{
		id: 'file-reveal',
		labelKey: 'menu.openFileLocation',
		chords: ['Mod+Shift+R'],
		group: 'file',
		editorAction: true,
	},
	{
		id: 'app-exit',
		labelKey: 'menu.exit',
		chords: ['Mod+Q'],
		group: 'file',
		documentCommands: ['close-window'],
		// On macOS the document handler returns before this branch; the native
		// menu's CmdOrCtrl+Q is what answers, and #281 left exactly two entries.
		documentExempt: ['macos'],
		nativeMenuAccelerator: 'CmdOrCtrl+Q',
	},

	// ---------------------------------------------------------------- edit
	{ id: 'fmt-bold', labelKey: 'menu.bold', chords: ['Mod+B'], group: 'edit', editorAction: true },
	{ id: 'fmt-italic', labelKey: 'menu.italic', chords: ['Mod+I'], group: 'edit', editorAction: true },
	{ id: 'fmt-underline', labelKey: 'menu.underline', chords: ['Mod+U'], group: 'edit', editorAction: true },
	{ id: 'fmt-strikethrough', labelKey: 'menu.strikethrough', chords: ['Mod+Shift+X'], group: 'edit', editorAction: true },
	{ id: 'fmt-inline-code', labelKey: 'menu.inlineCode', chords: ['Mod+Shift+E'], group: 'edit', editorAction: true },
	{ id: 'fmt-code-block', labelKey: 'menu.codeBlock', chords: ['Mod+Shift+F'], group: 'edit', editorAction: true },
	{ id: 'fmt-quote', labelKey: 'menu.quote', chords: ['Mod+Shift+.'], group: 'edit', editorAction: true },
	{ id: 'fmt-heading-1', labelKey: 'menu.heading1', chords: ['Mod+1'], group: 'edit', editorAction: true },
	{ id: 'fmt-heading-2', labelKey: 'menu.heading2', chords: ['Mod+2'], group: 'edit', editorAction: true },
	{ id: 'fmt-heading-3', labelKey: 'menu.heading3', chords: ['Mod+3'], group: 'edit', editorAction: true },
	// GitHub's documented ordered/unordered list chords, identical on both
	// platforms ("Inserts Markdown formatting for an ordered list" / "…an
	// unordered list"). Numbered is 7 and bulleted is 8 because that is the way
	// round GitHub has them, not because either digit resembles a list.
	{ id: 'fmt-numbered-list', labelKey: 'menu.numberedList', chords: ['Mod+Shift+7'], group: 'edit', editorAction: true },
	{ id: 'fmt-bullet-list', labelKey: 'menu.bulletList', chords: ['Mod+Shift+8'], group: 'edit', editorAction: true },
	// 9 IS ARBITRARY, and deliberately not dressed up as a convention: GitHub
	// documents no task-list chord at all, and neither does Typora or Obsidian.
	// The two that do disagree and are both taken here — Bear's `Cmd+T` is New
	// File, iA Writer's `Opt+Cmd+L` is Monaco's `toggleFindInSelection` on macOS
	// — so the tie-break is adjacency: the third list button gets the digit next
	// to the two the first two took.
	{ id: 'fmt-checklist', labelKey: 'menu.checklist', chords: ['Mod+Shift+9'], group: 'edit', editorAction: true },
	{
		id: 'fmt-link',
		labelKey: 'menu.link',
		// The strongest competitor signal in the whole keymap: Typora, Bear, iA
		// Writer and GitHub all document Mod+K for Insert Link, and it is the only
		// command where four independent sources agree exactly. The link button had
		// no shortcut at all until now.
		//
		// Taking it means Mod+K stops being a chord PREFIX, which is what
		// `insert-table-simple` and `table-insert-column` used to hang off. What
		// that costs on Monaco's side is argued in monacoChordOwnership.spec.ts.
		chords: ['Mod+K'],
		group: 'edit',
		editorAction: true,
	},
	{
		id: 'insert-table-simple',
		labelKey: 'menu.insertTable',
		// Typora's and Bear's macOS chord for the same command, and a single stroke
		// rather than the `Mod+K T` sequence it replaces: the sequence was awkward
		// enough to press that it is what started this rework.
		chords: ['Mod+Alt+T'],
		group: 'edit',
		editorAction: true,
	},
	{
		id: 'table-insert-column',
		labelKey: 'menu.insertTableColumn',
		// C for Column, and it joins the Mod+Shift+7/8/9 family above: those are all
		// "insert a structure", which is what this is.
		//
		// NOT `Mod+Alt+C`, which was the obvious pick and is not available — on macOS
		// that is Monaco's `toggleFindCaseSensitive`. The reason it cannot be taken is
		// recorded in monacoChordOwnership.spec.ts, where the next person hunting for
		// a free chord will be.
		chords: ['Mod+Shift+C'],
		group: 'edit',
		editorAction: true,
	},
	{
		id: 'table-delete-column',
		labelKey: 'menu.deleteTableColumn',
		// NOT a letter, and that is the whole point. `Mod+Shift+D` is free, but D is
		// the physical neighbour of C — one slip would turn "insert a column" into
		// "delete a column". A destructive verb must not sit next to its constructive
		// counterpart; that is the defect the old `Mod+K Shift+R` had, one slip from
		// Monaco's delete-line. Backspace is across the keyboard and already means
		// "remove" everywhere, so it carries no mnemonic to learn.
		chords: ['Mod+Shift+Backspace'],
		group: 'edit',
		editorAction: true,
	},

	// ---------------------------------------------------------------- keys
	//
	// What a key does when the caret is somewhere it means something extra. One
	// row per KEY, not per behaviour: each of these is a single binding that
	// dispatches on what the caret is sitting on, and two rows advertising `Enter`
	// would be the panel claiming two shortcuts where the app has one.
	//
	// `Mod+Enter` carries a modifier and still belongs here rather than under Edit:
	// it is not a command being invoked by name, it is Monaco's own Insert Line
	// Below meaning one more thing inside a table.
	{
		id: 'key-enter',
		labelKey: 'keys.enter',
		chords: ['Enter'],
		group: 'keys',
		editorCommand: 'continueListOnEnter',
	},
	{
		id: 'key-tab',
		labelKey: 'keys.tab',
		chords: ['Tab'],
		group: 'keys',
		editorCommand: 'handleTabKey',
	},
	{
		id: 'key-shift-tab',
		labelKey: 'keys.shiftTab',
		chords: ['Shift+Tab'],
		group: 'keys',
		editorCommand: 'handleShiftTabKey',
	},
	{
		id: 'key-mod-enter',
		labelKey: 'keys.modEnter',
		chords: ['Mod+Enter'],
		group: 'keys',
		editorCommand: 'handleModEnterKey',
	},
	{
		id: 'key-mod-shift-enter',
		labelKey: 'keys.modShiftEnter',
		chords: ['Mod+Shift+Enter'],
		group: 'keys',
		editorCommand: 'handleModShiftEnterKey',
	},

	// ---------------------------------------------------------------- view
	{
		id: 'view-toggle-edit',
		labelKey: 'menu.editor',
		chords: ['Mod+E'],
		group: 'view',
		editorAction: true,
		documentCommands: ['toggle-edit-view'],
	},
	{
		id: 'view-toggle-live',
		labelKey: 'menu.toggleLiveMode',
		chords: ['Mod+L'],
		group: 'view',
		// Both halves, like Mod+E: Monaco's own Ctrl+L is `expandLineSelection`,
		// so the editor action is what stops the chord selecting a line, and the
		// document command is what makes it work in the preview, where there is
		// no Monaco to register anything on.
		editorAction: true,
		documentCommands: ['toggle-live-mode'],
	},
	{
		id: 'view-toggle-split',
		labelKey: 'menu.splitView',
		// Also bound to OEM_102, the extra backslash key on ISO keyboards. That is
		// the same physical gesture rather than a second chord a user could be
		// told about, so it is not displayed.
		chords: ['Mod+\\'],
		group: 'view',
		editorAction: true,
		documentCommands: ['toggle-split-view'],
	},
	{
		id: 'toggle-zen-mode',
		labelKey: 'menu.zenMode',
		// Z for zen, at the third address this command has had. Mod+Shift+Z was
		// redo's only binding on macOS; Mod+Shift+D was free but sat in the same
		// Mod+Shift row the six formatting commands live in, and moving it out
		// leaves that row to the formatting verbs. See the note at the keybinding
		// in Editor.svelte.
		chords: ['Mod+Alt+Z'],
		group: 'view',
		editorAction: true,
	},
	{
		id: 'toggle-tabs',
		labelKey: 'menu.toggleShowTabs',
		chords: ['Mod+Shift+B'],
		group: 'view',
		editorAction: true,
	},
	{
		id: 'app-find',
		labelKey: 'menu.find',
		chords: ['Mod+F'],
		group: 'view',
		documentCommands: ['find'],
	},
	{
		id: 'app-settings',
		labelKey: 'menu.settings',
		chords: ['Mod+,'],
		group: 'view',
		documentCommands: ['open-settings'],
		nativeMenuAccelerator: 'CmdOrCtrl+,',
	},
	{
		id: 'view-preview-width',
		labelKey: 'settings.previewMaxWidth',
		// One row, two chords: `[` narrows and `]` widens, the same pair the
		// settings stepper offers. Both run the same branch, which turns full-width
		// off before it adjusts the width — one shortcut, two directions, which is
		// why this is the one row whose commands are listed per chord.
		chords: ['Mod+Alt+[', 'Mod+Alt+]'],
		group: 'view',
		documentCommands: ['preview-width-narrower', 'preview-width-wider'],
	},
	{ id: 'view-zoom-in', labelKey: 'menu.zoomIn', chords: ['Mod+='], group: 'view', documentCommands: ['zoom-in'] },
	{ id: 'view-zoom-out', labelKey: 'menu.zoomOut', chords: ['Mod+-'], group: 'view', documentCommands: ['zoom-out'] },
	{ id: 'view-zoom-reset', labelKey: 'menu.resetZoom', chords: ['Mod+0'], group: 'view', documentCommands: ['zoom-reset'] },

	// -------------------------------------------------------------- window
	{
		id: 'tab-next',
		labelKey: 'menu.nextTab',
		// A literal Ctrl on every platform, macOS included: Cmd+Tab is the system
		// application switcher and never reaches the app.
		chords: ['Ctrl+Tab'],
		group: 'window',
		editorAction: true,
		documentCommands: ['next-tab'],
	},
	{
		id: 'tab-prev',
		labelKey: 'menu.previousTab',
		chords: ['Ctrl+Shift+Tab'],
		group: 'window',
		editorAction: true,
		documentCommands: ['previous-tab'],
	},
	{
		id: 'tab-undo-close',
		labelKey: 'menu.undoCloseTab',
		chords: ['Mod+Shift+T'],
		group: 'window',
		editorAction: true,
		documentCommands: ['undo-close-tab'],
	},
	{
		id: 'tab-move-window',
		labelKey: 'menu.moveToWindow',
		chords: ['Mod+Shift+M'],
		group: 'window',
		documentCommands: ['move-tab-to-next-window'],
	},
	{
		id: 'nav-back',
		labelKey: 'menu.back',
		chords: ['Alt+Left'],
		group: 'window',
		documentCommands: ['history-back'],
	},
	{
		id: 'nav-forward',
		labelKey: 'menu.forward',
		chords: ['Alt+Right'],
		group: 'window',
		documentCommands: ['history-forward'],
	},
	{
		id: 'app-command-palette',
		labelKey: 'menu.commandPalette',
		chords: ['Mod+P'],
		group: 'window',
		editorAction: true,
	},
];

/**
 * The modifier word each platform spells `Mod` with.
 *
 * Takes the raw `settings.osType` rather than `ShortcutPlatform`, because that
 * store field also carries `'unknown'` while the Tauri call that resolves it is
 * still in flight. Every caller that has an os type and needs a modifier goes
 * through here, so `=== 'macos' ? 'Cmd' : 'Ctrl'` is written once.
 */
export function modifierFor(platform: string): 'Cmd' | 'Ctrl' {
	return platform === 'macos' ? 'Cmd' : 'Ctrl';
}

/**
 * Should this click on a document link open a tab rather than navigate this one?
 *
 * THE CHORD IS THE PLATFORM'S. This is a gesture people bring with them from a
 * browser rather than learn here: ⌘-click on macOS, Ctrl-click everywhere else.
 * Reading both modifiers on both platforms — fine for a wheel-zoom, where
 * either answer is the same answer — is wrong in each direction here. On macOS
 * Ctrl-click IS the secondary click, so one gesture would open a context menu
 * and a tab; on Windows and Linux Meta is the Super key, which belongs to the
 * window manager. Asked through `modifierFor` so that "which modifier is this
 * platform's" keeps one answer, including for the `'unknown'` os type the store
 * carries until Tauri replies.
 *
 * THE CHORD MEANS "THE OTHER ONE", not "new tab". With `preferNewTab` off it
 * opens a tab; with it on it navigates in place. That is what the modifier does
 * in a browser and in Obsidian, and it is the difference between a preference
 * that changes the default and one that takes the other behaviour away — the
 * in-place path is the only thing that writes a tab's file history, which is
 * what Back and Forward read.
 */
export function opensInNewTab(
	platform: string,
	event: { readonly metaKey: boolean; readonly ctrlKey: boolean },
	preferNewTab: boolean,
): boolean {
	const chord = modifierFor(platform) === 'Cmd' ? event.metaKey : event.ctrlKey;
	return chord !== preferNewTab;
}

/**
 * The words each platform prints on the keys the two platforms name
 * differently, keyed by that platform's `Mod` word.
 *
 * `Cmd` IS macOS here, and nothing else produces these two values: they come
 * from `modifierFor` above, which is the one place the os type is read. So a
 * caller holding a modifier has already told this table which platform it is
 * rendering for, even though it never passes a platform.
 *
 * `Ctrl` and `Shift` are absent on purpose — a Mac keyboard prints `control`
 * and `shift`, so those words need no translation. `Alt` is here because it
 * needs one: Apple keyboards print `⌥ option` and the word "Alt" appears on no
 * modern Mac keyboard.
 */
const PLATFORM_KEY_WORDS = {
	Cmd: { Mod: 'Cmd', Alt: 'Opt' },
	Ctrl: { Mod: 'Ctrl', Alt: 'Alt' },
} as const;

/**
 * A chord template as a user should read it on `modifier`'s platform.
 *
 * The keys whose NAME differs across platforms are substituted — `Mod` and
 * `Alt`, per `PLATFORM_KEY_WORDS`. Everything else — `Ctrl`, `Shift`, `F5`,
 * the key itself — is already the literal the key carries on both.
 *
 * `Alt` used to be in that second list, and that was wrong: the panel advertised
 * `Alt+Left` to a Mac user, who has no key called Alt to press. Adding a modifier
 * that macOS renames without adding it here fails
 * `scripts/shortcutRegistry.test.ts`.
 */
export function formatChord(chord: string, modifier: 'Cmd' | 'Ctrl'): string {
	const words: Record<string, string> = PLATFORM_KEY_WORDS[modifier];
	return chord.replace(/\b(?:Mod|Alt)\b/g, (token) => words[token]);
}

const byId = new Map(SHORTCUTS.map((entry) => [entry.id, entry]));

/**
 * The single chord a one-line consumer shows for `id`, or `undefined` when the
 * command has no shortcut. This is what the app menu and the toolbar tooltip
 * call, so neither of them holds a literal any more.
 */
export function shortcutLabel(id: string, modifier: 'Cmd' | 'Ctrl'): string | undefined {
	const entry = byId.get(id);
	return entry ? formatChord(entry.chords[0], modifier) : undefined;
}

type ShortcutSection = {
	group: ShortcutGroup;
	labelKey: string;
	entries: ReadonlyArray<{ id: string; labelKey: string; chords: string[] }>;
};

/** The whole registry, grouped and rendered for `platform` — what the panel draws. */
export function shortcutSections(platform: ShortcutPlatform): ShortcutSection[] {
	const modifier = modifierFor(platform);
	return SHORTCUT_GROUPS.map(({ group, labelKey }) => ({
		group,
		labelKey,
		entries: SHORTCUTS.filter((entry) => entry.group === group).map((entry) => ({
			id: entry.id,
			labelKey: entry.labelKey,
			chords: entry.chords.map((chord) => formatChord(chord, modifier)),
		})),
	}));
}
