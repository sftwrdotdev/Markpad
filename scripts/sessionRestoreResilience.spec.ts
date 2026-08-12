import assert from 'node:assert/strict';

import { test } from 'vitest';

// Startup restore is a data-safety path: the snapshot is the only record of
// which documents the user had open. Two ways it used to destroy that record:
//
// 1. A file that could not be read had its tab dropped, and the trimmed list
//    was written straight back to disk. A share that was down for a minute, a
//    drive that was not plugged in, a file another program had locked — the
//    tab was gone for good.
// 2. A restore that never finished left a breadcrumb, and the next launch
//    reacted by deleting the whole snapshot. One document took the session
//    down with it.
//
// These tests drive the real window session and the real TabManager against a
// stubbed Tauri bridge and a stubbed localStorage, so they lock the behaviour
// rather than the wording. The tests in the first half simulate an interrupted
// launch by leaving behind exactly the breadcrumb such a launch leaves; the
// `launch()` harness at the bottom goes further and models the kill itself,
// including what a kill takes with it.

// The runes are the compiler's, not ours: vitest builds `.svelte.ts` through the
// Svelte plugin, so the store and the session run under real reactivity, and
// jsdom supplies `window` and `localStorage`. Only the Tauri backend is stubbed.

const WINDOW_STATE_KEY = 'savedTabsDataV2';
const LEGACY_STATE_KEY = 'savedTabsData';
const RESTORE_IN_PROGRESS_KEY = 'markpad-window-restore-in-progress';

let invokeCalls: Array<{ cmd: string; args: any }> = [];
/** The window-state file the Rust side holds. */
let storedSnapshot: string | null = null;
/** The breadcrumb file the Rust side holds, beside the snapshot. */
let storedProgress: string | null = null;
/** Files the backend can read; anything else fails the way a real read does. */
let disk = new Map<string, string>();
/** Paths whose read should fail even though the file "exists". */
let unreadable = new Set<string>();
/** Called just before each read, to observe the breadcrumb mid-restore. */
let onRead: (path: string) => void = () => {};

/**
 * When this says yes, the process is gone: the call never answers and nothing
 * after it runs. See `launch()` for what that models and what it costs.
 */
let killsTheLaunch: (call: { cmd: string; args: any }) => boolean = () => false;
let died = false;

(window as any).__TAURI_INTERNALS__ = {
	metadata: { currentWindow: { label: 'main' }, currentWebview: { windowLabel: 'main', label: 'main' } },
	invoke: (cmd: string, args: any) => {
		invokeCalls.push({ cmd, args });
		if (!died && killsTheLaunch({ cmd, args })) {
			died = true;
			// A process that has been killed does not return an error — it does
			// not return. A rejection here would be caught and handled, which is
			// the one thing a real kill never lets the code do.
			return new Promise(() => {});
		}
		switch (cmd) {
			case 'get_os_type':
				return Promise.resolve('macos');
			case 'load_window_state':
				return Promise.resolve(storedSnapshot);
			case 'save_window_state':
				storedSnapshot = args.json;
				return Promise.resolve(null);
			case 'clear_window_state':
				storedSnapshot = null;
				return Promise.resolve(null);
			case 'load_restore_progress':
				return Promise.resolve(storedProgress);
			case 'save_restore_progress':
				storedProgress = args.json;
				return Promise.resolve(null);
			case 'clear_restore_progress':
				storedProgress = null;
				return Promise.resolve(null);
			case 'read_file_content_checked': {
				onRead(args.path);
				if (unreadable.has(args.path) || !disk.has(args.path)) {
					return Promise.reject(new Error(`cannot read ${args.path}`));
				}
				return Promise.resolve([disk.get(args.path), false]);
			}
			default:
				return Promise.resolve(null);
		}
	},
};

const { tabManager } = await import('../src/lib/stores/tabs.svelte.js');
const { createWindowSession } = await import('../src/lib/sessions/windowSession.svelte.js');

const warnings: string[] = [];
const errors: string[] = [];
/** What the session asked the UI to tell the user, before any wording. */
const notices: Array<{ deferredPath: string | null }> = [];

