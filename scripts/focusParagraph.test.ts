import assert from 'node:assert/strict';
import { test } from 'node:test';

import { paragraphAround } from '../src/lib/utils/focusParagraph.js';

const LINES = ['# Title', '', 'one', 'two', '  ', 'three', ''];
const read = (line: number) => LINES[line - 1];

test('the paragraph is the run of non-blank lines around the cursor', () => {
	assert.deepEqual(paragraphAround(read, LINES.length, 1), { start: 1, end: 1 });
	assert.deepEqual(paragraphAround(read, LINES.length, 4), { start: 3, end: 4 }, 'from its last line');
	assert.deepEqual(paragraphAround(read, LINES.length, 3), { start: 3, end: 4 }, 'from its first line');
	assert.deepEqual(paragraphAround(read, LINES.length, 6), { start: 6, end: 6 }, 'a whitespace-only line ends a paragraph');
	assert.deepEqual(paragraphAround(read, LINES.length, 2), { start: 2, end: 2 }, 'a blank line is its own');
});
