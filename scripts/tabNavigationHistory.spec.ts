import assert from 'node:assert/strict';
import { test } from 'vitest';

// A tab's `history` is a list of PATHS: `goBack` and `goForward` hand an entry
// back to the caller, which re-opens the file it names. An untitled buffer has
// no path and no file, so it is not a place the reader can return to — by the
// time Back could run, `forgetPreviousDocument` and the load that follows have
// already replaced the text that was in it.
//
// It used to get an entry regardless, from two directions: `addNewTab` seeded
// the history with the new tab's (empty) CONTENT, and `navigateFileHistory`
// synthesised `[currentPath]` for a tab whose history was empty. Either way the
// tab ended up at index 1 of `['', '/some/file.md']`, `canGoBack` reported true
// and lit the button, and `goBack` then rejected the `''` it got as falsy and
// returned null without even moving the index — a Back button that stayed
// enabled and did nothing for the rest of the tab's life.
//
// These tests drive the real TabManager: they assert behaviour, not wording.

// The runes are the compiler's, not ours: vitest builds `.svelte.ts` through the
// Svelte plugin. Only the things jsdom genuinely does not have are stubbed.
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

function tabWith(id: string) {
	return tabManager.tabs.find((tab) => tab.id === id)!;
}

test('a new tab carries no history entry until it points at a file', () => {
	reset();
	tabManager.addNewTab();

	assert.deepEqual(tabWith(tabManager.activeTabId!).history, []);
});

test('following a link out of an untitled tab does not light a Back button that cannot work', () => {
	reset();
	tabManager.addNewTab();
	const id = tabManager.activeTabId!;

	tabManager.navigate(id, '/notes/a.md');

	assert.deepEqual(tabWith(id).history, ['/notes/a.md']);
	assert.equal(tabManager.canGoBack(id), false);
	assert.equal(tabManager.goBack(id), null);
});

test('a tab that gave up its path to another does not keep a dead entry either', () => {
	reset();
	tabManager.addTab('/notes/target.md', 'target text');
	const resident = tabManager.activeTabId!;
	// Only a DIRTY tab survives losing its path — a clean one is closed.
	tabManager.updateTabRawContent(resident, 'work in progress');
	tabManager.addTab('/notes/from.md', 'from text');
	tabManager.navigate(tabManager.activeTabId!, '/notes/target.md');
	assert.equal(tabWith(resident).path, '', 'the dirty loser is now untitled');

	tabManager.navigate(resident, '/notes/b.md');

	assert.deepEqual(tabWith(resident).history, ['/notes/b.md']);
	assert.equal(tabManager.canGoBack(resident), false);
});

test('back and forward still walk a tab that has actually been somewhere', () => {
	reset();
	tabManager.addTab('/notes/a.md', 'a');
	const id = tabManager.activeTabId!;

	tabManager.navigate(id, '/notes/b.md');

	assert.deepEqual(tabWith(id).history, ['/notes/a.md', '/notes/b.md']);
	assert.equal(tabManager.canGoBack(id), true);
	assert.equal(tabManager.goBack(id), '/notes/a.md');
	assert.equal(tabManager.canGoForward(id), true);
	assert.equal(tabManager.goForward(id), '/notes/b.md');
});

// Save As is the other way an untitled tab acquires a path, and it must not
// leave a second entry behind either: the buffer did not move to another
// document, it just gained a name for the one it already held.
test('naming an untitled buffer replaces its entry rather than appending one', () => {
	reset();
	tabManager.addNewTab();
	const id = tabManager.activeTabId!;

	tabManager.updateTabPath(id, '/notes/saved.md');

	assert.deepEqual(tabWith(id).history, ['/notes/saved.md']);
	assert.equal(tabManager.canGoBack(id), false);
});
