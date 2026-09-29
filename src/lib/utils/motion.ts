/**
 * Whether an animation the user's setting asks for should run.
 *
 * Every animated jump (the preview's `scrollTo`/`scrollIntoView`, Monaco's
 * `smoothScrolling` in `editorOptions.ts`) and the caret glide ask this, each
 * with its own setting.
 *
 * The system preference sits beside the app's, not inside its default: seeding
 * the stored setting from `prefers-reduced-motion` would make a copy that goes
 * stale when the OS setting changes. Either one asking for less motion is
 * enough.
 */
export function allowsMotion(wanted: boolean, systemPrefersReducedMotion: boolean): boolean {
	return wanted && !systemPrefersReducedMotion;
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
	return allowsMotion(animate, systemPrefersReducedMotion) ? 'smooth' : 'auto';
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
