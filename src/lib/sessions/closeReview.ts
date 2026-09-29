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
 * Resolve dirty tabs one at a time with the per-tab save dialog (#189).
 * Returns false if the reader cancels, leaving the window open.
 *
 * `nextDirtyTab` is asked every round: a save can leave a tab dirty again,
 * and tabs can open or close while a dialog is up.
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