function makeSession() {
	return createWindowSession({
		isMainWindow: true,
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
		acceptTransferredTab: async () => true,
		onError: (message) => errors.push(message),
		onWarning: (message) => warnings.push(message),
		onInterrupted: (interruption) => notices.push(interruption),
	});
}

function snapshotOf(paths: string[]): string {
	return JSON.stringify({
		version: 2,
		activeTabId: null,
		tabs: paths.map((path, index) => ({ id: `tab-${index}`, path, title: path })),
	});
}

function reset(paths: string[], contents: Record<string, string> = {}) {
	tabManager.closeAll();
	tabManager.recentlyClosed.length = 0;
	localStorage.clear();
	invokeCalls = [];
	warnings.length = 0;
	errors.length = 0;
	notices.length = 0;
	unreadable = new Set();
	onRead = () => {};
	killsTheLaunch = () => false;
	died = false;
	disk = new Map(paths.map((path) => [path, contents[path] ?? `# ${path}`]));
	storedSnapshot = snapshotOf(paths);
	storedProgress = null;
}

/**
 * The breadcrumb as the next launch would find it. It is read from the Rust
 * side because that is where it lives now: the tests below seed the
 * localStorage key instead where they mean "a breadcrumb an older build left",
 * and the session honours that as a migration.
 */
function breadcrumb(): any {
	return storedProgress === null ? null : JSON.parse(storedProgress);
}

function persistedPaths(): string[] {
	return storedSnapshot ? JSON.parse(storedSnapshot).tabs.map((tab: { path: string }) => tab.path) : [];
}

const readsOf = () => invokeCalls.filter((call) => call.cmd === 'read_file_content_checked').map((call) => call.args.path);

// --- a read that fails is not a decision to close the document ---

test('a file that cannot be read keeps its tab', async () => {
	reset(['/a.md', '/away.md', '/c.md']);
	unreadable.add('/away.md');

	await makeSession().restore();

	assert.deepEqual(
		tabManager.tabs.map((tab) => tab.path),
		['/a.md', '/away.md', '/c.md'],
	);
	assert.ok(
		warnings.some((message) => message.includes('could not be read')),
		'the failure is reported, not silent',
	);
});

test('the failed read is not written back into the snapshot', async () => {
	reset(['/a.md', '/away.md']);
	unreadable.add('/away.md');

	await makeSession().restore();

	// This is the whole bug: the trimmed list used to be persisted right after
	// the loop, so the tab never came back even once the drive was plugged in.
	assert.deepEqual(persistedPaths(), ['/a.md', '/away.md']);
});

test('the empty buffer of an unreadable tab is flagged so nothing can save it over the file', async () => {
	reset(['/away.md']);
	unreadable.add('/away.md');

	await makeSession().restore();

	const tab = tabManager.tabs[0];
	assert.equal(tab.rawContent, '');
	assert.equal(tab.isDirty, false);
	// `isTruncated` is the existing "this buffer is not the whole file" flag:
	// every writer already refuses it and `ensureFullContent` re-reads the file
	// the next time the tab is opened for editing.
	assert.equal(tab.isTruncated, true);
});

test('the documents that did read are restored normally', async () => {
	reset(['/a.md', '/away.md'], { '/a.md': '# hello' });
	unreadable.add('/away.md');

	await makeSession().restore();

	const readable = tabManager.tabs.find((tab) => tab.path === '/a.md')!;
	assert.equal(readable.rawContent, '# hello');
	assert.notEqual(readable.isTruncated, true);
});

// --- an interrupted restore costs one document, not the session ---

test('an interrupted restore names the document it was on', async () => {
	reset(['/a.md', '/big.md', '/c.md']);
	const seen: Array<string | null> = [];
	onRead = () => seen.push(breadcrumb()?.pending ?? null);

	await makeSession().restore();

	// The breadcrumb has to be updated per document; a flag that only says "a
	// restore was running" cannot tell the next launch what to skip.
	assert.deepEqual(seen, ['/a.md', '/big.md', '/c.md']);
});

