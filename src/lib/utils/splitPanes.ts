/** Which side of a split the editor takes. `settings.splitEditorSide`. */
export type SplitEditorSide = 'left' | 'right';

/**
 * Where the splitter leaves the editor's share after travelling `fraction` of
 * the window to the RIGHT. Negative `fraction` is leftward travel.
 *
 * `splitRatio` is the EDITOR's share of the row, not the left pane's. That
 * distinction did not exist while the editor was always the left pane, and
 * `splitEditorSide` (#184) is what creates it: with the editor on the right,
 * the bar has to travel left to give it more room, so the same pointer motion
 * has to move the ratio the other way.
 *
 * Both the drag and the arrow keys go through here rather than each applying
 * the sign themselves. A splitter that followed the pointer one way and the
 * keyboard the other would be worse than one that got both wrong, and two
 * copies of `side === 'left' ? d : -d` is exactly the shape that ends up that
 * way — the second copy is written by whoever adds the next input route.
 *
 * The result is deliberately unclamped: `TabManager.setSplitRatio` holds the
 * 0.1–0.9 bounds, and a second copy of them here would be the same trap one
 * level down.
 */
export function splitRatioAfterMove(
	startRatio: number,
	fraction: number,
	editorSide: SplitEditorSide,
): number {
	return startRatio + (editorSide === 'left' ? fraction : -fraction);
}

/**
 * The arrow keys' route: one 5% step, the same units the drag moves in. `null`
 * for any other key.
 */
export function splitRatioAfterKey(ratio: number, key: string, editorSide: SplitEditorSide): number | null {
	const step = key === 'ArrowLeft' ? -0.05 : key === 'ArrowRight' ? 0.05 : 0;
	if (step === 0) return null;
	return splitRatioAfterMove(ratio, step, editorSide);
}

/** The pointer's route: travel from `startX` as a share of the window. */
export function splitRatioAfterDrag(
	startRatio: number,
	startX: number,
	clientX: number,
	containerWidth: number,
	editorSide: SplitEditorSide,
): number {
	return splitRatioAfterMove(startRatio, (clientX - startX) / containerWidth, editorSide);
}
