import assert from 'node:assert/strict';

import { test } from 'vitest';

/*
 * New Window builds `window-new-<nonce>` through `create_transfer_window` and
 * stages nothing. The broker refuses a claim on an unstaged token, which would
 * surface as an error toast, so the session must not ask.
 */

const invoked: string[] = [];

(window as any).__TAURI_INTERNALS__ = {
	metadata: {
		currentWindow: { label: 'window-new-1' },
		currentWebview: { windowLabel: 'window-new-1', label: 'window-new-1' },
	},
	invoke: (cmd: string) => {
		invoked.push(cmd);
		return Promise.resolve(cmd === 'get_os_type' ? 'macos' : null);
	},
};

const { createWindowSession } = await import('../src/lib/sessions/windowSession.svelte.js');
const { tabManager } = await import('../src/lib/stores/tabs.svelte.js');

test('a new window claims nothing and opens with no tabs', async () => {
	const errors: unknown[] = [];
	const session = createWindowSession({
		isMainWindow: false,
		windowStateKey: 'savedTabsDataV2',
		legacyStateKey: 'savedTabsData',
		restoreInProgressKey: 'markpad-window-restore-in-progress',
		serializeState: () => '',
		shouldRestoreState: () => false,
		isDisposed: () => false,
		restoreState: () => {},
		restoredTabs: () => [],
		applyRestoredContent: async () => {},
		dropRestoredTab: () => {},
		canTransfer: () => false,
		canDetach: () => false,
		transferPayload: () => '',
		onTransferClaimed: () => {},
		acceptTransferredTab: async () => true,
		onError: (message, error) => errors.push([message, error]),
		onWarning: (message, error) => errors.push([message, error]),
		onInterrupted: () => {},
	});

	await session.claimTransferredTab();

	assert.equal(invoked.includes('claim_detached_tab'), false);
	assert.deepEqual(errors, []);
	assert.equal(tabManager.tabs.length, 0);
});
