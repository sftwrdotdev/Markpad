import assert from 'node:assert/strict';

import { flushSync, mount, unmount } from 'svelte';
import { afterAll, beforeAll, describe, test, vi } from 'vitest';

// The runes are the compiler's, not ours: vitest builds `.svelte.ts` through the
// Svelte plugin, so the store and the session run under real reactivity, and jsdom
// supplies `window` and `localStorage`. Only the Tauri backend is stubbed.
//
// Each describe below was a file of its own, with its own window label and its
// own `invoke`. One bridge serves them all: `useTauri` swaps that file's label and
// `invoke` in for the length of its describe, and empties the store and
// localStorage first, which is how a fresh file found them.
type Bridge = { label: string; invoke: (cmd: string, args: any) => unknown };
const defaultBridge: Bridge = {
	label: 'main',
	// `get_os_type` is the settings store booting on import: `initOSType` only
	// catches a rejection, so answering `null` leaves `osType` null and the
	// font defaults it then indexes are undefined.
	invoke: (cmd: string) => Promise.resolve(cmd === 'get_os_type' ? 'macos' : null),
};
let bridge = defaultBridge;

(window as any).__TAURI_INTERNALS__ = {
	get metadata() {
		const label = bridge.label;
		return { currentWindow: { label }, currentWebview: { windowLabel: label, label } };
	},
	invoke: (cmd: string, args: any) => bridge.invoke(cmd, args),
	transformCallback: (fn: unknown) => fn,
};

const { tabManager } = await import('../src/lib/stores/tabs.svelte.js');
const { createWindowSession } = await import('../src/lib/sessions/windowSession.svelte.js');
const { snapshotTab, validateTransferPayload } = await import('../src/lib/utils/tabTransfer.js');
const { default: HomePage } = await import('../src/lib/components/HomePage.svelte');
const { promoteRecentFile, updateStoredRecentFiles } = await import('../src/lib/utils/recentFiles.js');
const { FolderManager, folderName, isInside, snapshotFolder } = await import('../src/lib/stores/folder.svelte.js');
const { HOME_TAB_PATH, isHomePath, showsHomeScreen } = await import('../src/lib/utils/homeTab.js');
const { hasRealFilePath } = await import('../src/lib/utils/tabFileActions.js');
const { openPinnedTagWindow, pinnedTagFromWindowLabel } = await import('../src/lib/utils/pinnedTagWindow.js');
const { reportWindowMeta } = await import('../src/lib/sessions/windowMeta.svelte.js');
const { runeEffect } = await import('./runeEffect.svelte.js');
const { getSupportedLanguages, t } = await import('../src/lib/utils/i18n.js');
const { viewerCommandFor } = await import('../src/lib/utils/viewerKeymap.js');
const { viewerCommandTable } = await import('../src/lib/utils/viewerCommands.js');

function useTauri(next: Partial<Bridge> = {}) {
	beforeAll(() => {
		bridge = { ...defaultBridge, ...next };
		tabManager.closeAll();
		tabManager.setWindowTag(null);
		localStorage.clear();
	});
	afterAll(() => {
		bridge = defaultBridge;
	});
}

// Session restore persists WINDOW state only: which files are open, the
// active tab, and per-tab UI (edit mode, split, scroll). Document content
// always lives on disk — the snapshot never carries rawContent, so unsaved
// changes are handled exclusively by the per-tab close dialogs.
describe('window state restore', () => {
	useTauri();

	test('the snapshot carries window state and no document content', () => {
		// The snapshot is written to disk on every close. A `...t` spread, or one
		// field added by hand, silently turns a window-layout file into a copy of
		// every open document — including one the user never saved anywhere.
		tabManager.closeAll();
		tabManager.addTab('/notes/a.md', 'on disk');
		const tab = tabManager.activeTab!;
		tabManager.updateTabRawContent(tab.id, 'a paragraph that was never saved');
		tab.isEditing = true;
		tab.isSplit = true;
		tab.scrollPercentage = 0.42;

		const snapshot = tabManager.serializeState();

		assert.doesNotMatch(snapshot, /never saved/, 'the buffer is not in the file');
		assert.doesNotMatch(snapshot, /on disk/, 'and neither is the last saved copy');

		const parsed = JSON.parse(snapshot);
		assert.equal(parsed.version, 2);
		assert.deepEqual(
			Object.keys(parsed.tabs[0]).sort(),
			['anchorLine', 'id', 'isEditing', 'isScrollSynced', 'isSplit', 'path', 'scrollPercentage', 'scrollTop', 'splitRatio', 'title'],
			'exactly the window-state fields, so a new one has to be added deliberately',
		);
		assert.equal(parsed.tabs[0].isEditing, true, 'the UI state that IS persisted survives');
		assert.equal(parsed.tabs[0].scrollPercentage, 0.42);
	});

	test('a tab with no file behind it is not persisted', () => {
		// Untitled tabs are resolved by the close dialogs, and the Home tab's path
		// is the sentinel 'HOME' rather than a file. Persisting either restores a
		// tab that can never be read.
		tabManager.closeAll();
		tabManager.addTab('/notes/a.md', 'saved');
		tabManager.addTab('', 'untitled draft');

		const parsed = JSON.parse(tabManager.serializeState());

		assert.deepEqual(parsed.tabs.map((t: { path: string }) => t.path), ['/notes/a.md']);
	});

	test('a restored tab comes back clean, empty and in its old place', () => {
		tabManager.closeAll();
		tabManager.addTab('/notes/a.md', 'on disk');
		const first = tabManager.activeTab!;
		first.isSplit = true;
		first.splitRatio = 0.3;
		tabManager.addTab('/notes/b.md', 'b on disk');
		const second = tabManager.activeTab!;
		tabManager.updateTabRawContent(second.id, 'unsaved');
		const snapshot = tabManager.serializeState();

		tabManager.closeAll();
		tabManager.restoreState(snapshot);

		assert.deepEqual(tabManager.tabs.map((t) => t.path), ['/notes/a.md', '/notes/b.md']);
		assert.equal(tabManager.activeTabId, second.id, 'the tab that was active is active again');
		for (const tab of tabManager.tabs) {
			assert.equal(tab.rawContent, '', 'content is read from disk afterwards, not from the snapshot');
			assert.equal(tab.isDirty, false, 'and a restored tab is never dirty on arrival');
		}
		assert.equal(tabManager.tabs[0].isSplit, true, 'per-tab layout survives the round trip');
		assert.equal(tabManager.tabs[0].splitRatio, 0.3);
	});

	test('a snapshot naming a tab that no longer exists still opens something', () => {
		// activeTabId is written from the live tab list; an entry dropped on the
		// read side (a legacy 'HOME', an untitled tab from an older build) can
		// leave it pointing at nothing. Restoring to no active tab is a blank
		// window with files in the tab bar.
		tabManager.closeAll();
		tabManager.restoreState(
			JSON.stringify({ version: 2, activeTabId: 'gone', tabs: [{ id: 'x', path: '/notes/a.md', title: 'a.md' }] }),
		);

		assert.equal(tabManager.tabs.length, 1);
		assert.equal(tabManager.activeTabId, 'x');
	});

	test('entries that are not files are dropped on the way back in', () => {
		tabManager.closeAll();
		tabManager.restoreState(
			JSON.stringify({
				version: 2,
				tabs: [{ id: 'h', path: 'HOME', title: 'Home' }, { id: 'u', path: '', title: 'Untitled' }, { id: 'a', path: '/notes/a.md', title: 'a.md' }],
			}),
		);

		assert.deepEqual(tabManager.tabs.map((t) => t.path), ['/notes/a.md']);
	});
});

