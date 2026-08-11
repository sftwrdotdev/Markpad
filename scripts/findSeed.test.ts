import assert from 'node:assert/strict';
import test from 'node:test';

import { findSeedFromSelection } from '../src/lib/utils/findSeed.js';
import { readSource } from './sourceTree.js';

/** A `Selection` as far as `findSeedFromSelection` is concerned. */
function selecting(text: string, where: 'preview' | 'elsewhere' | 'caret' = 'preview') {
	const node = where === 'elsewhere' ? 'outside' : 'inside';
	return { isCollapsed: where === 'caret', anchorNode: node, focusNode: node, toString: () => text } as unknown as Selection;
}

/** The rendered document. `contains` is the only question the seed asks of it. */
const preview = { contains: (node: unknown) => node === 'inside' } as unknown as Node;

test('what Cmd/Ctrl+F starts from, given what is selected', () => {
	const seed = (s: Selection | null, root: Node | null = preview) => findSeedFromSelection(s, root);

	assert.equal(seed(selecting('deterministic')), 'deterministic');
	// Across `**bold**`, a link or inline code the selection spans several text
	// nodes; reading only one would leave the feature off in the commonest case.
	assert.equal(seed(selecting('bold word')), 'bold word');
	assert.equal(seed(selecting('  spaced  ')), 'spaced', 'a double-click drags the trailing space in');

	// Empty means "leave the box alone" — a repeated Cmd/Ctrl+F re-focuses the
	// previous query (#559) rather than wiping it.
	assert.equal(seed(selecting('first\nsecond')), '', 'multi-line: Monaco’s rule in the other pane');
	assert.equal(seed(selecting('   ')), '', 'whitespace only');
	assert.equal(seed(selecting('x', 'caret')), '', 'a caret with nothing selected');
	assert.equal(seed(selecting('x', 'elsewhere')), '', 'selected in a modal or the tab strip');
	assert.equal(seed(null), '', 'no selection');
	assert.equal(seed(selecting('x'), null), '', 'no preview on screen');
});

test('the seed is wired to the find bar', () => {
	// One line the compiler cannot check: a pure function nothing calls is dead code.
	assert.match(readSource('src/lib/MarkdownViewer.svelte'), /if \(seed\) findBar\?\.setQuery\(seed\);/);
});
