import type { Appearance } from '../bindings.js';
import { untrack } from 'svelte';
import { clearVscodeTheme, loadVscodeTheme } from './theme.js';

export interface ThemeEffectDeps {
	/** What Rust paints the next window's background from: the appearance, never a theme name. */
	saveStartupAppearance(appearance: Appearance): void;
	readVscodeTheme(name: string): Promise<string>;
	/** Re-draws the diagrams. Run untracked: see below. */
	recolourDiagrams(): void;
	onLoadFailed(error: unknown): void;
}

/**
 * Applies the theme setting to the document whenever it changes. Call during
 * component init. Persistence and cross-window sync belong to the settings
 * store; this is only the part that cannot: applying the theme to the document.
 */
export function followTheme(getTheme: () => string, deps: ThemeEffectDeps): void {
	$effect(() => {
		const theme = getTheme();

		// Mermaid bakes its colours into the SVG it produces, so the diagrams have
		// to be drawn again; `renderRichContent` finds the ones drawn for another
		// theme. No `roots`, because the whole article is what changed appearance
		// — including the hosts of tabs that are not on screen, which the reader
		// switches back to without anything else re-rendering them.
		//
		// Called from each branch rather than once at the end, because the
		// `vscode:` branch does not know its own appearance until
		// `parseAndApplyVscodeTheme` has published `dataset.themeType`, and that
		// is what `currentMermaidTheme` reads. Calling here would have re-drawn
		// every diagram in the theme being replaced.
		//
		// `untrack` for the reason #740 established: `renderRichContent` reads
		// reactive state before its first `await`, so a tracked call makes this
		// effect re-run on unrelated changes — re-enriching every open tab's
		// host on top of the pass the patch effect owns.
		const recolourDiagrams = () => untrack(() => deps.recolourDiagrams());

		if (theme === 'system' || theme === 'light' || theme === 'dark') {
			if (theme === 'system') {
				delete document.documentElement.dataset.theme;
				delete document.documentElement.dataset.themeType;
			} else {
				document.documentElement.dataset.theme = theme;
				document.documentElement.dataset.themeType = theme;
			}
			clearVscodeTheme();
			deps.saveStartupAppearance(theme);
			recolourDiagrams();
			// No Monaco write here. It used to set `vs`/`vs-dark` through the
			// `monaco` global, and because a child's effects run before its
			// parent's it landed AFTER `Editor`'s own — stripping the editor of
			// `app-theme-*` on every theme change. `editorTheme.ts`'s
			// `monacoThemeName` is the one answer now, and `Editor` is the only
			// pane that asks it; with no editor mounted there is nothing to
			// paint, and a later mount reads the theme from the same seam.
		} else {
			const name = theme.replace('vscode:', '');
			loadVscodeTheme(name, deps.readVscodeTheme).then((applied) => {
				// A later choice replaced this one while it loaded; that choice
				// owns the window now.
				if (!applied) return;
				// `parseAndApplyVscodeTheme` decides dark vs. light from the theme's
				// own `type` field and publishes it here.
				deps.saveStartupAppearance(document.documentElement.dataset.themeType === 'dark' ? 'dark' : 'light');
				recolourDiagrams();
			}).catch(deps.onLoadFailed);
		}
	});
}