describe('window tags in the snapshot', () => {
	useTauri();

	function roundTrip(): { name: string; color: string; pinned: boolean } | null {
		const snapshot = tabManager.serializeState();
		tabManager.closeAll();
		tabManager.setWindowTag(null);
		tabManager.restoreState(snapshot);
		return tabManager.windowTag;
	}

	test('a window tag survives the snapshot round trip', () => {
		tabManager.closeAll();
		tabManager.addTab('/notes/a.md', 'x');
		tabManager.setWindowTag({ name: 'Drafts', color: '#ff8c00', pinned: true });

		assert.deepEqual(roundTrip(), { name: 'Drafts', color: '#ff8c00', pinned: true });
	});

	test('pinned defaults to false rather than to whatever was written', () => {
		// `pinned` decides whether the tag creates a reusable session, so an
		// older snapshot with no `pinned` field, or one carrying a non-boolean,
		// must not be read as pinned.
		tabManager.closeAll();
		tabManager.addTab('/notes/a.md', 'x');
		tabManager.setWindowTag({ name: 'Drafts', color: '#ff8c00' });
		assert.equal(tabManager.windowTag?.pinned, false, 'omitted means not pinned');
		assert.equal(roundTrip()?.pinned, false, 'and it stays that way through the snapshot');

		tabManager.closeAll();
		tabManager.restoreState(
			JSON.stringify({ version: 2, tabs: [], windowTag: { name: 'D', color: '#fff', pinned: 'yes' } }),
		);
		assert.equal(tabManager.windowTag?.pinned, false, 'a truthy non-boolean is not a pin');
	});

	test('a malformed tag produces no tag at all', () => {
		// A tag with no name renders as an empty chip the user cannot see or
		// remove; one with no colour has nothing to paint. Restore runs on a fresh
		// window, so the starting point here is no tag — the read side only ever
		// installs one, it does not clear an existing one.
		for (const windowTag of [{ color: '#fff' }, { name: '', color: '#fff' }, { name: 'D' }, null, 'Drafts']) {
			tabManager.closeAll();
			tabManager.setWindowTag(null);
			tabManager.restoreState(JSON.stringify({ version: 2, tabs: [], windowTag }));
			assert.equal(tabManager.windowTag, null, `${JSON.stringify(windowTag)} is rejected`);
		}
	});
});

// The home screen sits in a tab, and that tab's path is the sentinel string
// `'HOME'` rather than a file. `serializeState` filtered on `path !== ''`, so
// the sentinel was written into the session snapshot; `restoreState` accepted
// any non-empty string, so it came back; and startup then asked the backend to
// read a file called `HOME`. The failure left a phantom tab that can never be
// read, and a window whose only tab was the home screen came back empty.
//
// `hasRealFilePath` in utils/tabFileActions.ts is the project's existing answer
// to "is this path a file" — every other caller already used it.
//
// These tests drive the real TabManager, so they lock the behaviour rather than
// the wording. The restore-loop half lives in windows.sessionRestore.spec.ts,
// which already has the window-session harness.

describe('the home tab is not a file', () => {
	useTauri();

	function reset() {
		tabManager.closeAll();
		localStorage.clear();
	}

	test('a session snapshot never carries the home tab', () => {
		reset();
		tabManager.addTab('/notes/a.md');
		tabManager.addHomeTab();

		const snapshot = JSON.parse(tabManager.serializeState());

		assert.deepEqual(
			snapshot.tabs.map((tab: { path: string }) => tab.path),
			['/notes/a.md'],
		);
	});

	test('a window showing only the home tab writes an empty snapshot, not a HOME one', () => {
		reset();
		tabManager.addHomeTab();

		assert.deepEqual(JSON.parse(tabManager.serializeState()).tabs, []);
	});

	test('untitled tabs are still excluded from the snapshot', () => {
		// The filter this changes also carried the untitled rule; keep it honest.
		reset();
		tabManager.addTab('/notes/a.md');
		tabManager.addNewTab();

		assert.deepEqual(
			JSON.parse(tabManager.serializeState()).tabs.map((tab: { path: string }) => tab.path),
			['/notes/a.md'],
		);
	});

	test('a HOME entry in an older snapshot is not restored as a tab', () => {
		reset();
		// Builds before this fix wrote the sentinel into the snapshot, and those
		// snapshots are already on users' disks — so the read side has to reject it
		// too, not just the write side.
		tabManager.restoreState(
			JSON.stringify({
				version: 2,
				activeTabId: 'home-id',
				tabs: [
					{ id: 'home-id', path: 'HOME', title: 'Home' },
					{ id: 'doc-id', path: '/notes/a.md', title: 'a.md' },
				],
			}),
		);

		assert.deepEqual(
			tabManager.tabs.map((tab) => tab.path),
			['/notes/a.md'],
		);
		// The stale active id pointed at the rejected entry; the window must not
		// come back with nothing selected.
		assert.equal(tabManager.activeTabId, tabManager.tabs[0].id);
	});

	test('a snapshot of nothing but HOME restores no tabs at all', () => {
		reset();
		tabManager.restoreState(
			JSON.stringify({ version: 2, activeTabId: 'home-id', tabs: [{ id: 'home-id', path: 'HOME', title: 'Home' }] }),
		);

		assert.deepEqual(tabManager.tabs, []);
		assert.equal(tabManager.activeTabId, null);
	});
});

