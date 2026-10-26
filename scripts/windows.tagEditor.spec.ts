import assert from 'node:assert/strict';

import { flushSync } from 'svelte';
import { beforeEach, describe, onTestFinished, test } from 'vitest';

/*
 * The title bar's popovers — Home, theme, kebab and the window-tag editor —
 * run here as TitleBar.svelte runs them: `TitleBarPopovers` over the real
 * `TabManager`, under the compiler's runes, with its dismissal installed by a
 * real `$effect`. Only the Tauri backend is stubbed.
 *
 * What this does not establish: that the markup wires each handler to the
 * element named in the test, focus, or CSS.
 */

type InvokeCall = { cmd: string; args: any };
type Backend = {
	/** Answers `is_window_tag_taken`. */
	tagTakenElsewhere?: boolean;
	/** Fails every command, to drive the "backend cannot answer" path. */
	invokeFails?: boolean;
	/** Answers `rename_pinned_tag`. */
	pinRename?: 'renamed' | 'missing' | 'taken';
	/** Answers `save_pinned_tag`: `false` when another pin holds the name. */
	pinCreated?: boolean;
};

let backend: Backend = {};
let invokeCalls: InvokeCall[] = [];

(window as any).__TAURI_INTERNALS__ = {
	metadata: { currentWindow: { label: 'main' }, currentWebview: { windowLabel: 'main', label: 'main' } },
	invoke: (cmd: string, args: any) => {
		// The settings store boots on import; see AGENTS.md on `get_os_type`.
		if (cmd === 'get_os_type') return Promise.resolve('macos');
		invokeCalls.push({ cmd, args });
		if (backend.invokeFails) return Promise.reject(new Error(`invoke failed: ${cmd}`));
		if (cmd === 'rename_pinned_tag') return Promise.resolve(backend.pinRename ?? 'renamed');
		if (cmd === 'save_pinned_tag') return Promise.resolve(backend.pinCreated ?? true);
		if (cmd === 'is_window_tag_taken') return Promise.resolve(backend.tagTakenElsewhere ?? false);
		return Promise.resolve(null);
	},
	transformCallback: (fn: unknown) => fn,
};

const { tabManager } = await import('../src/lib/stores/tabs.svelte.js');
const { settings } = await import('../src/lib/stores/settings.svelte.js');
const { TAG_COLORS: COLORS, TitleBarPopovers, containClick, scopeLine } = await import('../src/lib/stores/titleBarPopovers.svelte.js');
const { runeEffect } = await import('./runeEffect.svelte.js');

/** An `EventTarget` standing in for `window` that reports which listeners are on it. */
class ListenedTarget extends EventTarget {
	readonly types = new Map<string, number>();
	addEventListener(type: string, fn: EventListenerOrEventListenerObject | null, options?: unknown) {
		this.types.set(type, (this.types.get(type) ?? 0) + 1);
		super.addEventListener(type, fn, options as AddEventListenerOptions);
	}
	removeEventListener(type: string, fn: EventListenerOrEventListenerObject | null, options?: unknown) {
		const count = this.types.get(type) ?? 0;
		if (count <= 1) this.types.delete(type);
		else this.types.set(type, count - 1);
		super.removeEventListener(type, fn, options as EventListenerOptions);
	}
	listening(): string[] {
		return [...this.types.keys()].sort();
	}
}

function setup(next: Backend = {}) {
	backend = next;
	invokeCalls = [];
	tabManager.setWindowTag(null);
	const target = new ListenedTarget();
	const bar = new TitleBarPopovers();
	onTestFinished(runeEffect(() => bar.listenForDismiss(target)));
	flushSync();

	/**
	 * One gesture along its bubble path: each handler in turn, then the window —
	 * unless something on the way called `stopPropagation`. Effects flush
	 * between the element's handlers and the window listener, as they do for a
	 * real click, so a listener installed by this very click sees it.
	 */
	const gesture = (type: string, ...handlers: Array<(event: Event) => void>) => {
		const event = new Event(type, { cancelable: true });
		let stopped = false;
		event.stopPropagation = () => void (stopped = true);
		for (const handler of handlers) {
			if (stopped) break;
			handler(event);
		}
		flushSync();
		if (!stopped) target.dispatchEvent(new Event(type));
		flushSync();
		return event;
	};
	const clickPath = (...handlers: Array<(event: Event) => void>) => gesture('click', ...handlers);
	const clickOutside = () => clickPath();
	const rightClickChip = () => gesture('contextmenu', (event) => bar.openTagEditorFromContextMenu(event));
	const chipClick = (event: Event) => bar.toggleTagEditor(event);

	return { bar, target, clickPath, clickOutside, rightClickChip, chipClick };
}

