import assert from 'node:assert/strict';
import test from 'node:test';

import { isInFencedCode } from '../src/lib/utils/codeFence.js';

/** Every line of `text`, 1-based, answered in order. */
function inside(text: string): boolean[] {
	const lines = text.split('\n');
	const doc = { getLineContent: (line: number) => lines[line - 1] };
	return lines.map((_, index) => isInFencedCode(doc, index + 1));
}

test('the lines after an opening fence are inside it, up to and including the closing fence', () => {
	assert.deepEqual(inside('a\n```\n1. x\n```\nb'), [false, false, true, true, false]);
	assert.deepEqual(inside('~~~ts\n|a|\n~~~\n|a|'), [false, true, true, false]);
});

test('only the same character, at least as long, with nothing after it, closes', () => {
	assert.deepEqual(inside('````\n```\nx\n````\ny'), [false, true, true, true, false]);
	assert.deepEqual(inside('```\n~~~\nx\n```\ny'), [false, true, true, true, false]);
	assert.deepEqual(inside('```\n``` ts\nx\n```  \ny'), [false, true, true, true, false]);
});

test('an unclosed fence runs to the end of the document', () => {
	assert.deepEqual(inside('```\na\nb'), [false, true, true]);
});

test('a backtick run with a backtick after it is inline code, not a fence', () => {
	assert.deepEqual(inside('```a```\n1. x'), [false, false]);
	// A tilde fence's info string may say anything.
	assert.deepEqual(inside('~~~ a`b\nx\n~~~'), [false, true, true]);
});

test('a fence nested in a list item or a quote counts; two backticks do not', () => {
	assert.deepEqual(inside('1. a\n   ```\n   2. b\n   ```\n3. c'), [false, false, true, true, false]);
	assert.deepEqual(inside('> ```\n> - x\n> ```\n- y'), [false, true, true, false]);
	assert.deepEqual(inside('``\n- x'), [false, false]);
});