/*
 * A new window starts with no tag.
 *
 * Nothing was changed to make that true — this file exists because it is true
 * and nothing said so. A tag names a window, so a window that did not exist
 * when the name was chosen is not the window it names, and inheriting one
 * would put two windows under a single name without the user ever typing it a
 * second time — which is precisely what the exclusivity check added alongside
 * this refuses when a user does it on purpose.
 *
 * Three things could carry a tag into a fresh window, and all three are driven
 * here rather than read:
 *
 *   1. `TabManager.windowTag`'s own initial value;
 *   2. session restore, which gives a window back only its own previous state;
 *   3. the tab-transfer claim, the only channel through which one window's
 *      content reaches another.
 *
 * `set_window_meta` is not a fourth. It is a one-way report from each window
 * into `AppState.window_registry` — `list_viewer_windows` and the exclusivity
 * check read it, and nothing writes a registry `tag_name` back into a window.
 */

describe('a new window starts with no tag', () => {
	const WINDOW_STATE_KEY = 'savedTabsDataV2';
	const LEGACY_STATE_KEY = 'savedTabsData';
	const RESTORE_IN_PROGRESS_KEY = 'markpad-window-restore-in-progress';

	/** A snapshot written by a window that had a tag, as `serializeState` writes it. */
	const TAGGED_SNAPSHOT = JSON.stringify({
		version: 2,
		windowTag: { name: 'Research', color: '#188038', pinned: true },
		activeTabId: 'tab-0',
		tabs: [{ id: 'tab-0', path: '/papers/a.md', title: 'a.md' }],
	});

	/** A transfer payload from a tagged window, with a tag smuggled in beside it. */
	const TRANSFER_PAYLOAD = JSON.stringify({
		path: '/papers/a.md',
		title: 'a.md',
		rawContent: '# a',
		originalContent: '# a',
		isDirty: false,
		isEditing: false,
		isSplit: false,
		isScrollSynced: false,
		hasReplacementChars: false,
		encoding: 'UTF-8',
		splitRatio: 0.5,
		scrollTop: 0,
		scrollPercentage: 0,
		anchorLine: 0,
		historyIndex: 0,
		history: ['# a'],
		windowTag: { name: 'Research', color: '#188038', pinned: true },
	});

	let invokeCalls: Array<{ cmd: string; args: any }> = [];
	/** What Rust holds for this window's label: snapshots are keyed by the caller. */
	let ownSnapshot: string | null = null;

	useTauri({
		// A detached window, which is what `create_transfer_window` builds.
		label: 'window-abc',
		invoke: (cmd: string, args: any) => {
			invokeCalls.push({ cmd, args });
			switch (cmd) {
				case 'get_os_type':
					return Promise.resolve('macos');
				case 'load_window_state':
					return Promise.resolve(ownSnapshot);
				case 'claim_detached_tab':
					return Promise.resolve(TRANSFER_PAYLOAD);
				case 'read_file_content_checked':
					return Promise.resolve(['# a', false, 'UTF-8']);
				default:
					return Promise.resolve(null);
			}
		},
	});

	// Read before any test runs, so this is the value the module was constructed
	// with rather than one a neighbouring test happened to leave behind.
	const INITIAL_WINDOW_TAG = tabManager.windowTag;

	function makeSession() {
		return createWindowSession({
			windowStateKey: WINDOW_STATE_KEY,
			legacyStateKey: LEGACY_STATE_KEY,
			restoreInProgressKey: RESTORE_IN_PROGRESS_KEY,
			serializeState: () => tabManager.serializeState(),
			shouldRestoreState: () => true,
			isDisposed: () => false,
			restoreState: (json) => tabManager.restoreState(json),
			restoredTabs: () => tabManager.tabs.map((tab) => ({ id: tab.id, path: tab.path })),
			loadRestoredTab: async () => {},
			dropRestoredTab: (tabId) => tabManager.closeTab(tabId),
			canTransfer: () => true,
			canDetach: () => true,
			transferPayload: () => '',
			onTransferClaimed: () => {},
			acceptTransferredTab: async (tab) => {
				tabManager.addTab(tab.path, tab.rawContent);
				return tabManager.activeTabId;
			},
			onError: () => {},
			onWarning: () => {},
			onInterrupted: () => {},
		});
	}

	function reset() {
		tabManager.closeAll();
		tabManager.setWindowTag(null);
		localStorage.clear();
		invokeCalls = [];
		ownSnapshot = null;
	}

	test('a freshly constructed TabManager holds no window tag', () => {
		assert.equal(INITIAL_WINDOW_TAG, null, 'the store starts a window off under a tag');
	});

	test('a new window has no snapshot of its own, so it cannot pick up another window’s tag', async () => {
		reset();

		const restored = await makeSession().restore();

		assert.equal(restored, false, 'a new window reported a snapshot of its own');
		assert.equal(tabManager.windowTag, null, 'a new window came up wearing the saved window tag');
		assert.deepEqual(tabManager.tabs, [], 'a new window restored the previous session');
	});

	test('a reopened window gets its own tag back', async () => {
		// The window was open when the app quit, and comes back under its label.
		// Also the fence: without it the test above passes for a build that never
		// restores anything.
		reset();
		ownSnapshot = TAGGED_SNAPSHOT;

		const restored = await makeSession().restore();

		assert.equal(restored, true);
		assert.deepEqual(tabManager.windowTag, { name: 'Research', color: '#188038', pinned: true });
		assert.equal(tabManager.tabs.length, 1);
	});

	test('the single localStorage snapshot of older builds is taken once, by the first window to restore', async () => {
		// localStorage is shared by every window. The launch window restores first
		// and removes it before any other window exists, so no later window reads it.
		reset();
		localStorage.setItem(WINDOW_STATE_KEY, TAGGED_SNAPSHOT);

		await makeSession().restore();
		assert.deepEqual(tabManager.windowTag, { name: 'Research', color: '#188038', pinned: true });
		assert.equal(localStorage.getItem(WINDOW_STATE_KEY), null, 'the old snapshot was left for another window');

		tabManager.closeAll();
		tabManager.setWindowTag(null);
		assert.equal(await makeSession().restore(), false);
		assert.equal(tabManager.windowTag, null);
	});

	test('a claimed tab brings no tag with it', async () => {
		// The detach path, end to end: the destination window boots, claims the
		// staged payload and builds the tab. The payload here deliberately carries
		// a `windowTag` field a source window might one day add; the validator's
		// job is to hand on only what it knows about.
		reset();

		const claimed = await makeSession().acceptOfferedTransfer('abc');

		assert.equal(claimed, true, 'precondition: the transfer was claimed');
		assert.equal(tabManager.tabs.length, 1, 'precondition: the tab arrived');
		assert.equal(tabManager.windowTag, null, 'the arriving tab dragged the source window’s tag with it');
		assert.equal((validateTransferPayload(TRANSFER_PAYLOAD) as any).windowTag, undefined, 'the validator passed an unknown field through');
	});

	test('the tab snapshot a window sends has no tag in it either', () => {
		// The other end of the same channel: nothing to inherit is put on the wire.
		reset();
		tabManager.setWindowTag({ name: 'Research', color: '#188038', pinned: true });
		tabManager.addTab('/papers/a.md', '# a');

		const payload = snapshotTab(tabManager.tabs[0]) as unknown as Record<string, unknown>;

		assert.ok(!('windowTag' in payload), 'the tab snapshot carries the window’s tag');
		assert.ok(
			!Object.values(payload).some((value) => typeof value === 'string' && value.includes('Research')),
			'the tag name reached the payload under some other field',
		);
		reset();
	});
});

