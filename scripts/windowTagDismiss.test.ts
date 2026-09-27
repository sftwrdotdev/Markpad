import assert from 'node:assert/strict';
import test from 'node:test';

import { COLORS, setup, settle, tabManager } from './windowTagEditor.js';

/*
 * The window-tag popover in TitleBar.svelte had no way out that did not write
 * something. `tagEditorOpen` went false in exactly two places — `applyTag`
 * (Save/Enter) and `clearTag` (Remove Tag, which only renders once a tag
 * exists) — so on a window with no tag yet, Save was the single exit. Escape
 * did nothing, a click elsewhere did nothing, and the chip re-opened rather
 * than toggled.
 *
 * The three other popovers in the same component — the Home menu, the theme
 * menu and the kebab menu — all take Escape on the container and all appear in
 * `handleGlobalDismiss`, which a `$effect` wires to window `click`,
 * `contextmenu` and `blur` while any of them is open. The tag editor was the
 * only one missing from both.
 *
 * The Save button has since gone, as in Chrome's tab-group editor: a click
 * elsewhere, the chip and Enter now commit the draft, and Escape alone
 * discards it.
 *
 * These tests RUN the real handlers rather than looking for them; see
 * windowTagEditor.ts for how the component's own functions and markup handlers
 * are lifted into one scope over the REAL `TabManager`. Nothing below asserts
 * how any of it is spelled: rewrite the dismissal any way that keeps these
 * outcomes and they stay green.
 *
 * What this does not establish: focus, CSS, or that Svelte flushes the effect
 * where `clickPath` assumes it does. It establishes what the handlers do when
 * they run.
 */

// --------------------------------------------------------------- the regression

test('Escape closes the tag editor on a window that has no tag yet', () => {
	// The reported dead end: with no tag set, `Remove Tag` is not rendered and
	// Save is the only control that closes the popover.
	const { bar } = setup();
	bar.openTagEditor();
	bar.setDraft('Research', COLORS[2]);

	bar.editorKeydown({ key: 'Escape' });

	assert.equal(bar.state().tagEditorOpen, false, 'Escape left the popover open');
	assert.equal(tabManager.windowTag, null, 'Escape wrote a tag — dismissing must not commit the draft');
});

test('a click elsewhere in the window commits the draft and closes', async () => {
	// There is no Save button, so leaving the popover is how a tag is saved.
	const { bar, clickOutside } = setup();
	bar.openTagEditor();
	bar.setDraft('Research', COLORS[2]);

	clickOutside();
	await settle();

	assert.equal(bar.state().tagEditorOpen, false, 'a click outside left the popover open');
	assert.deepEqual(tabManager.windowTag, { name: 'Research', color: COLORS[2], pinned: false }, 'a click outside dropped the draft');
});

test('a click elsewhere with a taken name keeps the popover open on the refusal', async () => {
	const { bar, clickOutside } = setup({ tagTakenElsewhere: true });
	bar.openTagEditor();
	bar.setDraft('Research', COLORS[2]);

	clickOutside();
	await settle();

	assert.equal(tabManager.windowTag, null, 'the duplicate name was written anyway');
	assert.equal(bar.state().tagEditorOpen, true, 'the popover closed, so the refusal had nowhere to appear');
	assert.notEqual(bar.state().tagError, '');
});

test('a click elsewhere on an unchanged tag asks the backend nothing', () => {
	const { bar, clickOutside, invokeCalls } = setup();
	tabManager.setWindowTag({ name: 'Docs', color: COLORS[1] });
	bar.openTagEditor();

	clickOutside();

	assert.equal(bar.state().tagEditorOpen, false);
	assert.deepEqual(invokeCalls, [], 'closing an untouched popover went to the backend');
});

test('the chip toggles the tag editor instead of only opening it', () => {
	const { bar, clickPath } = setup();
	tabManager.setWindowTag({ name: 'Docs', color: COLORS[1] });

	clickPath(bar.chipClick);
	assert.equal(bar.state().tagEditorOpen, true, 'the chip did not open the popover, or opened it into its own dismissal');

	clickPath(bar.chipClick);
	assert.equal(bar.state().tagEditorOpen, false, 'a second click on the chip left the popover open');
	assert.deepEqual(tabManager.windowTag, { name: 'Docs', color: COLORS[1], pinned: false }, 'toggling the chip changed the tag');
});

