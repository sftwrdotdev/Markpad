import assert from 'node:assert/strict';
import { describe, test } from 'vitest';

import { findMatches, markMatches } from '../src/lib/utils/findText.js';
import { FrontMatterFieldState } from '../src/lib/utils/frontMatterFieldState.svelte.js';
import type { FrontMatterField } from '../src/lib/utils/frontMatter.js';

// #982: find in the preview matches the text as drawn, the way Chromium's own
// find was measured to: across inline elements, never across a visible line
// break or into the next block, and literally inside `<pre>`.
describe('find in preview text', () => {
	const plain = { caseSensitive: false, wholeWord: false };

	function search(html: string, query: string, options = plain, limit = 100) {
		document.body.innerHTML = `<style>.soft-breaks br.softbreak { display: none; }</style><div id="root">${html}</div>`;
		const root = document.getElementById('root') as HTMLElement;
		const result = findMatches(root, query, options, () => false, limit);
		markMatches(result.matches, 'hit');
		const marks = [...root.querySelectorAll<HTMLElement>('mark.hit')].map((m) => [m.dataset.findMatch, m.textContent]);
		return { count: result.matches.length, truncated: result.truncated, marks, text: root.textContent };
	}

	test('a match runs across inline formatting, one mark per text node', () => {
		const run = search('<p>alpha <strong>beta</strong> gamma</p>', 'alpha beta');
		assert.equal(run.count, 1);
		assert.deepEqual(run.marks, [['0', 'alpha '], ['0', 'beta']]);
		assert.equal(run.text, 'alpha beta gamma');
	});

	test('a soft break the preview hides is a space', () => {
		const run = search('<div class="soft-breaks"><p>one<br class="softbreak">\ntwo</p></div>', 'one two');
		assert.equal(run.count, 1);
		assert.deepEqual(run.marks, [['0', 'one'], ['0', '\ntwo']]);
	});

	test('a visible line break is not a space', () => {
		assert.equal(search('<p>one<br class="softbreak">\ntwo</p>', 'one two').count, 0);
		assert.equal(search('<p>one<br>\ntwo</p>', 'one two').count, 0);
	});

	test('no match crosses into the next block', () => {
		assert.equal(search('<p>zeta</p><p>eta</p>', 'zeta eta').count, 0);
		assert.equal(search('<ul><li>one</li><li>two</li></ul>', 'one two').count, 0);
	});

	test('whitespace collapses outside pre and is literal inside it', () => {
		assert.equal(search('<p>a\n   b</p>', 'a b').count, 1);
		assert.equal(search('<pre>iota  kappa</pre>', 'iota kappa').count, 0);
		assert.equal(search('<pre><code><span>iota</span>  kappa</code></pre>', 'iota  kappa').count, 1);
	});

	test('a mark covers the characters that matched, wherever whitespace collapsed', () => {
		// The drawn text and the offsets back into each node are worked out by two
		// separate passes; if they ever disagree, the highlight lands on the wrong
		// characters while the count stays right.
		assert.deepEqual(search('<p>one  two   three</p>', 'three').marks, [['0', 'three']]);
		assert.deepEqual(search('<p>a\n   b</p>', 'b').marks, [['0', 'b']]);
		assert.deepEqual(search('<p>a\n   b</p>', 'a b').marks, [['0', 'a\n   b']]);
		// The leading space of ` y` is dropped, the line already ending in one.
		assert.deepEqual(search('<p>x <em> y</em></p>', 'y').marks, [['0', 'y']]);
		assert.deepEqual(search('<p>x <em> y</em></p>', 'x y').marks, [['0', 'x '], ['0', 'y']]);
		assert.deepEqual(search('<p>a<br>\n  b c</p>', 'b c').marks, [['0', 'b c']]);
	});

	test('several matches in one node are all marked, the text intact', () => {
		const run = search('<p>one one <em>one</em></p>', 'one');
		assert.equal(run.count, 3);
		assert.deepEqual(run.marks, [['0', 'one'], ['1', 'one'], ['2', 'one']]);
		assert.equal(run.text, 'one one one');
	});

	test('case and whole-word options still apply', () => {
		assert.equal(search('<p>Alpha alpha</p>', 'alpha', { caseSensitive: true, wholeWord: false }).count, 1);
		assert.equal(search('<p>cat catalog</p>', 'cat', { caseSensitive: false, wholeWord: true }).count, 1);
	});

	test('the limit stops the search and says so', () => {
		const run = search('<p>a a a a</p>', 'a', plain, 2);
		assert.equal(run.count, 2);
		assert.equal(run.truncated, true);
	});
});

// The panel keeps its per-field state side by side, and every table has to be
// keyed by document *and* field. The error table was once keyed by the bare
// field name, so a `date` error raised in one document stayed on screen under
// `date` after switching to another document.
describe('front matter field state scope', () => {
	const date: FrontMatterField = { key: 'date', value: '', kind: 'string', displayValue: '', editable: true };
	const tags: FrontMatterField = { key: 'tags', value: [], kind: 'list', displayValue: '', editable: true };

	function twoDocuments() {
		let doc = '/a.md';
		const state = new FrontMatterFieldState(() => doc);
		return { state, open: (path: string) => (doc = path) };
	}

	test('the front-matter error table is never keyed by a bare field name', () => {
		const { state, open } = twoDocuments();
		state.setEditError(date, new Error('bad date'));
		assert.equal(state.editError(date), 'Error: bad date');

		open('/b.md');
		assert.equal(state.editError(date), undefined, "one document's error must not show in another");
		state.clearEditError(date);

		open('/a.md');
		assert.equal(state.editError(date), 'Error: bad date', "clearing it elsewhere must not clear this document's");
	});

	test('all five per-field front-matter tables agree on their key', () => {
		const { state, open } = twoDocuments();
		state.setTagDraft(tags, 'draft-a');
		state.startTagEdit(tags, 2, 'edit-a');

		open('/b.md');
		assert.equal(state.tagDraft(tags), '');
		assert.equal(state.tagEditIndex(tags), null);
		assert.equal(state.tagEditDraft(tags, 'fallback'), 'fallback');
		state.setTagDraft(tags, 'draft-b');
		state.clearTagEdit(tags);

		open('/a.md');
		assert.equal(state.tagDraft(tags), 'draft-a');
		assert.equal(state.tagEditIndex(tags), 2);
		assert.equal(state.tagEditDraft(tags, 'fallback'), 'edit-a');
	});
});
