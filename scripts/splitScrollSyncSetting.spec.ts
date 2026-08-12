import assert from 'node:assert/strict';

import { flushSync } from 'svelte';
import { test } from 'vitest';

import { readSource } from './sourceTree.js';

/*
 * `editor.splitScrollSync` — the sticky "does a new split start scroll-locked"
 * answer — was the last localStorage write outside `writeStoredSetting`. The
 * tab store read it in its constructor and wrote it with a bare
 * `localStorage.setItem`.
 *
 * That is the milder half of the defect #618 collected the other three writers
 * for: one key and one write, so it could not clobber its neighbours the way a
 * whole-snapshot write did. What it still had was the other half — no `storage`
 * listener. Markpad opens several windows, each a separate webview over one
 * shared localStorage, so flipping scroll sync in window A left window B
 * seeding its next split from its own construction-time answer until it was
 * restarted, while every preference beside it synced live.
 *
 * It is a preference, not tab state: `Tab.isScrollSynced` is the per-tab value
 * (it lives in the window-state snapshot and is what the title bar toggles),
 * and this is the one scalar every tab and every window seeds from. So it now
 * lives in `SettingsStore` with the rest of them, and `TabManager` exposes it
 * under its tab-side name.
 *
 * This runs under vitest so the runes are the compiler's: `$effect` really
 * tracks, `flushSync()` really runs the write effects, and jsdom's
 * `localStorage` and `window` are real. Only the Tauri backend is stubbed.
 */
(window as any).__TAURI_INTERNALS__ = {
	metadata: { currentWindow: { label: 'main' }, currentWebview: { windowLabel: 'main', label: 'main' } },
	invoke: (cmd: string) => Promise.resolve(cmd === 'get_os_type' ? 'macos' : null),
};

const { createSettingsPersistence, settings, writeStoredSetting } = await import('../src/lib/stores/settings.svelte.js');
const { tabManager } = await import('../src/lib/stores/tabs.svelte.js');

const KEY = 'editor.splitScrollSync';

/** jsdom does not fire `storage` for writes made by this same document. */
function dispatchStorage(key: string | null, newValue: string | null) {
	window.dispatchEvent(new StorageEvent('storage', { key, newValue, storageArea: localStorage }));
}

function reset() {
	tabManager.closeAll();
	settings.splitScrollSync = false;
	// The write effects and the `storage` listener are only live once flushed.
	flushSync();
}

/** A split tab, the way the app reaches one. */
function splitTab(path: string) {
	tabManager.addTab(path, `# ${path}`);
	const id = tabManager.activeTabId!;
	tabManager.setSplitEnabled(id, true);
	return { id, tab: () => tabManager.tabs.find((candidate) => candidate.id === id)! };
}

test('the split scroll-sync preference is a persisted setting like every other one', () => {
	const entry = createSettingsPersistence().find((candidate) => candidate.key === KEY);
	assert.ok(entry, `${KEY} is not in createSettingsPersistence, so nothing syncs or validates it`);
});

test('a stored preference survives a restart and seeds the next split', () => {
	reset();
	localStorage.setItem(KEY, 'true');
	dispatchStorage(KEY, 'true');

	const { tab } = splitTab('/notes/restored.md');
	assert.equal(tab().isScrollSynced, true);
});

test('a sibling window flipping scroll sync arrives without a restart', () => {
	// THE BUG. Window B holds its own answer; window A flips the toggle and
	// publishes it. With no listener, B kept seeding splits from `false` until it
	// was restarted — the one behaviour the settings mechanism exists to give.
	reset();
	assert.equal(tabManager.splitScrollSyncPreference, false);

	localStorage.setItem(KEY, 'true');
	dispatchStorage(KEY, 'true');

	assert.equal(tabManager.splitScrollSyncPreference, true, 'the sibling window change never arrived');

	const { tab } = splitTab('/notes/sibling.md');
	assert.equal(tab().isScrollSynced, true, 'and the next split still started from the stale answer');
});

test('the arriving value is not echoed back at the window that sent it', () => {
	// Compare-and-set, not a flag: the write-back is dropped because the value is
	// already what is stored, so storage -> state -> effect -> write stops here.
	reset();
	localStorage.setItem(KEY, 'true');
	dispatchStorage(KEY, 'true');

	const entry = createSettingsPersistence().find((candidate) => candidate.key === KEY)!;
	assert.equal(writeStoredSetting(entry.key, entry.read(settings)), false);
});

test('toggling scroll sync on a tab publishes the preference for the other windows', () => {
	reset();
	const { id } = splitTab('/notes/toggled.md');

	tabManager.toggleScrollSync(id);
	assert.equal(tabManager.splitScrollSyncPreference, true);
	flushSync();
	assert.equal(localStorage.getItem(KEY), 'true');

	// Un-splitting keeps whatever the tab ended up with, as it always did.
	tabManager.setSplitEnabled(id, false);
	assert.equal(tabManager.splitScrollSyncPreference, true);
});

test('the tab store keeps no localStorage of its own', () => {
	// Both halves: the bare `setItem` the convention rule now forbids outright,
	// and the constructor's `getItem`, which is the load path that has to move
	// with it or the two would drift.
	const tabsSource = readSource('src/lib/stores/tabs.svelte.ts');
	assert.doesNotMatch(tabsSource, /localStorage\.(?:get|set)Item\s*\(/);
});
