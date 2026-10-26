/**
 * How many documents the preview DOM has been given, as a number anything
 * downstream of the render can wait on.
 *
 * `htmlContent` looks like the same signal and is not. It says a document
 * has been *rendered*, and the outline used to take it as saying the article
 * now *holds* that document — which is true only if the patch has
 * already run. On a mount it has not: Svelte runs a child component's
 * effects before its parent's, so `<Toc>` scanned the article in the same
 * flush, one step ahead of the patch that fills it, and found nothing. The
 * string does not change again, so nothing asked it to look twice and the
 * outline stayed empty until it was unmounted and remounted.
 *
 * A pinned outline is the one that never gets that remount, which is why it
 * was the only place the bug was visible: an overhanging floating outline
 * closes itself, and reopening it builds a new component against a DOM that
 * is by then complete.
 *
 * The counter is kept twice on purpose — `patches` is the plain one
 * this effect increments, so the `$state` is only ever written here and
 * never read, and the effect cannot schedule itself.
 *
 * Patches the visible preview host with each rendered document (`patch` is the
 * viewer's patch-and-enrich step) and publishes `revision` after every patch.
 * Call during component init.
 */
export function followPreviewPatch(
	getHost: () => HTMLElement | null,
	getHtml: () => string,
	patch: (host: HTMLElement, html: string) => void,
): { readonly revision: number } {
	let revision = $state(0);
	let patches = 0;
	$effect(() => {
		const host = getHost();
		if (!host) {
			// Still a read, so a document that lands before the element exists
			// re-runs this rather than being missed.
			void getHtml();
			return;
		}
		patch(host, getHtml());
		revision = ++patches;
	});
	return {
		get revision() {
			return revision;
		},
	};
}
