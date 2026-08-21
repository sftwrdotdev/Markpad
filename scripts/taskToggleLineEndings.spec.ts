import assert from 'node:assert/strict';

import { test } from 'vitest';

import { readRustBackend, readSource, sliceBetween, sliceFrom } from './sourceTree.js';

import { LIST_MARKER, TASK_BOX } from '../src/lib/utils/listSyntax.js';

// Toggling a task checkbox in the preview finds the line to rewrite by counting
// `\n` up to the regex match. Three rounds of fixes for #148 were verified on
// macOS, i.e. on LF, and all three missed that the count is wrong on CRLF:
//
//   `\s` matches `\r` as well as `\n`, and JavaScript's `/m` `^` also matches
//   between a `\r` and its `\n`. With `\s*` greedy, every match began one
//   character early — on the previous line's `\n` — so the slice held one `\n`
//   too few and every task resolved to line N-1.
//
// On the LAST task that is a no-op: nothing matches `sourceLine`, `toggle`
// returns false, and the caller restores the control. The reporter reads that
// as "the checkbox does not work". Everywhere else the off-by-one lands on a
// *real* task line and silently rewrites the wrong one, which is worse and was
// never reported because nobody could see it happen.
//
// These tests drive the real document session over both line endings. The
// existing behavioural toggle test lives in `truncatedBufferGuard.test.ts` and
// passes `sourceLine: 1` — the one line number the bug cannot reach, since at
// offset 0 there is no preceding terminator for `\s*` to eat.

// The runes are the compiler's, not ours: vitest builds `.svelte.ts` through the
// Svelte plugin, so the store and the session run under real reactivity, and jsdom
// supplies `window` and `localStorage`. Only the Tauri backend is stubbed.

let invokeCalls: Array<{ cmd: string; args: any }> = [];
let handleInvoke: (cmd: string, args: any) => unknown = () => {
	throw new Error('unexpected invoke');
};

(window as any).__TAURI_INTERNALS__ = {
	metadata: { currentWindow: { label: 'main' }, currentWebview: { windowLabel: 'main', label: 'main' } },
	invoke: (cmd: string, args: any) => {
		invokeCalls.push({ cmd, args });
		return Promise.resolve(handleInvoke(cmd, args)).then((value) => value);
	},
};

const { tabManager } = await import('../src/lib/stores/tabs.svelte.js');
const { createDocumentSession } = await import('../src/lib/sessions/documentSession.svelte.js');

function makeSession() {
	return createDocumentSession({
		setShowHome: () => {},
		currentFile: () => tabManager.activeTab?.path ?? '',
		resetScrollHistory: () => {},
		renderMarkdown: async (raw: string) => `<p>${raw.length}</p>`,
		afterLoad: async () => {},
		saveRecentFile: () => {},
		deleteRecentFile: () => {},
		setLoadingTabs: () => {},
		measureInitialViewport: () => {},
		isScrolling: () => false,
		renderRichContent: () => {},
		onError: () => {},
		onDiskChangedUnderSave: () => {},
		cancelPendingAutoSave: () => {},
		askClose: async () => 'discard' as const,
		onCloseSaveNewerEdits: () => {},
		onCloseAutoSaveFailed: () => {},
		onPartialCopySaved: () => {},
	});
}

/**
 * Opens `doc`, toggles the task on `sourceLine`, and returns what was written.
 *
 * Returns null when the toggle refused to write, which is the shape the last
 * task in a CRLF document had before this fix.
 */
async function toggledContent(doc: string, sourceLine: number, nowChecked: boolean) {
	tabManager.closeAll();
	invokeCalls = [];
	handleInvoke = (cmd) => {
		if (cmd === 'open_markdown_preview') return ['<p>preview</p>', doc, false, false];
		if (cmd === 'read_file_content_checked') return [doc, false];
		if (cmd === 'save_file_content') return null;
		return null;
	};
	const session = makeSession();
	await session.loadMarkdown('/docs/tasks.md');
	await session.toggleTaskCheckbox(sourceLine, nowChecked);
	const write = invokeCalls.find((call) => call.cmd === 'save_file_content');
	return write ? (write.args.content as string) : null;
}

