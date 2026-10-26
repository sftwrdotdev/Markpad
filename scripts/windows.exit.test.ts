import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { createWindowExit, type WindowExitOptions } from '../src/lib/sessions/windowExit.js';
import { pinnedTagFromWindowLabel } from '../src/lib/utils/pinnedTagWindow.js';

// Every way a window ends runs `createWindowExit` against a stub window. The
// Tauri bridge is the one boundary doubled: `invoke` calls are recorded, and
// `update_pinned_tag` answers whether the pin entry still exists.

type Tab = { id: string; path: string; isDirty: boolean };
type Answer = boolean | Promise<boolean>;

let invoked: { cmd: string; args: any }[] = [];
let handleInvoke: (cmd: string, args: any) => unknown = () => null;
(globalThis as any).window = {
	__TAURI_INTERNALS__: {
		invoke: async (cmd: string, args: any) => {
			invoked.push({ cmd, args });
			return handleInvoke(cmd, args);
		},
	},
};

function stubWindow(
	tabs: Tab[],
	settings: Partial<WindowExitOptions['settings']> = {},
	answers: Record<string, Answer> = {},
) {
	invoked = [];
	const log: string[] = [];
	const saves: string[][] = [];
	const pin = { exists: true };
	const loaded: string[] = [];
	let destroyed = false;
	let closed = false;
	handleInvoke = (cmd, args) => {
		if (cmd === 'update_pinned_tag') {
			saves.push([...args.files]);
			return pin.exists;
		}
		if (cmd === 'save_pinned_tag') throw new Error('a closing window recreated its pin');
		if (cmd === 'list_viewer_windows') return [];
		if (cmd === 'keeps_unsaved_on_close') return true;
		return null;
	};
	const closeTab = (id: string) => {
		log.push(`close:${id}`);
		const at = tabs.findIndex((tab) => tab.id === id);
		if (at !== -1) tabs.splice(at, 1);
	};
	const tabManager = {
		tabs,
		windowTag: { name: 'work', color: '#f00', pinned: true } as { name: string; color: string; pinned: boolean } | null,
		closeTab,
		setActive: (id: string) => void log.push(`active:${id}`),
		setWindowTag: (tag: any) => void (tabManager.windowTag = tag ? { ...tag, pinned: tag.pinned === true } : null),
	};
	const others = [
		{ label: 'second', close: async () => void log.push('close-window:second') },
		{ label: 'main', close: async () => void log.push('close-window:main(other)') },
	];
	const exit = createWindowExit({
		tabManager,
		settings: {
			autoSave: false,
			restoreStateOnReopen: false,
			closeWindowWithLastTab: true,
			persistOpenEditors: false,
			...settings,
		},
		appWindow: {
			label: 'main',
			close: async () => {
				closed = true;
				log.push('close-window:main');
			},
			destroy: async () => {
				destroyed = true;
				log.push('destroy');
			},
		},
		allWindows: async () => others,
		recovery: { isReady: () => false, keep: async () => true, drop: async () => true },
		persistWindowState: async (remember) => void log.push(`persist:${remember}`),
		canCloseTab: async (id) => {
			log.push(`ask:${id}`);
			const answer = await (answers[id] ?? true);
			// Save or Don't Save resolves the tab; Cancel leaves it as it was.
			if (answer) {
				const tab = tabs.find((item) => item.id === id);
				if (tab) tab.isDirty = false;
			}
			return answer;
		},
		saveSilently: async (id) => {
			log.push(`silent:${id}`);
			const tab = tabs.find((item) => item.id === id)!;
			tab.isDirty = false;
			return true;
		},
		hasExternalChangeConflict: () => false,
		onAutoSaveFailed: () => void log.push('toast:autoSaveFailed'),
		settle: async () => {},
		loadMarkdown: async (file) => void loaded.push(file),
		setShowHome: () => {},
		moveTabToWindow: async (id) => (closeTab(id), true),
	});
	return { exit, tabs, log, saves, pin, loaded, tabManager, isDestroyed: () => destroyed, isClosed: () => closed };
}

const closeEvent = (log: string[]) => ({ preventDefault: () => void log.push('prevent') });

