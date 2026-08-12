import type { OSType } from '../stores/settings.svelte.js';

/*
 * WHICH COMMAND a document-level keystroke means — the whole of it, and nothing
 * else.
 *
 * This was the body of `handleKeyDown` in MarkdownViewer.svelte, where it could
 * not be imported and therefore could not be run by a test. What tests did
 * instead was read it: fourteen assertions across four files matched the
 * component's source text for `if (mod && key === 'e')` and its neighbours, and
 * #647 turned five of them red by renaming a local. A source-shape assertion
 * cannot tell a rename from a regression, because it never asks what the code
 * DOES.
 *
 * The same argument as #644's fold drivers, and the same shape of answer: the
 * logic moves out, the wiring stays in. What moves is the part that is a
 * function of the keystroke — the branch structure, every modifier guard, the
 * per-platform scoping. What stays is the part that is genuinely the
 * component's: which of its own functions each command runs.
 *
 * WHY A COMMAND NAME RATHER THAN A HOST OBJECT. The obvious extraction hands
 * the dispatcher the eleven callbacks it used to close over (`closeFile`,
 * `saveContent`, `handleNewFile`, …) as a host argument, the way `FoldHost`
 * carries the fold drivers' three. Eleven is not three: a host that large is
 * the component with its name changed, every caller has to build one, and the
 * test that builds one is back to describing the component rather than running
 * it. So the seam is cut one step earlier, at the question that is actually
 * hard — WHICH command — and the answer is a string the caller switches on.
 * The component's switch is the residue, and it is checked where it lives.
 *
 * WHY IT TAKES NO STORES. Nothing here imports `settings` or `tabManager`;
 * every fact about the app arrives in `KeyContext` as a plain value. That is
 * partly #644's constraint (a store import drags its runes behind every
 * importer) and mostly this one: with no free identifiers there is nothing for
 * a test harness to stub, which is the failure #649 hit — a helper the harness
 * did not know about resolved to a recording stub whose result compared false
 * to everything, so a Windows-only branch reported as firing on all three
 * platforms and the measured chord count went from 51 to 610. A function whose
 * every input is an argument cannot be run against a more agreeable copy of the
 * app, because there is no copy to make.
 */

/**
 * One command the document-level keyboard reaches, named rather than called.
 *
 * The direction is part of the name — `next-tab` and `previous-tab` rather than
 * one `cycle-tab` — because the registry rows that advertise these chords used
 * to name `tabManager.cycleTab` for both and could not tell them apart.
 */
export type ViewerCommand =
	| 'preview-width-narrower'
	| 'preview-width-wider'
	| 'reload-from-disk'
	| 'move-tab-to-next-window'
	| 'close-file'
	| 'new-file'
	| 'open-file'
	| 'close-window'
	| 'toggle-split-view'
	| 'toggle-edit-view'
	| 'save-as'
	| 'save'
	| 'undo-close-tab'
	| 'next-tab'
	| 'previous-tab'
	| 'history-back'
	| 'history-forward'
	| 'zoom-in'
	| 'zoom-out'
	| 'zoom-reset'
	| 'open-settings'
	| 'find';

/**
 * The keystroke, as much of it as any branch reads.
 *
 * A structural subset of `KeyboardEvent` rather than the event itself, so a
 * test can hand over an object literal without a DOM. `target` is here because
 * the preview-width branch walks up from it; every other branch reads only
 * `key`, `code` and the four modifiers.
 */
export type KeyStroke = {
	readonly key: string;
	readonly code: string;
	readonly ctrlKey: boolean;
	readonly metaKey: boolean;
	readonly shiftKey: boolean;
	readonly altKey: boolean;
	readonly target?: EventTarget | null;
};

/**
 * Everything about the app a branch below is allowed to know.
 *
 * Six plain values, all of them read-only. Anything a command needs in order to
 * RUN — the active tab, the settings store, the window — is deliberately absent:
 * this decides which command, and the caller runs it.
 */
export type KeyContext = {
	/** The app is still loading its first document; nothing is dispatched. */
	readonly mode: 'loading' | 'app';
	readonly osType: OSType;
	/** The active tab shows both panes, which keeps the preview reachable. */
	readonly isSplit: boolean;
	/** Settings, the modal, the prompt or the home screen is in front. */
	readonly overlayOpen: boolean;
	readonly isEditing: boolean;
	/** The caret is inside the Monaco pane, so Monaco's own Find should answer. */
	readonly editorHasFocus: boolean;
};

/**
 * Whether the preview-width chords apply, given what the keystroke landed on.
 *
 * Exported because it is the one branch condition that reads the DOM, and the
 * only one a test cannot state as a boolean: `Mod+Alt+[` inside a text field is
 * the field's business.
 */
