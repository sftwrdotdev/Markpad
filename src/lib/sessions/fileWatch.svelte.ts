import { commands } from '../bindings.js';

/**
 * Keeps this window's file watcher on the active tab's file, and gives it up
 * when that has no path. Call it while a component initialises; the effect is
 * the component's. This is the one place that asks for a watch: a load
 * re-issuing `watch_file` made the watcher follow whichever document loaded
 * last rather than the active one (#296).
 *
 * Watched whether or not Auto-Reload is on: an edit made elsewhere under
 * unsaved changes is reported when it happens, not at the next save.
 * Auto-Reload only decides whether a clean tab reloads.
 *
 * The watcher sees nothing while a tab is in the background, so a tab shown
 * again with the file it was last shown with gets `onShownAgain` once the
 * watch on it is armed (#1101). Armed first, so a change landing between the
 * check's read and the arming is still reported by the watcher. A tab shown
 * for the first time, or a tab whose own path just changed, is in the middle
 * of a load and is not asked.
 */
export function followActiveFile(
	active: () => { id: string | null | undefined; path: string },
	onShownAgain: (tabId: string) => unknown = () => {},
) {
	const lastShownWith = new Map<string, string>();
	let shownId: string | null | undefined;
	$effect(() => {
		const { id, path } = active();
		const shownAgain = !!id && !!path && id !== shownId && lastShownWith.get(id) === path;
		shownId = id;
		if (id) lastShownWith.set(id, path);
		if (path) {
			const armed = commands.watchFile(path).catch(console.error);
			if (shownAgain) void armed.then(() => onShownAgain(id));
		} else {
			commands.unwatchFile().catch(console.error);
		}
	});
}
