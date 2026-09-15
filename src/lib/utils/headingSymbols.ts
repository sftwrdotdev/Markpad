import type * as Monaco from 'monaco-editor';

import type { HeadingAnchor } from './headingCompletion.js';

/**
 * The document's headings as nested sections, for Monaco's sticky scroll (#759).
 *
 * Sticky scroll pins the symbols the viewport is inside, and asks the document
 * symbol provider first. Markdown had none, so it fell back to indentation,
 * which pins a wrapped list item and never a heading. A section runs from its
 * heading to the line before the next heading at the same level or above, and
 * sits inside the nearest heading above it with a lower level — the outline
 * VS Code's Markdown extension hands the same editor.
 */
export function headingSymbols(
	anchors: HeadingAnchor[],
	lineCount: number,
	kind: Monaco.languages.SymbolKind,
): Monaco.languages.DocumentSymbol[] {
	const roots: Monaco.languages.DocumentSymbol[] = [];
	const open: { level: number; children: Monaco.languages.DocumentSymbol[] }[] = [];
	anchors.forEach((anchor, i) => {
		const children: Monaco.languages.DocumentSymbol[] = [];
		const line = { startLineNumber: anchor.line, startColumn: 1, endLineNumber: anchor.line, endColumn: 1 };
		const symbol = {
			name: anchor.text,
			detail: '',
			kind,
			tags: [],
			range: { ...line, endLineNumber: sectionEnd(anchors, i, lineCount) },
			selectionRange: line,
			children,
		};
		while (open.length > 0 && open[open.length - 1].level >= anchor.level) open.pop();
		(open[open.length - 1]?.children ?? roots).push(symbol);
		open.push({ level: anchor.level, children });
	});
	return roots;
}

/**
 * The same sections as fold ranges for the editor (#777). A fold stops at the
 * section's last non-blank line, so the gap before the next heading stays on
 * screen, as in VS Code; a heading with nothing under it does not fold.
 */
export function headingFoldRanges(
	anchors: HeadingAnchor[],
	lineCount: number,
	lineAt: (lineNumber: number) => string,
): { start: number; end: number }[] {
	return anchors.flatMap((anchor, i) => {
		let end = sectionEnd(anchors, i, lineCount);
		while (end > anchor.line && lineAt(end).trim() === '') end -= 1;
		return end > anchor.line ? [{ start: anchor.line, end }] : [];
	});
}

/** The line before the next heading at the same level or above, or the last line. */
function sectionEnd(anchors: HeadingAnchor[], i: number, lineCount: number): number {
	const next = anchors.slice(i + 1).find((later) => later.level <= anchors[i].level);
	return next ? next.line - 1 : lineCount;
}
