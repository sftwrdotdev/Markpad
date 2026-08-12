import assert from 'node:assert/strict';
import test from 'node:test';

import { offsetOf, readRustBackend, readSource, readSourceFiles, sliceBetween } from './sourceTree.js';

/*
 * #379 made every read that fills a WRITABLE buffer report whether the decode
 * was lossy, so the tab can refuse to write U+FFFD back over a file that was
 * merely in another encoding. Three reads kept the bare command:
 * `ensureFullContent`, and the two in MarkdownViewer that fill the editor and
 * the split pane. They were safe — but only because each re-read a file whose
 * tab `loadMarkdown` had already flagged. That is an invariant held by call
 * sites agreeing with each other, and the failure mode when one stops agreeing
 * is a destroyed document. It is now held by the code: every one of them reads
 * the fidelity itself.
 *
 * WHAT IS LEFT IN THIS FILE, AND WHY IT IS HERE RATHER THAN UNDER VITEST
 *
 * Every assertion below reads source text, and each one is of a kind no run can
 * reach:
 *
 *   - that the unchecked command exists NOWHERE. An absence is not observable
 *     at run time: executing the checked read cannot prove there is no other
 *     caller of the unchecked one. The same claim then crosses into the Rust
 *     crate, where nothing but the spelling connects the two sides.
 *   - the two MarkdownViewer call sites, and the two auto-save ones. They are
 *     in a `.svelte` component, and mounting one here would put jsdom in for
 *     Monaco, mermaid and KaTeX to earn a weaker claim than the text does —
 *     what these pin is the ORDER of statements inside a handler (flag the tab
 *     before the buffer is published; recognise the refusal before raising the
 *     generic toast), which is a property of the code as written.
 *
 * `ensureFullContent` is not here: it is a runes module driven for real, and
 * running it under a hand-written `$state` was standing exactly where the
 * assertions look. It is `checkedReadMigration.spec.ts` now. `lossyDecodeSaveGuard.test.ts`
 * and `lossySaveRefusalScope.spec.ts` cover the store behaviour these source
 * assertions deliberately stop short of.
 *
 * The second half of this file is the toast the guard's refusal used to
 * trigger every 1.5 seconds.
 */

// --- the two component call sites -------------------------------------------

const viewer = readSource('src/lib/MarkdownViewer.svelte');

test('the unchecked read command is gone, and nothing calls it', () => {
	// This was a three-file allowlist — the files #379 migrated. That is the
	// wrong shape for a rule that means "nobody, anywhere": a fourth file
	// added the call and the test still passed. Two changes fix it. The scan
	// below covers the whole tree, so a new file cannot slip under it. And the
	// Rust command itself is deleted, which is what turns the rule from a
	// convention into a fact: `read_file_content` is not registered any more,
	// so invoking it fails loudly instead of quietly filling a buffer with
	// mojibake nothing flagged.
	const offenders = readSourceFiles('src')
		.filter(({ text }) => /invoke\('read_file_content'/.test(text))
		.map(({ path }) => path);
	assert.deepEqual(offenders, [], 'read_file_content no longer exists; read_file_content_checked is the read');

	const rust = readRustBackend();
	assert.doesNotMatch(rust, /\basync fn read_file_content\(/, 'the unchecked command must stay deleted');
	assert.doesNotMatch(rust, /^\s*read_file_content,\s*$/m, 'and must not be registered again');
});

test('entering the editor reads the fidelity and stores it', () => {
	const toggle = sliceBetween(viewer, 'async function toggleEdit', 'async function saveContent');
	assert.match(toggle, /\[content, lossy, encoding\] = \(await invoke\('read_file_content_checked', \{ path: tab\.path \}\)\)/);
	const read = offsetOf(toggle, 'read_file_content_checked');
	const flag = offsetOf(toggle, 'setTabDecodedLossy(tab.id, lossy)');
	const store = offsetOf(toggle, 'setTabRawContent(tab.id, content)');
	assert.ok(read < flag && flag < store, 'flag the tab before the buffer is published');
});

test('entering split view reads the fidelity and stores it', () => {
	const enter = sliceBetween(viewer, 'async function toggleSplitView', '} else {');
	assert.match(enter, /\[content, lossy, encoding\] = \(await invoke\('read_file_content_checked', \{ path: tab\.path \}\)\)/);
	const flag = offsetOf(enter, 'setTabDecodedLossy(tab.id, lossy)');
	const store = offsetOf(enter, 'setTabRawContent(tab.id, content)');
	assert.ok(flag < store, 'flag the tab before the buffer is published');
});

// --- the repeating toast ------------------------------------------------------

test('the session can tell a refusal from a failure', () => {
	// `saveContent` returns false for both, which is why the auto-save timer
	// could not tell them apart. The predicate is no longer set membership on
	// its own: the set records what was SAID, and whether the refusal still
	// stands is asked of the tab. `lossySaveRefusalScope.test.ts` exercises
	// both halves for real; this only pins that the tab is consulted at all,
	// since a predicate that answers from memory alone is the defect.
	const body = sliceBetween(
		readSource('src/lib/sessions/documentSession.svelte.ts'),
		'function isLossySaveRefused(',
		'function updateLoading',
	);
	assert.match(body, /lossySaveWarnedTabs\.has\(tabId\)/);
	assert.match(body, /hasReplacementChars/, 'the live tab decides whether anything is still being refused');
});

test('a refused save does not add a generic toast to its own explanation', () => {
	const body = sliceBetween(viewer, 'Auto-save effect.', 'for (const id of [');
	const check = offsetOf(body, 'if (documentSession.isLossySaveRefused(s.id)) return;');
	const toast = offsetOf(body, "t('toast.autoSaveFailed'");
	assert.ok(check < toast, 'the refusal must be recognised before the generic toast is raised');
});

test('a tab that can only be refused stops re-arming the timer', () => {
	// Auto-save re-arms on every keystroke. Without this the guard was reached
	// again every 1.5s for as long as the user kept typing — each time
	// producing the console warning, the wasted round trip, and (before the
	// test above) the toast.
	const body = sliceBetween(viewer, 'Auto-save effect.', 'for (const id of [');
	assert.match(body, /decodedLossily: tab\.hasReplacementChars/);
	assert.match(body, /const eligible = [^;]*!\(s\.decodedLossily && documentSession\.isLossySaveRefused\(s\.id\)\)/);
	// The FIRST attempt must still happen: it is what produces the explanation.
	// `isLossySaveRefused` is false until the guard has spoken, so eligibility
	// only drops afterwards — and "Save As" to a new file clears
	// `hasReplacementChars`, which restores it.
	assert.match(
		readSource('src/lib/sessions/documentSession.svelte.ts'),
		/lossySaveWarnedTabs\.delete\(tab\.id\)/,
	);
});
