import type { Tab, tabManager as TabManager } from '../stores/tabs.svelte.js';

export type ColdEnrichmentRestoreOptions = {
	tabManager: typeof TabManager;
	tick: () => Promise<void>;
	/** The article on screen, read when the restore runs. */
	readonly markdownBody: HTMLElement | null | undefined;
	/** `restorePreviewReadingPosition` with the viewer's measurements. */
	restore: (body: HTMLElement, tab: Tab) => void;
};

/**
 * The second restore a cold start needs: the rich-content libraries land after
 * the document is already in the preview and after its position was restored
 * against it.
 */
export function createColdEnrichmentRestore(o: ColdEnrichmentRestoreOptions) {
	const { tabManager, tick } = o;

	/**
	 * The hosts whose document has been through `renderRichContent` at least
	 * once. A `WeakMap`/`WeakSet` keyed on the container for the same reason
	 * `states` in `previewPatch.ts` is: a host that Svelte destroys with its
	 * tab takes its entry with it, so this cannot drift from the set of live
	 * tabs the way a hand-kept registry can.
	 */
	const enrichedHosts = new WeakSet<HTMLElement>();

	/**
	 * Put the reader back where they were, once, after a cold start's enrichment
	 * has changed the layout underneath them.
	 *
	 * Through `restorePreviewReadingPosition` — the same cascade the restore
	 * effect runs, in the same order — because two sites consulting a tab's
	 * three position fields in different orders are two answers for one tab.
	 * That effect cannot do this itself: giving it a dependency on the render
	 * would drag the preview back to the anchor on every debounced re-render
	 * while the reader is typing in split view.
	 *
	 * Only for the tab that is still on screen. The enrichment is awaited, a
	 * switch can happen inside it, and restoring another tab's position into the
	 * article would move the document the reader is actually looking at.
	 */
	async function restoreAfterColdEnrichment(enrichment: Promise<void>, tabId: string | null) {
		await enrichment;
		await tick();
		const body = o.markdownBody;
		if (!body || !tabId || tabManager.activeTabId !== tabId) return;
		const tab = tabManager.tabs.find((t) => t.id === tabId);
		if (tab) o.restore(body, tab);
	}

	/**
	 * Called by the patch effect after it hands `insertedBlocks` new blocks of
	 * `host` to `renderRichContent`. A host's first enrichment is the cold
	 * start: it waits for whichever libraries the document needs. A tab being
	 * re-activated patches to nothing, and its host is in the set from that
	 * first render.
	 */
	function afterEnrichment(host: HTMLElement, insertedBlocks: number, enrichment: Promise<void>) {
		const cold = insertedBlocks > 0 && !enrichedHosts.has(host);
		if (!cold) return;
		enrichedHosts.add(host);
		void restoreAfterColdEnrichment(enrichment, tabManager.activeTabId);
	}

	return { afterEnrichment };
}
