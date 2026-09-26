import assert from 'node:assert/strict';
import { test } from 'vitest';

import { processMarkdownHtml } from '../src/lib/utils/markdown.js';

/**
 * An NBSP is typed on purpose, to keep an empty line Markdown would collapse
 * or to indent text (#843). The inputs are `convert_markdown` output,
 * captured from comrak.
 */

function render(html: string): HTMLElement {
	const root = document.createElement('div');
	root.innerHTML = processMarkdownHtml(html, '/doc.md', new Set());
	return root;
}

test('an NBSP paragraph after a code block is kept', () => {
	// "```\ncode block\n```\n\u00a0\n\nAfter.\n"
	const root = render(
		'<pre data-sourcepos="1:1-3:3"><code>code block\n</code></pre>\n' +
			'<p data-sourcepos="4:1-4:2">\u00a0</p>\n' +
			'<p data-sourcepos="6:1-6:6">After.</p>\n',
	);

	assert.deepEqual(
		Array.from(root.querySelectorAll('p'), (p) => p.textContent),
		['\u00a0', 'After.'],
	);
});

test('an NBSP first line in a callout body is kept', () => {
	// "> [!NOTE]\n> \u00a0\n> Body.\n"
	const root = render(
		'<blockquote data-sourcepos="1:1-3:7">\n' +
			'<p data-sourcepos="1:3-3:7">[!NOTE]<br data-sourcepos="1:10-1:10" />\n' +
			'\u00a0<br data-sourcepos="2:5-2:5" />\nBody.</p>\n</blockquote>\n',
	);

	const body = root.querySelector('.markdown-alert-content');
	assert.ok(body, 'the blockquote became a callout');
	assert.match(body.textContent ?? '', /^\s*\u00a0/);
	assert.ok(body.querySelector('br'), 'the NBSP line keeps its break');
});

test('the empty paragraph the callout marker leaves is still removed', () => {
	// "> [!NOTE]\n>\n> Body.\n" puts an ordinary blank line under the marker.
	const root = render(
		'<blockquote data-sourcepos="1:1-3:7">\n' +
			'<p data-sourcepos="1:3-1:9">[!NOTE]</p>\n' +
			'<p data-sourcepos="3:3-3:7">Body.</p>\n</blockquote>\n',
	);

	const body = root.querySelector('.markdown-alert-content');
	assert.ok(body, 'the blockquote became a callout');
	assert.deepEqual(
		Array.from(body.querySelectorAll('p'), (p) => p.textContent),
		['Body.'],
	);
});

test('NBSP indentation at the start of a task item is kept', () => {
	// "- [ ] \u00a0\u00a0indented\n"
	const root = render(
		'<ul class="contains-task-list" data-sourcepos="1:1-1:18">\n' +
			'<li data-sourcepos="1:1-1:18"><input type="checkbox" data-task-checkbox="" ' +
			'class="task-list-item-checkbox" disabled="" /> \u00a0\u00a0indented</li>\n</ul>\n',
	);

	assert.equal(root.querySelector('.task-text')?.textContent, '\u00a0\u00a0indented');
});
