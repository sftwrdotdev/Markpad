import assert from 'node:assert/strict';

import { test } from 'vitest';

import { offsetOf, readSource } from './sourceTree.js';

// The runes are the compiler's, not ours: vitest builds `.svelte.ts` through the
// Svelte plugin, so the store and the session run under real reactivity, and jsdom
// supplies `window` and `localStorage`. Only the Tauri backend is stubbed.
// `get_os_type` is the settings store booting on import: `initOSType` only
// catches a rejection, so answering `null` leaves `osType` null and the font
// defaults it then indexes are undefined.
(window as any).__TAURI_INTERNALS__ = {
	metadata: { currentWindow: { label: 'main' }, currentWebview: { windowLabel: 'main', label: 'main' } },
	invoke: (cmd: string) => Promise.resolve(cmd === 'get_os_type' ? 'macos' : null),
};

const { tabManager } = await import('../src/lib/stores/tabs.svelte.js');
const runtime = readSource('src-tauri/src/window_runtime.rs');
const viewer = readSource('src/lib/MarkdownViewer.svelte');
const titleBar = readSource('src/lib/components/TitleBar.svelte');
const home = readSource('src/lib/components/HomePage.svelte');

function roundTrip(): { name: string; color: string; pinned: boolean } | null {
	const snapshot = tabManager.serializeState();
	tabManager.closeAll();
	tabManager.setWindowTag(null);
	tabManager.restoreState(snapshot);
	return tabManager.windowTag;
}

test('a window tag survives the snapshot round trip', () => {
	tabManager.closeAll();
	tabManager.addTab('/notes/a.md', 'x');
	tabManager.setWindowTag({ name: 'Drafts', color: '#ff8c00', pinned: true });

	assert.deepEqual(roundTrip(), { name: 'Drafts', color: '#ff8c00', pinned: true });
});

test('pinned defaults to false rather than to whatever was written', () => {
	// `pinned` decides whether the tag creates a reusable session, so an
	// older snapshot with no `pinned` field, or one carrying a non-boolean,
	// must not be read as pinned.
	tabManager.closeAll();
	tabManager.addTab('/notes/a.md', 'x');
	tabManager.setWindowTag({ name: 'Drafts', color: '#ff8c00' });
	assert.equal(tabManager.windowTag?.pinned, false, 'omitted means not pinned');
	assert.equal(roundTrip()?.pinned, false, 'and it stays that way through the snapshot');

	tabManager.closeAll();
	tabManager.restoreState(
		JSON.stringify({ version: 2, tabs: [], windowTag: { name: 'D', color: '#fff', pinned: 'yes' } }),
	);
	assert.equal(tabManager.windowTag?.pinned, false, 'a truthy non-boolean is not a pin');
});

test('a malformed tag produces no tag at all', () => {
	// A tag with no name renders as an empty chip the user cannot see or
	// remove; one with no colour has nothing to paint. Restore runs on a fresh
	// window, so the starting point here is no tag — the read side only ever
	// installs one, it does not clear an existing one.
	for (const windowTag of [{ color: '#fff' }, { name: '', color: '#fff' }, { name: 'D' }, null, 'Drafts']) {
		tabManager.closeAll();
		tabManager.setWindowTag(null);
		tabManager.restoreState(JSON.stringify({ version: 2, tabs: [], windowTag }));
		assert.equal(tabManager.windowTag, null, `${JSON.stringify(windowTag)} is rejected`);
	}
});

test('only explicitly pinned tags create reusable sessions', () => {
	assert.match(runtime, /pub fn save_pinned_tag/);
	assert.match(runtime, /pub fn remove_pinned_tag/);
	assert.match(viewer, /if \(!tag\?\.pinned\) return;/);
	assert.match(viewer, /savePinnedTagIfNeeded/);
	assert.match(home, /onopenPinnedTag/);
});

test('the title bar exposes a named color chip and pin control', () => {
	assert.match(titleBar, /tagColors/);
	assert.match(titleBar, /window-tag-chip/);
	assert.match(titleBar, /togglePinnedTag/);
});

test('the Home menu groups window organization below export actions', () => {
	const exportIndex = offsetOf(titleBar, "t('menu.exportPdf', currentLanguage)");
	const tagIndex = offsetOf(titleBar, "t('menu.setWindowTag', currentLanguage)");
	const mergeIndex = offsetOf(titleBar, "t('menu.mergeAllWindows', currentLanguage)");
	const exitIndex = offsetOf(titleBar, "t('menu.exit', currentLanguage)");

	assert.ok(exportIndex < tagIndex);
	assert.ok(tagIndex < mergeIndex);
	assert.ok(mergeIndex < exitIndex);
	assert.match(titleBar, /homeMenuOpen = false;\s*openTagEditor\(\);/);
});
