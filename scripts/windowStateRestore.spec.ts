import assert from 'node:assert/strict';

import { test } from 'vitest';

import { offsetOf, readSource, sliceBetween } from './sourceTree.js';

// The runes are the compiler's, not ours: vitest builds `.svelte.ts` through the
// Svelte plugin, so the store and the session run under real reactivity, and jsdom
// supplies `window` and `localStorage`. Only the Tauri backend is stubbed.
(window as any).__TAURI_INTERNALS__ = {
	metadata: { currentWindow: { label: 'main' }, currentWebview: { windowLabel: 'main', label: 'main' } },
	// `get_os_type` is the settings store booting on import: `initOSType` only
	// catches a rejection, so answering `null` leaves `osType` null and the
	// font defaults it then indexes are undefined.
	invoke: (cmd: string) => Promise.resolve(cmd === 'get_os_type' ? 'macos' : null),
};

const { tabManager } = await import('../src/lib/stores/tabs.svelte.js');

const tabs = readSource('src/lib/stores/tabs.svelte.ts');
const viewer = readSource('src/lib/MarkdownViewer.svelte');
const session = readSource('src/lib/sessions/windowSession.svelte.ts');

// Session restore persists WINDOW state only: which files are open, the
// active tab, and per-tab UI (edit mode, split, scroll). Document content
// always lives on disk — the snapshot never carries rawContent, so unsaved
// changes are handled exclusively by the per-tab close dialogs.

/** The `onCloseRequested` registration, up to the next window listener. */
function closeHandler(): string {
	return sliceBetween(viewer, 'appWindow.onCloseRequested', 'onDragDropEvent');
}

test('the snapshot carries window state and no document content', () => {
	// The snapshot is written to disk on every close. A `...t` spread, or one
	// field added by hand, silently turns a window-layout file into a copy of
	// every open document — including one the user never saved anywhere.
	tabManager.closeAll();
	tabManager.addTab('/notes/a.md', 'on disk');
	const tab = tabManager.activeTab!;
	tabManager.updateTabRawContent(tab.id, 'a paragraph that was never saved');
	tab.isEditing = true;
	tab.isSplit = true;
	tab.scrollPercentage = 0.42;

	const snapshot = tabManager.serializeState();

	assert.doesNotMatch(snapshot, /never saved/, 'the buffer is not in the file');
	assert.doesNotMatch(snapshot, /on disk/, 'and neither is the last saved copy');

	const parsed = JSON.parse(snapshot);
	assert.equal(parsed.version, 2);
	assert.deepEqual(
		Object.keys(parsed.tabs[0]).sort(),
		['anchorLine', 'id', 'isEditing', 'isScrollSynced', 'isSplit', 'path', 'scrollPercentage', 'scrollTop', 'splitRatio', 'title'],
		'exactly the window-state fields, so a new one has to be added deliberately',
	);
	assert.equal(parsed.tabs[0].isEditing, true, 'the UI state that IS persisted survives');
	assert.equal(parsed.tabs[0].scrollPercentage, 0.42);
});

test('a tab with no file behind it is not persisted', () => {
	// Untitled tabs are resolved by the close dialogs, and the Home tab's path
	// is the sentinel 'HOME' rather than a file. Persisting either restores a
	// tab that can never be read.
	tabManager.closeAll();
	tabManager.addTab('/notes/a.md', 'saved');
	tabManager.addTab('', 'untitled draft');

	const parsed = JSON.parse(tabManager.serializeState());

	assert.deepEqual(parsed.tabs.map((t: { path: string }) => t.path), ['/notes/a.md']);
});

test('a restored tab comes back clean, empty and in its old place', () => {
	tabManager.closeAll();
	tabManager.addTab('/notes/a.md', 'on disk');
	const first = tabManager.activeTab!;
	first.isSplit = true;
	first.splitRatio = 0.3;
	tabManager.addTab('/notes/b.md', 'b on disk');
	const second = tabManager.activeTab!;
	tabManager.updateTabRawContent(second.id, 'unsaved');
	const snapshot = tabManager.serializeState();

	tabManager.closeAll();
	tabManager.restoreState(snapshot);

	assert.deepEqual(tabManager.tabs.map((t) => t.path), ['/notes/a.md', '/notes/b.md']);
	assert.equal(tabManager.activeTabId, second.id, 'the tab that was active is active again');
	for (const tab of tabManager.tabs) {
		assert.equal(tab.rawContent, '', 'content is read from disk afterwards, not from the snapshot');
		assert.equal(tab.isDirty, false, 'and a restored tab is never dirty on arrival');
	}
	assert.equal(tabManager.tabs[0].isSplit, true, 'per-tab layout survives the round trip');
	assert.equal(tabManager.tabs[0].splitRatio, 0.3);
});

test('a snapshot naming a tab that no longer exists still opens something', () => {
	// activeTabId is written from the live tab list; an entry dropped on the
	// read side (a legacy 'HOME', an untitled tab from an older build) can
	// leave it pointing at nothing. Restoring to no active tab is a blank
	// window with files in the tab bar.
	tabManager.closeAll();
	tabManager.restoreState(
		JSON.stringify({ version: 2, activeTabId: 'gone', tabs: [{ id: 'x', path: '/notes/a.md', title: 'a.md' }] }),
	);

	assert.equal(tabManager.tabs.length, 1);
	assert.equal(tabManager.activeTabId, 'x');
});

