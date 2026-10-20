import assert from 'node:assert/strict';

import { test } from 'vitest';

// #767. There is one snapshot slot, and startup restores it into main whoever
// wrote it. A detached window left on its own used to skip writing it, so the
// next launch brought back main's older tabs instead of the ones on screen.

let viewerWindows: Array<{ label: string }> = [];
let saved: string | null = null;

(window as any).__TAURI_INTERNALS__ = {
	metadata: {
		currentWindow: { label: 'window-abc' },
		currentWebview: { windowLabel: 'window-abc', label: 'window-abc' },
	},
	invoke: (cmd: string, args: any) => {
		switch (cmd) {
			case 'get_os_type':
				return Promise.resolve('macos');
			case 'list_viewer_windows':
				return Promise.resolve(viewerWindows);
			case 'save_window_state':
				saved = args.json;
				return Promise.resolve(null);
			default:
				return Promise.resolve(null);
		}
	},
};

const { tabManager } = await import('../src/lib/stores/tabs.svelte.js');
const { createWindowSession } = await import('../src/lib/sessions/windowSession.svelte.js');

async function persistFromDetachedWindow(open: string[]) {
	tabManager.closeAll();
	tabManager.addTab('/notes/a.md', '# a');
	viewerWindows = open.map((label) => ({ label }));
	saved = null;
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
	}).persistState();
}

test('the last window left writes the session, though it is not main', async () => {
	await persistFromDetachedWindow(['window-abc']);
	assert.deepEqual(
		JSON.parse(saved ?? '{"tabs":[]}').tabs.map((tab: { path: string }) => tab.path),
		['/notes/a.md'],
	);
});

test('while another window is open, a detached window leaves the session alone', async () => {
	await persistFromDetachedWindow(['main', 'window-abc']);
	assert.equal(saved, null);
});

test('a registry that has not heard from this window yet does not make it the last one', async () => {
	await persistFromDetachedWindow(['main']);
	assert.equal(saved, null);
});
