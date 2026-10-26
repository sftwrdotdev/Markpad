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
	test('the outline takes no document string', () => {
		// The revision itself is layout.spec.ts "the revision is published by the
		// patch, not by the render". This is the absence of the old signal.
		const toc = readSource('src/lib/components/Toc.svelte');
		expect(/htmlContent/.test(toc.split('It used to be')[0])).toBe(false);
	});

});
