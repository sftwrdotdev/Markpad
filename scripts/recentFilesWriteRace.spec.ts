import assert from 'node:assert/strict';

import { test } from 'vitest';

/*
 * The race `updateStoredRecentFiles` documented but did not close.
 *
 * Re-reading before writing fixed the reported defect — a window publishing a
 * snapshot of its own stale in-memory array — but the read and the write are
 * still two calls. localStorage has no compare-and-swap and the spec's storage
 * mutex is implemented nowhere, so a sibling window's `setItem` can land
 * between them, and the entry that sibling had just added is overwritten by a
 * list computed before it existed.
 *
 * The answer here is to read back what landed and re-apply the mutation over
 * whatever list won. It works because every mutation is "apply my one change to
 * the list you hand me": promote, drop and rename are each idempotent and each
 * merge, so re-applying folds this window's change into the sibling's. Both
 * windows run it, so whoever loses an interleaving is the one that retries.
 *
 * The alternative was Rust owning the list under a `Mutex`, the way
 * `update_pinned_tags` owns the pin list. See the commit message and the note
 * on `updateStoredRecentFiles` for why that lock is available there and not
 * here.
 *
 * This file runs under vitest for jsdom's REAL localStorage: the interleaving
 * is staged by wrapping `Storage.prototype.setItem`, which a hand-written shim
 * would let the test define into existence.
 */
(window as any).__TAURI_INTERNALS__ = { invoke: async () => 'macos' };

const { promoteRecentFile, updateStoredRecentFiles } = await import('../src/lib/utils/recentFiles.js');

const KEY = 'recent-files';

const stored = () => JSON.parse(localStorage.getItem(KEY) ?? '[]') as string[];

function seed(files: string[]) {
	localStorage.clear();
	localStorage.setItem(KEY, JSON.stringify(files));
}

/**
 * Stages window B's `setItem` landing immediately after each of window A's,
 * `times` times over — the interleaving in which A's write is the one that
 * loses. Returns a disposer; the caller restores in a `finally`.
 */
function clobberAfterWrite(value: string[], times: number) {
	const original = Storage.prototype.setItem;
	let remaining = times;
	Storage.prototype.setItem = function patched(key: string, item: string) {
		original.call(this, key, item);
		if (key === KEY && remaining > 0) {
			remaining--;
			original.call(this, key, JSON.stringify(value));
		}
	};
	return () => {
		Storage.prototype.setItem = original;
	};
}

test('an entry is not lost to a sibling window that writes a moment later', () => {
	// THE RACE. Both windows read `['/old.md']`; B's write lands after A's, so
	// the stored list is B's and `/from-a.md` was never in it. Unrepaired, the
	// file the user just opened in window A is simply not in their recent list.
	seed(['/old.md']);
	const restore = clobberAfterWrite(['/from-b.md', '/old.md'], 1);
	try {
		const result = updateStoredRecentFiles((current) => promoteRecentFile(current, '/from-a.md'));

		assert.deepEqual(stored(), ['/from-a.md', '/from-b.md', '/old.md'], 'the losing window did not fold its change back in');
		// ...and the window that retried knows the merged list without a reload,
		// so its own home screen is not the stale one.
		assert.deepEqual(result, stored());
	} finally {
		restore();
	}
});

test('a removal survives the same interleaving', () => {
	// The other direction: A's mutation is a deletion, and B's write resurrects
	// the entry A removed. Re-applying `dropRecentFile` over B's list is what
	// makes the deletion stick.
	seed(['/a.md', '/b.md']);
	const restore = clobberAfterWrite(['/c.md', '/a.md', '/b.md'], 1);
	try {
		updateStoredRecentFiles((current) => current.filter((file) => file !== '/a.md'));

		assert.deepEqual(stored(), ['/c.md', '/b.md']);
		assert.ok(!stored().includes('/a.md'), 'the deletion was undone by the other window');
	} finally {
		restore();
	}
});

test('a window that keeps losing gives up rather than spinning', () => {
	// The cap. A sibling that overwrites every single attempt must not turn a
	// click into an unbounded loop — N windows retrying each other is a
	// live-lock, and this runs synchronously on the main thread. Giving up costs
	// the one entry that every interleaving used to cost.
	seed(['/old.md']);
	const restore = clobberAfterWrite(['/relentless.md'], Number.MAX_SAFE_INTEGER);
	try {
		const result = updateStoredRecentFiles((current) => promoteRecentFile(current, '/from-a.md'));

		assert.deepEqual(stored(), ['/relentless.md'], 'the last writer still wins');
		assert.ok(result.includes('/from-a.md'), 'and the caller is handed the list it computed');
	} finally {
		restore();
	}
});

test('an uncontended write still costs exactly one setItem', () => {
	// The read-back must not become a second write: `writeStoredSetting` is
	// compare-and-set precisely so that a list which did not change fires no
	// `storage` event in the other windows, and an echoed write-back would undo
	// that. Counted through the real `Storage.prototype`.
	seed(['/a.md']);
	const original = Storage.prototype.setItem;
	const writes: string[] = [];
	Storage.prototype.setItem = function patched(key: string, item: string) {
		writes.push(key);
		original.call(this, key, item);
	};
	try {
		updateStoredRecentFiles((current) => promoteRecentFile(current, '/b.md'));
		assert.deepEqual(writes, [KEY]);

		writes.length = 0;
		updateStoredRecentFiles((current) => promoteRecentFile(current, '/b.md'));
		assert.deepEqual(writes, [], 'a list that did not change must not be written back');
	} finally {
		Storage.prototype.setItem = original;
	}
});
