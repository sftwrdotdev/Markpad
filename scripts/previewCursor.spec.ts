import assert from 'node:assert/strict';

import { test } from 'vitest';

import { pointAtSource, sourceAtPoint, type DomPoint, type SourcePoint } from '../src/lib/utils/previewCursor.js';
import { asRendererLine } from '../src/lib/utils/lineCoordinates.js';

// #799's shared cursor: a click in the preview lands on a source character,
// and the editor's cursor is drawn back onto the rendered character. The HTML
// is `convert_markdown`'s real output for SOURCE, so the columns are comrak's
// UTF-8 byte offsets, which the Chinese lines exercise.

const SOURCE = "# Title here\n\nA paragraph with **bold text** and a [link](https://example.com) here.\nSecond line with `code` and an escaped \\* star & more.\n\n中文段落里有**粗体**和测试。\n\n- item one\n- item **two**\n\n> quoted text\n\n```js\nlet x = 1;\n```\n\n| name | 值 |\n| --- | --- |\n| 甲 | beta |\n";
const HTML = "<h1 id=\"title-here\" data-sourcepos=\"1:1-1:12\">Title here<a href=\"#title-here\" aria-label=\"Link to heading 'Title here'\" data-heading-content=\"Title here\" class=\"anchor\"></a></h1>\n<p data-sourcepos=\"3:1-4:54\">A paragraph with <strong data-sourcepos=\"3:18-3:30\">bold text</strong> and a <a data-sourcepos=\"3:38-3:64\" href=\"https://example.com\">link</a> here.<br data-sourcepos=\"3:71-3:71\" />\nSecond line with <code data-sourcepos=\"4:18-4:23\">code</code> and an escaped * star &amp; more.</p>\n<p data-sourcepos=\"6:1-6:40\">中文段落里有<strong data-sourcepos=\"6:19-6:28\">粗体</strong>和测试。</p>\n<ul data-sourcepos=\"8:1-9:14\">\n<li data-sourcepos=\"8:1-8:10\">item one</li>\n<li data-sourcepos=\"9:1-10:0\">item <strong data-sourcepos=\"9:8-9:14\">two</strong></li>\n</ul>\n<blockquote data-sourcepos=\"11:1-11:13\">\n<p data-sourcepos=\"11:3-11:13\">quoted text</p>\n</blockquote>\n<pre data-sourcepos=\"13:1-15:3\"><code class=\"language-js\">let x = 1;\n</code></pre>\n<table data-sourcepos=\"17:1-19:14\">\n<thead>\n<tr data-sourcepos=\"17:1-17:14\">\n<th data-sourcepos=\"17:2-17:7\">name</th>\n<th data-sourcepos=\"17:9-17:13\">值</th>\n</tr>\n</thead>\n<tbody>\n<tr data-sourcepos=\"19:1-19:14\">\n<td data-sourcepos=\"19:2-19:6\">甲</td>\n<td data-sourcepos=\"19:8-19:13\">beta</td>\n</tr>\n</tbody>\n</table>\n";

const sourceLines = SOURCE.split('\n');
const readLine = (line: number) => sourceLines[line - 1];

function render() {
	const root = document.createElement('div');
	root.innerHTML = HTML;
	return root;
}

/** The text node and offset of the `nth` occurrence of `char` in rendered text under `selector`. */
function charIn(root: Element, selector: string, char: string, nth = 0) {
	const walker = document.createTreeWalker(root.querySelector(selector)!, NodeFilter.SHOW_TEXT);
	let seen = 0;
	for (let node = walker.nextNode() as Text | null; node; node = walker.nextNode() as Text | null) {
		for (let offset = 0; offset < node.data.length; offset++) {
			if (node.data[offset] === char && seen++ === nth) return { node, offset };
		}
	}
	throw new Error(`no ${char} under ${selector}`);
}

const at = (line: number, column: number): SourcePoint => ({ line: asRendererLine(line), column });

test('a click lands on the source character it rendered', () => {
	const root = render();
	const cases: Array<[string, string, SourcePoint, number?]> = [
		['h1', 'T', at(1, 3)],
		['p strong', 'b', at(3, 20)],
		['p a', 'l', at(3, 39)],
		['p code', 'c', at(4, 19)],
		['p', '*', at(4, 41)],
		['p', '&', at(4, 48)],
		['p:nth-of-type(2)', '粗', at(6, 9)],
		['p:nth-of-type(2)', '测', at(6, 14)],
		['li', 'o', at(8, 8)],
		['li:nth-of-type(2) strong', 't', at(9, 10)],
		['blockquote p', 'q', at(11, 3)],
		['pre', 'x', at(14, 5)],
		['td', '甲', at(19, 3)],
		['td:nth-of-type(2)', 'b', at(19, 7)],
	];
	for (const [selector, char, expected] of cases) {
		assert.deepEqual(sourceAtPoint(root, charIn(root, selector, char), readLine), expected, `${char} in ${selector}`);
		assert.equal(sourceLines[expected.line - 1][expected.column - 1], char, `${char} is the source character there`);
	}
});

test('every rendered character goes to the source and back to itself', () => {
	const root = render();
	const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
	let checked = 0;
	for (let node = walker.nextNode() as Text | null; node; node = walker.nextNode() as Text | null) {
		for (let offset = 0; offset < node.data.length; offset++) {
			if (/\s/.test(node.data[offset]) || !node.parentElement?.closest('[data-sourcepos]')) continue;
			const source: SourcePoint = sourceAtPoint(root, { node, offset }, readLine)!;
			const back: DomPoint = pointAtSource(root, source, readLine)!;
			assert.equal(back.node, node, `"${node.data[offset]}" came back in another node`);
			assert.equal(back.offset, offset, `"${node.data[offset]}" came back at another offset`);
			checked++;
		}
	}
	assert.ok(checked > 130, `the fixture was walked (${checked})`);
});

test('a fenced block pairs its code, not its info string', () => {
	// `js` on the fence would take the first two characters of `js = 1`.
	const root = document.createElement('div');
	root.innerHTML = '<pre data-sourcepos="1:1-3:3"><code class="language-js">js = 1;\n</code></pre>';
	const lines = ['```js', 'js = 1;', '```'];
	const point = sourceAtPoint(root, charIn(root, 'pre', 's'), (line) => lines[line - 1]);
	assert.deepEqual(point, at(2, 2));
});

test('a point inside KaTeX lands just after the formula', () => {
	const root = document.createElement('div');
	root.innerHTML = '<p data-sourcepos="1:1-1:14">sum <span class="katex">x2x^2</span> done</p>';
	const katex = root.querySelector('.katex')!;
	const point = sourceAtPoint(root, { node: katex.firstChild!, offset: 1 }, () => 'sum $x^2$ done');
	assert.deepEqual(point, at(1, 10), 'on the space after `$x^2$`');
});