export function canUsePreviewWidthShortcut(target: EventTarget | null | undefined, context: KeyContext): boolean {
	if (context.overlayOpen || (context.isEditing && !context.isSplit)) return false;
	// `typeof target.closest === 'function'` rather than `target instanceof
	// Element`, which is what this said while it lived in the component. The
	// module is imported by `node --test` files that have no DOM at all, where
	// the bare global is a ReferenceError rather than a false — and `instanceof`
	// against a DOM constructor is the wrong test anyway for a node from another
	// realm. The method being called is the thing worth asking about.
	const element = target as Element | null | undefined;
	if (typeof element?.closest !== 'function') return true;
	return !element.closest('input, textarea, select, [contenteditable="true"], [role="textbox"]');
}

/**
 * The command this keystroke means, or null for one the app does not bind.
 *
 * Null is also the answer for a chord that is *deliberately* left to something
 * else — macOS's ⌘Q, which the native menu owns, and Mod+F while the editor has
 * focus, which is Monaco's. The caller preventDefaults exactly when this
 * returns a command, which is what the handler did branch by branch before.
 */
export function viewerCommandFor(e: KeyStroke, context: KeyContext): ViewerCommand | null {
	if (context.mode !== 'app') return null;

	const cmdOrCtrl = e.ctrlKey || e.metaKey;
	const key = e.key.toLowerCase();
	const code = e.code;

	/*
	 * The three modifier shapes almost every branch below wants, named once.
	 *
	 * A chord means the modifiers it names AND the absence of the ones it does
	 * not. Half the branches here used to say only `cmdOrCtrl && key === …`,
	 * which is not `Mod+X` — it is `Mod+X` plus its whole Shift/Alt cross
	 * product. `Mod+W` was the expensive case: Shift+Cmd+W and Alt+Cmd+W are
	 * what a user reaches for when they mean "close the window" or "close
	 * everything", and both silently closed one document instead. `Mod+Q`,
	 * `Mod+E`, `Mod+S`, `Mod+,` and the zoom chords all had the same hole, and
	 * on macOS Shift+Cmd+Q — Log Out — reached the window-close branch.
	 *
	 * The guard is here rather than repeated in fourteen branches so that a
	 * branch added later INHERITS it by reaching for `mod`, instead of having
	 * to remember three negations. `shortcutRegistry.test.ts` closes the other
	 * half: any chord this function answers that the registry does not advertise
	 * fails there, so a new branch cannot quietly grow a cross product again.
	 *
	 * Three branches are deliberately not written in these terms, each with its
	 * reason at the branch: tab cycling (Shift picks the direction), zoom in
	 * (`+` is the shifted `=`), and the Alt-only navigation chords.
	 */
	const mod = cmdOrCtrl && !e.shiftKey && !e.altKey;
	const modShift = cmdOrCtrl && e.shiftKey && !e.altKey;
	const modAlt = cmdOrCtrl && !e.shiftKey && e.altKey;

	// The macOS application menu owns ⌘Q. Document shortcuts remain in the
	// in-window controls, so they continue to act on the current webview.
	if (context.osType === 'macos' && mod && key === 'q') return null; // → menu-app-quit

	if (modAlt && (code === 'BracketLeft' || code === 'BracketRight')) {
		if (!canUsePreviewWidthShortcut(e.target, context)) return null;
		return code === 'BracketLeft' ? 'preview-width-narrower' : 'preview-width-wider';
	}

	if (!cmdOrCtrl && !e.shiftKey && !e.altKey && code === 'F5') return 'reload-from-disk';
	if (modShift && key === 'm') return 'move-tab-to-next-window';
	// Nothing catches the Shift and Alt variants on the way past: they are not
	// another command in disguise, they are a user asking the WINDOW manager
	// for something. Leaving them unhandled — and unprevented — is what lets
	// the OS answer them, which is strictly better than answering with the one
	// irreversible thing the app can do.
	if (mod && key === 'w') return 'close-file';
	// Windows only, which is the scope this binding was written to and then
	// exceeded. `docs/requirements/157-ctrl-f4-close-tab.md`, added by the
	// same commit as the branch itself (4670743, "add Ctrl+F4 shortcut to
	// close active tab on Windows"), puts "macOS / Linux (dort ist Ctrl+F4
	// kein Standard)" under "Out of scope"; the handler bound all three
	// anyway. So this is not a new product decision, it is the documented one
	// finally being implemented. The doc went away with the rest of docs/ in
	// d69c181, which is how the intent stopped being checkable —
	// `shortcutRegistry.test.ts` now holds it instead.
	//
	// The convention argument is why the requirement says that: Ctrl+F4
	// closes a document window on Windows, still live in Office and the IDEs.
	// macOS has no equivalent — Cmd+F4 means nothing, and with "Use F1, F2,
	// etc. as standard function keys" off, which is the default, F4 runs a
	// system function and the app never receives the event at all
	// (hand-tested on a Mac: it did nothing). A Mac was therefore offered a
	// THIRD route to an irreversible action that was at once non-conventional
	// and nearly unpressable.
	//
	// Not a rule about odd-looking chords: `Cmd+Shift+=` stays on every
	// platform. That one is not a platform convention, it is how "Cmd plus"
	// is typed — `+` is the shifted `=` on every layout — so Mac users press
	// it as much as anyone. The question is "does anyone on this platform
	// actually press this?", not "does it carry a Shift?".
	//
	// A bare `osType` comparison next to #646's `platformOf` is deliberate,
	// not an oversight. `platformOf` answers `'macos' | 'windows'` and folds
	// Linux INTO `'windows'` — correct for the two questions it was built for
	// (which modifier to print, which window chrome to draw) and unable to
	// express this one, which needs all three apart. And the reason to avoid a
	// bare comparison does not apply to this spelling: `osType` is `'unknown'`
	// until the Rust command answers, and `=== 'windows'` resolves that window
	// to DO NOT FIRE. It fails closed, which is the only acceptable direction
	// for a branch that throws a document away.
	if (context.osType === 'windows' && mod && code === 'F4') return 'close-file';
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
	if (mod && (key === 't' || key === 'n')) return 'new-file';
	if (mod && key === 'o') return 'open-file';
	if (mod && key === 'q') return 'close-window';
	if (mod && (code === 'Backslash' || code === 'IntlBackslash')) return 'toggle-split-view';
	if (mod && key === 'e') return 'toggle-edit-view';
	// Save As. The app menu advertised this chord for as long as the menu has
	// existed, but nothing ever bound it: the branch below matched on
	// `cmdOrCtrl && key === 's'` with no Shift guard, so the advertised
	// keystroke fell through to a plain Save and silently overwrote the file
	// the user was asking to write somewhere else. `saveContentAs` had no
	// keyboard path at all — its only caller was the menu button.
	if (modShift && key === 's') return 'save-as';
	if (mod && key === 's') return 'save';
	if (modShift && key === 't') return 'undo-close-tab';
	// Not `mod`/`modShift`: Shift is the ARGUMENT here, not part of the chord's
	// identity — it picks the direction. Alt still has to be up.
	if (cmdOrCtrl && !e.altKey && code === 'Tab') return e.shiftKey ? 'previous-tab' : 'next-tab';
	if (mod && code === 'PageUp') return 'previous-tab';
	if (mod && code === 'PageDown') return 'next-tab';
	// Alt-based chords, so they say what they need by hand: `mod` would demand
	// Alt be up, which is the opposite of what these two bind.
	if (e.metaKey && !e.ctrlKey && e.altKey && !e.shiftKey && code === 'ArrowLeft') return 'previous-tab';
	if (e.metaKey && !e.ctrlKey && e.altKey && !e.shiftKey && code === 'ArrowRight') return 'next-tab';
	if (e.altKey && !e.shiftKey && !cmdOrCtrl && code === 'ArrowLeft') return 'history-back';
	if (e.altKey && !e.shiftKey && !cmdOrCtrl && code === 'ArrowRight') return 'history-forward';
	// The one chord that cannot demand Shift be up. `+` IS the shifted `=` on
	// the layouts that have both, so `mod` would delete the `+` spelling
	// outright and leave Cmd+Shift+= — how a lot of people zoom in — dead. The
	// guard is per-spelling instead: bare `=` wants no Shift, `+` brings its
	// own. (The keymap harness only ever fires unshifted characters, so it sees
	// the `=` half of this and never the `+` half; `viewerKeymap.test.ts` fires
	// the `+` half directly.)
	if (cmdOrCtrl && !e.altKey && (key === '+' || (key === '=' && !e.shiftKey))) return 'zoom-in';
	if (mod && key === '-') return 'zoom-out';
	if (mod && key === '0') return 'zoom-reset';
	if (mod && key === ',') return 'open-settings';
	// Ctrl/Cmd+F: route to either Monaco's built-in find or the preview
	// FindBar depending on focus and which panes are visible. The caller only
	// preventDefaults when it takes the action itself — otherwise Monaco's own
	// keybinding fires — which is why focus is a condition here rather than a
	// branch inside the command.
	if (mod && key === 'f' && !context.editorHasFocus) return 'find';

	return null;
}