test('the launch after an interruption restores everything except the suspect', async () => {
	reset(['/a.md', '/big.md', '/c.md']);
	localStorage.setItem(
		RESTORE_IN_PROGRESS_KEY,
		JSON.stringify({ running: true, pending: '/big.md', deferred: [], interruptions: 0 }),
	);

	await makeSession().restore();

	assert.deepEqual(readsOf(), ['/a.md', '/c.md'], 'the suspect is not read again');
	assert.deepEqual(
		tabManager.tabs.map((tab) => tab.path),
		['/a.md', '/big.md', '/c.md'],
		'every tab is still there, including the deferred one',
	);
	assert.deepEqual(persistedPaths(), ['/a.md', '/big.md', '/c.md']);
	assert.equal(storedSnapshot !== null, true, 'the snapshot is never discarded');
	assert.equal(
		invokeCalls.some((call) => call.cmd === 'clear_window_state'),
		false,
	);
});

test('a breadcrumb from an older build no longer wipes the session', async () => {
	reset(['/a.md', '/b.md']);
	// Pre-fix builds wrote the string 'true' and the next launch deleted the
	// entire snapshot on sight.
	localStorage.setItem(RESTORE_IN_PROGRESS_KEY, 'true');

	await makeSession().restore();

	assert.deepEqual(
		tabManager.tabs.map((tab) => tab.path),
		['/a.md', '/b.md'],
	);
	assert.equal(
		invokeCalls.some((call) => call.cmd === 'clear_window_state'),
		false,
	);
	// It names no suspect, so it costs one retry rather than one document.
	assert.deepEqual(readsOf(), ['/a.md', '/b.md']);
});

test('a finished restore leaves no breadcrumb behind', async () => {
	reset(['/a.md']);

	await makeSession().restore();

	assert.equal(breadcrumb(), null);
});

test('deferrals accumulate one document per interruption instead of retrying forever', async () => {
	reset(['/a.md', '/one.md', '/two.md']);
	localStorage.setItem(
		RESTORE_IN_PROGRESS_KEY,
		JSON.stringify({ running: true, pending: '/one.md', deferred: [], interruptions: 0 }),
	);
	await makeSession().restore();
	assert.deepEqual(breadcrumb().deferred, ['/one.md']);

	// The next launch dies on a different document.
	reset(['/a.md', '/one.md', '/two.md']);
	localStorage.setItem(
		RESTORE_IN_PROGRESS_KEY,
		JSON.stringify({ running: true, pending: '/two.md', deferred: ['/one.md'], interruptions: 1 }),
	);

	await makeSession().restore();

	assert.deepEqual(readsOf(), ['/a.md']);
	assert.deepEqual(
		tabManager.tabs.map((tab) => tab.path),
		['/a.md', '/one.md', '/two.md'],
	);
	assert.deepEqual(breadcrumb().deferred, ['/one.md', '/two.md']);
});

test('after repeated interruptions startup stops reading but still hands back every tab', async () => {
	reset(['/a.md', '/b.md', '/c.md']);
	localStorage.setItem(
		RESTORE_IN_PROGRESS_KEY,
		JSON.stringify({ running: true, pending: null, deferred: [], interruptions: 2 }),
	);

	await makeSession().restore();

	assert.deepEqual(readsOf(), [], 'a third interrupted launch stops opening documents by itself');
	assert.deepEqual(
		tabManager.tabs.map((tab) => tab.path),
		['/a.md', '/b.md', '/c.md'],
	);
	assert.deepEqual(persistedPaths(), ['/a.md', '/b.md', '/c.md']);
	for (const tab of tabManager.tabs) assert.equal(tab.isTruncated, true);
});

// --- the HOME sentinel never reaches the backend ---

test('a HOME entry in an older snapshot is never read as a file', async () => {
	reset(['/a.md']);
	storedSnapshot = snapshotOf(['HOME', '/a.md']);

	await makeSession().restore();

	// A sentinel is not a file that might come back later, so it is dropped
	// rather than kept as an unreadable tab.
	assert.equal(readsOf().includes('HOME'), false);
	assert.deepEqual(
		tabManager.tabs.map((tab) => tab.path),
		['/a.md'],
	);
	assert.deepEqual(persistedPaths(), ['/a.md']);
});

test('a snapshot of nothing but HOME does not cost the window its session', async () => {
	reset([]);
	storedSnapshot = snapshotOf(['HOME']);

	await makeSession().restore();

	assert.deepEqual(tabManager.tabs, []);
	assert.equal(
		invokeCalls.some((call) => call.cmd === 'read_file_content_checked'),
		false,
	);
});

