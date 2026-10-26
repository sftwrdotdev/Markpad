import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

// The one place the suite reads a repo file as text. Reading a file is a
// decision about line endings and path separators, and a decision made at
// every call site is a decision made differently; the `tests-read-through-
// source-tree` lint rule keeps it here.

/**
 * A repo file as text, with CRLF collapsed to LF.
 *
 * Every assertion below that matches source against a pattern containing `\n`,
 * and every anchor handed to `sliceBetween` that spells a line
 * break, is a claim about bytes Git checked out. On Windows `core.autocrlf`
 * defaults to true, so the whole working tree arrives CRLF, none of those
 * patterns match, and `sliceBetween` throws `expected to find "…"` for an anchor
 * that is sitting right there in the file.
 *
 * Not hypothetical: fifteen test files were red on the maintainer's Windows
 * checkout while cutting v2.7.0, and were hand-patched one assertion at a time
 * in #452 — `[^\r\n]` here, `source.includes('\r\n') ? … : …` there. Those
 * patches are correct and they do not scale. 60 files in this suite read a repo
 * file as text across 135 call sites, every new one re-rolls the same dice on a
 * Unix machine, and the loss is only discovered by a maintainer running the
 * suite on Windows.
 *
 * So the line ending is decided once, here, and every assertion downstream is
 * written against `\n` — the form the files have in the repository.
 *
 * This does not make CRLF untestable, because no test that cares about CRLF
 * reads it off the disk. `editing.test.ts`, `editing.test.ts`
 * and `editor.test.ts` all assert on the parser's handling of a CRLF
 * *document*, and each spells the document as a literal in the test — which is
 * the right way round: a fixture whose bytes matter should not be at the mercy
 * of what Git decided to check out.
 *
 * `path` is `string | URL` because both spellings are already in use: a
 * cwd-relative string (`npm test` runs from the repo root) and
 * `new URL('../src/…', import.meta.url)`, which resolves against the test file
 * rather than the cwd. `readFileSync` takes either, so no call site has to
 * change shape to get normalized.
 *
 * The `import.meta.url` spelling only works under `node --test`. Vitest serves
 * test files through Vite, so `import.meta.url` is an `http://` URL there and
 * `readFileSync` rejects it with "The URL must be of scheme file". A `*.spec.ts`
 * file must use the cwd-relative string form.
 */
export function readSource(path: string | URL): string {
	return readFileSync(path, 'utf8').replace(/\r\n/g, '\n');
}

/**
 * `source` from the first `start` to the first `end` that follows it.
 *
 * Searching `end` from the end of `start` rather than from 0 is deliberate: an
 * `end` that happens to occur earlier in the file produces an empty string, and
 * an empty subject is degenerate for the same reason -1 is.
 */
export function sliceBetween(source: string, start: string, end: string): string {
	const from = source.indexOf(start);
	assert.notEqual(from, -1, `expected to find ${JSON.stringify(start)}`);
	const to = source.indexOf(end, from + start.length);
	assert.notEqual(to, -1, `expected to find ${JSON.stringify(end)} after ${JSON.stringify(start)}`);
	return source.slice(from, to);
}

/**
 * The offset of `marker` in `source`, which must be present.
 *
 * The third shape, for the assertions that compare two offsets rather than
 * slice with them: `assert.ok(a < b)` reads as "a comes first" but is also
 * satisfied by `a === -1`, so a marker that stopped existing turns the
 * ordering claim into a claim about nothing — the same failure `sliceBetween`
 * guards against, one operator away. `from` mirrors `String#indexOf`'s second
 * argument for the "…after this point" cases.
 */
export function offsetOf(source: string, marker: string, from = 0): number {
	const at = source.indexOf(marker, from);
	assert.notEqual(at, -1, `expected to find ${JSON.stringify(marker)}`);
	return at;
}

/**
 * Every `.rs` file of the backend, repo-relative and sorted.
 *
 * Named rather than listed because the list changes: `lib.rs` was one 5,500
 * line file until it was split into `fs_safety`/`markdown`/`commands`/`app`,
 * and every test that had spelled `src-tauri/src/lib.rs` went red on a change
 * that moved no code. A test asking "does the backend do X" is asking about
 * the crate, not about which file the author last put X in.
 */
export function rustSourceFiles(): string[] {
	// Cwd-relative, not `import.meta.url`: see the note on `readSource`. Under
	// vitest that URL is `http://`, which `readdirSync` refuses outright.
	return readdirSync('src-tauri/src')
		.filter((name) => name.endsWith('.rs'))
		.sort()
		.map((name) => `src-tauri/src/${name}`);
}
