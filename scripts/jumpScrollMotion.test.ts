import assert from 'node:assert/strict';
import test from 'node:test';

import { animatesJumpScroll, jumpScrollBehavior } from '../src/lib/utils/motion.js';

/*
 * Issue #199: a long jump — a heading from the table of contents, the next find
 * match — animates its scroll, and on a dark theme that reads as a flash of
 * content. The reporter switched to a light theme to work around it.
 *
 * The decision is one predicate because it was seven literals: four
 * `behavior: 'smooth'` in `MarkdownViewer`, two in `FindBar`, and Monaco's
 * `smoothScrolling` in the editor options. A preference that reached six of
 * them and missed the seventh is the failure this repo keeps meeting.
 */

test('the preference turns the animation off', () => {
	assert.equal(animatesJumpScroll(true, false), true);
	assert.equal(animatesJumpScroll(false, false), false);
});

test('the system asking for less motion is enough on its own', () => {
	// Not folded into the setting's default, which would be a copy going stale
	// the moment the OS preference changed. Either voice is enough — the way
	// `@media (prefers-reduced-motion: reduce)` is defined.
	assert.equal(animatesJumpScroll(true, true), false);
	assert.equal(animatesJumpScroll(false, true), false);
});

test('the scroll behaviour follows the same answer', () => {
	// One decision reaching `scrollTo`, `scrollIntoView` and Monaco's boolean,
	// rather than each call site spelling the ternary.
	assert.equal(jumpScrollBehavior(true, false), 'smooth');
	assert.equal(jumpScrollBehavior(false, false), 'auto');
	assert.equal(jumpScrollBehavior(true, true), 'auto');
});
