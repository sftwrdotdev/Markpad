import assert from 'node:assert/strict';
import test from 'node:test';

import { outwardSign, planPaneSlide } from '../src/lib/utils/paneSlide.js';

const preview = { editor: false, viewer: true };
const edit = { editor: true, viewer: false };
const split = { editor: true, viewer: true };

test('each view mode switch names the pane that comes and the one that goes', () => {
	assert.deepEqual(planPaneSlide(preview, split), { entering: 'editor', leaving: null });
	assert.deepEqual(planPaneSlide(split, preview), { entering: null, leaving: 'editor' });
	assert.deepEqual(planPaneSlide(edit, split), { entering: 'viewer', leaving: null });
	assert.deepEqual(planPaneSlide(split, edit), { entering: null, leaving: 'viewer' });
	assert.deepEqual(planPaneSlide(preview, edit), { entering: 'editor', leaving: 'viewer' });
	assert.deepEqual(planPaneSlide(edit, preview), { entering: 'viewer', leaving: 'editor' });
});

test('the same panes on screen is no slide', () => {
	for (const mode of [preview, edit, split]) assert.equal(planPaneSlide(mode, mode), null);
});

test('a pane slides from its own outer edge, whichever side the editor is on', () => {
	assert.equal(outwardSign('editor', false), -1);
	assert.equal(outwardSign('viewer', false), 1);
	assert.equal(outwardSign('editor', true), 1);
	assert.equal(outwardSign('viewer', true), -1);
});
