import { commands } from '../bindings.js';

type MetaSource = {
	readonly windowTag: { name: string; color: string } | null;
	readonly activeTab: { title: string } | undefined;
	readonly tabs: readonly unknown[];
};

/**
 * Keeps the backend's window registry up to date with this window's tag,
 * active title and tab count. Call during component init.
 *
 * A window opened for a pinned group is entered in the registry under the
 * group's name when it is created. Reporting before it has adopted the group
 * would clear that name and let a second click open the group again, so such a
 * window starts not ready and reports from `markReady` on.
 */
export function reportWindowMeta(tabManager: MetaSource, readyAtStart: boolean) {
	let ready = $state(readyAtStart);
	$effect(() => {
		if (!ready) return;
		commands.setWindowMeta(tabManager.windowTag?.name ?? null, tabManager.windowTag?.color ?? null, tabManager.activeTab?.title ?? '', tabManager.tabs.length).catch(() => {});
	});
	return { markReady: () => void (ready = true) };
}
