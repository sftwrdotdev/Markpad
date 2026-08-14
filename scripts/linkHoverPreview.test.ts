import assert from 'node:assert/strict';
import test from 'node:test';

import { functionSource, offsetOf, readSource } from './sourceTree.js';

/*
 * The box that names a link while the cursor is on it had two faults, both
 * reported from a build.
 *
 * It said `tauri://localhost/3.md` for `[3.md](./3.md)`. That is the DOM
 * resolving `href` against the webview's own origin — the same resolution
 * `resolveLocalFileLinkPath` exists to undo on the click side, and the same
 * origin `localFileLinks.test.ts` documents. `handleMouseOver` had already
 * read `getAttribute('href')` into `rawHref` for its other two branches; the
 * one that prints the address was the one that did not use it.
 *
 * And it stayed on screen after the click. `mouseout` is the only thing that
 * takes it down, and a click that replaces the document removes the anchor
 * while the cursor is still on it — removing a node dispatches no `mouseout`,
 * so nothing ever fired.
 *
 * Neither half has a seam a Node test can reach: both are branches inside a
 * 4,700-line component, and what they do is set component state. So these
 * assert against the source, and what they establish is narrow — that the
 * resolved href is not read where the address is printed, and that the click
 * handler drops the box before it does anything else. Whether the box is then
 * painted or not is checked by hand.
 */

const viewer = readSource('src/lib/MarkdownViewer.svelte');

test('the hover preview never prints the webview origin', () => {
	const hover = functionSource(viewer, 'handleMouseOver');

	// Stated as the thing that must not come back rather than as today's
	// spelling of what replaced it: the resolved property is what put a
	// `tauri://` URL in front of the user, so this function may not read it.
	//
	// The whole function, comments included — deliberately. The first version of
	// this test went red on the comment explaining the fix, and that is the rule
	// working: a comment naming the property is how the next person is talked
	// into writing it again. Describe it, do not spell it.
	assert.doesNotMatch(
		hover,
		/anchor\.href/,
		'the hover preview reads the resolved href, which is the webview origin plus a path that is not the file',
	);
	assert.match(hover, /getAttribute\('href'\)/);
});

test('a click takes the hover preview down before it does anything else', () => {
	const click = functionSource(viewer, 'handleLinkClick');

	// Before the branches, because every one of them can be the one that
	// replaces the document — a fold, an anchor, a relative link, a new tab.
	const hide = offsetOf(click, 'tooltip.show = false');
	const firstBranch = offsetOf(click, 'toggleFoldFromClick');

	assert.ok(hide >= 0, 'the click handler never drops the hover preview');
	assert.ok(
		hide < firstBranch,
		'the hover preview is dropped after a branch that can already have replaced the document',
	);
});
