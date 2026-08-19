import assert from 'node:assert/strict';
import test from 'node:test';

import { readSource } from './sourceTree.js';

// #681: inline code in a heading rendered small and floating above the words
// around it. Two independent causes, one in each stylesheet, and neither is
// reachable by a test that runs code — this is CSS the browser resolves.

const styles = readSource('src/styles.css');
const viewer = readSource('src/lib/MarkdownViewer.svelte');

test('a heading stands its content on the text baseline', () => {
	// The heading is a flex container so the fold chevron can sit beside the
	// text, which makes every element inside it a flex item. `flex-start` pinned
	// each one to the top of the line — the smaller the element, the higher it
	// floated. Measured on `## Heading \x60code\x60 Test`: the code chip's bottom sat
	// 8px above the heading text's, and 2px below it after.
	const rule = styles.match(/\.foldable-header \{[^}]*\}/);
	assert.ok(rule, 'styles.css must still define .foldable-header');
	assert.match(rule[0], /align-items:\s*baseline;/);
	assert.doesNotMatch(rule[0], /align-items:\s*flex-start;/);
});

test('inline code in a heading scales with the heading', () => {
	// The Code Font Size setting is an absolute px — right for code in prose,
	// wrong for code in a heading, where 14px inside a 24px `##` reads as a
	// footnote. GitHub sizes inline code relative to what contains it.
	assert.match(
		viewer,
		/:global\(\.markdown-body :is\(h1, h2, h3, h4, h5, h6\) code\) \{\s*\n\s*font-size: 0\.85em !important;/,
	);
});

test('the setting still governs code everywhere else', () => {
	// The fix is scoped to headings; body text and code blocks keep answering to
	// `--code-font-size`, which is what the setting promises.
	assert.match(viewer, /:global\(\.markdown-body code\) \{[\s\S]*?font-size: var\(--code-font-size, 14px\) !important;/);
});
