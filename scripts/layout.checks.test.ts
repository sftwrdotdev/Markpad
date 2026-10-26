import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { readSource } from './sourceTree.js';

describe('split pane ratio', () => {
	test('the bounds are not re-stated here', () => {
		// `TabManager.setSplitRatio` clamps. A second copy of 0.1/0.9 in this
		// module would be the shape where the two answers drift apart. The drag
		// against the store's bounds is run in layout.spec.ts; an identical copy is
		// only visible in the text (lint-candidate).
		const source = readSource(new URL('../src/lib/utils/splitPanes.ts', import.meta.url));
		assert.equal(/Math\.(min|max)/.test(source), false);
	});

	test('no splitter route spells the direction itself', () => {
		// The routes' agreement is layout.test.ts "both splitter routes take the
		// direction from the same place". This is the absence of a third copy.
		const viewer = readSource(new URL('../src/lib/MarkdownViewer.svelte', import.meta.url));
		assert.equal(/splitEditorSide === 'left' \? /.test(viewer), false);
	});

});

describe('fold layout', () => {
	// The direction the previous spelling could not state. `observeFoldLayout` used
	// to be handed `markdownBody`, and that was right while the article held one
	// document; it now holds one `.markdown-blocks` host per open tab, all but one
	// of them `display: none`. `updateFoldHeights` walks its root, measures each
	// wrapper with `getBoundingClientRect().height` — 0 for everything in a hidden
	// subtree — and writes what it measured into `--fold-content-height`, which
	// styles.css resolves to the wrapper's `height`. A walk rooted at the article
	// therefore collapses every fold of every background tab, and the reader sees
	// it a frame after switching back, because `scheduleUpdate` defers through
	// `requestAnimationFrame` and that runs in the step AFTER the ResizeObserver
	// delivery that would correct it.
	//
	// This cannot be a behaviour test: jsdom has no layout, so every rect is 0
	// whether or not the element is displayed, and the visible and the hidden case
	// are indistinguishable to it. The proposition is an absence — "nothing ever
	// measures from the article" — so it is pinned as one.
	test('fold measurement is rooted at the visible host, never at the article holding every tab', () => {
		const viewer = readSource('src/lib/MarkdownViewer.svelte');

		assert.doesNotMatch(
			viewer,
			/(?:observeFoldLayout\(|followFoldLayout\(\s*\w+\s*,\s*\(\)\s*=>)\s*markdownBody/,
			'observing the article would measure every hidden tab and write zero heights into it',
		);
	});
});

/**
 * #169: the outline highlights the heading you are reading, but only ever
 * answered to the PREVIEW.
 *
 * `Toc.svelte` decided by rendered box — `querySelector` each visible entry
 * out of the preview and measure it against the container, per entry, per
 * scroll event. That question has no answer while the editor is the pane being
 * scrolled: in editor-only mode the preview never scrolls, and in split view
 * it moves only while scroll sync is on. So the outline sat still exactly
 * where the reporter said it did.
 *
 * A SOURCE LINE is something both panes can produce — the editor sends one on
 * every scroll, and the preview already computes one for the tab's reading
 * position — so the rule is now one comparison over a list, fed by either.
 * That the two panes share it is the property worth having: in split view with
 * sync on both are live at once, and two rules could disagree as the panes
 * settle and flicker the highlight between two entries.
 */
describe('outline follows the editor', () => {
	const settingsSource = readSource(new URL('../src/lib/stores/settings.svelte.ts', import.meta.url));
	const settingsComponentSource = readSource(new URL('../src/lib/components/Settings.svelte', import.meta.url));

	test('there is no preference for it, because the preview never had one', () => {
		// The outline has always followed the preview unconditionally. This is the
		// same feature answering for the other pane, so a switch would have made
		// half of one behaviour optional and left the reader to work out which half.
		assert.doesNotMatch(settingsSource, /tocFollowsEditor/);
		assert.doesNotMatch(settingsComponentSource, /tocFollowsEditor/);
	});
});