/**
 * The same document in both line endings, so a case can be run over each.
 *
 * The blank line before the list is not decoration — it is the condition that
 * makes this reachable on LF. `\s*` is greedy and `/m` `^` matches at the
 * start of the blank line, so the match ate the blank line's terminator and
 * `offset` landed one line early. Every list written the ordinary way, with a
 * blank line above it, hit this on every platform; CRLF widened it from the
 * first task of each block to all of them.
 */
function document(eol: string) {
	return ['intro', '', '- [ ] one', '- [ ] two', '- [ ] three'].join(eol) + eol;
}

/** A list that starts immediately after prose — the shape that always worked. */
function documentWithoutBlankLine(eol: string) {
	return ['intro', '- [ ] one', '- [ ] two'].join(eol) + eol;
}

for (const [name, eol] of [
	['LF', '\n'],
	['CRLF', '\r\n'],
] as const) {
	test(`${name}: the task the reader clicked is the task that changes`, async () => {
		// Line 3 is `- [ ] two`. Under the old pattern this resolved to line 2
		// and rewrote `one` instead — a silent, invisible wrong write.
		const written = await toggledContent(document(eol), 4, true);
		assert.ok(written, 'the toggle wrote');
		assert.equal(written, ['intro', '', '- [ ] one', '- [x] two', '- [ ] three'].join(eol) + eol);
	});

	test(`${name}: the last task toggles at all`, async () => {
		// Line 4 is the last task. Under the old pattern nothing matched line 4,
		// so the write was skipped entirely and the control snapped back. This
		// is the symptom #148 reports.
		const written = await toggledContent(document(eol), 5, true);
		assert.ok(written, 'the toggle wrote instead of silently refusing');
		assert.equal(written, ['intro', '', '- [ ] one', '- [ ] two', '- [x] three'].join(eol) + eol);
	});

	test(`${name}: unticking is the same arithmetic`, async () => {
		const doc = ['intro', '', '- [x] one', '- [x] two'].join(eol) + eol;
		const written = await toggledContent(doc, 4, false);
		assert.equal(written, ['intro', '', '- [x] one', '- [ ] two'].join(eol) + eol);
	});

	test(`${name}: only one line changes`, async () => {
		// The failure mode this guards is a match that spans the previous line's
		// terminator: the replacement then rewrites two lines at once.
		const before = document(eol);
		const written = await toggledContent(before, 4, true);
		assert.ok(written);
		const changed = written!
			.split(eol)
			.filter((line, index) => line !== before.split(eol)[index]);
		assert.deepEqual(changed, ['- [x] two'], 'exactly one line differs');
	});

	test(`${name}: the shapes the write-back claims to support`, async () => {
		// Ordered, parenthesised, quoted, nested and `*`/`+` bullets all go
		// through the same pattern; the CRLF bug hit every one of them.
		const doc = ['intro', '', '1. [ ] ordered', '2) [ ] paren', '> - [ ] quoted', '  * [ ] nested', '+ [ ] plus'].join(eol) + eol;
		for (const [line, expected] of [
			[3, '1. [x] ordered'],
			[4, '2) [x] paren'],
			[5, '> - [x] quoted'],
			[6, '  * [x] nested'],
			[7, '+ [x] plus'],
		] as const) {
			const written = await toggledContent(doc, line, true);
			assert.ok(written, `line ${line} wrote`);
			assert.equal(written!.split(eol)[line - 1], expected);
		}
	});
}

test('the marker grammar the renderer reads still matches listSyntax.ts', () => {
	// The last cross-language copy of this vocabulary. The rewrite above only
	// gets a chance to run on lines the *renderer* turned into a task item, and
	// `TASK_SOURCE_RE` is what decides that — so a marker one side accepts and
	// the other does not is a checkbox that draws and then refuses to toggle.
	// Every TypeScript reader imports the fragments from utils/listSyntax.ts
	// (pinned by singleImplementationConvention.test.ts); Rust cannot, so the
	// drift is caught here instead, by reading the pattern back out of the
	// source and looking for the fragments inside it.
	//
	// Fragments rather than the whole pattern, deliberately: what surrounds them
	// is allowed to differ. Rust asks a yes/no question about one line and may
	// spell its whitespace `\s`; the rewrite above works over the whole body
	// with `/m` and may not (see the comment at the call site). The marker
	// itself is the only part that has to be the same on both sides.
	const declared = sliceFrom(readRustBackend(), 'static TASK_SOURCE_RE');
	const pattern = /Regex::new\(r"([^"]*)"\)/.exec(declared);
	assert.notEqual(pattern, null, 'TASK_SOURCE_RE no longer holds a raw regex literal');

	for (const fragment of [LIST_MARKER, TASK_BOX]) {
		assert.ok(
			pattern![1].includes(fragment),
			`the Rust renderer reads ${JSON.stringify(pattern![1])}, which does not contain ${fragment} — the two sides disagree about what a list item is`,
		);
	}
});