// Every window keeps its own snapshot, keyed by its label on the Rust side. A
// secondary window writes its snapshot whoever else is open, and nobody else's:
// that is what lets each window come back on relaunch, and what ended the quit
// race where the last window to close overwrote main's single slot.

describe('each window keeps its own snapshot', () => {
	let calls: Array<{ cmd: string; args: any }> = [];

	useTauri({
		label: 'window-abc',
		invoke: (cmd: string, args: any) => {
			calls.push({ cmd, args });
			return Promise.resolve(cmd === 'get_os_type' ? 'macos' : null);
		},
	});

	function makeSession() {
		return createWindowSession({
			windowStateKey: 'savedTabsDataV2',
			legacyStateKey: 'savedTabsData',
			restoreInProgressKey: 'markpad-window-restore-in-progress',
			serializeState: () => tabManager.serializeState(),
			shouldRestoreState: () => true,
			isDisposed: () => false,
			restoreState: () => {},
			restoredTabs: () => [],
			loadRestoredTab: async () => {},
			dropRestoredTab: () => {},
			canTransfer: () => true,
			canDetach: () => true,
			transferPayload: () => '',
			onTransferClaimed: () => {},
			acceptTransferredTab: async () => 'arrived',
			onError: () => {},
			onWarning: () => {},
			onInterrupted: () => {},
		});
	}

	async function persistFromDetachedWindow(remember: boolean) {
		tabManager.closeAll();
		tabManager.addTab('/notes/a.md', '# a');
		calls = [];
		await makeSession().persistState(remember);
	}

	const saves = () => calls.filter((call) => call.cmd === 'save_window_state').map((call) => call.args.json);

	test('a detached window writes its own snapshot without asking who else is open', async () => {
		await persistFromDetachedWindow(true);
		const saves = calls.filter((call) => call.cmd === 'save_window_state');
		assert.equal(saves.length, 1);
		assert.deepEqual(
			JSON.parse(saves[0].args.json).tabs.map((tab: { path: string }) => tab.path),
			['/notes/a.md'],
		);
		assert.ok(!calls.some((call) => call.cmd === 'forget_window_state'));
	});

	test('a window closed on its own is forgotten, not saved', async () => {
		await persistFromDetachedWindow(false);
		assert.ok(calls.some((call) => call.cmd === 'forget_window_state'));
		assert.ok(!calls.some((call) => call.cmd === 'save_window_state'));
	});

	test('a window records its state while open, within the bounded delay, latest first', async () => {
		vi.useFakeTimers();
		try {
			tabManager.closeAll();
			const session = makeSession();
			calls = [];
			session.record('before restore');
			await vi.advanceTimersByTimeAsync(1000);
			assert.deepEqual(saves(), [], 'recorded over the snapshot it had not read yet');
			await session.restore();
			// The restore writes the window's starting snapshot, an empty one included.
			assert.equal(saves().length, 1);
			session.record('one');
			session.record('two');
			await vi.advanceTimersByTimeAsync(499);
			assert.equal(saves().length, 1, 'wrote before the bounded delay');
			await vi.advanceTimersByTimeAsync(1);
			assert.deepEqual(saves().slice(1), ['two']);
		} finally {
			vi.useRealTimers();
		}
	});

	test('a window forgotten with a write pending is not written back', async () => {
		vi.useFakeTimers();
		try {
			tabManager.closeAll();
			const session = makeSession();
			await session.restore();
			calls = [];
			session.record('pending');
			await session.persistState(false);
			session.record('after forget');
			await vi.advanceTimersByTimeAsync(5000);
			assert.deepEqual(saves(), []);
			assert.equal(calls.at(-1)?.cmd, 'forget_window_state');
		} finally {
			vi.useRealTimers();
		}
	});
});

/*
 * New Window builds `window-new-<nonce>` through `create_transfer_window` and
 * stages nothing. The broker refuses a claim on an unstaged token, which would
 * surface as an error toast, so the session must not ask.
 */

describe('a new window claims nothing', () => {
	const invoked: string[] = [];

	useTauri({
		label: 'window-new-1',
		invoke: (cmd: string) => {
			invoked.push(cmd);
			return Promise.resolve(cmd === 'get_os_type' ? 'macos' : null);
		},
	});

	test('a new window claims nothing and opens with no tabs', async () => {
		const errors: unknown[] = [];
		const session = createWindowSession({
			windowStateKey: 'savedTabsDataV2',
			legacyStateKey: 'savedTabsData',
			restoreInProgressKey: 'markpad-window-restore-in-progress',
			serializeState: () => '',
			shouldRestoreState: () => false,
			isDisposed: () => false,
			restoreState: () => {},
			restoredTabs: () => [],
			loadRestoredTab: async () => {},
			dropRestoredTab: () => {},
			canTransfer: () => false,
			canDetach: () => false,
			transferPayload: () => '',
			onTransferClaimed: () => {},
			acceptTransferredTab: async () => 'arrived',
			onError: (message, error) => errors.push([message, error]),
			onWarning: (message, error) => errors.push([message, error]),
			onInterrupted: () => {},
		});

		await session.claimTransferredTab();

		assert.equal(invoked.includes('claim_detached_tab'), false);
		assert.deepEqual(errors, []);
		assert.equal(tabManager.tabs.length, 0);
	});
});

