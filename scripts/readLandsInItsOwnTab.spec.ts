import assert from 'node:assert/strict';

import { test } from 'vitest';

// A disk read that fills a tab is an await, and the tab can change under it:
// the user switches to another tab, types, ticks a task, navigates, or closes
// it. `claimTabForRead` pins the tab, its file and its buffer when the read
// departs, and refuses the result if any of them moved by the time it lands.
//
// Each test holds one backend call open, changes the tab while it is out, then
// lets it answer — the "old result arrives late" order — and checks the stale
// result was refused. The real TabManager, document session and window session
// run under vitest; only the Tauri bridge is stubbed.

type Deferred = { promise: Promise<unknown>; resolve: (value: unknown) => void };
function deferred(): Deferred {
	let resolve!: (value: unknown) => void;
	const promise = new Promise<unknown>((r) => (resolve = r));
	return { promise, resolve };
}

const disk = new Map<string, string>();
/** Calls to hold open, by command name, until the test resolves them. */
const held = new Map<string, Deferred>();
let storedSnapshot: string | null = null;

function answer(cmd: string, args: any): unknown {
	switch (cmd) {
		case 'canonicalize_path':
			return args.path;
		case 'open_markdown_preview':
			return [disk.get(args.path) ?? '', true, false, 'UTF-8'];
		case 'read_file_content_checked':
			return [disk.get(args.path) ?? '', false, 'UTF-8'];
		case 'load_window_state':
			return storedSnapshot;
		default:
			return null;
	}
}

(window as any).__TAURI_INTERNALS__ = {
	metadata: { currentWindow: { label: 'main' }, currentWebview: { windowLabel: 'main', label: 'main' } },
	invoke: (cmd: string, args: any) => {
		const hold = held.get(cmd);
		if (hold) {
			held.delete(cmd);
			return hold.promise.then(() => answer(cmd, args));
		}
		return Promise.resolve(answer(cmd, args));
	},
};

const { tabManager } = await import('../src/lib/stores/tabs.svelte.js');
const { createDocumentSession, claimTabForRead } = await import('../src/lib/sessions/documentSession.svelte.js');
const { createWindowSession } = await import('../src/lib/sessions/windowSession.svelte.js');
const { settings } = await import('../src/lib/stores/settings.svelte.js');

function makeSession() {
	return createDocumentSession({
		setShowHome: () => {},
		currentFile: () => tabManager.activeTab?.path ?? '',
		resetScrollHistory: () => {},
		renderMarkdown: async (raw: string) => `<p>${raw}</p>`,
		afterLoad: async () => {},
		saveRecentFile: () => {},
		deleteRecentFile: () => {},
		setLoadingTabs: () => {},
		measureInitialViewport: () => {},
		isScrolling: () => false,
		onError: () => {},
		onDiskChangedUnderSave: () => {},
		cancelPendingAutoSave: () => {},
		askClose: async () => 'discard' as const,
		onCloseSaveNewerEdits: () => {},
		onCloseAutoSaveFailed: () => {},
		onPartialCopySaved: () => {},
	});
}

function reset() {
	tabManager.closeAll();
	disk.clear();
	held.clear();
	storedSnapshot = null;
	settings.openFileMode = 'preview';
}

