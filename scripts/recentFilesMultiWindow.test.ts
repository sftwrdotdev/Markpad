import assert from 'node:assert/strict';
import test from 'node:test';

import { readSource } from './sourceTree.js';

/*
 * The recent-file list was written back as `JSON.stringify(recentFiles)` from
 * the window's own in-memory copy, in three places, with no re-read and no
 * `storage` listener. Markpad opens several windows; each is a separate webview
 * with its own copy of that array and all of them share one localStorage. So
 * every write published a snapshot taken whenever that window last looked, and
 * the later write erased the other window's entries. There was no ordering in
 * which both survived.
 *
 * The fix is the one #370 established for settings: re-read before writing, and
 * let a `storage` listener fold in what the siblings did. This file runs the
 * real module for the merge semantics; the three call sites are asserted
 * against the component's source, because they live in a Svelte file.
 *
 * `recentFiles.ts` reaches `writeStoredSetting` in `settings.svelte.ts`, which
 * is a runes module — hence the shims below, the same ones
 * settingsPersistence.spec.ts uses and for the same reason. Node's test runner
 * gives every file its own process, so they cannot leak.
 */

const runes = globalThis as unknown as { $state: unknown; $derived: unknown; $effect: unknown };
const identity = (value: unknown) => value;
runes.$state = Object.assign(identity, { raw: identity, snapshot: identity });
runes.$derived = Object.assign(identity, { by: (fn: () => unknown) => fn() });
runes.$effect = Object.assign((fn: () => void) => fn(), {
	root: (fn: () => void) => {
		fn();
		return () => {};
	},
	pre: (fn: () => void) => fn(),
	tracking: () => false,
});

const backing = new Map<string, string>();
/** Every `setItem` that actually happened. A no-op write must not appear. */
const writes: string[] = [];

const localStorageShim = {
	getItem: (key: string) => (backing.has(key) ? backing.get(key)! : null),
	setItem: (key: string, value: string) => {
		writes.push(key);
		backing.set(key, String(value));
	},
	removeItem: (key: string) => {
		writes.push(key);
		backing.delete(key);
	},
	clear: () => backing.clear(),
};

Object.defineProperty(globalThis, 'localStorage', { value: localStorageShim, configurable: true });
Object.defineProperty(globalThis, 'window', {
	value: { __TAURI_INTERNALS__: { invoke: async () => 'macos' }, addEventListener: () => {}, removeEventListener: () => {} },
	configurable: true,
});
Object.defineProperty(globalThis, 'navigator', { value: { language: 'en-US' }, configurable: true });

const {
	dropRecentFile,
	isRecentFilesStorageEvent,
	parseRecentFiles,
	promoteRecentFile,
	readStoredRecentFiles,
	renameRecentFile,
	updateStoredRecentFiles,
} = await import('../src/lib/utils/recentFiles.js');

/*
 * The key and the cap, written out rather than imported.
 *
 * They used to be `RECENT_FILES_KEY` and `RECENT_FILES_LIMIT`, exported from
 * `recentFiles.ts` for this file and for nothing else, and every assertion
 * compared the module's value with itself. Measured: `'recent-files'` renamed
 * to `'markpad-recent'` — green, and a rename orphans every existing user's
 * list, because that literal appears nowhere else to contradict it. `9` changed
 * to `3` — green, because the boundedness test seeded `LIMIT + 5` and then
 * asserted the result was `LIMIT` long.
 *
 * Both are on-disk format. A localStorage key and the length of a list the user
 * can see are things a reader should be able to look up in the test, and things
 * that must not change without someone deciding to change them, so they are
 * stated here and the exports are gone.
 */
const KEY = 'recent-files';
const LIMIT = 9;

function seed(files: string[]) {
	backing.clear();
	writes.length = 0;
	backing.set(KEY, JSON.stringify(files));
}

const stored = () => parseRecentFiles(backing.get(KEY) ?? null);

/**
 * A window: its own in-memory copy of the list, exactly as the component holds
 * one. `open`/`remove` are what the component's `saveRecentFile` and
 * `deleteRecentFile` now do.
 */
function makeWindow(initial: string[]) {
	const self = {
		files: [...initial],
		open(path: string) {
			self.files = updateStoredRecentFiles((current) => promoteRecentFile(current, path));
		},
		remove(path: string) {
			self.files = updateStoredRecentFiles((current) => dropRecentFile(current, path));
		},
		rename(from: string, to: string) {
			self.files = updateStoredRecentFiles((current) => renameRecentFile(current, from, to));
		},
	};
	return self;
}

test('a second window opening a file does not erase the first one', () => {
	// The reported defect. Both windows start from the same list, both open
	// something, and the loser used to be whoever wrote first.
	seed(['/notes/old.md']);
	const a = makeWindow(['/notes/old.md']);
	const b = makeWindow(['/notes/old.md']);

	a.open('/notes/from-a.md');
	b.open('/notes/from-b.md');

	assert.deepEqual(stored(), ['/notes/from-b.md', '/notes/from-a.md', '/notes/old.md']);
	// And the window that wrote last knows the merged list without a reload.
	assert.deepEqual(b.files, stored());
});

test('a removal in one window is not undone by an unrelated open in another', () => {
	seed(['/notes/a.md', '/notes/b.md']);
	const a = makeWindow(['/notes/a.md', '/notes/b.md']);
	const b = makeWindow(['/notes/a.md', '/notes/b.md']);

	a.remove('/notes/a.md');
	b.open('/notes/c.md');

	assert.deepEqual(stored(), ['/notes/c.md', '/notes/b.md']);
	assert.ok(!stored().includes('/notes/a.md'), 'the deletion must survive the other window');
});