// --- a launch killed at any point costs at most one repeat ---
//
// The tests above all begin from a breadcrumb that a dead launch is ASSUMED to
// have left. That assumption is the thing #201 disproves: the breadcrumb lived
// in localStorage, `setItem` is an async message to the WebKit storage process,
// and the kill this record exists to survive is exactly the event that loses
// messages in flight. A test that seeds the breadcrumb by hand cannot see that
// — it will pass whatever store the record is kept in, which is why the
// mechanism could be complete, tested, and still leave the reporter relaunching
// into the same hang.
//
// So these run the kill instead of assuming its result. `launch()` models three
// things about a killed process, and the second is the one that bites:
//
//   1. the call it died in never answers, and nothing after it runs;
//   2. whatever the launch had put in localStorage is gone with it;
//   3. whatever reached the backend is still there when the next one starts.
//
// (2) is the pessimistic reading — a real kill sometimes loses the write and
// sometimes does not — and it is the right one for a resilience contract: the
// guarantee worth having is the one that holds when the flush does not happen.
// It is also what the repository already concluded about this exact store, in
// the comment above `persistWindowState`.

/** Lets every already-queued microtask run, then returns. */
const flush = () => new Promise((resolve) => setImmediate(resolve));

/**
 * One launch of Markpad against the world the previous launches left behind.
 *
 * Returns 'died' if `dies` fired, 'restored' if the pass ran to completion.
 * A killed launch never resolves — that is what being killed means — so this
 * cannot simply await `restore()`.
 */
async function launch(dies: (call: { cmd: string; args: any }) => boolean = () => false) {
	// A new process: no tabs on screen, and nothing left of the store the last
	// kill took down with it.
	tabManager.closeAll();
	localStorage.clear();
	died = false;
	killsTheLaunch = dies;

	let settled = false;
	void makeSession()
		.restore()
		.then(
			() => (settled = true),
			() => (settled = true),
		);
	for (let turn = 0; turn < 200 && !settled && !died; turn++) await flush();
	killsTheLaunch = () => false;

	// Without this the harness could report 'restored' for a launch that merely
	// ran out of turns, and every assertion below would be measuring the loop
	// bound instead of the mechanism.
	assert.ok(settled || died, 'the simulated launch neither finished nor died');
	return died ? 'died' : 'restored';
}

const readsOfPath = (path: string) => readsOf().filter((read) => read === path).length;

test('a document that kills the launch reading it is read by exactly one more launch', async () => {
	reset(['/a.md', '/poison.md', '/c.md']);
	// The #201 shape: one document takes the process down, every time, before
	// the window is usable. The user's only move is to launch it again.
	const poison = ({ cmd, args }: { cmd: string; args: any }) =>
		cmd === 'read_file_content_checked' && args.path === '/poison.md';

	// A stopping bound, not an expected count: the design promises two, and a
	// broken mechanism never recovers at all, so anything comfortably above two
	// does the job. Read the failure message, not this number.
	const GIVE_UP_AFTER = 5;
	const outcomes: string[] = [];
	for (let attempt = 0; attempt < GIVE_UP_AFTER; attempt++) {
		outcomes.push(await launch(poison));
		if (outcomes[outcomes.length - 1] === 'restored') break;
	}
	const recovered = outcomes[outcomes.length - 1] === 'restored';

	assert.deepEqual(
		outcomes,
		['died', 'restored'],
		// Says what happened rather than how long the loop ran. `outcomes.length`
		// is this test's own bound when nothing recovers, and a message that
		// reports it as a launch count reads as a result — which is how a reader
		// ends up believing the suite reproduced a number from a bug report.
		recovered
			? `recovery took ${outcomes.length} launches, not the two the design promises; ` +
				`/poison.md was read ${readsOfPath('/poison.md')} times`
			: `never recovered: ${outcomes.length} launches all died and the loop gave up, ` +
				`with /poison.md read ${readsOfPath('/poison.md')} times — ` +
				'the launch that died on it left nothing the next one could find',
	);
	assert.equal(readsOfPath('/poison.md'), 1, 'the document that killed a launch is not read again');
	assert.deepEqual(
		tabManager.tabs.map((tab) => tab.path),
		['/a.md', '/poison.md', '/c.md'],
		'and the session comes back whole, minus the content of the one suspect',
	);
	assert.deepEqual(readsOf().slice(-2), ['/a.md', '/c.md'], 'the other documents are read normally');
});

