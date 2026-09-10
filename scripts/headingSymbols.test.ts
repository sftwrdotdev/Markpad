import assert from 'node:assert/strict';
import test from 'node:test';

import type * as Monaco from 'monaco-editor';

import { headingSymbols } from '../src/lib/utils/headingSymbols.js';

const heading = (line: number, level: number, text: string) => ({ line, level, text, slug: '' });

/** One row per symbol, indented by depth: `name start-end`. */
function outline(symbols: Monaco.languages.DocumentSymbol[], depth = 0): string[] {
	return symbols.flatMap((symbol) => [
		`${'  '.repeat(depth)}${symbol.name} ${symbol.range.startLineNumber}-${symbol.range.endLineNumber}`,
		...outline(symbol.children ?? [], depth + 1),
	]);
}

test('#759: a section nests under the heading above it, and ends where a peer or a parent starts', () => {
	// The document from the issue, with a second H2 so a section has to close.
	const symbols = headingSymbols(
		[heading(1, 1, 'H1'), heading(3, 2, 'H2'), heading(5, 3, 'H3'), heading(10, 3, 'Second H3'), heading(14, 2, 'Another H2')],
		16,
		0,
	);
	assert.deepEqual(outline(symbols), [
		'H1 1-16',
		'  H2 3-13',
		'    H3 5-9',
		'    Second H3 10-13',
		'  Another H2 14-16',
	]);
});

test('a skipped level still nests, and a shallower heading closes every deeper section', () => {
	const symbols = headingSymbols([heading(1, 1, 'A'), heading(2, 3, 'deep'), heading(4, 2, 'B'), heading(6, 1, 'C')], 8, 0);
	assert.deepEqual(outline(symbols), ['A 1-5', '  deep 2-3', '  B 4-5', 'C 6-8']);
});
