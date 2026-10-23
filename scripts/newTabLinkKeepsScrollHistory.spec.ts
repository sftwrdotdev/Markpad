import assert from 'node:assert/strict';
import { test } from 'vitest';

// A link opened in a new tab leaves the tab it was clicked in as it was. #1007
// routed it through `loadMarkdown`'s ordinary open path, which clears the
// in-page jump stacks of the ACTIVE tab before picking a tab, and at that point
// the active tab is still the one the user is leaving.

(window as any).__TAURI_INTERNALS__ = {
	metadata: { currentWindow: { label: 'main' }, currentWebview: { windowLabel: 'main', label: 'main' } },
	invoke: (cmd: string) => {
		if (cmd === 'open_markdown_preview') return Promise.resolve(['# B\n', true, false]);
		if (cmd === 'read_file_content_checked') return Promise.resolve(['# B\n', false]);
		if (cmd === 'get_os_type') return Promise.resolve('macos');
		return Promise.resolve(null);
	},
};

const { tabManager } = await import('../src/lib/stores/tabs.svelte.js');
const { createDocumentSession } = await import('../src/lib/sessions/documentSession.svelte.js');

// What openMarkdownTargetInNewTab passes (pinned in reopenDirtyDocument.spec.ts).
const newTabOptions = { inNewTab: true };

function makeSession() {
	return createDocumentSession({
		setShowHome: () => {},
		currentFile: () => tabManager.activeTab?.path ?? '',
		// As MarkdownViewer wires it.
		resetScrollHistory: () => {
			if (tabManager.activeTabId) tabManager.clearScrollHistory(tabManager.activeTabId);
		},
		renderMarkdown: async (raw: string) => raw,
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

const stackOf = (id: string) => tabManager.tabs.find((t) => t.id === id)!.scrollHistory;

test('a link opened in a new tab keeps the source tab in-page back history', async () => {
	tabManager.closeAll();
	tabManager.addTab('/notes/a.md', '# A\n');
	const a = tabManager.activeTabId!;
	tabManager.pushScrollHistory(a, 1200);
	tabManager.pushScrollHistory(a, 3400);

	await makeSession().loadMarkdown('/notes/b.md', newTabOptions);

	assert.notEqual(tabManager.activeTabId, a, 'b.md opened in its own tab');
	assert.deepEqual(stackOf(a), [1200, 3400]);
});

test('a link to a file already open in another tab still activates that tab', async () => {
	tabManager.closeAll();
	tabManager.addTab('/notes/b.md', '# B\n');
	const b = tabManager.activeTabId!;
	tabManager.addTab('/notes/a.md', '# A\n');
	const a = tabManager.activeTabId!;
	tabManager.pushScrollHistory(a, 1200);

	await makeSession().loadMarkdown('/notes/b.md', newTabOptions);

	assert.equal(tabManager.activeTabId, b);
	assert.equal(tabManager.tabs.length, 2);
	assert.deepEqual(stackOf(a), [1200]);
});
