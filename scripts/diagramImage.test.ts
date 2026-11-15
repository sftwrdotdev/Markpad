import { test } from 'node:test';
import assert from 'node:assert/strict';
import { diagramPngSize } from '../src/lib/utils/diagramImage.ts';

// #1085: copied diagrams are drawn at twice their size, so a paste stays sharp,
// but a huge diagram is capped so the canvas does not fail.
test('a copied diagram is twice its size, capped at 8192 on the long side', () => {
	assert.deepEqual(diagramPngSize(300, 120.4), { width: 600, height: 241 });
	assert.deepEqual(diagramPngSize(10000, 2500), { width: 8192, height: 2048 });
	assert.deepEqual(diagramPngSize(0, 0), { width: 1, height: 1 });
});
