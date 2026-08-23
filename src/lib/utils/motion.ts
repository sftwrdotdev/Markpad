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
	return wantedUnlessSystemAsksForLess(animate, systemPrefersReducedMotion);
}

/**
 * Whether the caret glides to its new position — Monaco's
 * `cursorSmoothCaretAnimation`, which `Editor.svelte` hard-coded to `'on'`
 * (#710).
 *
 * A second preference and not the one above: a jump is something the app does
 * to the view on the user's behalf, and the caret glide is drawn under every
 * arrow key. Someone can want the first animated and the second not, which is
 * why this is its own setting rather than a second reader of
 * `animateJumpScroll`.
 *
 * It answers the system preference the same way, and for the reason spelled
 * out above: either voice asking for less motion is enough.
 */
export function animatesCursor(animate: boolean, systemPrefersReducedMotion: boolean): boolean {
	return wantedUnlessSystemAsksForLess(animate, systemPrefersReducedMotion);
}

/**
 * The shared half of the two answers above — the part that would otherwise be
 * one expression written twice, which is how a preference ends up honouring
 * `prefers-reduced-motion` in one place and not the other.
 */
function wantedUnlessSystemAsksForLess(animate: boolean, reducedMotion: boolean): boolean {
	return animate && !reducedMotion;
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