function hold(cmd: string) {
	const d = deferred();
	held.set(cmd, d);
	return d;
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
const tabById = (id: string) => tabManager.tabs.find((tab) => tab.id === id)!;

test('Reload from disk lands in the tab it was asked for, not the one switched to', async () => {
	reset();
	const session = makeSession();
	disk.set('/notes/a.md', 'a on disk');
	tabManager.addTab('/notes/a.md', 'a old');
	const a = tabManager.activeTabId!;
	tabManager.addTab('/notes/b.md', 'b text');
	const b = tabManager.activeTabId!;
	tabManager.setActive(a);

	const gate = hold('canonicalize_path');
	const load = session.loadMarkdown('/notes/a.md', { preserveEditState: true, skipTabManagement: true, discardUnsavedBuffer: true });
	tabManager.setActive(b);
	gate.resolve(undefined);
	await load;

	assert.equal(tabById(b).rawContent, 'b text', 'the tab switched to must keep its own text');
	assert.equal(tabById(b).path, '/notes/b.md');
	assert.equal(tabById(a).rawContent, 'a on disk', 'the reload belongs to the tab it was asked for');
});

test('Back lands in the tab it was pressed in', async () => {
	reset();
	const session = makeSession();
	disk.set('/notes/prev.md', 'prev on disk');
	tabManager.addTab('/notes/prev.md', 'prev on disk');
	const a = tabManager.activeTabId!;
	tabManager.navigate(a, '/notes/next.md');
	tabManager.setTabRawContent(a, 'next text');
	tabManager.addTab('/notes/b.md', 'b text');
	const b = tabManager.activeTabId!;
	tabManager.setActive(a);

	const path = tabManager.goBack(a)!;
	const gate = hold('canonicalize_path');
	const load = session.loadMarkdown(path, { skipTabManagement: true });
	tabManager.setActive(b);
	gate.resolve(undefined);
	await load;

	assert.equal(tabById(b).rawContent, 'b text');
	assert.equal(tabById(a).rawContent, 'prev on disk');
});

test('typing during a Live Mode reload is kept, and the tab stays dirty', async () => {
	for (const mode of ['preview', 'editor'] as const) {
		reset();
		settings.openFileMode = mode;
		const session = makeSession();
		disk.set('/notes/a.md', 'changed by another program');
		tabManager.addTab('/notes/a.md', 'original');
		const a = tabManager.activeTabId!;
		tabById(a).isEditing = mode === 'editor';

		const gate = hold(mode === 'editor' ? 'read_file_content_checked' : 'open_markdown_preview');
		const load = session.loadMarkdown('/notes/a.md');
		await settle();
		tabManager.updateTabRawContent(a, 'original plus typing');
		gate.resolve(undefined);
		await load;

		assert.equal(tabById(a).rawContent, 'original plus typing', `typing lost (${mode})`);
		assert.equal(tabById(a).isDirty, true, `edits must still read as unsaved (${mode})`);
	}
});

test('typing during a non-markdown reload is kept', async () => {
	reset();
	const session = makeSession();
	disk.set('/notes/a.json', 'changed by another program');
	tabManager.addTab('/notes/a.json', 'original');
	const a = tabManager.activeTabId!;

	const gate = hold('read_file_content_checked');
	const load = session.loadMarkdown('/notes/a.json');
	await settle();
	tabManager.updateTabRawContent(a, 'original plus typing');
	gate.resolve(undefined);
	await load;

	assert.equal(tabById(a).rawContent, 'original plus typing');
	assert.equal(tabById(a).isDirty, true);
});

test('completing a partial buffer does not land on a tab that navigated away', async () => {
	reset();
	const session = makeSession();
	disk.set('/notes/big.md', 'the whole big file');
	tabManager.addTab('/notes/big.md', '');
	const a = tabManager.activeTabId!;
	tabManager.setTabRawContent(a, 'the whole', true);

	const gate = hold('read_file_content_checked');
	const completing = session.ensureFullContent(a);
	tabManager.navigate(a, '/notes/other.md');
	tabManager.setTabRawContent(a, 'other text');
	gate.resolve(undefined);
	assert.equal(await completing, true, 'the buffer the tab now holds is whole');

	assert.equal(tabById(a).rawContent, 'other text');
	assert.equal(tabById(a).path, '/notes/other.md');
});

// The read Cmd+E and split view make (MarkdownViewer.svelte) use the claim
// directly. A task ticked while it is out is saved by auto-save, so the tab is
// clean again when the read lands: "not dirty" alone would let the read, which
// left before the tick, put the unticked text back.
test('a read that left before a ticked-and-saved task is refused', () => {
	reset();
	tabManager.addTab('/notes/a.md', '- [ ] task');
	const a = tabManager.activeTabId!;

	const mayApply = claimTabForRead(a);
	tabManager.setTabRawContent(a, '- [x] task');

	assert.equal(tabById(a).isDirty, false);
	assert.equal(mayApply(), false);
});

test('of two reads of one tab, only the newer may land', () => {
	reset();
	tabManager.addTab('/notes/a.md', 'text');
	const a = tabManager.activeTabId!;

	const older = claimTabForRead(a);
	const newer = claimTabForRead(a);

	assert.equal(older(), false);
	assert.equal(newer(), true);
});

test('a read of a closed tab is refused', () => {
	reset();
	tabManager.addTab('/notes/a.md', 'text');
	const a = tabManager.activeTabId!;
	const mayApply = claimTabForRead(a);
	tabManager.closeTab(a);
	assert.equal(mayApply(), false);
});

test('typing into a restored tab before its read lands is kept', async () => {
	reset();
	tabManager.addTab('/notes/a.md', '');
	storedSnapshot = tabManager.serializeState();
	tabManager.closeAll();
	localStorage.clear();
	disk.set('/notes/a.md', 'a on disk');
	const session = makeSession();

	const windowSession = createWindowSession({
		windowStateKey: 'readLandsState',
		legacyStateKey: 'readLandsLegacy',
		restoreInProgressKey: 'readLandsProgress',
		serializeState: () => tabManager.serializeState(),
		shouldRestoreState: () => true,
		isDisposed: () => false,
		restoreState: (json) => tabManager.restoreState(json),
		restoredTabs: () => tabManager.tabs.map((tab) => ({ id: tab.id, path: tab.path })),
		loadRestoredTab: (tabId) => session.readRestoredTab(tabId),
		dropRestoredTab: (tabId) => tabManager.closeTab(tabId),
		canTransfer: () => true,
		canDetach: () => true,
		transferPayload: () => '',
		onTransferClaimed: () => {},
		acceptTransferredTab: async () => 'arrived',
		onError: () => {},
		onWarning: () => {},
		onInterrupted: () => {},
	});

	// A preview tab: restore reads it the way an open does, through the slice.
	const gate = hold('open_markdown_preview');
	const restoring = windowSession.restore();
	while (tabManager.tabs.length === 0 || held.has('open_markdown_preview')) await settle();
	const a = tabManager.tabs[0].id;
	tabManager.updateTabRawContent(a, 'typed while restoring');
	gate.resolve(undefined);
	await restoring;

	assert.equal(tabById(a).rawContent, 'typed while restoring');
	assert.equal(tabById(a).isDirty, true);
});
