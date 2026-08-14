/**
 * Whether a jump animates its scroll, and the `ScrollBehavior` that follows.
 *
 * ONE ANSWER FOR SEVEN CALL SITES. Six `behavior: 'smooth'` literals across
 * `MarkdownViewer` and `FindBar`, plus Monaco's `smoothScrolling` in
 * `Editor.svelte` — the same decision, spelled three ways in three files. A
 * preference that reached six of them and missed the seventh is the shape this
 * repo keeps finding: an underscore missing from a separator list, one view
 * toggle left at a different default from its six siblings, one branch reading
 * the resolved href while the two beside it read the attribute.
 *
 * THE SYSTEM PREFERENCE SITS BESIDE THE APP'S, NOT INSIDE ITS DEFAULT. Seeding
 * the stored setting from `prefers-reduced-motion` would make a copy that goes
 * stale the moment the user changes the system setting, and it would have the
 * app remembering an answer the OS is already giving — the same two-places-one-
 * fact trap. Either voice asking for less motion is enough, which is how
 * `@media (prefers-reduced-motion: reduce)` is defined: it is a request from
 * the person, not a default for the app to override.
 */
export function animatesJumpScroll(animate: boolean, systemPrefersReducedMotion: boolean): boolean {
	return animate && !systemPrefersReducedMotion;
}

/**
 * The same decision as a `ScrollBehavior`, for the `scrollTo` and
 * `scrollIntoView` callers. `'auto'` rather than `'instant'`: both jump, and
 * `'auto'` is the value the spec has always had.
 */
export function jumpScrollBehavior(
	animate: boolean,
	systemPrefersReducedMotion: boolean,
): ScrollBehavior {
	return animatesJumpScroll(animate, systemPrefersReducedMotion) ? 'smooth' : 'auto';
}

/**
 * Reads the system preference, and reports every later change.
 *
 * Returns the unsubscribe. `matchMedia` is absent when this module is loaded
 * outside a browser — a test importing the two functions above, which is the
 * point of them being pure — so the caller keeps whatever it had.
 */
export function watchReducedMotion(onChange: (reduced: boolean) => void): () => void {
	if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return () => {};

	const query = window.matchMedia('(prefers-reduced-motion: reduce)');
	onChange(query.matches);
	const listener = (event: MediaQueryListEvent) => onChange(event.matches);
	query.addEventListener('change', listener);
	return () => query.removeEventListener('change', listener);
}
