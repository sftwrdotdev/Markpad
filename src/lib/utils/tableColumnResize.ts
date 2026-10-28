/**
 * Dragging a column border anywhere in a preview table moves width between the
 * two columns beside it, as in a word processor's table (#1036).
 *
 * The widths are inline styles on the live `th`s and nowhere else. GFM has no
 * syntax to keep them in, and both exports render the buffer again rather than
 * read the preview, so they belong to this view of the document only. The block
 * patch keeps a table's nodes until that table's own source changes, so the
 * widths survive edits elsewhere and reset when the table is edited or the file
 * is opened again.
 *
 * The first drag pins every column at the width it has and sizes the table to
 * `min-content`, the sum of its columns. Any wider and auto layout hands the
 * slack out to every column; sized by its widest content, the table would stay
 * as wide as the page and do exactly that.
 *
 * The table never gets narrower than it was before the first drag. A border
 * between two columns trades width between them, so the total holds; a column
 * cannot go below its longest word (the floor #927 set), so what it could not
 * give stays with it, and what its neighbour could not give widens the table,
 * past 100% into its horizontal scroll. The table's outer border widens the
 * last column freely and narrows it only down to that first width. A
 * double-click on a border puts the whole table back on automatic widths.
 */

/** How near a border, in px, a press counts as grabbing it. */
const GRAB = 5;

const HOVER_CLASS = 'column-resize-hover';

/**
 * The header cell of the column whose trailing border is under the pointer, or
 * null. Any row's border counts; the width is kept on the header cell, which
 * sizes the whole column.
 */
export function cellAtBorder(e: MouseEvent): HTMLTableCellElement | null {
	if (!(e.target instanceof Element)) return null;
	const cell = e.target.closest('td, th');
	const header = cell?.closest('table')?.tHead?.rows[0];
	if (!(cell instanceof HTMLTableCellElement) || !header) return null;
	const rect = cell.getBoundingClientRect();
	const rtl = getComputedStyle(cell).direction === 'rtl';
	const toTrailing = rtl ? e.clientX - rect.left : rect.right - e.clientX;
	// Just past a border the pointer is already over the next cell.
	const toLeading = rtl ? rect.right - e.clientX : e.clientX - rect.left;
	const column = toTrailing <= GRAB ? cell.cellIndex : toLeading <= GRAB ? cell.cellIndex - 1 : -1;
	return header.cells[column] ?? null;
}

function usedWidth(cell: Element): number {
	return parseFloat(getComputedStyle(cell).width) || 0;
}

/**
 * Width alone is not enough in WebKit: a table capped at 100% still squeezes
 * its columns to fit, so a column widened past the page takes from the others
 * instead of the table scrolling. The minimum makes the pinned width hold.
 */
function pin(cell: HTMLElement, width: number | null): void {
	const value = width === null ? '' : `${Math.max(0, width)}px`;
	cell.style.width = value;
	cell.style.minWidth = value;
}

/** Each resized table's width before its first drag: the least it may shrink to. */
const naturalWidths = new WeakMap<HTMLTableElement, number>();

/** Wires column resizing onto the preview root; returns the teardown. */
export function attachTableColumnResize(root: HTMLElement): () => void {
	let endDrag: (() => void) | null = null;

	const onHover = (e: PointerEvent) => {
		if (endDrag || e.buttons) return;
		root.classList.toggle(HOVER_CLASS, cellAtBorder(e) !== null);
	};

	const onLeave = () => {
		if (!endDrag) root.classList.remove(HOVER_CLASS);
	};

	const onDown = (e: PointerEvent) => {
		if (e.button !== 0 || endDrag) return;
		const cell = cellAtBorder(e);
		if (!cell) return;
		e.preventDefault();

		const table = cell.closest('table')!;
		if (!table.style.width) {
			naturalWidths.set(table, table.offsetWidth);
			// Measure every column before writing any: each write reflows the rest.
			const cells = Array.from(cell.parentElement?.children ?? []) as HTMLElement[];
			const widths = cells.map(usedWidth);
			cells.forEach((c, i) => pin(c, widths[i]));
			table.style.width = 'min-content';
		}
		const natural = naturalWidths.get(table) ?? 0;
		const next = cell.nextElementSibling as HTMLElement | null;
		const start = usedWidth(cell);
		const startNext = next ? usedWidth(next) : 0;
		const startX = e.clientX;
		const sign = getComputedStyle(cell).direction === 'rtl' ? -1 : 1;

		const onMove = (move: PointerEvent) => {
			pin(cell, start + sign * (move.clientX - startX));
			if (next) {
				// What the column really gave up or took, after its floor.
				pin(next, startNext + start - usedWidth(cell));
			} else {
				const short = natural - table.scrollWidth;
				if (short > 0) pin(cell, usedWidth(cell) + short);
			}
		};
		endDrag = () => {
			window.removeEventListener('pointermove', onMove);
			window.removeEventListener('pointerup', endDrag!);
			window.removeEventListener('pointercancel', endDrag!);
			endDrag = null;
		};
		window.addEventListener('pointermove', onMove);
		window.addEventListener('pointerup', endDrag);
		window.addEventListener('pointercancel', endDrag);
	};

	const onDoubleClick = (e: MouseEvent) => {
		const table = cellAtBorder(e)?.closest('table');
		if (!table) return;
		e.preventDefault();
		table.style.width = '';
		for (const th of table.querySelectorAll<HTMLElement>('thead th')) pin(th, null);
	};

	root.addEventListener('pointermove', onHover);
	root.addEventListener('pointerleave', onLeave);
	root.addEventListener('pointerdown', onDown);
	root.addEventListener('dblclick', onDoubleClick);
	return () => {
		endDrag?.();
		root.classList.remove(HOVER_CLASS);
		root.removeEventListener('pointermove', onHover);
		root.removeEventListener('pointerleave', onLeave);
		root.removeEventListener('pointerdown', onDown);
		root.removeEventListener('dblclick', onDoubleClick);
	};
}
