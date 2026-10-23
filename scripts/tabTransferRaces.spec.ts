import assert from 'node:assert/strict';

import { flushSync } from 'svelte';
import { afterEach, test, vi } from 'vitest';

/*
 * Moving a tab to another window takes a snapshot when it starts and closes
 * the source tab when the destination completes, one to two seconds later.
 * These drive the source and destination halves of `windowSession` against a
 * scripted broker: the session and the tab store run for real, only the Tauri
 * backend is stubbed.
 */

type Handler = (event: { event: string; id: number; payload: unknown }) => void;

const listeners = new Map<number, { event: string; handler: Handler }>();
let nextListener = 1;
let calls: Array<{ cmd: string; args: any }> = [];
let respond: (cmd: string, args: any) => unknown = () => null;

(window as any).__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => {} };
(window as any).__TAURI_INTERNALS__ = {
	metadata: {
		currentWindow: { label: 'main' },
		currentWebview: { windowLabel: 'main', label: 'main' },
	},
	transformCallback: (fn: unknown) => fn,
	invoke: async (cmd: string, args: any) => {
		if (cmd === 'plugin:event|listen') {
			const id = nextListener++;
			listeners.set(id, { event: args.event, handler: args.handler });
			return id;
		}
		if (cmd === 'plugin:event|unlisten') {
			listeners.delete(args.eventId);
			return null;
		}
		if (cmd === 'get_os_type') return 'macos';
		calls.push({ cmd, args });
		return respond(cmd, args);
	},
};

const { tabManager } = await import('../src/lib/stores/tabs.svelte.js');
const { createWindowSession } = await import('../src/lib/sessions/windowSession.svelte.js');

const TOKEN = 'tok';

function emit(event: string, payload: unknown) {
	for (const [id, listener] of listeners) {
		if (listener.event === event) listener.handler({ event, id, payload });
	}
}

/** Lets pending IPC promises resolve and effects flush. */
async function settle() {
	for (let i = 0; i < 20; i++) {
		flushSync();
		await Promise.resolve();
	}
}

function makeSession(accept: () => Promise<string | null> = async () => null) {
	const claimed: string[] = [];
	const session = createWindowSession({
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
		canTransfer: () => true,
		canDetach: () => true,
		transferPayload: (tabId) => tabManager.tabs.find((tab) => tab.id === tabId)!.rawContent,
		onTransferClaimed: (tabId) => {
			claimed.push(tabId);
			tabManager.closeTab(tabId);
		},
		acceptTransferredTab: accept,
		onError: () => {},
		onWarning: () => {},
		onInterrupted: () => {},
	});
	return { session, claimed };
}

function openTab(text: string) {
	tabManager.addTab('/notes/a.md', text);
	return tabManager.activeTabId!;
}

afterEach(() => {
	vi.useRealTimers();
	tabManager.closeAll();
	listeners.clear();
	calls = [];
	respond = () => null;
});

test('typing before the destination claims travels with the tab', async () => {
	respond = (cmd) => (cmd === 'stage_detached_tab' ? TOKEN : cmd === 'refresh_detached_tab' ? 'updated' : null);
	const tabId = openTab('first');
	const { session } = makeSession();

	const moving = session.transfer(tabId, async () => {});
	await settle();
	tabManager.updateTabRawContent(tabId, 'first, then more');
	await settle();

	const refresh = calls.find((call) => call.cmd === 'refresh_detached_tab');
	assert.ok(refresh, 'the edit never reached the broker; the destination claims the stale snapshot');
	assert.equal(refresh.args.payload, 'first, then more');

	emit('tab-transfer-claimed', TOKEN);
	assert.equal(await moving, true);
	assert.equal(tabManager.tabs.length, 0);
});

test('an edit after the claim withdraws the transfer and the source keeps its tab', async () => {
	respond = (cmd) => (cmd === 'stage_detached_tab' ? TOKEN : cmd === 'refresh_detached_tab' ? 'revoked' : null);
	const tabId = openTab('first');
	const { session, claimed } = makeSession();

	const moving = session.transfer(tabId, async () => {});
	await settle();
	tabManager.updateTabRawContent(tabId, 'typed while the new window rendered');
	await settle();

	assert.equal(await moving, false);
	assert.deepEqual(claimed, []);
	assert.equal(tabManager.tabs[0]?.rawContent, 'typed while the new window rendered');
});

test('a completion that overtook the last edit does not close the edited tab', async () => {
	// The refresh lands after `complete` took the entry: the broker says
	// `gone` and `tab-transfer-claimed` is already on its way.
	respond = (cmd) => (cmd === 'stage_detached_tab' ? TOKEN : cmd === 'refresh_detached_tab' ? 'gone' : null);
	const tabId = openTab('first');
	const { session, claimed } = makeSession();

	const moving = session.transfer(tabId, async () => {});
	await settle();
	tabManager.updateTabRawContent(tabId, 'last keystroke');
	await settle();
	emit('tab-transfer-claimed', TOKEN);

	assert.equal(await moving, false);
	assert.deepEqual(claimed, []);
	assert.equal(tabManager.tabs[0]?.rawContent, 'last keystroke');
});

test('a destination whose completion is refused drops the tab it built', async () => {
	respond = (cmd) => {
		if (cmd === 'claim_detached_tab') {
			return JSON.stringify({
				path: '/notes/a.md',
				title: 'a.md',
				rawContent: 'old',
				originalContent: 'old',
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
				history: [],
			});
		}
		if (cmd === 'complete_detached_tab') {
			return Promise.reject('TRANSFER_NOT_FOUND: the staged tab is gone; the source window kept it');
		}
		return null;
	};
	const { session } = makeSession(async () => openTab('old'));

	assert.equal(await session.acceptOfferedTransfer(TOKEN), false);
	assert.equal(tabManager.tabs.length, 0, 'the source kept the tab, so this copy is a duplicate');
});

test('a claim the destination never completes is handed back after its grace', async () => {
	vi.useFakeTimers();
	// Claimed, then the destination window died: the broker protects the
	// claim for a while and then lets the source cancel it.
	const outcomes = [
		{ cancelled: false, claimed: true },
		{ cancelled: false, claimed: true },
		{ cancelled: true, claimed: true },
	];
	respond = (cmd) => (cmd === 'stage_detached_tab' ? TOKEN : cmd === 'cancel_detached_tab' ? outcomes.shift() : null);
	const tabId = openTab('doc');
	const { session } = makeSession();

	let result: boolean | undefined;
	void session.transfer(tabId, async () => {}).then((moved) => (result = moved));
	for (let i = 0; i < 4; i++) {
		await vi.advanceTimersByTimeAsync(15_000);
		await settle();
	}

	assert.equal(result, false, 'the source stopped asking after one refusal and stayed stuck');
	assert.equal(tabManager.tabs.length, 1);
	// The tab is movable again.
	assert.equal(calls.filter((call) => call.cmd === 'stage_detached_tab').length, 1);
	void session.transfer(tabId, async () => {});
	await settle();
	assert.equal(calls.filter((call) => call.cmd === 'stage_detached_tab').length, 2);
});
