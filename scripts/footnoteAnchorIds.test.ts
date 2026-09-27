import assert from 'node:assert/strict';
import test from 'node:test';

import { anchorIdCandidates } from '../src/lib/utils/markdownLinks.js';

/*
 * comrak writes the two kinds of same-document target differently. A heading
 * id is the text as-is (`id="概述"`) and the link to it is percent-encoded
 * (`href="#%E6%A6%82%E8%BF%B0"`), so the fragment has to be decoded to find
 * it. A footnote id is percent-encoded in the id itself
 * (`id="fn-%E6%B3%A8%E9%87%8A"`), so decoding the href loses it. The viewer's
 * jump and hover tooltip look up every candidate this returns.
 */

test('a CJK heading link is found by its decoded id', () => {
	assert.ok(anchorIdCandidates('%E6%A6%82%E8%BF%B0').includes('概述'));
});

test('a CJK footnote and its back-link are found by the id as written', () => {
	for (const fragment of ['fn-%E6%B3%A8%E9%87%8A', 'fnref-%E6%B3%A8%E9%87%8A']) {
		assert.ok(anchorIdCandidates(fragment).includes(fragment), fragment);
	}
});

test('a block reference drops its caret and a malformed escape is kept', () => {
	assert.deepEqual(anchorIdCandidates('^abc'), ['abc']);
	assert.deepEqual(anchorIdCandidates('50%off'), ['50%off']);
});
