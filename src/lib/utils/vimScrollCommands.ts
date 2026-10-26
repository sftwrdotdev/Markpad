/*
 * Vim's scroll-cursor family — `zz`, `zt`, `zb`, `z.`, `z-`, `z<CR>` — does
 * nothing in monaco-vim 0.4.4 (#104, #393). Two separate defects, both here.
 *
 * 1. THE SCROLL NEVER HAPPENS. All six keys route to one action:
 *
 *        scrollToCursor: function (cm, actionArgs) {
 *          var charCoords = cm.charCoords(new Pos(lineNum, 0), "local");
 *          var y = charCoords.top;
 *          var lineHeight = charCoords.bottom - y;
 *          switch (actionArgs.position) { … }   // y becomes a pixel offset
 *          cm.moveCurrentLineTo(y);
 *        }
 *
 *    while the adapter it hands that number to is:
 *
 *        moveCurrentLineTo(viewPosition) {
 *          switch (viewPosition) {
 *            case "top":    editor.revealRangeAtTop(range); return;
 *            case "center": editor.revealRangeInCenter(range); return;
 *            case "bottom": editor._revealRange?.(range, Bottom); return;
 *          }
 *        }
 *
 *    No default branch, so a number matches nothing and the call silently
 *    returns. The arithmetic is doubly meaningless in this adapter: its
 *    `charCoords` returns `{ top: pos.line, left: pos.ch }` — line numbers, not
 *    pixels, and with no `bottom` key at all, so `lineHeight` is `NaN` and `y`
 *    is `NaN` for `center` and `bottom`.
 *
 *    The fix hands `moveCurrentLineTo` one of the three strings its switch is
 *    written for and drops the pixel arithmetic, which nothing in this adapter
 *    could have used.
 *
 * 2. `zb` AND `z-` ARE SWAPPED. Vim (`:help scroll-cursor`) pairs each position
 *    with a letter form that keeps the cursor column and a punctuation form that
 *    moves it to the first non-blank:
 *
 *        zt / z<CR>   top       zz / z.   center      zb / z-   bottom
 *              ^ first non-blank      ^                    ^
 *
 *    0.4.4 gets top and center right and has bottom backwards: its `z-` keeps
 *    the column and its `zb` carries `motion: "moveToFirstNonWhiteSpaceCharacter"`.
 *    Nobody could see it while defect 1 made the whole family dead — fixing the
 *    scroll is what would have made a wrong cursor visible, so both go together.
 *
 * WHY NOT AN UPGRADE: 0.4.4 is the latest release (2025-11-22) and upstream
 * master has only dependency bumps since; `moveCurrentLineTo` is unchanged
 * there. WHY NOT A PATCH: `Vim.defineAction` and `Vim.mapCommand` are the
 * package's own extension points, so nothing here touches a dependency's file.
 *
 * DEGRADING: every step is guarded and the whole thing is a no-op if the API is
 * not what this file expects, so an upgrade that renames or removes it costs a
 * silent return, not a crash on entering Vim mode.
 * `scripts/editor.vim.test.ts` drives the six keys through the real
 * package and fails when upstream's behaviour changes underneath.
 */

/** The three view positions the adapter's `moveCurrentLineTo` switch accepts. */
type ViewPosition = 'top' | 'center' | 'bottom';

/** The part of monaco-vim's `cm` an action for this family reaches. */
type ScrollTarget = {
	moveCurrentLineTo?: (viewPosition: ViewPosition) => void;
};

/**
 * The part of `VimMode.Vim` used here.
 *
 * Written out rather than imported: monaco-vim's own `.d.ts` declares neither
 * the `Vim` static nor this API, so there is nothing to import, and the
 * structural check in `installVimScrollCommands` is what stands in for the
 * types upstream does not ship.
 */
type VimApi = {
	defineAction?: (name: string, fn: (cm: ScrollTarget, actionArgs: { position?: unknown }) => void) => void;
	mapCommand?: (keys: string, type: string, name: string, args: unknown, extra: unknown) => void;
};

/**
 * The Vim APIs already patched.
 *
 * `defineAction` overwrites an entry and is safe to repeat, but `mapCommand`
 * *unshifts* onto a module-global keymap — running it once per Vim-mode toggle
 * would grow that array for the life of the window. Keyed on the API object
 * rather than a plain boolean because monaco-vim is a singleton in the app but
 * not in a test, where each case imports a fresh copy.
 */
const patched = new WeakSet<object>();

/**
 * Give the Vim z-family the scroll it never performs, and put `zb`/`z-` the way
 * Vim documents them.
 *
 * Takes monaco-vim's `VimMode` export. Returns whether the commands are in
 * place — `false` means the API was not the shape this file expects and nothing
 * was changed.
 */
export function installVimScrollCommands(vimMode: unknown): boolean {
	const api: VimApi | undefined = (vimMode as { Vim?: VimApi } | null | undefined)?.Vim;
	if (!api || typeof api !== 'object') return false;
	if (patched.has(api)) return true;
	if (typeof api.defineAction !== 'function') return false;

	api.defineAction('scrollToCursor', (cm, actionArgs) => {
		const position = actionArgs?.position;
		// `center` is the default because it is what the keymap asks for when a
		// mapping omits the argument, and because a scroll to a defensible place
		// beats the silent nothing this replaces.
		const viewPosition: ViewPosition = position === 'top' || position === 'bottom' ? position : 'center';
		cm?.moveCurrentLineTo?.(viewPosition);
	});

	// A `mapCommand` entry is unshifted onto the keymap and the dispatcher takes
	// the first full match, so these two win over the swapped defaults. They are
	// user mappings as far as monaco-vim is concerned, which means `:mapclear`
	// drops them and hands `zb`/`z-` back to upstream — a scroll to the right
	// place with the wrong cursor column, not a dead key.
	if (typeof api.mapCommand === 'function') {
		api.mapCommand('zb', 'action', 'scrollToCursor', { position: 'bottom' }, {});
		api.mapCommand('z-', 'action', 'scrollToCursor', { position: 'bottom' }, {
			motion: 'moveToFirstNonWhiteSpaceCharacter',
		});
	}

	patched.add(api);
	return true;
}
