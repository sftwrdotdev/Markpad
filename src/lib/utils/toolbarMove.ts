/** Index moves over an already-normalized toolbar order, shared by both toolbars. */
export type ToolbarMove = {
	fromIndex: number;
	toIndex: number;
};

export function getReorderMove(normalized: readonly string[], draggedId: string, targetId: string): ToolbarMove | null {
	const fromIndex = normalized.indexOf(draggedId);
	const toIndex = normalized.indexOf(targetId);

	if (fromIndex === -1 || toIndex === -1 || fromIndex === toIndex) return null;
	return { fromIndex, toIndex };
}

export function getAdjacentMove(normalized: readonly string[], id: string, direction: 'up' | 'down'): ToolbarMove | null {
	const fromIndex = normalized.indexOf(id);
	if (fromIndex === -1) return null;

	const toIndex = direction === 'up' ? fromIndex - 1 : fromIndex + 1;
	if (toIndex < 0 || toIndex >= normalized.length) return null;

	return { fromIndex, toIndex };
}

export function applyMove(normalized: string[], move: ToolbarMove): string[] {
	if (
		move.fromIndex < 0 ||
		move.fromIndex >= normalized.length ||
		move.toIndex < 0 ||
		move.toIndex >= normalized.length ||
		move.fromIndex === move.toIndex
	) {
		return normalized;
	}

	const next = [...normalized];
	const [moved] = next.splice(move.fromIndex, 1);
	next.splice(move.toIndex, 0, moved);
	return next;
}
