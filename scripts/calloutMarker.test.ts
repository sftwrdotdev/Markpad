import assert from 'node:assert/strict';
import test from 'node:test';

import { installShimDom, parseHtml } from './renderProtocolDom.ts';

installShimDom();

const { processMarkdownHtml } = await import('../src/lib/utils/markdown.ts');

// Only the text a quote opens with can make it a callout, as in Obsidian and
// GitHub. The marker used to be looked for in every text node of the quote, so
// a `[!note]` shown in inline code, a code block or a nested quote turned the
// whole quote into a callout and the matched text was deleted.

function render(html: string) {
	return parseHtml(processMarkdownHtml(html, '/doc.md', new Set()));
}

test('a marker in inline code is text, not a callout', () => {
	const root = render('<blockquote>\n<p>Use <code>[!note]</code> to make a callout</p>\n</blockquote>');
	assert.equal(root.querySelector('.markdown-alert'), null);
	assert.equal(root.querySelector('code')?.textContent, '[!note]');
});

test('a marker at the top of a code block is text, not a callout', () => {
	const root = render('<blockquote>\n<pre><code>[!warning] Title\n</code></pre>\n</blockquote>');
	assert.equal(root.querySelector('.markdown-alert'), null);
	assert.equal(root.querySelector('code')?.textContent, '[!warning] Title\n');
});

test('a callout in a nested quote leaves the outer quote alone', () => {
	const root = render(
		'<blockquote>\n<p>Outer</p>\n<blockquote>\n<p>[!tip] Inner</p>\n</blockquote>\n</blockquote>',
	);
	const outer = root.querySelector('blockquote');
	assert.ok(outer, 'the outer quote is still a quote');
	assert.equal(outer.querySelector('p')?.textContent, 'Outer');
	const tip = outer.querySelector('.markdown-alert-tip');
	assert.ok(tip, 'the inner quote is the callout');
	assert.equal(tip.querySelector('.callout-title-inner')?.textContent, 'Inner');
});

test('a quote that opens with the marker is still a callout, fold and title included', () => {
	const root = render('<blockquote>\n<p>[!note]+ My title<br />\nbody</p>\n</blockquote>');
	const callout = root.querySelector('.markdown-alert-note');
	assert.ok(callout);
	assert.ok(callout.classList.contains('callout-foldable'));
	assert.equal(callout.querySelector('.callout-title-inner')?.textContent, 'My title');
	assert.match(callout.querySelector('.content-inner')?.textContent ?? '', /body/);
});
