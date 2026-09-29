import assert from 'node:assert/strict';
import test from 'node:test';

import { functionSource, readSource } from './sourceTree.js';

test('an outline click is a jump, so it asks the same preference', () => {
	// #199 was reported against the table of contents, and `Toc.svelte` was the
	// one jump the preference never reached: its `scrollTo` kept a literal
	// `'smooth'`. `.svelte` files cannot run under `node --test`, so the anchor
	// is the jump function's text: no second copy of the answer in it.
	const jumpTo = functionSource(readSource('src/lib/components/Toc.svelte'), 'jumpTo');
	assert.doesNotMatch(jumpTo, /'smooth'/);
	assert.match(jumpTo, /jumpScrollBehavior\(/);
});