test('a rename in one window survives a concurrent open in another', () => {
	seed(['/notes/draft.md']);
	const a = makeWindow(['/notes/draft.md']);
	const b = makeWindow(['/notes/draft.md']);

	a.rename('/notes/draft.md', '/notes/final.md');
	b.open('/notes/other.md');

	assert.deepEqual(stored(), ['/notes/other.md', '/notes/final.md']);
});

test('reopening a file moves it to the front without duplicating it', () => {
	seed(['/a.md', '/b.md', '/c.md']);
	makeWindow([]).open('/c.md');
	assert.deepEqual(stored(), ['/c.md', '/a.md', '/b.md']);
});

test('renaming onto a path already in the list leaves one entry', () => {
	// The UI removes one entry per click, so a duplicate would be a row the
	// user cannot get rid of.
	seed(['/notes/a.md', '/notes/b.md']);
	makeWindow([]).rename('/notes/a.md', '/notes/b.md');
	assert.deepEqual(stored(), ['/notes/b.md']);
});

test('the list stays bounded no matter how the entries arrived', () => {
	const many = Array.from({ length: LIMIT + 5 }, (_, index) => `/f${index}.md`);
	seed(many);
	makeWindow([]).open('/new.md');
	assert.equal(stored().length, LIMIT);
	assert.equal(stored()[0], '/new.md');
});

test('each of the two caps is load-bearing on its own', () => {
	// An open goes through both of them — `promoteRecentFile` caps, and
	// `updateStoredRecentFiles` caps again — so the test above stays green when
	// either one is deleted, and only fails when both are. Each layer is driven
	// alone here: the pure function directly, and the helper with a mutation
	// that does not cap.
	//
	// Both layers earn their keep. `promoteRecentFile` is exported and is the
	// one that defines what "recent" means; the cap in `updateStoredRecentFiles`
	// is what bounds the stored list whatever a caller hands it, including the
	// merge of a sibling window's longer list.
	const many = Array.from({ length: LIMIT + 5 }, (_, index) => `/f${index}.md`);

	assert.equal(promoteRecentFile(many, '/new.md').length, LIMIT, 'promoteRecentFile caps what it returns');

	seed(many);
	updateStoredRecentFiles((current) => ['/new.md', ...current]);
	assert.equal(stored().length, LIMIT, 'and the stored list is capped even when the mutation is not');
	assert.equal(stored()[0], '/new.md');
});

test('a write that changes nothing does not wake the other windows', () => {
	// This is the anti-echo half. localStorage only fires `storage` when the
	// value changes, so a compare-and-set write ends the
	// storage -> state -> write -> storage loop after one hop. A flag would
	// not: effects are flushed asynchronously (see settings.svelte.ts).
	seed(['/a.md']);
	makeWindow([]).open('/a.md');
	assert.deepEqual(stored(), ['/a.md']);
	assert.deepEqual(writes, [], 'an identical list must not be written back');
});

test('a corrupt entry is survivable', () => {
	backing.clear();
	backing.set(KEY, '{not json');
	assert.deepEqual(readStoredRecentFiles(), []);
	backing.set(KEY, '{"a":1}');
	assert.deepEqual(readStoredRecentFiles(), []);
	backing.set(KEY, '["/a.md", 7, null]');
	assert.deepEqual(readStoredRecentFiles(), ['/a.md']);
	// And a corrupt entry must not stop the next open from being recorded.
	backing.set(KEY, 'garbage');
	makeWindow([]).open('/b.md');
	assert.deepEqual(stored(), ['/b.md']);
});

test('only this key, and a wholesale clear, count as a remote change', () => {
	assert.equal(isRecentFilesStorageEvent({ key: KEY, storageArea: null }), true);
	// `key: null` is localStorage being cleared.
	assert.equal(isRecentFilesStorageEvent({ key: null, storageArea: null }), true);
	assert.equal(isRecentFilesStorageEvent({ key: 'theme', storageArea: null }), false);
	assert.equal(
		isRecentFilesStorageEvent({ key: KEY, storageArea: {} as Storage }),
		false,
		'sessionStorage is a different store',
	);
});

// --- wiring ------------------------------------------------------------------

const viewer = readSource('src/lib/MarkdownViewer.svelte');

test('every mutation goes through the read-modify-write helper', () => {
	assert.match(viewer, /recentFiles = updateStoredRecentFiles\(\((\w+)\) => promoteRecentFile\(\1, path\)\)/);
	assert.match(viewer, /recentFiles = updateStoredRecentFiles\(\((\w+)\) => dropRecentFile\(\1, path\)\)/);
	assert.match(viewer, /recentFiles = updateStoredRecentFiles\(\((\w+)\) => renameRecentFile\(\1, oldPath, newPath\)\)/);
	assert.equal(viewer.match(/updateStoredRecentFiles\(/g)?.length, 3, 'exactly three call sites, all of them shown above');
});

test('nothing writes the key directly any more', () => {
	// Any surviving `setItem('recent-files', ...)` is a window publishing its
	// own snapshot again, which is the whole defect.
	assert.doesNotMatch(viewer, /setItem\('recent-files'/);
	assert.doesNotMatch(viewer, /getItem\('recent-files'/);
});

test('a window folds in what its siblings did', () => {
	// localStorage fires `storage` in every OTHER same-origin document. Without
	// this the home screen showed a stale list until restart — and that stale
	// list was what the next write published.
	assert.match(viewer, /isRecentFilesStorageEvent\(event\)\) recentFiles = readStoredRecentFiles\(\)/);
	assert.match(viewer, /window\.addEventListener\('storage', onStorage\)/);
	assert.match(viewer, /window\.removeEventListener\('storage', onStorage\)/);
});