describe('pinned groups on the home page', () => {
	useTauri({
		invoke: () => Promise.resolve(null),
	});

	test('right-clicking a pinned group lists its files, with folders for duplicate names', () => {
		const loaded: string[] = [];
		const files = ['/skills/alpha/SKILL.md', '/skills/beta/SKILL.md', '/notes/todo.md'];
		const target = document.createElement('div');
		document.body.append(target);
		const home = mount(HomePage, {
			target,
			props: {
				recentFiles: [],
				pinnedTags: [{ name: 'work', color: '#f00', files }],
				onselectFile: () => {},
				onloadFile: (file: string) => loaded.push(file),
				onremoveRecentFile: () => {},
				onnewFile: () => {},
			},
		});
		flushSync();

		let documentMenuOpened = false;
		document.addEventListener('contextmenu', () => (documentMenuOpened = true), { once: true });
		const card = [...target.querySelectorAll('.recent-card')].find((el) => el.textContent?.includes('work'))!;
		card.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 10, clientY: 10 }));
		flushSync();

		const rows = [...target.querySelectorAll('.menu-item')].map((el) => el.textContent?.replace(/\s+/g, ' ').trim());
		assert.deepEqual(rows, ['SKILL.md alpha', 'SKILL.md beta', 'todo.md'], 'one row per file, same names told apart by folder');
		assert.equal(documentMenuOpened, false, 'the preview context menu must not open on top');

		(target.querySelectorAll('.menu-item')[1] as HTMLButtonElement).click();
		flushSync();
		assert.deepEqual(loaded, ['/skills/beta/SKILL.md'], 'clicking a row opens that file');
		assert.equal(target.querySelector('.menu-item'), null, 'and closes the menu');

		unmount(home);
		target.remove();
	});
});

/*
 * The race `updateStoredRecentFiles` documented but did not close.
 *
 * Re-reading before writing fixed the reported defect — a window publishing a
 * snapshot of its own stale in-memory array — but the read and the write are
 * still two calls. localStorage has no compare-and-swap and the spec's storage
 * mutex is implemented nowhere, so a sibling window's `setItem` can land
 * between them, and the entry that sibling had just added is overwritten by a
 * list computed before it existed.
 *
 * The answer here is to read back what landed and re-apply the mutation over
 * whatever list won. It works because every mutation is "apply my one change to
 * the list you hand me": promote, drop and rename are each idempotent and each
 * merge, so re-applying folds this window's change into the sibling's. Both
 * windows run it, so whoever loses an interleaving is the one that retries.
 *
 * The alternative was Rust owning the list under a `Mutex`, the way
 * `update_pinned_tags` owns the pin list. See the commit message and the note
 * on `updateStoredRecentFiles` for why that lock is available there and not
 * here.
 *
 * This file runs under vitest for jsdom's REAL localStorage: the interleaving
 * is staged by wrapping `Storage.prototype.setItem`, which a hand-written shim
 * would let the test define into existence.
 */
describe('recent-file writes race other windows', () => {
	useTauri({ invoke: async () => 'macos' });

	const KEY = 'recent-files';

	const stored = () => JSON.parse(localStorage.getItem(KEY) ?? '[]') as string[];

	function seed(files: string[]) {
		localStorage.clear();
		localStorage.setItem(KEY, JSON.stringify(files));
	}

	/**
	 * Stages window B's `setItem` landing immediately after each of window A's,
	 * `times` times over — the interleaving in which A's write is the one that
	 * loses. Returns a disposer; the caller restores in a `finally`.
	 */
	function clobberAfterWrite(value: string[], times: number) {
		const original = Storage.prototype.setItem;
		let remaining = times;
		Storage.prototype.setItem = function patched(key: string, item: string) {
			original.call(this, key, item);
			if (key === KEY && remaining > 0) {
				remaining--;
				original.call(this, key, JSON.stringify(value));
			}
		};
		return () => {
			Storage.prototype.setItem = original;
		};
	}

	test('an entry is not lost to a sibling window that writes a moment later', () => {
		// THE RACE. Both windows read `['/old.md']`; B's write lands after A's, so
		// the stored list is B's and `/from-a.md` was never in it. Unrepaired, the
		// file the user just opened in window A is simply not in their recent list.
		seed(['/old.md']);
		const restore = clobberAfterWrite(['/from-b.md', '/old.md'], 1);
		try {
			const result = updateStoredRecentFiles((current) => promoteRecentFile(current, '/from-a.md'));

			assert.deepEqual(stored(), ['/from-a.md', '/from-b.md', '/old.md'], 'the losing window did not fold its change back in');
			// ...and the window that retried knows the merged list without a reload,
			// so its own home screen is not the stale one.
			assert.deepEqual(result, stored());
		} finally {
			restore();
		}
	});

	test('a removal survives the same interleaving', () => {
		// The other direction: A's mutation is a deletion, and B's write resurrects
		// the entry A removed. Re-applying `dropRecentFile` over B's list is what
		// makes the deletion stick.
		seed(['/a.md', '/b.md']);
		const restore = clobberAfterWrite(['/c.md', '/a.md', '/b.md'], 1);
		try {
			updateStoredRecentFiles((current) => current.filter((file) => file !== '/a.md'));

			assert.deepEqual(stored(), ['/c.md', '/b.md']);
			assert.ok(!stored().includes('/a.md'), 'the deletion was undone by the other window');
		} finally {
			restore();
		}
	});

	test('a window that keeps losing gives up rather than spinning', () => {
		// The cap. A sibling that overwrites every single attempt must not turn a
		// click into an unbounded loop — N windows retrying each other is a
		// live-lock, and this runs synchronously on the main thread. Giving up costs
		// the one entry that every interleaving used to cost.
		seed(['/old.md']);
		const restore = clobberAfterWrite(['/relentless.md'], Number.MAX_SAFE_INTEGER);
		try {
			const result = updateStoredRecentFiles((current) => promoteRecentFile(current, '/from-a.md'));

			assert.deepEqual(stored(), ['/relentless.md'], 'the last writer still wins');
			assert.ok(result.includes('/from-a.md'), 'and the caller is handed the list it computed');
		} finally {
			restore();
		}
	});

	test('an uncontended write still costs exactly one setItem', () => {
		// The read-back must not become a second write: `writeStoredSetting` is
		// compare-and-set precisely so that a list which did not change fires no
		// `storage` event in the other windows, and an echoed write-back would undo
		// that. Counted through the real `Storage.prototype`.
		seed(['/a.md']);
		const original = Storage.prototype.setItem;
		const writes: string[] = [];
		Storage.prototype.setItem = function patched(key: string, item: string) {
			writes.push(key);
			original.call(this, key, item);
		};
		try {
			updateStoredRecentFiles((current) => promoteRecentFile(current, '/b.md'));
			assert.deepEqual(writes, [KEY]);

			writes.length = 0;
			updateStoredRecentFiles((current) => promoteRecentFile(current, '/b.md'));
			assert.deepEqual(writes, [], 'a list that did not change must not be written back');
		} finally {
			Storage.prototype.setItem = original;
		}
	});
});