test('opening the tag editor from the Home menu survives the click that opened it', () => {
	/*
	 * The other entry point, and the one this fix could plausibly have broken.
	 * `Home > Set window tag` runs `homeMenuOpen = false; openTagEditor();` and
	 * calls no `stopPropagation` of its own, while `homeMenuOpen` being true
	 * means the window `click` listener is ALREADY installed when it runs. Now
	 * that `handleGlobalDismiss` closes the tag editor too, a click that reached
	 * the window would open the popover and shut it again in one gesture, and
	 * the user would see nothing happen.
	 *
	 * It does not reach the window: `.home-dropdown-menu` — the item's parent —
	 * carries `onclick={(e) => e.stopPropagation()}`, which is why none of the
	 * menu items need one each. That containment is load-bearing for this fix
	 * and was previously untested, so the whole path runs here: listener already
	 * installed, then the item's handler, then the container's.
	 */
	const { bar, listeners, flush, clickPath } = setup();
	bar.openHomeMenu();
	flush();
	assert.ok(listeners.get('click'), 'precondition: an open Home menu has already installed the window listener');

	clickPath(bar.homeMenuTagItemClick, bar.homeMenuClick);

	assert.equal(bar.state().homeMenuOpen, false, 'the Home menu stayed open');
	assert.equal(bar.state().tagEditorOpen, true, 'the menu item opened the tag editor into its own dismissal');
});

test('Escape discards the draft: reopening shows the stored tag', () => {
	// Escape is the one exit that discards, matching the Escape-cancels
	// convention of every popover editor. The mechanism is `openTagEditor`
	// re-seeding both draft fields.
	const { bar } = setup();
	tabManager.setWindowTag({ name: 'Docs', color: COLORS[1] });
	bar.openTagEditor();
	bar.setDraft('Docs, rewritten', COLORS[4]);

	bar.editorKeydown({ key: 'Escape' });
	assert.equal(bar.state().tagEditorOpen, false, 'Escape left the popover open');
	bar.openTagEditor();

	assert.equal(bar.state().tagDraftName, 'Docs', 'the abandoned name came back');
	assert.equal(bar.state().tagDraftColor, COLORS[1], 'the abandoned colour came back');
	assert.deepEqual(tabManager.windowTag, { name: 'Docs', color: COLORS[1], pinned: false });
});

// ------------------------------------------------------------------ the fences
//
// Each of these passes today and would also pass for a popover that simply
// closed on everything — which is what they are here to stop.

test('Enter still saves the draft', async () => {
	const { bar } = setup();
	bar.openTagEditor();
	bar.setDraft('Notes', COLORS[3]);

	bar.editorKeydown({ key: 'Enter' });
	await settle();

	assert.equal(bar.state().tagEditorOpen, false);
	assert.deepEqual(tabManager.windowTag, { name: 'Notes', color: COLORS[3], pinned: false }, 'Enter stopped committing');
});

test('typing in the name field does not close the tag editor', () => {
	const { bar } = setup();
	bar.openTagEditor();

	for (const key of ['a', 'Backspace', 'Tab', 'ArrowLeft', ' ']) {
		bar.editorKeydown({ key });
		assert.equal(bar.state().tagEditorOpen, true, `\`${key}\` closed the popover`);
	}
});

test('clicks inside the tag editor do not dismiss it', () => {
	// Picking a colour is a click in the window like any other; without the
	// popover swallowing it, the dismissal added above would eat the editor
	// the moment the user chose a colour.
	const { bar, clickPath } = setup();
	bar.openTagEditor();

	clickPath(bar.editorClick);

	assert.equal(bar.state().tagEditorOpen, true, 'a click inside the popover dismissed it');
});

test('the window listeners exist only while something is open', () => {
	const { bar, listeners, flush } = setup();

	flush();
	assert.deepEqual([...listeners.keys()], [], 'listeners are installed with every popover closed');

	bar.openTagEditor();
	flush();
	assert.deepEqual([...listeners.keys()].sort(), ['blur', 'click', 'contextmenu']);

	// Every route the menus already used has to dismiss the tag editor too,
	// not just the click one asserted above.
	for (const type of ['blur', 'contextmenu']) {
		bar.openTagEditor();
		flush();
		listeners.get(type)!();
		assert.equal(bar.state().tagEditorOpen, false, `\`${type}\` did not dismiss the tag editor`);
	}

	flush();
	assert.deepEqual([...listeners.keys()], [], 'listeners outlived the last open popover');
});