test('launches killed before the snapshot arrives still count, so startup can give up by itself', async () => {
	reset(['/a.md', '/b.md', '/c.md']);
	// Nothing here blames a document — the process is gone before the snapshot
	// that names one has even been loaded. A launch that leaves no trace of
	// itself cannot advance the give-up counter, and startup that cannot give
	// up walks into the same wall for as long as the user keeps launching it.
	const duringTheLoad = ({ cmd }: { cmd: string }) => cmd === 'load_window_state';

	for (let attempt = 0; attempt < 3; attempt++) {
		assert.equal(await launch(duringTheLoad), 'died', `launch ${attempt + 1} was supposed to die`);
	}
	invokeCalls = [];
	assert.equal(await launch(), 'restored');

	assert.deepEqual(
		readsOf(),
		[],
		'after three launches died before they could name a suspect, startup stops opening documents at all',
	);
	assert.deepEqual(
		tabManager.tabs.map((tab) => tab.path),
		['/a.md', '/b.md', '/c.md'],
		'and still hands back every tab',
	);
	assert.deepEqual(persistedPaths(), ['/a.md', '/b.md', '/c.md']);
});

test('claiming the launch early does not strand a window that had nothing to restore', async () => {
	// Claiming before the snapshot is loaded means a launch with no snapshot at
	// all leaves a breadcrumb describing nothing. If that phantom stuck, three
	// ordinary launches of an empty window would be enough to make the fourth
	// refuse to open documents.
	reset([]);
	storedSnapshot = null;
	assert.equal(await launch(), 'restored');
	assert.equal(breadcrumb(), null, 'a launch with nothing to restore leaves no claim behind');

	assert.equal(await launch(({ cmd }) => cmd === 'load_window_state'), 'died');
	assert.notEqual(breadcrumb(), null, 'the launch that died during the load is on the record');
	assert.equal(await launch(), 'restored');
	assert.equal(breadcrumb(), null, 'and the record retires itself once there is nothing to describe');

	// The phantom cost nothing: a later launch reads every document.
	disk = new Map([['/a.md', '# a'], ['/b.md', '# b']]);
	storedSnapshot = snapshotOf(['/a.md', '/b.md']);
	invokeCalls = [];
	assert.equal(await launch(), 'restored');
	assert.deepEqual(readsOf(), ['/a.md', '/b.md']);
});

test('the launch that follows an interruption tells the user which document it skipped', async () => {
	reset(['/a.md', '/poison.md']);
	await launch(({ cmd, args }) => cmd === 'read_file_content_checked' && args.path === '/poison.md');
	notices.length = 0;

	assert.equal(await launch(), 'restored');

	// Not a sentence: the session has no language and the app ships 26 locales,
	// so the mechanism reports the fact and MarkdownViewer picks the wording.
	assert.deepEqual(notices, [{ deferredPath: '/poison.md' }]);
});

test('a launch that was not interrupted tells the user nothing', async () => {
	reset(['/a.md']);
	assert.equal(await launch(), 'restored');
	assert.deepEqual(notices, [], 'the ordinary case is silent');
});

test('a deferred document is released once Markpad has read it', async () => {
	reset(['/a.md', '/big.md']);
	localStorage.setItem(
		RESTORE_IN_PROGRESS_KEY,
		JSON.stringify({ running: true, pending: '/big.md', deferred: [], interruptions: 0 }),
	);
	const session = makeSession();
	await session.restore();
	assert.deepEqual(breadcrumb().deferred, ['/big.md']);

	// The user opens it by hand and nothing goes wrong.
	const deferredTab = tabManager.tabs.find((tab) => tab.path === '/big.md')!;
	tabManager.setTabRawContent(deferredTab.id, '# big');

	await session.persistState();

	assert.equal(breadcrumb(), null, 'the deferral is not permanent');
});
