import assert from 'node:assert/strict';
import test from 'node:test';

import { readSource } from './sourceTree.js';

test('fold layout observes rendered content and publishes its measured height', () => {
	const source = readSource('src/lib/utils/foldLayout.ts');

	assert.match(source, /new ResizeObserver/);
	assert.match(source, /--fold-content-height/);
	assert.match(source, /requestAnimationFrame/);
});

test('fold wrapper animates an explicit measured height instead of a fractional grid track', () => {
	const styles = readSource('src/styles.css');
	const expandedRule = styles.match(/\.foldable-content-wrapper\s*\{([^}]*)\}/)?.[1] || '';

	assert.match(expandedRule, /height:\s*var\(--fold-content-height/);
	assert.doesNotMatch(expandedRule, /grid-template-rows:\s*1fr/);
	assert.match(styles, /foldable-content-wrapper\.is-collapsed[\s\S]*height:\s*0/);
});

// Salvaged from `findCollapsedMatches.test.ts`, which was deleted for asserting
// the spelling of FindBar.svelte (it stayed green with `revealFoldsAround` made
// a no-op). This assertion is a different kind: it couples a TypeScript constant
// to a CSS duration in another file. Nothing else compares the two, and when
// FindBar's re-aim timer fires before the height transition settles the scroll
// lands on a target that is still moving — a defect that only shows up as "find
// sometimes scrolls to the wrong place".
test('the find-bar fold re-aim delay outlasts the CSS fold transition', () => {
	const findBar = readSource('src/lib/components/FindBar.svelte');
	const styles = readSource('src/styles.css');

	const declared = findBar.match(/const FOLD_TRANSITION_MS = (\d+);/);
	assert.ok(declared, 'FindBar.svelte must declare the delay it waits for the fold to settle');

	const expandedRule = styles.match(/\.foldable-content-wrapper\s*\{([^}]*)\}/)?.[1] || '';
	const transition = expandedRule.match(/transition:[^;]*?height\s+([\d.]+)s/);
	assert.ok(transition, 'styles.css must animate the fold wrapper height');

	assert.ok(
		Number(declared[1]) >= Number(transition[1]) * 1000,
		`FOLD_TRANSITION_MS (${declared[1]}ms) must outlast the ${transition[1]}s height transition`,
	);
});

test('preview lifecycle starts and cleans up fold observation', () => {
	const viewer = readSource('src/lib/MarkdownViewer.svelte');

	assert.match(viewer, /observeFoldLayout\((?:markdownBody|body)\)/);
	assert.match(viewer, /observation\.stop\(\)/);
});

test('fold measurement pauses while the preview pane is hidden by edit mode', () => {
	const viewer = readSource('src/lib/MarkdownViewer.svelte');

	assert.match(viewer, /if \(!body \|\| \(isEditing && !isSplit\)\) return;/);
});

// The observation used to be torn down and rebuilt on every render, which is
// how a document's every fold came to re-measure once per character:
// `ResizeObserver.observe` re-registers a target it is already watching, and a
// registration delivers an initial observation. What replaced it is a live
// observation plus `observe` calls for the blocks the patch inserted, so the
// two halves of that have to stay coupled — a viewer that re-observes the whole
// host, or a `foldLayout.ts` that only observes from a root, puts the cost back
// without changing a single assertion above.
test('only newly patched blocks are handed to the fold observer', () => {
	const viewer = readSource('src/lib/MarkdownViewer.svelte');
	const foldLayout = readSource('src/lib/utils/foldLayout.ts');

	assert.match(
		viewer,
		/for \(const \w+ of patch\.inserted\) foldLayout\?\.observe\(\w+\)/,
		'the viewer must observe the patched blocks, not the whole preview',
	);
	assert.doesNotMatch(
		viewer,
		/foldLayout\?\.observe\(host\)/,
		're-observing the host re-registers every fold in the document',
	);
	assert.match(
		foldLayout,
		/observe\(scope: Element\)/,
		'observeFoldLayout must accept a scope smaller than the article',
	);
});
