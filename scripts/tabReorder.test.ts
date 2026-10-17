import assert from 'node:assert/strict';
import test from 'node:test';

import { closestSlotIndex, dragDistance } from '../src/lib/utils/tabReorder.js';

// Three 100x30 tabs, laid out across the strip and then down the column (#884).
const row = [0, 1, 2].map((i) => ({ left: i * 104, top: 0, width: 100, height: 30 }));
const column = [0, 1, 2].map((i) => ({ left: 0, top: i * 32, width: 180, height: 30 }));

test('the strip picks the slot nearest the pointer horizontally', () => {
	assert.equal(closestSlotIndex(row, { x: 10, y: 500 }, 'x'), 0);
	assert.equal(closestSlotIndex(row, { x: 160, y: 500 }, 'x'), 1);
	assert.equal(closestSlotIndex(row, { x: 999, y: 0 }, 'x'), 2);
});

test('the column picks the slot nearest the pointer vertically, whatever its x', () => {
	assert.equal(closestSlotIndex(column, { x: 500, y: 5 }, 'y'), 0);
	assert.equal(closestSlotIndex(column, { x: -40, y: 40 }, 'y'), 1);
	assert.equal(closestSlotIndex(column, { x: 90, y: 400 }, 'y'), 2);
});

test('non-tab children are skipped and an empty list has no slot', () => {
	assert.equal(closestSlotIndex([null, column[1], null], { x: 0, y: 0 }, 'y'), 1);
	assert.equal(closestSlotIndex([], { x: 0, y: 0 }, 'x'), -1);
});

test('a drag starts on travel along the layout axis only', () => {
	const start = { x: 100, y: 100 };
	assert.equal(dragDistance(start, { x: 108, y: 100 }, 'x'), 8);
	assert.equal(dragDistance(start, { x: 108, y: 100 }, 'y'), 0);
	assert.equal(dragDistance(start, { x: 100, y: 93 }, 'y'), 7);
});
