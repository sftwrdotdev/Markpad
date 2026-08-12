import { writeStoredSetting } from '../stores/settings.svelte.js';

// Module-private on purpose. Both used to be exported, and the only importer
// was recentFilesMultiWindow.test.ts, which compared each one with itself —
// so renaming the key or changing the cap could not fail anything. The test
// writes both values out now; an export that exists to be asserted against
// itself is not a contract with anyone.
const RECENT_FILES_KEY = 'recent-files';
const RECENT_FILES_LIMIT = 9;
/**
 * How many times {@link updateStoredRecentFiles} will re-apply its mutation
 * over a sibling window's write before giving up. A cap rather than a loop
 * until success: N windows all retrying each other is a live-lock, and this
 * runs synchronously on a click. Exhausting it loses one recent-file entry,
 * which is exactly what happened on every interleaving before.
 */
const RECENT_FILES_WRITE_ATTEMPTS = 3;

/**
 * The recent-file list, as stored. Anything that is not an array of strings is
 * treated as absent rather than thrown: a corrupt entry must not be able to
 * stop the app from recording new files.
 */
export function parseRecentFiles(raw: string | null): string[] {
	if (raw === null) return [];
	try {
		const parsed = JSON.parse(raw);
		return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [];
	} catch {
		return [];
	}
}

function dedupe(files: readonly string[]): string[] {
	return [...new Set(files)];
}

/** Moves `path` to the front, keeping the list at most {@link RECENT_FILES_LIMIT} long. */
export function promoteRecentFile(stored: readonly string[], path: string): string[] {
	return dedupe([path, ...stored]).slice(0, RECENT_FILES_LIMIT);
}

export function dropRecentFile(stored: readonly string[], path: string): string[] {
	return stored.filter((file) => file !== path);
}

/**
 * Follows a renamed file. Deduplicates afterwards: the new name may already be
 * in the list (the user renamed a file back onto a path they had opened
 * before), and two entries for one file is a list that cannot be cleaned up
 * from the UI, which removes one entry per click.
 */
export function renameRecentFile(stored: readonly string[], oldPath: string, newPath: string): string[] {
	return dedupe(stored.map((file) => (file === oldPath ? newPath : file)));
}

export function readStoredRecentFiles(): string[] {
	if (typeof localStorage === 'undefined' || typeof localStorage.getItem !== 'function') return [];
	return parseRecentFiles(localStorage.getItem(RECENT_FILES_KEY));
}

/**
 * Read-modify-write against localStorage, and the only way this list is
 * changed.
 *
 * Every Markpad window is a separate webview with its own copy of the list and
 * one shared localStorage. Writing `JSON.stringify(recentFiles)` from an
 * in-memory copy therefore published a snapshot taken when that window last
 * looked — so opening a file in window B erased everything window A had opened
 * since, and there was no ordering in which both survived. Re-reading first
 * makes each change a change to the *stored* list rather than to a stale copy
 * of it.
 *
 * Re-reading alone narrows the race without closing it. Two windows are two
 * documents over one storage area, the spec's storage mutex is not implemented
 * anywhere, and localStorage has no compare-and-swap — so a sibling's write can
 * still land between this window's `getItem` and its `setItem`, and the entry
 * that sibling had just added is gone.
 *
 * So the cycle reads back what actually landed. If the stored list is not the
 * one this window just wrote, a sibling overwrote it, and `mutate` is applied
 * again over the list that won. That works because every mutation here is
 * "apply my one change to whatever list you hand me" — promote, drop, rename
 * are each idempotent and each merge — so re-applying folds this change into
 * the sibling's instead of one of the two being dropped. Both windows run this
 * code, so the loser of any interleaving is the one that retries, and the pair
 * converges without either of them holding anything.
 *
 * What is left: a sibling write that lands after the read-back. That window is
 * itself reading back, finds the list this one published, and merges into it —
 * so the surviving loss needs a sibling to clobber us *and* to see its own
 * write intact, which is a second interleaving inside a few microseconds of
 * synchronous code that runs only on discrete user actions. The attempt cap is
 * what keeps two busy windows from live-locking; hitting it loses one entry
 * that the next open restores, which is the pre-existing worst case.
 *
 * Rust owning the list instead — the way `update_pinned_tags` in
 * `window_runtime.rs` owns the pin list under a real `Mutex` — was the other
 * answer, and it is not available for the same reason it was available there.
 * That lock works because every window is a thread of one Rust process; these
 * writers are separate webview processes with no shared primitive between them,
 * so a backend list would have to be pushed back out to each window anyway,
 * which is what the `storage` event already does. And Rust is the authority on
 * pins because Rust reads them (it owns the window list); nothing in the
 * backend reads recent files. Moving them there would make a list the home
 * screen renders synchronously into an async IPC round trip at every reader.
 *
 * The write goes through {@link writeStoredSetting} (#370) so that a write
 * which changes nothing does not fire a `storage` event in the other windows.
 * That is what keeps the listener below from bouncing an update back and
 * forth; the reasoning for preferring compare-and-set over an
 * "I am applying a remote change" flag is documented there.
 */
export function updateStoredRecentFiles(mutate: (current: string[]) => string[]): string[] {
	let next: string[] = [];
	for (let attempt = 0; attempt < RECENT_FILES_WRITE_ATTEMPTS; attempt++) {
		next = dedupe(mutate(readStoredRecentFiles())).slice(0, RECENT_FILES_LIMIT);
		const written = JSON.stringify(next);
		writeStoredSetting(RECENT_FILES_KEY, written);
		if (JSON.stringify(readStoredRecentFiles()) === written) break;
	}
	return next;
}

/**
 * True when `event` means the recent-file list changed somewhere else.
 * A null key is localStorage being cleared wholesale.
 */
export function isRecentFilesStorageEvent(event: Pick<StorageEvent, 'key' | 'storageArea'>): boolean {
	if (typeof localStorage !== 'undefined' && typeof localStorage.getItem === 'function' && event.storageArea && event.storageArea !== localStorage) return false;
	return event.key === null || event.key === RECENT_FILES_KEY;
}