test('a tab-indented task keeps its indentation', async () => {
	// `[ \t]*` has to admit a tab, or a tab-indented task stops being found at
	// all — the failure the narrowing could plausibly have introduced.
	const doc = ['intro', '', '\t- [ ] tabbed'].join('\r\n') + '\r\n';
	const written = await toggledContent(doc, 3, true);
	assert.equal(written, ['intro', '', '\t- [x] tabbed'].join('\r\n') + '\r\n');
});

// The condition, isolated. A list that begins immediately after prose was
// always correct on LF — which is why the first version of this file, whose
// fixtures had no blank line, passed on LF and hid half the bug.
for (const [name, eol] of [
	['LF', '\n'],
	['CRLF', '\r\n'],
] as const) {
	test(`${name}: a list with no blank line above it`, async () => {
		const written = await toggledContent(documentWithoutBlankLine(eol), 3, true);
		assert.equal(written, ['intro', '- [ ] one', '- [x] two'].join(eol) + eol);
	});
}

test('LF: the first task after a blank line is the one that regressed', async () => {
	// On LF only the first task of each block was wrong: `\s*` could eat the
	// blank line's single `\n`, but not a task line above it. That is why
	// samples/stress-test.md — 44 tasks, LF — had exactly six wrong, one per
	// block. CRLF widened it to every task, because `^` also matches between
	// a `\r` and its `\n`.
	const doc = ['intro', '', '- [ ] one', '- [ ] two'].join('\n') + '\n';
	const written = await toggledContent(doc, 3, true);
	assert.equal(written, ['intro', '', '- [x] one', '- [ ] two'].join('\n') + '\n');
});

test('LF: two blank lines above the list', async () => {
	const doc = ['intro', '', '', '- [ ] one'].join('\n') + '\n';
	const written = await toggledContent(doc, 4, true);
	assert.equal(written, ['intro', '', '', '- [x] one'].join('\n') + '\n');
});

// ---------------------------------------------- the toggle does not re-render
//
// Ticking a checkbox writes the buffer, and MarkdownViewer's render effect
// re-renders whenever the buffer stops matching `previewedRawContent`. It
// would rebuild the whole article to arrive at the DOM already on screen — the
// browser has drawn the native checkbox and the caller has added `task-done` —
// and rebuilding drops the reader's scroll position, which in a long document
// throws the view somewhere else entirely.

const sessionSource = readSource('src/lib/sessions/documentSession.svelte.ts');

test('a toggle tells the preview it is already up to date', async () => {
	const doc = ['intro', '', '- [ ] one', '- [ ] two'].join('\n') + '\n';
	tabManager.closeAll();
	invokeCalls = [];
	handleInvoke = (cmd) => {
		if (cmd === 'open_markdown_preview') return ['<p>preview</p>', doc, false, false];
		if (cmd === 'read_file_content_checked') return [doc, false];
		if (cmd === 'save_file_content') return null;
		return null;
	};
	const session = makeSession();
	await session.loadMarkdown('/docs/tasks.md');
	const tab = tabManager.activeTab!;

	await session.toggleTaskCheckbox(3, true);

	assert.equal(tab.previewedRawContent, tab.rawContent, 'the render effect has nothing to do');
});

test('it is marked before anything can be awaited', () => {
	// The render effect arms its 16ms timer the moment the buffer changes and
	// checks the field BEFORE that — so marking after an `await` would be too
	// late to prevent the render it has already scheduled.
	const fn = sliceBetween(sessionSource, 'async function toggleTaskCheckbox(', '\n\tasync function ');
	const marked = fn.indexOf('tab.previewedRawContent = updated;');
	const awaited = fn.indexOf('await saveContent');
	assert.ok(marked > 0, 'the toggle marks the preview');
	assert.ok(marked < awaited, 'marked before the first await after the write');
});
