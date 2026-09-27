import assert from 'node:assert/strict';
import test from 'node:test';

import { COLORS, setup, settle, styleRule, tabManager } from './windowTagEditor.js';

/*
 * A window tag is a property of the WINDOW. `TabManager.windowTag` is one
 * nullable record; Tab.svelte and TabList.svelte never read it. Every tab in
 * the window is under the tag and there is no such thing as a tab that is not.
 *
 * The chip renders as a coloured pill at the left end of the tab strip —
 * exactly where Chrome puts a tab-GROUP chip, where a coloured enclosure marks
 * which tabs belong. So the control asks "which of these tabs?" and the screen
 * answers nothing. Three changes make the visual language agree with the
 * semantics, and none of them introduces per-tab membership:
 *
 *   1. one continuous line under the whole strip, in the tag's colour;
 *   2. left-click the chip edits the tag, right-click commands it;
 *   3. a tag name may be held by only one window at a time.
 *
 * These tests RUN the component's own handlers over the real `TabManager` —
 * see windowTagEditor.ts. The two CSS assertions are the exception and say so:
 * there is no layout engine here, so they query the parsed stylesheet for the
 * declarations that decide where the line is drawn.
 */

// ------------------------------------------------------------ 1. scope line

test('the scope line follows the window tag, and is the strip’s property', () => {
	const { bar } = setup();

	assert.equal(!!bar.tabAreaTagged(), false, 'an untagged window drew a scope line');
	assert.equal(bar.tabAreaTagColor(), undefined, 'an untagged window still carried a tag colour');

	tabManager.setWindowTag({ name: 'Research', color: COLORS[4] });

	assert.equal(!!bar.tabAreaTagged(), true, 'a tagged window drew no scope line');
	assert.equal(bar.tabAreaTagColor(), COLORS[4], 'the line did not take the tag’s colour');

	// The point of putting it on the strip: nothing about it is per tab, so a
	// tab opened after the tag was set needs no marking of its own.
	const before = bar.tabAreaTagColor();
	tabManager.addNewTab();
	tabManager.addNewTab();
	assert.equal(bar.tabAreaTagColor(), before, 'opening tabs changed what the scope line shows');
	assert.equal(!!bar.tabAreaTagged(), true, 'a tab opened after the tag was set left the strip unmarked');

	tabManager.setWindowTag(null);
	assert.equal(!!bar.tabAreaTagged(), false, 'removing the tag left the scope line behind');
	tabManager.closeAll();
});

test('the scope line is drawn on the strip, in a channel the active tab does not use', () => {
	/*
	 * Not executed: there is no layout engine in this runner, so this reads the
	 * parsed stylesheet rather than a rendered box. It is here because the
	 * decision it records is the one that makes the line safe — the active tab
	 * is marked with `background-color`, so a line along the bottom edge of the
	 * strip cannot be misread as "this tab", and nothing has to arbitrate
	 * between the two markings.
	 */
	const line = styleRule('src/lib/components/TitleBar.svelte', '.tab-area.tagged::after');
	assert.ok(line.size > 0, 'no rule draws the scope line');
	assert.equal(line.get('position'), 'absolute');
	assert.equal(line.get('bottom'), '0');
	assert.equal(line.get('left'), '0');
	assert.equal(line.get('right'), '0', 'the line stops short of the end of the strip');
	assert.equal(line.get('background'), 'var(--tag-color)', 'the line is not painted in the tag’s colour');
	assert.equal(line.get('pointer-events'), 'none', 'the line would swallow clicks and drags on the title bar');
	assert.equal(styleRule('src/lib/components/TitleBar.svelte', '.tab-area').get('position'), 'relative', 'the line has nothing to position against');

	const activeTab = styleRule('src/lib/components/Tab.svelte', '.tab.active');
	assert.ok(activeTab.size > 0, 'the active tab has no styling at all — this test is looking at the wrong rule');
	for (const property of ['border-bottom', 'border-bottom-color', 'border', 'box-shadow', 'outline']) {
		assert.equal(
			activeTab.get(property),
			undefined,
			`the active tab now marks itself with \`${property}\`, which competes with the scope line along the same edge`,
		);
	}
	assert.ok(activeTab.has('background-color'), 'the active tab no longer marks itself with a background');
});

// ------------------------------------------------- 2. left-click / right-click

