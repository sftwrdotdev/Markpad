import { describe, expect, test } from 'vitest';

import Toc from '../src/lib/components/Toc.svelte';
import { readSource } from './sourceTree.js';

describe('outline render signal', () => {
	test('the outline takes no document string', () => {
		// The revision itself is layout.spec.ts "the revision is published by the
		// patch, not by the render". This is the absence of the old signal.
		const toc = readSource('src/lib/components/Toc.svelte');
		expect(/htmlContent/.test(toc.split('It used to be')[0])).toBe(false);
	});

});