const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
	tabManager.closeAll();
	settings.language = 'en';
});

/*
 * The window-tag popover had no way out that did not write something: on a
 * window with no tag yet, Save was the single exit. Escape did nothing, a click
 * elsewhere did nothing, and the chip re-opened rather than toggled. The Save
 * button has since gone, as in Chrome's tab-group editor: a click elsewhere,
 * the chip and Enter commit the draft, and Escape alone discards it.
 */
describe('dismissing the window-tag editor', () => {
	test('Escape closes the tag editor on a window that has no tag yet', () => {
		const { bar } = setup();
		bar.openTagEditor();
		bar.tagDraftName = 'Research';
		bar.tagDraftColor = COLORS[2];

		bar.editorKeydown({ key: 'Escape' });

		assert.equal(bar.tagEditorOpen, false, 'Escape left the popover open');
		assert.equal(tabManager.windowTag, null, 'Escape wrote a tag — dismissing must not commit the draft');
	});

	test('a click elsewhere in the window commits the draft and closes', async () => {
		const { bar, clickOutside } = setup();
		bar.openTagEditor();
		bar.tagDraftName = 'Research';
		bar.tagDraftColor = COLORS[2];

		clickOutside();
		await settle();

		assert.equal(bar.tagEditorOpen, false, 'a click outside left the popover open');
		assert.deepEqual(tabManager.windowTag, { name: 'Research', color: COLORS[2], pinned: false }, 'a click outside dropped the draft');
	});

	test('a click elsewhere with a taken name keeps the popover open on the refusal', async () => {
		const { bar, clickOutside } = setup({ tagTakenElsewhere: true });
		bar.openTagEditor();
		bar.tagDraftName = 'Research';

		clickOutside();
		await settle();

		assert.equal(tabManager.windowTag, null, 'the duplicate name was written anyway');
		assert.equal(bar.tagEditorOpen, true, 'the popover closed, so the refusal had nowhere to appear');
		assert.notEqual(bar.tagError, '');
	});

	test('a click elsewhere on an unchanged tag asks the backend nothing', () => {
		const { bar, clickOutside } = setup();
		tabManager.setWindowTag({ name: 'Docs', color: COLORS[1] });
		bar.openTagEditor();

		clickOutside();

		assert.equal(bar.tagEditorOpen, false);
		assert.deepEqual(invokeCalls, [], 'closing an untouched popover went to the backend');
	});

	test('the chip toggles the tag editor instead of only opening it', () => {
		const { bar, clickPath, chipClick } = setup();
		tabManager.setWindowTag({ name: 'Docs', color: COLORS[1] });

		clickPath(chipClick);
		assert.equal(bar.tagEditorOpen, true, 'the chip did not open the popover, or opened it into its own dismissal');

		clickPath(chipClick);
		assert.equal(bar.tagEditorOpen, false, 'a second click on the chip left the popover open');
		assert.deepEqual(tabManager.windowTag, { name: 'Docs', color: COLORS[1], pinned: false }, 'toggling the chip changed the tag');
	});

	test('opening the tag editor from the Home menu survives the click that opened it', () => {
		// The item calls no `stopPropagation` of its own while the open Home menu
		// has already installed the window listener; its container does.
		const { bar, target, clickPath } = setup();
		bar.homeMenuOpen = true;
		flushSync();
		assert.ok(target.listening().includes('click'), 'precondition: an open Home menu has already installed the window listener');

		clickPath(() => bar.openTagEditorFromHomeMenu(), containClick);

		assert.equal(bar.homeMenuOpen, false, 'the Home menu stayed open');
		assert.equal(bar.tagEditorOpen, true, 'the menu item opened the tag editor into its own dismissal');
	});

	test('Escape discards the draft: reopening shows the stored tag', () => {
		const { bar } = setup();
		tabManager.setWindowTag({ name: 'Docs', color: COLORS[1] });
		bar.openTagEditor();
		bar.tagDraftName = 'Docs, rewritten';
		bar.tagDraftColor = COLORS[4];

		bar.editorKeydown({ key: 'Escape' });
		assert.equal(bar.tagEditorOpen, false, 'Escape left the popover open');
		bar.openTagEditor();

		assert.equal(bar.tagDraftName, 'Docs', 'the abandoned name came back');
		assert.equal(bar.tagDraftColor, COLORS[1], 'the abandoned colour came back');
		assert.deepEqual(tabManager.windowTag, { name: 'Docs', color: COLORS[1], pinned: false });
	});

	test('Enter still saves the draft', async () => {
		const { bar } = setup();
		bar.openTagEditor();
		bar.tagDraftName = 'Notes';
		bar.tagDraftColor = COLORS[3];

		bar.editorKeydown({ key: 'Enter' });
		await settle();

		assert.equal(bar.tagEditorOpen, false);
		assert.deepEqual(tabManager.windowTag, { name: 'Notes', color: COLORS[3], pinned: false }, 'Enter stopped committing');
	});

	test('typing in the name field does not close the tag editor', () => {
		const { bar } = setup();
		bar.openTagEditor();

		for (const key of ['a', 'Backspace', 'Tab', 'ArrowLeft', ' ']) {
			bar.editorKeydown({ key });
			assert.equal(bar.tagEditorOpen, true, `\`${key}\` closed the popover`);
		}
	});

	test('clicks inside the tag editor do not dismiss it', () => {
		const { bar, clickPath } = setup();
		bar.openTagEditor();
		flushSync();

		clickPath(() => (bar.tagDraftColor = COLORS[5]), containClick);

		assert.equal(bar.tagEditorOpen, true, 'a click inside the popover dismissed it');
	});

	test('the window listeners exist only while something is open', () => {
		const { bar, target } = setup();
		assert.deepEqual(target.listening(), [], 'listeners are installed with every popover closed');

		bar.openTagEditor();
		flushSync();
		assert.deepEqual(target.listening(), ['blur', 'click', 'contextmenu']);

		for (const type of ['blur', 'contextmenu']) {
			bar.openTagEditor();
			flushSync();
			target.dispatchEvent(new Event(type));
			flushSync();
			assert.equal(bar.tagEditorOpen, false, `\`${type}\` did not dismiss the tag editor`);
		}

		assert.deepEqual(target.listening(), [], 'listeners outlived the last open popover');
	});
});

