import { observeFoldLayout, type FoldLayoutObservation } from './foldLayout.js';

/** The preview pane is on screen outside edit mode, and in split view. */
export function previewPaneShown(isEditing: boolean, isSplit: boolean): boolean {
	return !isEditing || isSplit;
}

/**
 * Keeps one fold-layout observation on the visible preview host, published in
 * `holder.current` for the patch to hand its new blocks to. Call during
 * component init.
 *
 * Keyed on the visible host only. A keystroke must not re-observe: a fresh
 * `observe` reports at once and would re-measure every fold. The patch observes
 * new blocks itself. A hidden host is not observed at all, because its boxes
 * measure 0.
 */
export function followFoldLayout(
	holder: { current: FoldLayoutObservation | null },
	getHost: () => HTMLElement | null | undefined,
	isShown: () => boolean,
): void {
	$effect(() => {
		const host = getHost();
		if (!host || !isShown()) return;

		const observation = observeFoldLayout(host);
		holder.current = observation;

		return () => {
			observation.stop();
			if (holder.current === observation) holder.current = null;
		};
	});
}
