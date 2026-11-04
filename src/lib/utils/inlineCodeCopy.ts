/**
 * Click-to-copy for inline code (`like this`) in the preview.
 *
 * Hovering an inline `<code>` shows a small copy badge against its right edge.
 * The badge is the element's own `::before`/`::after` (styles.css,
 * `.copyable-inline-code`), not a node in the document: the preview's copy,
 * find, scroll sync and cursor mapping all walk this DOM, and a button inside
 * every code span would be one more thing each of them has to step over.
 *
 * A pseudo-element is never an event target, so a click on the badge arrives
 * as a click on the `<code>` itself. What tells the two apart is where the
 * click landed: the badge sits outside the code's own line boxes, and the
 * code's text never does.
 */

/** Class the preview article carries while the badge is on. */
export const COPYABLE_INLINE_CODE_CLASS = 'copyable-inline-code';

/** Class a code span carries while its badge reads "Copied!". */
export const INLINE_CODE_COPIED_CLASS = 'inline-code-copied';

/**
 * The inline `<code>` whose copy badge a click at (`clientX`, `clientY`) hit,
 * or null when the click was anywhere else.
 *
 * Not inline code: anything in a `<pre>` (fenced blocks have their own label)
 * and anything in a link, where a click has to keep following the link.
 */
export function inlineCodeCopyTarget(target: EventTarget | null, clientX: number, clientY: number): HTMLElement | null {
	const element = target instanceof Element ? target : null;
	const code = element?.closest('code');
	if (!code || code.closest('pre, a')) return null;

	// A click whose target is the code but which lands outside every one of
	// its own line boxes can only have landed on the badge. Line boxes, not the
	// bounding box: wrapped code spans several lines, and the bounding box of
	// those covers ground the code's text does not. Asking "outside the code"
	// rather than "inside the badge" keeps this true wherever styles.css puts
	// the badge.
	const lines = Array.from(code.getClientRects());
	const onText = lines.some(
		(line) => clientX >= line.left && clientX <= line.right && clientY >= line.top && clientY <= line.bottom,
	);
	return onText ? null : (code as HTMLElement);
}

const copiedTimers = new WeakMap<HTMLElement, ReturnType<typeof setTimeout>>();

/**
 * Shows "Copied!" on a code span's badge for 1.5 s. A second copy inside
 * that time restarts it rather than ending it early.
 */
export function flashInlineCodeCopied(code: HTMLElement) {
	const pending = copiedTimers.get(code);
	if (pending) clearTimeout(pending);
	code.classList.add(INLINE_CODE_COPIED_CLASS);
	copiedTimers.set(
		code,
		setTimeout(() => {
			copiedTimers.delete(code);
			code.classList.remove(INLINE_CODE_COPIED_CLASS);
		}, 1500),
	);
}

/**
 * Handles a preview click if it hit an inline code badge: copies the code's
 * text and flashes the badge. Returns whether it did, so the caller can stop
 * the click there.
 */
export function handleInlineCodeCopyClick(
	event: MouseEvent,
	copy: (text: string) => Promise<unknown>,
): boolean {
	const code = inlineCodeCopyTarget(event.target, event.clientX, event.clientY);
	if (!code) return false;
	event.preventDefault();
	event.stopPropagation();
	copy(code.textContent ?? '')
		.then(() => flashInlineCodeCopied(code))
		.catch((error) => console.error('Failed to copy inline code:', error));
	return true;
}