/*
 * A window tag is a property of the WINDOW: one nullable record on the
 * `TabManager`, under which every tab in the window sits. The chip sits where
 * Chrome puts a tab-group chip, so the strip draws one line under all of it,
 * both mouse buttons open the one popover, and a name is held by one window.
 */
describe('a window tag is scoped to the whole window', () => {
	test('the scope line follows the window tag, and is the strip’s property', () => {
		setup();
		assert.deepEqual(scopeLine(tabManager.windowTag), { tagged: false, color: undefined }, 'an untagged window drew a scope line');

		tabManager.setWindowTag({ name: 'Research', color: COLORS[4] });
		assert.deepEqual(scopeLine(tabManager.windowTag), { tagged: true, color: COLORS[4] }, 'a tagged window drew no scope line in its colour');

		// Nothing about it is per tab, so a tab opened after the tag was set needs
		// no marking of its own.
		tabManager.addNewTab();
		tabManager.addNewTab();
		assert.deepEqual(scopeLine(tabManager.windowTag), { tagged: true, color: COLORS[4] }, 'opening tabs changed what the scope line shows');

		tabManager.setWindowTag(null);
		assert.equal(scopeLine(tabManager.windowTag).tagged, false, 'removing the tag left the scope line behind');
	});

	test('both buttons on the chip open the one popover', () => {
		const { bar, clickPath, chipClick, rightClickChip } = setup();
		tabManager.setWindowTag({ name: 'Docs', color: COLORS[1] });

		clickPath(chipClick);
		assert.equal(bar.tagEditorOpen, true, 'left-click did not open the popover');
		clickPath(chipClick);
		assert.equal(bar.tagEditorOpen, false, 'precondition: left-click still toggles');

		const event = rightClickChip();
		assert.equal(event.defaultPrevented, true, 'the platform context menu was left to open over the title bar');
		assert.equal(bar.tagEditorOpen, true, 'right-click did not open the popover, or opened it into its own dismissal');
	});

	test('right-click opens but never closes, and never discards a draft', () => {
		const { bar, rightClickChip } = setup();
		tabManager.setWindowTag({ name: 'Docs', color: COLORS[1] });
		bar.openTagEditor();
		bar.tagDraftName = 'Docs, half-ty';
		bar.tagDraftColor = COLORS[5];
		flushSync();

		rightClickChip();

		assert.equal(bar.tagEditorOpen, true, 'right-click closed the popover it exists to open');
		assert.equal(bar.tagDraftName, 'Docs, half-ty', 'right-click re-seeded the draft over what the user had typed');
		assert.equal(bar.tagDraftColor, COLORS[5], 'right-click re-seeded the colour');
	});

	test('the popover carries Pin/Unpin and Remove, and each acts on the tag', async () => {
		const { bar } = setup();
		tabManager.setWindowTag({ name: 'Docs', color: COLORS[1] });
		tabManager.addTab('/notes/a.md');
		bar.openTagEditor();

		assert.equal(bar.tagActions?.pinned, false, 'the pin control does not offer to pin an unpinned tag');
		await bar.togglePinnedTag();
		assert.equal(tabManager.windowTag?.pinned, true, 'Pin did not pin the tag');
		assert.deepEqual(
			invokeCalls.filter((call) => call.cmd === 'save_pinned_tag').map((call) => call.args),
			[{ name: 'Docs', color: COLORS[1], files: ['/notes/a.md'] }],
			'Pin did not persist the window’s documents',
		);
		assert.equal(bar.tagActions?.pinned, true, 'the pin control does not track the pin state');

		bar.clearTag();
		assert.equal(tabManager.windowTag, null, 'Remove left the tag in place');
		assert.ok(
			invokeCalls.some((call) => call.cmd === 'remove_pinned_tag' && call.args.name === 'Docs'),
			'Remove dropped a pinned tag from the window without dropping its saved session',
		);
	});

	test('Close Tag is offered only for a pinned tag, the one Home can reopen', () => {
		const { bar } = setup();
		tabManager.setWindowTag({ name: 'Docs', color: COLORS[1] });
		assert.equal(bar.tagActions?.canClose, false, 'an unpinned tag was offered Close');

		tabManager.setWindowTag({ name: 'Docs', color: COLORS[1], pinned: true });
		assert.equal(bar.tagActions?.canClose, true, 'a pinned tag was not offered Close');
	});

	test('Pin and Remove are offered only once a tag exists', () => {
		const { bar } = setup();
		bar.openTagEditor();
		assert.equal(bar.tagActions, null, 'a window with no tag was offered Pin and Remove');

		tabManager.setWindowTag({ name: 'Docs', color: COLORS[1] });
		assert.notEqual(bar.tagActions, null, 'a tagged window was not offered Pin and Remove');
	});

	test('an emptied name keeps the tag, pinned or not, and asks the backend nothing', async () => {
		for (const pinned of [false, true]) {
			const { bar } = setup({ tagTakenElsewhere: true });
			tabManager.setWindowTag({ name: 'Docs', color: COLORS[1], pinned });
			bar.openTagEditor();
			bar.tagDraftName = '   ';
			bar.tagDraftColor = COLORS[4];

			await bar.applyTag();

			assert.deepEqual(tabManager.windowTag, { name: 'Docs', color: COLORS[1], pinned }, 'an emptied name changed the tag');
			assert.equal(bar.tagEditorOpen, false, 'the popover stayed open');
			assert.deepEqual(invokeCalls, [], 'an emptied name went to the backend');
		}
	});

	test('a name another window already holds is refused, in the popover', async () => {
		const { bar } = setup({ tagTakenElsewhere: true });
		bar.openTagEditor();
		bar.tagDraftName = 'Research';

		await bar.applyTag();

		assert.equal(tabManager.windowTag, null, 'the duplicate name was written anyway');
		assert.equal(bar.tagEditorOpen, true, 'the popover closed, so the refusal had nowhere to appear');
		assert.match(bar.tagError, /already uses this name/i, 'the refusal does not say what happened');
		assert.match(bar.tagError, /pick a different one/i, 'the refusal does not say what to do about it');
		assert.deepEqual(
			invokeCalls.filter((call) => call.cmd === 'is_window_tag_taken').map((call) => call.args),
			[{ name: 'Research' }],
			'the name was not checked, or was checked more than once',
		);
		assert.equal(bar.tagDraftName, 'Research', 'the refused name was taken away from the user to retype');
	});

	test('editing the name clears the refusal', async () => {
		const { bar } = setup({ tagTakenElsewhere: true });
		bar.openTagEditor();
		bar.tagDraftName = 'Research';
		await bar.applyTag();
		assert.notEqual(bar.tagError, '', 'precondition: the save was refused');

		bar.tagDraftName = 'Research notes';
		bar.nameEdited();

		assert.equal(bar.tagError, '', 'the refusal stayed on screen while the user fixed it');
	});

	test('the name is trimmed before it is checked and before it is stored', async () => {
		// Otherwise `"Research "` slips past a check for `"Research"`.
		const { bar } = setup();
		bar.openTagEditor();
		bar.tagDraftName = '  Research  ';
		bar.tagDraftColor = COLORS[2];

		await bar.applyTag();

		assert.deepEqual(
			invokeCalls.filter((call) => call.cmd === 'is_window_tag_taken').map((call) => call.args.name),
			['Research'],
			'the untrimmed name was sent to the check',
		);
		assert.equal(tabManager.windowTag?.name, 'Research', 'the untrimmed name was stored');
	});

	test('a window may keep its own name — the check excludes the asker', async () => {
		// The exclusion is the backend's; the frontend asks and obeys.
		const { bar } = setup({ tagTakenElsewhere: false });
		tabManager.setWindowTag({ name: 'Research', color: COLORS[2], pinned: true });
		bar.openTagEditor();
		bar.tagDraftColor = COLORS[6];

		await bar.applyTag();

		assert.deepEqual(tabManager.windowTag, { name: 'Research', color: COLORS[6], pinned: true }, 're-saving a window’s own tag name was refused, or lost its pin');
		assert.equal(bar.tagError, '');
	});

	test('a backend that cannot answer does not block the user’s own save', async () => {
		const { bar } = setup({ invokeFails: true });
		bar.openTagEditor();
		bar.tagDraftName = 'Research';
		bar.tagDraftColor = COLORS[2];

		await bar.applyTag();

		assert.deepEqual(tabManager.windowTag, { name: 'Research', color: COLORS[2], pinned: false }, 'a failed check swallowed the save');
		assert.equal(bar.tagEditorOpen, false);
		assert.equal(bar.tagError, '');
	});

	test('renaming a pinned tag renames its pin, which keeps the window pinned', async () => {
		// The closing save refreshes the pin by the window's current name; a rename
		// that left pinned-tags.json alone unpinned the window at close.
		const { bar } = setup();
		tabManager.setWindowTag({ name: 'Research', color: COLORS[2], pinned: true });
		bar.openTagEditor();
		bar.tagDraftName = 'Papers';
		bar.tagDraftColor = COLORS[6];

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
		bar.tagDraftName = 'Notes';

		await bar.applyTag();

		assert.deepEqual(tabManager.windowTag, { name: 'Research', color: COLORS[2], pinned: true }, 'the rename went through anyway');
		assert.equal(bar.tagEditorOpen, true);
		assert.match(bar.tagError, /pinned tag already uses this name/i);
	});

	test('pinning under a name a closed pinned group holds is refused, in the popover', async () => {
		const { bar } = setup({ pinCreated: false });
		tabManager.setWindowTag({ name: 'Work', color: COLORS[2] });
		bar.openTagEditor();

		await bar.togglePinnedTag();

		assert.deepEqual(tabManager.windowTag, { name: 'Work', color: COLORS[2], pinned: false }, 'the window was marked pinned anyway');
		assert.equal(bar.tagEditorOpen, true);
		assert.match(bar.tagError, /pinned tag already uses this name/i);
	});

	test('renaming a tag another window unpinned renames the window unpinned', async () => {
		const { bar } = setup({ pinRename: 'missing' });
		tabManager.setWindowTag({ name: 'Research', color: COLORS[2], pinned: true });
		bar.openTagEditor();
		bar.tagDraftName = 'Papers';

		await bar.applyTag();

		assert.deepEqual(tabManager.windowTag, { name: 'Papers', color: COLORS[2], pinned: false });
	});

	test('an unpinned rename and a pinned colour change leave the pin file to the closing save', async () => {
		const { bar } = setup();
		tabManager.setWindowTag({ name: 'Research', color: COLORS[2], pinned: true });
		bar.openTagEditor();
		bar.tagDraftColor = COLORS[6];
		await bar.applyTag();

		tabManager.setWindowTag({ name: 'Docs', color: COLORS[2] });
		bar.openTagEditor();
		bar.tagDraftName = 'Papers';
		await bar.applyTag();

		assert.deepEqual(invokeCalls.filter((call) => call.cmd === 'rename_pinned_tag'), []);
	});
});
