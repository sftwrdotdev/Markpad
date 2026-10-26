import assert from 'node:assert/strict';
import { before, describe, test } from 'node:test';

import { COLORS, setup, settle, styleRule, tabManager } from './windowTagEditor.js';

// windowTagEditor.ts installs its rune and Tauri shims on import, which is why
// these cases keep a file of their own. Each describe starts from an empty
// window, as each used to start from a fresh process.

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

describe('dismissing the window-tag editor', () => {
	before(() => tabManager.closeAll());

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
});

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

describe('a window tag is scoped to the whole window', () => {
	before(() => tabManager.closeAll());

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
		await settle();
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

	// -------------------------------------------------------- 5. renaming a pin

	test('renaming a pinned tag renames its pin, which keeps the window pinned', async () => {
		// The closing save refreshes the pin by the window's current name. A rename
		// that left pinned-tags.json alone found nothing there at close, and the
		// window silently unpinned itself while Home kept the old name.
		const { bar, invokeCalls } = setup();
		tabManager.setWindowTag({ name: 'Research', color: COLORS[2], pinned: true });
		bar.openTagEditor();
		bar.setDraft('Papers', COLORS[6]);

		await bar.applyTag();

		assert.deepEqual(
			invokeCalls.filter((call) => call.cmd === 'rename_pinned_tag').map((call) => call.args),
			[{ oldName: 'Research', name: 'Papers', color: COLORS[6] }],
			'the pin file was not told about the rename',
		);
		assert.deepEqual(tabManager.windowTag, { name: 'Papers', color: COLORS[6], pinned: true });
	});

	test('a name another pinned tag holds is refused, in the popover', async () => {
		const { bar } = setup({ pinRename: 'taken' });
		tabManager.setWindowTag({ name: 'Research', color: COLORS[2], pinned: true });
		bar.openTagEditor();
		bar.setDraft('Notes', COLORS[2]);

		await bar.applyTag();

		assert.deepEqual(tabManager.windowTag, { name: 'Research', color: COLORS[2], pinned: true }, 'the rename went through anyway');
		assert.equal(bar.state().tagEditorOpen, true);
		assert.match(bar.state().tagError, /pinned tag already uses this name/i);
	});

	test('pinning under a name a closed pinned group holds is refused, in the popover', async () => {
		// The group's window is closed, so no open window holds the name and the
		// rename check never saw it. Pinning used to replace that group's files.
		const { bar } = setup({ pinCreated: false });
		tabManager.setWindowTag({ name: 'Work', color: COLORS[2] });
		bar.openTagEditor();

		bar.pinClick({ stopPropagation: () => {} });
		await settle();

		assert.deepEqual(tabManager.windowTag, { name: 'Work', color: COLORS[2], pinned: false }, 'the window was marked pinned anyway');
		assert.equal(bar.state().tagEditorOpen, true);
		assert.match(bar.state().tagError, /pinned tag already uses this name/i);
	});

	test('renaming a tag another window unpinned renames the window unpinned', async () => {
		const { bar } = setup({ pinRename: 'missing' });
		tabManager.setWindowTag({ name: 'Research', color: COLORS[2], pinned: true });
		bar.openTagEditor();
		bar.setDraft('Papers', COLORS[2]);

		await bar.applyTag();

		assert.deepEqual(tabManager.windowTag, { name: 'Papers', color: COLORS[2], pinned: false });
	});

	test('an unpinned rename and a pinned colour change leave the pin file to the closing save', async () => {
		// The closing save sends the colour with the files, so a colour change
		// reaches the pin file without a rename.
		const { bar, invokeCalls } = setup();
		tabManager.setWindowTag({ name: 'Research', color: COLORS[2], pinned: true });
		bar.openTagEditor();
		bar.setDraft('Research', COLORS[6]);
		await bar.applyTag();

		tabManager.setWindowTag({ name: 'Docs', color: COLORS[2] });
		bar.openTagEditor();
		bar.setDraft('Papers', COLORS[2]);
		await bar.applyTag();

		assert.deepEqual(invokeCalls.filter((call) => call.cmd === 'rename_pinned_tag'), []);
	});
});
