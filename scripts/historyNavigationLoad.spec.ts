import assert from 'node:assert/strict';

import { test } from 'vitest';

import { readSource, sliceBetween } from './sourceTree.js';

// Back/forward used to repoint the tab (path, title, history index, a clean
// baseline) and only then read the file. A file deleted or renamed since left
// the tab titled and saved as that file while it still showed the other
// document's text, and "keep mine" on the conflict that followed wrote it
// there. Following a link already read first and repointed on success; history
// navigation now does the same.
//
// Real store and session under the Svelte compiler; only the backend is stubbed.

const disk = new Map<string, string>();
let duringRead: () => void = () => {};

(window as any).__TAURI_INTERNALS__ = {
	metadata: { currentWindow: { label: 'main' }, currentWebview: { windowLabel: 'main', label: 'main' } },
	invoke: async (cmd: string, args: any) => {
		if (cmd === 'get_os_type') return 'macos';
		if (cmd === 'canonicalize_path') return args.path;
		if (cmd === 'open_markdown_preview' || cmd === 'read_file_content_checked') {
			duringRead();
			if (!disk.has(args.path)) throw new Error(`no such file: ${args.path}`);
			const text = disk.get(args.path)!;
			return cmd === 'open_markdown_preview' ? ['', text, true, false, 'UTF-8'] : [text, false, 'UTF-8'];
		}
		return null;
	},
};

const { tabManager } = await import('../src/lib/stores/tabs.svelte.js');
const { createDocumentSession } = await import('../src/lib/sessions/documentSession.svelte.js');

let conflicts: string[] = [];
let errors: string[] = [];

const session = createDocumentSession({
	setShowHome: () => {},
	currentFile: () => tabManager.activeTab?.path ?? '',
	resetScrollHistory: () => {},
	renderMarkdown: async () => '',
	afterLoad: async () => {},
	saveRecentFile: () => {},
	deleteRecentFile: () => {},
	setLoadingTabs: () => {},
	measureInitialViewport: () => {},
	isScrolling: () => false,
	renderRichContent: () => {},
	onError: (message: string) => errors.push(message),
	onDiskChangedUnderSave: (tabId: string) => conflicts.push(tabId),
	cancelPendingAutoSave: () => {},
	askClose: async () => 'discard' as const,
	onCloseSaveNewerEdits: () => {},
	onCloseAutoSaveFailed: () => {},
	onPartialCopySaved: () => {},
});

/** A tab that opened a.md and followed a link to b.md: history [a, b]. */
async function followedLink() {
	tabManager.closeAll();
	disk.clear();
	conflicts = [];
	errors = [];
	duringRead = () => {};
	disk.set('/notes/a.md', 'text of a');
	disk.set('/notes/b.md', 'text of b');
	await session.loadMarkdown('/notes/a.md');
	await session.loadMarkdown('/notes/b.md', { navigate: true });
	const tab = tabManager.activeTab!;
	assert.deepEqual([tab.path, tab.rawContent, tab.historyIndex], ['/notes/b.md', 'text of b', 1]);
	return tab;
}

/** What the viewer's `navigateFileHistory` does once the tab may be left. */
async function goBack(tabId: string) {
	const path = tabManager.peekHistory(tabId, 'back');
	if (path) await session.loadMarkdown(path, { historyStep: 'back' });
}

test('Back to a file that has gone leaves the tab on the document it holds', async () => {
	const tab = await followedLink();
	disk.delete('/notes/a.md');

	await goBack(tab.id);

	assert.equal(errors.length, 1, 'the failed read was not reported');
	assert.equal(tabManager.tabs.length, 1);
	assert.equal(tab.path, '/notes/b.md');
	assert.equal(tab.title, 'b.md');
	assert.equal(tab.historyIndex, 1, 'history moved although nothing was opened');
	assert.equal(tab.rawContent, 'text of b');
	assert.equal(tab.isDirty, false);
	assert.equal(tabManager.canGoBack(tab.id), true, 'Back should still be there to retry');
});

test('Back and Forward repoint the tab once the file has been read', async () => {
	const tab = await followedLink();

	await goBack(tab.id);
	assert.deepEqual([tab.path, tab.title, tab.historyIndex, tab.rawContent, tab.isDirty], ['/notes/a.md', 'a.md', 0, 'text of a', false]);

	await session.loadMarkdown(tabManager.peekHistory(tab.id, 'forward')!, { historyStep: 'forward' });
	assert.deepEqual([tab.path, tab.title, tab.historyIndex, tab.rawContent, tab.isDirty], ['/notes/b.md', 'b.md', 1, 'text of b', false]);
});

test('a keystroke typed while Back is loading raises no conflict and cannot land in the other file', async () => {
	const tab = await followedLink();
	duringRead = () => tabManager.updateTabRawContent(tab.id, 'text of b, typed');

	await goBack(tab.id);

	assert.deepEqual(conflicts, []);
	assert.equal(tab.path, '/notes/a.md');
	assert.equal(tab.rawContent, 'text of a');
	assert.equal(tab.isDirty, false);
});

test('Back and Forward ask the history before the unsaved-changes dialog, and repoint only through the load', () => {
	// A component that cannot be imported, so its statement order is matched as text.
	const fn = sliceBetween(readSource('src/lib/MarkdownViewer.svelte'), 'async function navigateFileHistory', '\n\t}');
	assert.ok(fn.indexOf('peekHistory') >= 0 && fn.indexOf('peekHistory') < fn.indexOf('canCloseTab'), '"Don\'t Save" with nowhere to go drops the edits');
	assert.doesNotMatch(fn, /\.go(Back|Forward)\(/, 'the tab is repointed before its file is read');
	assert.match(fn, /historyStep: direction/);
});