/*
 * The folder sidebar's store against a fake disk. Runs under vitest because
 * `folder.svelte.ts` is a runes module. The Tauri bridge is stubbed: `invoke`
 * answers from `disk` and records every watch, and `listen` hands back the
 * callback so a test can fire `folder-changed` itself.
 */
describe('the folder sidebar store', () => {
	type Entry = { name: string; path: string; isDir: boolean };
	let disk: Record<string, Entry[]> = {};
	const watched = new Set<string>();
	let folderChanged: ((event: { payload: string }) => void) | null = null;
	/** How long each successive read takes to answer, in ms, in call order. */
	let readDelaysMs: number[] = [];

	function dir(path: string, ...children: string[]): void {
		disk[path] = children.map((child) => ({
			name: child.replace(/\/$/, ''),
			path: `${path}/${child.replace(/\/$/, '')}`,
			isDir: child.endsWith('/'),
		}));
	}

	function handleInvoke(command: string, args: Record<string, any>): unknown {
		switch (command) {
			case 'read_folder_entries': {
				// The listing is taken when the read starts and handed back later.
				const listing = disk[args.path];
				const delay = readDelaysMs.shift() ?? 0;
				return new Promise((resolve, reject) =>
					setTimeout(() => (listing ? resolve(listing) : reject(new Error('Not a directory'))), delay),
				);
			}
			case 'watch_folder':
				watched.add(args.path);
				return null;
			case 'unwatch_folder':
				watched.delete(args.path);
				return null;
			case 'unwatch_all_folders':
				watched.clear();
				return null;
			case 'listen':
				folderChanged = args.handler;
				return 1;
			default:
				return null;
		}
	}

	useTauri({
		invoke: async (command: string, args: Record<string, unknown>) => handleInvoke(command.replace(/^plugin:[^|]*\|/, ''), args ?? {}),
	});

	function freshDisk() {
		disk = {};
		watched.clear();
		readDelaysMs = [];
		localStorage.clear();
		dir('/notes', 'drafts/', 'a.md', 'b.txt');
		dir('/notes/drafts', 'old/', 'c.md');
		dir('/notes/drafts/old', 'd.md');
	}

	test('opening a folder reads and watches only its top level', async () => {
		freshDisk();
		const folder = new FolderManager();
		await folder.open('/notes');
		assert.deepEqual(Object.keys(folder.entries), ['/notes']);
		assert.deepEqual([...watched], ['/notes']);
		assert.equal(folder.rootName, 'notes');
	});

	test('collapsing a folder stops watching it and everything expanded under it', async () => {
		freshDisk();
		const folder = new FolderManager();
		await folder.open('/notes');
		await folder.toggle('/notes/drafts');
		await folder.toggle('/notes/drafts/old');
		assert.deepEqual([...watched].sort(), ['/notes', '/notes/drafts', '/notes/drafts/old']);

		await folder.toggle('/notes/drafts');
		assert.deepEqual([...watched], ['/notes']);
		assert.deepEqual(folder.expanded, []);
		assert.deepEqual(Object.keys(folder.entries), ['/notes']);
	});

	test('a folder-changed event re-reads that one listing', async () => {
		freshDisk();
		const folder = new FolderManager();
		await folder.open('/notes');
		dir('/notes', 'drafts/', 'a.md', 'b.txt', 'new.md');
		folderChanged?.({ payload: '/notes' });
		await new Promise((resolve) => setTimeout(resolve, 0));
		assert.deepEqual(
			folder.entries['/notes'].map((e) => e.name),
			['drafts', 'a.md', 'b.txt', 'new.md'],
		);
	});

	test('an older read of a folder that answers last does not replace a newer one', async () => {
		// Two re-reads of one folder in flight at once: a change event and the
		// Refresh button, say. The first is slow and saw the file still there; the
		// second saw it deleted. Whichever answers last used to win.
		freshDisk();
		const folder = new FolderManager();
		await folder.open('/notes');

		readDelaysMs = [30, 5];
		const older = folder.refresh();
		dir('/notes', 'drafts/', 'a.md');
		const newer = folder.refresh();
		await Promise.all([older, newer]);

		assert.deepEqual(
			folder.entries['/notes'].map((e) => e.name),
			['drafts', 'a.md'],
			'the deleted file came back from the older read',
		);
	});

	test('a subfolder that vanished collapses with everything under it', async () => {
		freshDisk();
		const folder = new FolderManager();
		await folder.open('/notes');
		await folder.toggle('/notes/drafts');
		await folder.toggle('/notes/drafts/old');
		delete disk['/notes/drafts'];
		delete disk['/notes/drafts/old'];

		await folder.refresh();
		assert.deepEqual(folder.expanded, []);
		assert.deepEqual(Object.keys(folder.entries), ['/notes']);
		assert.deepEqual([...watched], ['/notes']);
	});

	test('closing forgets the folder and its watches', async () => {
		freshDisk();
		const folder = new FolderManager();
		await folder.open('/notes');
		await folder.close();
		assert.equal(folder.root, null);
		assert.equal(watched.size, 0);
	});

	test('a saved folder that no longer exists is dropped on restore, not shown as an error', async () => {
		freshDisk();
		const folder = new FolderManager();
		await folder.restore('/gone');
		assert.equal(folder.root, null);
		assert.equal(folder.error, null);
	});

	test('each window reopens the folder its own snapshot names', async () => {
		freshDisk();
		const first = new FolderManager();
		const second = new FolderManager();
		await first.restore(snapshotFolder(JSON.stringify({ version: 2, tabs: [], folderRoot: '/notes' })));
		await second.restore(snapshotFolder(JSON.stringify({ version: 2, tabs: [] })));
		assert.equal(first.root, '/notes');
		assert.equal(second.root, null);
		assert.equal(snapshotFolder('not json'), null);
	});

	test('path helpers work on both separators', () => {
		assert.equal(folderName('/home/me/notes/'), 'notes');
		assert.equal(folderName('C:\\Users\\me\\notes'), 'notes');
		assert.ok(isInside('/a/b/c', '/a/b'));
		assert.ok(isInside('C:\\a\\b\\c', 'C:\\a\\b'));
		assert.ok(!isInside('/a/bc', '/a/b'), 'a sibling with a longer name is not inside');
		assert.ok(!isInside('/a/b', '/a/b'));
	});
});

