/** One tab as the auto-save debounce sees it on a pass. */
export type AutoSaveTabState = {
	id: string;
	path: string;
	isDirty: boolean;
	/** In edit mode or split view. */
	editable: boolean;
	hasPendingConflict: boolean;
	decodedLossily: boolean;
};

/** Whether the debounce arms (or keeps) a timer for this tab. */
export function isAutoSaveEligible(s: AutoSaveTabState, isLossySaveRefused: (tabId: string) => boolean): boolean {
	// A tab with an unanswered external-change conflict is NOT
	// eligible: the debounce would fire while the bar is still
	// asking "reload or keep mine", write the buffer, and destroy
	// the disk version the question was about — leaving the user to
	// answer a question whose "reload" branch no longer exists.
	// Only this background timer is held back. Cmd+S and the close
	// dialog's Save still write, because that answer means "keep
	// mine".
	// A tab whose buffer was decoded lossily is dropped once the
	// guard has refused it and said why. The first attempt is what
	// produces that explanation, so it is deliberately allowed
	// through; re-arming after it would only reach the same refusal
	// every 1.5s for as long as the user keeps typing.
	return s.isDirty && s.path !== '' && s.editable && !s.hasPendingConflict
		&& !(s.decodedLossily && isLossySaveRefused(s.id));
}

/** Whether an auto-save that resolved false gets the generic "auto-save failed" toast. */
export function autoSaveFailureNeedsToast(
	tabId: string,
	reasons: { isLossySaveRefused: (tabId: string) => boolean; hasExternalChangeConflict: (tabId: string) => boolean },
): boolean {
	// A refusal already explained itself, naming the
	// file and the way out. "Auto-save failed" on top
	// of that says nothing new.
	if (reasons.isLossySaveRefused(tabId)) return false;
	// Same reasoning for the other refusal: the disk
	// moved under the write, and the conflict bar is
	// already on screen saying so and offering both
	// ways out.
	if (reasons.hasExternalChangeConflict(tabId)) return false;
	return true;
}
