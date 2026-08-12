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
 * Which menu the command would live under. The four labels are the existing
 * menu-bar categories, so grouping the panel costs no new translations.
 */
type ShortcutGroup = 'file' | 'edit' | 'view' | 'window';

/** Display order of the groups, and the i18n key that titles each one. */
export const SHORTCUT_GROUPS: ReadonlyArray<{ group: ShortcutGroup; labelKey: string }> = [
	{ group: 'file', labelKey: 'menu.file' },
	{ group: 'edit', labelKey: 'menu.edit' },
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
	 * The chords, most-advertised first. `Mod` renders as `Cmd` on macOS and
	 * `Ctrl` elsewhere; a literal `Ctrl` stays `Ctrl` on every platform, which is
	 * what tab cycling actually binds.
	 *
	 * Consumers with room for one chord (the app menu, the toolbar tooltip) show
	 * `chords[0]`; the panel shows all of them.
	 */
	readonly chords: readonly string[];
	readonly group: ShortcutGroup;
	/** `Editor.svelte` registers this chord on a Monaco action whose id is `id`. */
	readonly editorAction?: true;
	/**
	 * The app function `MarkdownViewer.svelte`'s document-level handler runs for
	 * this chord when the editor does not have focus. Recorded as a call path, so
	 * `tabManager.cycleTab` matches `tabManager.cycleTab:next`.
	 */
	readonly documentCall?: string;
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
		documentCall: 'handleNewFile',
	},
	{
		id: 'file-open',
		labelKey: 'menu.openFile',
		chords: ['Mod+O'],
		group: 'file',
		editorAction: true,
		documentCall: 'selectFile',
	},
	{
		id: 'file-save',
		labelKey: 'menu.save',
		chords: ['Mod+S'],
		group: 'file',
		editorAction: true,
		documentCall: 'saveContent',
	},
	{
		id: 'file-save-as',
		labelKey: 'menu.saveAs',
		// The chord the app menu has always printed. It is bound for the first
		// time here: until now the save branch matched `cmdOrCtrl && key === 's'`
		// with no Shift guard, so the advertised keystroke ran a plain Save.
		chords: ['Mod+Shift+S'],
		group: 'file',
		documentCall: 'saveContentAs',
	},
	{
		id: 'file-reload',
		labelKey: 'menu.reloadFromDisk',
		chords: ['F5'],
		group: 'file',
		documentCall: 'reloadFromDisk',
	},
	{
		id: 'file-close',
		labelKey: 'menu.closeFile',
		chords: ['Mod+W'],
		group: 'file',
		editorAction: true,
		documentCall: 'closeFile',
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
		documentCall: 'getCurrentWindow',
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
	{
		id: 'insert-table-simple',
		labelKey: 'menu.insertTable',
		// A chord SEQUENCE, not a combination: Mod+K, release, then T.
		chords: ['Mod+K T'],
		group: 'edit',
		editorAction: true,
	},
	// The rest of the table verbs share Insert Table's `Mod+K` prefix, so they
	// open no new chord namespace. Adding a ROW is not among them: Tab at the end
	// of a table already does that, which is what every other editor's users
	// expect.
	{ id: 'table-insert-row', labelKey: 'menu.insertTableRow', chords: ['Mod+K R'], group: 'edit', editorAction: true },
	{ id: 'table-delete-row', labelKey: 'menu.deleteTableRow', chords: ['Mod+K Shift+R'], group: 'edit', editorAction: true },
	{ id: 'table-insert-column', labelKey: 'menu.insertTableColumn', chords: ['Mod+K C'], group: 'edit', editorAction: true },
	{ id: 'table-delete-column', labelKey: 'menu.deleteTableColumn', chords: ['Mod+K Shift+C'], group: 'edit', editorAction: true },

	// ---------------------------------------------------------------- view
	{
		id: 'view-toggle-edit',
		labelKey: 'menu.editor',
		chords: ['Mod+E'],
		group: 'view',
		editorAction: true,
		documentCall: 'toggleEdit',
	},
	{
		id: 'view-toggle-live',
		labelKey: 'menu.toggleLiveMode',
		chords: ['Mod+L'],
		group: 'view',
		editorAction: true,
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
		documentCall: 'toggleSplitView',
	},
	{
		id: 'toggle-zen-mode',
		labelKey: 'menu.zenMode',
		chords: ['Mod+Shift+Z'],
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
		documentCall: 'triggerFindAction',
	},
	{
		id: 'app-settings',
		labelKey: 'menu.settings',
		chords: ['Mod+,'],
		group: 'view',
		// The branch opens Settings by assigning, not by calling; the harness
		// records the write.
		documentCall: 'showSettings=true',
		nativeMenuAccelerator: 'CmdOrCtrl+,',
	},
	{
		id: 'view-preview-width',
		labelKey: 'settings.previewMaxWidth',
		// One row, two chords: `[` narrows and `]` widens, the same pair the
		// settings stepper offers. Both run the same branch, which turns full-width
		// off before it adjusts the width; the width write is the one this row
		// names, and the full-width write is accounted for in
		// DOCUMENT_NOT_ADVERTISED as part of this same shortcut.
		chords: ['Mod+Alt+[', 'Mod+Alt+]'],
		group: 'view',
		documentCall: 'settings.previewMaxWidth=',
	},
	{ id: 'view-zoom-in', labelKey: 'menu.zoomIn', chords: ['Mod+='], group: 'view', documentCall: 'settings.zoomIn' },
	{ id: 'view-zoom-out', labelKey: 'menu.zoomOut', chords: ['Mod+-'], group: 'view', documentCall: 'settings.zoomOut' },
	{ id: 'view-zoom-reset', labelKey: 'menu.resetZoom', chords: ['Mod+0'], group: 'view', documentCall: 'settings.resetZoom' },

	// -------------------------------------------------------------- window
	{
		id: 'tab-next',
		labelKey: 'menu.nextTab',
		// A literal Ctrl on every platform, macOS included: Cmd+Tab is the system
		// application switcher and never reaches the app.
		chords: ['Ctrl+Tab'],
		group: 'window',
		editorAction: true,
		documentCall: 'tabManager.cycleTab',
	},
	{
		id: 'tab-prev',
		labelKey: 'menu.previousTab',
		chords: ['Ctrl+Shift+Tab'],
		group: 'window',
		editorAction: true,
		documentCall: 'tabManager.cycleTab',
	},
	{
		id: 'tab-undo-close',
		labelKey: 'menu.undoCloseTab',
		chords: ['Mod+Shift+T'],
		group: 'window',
		editorAction: true,
		documentCall: 'handleUndoCloseTab',
	},
	{
		id: 'tab-move-window',
		labelKey: 'menu.moveToWindow',
		chords: ['Mod+Shift+M'],
		group: 'window',
		documentCall: 'carryActiveTabToNextWindow',
	},
	{
		id: 'nav-back',
		labelKey: 'menu.back',
		chords: ['Alt+Left'],
		group: 'window',
		documentCall: 'navigateFileHistory',
	},
	{
		id: 'nav-forward',
		labelKey: 'menu.forward',
		chords: ['Alt+Right'],
		group: 'window',
		documentCall: 'navigateFileHistory',
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
 * A chord template as a user should read it on `platform`.
 *
 * Only `Mod` is substituted. Everything else — `Ctrl`, `Alt`, `F5`, `Shift` —
 * is already the literal the key carries.
 */
export function formatChord(chord: string, modifier: 'Cmd' | 'Ctrl'): string {
	return chord.replace(/\bMod\b/g, modifier);
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
