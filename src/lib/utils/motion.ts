/**
 * A jump's `ScrollBehavior` from the "animate jumps" setting, for the
 * `scrollTo` and `scrollIntoView` callers. `'auto'` rather than `'instant'`:
 * both jump, and `'auto'` is the value the spec has always had.
 *
 * The system's reduce-motion preference is not read. Markpad runs on three
 * systems that do not all have one, so the app's own settings are the only
 * answer, and a switch the user can see is never overruled by one they cannot.
 */
export function jumpScrollBehavior(animate: boolean): ScrollBehavior {
	return animate ? 'smooth' : 'auto';
}
