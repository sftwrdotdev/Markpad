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
		const next = anchors.slice(i + 1).find((later) => later.level <= anchor.level);
		const children: Monaco.languages.DocumentSymbol[] = [];
		const line = { startLineNumber: anchor.line, startColumn: 1, endLineNumber: anchor.line, endColumn: 1 };
		const symbol = {
			name: anchor.text,
			detail: '',
			kind,
			tags: [],
			range: { ...line, endLineNumber: next ? next.line - 1 : lineCount },
			selectionRange: line,
			children,
		};
		while (open.length > 0 && open[open.length - 1].level >= anchor.level) open.pop();
		(open[open.length - 1]?.children ?? roots).push(symbol);
		open.push({ level: anchor.level, children });
	});
	return roots;
}
