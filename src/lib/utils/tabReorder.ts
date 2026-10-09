/**
 * Drag-to-reorder for the tab strip, in either orientation.
 *
 * The horizontal strip under the title bar and the vertical tab column (#884)
 * share one drop rule: the dragged tab takes the slot whose centre is nearest
 * the pointer, measured along the axis the tabs are laid out on. Kept free of
 * the DOM so both orientations are tested against the same function.
 */

export type TabAxis = 'x' | 'y';

export interface TabSlot {
	left: number;
	top: number;
	width: number;
	height: number;
}

/** Index of the slot whose centre is nearest `pointer` along `axis`, or -1 with no slots. */
export function closestSlotIndex(slots: readonly (TabSlot | null)[], pointer: { x: number; y: number }, axis: TabAxis): number {
	let closest = -1;
	let minDist = Infinity;
	slots.forEach((slot, index) => {
		if (!slot) return;
		const center = axis === 'x' ? slot.left + slot.width / 2 : slot.top + slot.height / 2;
		const dist = Math.abs((axis === 'x' ? pointer.x : pointer.y) - center);
		if (dist < minDist) {
			minDist = dist;
			closest = index;
		}
	});
	return closest;
}

/** How far the pointer has travelled from the press along `axis`. */
export function dragDistance(start: { x: number; y: number }, current: { x: number; y: number }, axis: TabAxis): number {
	return Math.abs(axis === 'x' ? current.x - start.x : current.y - start.y);
}