/*
 * Issue #392, second half: "the Home tab it opens renders blank". The viewer
 * draws the home screen only when `showsHomeScreen` says so; the old gate
 * compared the tab title against 'Recents', a home tab that no longer existed,
 * so the home tab fell into the document container.
 */
describe('the home tab renders the home screen', () => {
	useTauri();

	/** True when the app draws the document container; false when it draws HomePage. */
	const showsDocumentContainer = (showHome = false) => !showsHomeScreen(tabManager.activeTab, showHome);

	function reset() {
		tabManager.closeAll();
		localStorage.clear();
	}

	// --------------------------------------------------------------- the regression

	test('the home tab renders the home screen, not an empty document', () => {
		reset();
		tabManager.addHomeTab();

		assert.equal(tabManager.activeTab?.path, HOME_TAB_PATH, 'precondition: the home tab is active');
		assert.equal(
			showsDocumentContainer(),
			false,
			'the active home tab fell into the document container: the user sees a blank page',
		);
	});

	test('a home tab opened next to files still renders the home screen', () => {
		// Ctrl+T from a window that already has documents open — the reported path.
		reset();
		tabManager.addTab('/notes/a.md');
		tabManager.addTab('/notes/b.md');
		tabManager.addHomeTab();

		assert.equal(showsDocumentContainer(), false, 'blank home tab alongside open files');
	});

	test('the home screen is reached by tab kind, never by the tab title', () => {
		// The dead half of the old gate. `title` is user-facing text: localised,
		// and for a file tab it is just a filename, so a document called
		// `Recents` used to be enough to hide the editor. Nothing about which
		// branch runs may depend on it.
		reset();
		tabManager.addHomeTab();
		const home = tabManager.activeTab!;

		for (const { code } of getSupportedLanguages()) {
			home.title = t('tabs.home', code);
			assert.equal(showsDocumentContainer(), false, `the home screen disappears in locale ${code}`);
		}

		home.title = 'Recents';
		assert.equal(showsDocumentContainer(), false, 'the pre-i18n English title must not be what makes this work');

		reset();
		tabManager.addTab('/notes/Recents');
		assert.equal(showsDocumentContainer(), true, 'a document named Recents is a document');
	});

	// ---------------------------------------------------------------- the neighbours
	//
	// The three states that already worked. They are the fence: a gate that simply
	// always chose HomePage would pass the tests above and fail every one of these.

	test('a saved file renders the document container', () => {
		reset();
		tabManager.addTab('/notes/a.md');

		assert.equal(showsDocumentContainer(), true);
	});

	test('an untitled buffer renders the document container', () => {
		// The distinction the fix rests on: an untitled tab has no file either, so
		// `hasRealFilePath` is false for both — but it IS a document, and gating on
		// that predicate would have hidden the editor for every new file.
		reset();
		tabManager.addNewTab();

		assert.equal(tabManager.activeTab?.path, '', 'precondition: an untitled tab has no path');
		assert.equal(hasRealFilePath(''), false, 'precondition: and no real file either');
		assert.equal(isHomePath(''), false, 'but it is not the home tab');
		assert.equal(showsDocumentContainer(), true, 'a new file must still get an editor');
	});

	test('an empty window renders the home screen', () => {
		reset();

		assert.equal(tabManager.activeTab, undefined);
		assert.equal(showsDocumentContainer(), false);
	});

	test('the Home toolbar button still overlays the home screen on any tab', () => {
		// `showHome` is the other, older route to the same screen: a transient flag
		// set by the toolbar/menu item, independent of any tab. It must keep
		// winning over whatever tab is active.
		reset();
		tabManager.addTab('/notes/a.md');
		assert.equal(showsDocumentContainer(true), false, 'a file tab with showHome set');

		tabManager.addNewTab();
		assert.equal(showsDocumentContainer(true), false, 'an untitled tab with showHome set');

		tabManager.addHomeTab();
		assert.equal(showsDocumentContainer(true), false, 'the home tab with showHome set');
	});

	test('switching from the home tab back to a file returns to the document', () => {
		reset();
		tabManager.addTab('/notes/a.md');
		const file = tabManager.activeTab!.id;
		tabManager.addHomeTab();
		assert.equal(showsDocumentContainer(), false);

		tabManager.setActive(file);

		assert.equal(showsDocumentContainer(), true, 'the document container must come back');
	});
});

