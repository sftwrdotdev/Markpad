/** The fields the review needs from a tab. */
export type ReviewTab = { id: string; path: string };

export type CloseReview = {
	/** The leftmost tab still holding unsaved changes, or undefined when none do. */
	nextDirtyTab: () => ReviewTab | undefined;
	setActive: (id: string) => void;
	/** Let the activation paint before a modal covers it — `tick()` in the app. */
	settle: () => Promise<void>;
	/** The same per-tab unsaved-changes dialog a single tab close shows. */
	canCloseTab: (id: string) => Promise<boolean>;
	closeTab: (id: string) => void;
	/** Whether a resolved tab is closed, or left open for the restore snapshot. */
	shouldCloseAfterResolving: (tab: ReviewTab) => boolean;
};

/**
 * Walk the dirty tabs one at a time, resolving each through the dialog the
 * reader already knows (issue #189 — this replaced one aggregate "you have N
 * unsaved files" modal).
 *
 * Returns false if the reader cancelled, which stops the walk and keeps the
 * window open with the tabs that are left.
 *
 * `nextDirtyTab` is re-consulted every round rather than iterated over a list
 * captured up front. A save can leave a tab dirty again, and tabs can be opened
 * or closed while a dialog is up; a stale list would either skip a tab holding
 * unsaved work or try to close one that is already gone.
 *
 * Extracted from `MarkdownViewer.svelte` so this can be run rather than
 * described. What it replaced was `assert.match(handler, /if \(!\(await
 * canCloseTab\(dirty\.id\)\)\) return;/)` — an assertion that the source
 * contains a `return`, which is as close to "cancelling stops the walk" as
 * matching text gets.
 */
export async function reviewDirtyTabs(review: CloseReview): Promise<boolean> {
	while (true) {
		const dirty = review.nextDirtyTab();
		if (!dirty) return true;

		// Activate first: the dialog names one tab, and a reader looking at a
		// different document cannot tell which.
		review.setActive(dirty.id);
		await review.settle();

		if (!(await review.canCloseTab(dirty.id))) return false;

		if (review.shouldCloseAfterResolving(dirty)) review.closeTab(dirty.id);
	}
}