test('both buttons on the chip open the one popover', () => {
	/*
	 * The chip borrows Chrome's tab-group chip visually, but not the state that
	 * makes Chrome's left/right division necessary: there, left-click collapses
	 * and expands the group, so the commands need a second surface. A window tag
	 * has nothing to collapse, so left-click has no second job and a right-click
	 * menu would only hide Pin and Remove behind a gesture that advertises
	 * nothing. What right-click does owe the user is not raising the platform
	 * menu over the title bar.
	 */
	const { bar, clickPath, rightClick } = setup();
	tabManager.setWindowTag({ name: 'Docs', color: COLORS[1] });

	clickPath(bar.chipClick);
	assert.equal(bar.state().tagEditorOpen, true, 'left-click did not open the popover');

	clickPath(bar.chipClick);
	assert.equal(bar.state().tagEditorOpen, false, 'precondition: left-click still toggles');

	const { defaultPrevented } = rightClick();
	assert.equal(defaultPrevented, true, 'the platform context menu was left to open over the title bar');
	assert.equal(bar.state().tagEditorOpen, true, 'right-click did not open the popover');
});

test('right-click opens but never closes, and never discards a draft', () => {
	/*
	 * The one place the two gestures differ, and why. `openTagEditor` re-seeds
	 * the draft from the stored tag, so a right-click that re-opened an open
	 * popover would throw away a name the user was in the middle of typing —
	 * and a gesture whose whole purpose is "show me the tag's controls" should
	 * not sometimes hide them.
	 */
	const { bar, rightClick } = setup();
	tabManager.setWindowTag({ name: 'Docs', color: COLORS[1] });
	bar.openTagEditor();
	bar.setDraft('Docs, half-ty', COLORS[5]);

	rightClick();

	assert.equal(bar.state().tagEditorOpen, true, 'right-click closed the popover it exists to open');
	assert.equal(bar.state().tagDraftName, 'Docs, half-ty', 'right-click re-seeded the draft over what the user had typed');
	assert.equal(bar.state().tagDraftColor, COLORS[5], 'right-click re-seeded the colour');
});

test('the popover carries Pin/Unpin and Remove, and each acts on the tag', async () => {
	/*
	 * Run through each button's own `onclick`, so this fails if a control is
	 * unwired as well as if it is missing.
	 */
	const { bar, invokeCalls } = setup();
	tabManager.setWindowTag({ name: 'Docs', color: COLORS[1] });
	tabManager.addTab('/notes/a.md');
	bar.openTagEditor();

	// Pin persists the window's documents under the tag's name.
	assert.equal(bar.pinLabel(), 'Pin Tag', 'the pin control does not offer to pin an unpinned tag');
	bar.pinClick({ stopPropagation: () => {} });
	assert.equal(tabManager.windowTag?.pinned, true, 'Pin did not pin the tag');
	assert.deepEqual(
		invokeCalls.filter((call) => call.cmd === 'save_pinned_tag').map((call) => call.args),
		[{ name: 'Docs', color: COLORS[1], files: ['/notes/a.md'] }],
		'Pin did not persist the window’s documents',
	);
	assert.equal(bar.pinLabel(), 'Unpin Tag', 'the pin control does not track the pin state');

	// Remove drops the tag and the saved session with it.
	bar.removeClick({ stopPropagation: () => {} });
	assert.equal(tabManager.windowTag, null, 'Remove left the tag in place');
	assert.ok(
		invokeCalls.some((call) => call.cmd === 'remove_pinned_tag' && call.args.name === 'Docs'),
		'Remove dropped a pinned tag from the window without dropping its saved session',
	);
	tabManager.closeAll();
});

test('Close Tag is offered only for a pinned tag, the one Home can reopen', () => {
	// Closing an unpinned tag would lose it for good, which is Remove's job.
	const { bar } = setup();
	tabManager.setWindowTag({ name: 'Docs', color: COLORS[1] });
	bar.openTagEditor();
	assert.equal(!!bar.closeRendered(), false, 'an unpinned tag was offered Close');

	tabManager.setWindowTag({ name: 'Docs', color: COLORS[1], pinned: true });
	assert.equal(!!bar.closeRendered(), true, 'a pinned tag was not offered Close');
});

test('Pin and Remove are offered only once a tag exists', () => {
	// They act on a stored tag, and `Home > Window Tag…` opens this popover on a
	// window that has none. Both render under `{#if tabManager.windowTag}`; this
	// evaluates that condition rather than reading it.
	const { bar } = setup();
	bar.openTagEditor();

	assert.equal(!!bar.pinRendered(), false, 'a window with no tag was offered Pin');
	assert.equal(!!bar.removeRendered(), false, 'a window with no tag was offered Remove');

	tabManager.setWindowTag({ name: 'Docs', color: COLORS[1] });

	assert.equal(!!bar.pinRendered(), true, 'a tagged window was not offered Pin');
	assert.equal(!!bar.removeRendered(), true, 'a tagged window was not offered Remove');
});

