import assert from 'node:assert/strict';
import test from 'node:test';

import { opensInNewTab } from '../src/lib/utils/shortcuts.js';

/*
 * Issue #661: with `1.md` and `2.md` both open, clicking a link in `1.md` that
 * points at `2.md` navigated the `1.md` tab onto that file — and the `2.md` tab
 * disappeared.
 *
 * The disappearance is `TabManager.claimPath` holding its one-tab-per-path
 * invariant, which is deliberate and documented: the losing tab was clean, so
 * it is a copy of the file the winner now holds, and it goes on the
 * reopen-closed-tab stack. The gap is upstream of it — `addTab` already
 * resolves an open request to the tab that has the file ("VS Code and Sublime
 * Text both resolve an open request to the existing view"), and the relative
 * link was the one entry point that did not go through it.
 *
 * `opensInNewTab` is the whole decision this change adds, so these run the real
 * code. Which function the click handler then calls is asserted by hand against
 * a build; there is no seam in the component for a test to reach.
 */

const CLICK = { metaKey: false, ctrlKey: false };
const CMD = { metaKey: true, ctrlKey: false };
const CTRL = { metaKey: false, ctrlKey: true };

test('the chord is the one the platform uses everywhere else', () => {
	// ⌘ on macOS. Ctrl there is the secondary click, so reading it would answer
	// one gesture with a context menu and a new tab at once.
	assert.equal(opensInNewTab('macos', CMD, false), true);
	assert.equal(opensInNewTab('macos', CTRL, false), false);

	// Ctrl elsewhere. Meta is the Super key and belongs to the window manager.
	for (const platform of ['windows', 'linux']) {
		assert.equal(opensInNewTab(platform, CTRL, false), true);
		assert.equal(opensInNewTab(platform, CMD, false), false);
	}
});

test('an os type that has not resolved yet still answers', () => {
	// `settings.osType` is `'unknown'` until the Tauri call returns, and a click
	// can land in that window. `modifierFor` sends everything that is not macOS
	// down the Ctrl branch, and this follows it rather than deciding again.
	assert.equal(opensInNewTab('unknown', CTRL, false), true);
	assert.equal(opensInNewTab('unknown', CMD, false), false);
});

test('the chord means the other one, not new tab', () => {
	// With the preference on, a plain click opens the tab and the chord is how
	// you navigate in place — which is the only thing that writes a tab's file
	// history, so the Back and Forward buttons stay reachable either way.
	assert.equal(opensInNewTab('macos', CLICK, true), true);
	assert.equal(opensInNewTab('macos', CMD, true), false);
	assert.equal(opensInNewTab('windows', CLICK, true), true);
	assert.equal(opensInNewTab('windows', CTRL, true), false);
});

test('a plain click keeps navigating this tab by default', () => {
	// The default this ships with: nothing about an existing install changes
	// until someone turns the preference on.
	assert.equal(opensInNewTab('macos', CLICK, false), false);
	assert.equal(opensInNewTab('windows', CLICK, false), false);
});
