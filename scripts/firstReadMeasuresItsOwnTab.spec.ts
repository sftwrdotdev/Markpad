import assert from 'node:assert/strict';

import { test } from 'vitest';

/**
 * Opening a large file is two reads: a 5MB slice that puts something on screen,
 * and a background read that completes it. The slice arrives after three awaits,
 * and the reader can switch tabs inside any of them.
 *
 * Every write the first stage makes is addressed by tab id, so a switch costs
 * nothing — with a preview host per tab, the HTML lands on the tab that asked
 * for it and is shown when that tab is next displayed. The exception was the
 * viewport measurement: there is one article on screen and one `isAtBottom`
 * flag, so measuring after a switch answers "does this document fit the
 * viewport" for the tab the reader moved to, and a short one sets the flag that
 * raises the "loading full document" chip on the tab still loading — at the top
 * of a slice nobody has scrolled.
 *
 * The switch here happens inside `renderMarkdown`, which is where the real one
 * has the most room: rendering 5MB of markdown is the longest await on the path.
 */

let handleInvoke: (cmd: string, args: any) => unknown = (cmd) => {
	throw new Error(`unexpected invoke: ${cmd}`);
};
(window as any).__TAURI_INTERNALS__ = {
	metadata: { currentWindow: { label: 'main' }, currentWebview: { windowLabel: 'main', label: 'main' } },
	invoke: (cmd: string, args: any) => Promise.resolve(handleInvoke(cmd, args)),
};

const { tabManager } = await import('../src/lib/stores/tabs.svelte.js');
const { createDocumentSession } = await import('../src/lib/sessions/documentSession.svelte.js');

const BIG = '/notes/big.md';
const SMALL = '/notes/small.md';

/** The first stage returns a slice (`isFull` false); the completion never lands. */
function readsATruncatedFile() {
	handleInvoke = (cmd, args) => {
		if (cmd === 'get_os_type') return 'macos';
		if (cmd === 'canonicalize_path') return args.path;
		if (cmd === 'open_markdown_preview') return [args.path, 'the first five megabytes', false, false, 'UTF-8'];
		// The background completion, left in flight: this is about the tab the
		// first stage lands on, not about what finishes afterwards.
		if (cmd === 'read_file_content_checked') return new Promise(() => {});
		throw new Error(`unexpected invoke: ${cmd}`);
	};
}

function openTwoTabs() {
	tabManager.closeAll();
	tabManager.addTab(BIG);
	tabManager.addTab(SMALL);
	const big = tabManager.tabs.find((tab) => tab.path === BIG)!.id;
	const small = tabManager.tabs.find((tab) => tab.path === SMALL)!.id;
	tabManager.setActive(big);
	return { big, small };
}

function makeSession(overrides: Record<string, unknown> = {}) {
	return createDocumentSession({
		setShowHome: () => {},
		currentFile: () => tabManager.activeTab?.path ?? '',
		resetScrollHistory: () => {},
		renderMarkdown: async () => 'rendered',
		afterLoad: async () => {},
		saveRecentFile: () => {},
		deleteRecentFile: () => {},
		setLoadingTabs: () => {},
		measureInitialViewport: () => {},
		isScrolling: () => false,
		renderRichContent: () => {},
		onError: (message: string, error: unknown) => {
			throw new Error(`${message}: ${String(error)}`);
		},
		onDiskChangedUnderSave: () => {},
		cancelPendingAutoSave: () => {},
		askClose: async () => 'discard' as const,
		onCloseSaveNewerEdits: () => {},
		onCloseAutoSaveFailed: () => {},
		onPartialCopySaved: () => {},
		...overrides,
	});
}

test('a switch during the first read leaves the other document unmeasured', async () => {
	readsATruncatedFile();
	const { big, small } = openTwoTabs();

	const measuredWhileActive: (string | null)[] = [];
	let loading: string[] = [];
	const session = makeSession({
		renderMarkdown: async () => {
			tabManager.setActive(small);
			return 'rendered';
		},
		setLoadingTabs: (ids: string[]) => (loading = ids),
		measureInitialViewport: () => measuredWhileActive.push(tabManager.activeTabId),
	});

	await session.loadMarkdown(BIG);

	assert.deepEqual(measuredWhileActive, [], 'the article showing the other tab is not measured');
	// The rest of the path was already right, and stays that way: the slice and
	// its rendered HTML are addressed by id, and so is the loading set the chip
	// asks about.
	assert.equal(tabManager.tabs.find((tab) => tab.id === big)!.content, 'rendered');
	assert.equal(tabManager.tabs.find((tab) => tab.id === big)!.isTruncated, true);
	assert.equal(tabManager.tabs.find((tab) => tab.id === small)!.content, '');
	assert.deepEqual(loading, [big], 'the loading tab is the one that is loading, not the one on screen');
});

test('with no switch, the tab that loaded is the tab measured', async () => {
	readsATruncatedFile();
	const { big } = openTwoTabs();

	const measuredWhileActive: (string | null)[] = [];
	const session = makeSession({
		measureInitialViewport: () => measuredWhileActive.push(tabManager.activeTabId),
	});

	await session.loadMarkdown(BIG);

	assert.deepEqual(measuredWhileActive, [big], 'the ordinary open still measures, exactly once');
});
