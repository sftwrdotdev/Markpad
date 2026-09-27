import assert from 'node:assert/strict';

import { test } from 'vitest';

// A moved tab is snapshotted when the transfer is staged, and the source closes
// it when the destination claims it. The destination window takes a while to
// appear, and the source keeps focus the whole time, so anything written into
// the tab in between was closed with it: typing kept going into a tab whose
// copy had already left, and an auto-save moved the baseline the arriving copy
// would compare the disk against.

const TOKEN = 'token-1';
let claimedHandler: ((event: { payload: string }) => void) | null = null;
let stagedPayload: string | null = null;
let saves = 0;

(window as any).__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => {} };
(window as any).__TAURI_INTERNALS__ = {
	metadata: { currentWindow: { label: 'main' }, currentWebview: { windowLabel: 'main', label: 'main' } },
	transformCallback: (fn: unknown) => fn,
	invoke: (cmd: string, args: any) => {
		switch (cmd) {
			case 'get_os_type':
				return Promise.resolve('macos');
			case 'stage_detached_tab':
				stagedPayload = args.payload;
				return Promise.resolve(TOKEN);
			case 'plugin:event|listen':
				if (args.event === 'tab-transfer-claimed') claimedHandler = args.handler;
				return Promise.resolve(1);
			case 'cancel_detached_tab':
				return Promise.resolve({ cancelled: true, claimed: false });
			case 'read_file_content_checked':
				return Promise.resolve([tabManager.activeTab?.originalContent ?? '', false, 'UTF-8']);
			case 'save_file_content':
				saves += 1;
				return Promise.resolve(null);
			default:
				return Promise.resolve(null);
		}
	},
};

const { tabManager } = await import('../src/lib/stores/tabs.svelte.js');
const { createWindowSession } = await import('../src/lib/sessions/windowSession.svelte.js');
const { createDocumentSession } = await import('../src/lib/sessions/documentSession.svelte.js');
const { snapshotTab } = await import('../src/lib/utils/tabTransfer.js');

function makeWindowSession() {
	return createWindowSession({
		isMainWindow: true,
		windowStateKey: 'savedTabsDataV2',
		legacyStateKey: 'savedTabsData',
		restoreInProgressKey: 'markpad-window-restore-in-progress',
		serializeState: () => tabManager.serializeState(),
		shouldRestoreState: () => false,
		isDisposed: () => false,
		restoreState: () => {},
		restoredTabs: () => [],
		applyRestoredContent: async () => {},
		dropRestoredTab: () => {},
		canTransfer: () => true,
		canDetach: () => true,
		transferPayload: (tabId) => JSON.stringify(snapshotTab(tabManager.tabs.find((tab) => tab.id === tabId)!)),
		onTransferClaimed: (tabId) => tabManager.closeTab(tabId),
		acceptTransferredTab: async () => true,
		onError: () => {},
		onWarning: () => {},
		onInterrupted: () => {},
	});
}

function makeDocumentSession() {
	return createDocumentSession({
		setShowHome: () => {},
		currentFile: () => tabManager.activeTab?.path ?? '',
		resetScrollHistory: () => {},
		renderMarkdown: async () => '<p>x</p>',
		afterLoad: async () => {},
		saveRecentFile: () => {},
		deleteRecentFile: () => {},
		setLoadingTabs: () => {},
		measureInitialViewport: () => {},
		isScrolling: () => false,
		renderRichContent: () => {},
		onError: () => {},
		onDiskChangedUnderSave: () => {},
		cancelPendingAutoSave: () => {},
		askClose: async () => 'discard' as const,
		onCloseSaveNewerEdits: () => {},
		onCloseAutoSaveFailed: () => {},
		onPartialCopySaved: () => {},
	});
}

/** Open a dirty tab and start moving it; returns once the snapshot is staged. */
async function startMove(deliver: () => Promise<void> = () => Promise.resolve()) {
	tabManager.closeAll();
	claimedHandler = null;
	stagedPayload = null;
	saves = 0;
	tabManager.addTab('/notes/a.md', 'saved');
	const id = tabManager.activeTabId!;
	tabManager.updateTabRawContent(id, 'sent');
	const moved = makeWindowSession().transfer(id, deliver);
	while (!claimedHandler) await new Promise((resolve) => setTimeout(resolve, 0));
	const tab = tabManager.tabs.find((item) => item.id === id)!;
	return { id, tab, moved };
}

test('keys typed while the move is in flight are not closed with the source tab', async () => {
	const { id, tab, moved } = await startMove();

	tabManager.updateTabRawContent(id, 'sent and typed afterwards');
	// What the claim is about to close must be exactly what left.
	const sent = JSON.parse(stagedPayload!);
	assert.equal(tab.rawContent, sent.rawContent);

	claimedHandler!({ payload: TOKEN });
	assert.equal(await moved, true);
	assert.equal(tabManager.tabs.some((item) => item.id === id), false);
});

test('a save during the move does not move the baseline the arriving copy carries', async () => {
	const { id, tab, moved } = await startMove();

	assert.equal(await makeDocumentSession().saveContent(id), false);
	assert.equal(saves, 0);
	assert.equal(tab.originalContent, JSON.parse(stagedPayload!).originalContent);

	claimedHandler!({ payload: TOKEN });
	await moved;
});

test('a move that fails hands the tab back editable', async () => {
	const { id, tab, moved } = await startMove(() => Promise.reject(new Error('no window')));
	assert.equal(await moved, false);

	tabManager.updateTabRawContent(id, 'typed after the failure');
	assert.equal(tab.rawContent, 'typed after the failure');
	assert.equal(await makeDocumentSession().saveContent(id), true);
});
