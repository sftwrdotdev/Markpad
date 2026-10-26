import assert from 'node:assert/strict';

import { describe, expect, test } from 'vitest';

import Toc from '../src/lib/components/Toc.svelte';
import { readSource } from './sourceTree.js';

describe('split scroll-sync preference', () => {
	test('the tab store keeps no localStorage of its own', () => {
		// Both halves: the bare `setItem` the convention rule now forbids outright,
		// and the constructor's `getItem`, which is the load path that has to move
		// with it or the two would drift.
		const tabsSource = readSource('src/lib/stores/tabs.svelte.ts');
		assert.doesNotMatch(tabsSource, /localStorage\.(?:get|set)Item\s*\(/);
	});
});

describe('outline render signal', () => {
	test('the revision is published by the patch, not by the render', () => {
		// The guard on the fix: a signal derived from the rendered string rather
		// than from the write to the DOM is the bug, spelled differently.
		const viewer = readSource('src/lib/MarkdownViewer.svelte');

		const patchEffect = viewer.slice(viewer.indexOf('patchHost(\n\t\t\thost,'));
		const bump = patchEffect.indexOf('previewRevision = ++previewPatches;');
		expect(bump).toBeGreaterThan(-1);
		expect(bump).toBeLessThan(patchEffect.indexOf('\n\t});'));

		// And the outline no longer receives the document string it never read.
		const toc = readSource('src/lib/components/Toc.svelte');
		expect(/htmlContent/.test(toc.split('It used to be')[0])).toBe(false);
	});
});
