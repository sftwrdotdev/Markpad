import assert from 'node:assert/strict';

import { test, vi } from 'vitest';

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
