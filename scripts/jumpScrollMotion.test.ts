import assert from 'node:assert/strict';
import test from 'node:test';

import { jumpScrollBehavior } from '../src/lib/utils/motion.js';

/*
 * Issue #199: a long jump — a heading from the table of contents, the next find
 * match — animates its scroll, and on a dark theme that reads as a flash of
 * content. The reporter switched to a light theme to work around it.
 */

test('the setting alone decides whether a jump animates', () => {
	// No second argument for the system's reduce-motion preference: Markpad runs
	// on three systems that do not all have one, and a switch the user can see
	// must not be overruled by one they cannot.
	assert.equal(jumpScrollBehavior.length, 1);
	assert.equal(jumpScrollBehavior(true), 'smooth');
	assert.equal(jumpScrollBehavior(false), 'auto');
});
