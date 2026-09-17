import assert from 'node:assert/strict';
import test from 'node:test';

import { readSource } from './sourceTree.js';

// #681: inline code in a heading rendered small and floating above the words
// around it. Two independent causes, one in each stylesheet, and neither is
// reachable by a test that runs code — this is CSS the browser resolves.

const styles = readSource('src/styles.css');
const viewer = readSource('src/lib/MarkdownViewer.svelte');

test('a heading lays its content out as one line of text', () => {
	// A flex heading makes every text run, `<em>`, `<code>` and image its own
	// flex item: #681 floated inline code above the words, #791 ate the spaces
	// around `*not*` and broke it into `n`/`o`/`t` on a narrow pane. The fold
	// chevron is absolutely positioned, so inline layout costs it nothing.
	const rule = styles.match(/\.foldable-header \{[^}]*\}/);
	assert.ok(rule, 'styles.css must still define .foldable-header');
	assert.doesNotMatch(rule[0], /display:\s*(inline-)?(flex|grid)/);
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
