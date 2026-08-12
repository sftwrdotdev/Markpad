import assert from 'node:assert/strict';
import { test } from 'vitest';

import { asRendererLine } from '../src/lib/utils/lineCoordinates.js';

// A file path identifies a tab. Two tabs on one file are two buffers with two
// dirty flags and two auto-save timers writing the same file in turn, so
// whichever lands last silently overwrites the other's work. Every way to
// reach that state goes through a different caller — a link opened in a new
// tab, Save As onto an open file, back/forward, a tab moved in from another
// window — so the constraint belongs to the store.
//
// These tests drive the real TabManager: they assert behaviour, not wording.

// The runes are the compiler's, not ours: vitest builds `.svelte.ts` through the
// Svelte plugin, so `$state`/`$derived`/`$effect` behave here exactly as they do
// in the app. Only the things jsdom genuinely does not have are stubbed.
(window as any).__TAURI_INTERNALS__ = {
	metadata: { currentWindow: { label: 'main' }, currentWebview: { windowLabel: 'main', label: 'main' } },
	invoke: (cmd: string) => Promise.resolve(cmd === 'get_os_type' ? 'macos' : null),
};

const { tabManager } = await import('../src/lib/stores/tabs.svelte.js');

function reset() {
	tabManager.closeAll();
	tabManager.recentlyClosed.length = 0;
	localStorage.clear();
}

function tabsFor(path: string) {
	return tabManager.tabs.filter((tab) => tab.path === path);
}

// --- one tab per file ---

test('opening a file that is already open activates that tab instead of duplicating it', () => {
	reset();
	tabManager.addTab('/notes/a.md', 'first');
	const first = tabManager.activeTabId;
	tabManager.addTab('/notes/b.md');

	tabManager.addTab('/notes/a.md');

	assert.equal(tabsFor('/notes/a.md').length, 1);
	assert.equal(tabManager.activeTabId, first, 'the request resolves to the existing tab');
	assert.equal(tabManager.tabs.length, 2);
});

// Scope: this proves the STORE does not clobber the buffer when an open file
// is opened again. It does not prove the whole open flow is safe —
// `documentSession.loadMarkdown` re-reads the file into the tab it activates,
// which is a pre-existing behaviour of the ordinary open path and lives
// outside this file.
test('re-opening a file does not overwrite the unsaved edits in its tab', () => {
	reset();
	tabManager.addTab('/notes/a.md', 'saved text');
	const id = tabManager.activeTabId!;
	tabManager.updateTabRawContent(id, 'unsaved edits');

	tabManager.addTab('/notes/a.md', 'saved text');

	const tab = tabManager.tabs.find((item) => item.id === id)!;
	assert.equal(tab.rawContent, 'unsaved edits');
	assert.equal(tab.isDirty, true);
});

test('following a link to an open file leaves exactly one tab holding it', () => {
	reset();
	tabManager.addTab('/notes/target.md', 'target text');
	tabManager.addTab('/notes/from.md', 'from text');
	const walker = tabManager.activeTabId!;

	tabManager.navigate(walker, '/notes/target.md');

	assert.equal(tabsFor('/notes/target.md').length, 1);
	assert.equal(tabsFor('/notes/target.md')[0].id, walker);
	// The clean loser is a copy of the file the winner now holds, so closing it
	// costs nothing — and it lands on the reopen stack like any other close.
	assert.ok(tabManager.recentlyClosed.includes('/notes/target.md'));
});

test('a tab with unsaved edits is never closed to resolve a path conflict', () => {
	reset();
	tabManager.addTab('/notes/target.md', 'target text');
	const resident = tabManager.activeTabId!;
	tabManager.updateTabRawContent(resident, 'work in progress');
	tabManager.addTab('/notes/from.md', 'from text');
	const walker = tabManager.activeTabId!;

	tabManager.navigate(walker, '/notes/target.md');

	const kept = tabManager.tabs.find((tab) => tab.id === resident);
	assert.ok(kept, 'the dirty buffer survives');
	assert.equal(kept!.rawContent, 'work in progress');
	assert.equal(kept!.isDirty, true);
	// It keeps the text and gives up the path: nothing is discarded, and
	// nothing can auto-save over the file behind the user's back.
	assert.equal(kept!.path, '');
	assert.equal(tabsFor('/notes/target.md').length, 1);
	assert.equal(tabsFor('/notes/target.md')[0].id, walker);
});

test('Save As onto a file that is already open does not leave two tabs on it', () => {
	reset();
	tabManager.addTab('/notes/target.md', 'target text');
	tabManager.addNewTab();
	const untitled = tabManager.activeTabId!;

	// saveContentAs writes the file first and then re-points the tab.
	tabManager.updateTabPath(untitled, '/notes/target.md');

	assert.equal(tabsFor('/notes/target.md').length, 1);
	assert.equal(tabsFor('/notes/target.md')[0].id, untitled);
});

test('an external rename onto an open file does not leave two tabs on it', () => {
	reset();
	tabManager.addTab('/notes/target.md', 'target text');
	tabManager.addTab('/notes/other.md', 'other text');
	const renamed = tabManager.activeTabId!;

	tabManager.renameTab(renamed, '/notes/target.md');

	assert.equal(tabsFor('/notes/target.md').length, 1);
	assert.equal(tabsFor('/notes/target.md')[0].id, renamed);
});

test('going back to a file another tab has since opened does not duplicate it', () => {
	reset();
	tabManager.addTab('/notes/a.md', 'a');
	const walker = tabManager.activeTabId!;
	tabManager.navigate(walker, '/notes/b.md');
	tabManager.addTab('/notes/a.md');

	assert.equal(tabManager.goBack(walker), '/notes/a.md');

	assert.equal(tabsFor('/notes/a.md').length, 1);
	assert.equal(tabsFor('/notes/a.md')[0].id, walker);
});

test('a tab arriving from another window does not duplicate a file open here', () => {
	reset();
	tabManager.addTab('/notes/shared.md', 'resident copy');

	tabManager.insertTransferredTab({
		path: '/notes/shared.md',
		title: 'shared.md',
		rawContent: 'edited elsewhere',
		originalContent: 'resident copy',
		isDirty: true,
		isEditing: true,
		scrollTop: 0,
		scrollPercentage: 0,
		anchorLine: asRendererLine(0),
		isSplit: false,
		splitRatio: 0.5,
		isScrollSynced: false,
		hasReplacementChars: false,
		encoding: 'UTF-8',
		history: ['/notes/shared.md'],
		historyIndex: 0,
	});

	assert.equal(tabsFor('/notes/shared.md').length, 1);
	assert.equal(tabsFor('/notes/shared.md')[0].rawContent, 'edited elsewhere');
});

test('untitled tabs are not files and do not collide', () => {
	reset();
	tabManager.addNewTab();
	tabManager.addNewTab();
	tabManager.addNewTab();

	assert.equal(tabManager.tabs.length, 3);
	assert.equal(tabsFor('').length, 3);
});

test('the home tab is a singleton on its own terms, not through the path rule', () => {
	reset();
	tabManager.addHomeTab();
	const home = tabManager.activeTabId;
	tabManager.addTab('/notes/a.md');
	tabManager.addHomeTab();

	assert.equal(tabsFor('HOME').length, 1);
	assert.equal(tabManager.activeTabId, home);
});