test('an emptied name keeps the tag, pinned or not, and asks the backend nothing', async () => {
	// With commit-on-dismiss, an emptied name that removed the tag would let a
	// stray click delete a pinned session. Remove Tag is the only way out.
	for (const pinned of [false, true]) {
		const { bar, invokeCalls } = setup({ tagTakenElsewhere: true });
		tabManager.setWindowTag({ name: 'Docs', color: COLORS[1], pinned });
		bar.openTagEditor();
		bar.setDraft('   ', COLORS[4]);

		await bar.applyTag();

		assert.deepEqual(tabManager.windowTag, { name: 'Docs', color: COLORS[1], pinned }, 'an emptied name changed the tag');
		assert.equal(bar.state().tagEditorOpen, false, 'the popover stayed open');
		assert.deepEqual(invokeCalls, [], 'an emptied name went to the backend');
	}
});

// ----------------------------------------------------------- 4. exclusivity

test('a name another window already holds is refused, in the popover', async () => {
	const { bar, invokeCalls } = setup({ tagTakenElsewhere: true });
	bar.openTagEditor();
	bar.setDraft('Research', COLORS[2]);

	await bar.applyTag();

	assert.equal(tabManager.windowTag, null, 'the duplicate name was written anyway');
	assert.equal(bar.state().tagEditorOpen, true, 'the popover closed, so the refusal had nowhere to appear');
	assert.match(bar.state().tagError, /already uses this name/i, 'the refusal does not say what happened');
	assert.match(bar.state().tagError, /pick a different one/i, 'the refusal does not say what to do about it');
	assert.deepEqual(
		invokeCalls.filter((call) => call.cmd === 'is_window_tag_taken').map((call) => call.args),
		[{ name: 'Research' }],
		'the name was not checked, or was checked more than once',
	);
	assert.equal(bar.state().tagDraftName, 'Research', 'the refused name was taken away from the user to retype');
});

test('editing the name clears the refusal', async () => {
	const { bar } = setup({ tagTakenElsewhere: true });
	bar.openTagEditor();
	bar.setDraft('Research', COLORS[2]);
	await bar.applyTag();
	assert.notEqual(bar.state().tagError, '', 'precondition: the save was refused');

	bar.typeName('Research notes');

	assert.equal(bar.state().tagError, '', 'the refusal stayed on screen while the user fixed it');
});

test('the name is trimmed before it is checked and before it is stored', async () => {
	// Otherwise `"Research "` slips past a check for `"Research"` and lands in
	// the registry as a second, invisible spelling of the same name.
	const seen: string[] = [];
	const { bar, invokeCalls } = setup({ tagTakenElsewhere: () => true });
	bar.openTagEditor();
	bar.setDraft('  Research  ', COLORS[2]);

	await bar.applyTag();
	seen.push(...invokeCalls.filter((call) => call.cmd === 'is_window_tag_taken').map((call) => call.args.name));

	assert.deepEqual(seen, ['Research'], 'the untrimmed name was sent to the check');
});

test('a window may keep its own name — the check excludes the asker', async () => {
	// Changing only the colour re-saves the same name. The exclusion is the
	// backend's (`tag_held_by_another_window` skips the asking label), so what
	// this pins down is that the frontend asks and obeys rather than
	// second-guessing: given "not taken", the save goes through.
	const { bar } = setup({ tagTakenElsewhere: false });
	tabManager.setWindowTag({ name: 'Research', color: COLORS[2], pinned: true });
	bar.openTagEditor();
	bar.setDraft('Research', COLORS[6]);

	await bar.applyTag();

	assert.deepEqual(
		tabManager.windowTag,
		{ name: 'Research', color: COLORS[6], pinned: true },
		're-saving a window’s own tag name was refused, or lost its pin',
	);
	assert.equal(bar.state().tagError, '');
});

test('a backend that cannot answer does not block the user’s own save', async () => {
	// The check exists to stop one window quietly overwriting another's pinned
	// documents. An IPC failure is not evidence that it would, and refusing
	// here would make a broken command look like a naming rule.
	const { bar } = setup({ invokeFails: true });
	bar.openTagEditor();
	bar.setDraft('Research', COLORS[2]);

	await bar.applyTag();

	assert.deepEqual(tabManager.windowTag, { name: 'Research', color: COLORS[2], pinned: false }, 'a failed check swallowed the save');
	assert.equal(bar.state().tagEditorOpen, false);
	assert.equal(bar.state().tagError, '');
});
