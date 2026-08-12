import assert from 'node:assert/strict';

import { test } from 'vitest';

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
 *   2. session restore, which is where a window gets its previous state back;
 *   3. the tab-transfer claim, the only channel through which one window's
 *      content reaches another.
 *
 * `set_window_meta` is not a fourth. It is a one-way report from each window
 * into `AppState.window_registry` — `list_viewer_windows` and the exclusivity
 * check read it, and nothing writes a registry `tag_name` back into a window.
 */

// The runes are the compiler's, not ours: vitest builds `.svelte.ts` through the
// Svelte plugin, so the store and the session run under real reactivity, and
// jsdom supplies `window` and `localStorage`. Only the Tauri backend is stubbed.

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

(window as any).__TAURI_INTERNALS__ = {
	// A detached window, which is what `create_transfer_window` builds.
	metadata: {
		currentWindow: { label: 'window-abc' },
		currentWebview: { windowLabel: 'window-abc', label: 'window-abc' },
	},
	invoke: (cmd: string, args: any) => {
		invokeCalls.push({ cmd, args });
		switch (cmd) {
			case 'get_os_type':
				return Promise.resolve('macos');
			case 'load_window_state':
				return Promise.resolve(TAGGED_SNAPSHOT);
			case 'claim_detached_tab':
				return Promise.resolve(TRANSFER_PAYLOAD);
			case 'read_file_content_checked':
				return Promise.resolve(['# a', false, 'UTF-8']);
			default:
				return Promise.resolve(null);
		}
	},
};

const { tabManager } = await import('../src/lib/stores/tabs.svelte.js');
const { createWindowSession } = await import('../src/lib/sessions/windowSession.svelte.js');
const { snapshotTab, validateTransferPayload } = await import('../src/lib/utils/tabTransfer.js');

// Read before any test runs, so this is the value the module was constructed
// with rather than one a neighbouring test happened to leave behind.
const INITIAL_WINDOW_TAG = tabManager.windowTag;

function makeSession(isMainWindow: boolean) {
	return createWindowSession({
		isMainWindow,
		windowStateKey: WINDOW_STATE_KEY,
		legacyStateKey: LEGACY_STATE_KEY,
		restoreInProgressKey: RESTORE_IN_PROGRESS_KEY,
		serializeState: () => tabManager.serializeState(),
		shouldRestoreState: () => true,
		isDisposed: () => false,
		restoreState: (json) => tabManager.restoreState(json),
		restoredTabs: () => tabManager.tabs.map((tab) => ({ id: tab.id, path: tab.path })),
		applyRestoredContent: async (tabId, raw) => {
			const tab = tabManager.tabs.find((item) => item.id === tabId);
			if (!tab) return;
			tab.rawContent = raw;
			tab.originalContent = raw;
		},
		dropRestoredTab: (tabId) => tabManager.closeTab(tabId),
		canTransfer: () => true,
		canDetach: () => true,
		transferPayload: () => '',
		onTransferClaimed: () => {},
		acceptTransferredTab: async (tab) => {
			tabManager.addTab(tab.path, tab.rawContent);
			return true;
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
}

test('a freshly constructed TabManager holds no window tag', () => {
	assert.equal(INITIAL_WINDOW_TAG, null, 'the store starts a window off under a tag');
});

test('a detached window does not restore, so it cannot pick up the tag in the snapshot', async () => {
	reset();

	await makeSession(false).restore();

	assert.equal(tabManager.windowTag, null, 'a new window came up wearing the saved window tag');
	assert.deepEqual(tabManager.tabs, [], 'a new window restored the previous session');
	assert.equal(
		invokeCalls.filter((call) => call.cmd === 'load_window_state').length,
		0,
		'a new window read the saved session at all',
	);
});

test('the main window does restore its own tag — this is not a test that restore is broken', async () => {
	// The fence. Without it the test above passes for a build that simply never
	// restores anything, which is a much worse defect than the one it guards.
	reset();

	await makeSession(true).restore();

	assert.deepEqual(
		tabManager.windowTag,
		{ name: 'Research', color: '#188038', pinned: true },
		'the window that wrote the snapshot did not get its own tag back',
	);
	assert.equal(tabManager.tabs.length, 1, 'the snapshot’s tabs were not restored');
});

test('a claimed tab brings no tag with it', async () => {
	// The detach path, end to end: the destination window boots, claims the
	// staged payload and builds the tab. The payload here deliberately carries
	// a `windowTag` field a source window might one day add; the validator's
	// job is to hand on only what it knows about.
	reset();

	const claimed = await makeSession(false).acceptOfferedTransfer('abc');

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