const files = (...dirty: boolean[]): Tab[] =>
	dirty.map((isDirty, i) => ({ id: 'abc'[i], path: `/notes/${'abc'[i]}.md`, isDirty }));

/** A dialog answer the test settles by hand, to look at the window while it is up. */
function pendingAnswer() {
	let answer!: (value: boolean) => void;
	const promise = new Promise<boolean>((resolve) => (answer = resolve));
	return { promise, answer };
}

// Window close (issue #189): instead of one aggregate "you have N unsaved
// files" modal, the red close button walks the dirty tabs one at a time —
// activating each and showing the SAME unsaved-changes dialog a single tab
// close shows. Cancel stops the walk; the window stays open.
describe('the window close handler', () => {
	test('the aggregate unsaved-files modal is gone from the close handler', async () => {
		// Each dirty tab gets its own dialog, and none is discarded unasked: the
		// old discard path cleared every dirty flag and then closed.
		const w = stubWindow(files(true, true), {}, { b: false });
		await w.exit.handleCloseRequested(closeEvent(w.log));
		assert.deepEqual(w.log.filter((line) => line.startsWith('ask:')), ['ask:a', 'ask:b']);
		assert.equal(w.tabs.find((tab) => tab.id === 'b')?.isDirty, true, 'the cancelled tab keeps its edits');
		assert.equal(w.isClosed(), false);
	});

	test('closing the window still reviews unsaved tabs', async () => {
		const w = stubWindow(files(false, true));
		await w.exit.handleCloseRequested(closeEvent(w.log));
		assert.deepEqual(w.log.slice(0, 3), ['prevent', 'active:b', 'ask:b']);
		assert.equal(w.isClosed(), true);
	});

	test('the close is prevented synchronously before the walk starts', async () => {
		const w = stubWindow(files(true));
		await w.exit.handleCloseRequested(closeEvent(w.log));
		assert.ok(w.log.indexOf('prevent') !== -1 && w.log.indexOf('prevent') < w.log.indexOf('ask:a'), w.log.join(' '));
	});

	test('the window closes only after every dirty tab is resolved', async () => {
		const w = stubWindow(files(true, true));
		await w.exit.handleCloseRequested(closeEvent(w.log));
		assert.equal(w.log.at(-1), 'close-window:main', w.log.join(' '));
		assert.ok(w.log.indexOf('ask:b') < w.log.indexOf('close-window:main'));
	});

	test('a clean window is not held open', async () => {
		// The fence for the tests above: with nothing to review the native close
		// proceeds on its own, so nothing prevents it or re-triggers it.
		const w = stubWindow(files(false));
		await w.exit.handleCloseRequested(closeEvent(w.log));
		assert.equal(w.log.includes('prevent'), false);
		assert.equal(w.isClosed(), false);
	});

	test('a cancelled walk stops the handler before it persists or closes', async () => {
		const w = stubWindow(files(true), {}, { a: false });
		await w.exit.handleCloseRequested(closeEvent(w.log));
		assert.equal(w.log.some((line) => line.startsWith('persist:')), false, 'cancel writes no snapshot');
		assert.equal(w.isClosed(), false, 'and the window stays open');
		assert.deepEqual(invoked.at(-1), { cmd: 'set_quitting', args: { quitting: false } }, 'a cancelled close cancels the quit');
	});

	test('a second close request cannot start a competing walk', async () => {
		const dialog = pendingAnswer();
		const w = stubWindow(files(true), {}, { a: dialog.promise });
		const first = w.exit.handleCloseRequested(closeEvent(w.log));
		await new Promise((resolve) => setTimeout(resolve, 0));
		assert.deepEqual(w.log, ['prevent', 'active:a', 'ask:a'], 'precondition: the first walk is showing its dialog');

		const second: string[] = [];
		const swallowed = await Promise.race([
			w.exit.handleCloseRequested(closeEvent(second)).then(() => true),
			new Promise((resolve) => setTimeout(() => resolve(false), 50)),
		]);
		assert.equal(swallowed, true, 'the second request returns at once instead of waiting on a dialog');
		assert.deepEqual(second, ['prevent'], 'the second request is swallowed');
		assert.equal(w.log.filter((line) => line === 'ask:a').length, 1, 'and asks nothing');

		// Cancelling releases the guard, so the next close walks again.
		dialog.answer(false);
		await first;
		await w.exit.handleCloseRequested(closeEvent(second));
		assert.equal(w.log.filter((line) => line === 'ask:a').length, 2);
	});

	test('the walk proceeds in strict tab-strip order', async () => {
		const tabs = files(false, true, true);
		const w = stubWindow(tabs);
		w.tabManager.setActive('c');
		await w.exit.settleForExit(async () => true);
		assert.deepEqual(w.log.filter((line) => line.startsWith('ask:')), ['ask:b', 'ask:c']);
	});

	test('the restore-on-reopen branch persists window state via the shared helper', async () => {
		// Whether the window is remembered is asked once the walk is over, and the
		// answer is what the snapshot helper is handed.
		for (const remember of [true, false]) {
			const w = stubWindow(files(true));
			let askedAfterWalk = false;
			await w.exit.settleForExit(async () => {
				askedAfterWalk = w.log.includes('ask:a');
				return remember;
			});
			assert.equal(askedAfterWalk, true);
			assert.equal(w.log.at(-1), `persist:${remember}`);
		}
	});

	test('the close flow resolves dirty tabs before serializing window state', async () => {
		const w = stubWindow(files(true, true), { restoreStateOnReopen: true });
		await w.exit.settleForExit(async () => true);
		assert.ok(w.log.indexOf('ask:b') < w.log.indexOf('persist:true'), w.log.join(' '));
	});

	test('with restore enabled resolved titled tabs stay open for the snapshot', async () => {
		const tabs = [...files(true), { id: 'u', path: '', isDirty: true }];
		const w = stubWindow(tabs, { restoreStateOnReopen: true });
		await w.exit.settleForExit(async () => true);
		assert.deepEqual(w.tabs.map((tab) => tab.id), ['a'], 'the titled tab stays, the untitled one has nothing to restore');

		const off = stubWindow(files(true), { restoreStateOnReopen: false });
		await off.exit.settleForExit(async () => true);
		assert.deepEqual(off.tabs, [], 'with restore off the review closes tabs one by one');
	});

	test('auto-save fast path silently saves titled tabs before the walk', async () => {
		const tabs = [...files(true), { id: 'u', path: '', isDirty: true }];
		const w = stubWindow(tabs, { autoSave: true });
		await w.exit.settleForExit(async () => true);
		assert.deepEqual(
			w.log.filter((line) => line.startsWith('silent:') || line.startsWith('ask:')),
			['silent:a', 'ask:u'],
			'the titled tab is saved without a prompt; the untitled one needs the dialog',
		);
	});

	test('quitting writes the session instead of discarding it', async () => {
		// Quit closes every window, each through its own close handler, which
		// persists like the red button. This window goes last.
		const w = stubWindow(files(false));
		await w.exit.appExit();
		assert.deepEqual(invoked[0], { cmd: 'set_quitting', args: { quitting: true } });
		assert.deepEqual(w.log, ['close-window:second', 'close-window:main']);
		assert.equal(w.log.some((line) => line === 'persist:false'), false, 'nothing is discarded');
	});
});

