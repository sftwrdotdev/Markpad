import assert from 'node:assert/strict';
import test from 'node:test';

import { readSource } from './sourceTree.js';

import { splitRatioAfterMove } from '../src/lib/utils/splitPanes.ts';

test('the editor grows when the bar moves away from it, whichever side it is on', () => {
	// Editor on the left: rightward travel is more editor.
	assert.equal(splitRatioAfterMove(0.5, 0.1, 'left'), 0.6);
	assert.equal(splitRatioAfterMove(0.5, -0.1, 'left'), 0.4);

	// Editor on the right: the same motion has to mean the opposite, because
	// the ratio is the editor's share and the editor is now on the far side.
	assert.equal(splitRatioAfterMove(0.5, 0.1, 'right'), 0.4);
	assert.equal(splitRatioAfterMove(0.5, -0.1, 'right'), 0.6);
});

test('the bounds are not re-stated here', () => {
	// `TabManager.setSplitRatio` clamps. A second copy of 0.1/0.9 in this
	// module would be the shape where the two answers drift apart.
	assert.equal(splitRatioAfterMove(0.9, 0.5, 'left'), 1.4);
	assert.equal(splitRatioAfterMove(0.1, -0.5, 'left'), -0.4);

	const source = readSource(new URL('../src/lib/utils/splitPanes.ts', import.meta.url));
	assert.equal(/Math\.(min|max)/.test(source), false);
});

test('both splitter routes take the direction from the same place', () => {
	// The failure this guards is a splitter that follows the pointer one way
	// and the arrow keys the other — invisible until someone swaps the panes.
	const viewer = readSource(new URL('../src/lib/MarkdownViewer.svelte', import.meta.url));

	const calls = viewer.match(/splitRatioAfterMove\(/g) ?? [];
	assert.equal(calls.length, 2, 'expected the drag and the arrow keys, and nothing else');

	// No route may reintroduce the sign itself.
	assert.equal(/splitEditorSide === 'left' \? /.test(viewer), false);
});
