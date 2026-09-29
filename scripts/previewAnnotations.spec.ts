import assert from 'node:assert/strict';

import { test } from 'vitest';

import { annotationOf, hitAt, occurrenceRanges, overlapping, rangeOf, type Annotation } from '../src/lib/utils/previewAnnotations.js';
import { asRendererLine } from '../src/lib/utils/lineCoordinates.js';

// A reader's session-only highlight: the selection goes to source points,
// and comes back as the same text however the preview was re-rendered since.

const SOURCE = ['A paragraph with **bold text** here.', '', '中文段落里有**粗体**和测试。'];
const HTML = '<p data-sourcepos="1:1-1:36">A paragraph with <strong data-sourcepos="1:18-1:30">bold text</strong> here.</p>\n<p data-sourcepos="3:1-3:40">中文段落里有<strong data-sourcepos="3:19-3:28">粗体</strong>和测试。</p>';
const readLine = (line: number) => SOURCE[line - 1];

function render() {
	const root = document.createElement('div');
	root.innerHTML = HTML;
	return root;
}

function select(root: Element, from: string, to: string) {
	const text = root.textContent!;
	const start = text.indexOf(from);
	const end = text.indexOf(to) + to.length;
	const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
	const range = document.createRange();
	let seen = 0;
	for (let node = walker.nextNode() as Text | null; node; node = walker.nextNode() as Text | null) {
		if (start >= seen && start < seen + node.data.length) range.setStart(node, start - seen);
		if (end > seen && end <= seen + node.data.length) range.setEnd(node, end - seen);
		seen += node.data.length;
	}
	return range;
}

test('a selection comes back as the same text in a fresh render', () => {
	const cases: Array<[string, string, string]> = [
		['bold', 'text', 'bold text'],
		['with', 'here', 'with bold text here'],
		['text', '粗体', 'text here.\n中文段落里有粗体'],
		['粗', '测', '粗体和测'],
	];
	for (const [from, to, expected] of cases) {
		const shown = render();
		const mark = annotationOf(shown, select(shown, from, to), readLine);
		assert.ok(mark, `${from}…${to} mapped`);
		assert.equal(rangeOf(render(), mark, readLine)?.toString(), expected);
	}
});

const at = (line: number, column: number) => ({ line: asRendererLine(line), column });
const span = (a: number, b: number): Annotation => ({ start: at(1, a), end: at(1, b) });

test('overlap is half-open, and a point hits the mark around it', () => {
	const marks = [span(3, 8), span(12, 20)];
	assert.deepEqual(overlapping(marks, span(7, 13)), marks);
	assert.deepEqual(overlapping(marks, span(8, 12)), [], 'touching ends do not overlap');
	assert.deepEqual(hitAt(marks, at(1, 3)), [marks[0]]);
	assert.deepEqual(hitAt(marks, at(1, 8)), [], 'the end is outside');
	assert.deepEqual(hitAt(marks, at(2, 1)), []);
});

test('occurrences are the exact copies of the selected text, up to the limit', () => {
	const root = document.createElement('div');
	root.innerHTML = '<p>cat, Cat, cat</p><p>concatenate <strong>cat</strong></p>';
	const found = occurrenceRanges(root, 'cat', 100);
	assert.deepEqual(found.map((range) => range.toString()), ['cat', 'cat', 'cat', 'cat'], 'case-sensitive, inside words too');
	assert.equal(occurrenceRanges(root, 'cat', 2).length, 2);
});