/*
 * A pinned tag's file list is written when its window ends. Every way of ending
 * a window closes tabs on the way — the last tab's ×, the close review with
 * restore off, a merge into another window — and the pin used to be written
 * after they were gone, so Home showed the group with no files. What is
 * asserted is the last list sent to `update_pinned_tag`.
 */
describe('a pinned tag keeps its files when its window ends', () => {
	test('closing every tab with × keeps the last file in the pin', async () => {
		const w = stubWindow(files(false, false));
		await w.exit.closeTabAndWindowIfLast('a');
		await w.exit.closeTabAndWindowIfLast('b');
		assert.equal(w.isDestroyed(), true);
		assert.deepEqual(w.saves.at(-1), ['/notes/b.md']);
	});

	test('with the window kept open, closing the empty window later does not empty the pin', async () => {
		const w = stubWindow(files(false, false), { closeWindowWithLastTab: false });
		await w.exit.closeTabAndWindowIfLast('a');
		await w.exit.closeTabAndWindowIfLast('b');
		assert.equal(w.isDestroyed(), false);
		assert.equal(await w.exit.settleForExit(async () => true), true);
		assert.deepEqual(w.saves.at(-1), ['/notes/b.md']);
	});

	test('the close review with restore off keeps the dirty tabs it closes in the pin', async () => {
		const w = stubWindow(files(true, false));
		assert.equal(await w.exit.settleForExit(async () => true), true);
		assert.deepEqual(w.tabs.map((tab) => tab.id), ['b'], 'the review closed the dirty tab');
		// The handler re-triggers the close after a review, and settles again.
		assert.equal(await w.exit.settleForExit(async () => true), true);
		assert.deepEqual(w.saves.at(-1), ['/notes/a.md', '/notes/b.md']);

		// A window that lives on after that (an update that failed to install)
		// saves what it has open, not the list the review started from.
		w.tabs.push({ id: 'c', path: '/notes/c.md', isDirty: false });
		assert.equal(await w.exit.settleForExit(async () => true), true);
		assert.deepEqual(w.saves.at(-1), ['/notes/b.md', '/notes/c.md']);
	});

	test('an update whose install fails leaves no stale review list behind', async () => {
		// The update settles like a close but is not followed by one: when the
		// install fails the window stays, and a later last-tab close saved the
		// list the update's review started from.
		const w = stubWindow(files(true, false));
		assert.equal(await w.exit.settleForUpdate(), true);
		assert.deepEqual(w.saves.at(-1), ['/notes/a.md', '/notes/b.md']);

		w.tabs.push({ id: 'c', path: '/notes/c.md', isDirty: false });
		await w.exit.closeTabAndWindowIfLast('b');
		await w.exit.closeTabAndWindowIfLast('c');
		assert.deepEqual(w.saves.at(-1), ['/notes/c.md']);
	});

	test('merging a pinned window into another keeps its files in the pin', async () => {
		const w = stubWindow(files(false, false));
		await w.exit.mergeSelfInto('other');
		assert.equal(w.isDestroyed(), true);
		assert.deepEqual(w.saves.at(-1), ['/notes/a.md', '/notes/b.md']);
	});

	test('a pin another window removed stays removed when this window closes', async () => {
		const w = stubWindow(files(false, false));
		w.pin.exists = false;
		assert.equal(await w.exit.settleForExit(async () => true), true);
		assert.deepEqual(w.tabManager.windowTag, { name: 'work', color: '#f00', pinned: false }, 'the window still claims the pin');
	});

	test('only explicitly pinned tags create reusable sessions', async () => {
		// An unpinned tag is a label on this window only: ending the window
		// writes no pin entry for it.
		const w = stubWindow(files(false, false));
		w.tabManager.windowTag = { name: 'work', color: '#f00', pinned: false };
		await w.exit.closeTabAndWindowIfLast('a');
		await w.exit.closeTabAndWindowIfLast('b');
		assert.equal(w.isDestroyed(), true);
		assert.deepEqual(w.saves, []);
		assert.equal(invoked.some((call) => call.cmd.includes('pinned_tag')), false);
	});

	const research = { name: 'research', color: '#0a0', files: ['/papers/x.md', '/papers/y.md'] };

	test('opening a pinned group in a window with tabs opens a new window for it', async () => {
		const w = stubWindow(files(false, false));
		await w.exit.openPinnedTag(research);
		const creates = invoked.filter((call) => call.cmd === 'create_transfer_window');
		assert.equal(creates.length, 1);
		assert.equal(pinnedTagFromWindowLabel(`window-${creates[0].args.token}`), 'research', 'the new window reads the group from its label');
		assert.equal(creates[0].args.tagName, 'research', "and is created as the group's holder");
		assert.deepEqual(w.loaded, [], 'no file of the group joins this window');
		assert.deepEqual(w.tabs.map((tab) => tab.id), ['a', 'b']);
		assert.deepEqual(w.tabManager.windowTag, { name: 'work', color: '#f00', pinned: true });
	});

	test('an empty window adopts the pinned group in place', async () => {
		const w = stubWindow([]);
		w.tabManager.windowTag = null;
		await w.exit.openPinnedTag(research);
		assert.equal(invoked.some((call) => call.cmd === 'create_transfer_window'), false);
		assert.deepEqual(w.loaded, research.files);
		assert.deepEqual(w.tabManager.windowTag, { ...research, pinned: true });
	});
});