test('entries that are not files are dropped on the way back in', () => {
	tabManager.closeAll();
	tabManager.restoreState(
		JSON.stringify({
			version: 2,
			tabs: [{ id: 'h', path: 'HOME', title: 'Home' }, { id: 'u', path: '', title: 'Untitled' }, { id: 'a', path: '/notes/a.md', title: 'a.md' }],
		}),
	);

	assert.deepEqual(tabManager.tabs.map((t) => t.path), ['/notes/a.md']);
});

test('startup restore reads content from disk, not from the snapshot', () => {
	const restore = sliceBetween(session, 'async function restore', 'async function claimTransferredTab');
	assert.match(restore, /read_file_content/);
	// a file that cannot be read keeps its tab and its place in the snapshot —
	// dropping it here also dropped it from the snapshot written moments later
	// (sessionRestoreResilience.test.ts)
	assert.match(restore, /tabManager\.markTabContentUnavailable\(tab\.id\);/);
	// dropping is reserved for an entry that is not a file at all — a legacy
	// 'HOME' sentinel (homeSentinelSnapshot.test.ts)
	assert.match(restore, /if \(!hasRealFilePath\(tab\.path\)\) \{\s*\n\s*options\.dropRestoredTab\(tab\.id\);/);
	assert.match(viewer, /await windowSession\.restore\(\);/);
});

test('the close flow resolves dirty tabs before serializing window state', () => {
	const handler = closeHandler();
	const walk = offsetOf(handler, 'reviewDirtyTabs({');
	const persist = offsetOf(handler, 'persistWindowState()');
	assert.ok(walk < persist, 'dirty tabs must be resolved before the snapshot is written');
});

test('v2 snapshots are invisible to legacy builds (Rust file, localStorage keys removed)', () => {
	// An older build restoring a snapshot it cannot understand ends up with
	// undefined tab content; its editor then attributes a stale buffer to the
	// wrong tab and auto-save writes it to disk. The snapshot now lives in a
	// Rust-written file (setItem is an async message to the WebKit storage
	// process and loses a flush race when the last window's close ends the
	// process); both localStorage keys are removed on write, so a downgraded
	// build starts a fresh session instead of misreading anything.
	const scope = sliceBetween(session, 'async function persistState', 'async function restore');
	assert.match(scope, /invoke\('save_window_state'/);
	assert.doesNotMatch(scope, /setItem\(/);
	assert.match(scope, /removeItem\(options\.windowStateKey\)/);
	assert.match(scope, /removeItem\(options\.legacyStateKey\)/);
	assert.match(viewer, /const WINDOW_STATE_KEY = 'savedTabsDataV2';/);
	// only the main window persists: secondary labels are per-session, and a
	// shared write slot would let the last window closed overwrite the rest
	assert.match(scope, /if \(!options\.isMainWindow\) return;/);
	// startup prefers the Rust file and falls back to the localStorage keys
	// (v2 first, then legacy) for one-time migration of older snapshots
	assert.match(session, /invoke\('load_window_state'\)/);
	assert.match(
		session,
		/localStorage\.getItem\(options\.windowStateKey\) \?\?\n?\s*localStorage\.getItem\(options\.legacyStateKey\)/,
	);
	// The shared helper clears the Rust snapshot and both localStorage keys.
	// Only explicit exit uses it: a restore that goes wrong must never delete
	// the record of which documents were open (interruptedSessionRestore.test.ts).
	const discardScope = sliceBetween(session, 'async function discardPersistedState', 'async function readProgress');
	assert.match(discardScope, /clear_window_state/);
	assert.match(discardScope, /removeItem\(options\.windowStateKey\)/);
	assert.match(discardScope, /removeItem\(options\.legacyStateKey\)/);
	// Explicit exit delegates to the same cleanup path.
	const exitScope = sliceBetween(viewer, 'async function appExit', '\n\t}');
	assert.match(exitScope, /await discardPersistedWindowState\(\)/);
});

test('exit discards the snapshot only once startup has finished', () => {
	const exitScope = sliceBetween(viewer, 'async function appExit', '\n\t}');
	// Until `init` flips `mode` to 'app', the file on disk is the only complete
	// record of the session: restore has rebuilt the tab list but is still
	// reading those files back. An unreachable restored path stretches that
	// window to one share timeout per tab, and the loading screen renders the
	// ☰ menu while every keyboard shortcut is inert — so Exit is the control
	// the user reaches for, and discarding there costs them the session.
	assert.match(exitScope, /restoreStateOnReopen && mode === 'app'/);
	const gate = offsetOf(exitScope, "mode === 'app'");
	const discard = offsetOf(exitScope, 'discardPersistedWindowState()');
	assert.ok(gate < discard, 'the discard must sit behind the startup gate');
});

test('with restore enabled resolved titled tabs stay open for the snapshot', () => {
	const handler = closeHandler();
	// tabs are closed one-by-one only when restore is off (or untitled).
	// The walk itself is covered by windowClosePerTab, which runs it; what is
	// asserted here is the policy the component hands it.
	assert.match(handler, /!settings\.restoreStateOnReopen \|\| tab\.path === ''/);
});

test('auto-save fast path silently saves titled tabs before the walk', () => {
	const handler = closeHandler();
	const fastPath = offsetOf(handler, 'if (settings.autoSave) {');
	const walk = offsetOf(handler, 'reviewDirtyTabs({');
	assert.ok(fastPath < walk, 'the silent save runs before the per-tab walk');
});
