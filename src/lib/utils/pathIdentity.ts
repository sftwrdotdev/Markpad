import { invoke } from '@tauri-apps/api/core';
import { hasRealFilePath } from './tabFileActions.js';

/**
 * Anything that holds a file path and may know its canonical identity. `Tab`
 * satisfies it structurally, so the comparison below can be handed a tab
 * directly without the store having to build a wrapper object.
 */
/**
 * The last segment of `path`, splitting on both `/` and `\\` so a Windows path
 * read on macOS (or the reverse) still names its file. `''` for an empty path
 * or one ending in a separator; each caller picks its own fallback.
 */
export function basename(path: string): string {
	return path.slice(Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\')) + 1);
}

export interface PathIdentity {
	path: string;
	/**
	 * `path` resolved by the filesystem — see the Rust `canonical_identity`.
	 * Empty or absent means "not resolved", which is the honest answer for a
	 * path that arrived through a route that has not asked yet, and for a
	 * volume or file the resolution failed on.
	 */
	pathKey?: string;
}

/**
 * Ask the filesystem what file `path` names. Resolves case, Unicode
 * normalization and symlinks — see the Rust `canonical_identity` for why each
 * of those is a filesystem question rather than a platform one.
 *
 * Falls back to the path itself when the backend cannot answer (an unreachable
 * network volume, a missing parent directory, or a test harness that does not
 * stub the command). That fallback is deliberately the status quo: comparing
 * the literal path is what every one of these call sites did before, so a
 * failure to resolve costs the improvement, never correctness that was already
 * there.
 */
export async function canonicalizePath(path: string): Promise<string> {
	if (!hasRealFilePath(path)) return '';
	try {
		const resolved = await invoke<string>('canonicalize_path', { path });
		return typeof resolved === 'string' && resolved !== '' ? resolved : path;
	} catch {
		return path;
	}
}

/**
 * Do these two references name the same file?
 *
 * Synchronous on purpose. `TabManager.claimPath` runs on every navigate,
 * back/forward, Save As and cross-window arrival; making the comparison async
 * would turn six synchronous store methods into promises and spread through
 * their callers, for a question that has already been answered once when the
 * path entered the app. So the I/O happens at entry (`canonicalizePath`), the
 * answer rides on the tab, and this stays string equality.
 *
 * Keys are trusted only when BOTH sides have one. A key compared against a raw
 * path would be comparing two different kinds of string: `/notes/today.md` may
 * be a symlink whose key is `/archive/2026-08-03.md`, so a raw path that
 * happens to equal some other tab's key is not evidence of anything. When
 * either side is unresolved this degrades to exact path equality — precisely
 * the behaviour that existed before, so an entry point that has not been
 * taught to resolve paths yet is no worse than it was.
 */
export function isSameFilePath(a: PathIdentity, b: PathIdentity): boolean {
	if (!hasRealFilePath(a.path) || !hasRealFilePath(b.path)) return false;
	if (a.pathKey && b.pathKey) return a.pathKey === b.pathKey;
	return a.path === b.path;
}
