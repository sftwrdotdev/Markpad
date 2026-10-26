import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { FOLD_TRANSITION_MS } from '../src/lib/utils/foldLayout.js';
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

	test('fold wrapper animates an explicit measured height instead of a fractional grid track', () => {
		const styles = readSource('src/styles.css');
		const expandedRule = styles.match(/\.foldable-content-wrapper\s*\{([^}]*)\}/)?.[1] || '';

		assert.match(expandedRule, /height:\s*var\(--fold-content-height/);
		assert.doesNotMatch(expandedRule, /grid-template-rows:\s*1fr/);
		assert.match(styles, /foldable-content-wrapper\.is-collapsed[\s\S]*height:\s*0/);
	});

	// This assertion couples a TypeScript constant to a CSS duration in another file. Nothing else compares the two, and when
	// FindBar's re-aim timer fires before the height transition settles the scroll
	// lands on a target that is still moving — a defect that only shows up as "find
	// sometimes scrolls to the wrong place".
	test('the find-bar fold re-aim delay outlasts the CSS fold transition', () => {
		const styles = readSource('src/styles.css');

		const expandedRule = styles.match(/\.foldable-content-wrapper\s*\{([^}]*)\}/)?.[1] || '';
		const transition = expandedRule.match(/transition:[^;]*?height\s+([\d.]+)s/);
		assert.ok(transition, 'styles.css must animate the fold wrapper height');

		assert.ok(
			FOLD_TRANSITION_MS >= Number(transition[1]) * 1000,
			`FOLD_TRANSITION_MS (${FOLD_TRANSITION_MS}ms) must outlast the ${transition[1]}s height transition`,
		);
	});

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
