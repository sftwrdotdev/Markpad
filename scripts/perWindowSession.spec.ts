import assert from 'node:assert/strict';

import { test } from 'vitest';

// Every window keeps its own snapshot, keyed by its label on the Rust side. A
// secondary window writes its snapshot whoever else is open, and nobody else's:
// that is what lets each window come back on relaunch, and what ended the quit
// race where the last window to close overwrote main's single slot.

let calls: Array<{ cmd: string; args: any }> = [];

(window as any).__TAURI_INTERNALS__ = {
	metadata: {
		currentWindow: { label: 'window-abc' },
		currentWebview: { windowLabel: 'window-abc', label: 'window-abc' },
	},
	invoke: (cmd: string, args: any) => {
		calls.push({ cmd, args });
		return Promise.resolve(cmd === 'get_os_type' ? 'macos' : null);
	},
};

const { tabManager } = await import('../src/lib/stores/tabs.svelte.js');
const { createWindowSession } = await import('../src/lib/sessions/windowSession.svelte.js');

async function persistFromDetachedWindow(remember: boolean) {
	tabManager.closeAll();
	tabManager.addTab('/notes/a.md', '# a');
	calls = [];
	await createWindowSession({
		isMainWindow: false,
		windowStateKey: 'savedTabsDataV2',
		legacyStateKey: 'savedTabsData',
		restoreInProgressKey: 'markpad-window-restore-in-progress',
		serializeState: () => tabManager.serializeState(),
		shouldRestoreState: () => true,
		isDisposed: () => false,
		restoreState: () => {},
		restoredTabs: () => [],
		applyRestoredContent: async () => {},
		dropRestoredTab: () => {},
		canTransfer: () => true,
		canDetach: () => true,
		transferPayload: () => '',
		onTransferClaimed: () => {},
		acceptTransferredTab: async () => true,
		onError: () => {},
		onWarning: () => {},
		onInterrupted: () => {},
	}).persistState(remember);
}

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
