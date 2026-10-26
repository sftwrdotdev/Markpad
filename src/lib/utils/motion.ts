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

/**
 * Commit `el`'s current style without animating it: add `tab-switching`
 * (transitions off, see styles.css), force a style recompute, remove it. The
 * forced read between the two is the mechanism, not a formality: without it
 * the class is added and removed within one style computation and suppresses
 * nothing.
 */
export function commitWithoutTransitions(el: Pick<HTMLElement, 'classList' | 'offsetHeight'>): void {
	el.classList.add('tab-switching');
	void el.offsetHeight;
	el.classList.remove('tab-switching');
}