describe('a pinned group opens in a window that holds it', () => {
	const calls: { cmd: string; args: any }[] = [];
	useTauri({
		invoke: async (cmd: string, args: any) => {
			calls.push({ cmd, args });
			if (cmd === 'get_os_type') return 'macos';
			return cmd === 'list_viewer_windows' ? [] : null;
		},
	});

	test("a window opened for a pinned group is created as the group's holder", async () => {
		// The window reports its tag only once it has mounted and read the group.
		// Until then the registry knew nothing of it, so a second click on the same
		// group opened a second window. `tagName` has the backend record the holder
		// as it creates the window. (The viewer's own route, `openPinnedTag`, is
		// asserted in windows.exit.test.ts.)
		await openPinnedTagWindow('Work');
		const create = calls.find((call) => call.cmd === 'create_transfer_window');
		assert.equal(create?.args.tagName, 'Work');
		assert.equal(pinnedTagFromWindowLabel(`window-${create?.args.token}`), 'Work');

		// And the new window does not report itself, clearing that name, before it
		// has adopted the group.
		tabManager.addTab('/notes/a.md');
		calls.length = 0;
		const metaCalls = () => calls.filter((call) => call.cmd === 'set_window_meta');
		let meta!: { markReady: () => void };
		const dispose = runeEffect(() => void (meta = reportWindowMeta(tabManager, false)));
		try {
			flushSync();
			assert.deepEqual(metaCalls(), [], 'reported before the group was adopted');
			tabManager.setWindowTag({ name: 'Work', color: '#f00', pinned: true });
			meta.markReady();
			flushSync();
			assert.equal(metaCalls().at(-1)?.args.tagName, 'Work');
		} finally {
			dispose();
		}
	});
});

describe('window organization', () => {
	// jsdom has no Web Animations, and the Home menu flies in. An animation that
	// never finishes is enough: the assertions read the menu, not the motion.
	Element.prototype.animate ??= function () {
		return { cancel() {}, playState: 'finished', effect: null, onfinish: null } as unknown as Animation;
	};
	const invoked: { cmd: string; args: any }[] = [];
	useTauri({
		invoke: (cmd: string, args: any) => {
			invoked.push({ cmd, args });
			if (cmd === 'get_os_type') return Promise.resolve('macos');
			if (cmd === 'list_pinned_tags') return Promise.resolve([]);
			if (cmd === 'list_viewer_windows') {
				return Promise.resolve([
					{ label: 'main', title: 'Main' },
					{ label: 'window-2', title: 'Other' },
				]);
			}
			return Promise.resolve(null);
		},
	});

	function mounted(Component: any, props: Record<string, unknown>) {
		const target = document.createElement('div');
		document.body.append(target);
		const instance = mount(Component, { target, props, intro: false });
		flushSync();
		return {
			target,
			[Symbol.dispose]() {
				unmount(instance);
				target.remove();
			},
		};
	}

	async function openHomeMenu(onmergeAllWindows: () => void) {
		const { default: TitleBar } = await import('../src/lib/components/TitleBar.svelte');
		tabManager.addTab('/notes/a.md', '# A document');
		const view = mounted(TitleBar, {
			isFocused: true,
			isScrolled: false,
			currentFile: '/notes/a.md',
			liveMode: false,
			windowTitle: 'a.md',
			showHome: false,
			isEditing: false,
			ontoggleHome: () => {},
			ononpenFileLocation: () => {},
			ontoggleLiveMode: () => {},
			onsetViewMode: () => {},
			onmergeAllWindows,
			theme: 'dark',
		});
		view.target.querySelector<HTMLButtonElement>('.icon-home-btn')!.click();
		flushSync();
		const items = [...view.target.querySelectorAll<HTMLButtonElement>('.home-menu-item')];
		return { view, items, labels: items.map((item) => item.textContent?.replace(/\s+/g, ' ').trim() ?? '') };
	}

	test('window organization exposes move, merge, and carry actions', async () => {
		// Move: the tab's context menu offers every other window by name, and
		// choosing one asks this window to move the tab there.
		const { default: TabView } = await import('../src/lib/components/Tab.svelte');
		tabManager.closeAll();
		tabManager.addTab('/notes/a.md', 'text');
		const tab = tabManager.activeTab!;
		{
			using view = mounted(TabView, { tab, isActive: true, onclick: () => {}, onclose: () => {} });
			view.target.querySelector('.tab')!.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
			await new Promise((resolve) => setTimeout(resolve, 0));
			flushSync();
			const moveLabel = t('menu.moveToWindow', 'en');
			const moves = [...view.target.querySelectorAll<HTMLButtonElement>('.menu-item')].filter((item) => {
				const label = item.textContent?.trim() ?? '';
				return label.startsWith(`${moveLabel} `) && label !== t('menu.moveToNewWindow', 'en');
			});
			assert.equal(moves.length, 1, 'one entry per other window, none for this one');
			invoked.length = 0;
			moves[0].click();
			const emitted = invoked.find((call) => call.cmd === 'plugin:event|emit_to');
			assert.equal(emitted?.args.event, 'menu-tab-move');
			assert.deepEqual(emitted?.args.payload, { tabId: tab.id, targetLabel: 'window-2' });
		}

		// Merge: the Home menu entry reaches the viewer's handler.
		let merged = 0;
		{
			const { view, items, labels } = await openHomeMenu(() => merged++);
			using _ = view;
			items[labels.indexOf(t('menu.mergeAllWindows', 'en'))].click();
			flushSync();
			assert.equal(merged, 1);
		}

		// Carry: the chord names the command, and the command carries the tab.
		const command = viewerCommandFor(
			{ key: 'm', code: 'KeyM', ctrlKey: true, metaKey: false, shiftKey: true, altKey: false },
			{ mode: 'app', osType: 'windows', isSplit: false, overlayOpen: false, dialogOpen: false, isEditing: false, editorHasFocus: false },
		);
		assert.equal(command, 'move-tab-to-next-window');
		const calls: string[] = [];
		const host = new Proxy({} as any, {
			get: (_, prop) => (prop === 'settings' || prop === 'tabManager' ? {} : () => void calls.push(String(prop))),
		});
		viewerCommandTable(host)[command]();
		assert.deepEqual(calls, ['carryActiveTabToNextWindow']);
	});

	test('the Home menu groups window organization below export actions', async () => {
		const { view, labels } = await openHomeMenu(() => {});
		using _ = view;
		const at = (key: string) => {
			const index = labels.findIndex((label) => label.startsWith(t(key, 'en')));
			assert.notEqual(index, -1, `${key} is in the menu`);
			return index;
		};
		assert.ok(at('menu.exportPdf') < at('menu.setWindowTag'));
		assert.ok(at('menu.setWindowTag') < at('menu.mergeAllWindows'));
		assert.ok(at('menu.mergeAllWindows') < at('menu.exit'));
	});
});
