import assert from 'node:assert/strict';
import test from 'node:test';

import { offsetOf, readRustBackend, readSource, readSourceFiles, sliceBetween } from './sourceTree.js';

// Runes and the Tauri bridge, shimmed the way truncatedBufferGuard.test.ts
// shims them: the stores are runes modules, and Node's test runner gives every
// file its own process, so this cannot leak into another suite.
const g = globalThis as any;
const runeEffect = (fn: () => void) => {
	void fn;
};
runeEffect.root = (fn: () => unknown) => fn();
g.$state = (value: unknown) => value;
g.$state.raw = (value: unknown) => value;
g.$state.snapshot = (value: unknown) => value;
g.$derived = (value: unknown) => value;
g.$derived.by = (fn: () => unknown) => fn();
g.$effect = runeEffect;
g.window = g.window ?? {};
Object.defineProperty(g, 'navigator', { value: { language: 'en-US' }, configurable: true });
Object.defineProperty(g, 'localStorage', {
	value: { getItem: () => null, setItem: () => {}, removeItem: () => {}, clear: () => {} },
	configurable: true,
});

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
 * `ensureFullContent` is exercised for real below. The two MarkdownViewer sites
 * are in a Svelte component and are asserted against its source: those tests
 * establish that the checked command is called and its verdict stored, not that
 * the store then behaves — `lossyDecodeSaveGuard.test.ts` covers that.
 *
 * The second half of this file is the toast the guard's refusal used to
 * trigger every 1.5 seconds.
 */

const PARTIAL = 'first half';
const FULL = 'first half and the rest';

/** Set per test. `get_os_type` is the settings store booting on import. */
let handleInvoke: (cmd: string, args: Record<string, unknown>) => unknown = (cmd) => {
	if (cmd === 'get_os_type') return 'macos';
	throw new Error(`unexpected invoke: ${cmd}`);
};
const errors: string[] = [];

g.window.__TAURI_INTERNALS__ = {
	invoke: (command: string, args: Record<string, unknown>) =>
		Promise.resolve(handleInvoke(command.replace(/^plugin:[^|]*\|/, ''), args ?? {})),
	transformCallback: (fn: unknown) => fn,
};

const { tabManager } = await import('../src/lib/stores/tabs.svelte.js');
const { createDocumentSession } = await import('../src/lib/sessions/documentSession.svelte.js');

function makeSession() {
	return createDocumentSession({
		setShowHome: () => {},
		currentFile: () => tabManager.activeTab?.path ?? '',
		resetScrollHistory: () => {},
		renderMarkdown: async () => '<p>x</p>',
		afterLoad: async () => {},
		saveRecentFile: () => {},
		deleteRecentFile: () => {},
		setLoadingTabs: () => {},
		measureInitialViewport: () => {},
		isScrolling: () => false,
		renderRichContent: () => {},
		onError: (message) => errors.push(message),
		selfWriteGraceMs: 400,
		cancelPendingAutoSave: () => {},
		askClose: async () => 'discard' as const,
		onCloseSaveNewerEdits: () => {},
		onCloseAutoSaveFailed: () => {},
		onPartialCopySaved: () => {},
	});
}

/** Open a >50KB file and leave the background full read pending forever. */
async function openPartial() {
	tabManager.closeAll();
	errors.length = 0;
	handleInvoke = (cmd) => {
		if (cmd === 'open_markdown_preview') return ['<p>preview</p>', PARTIAL, false, false];
		if (cmd === 'read_file_content_checked') return new Promise(() => {});
		throw new Error(`unexpected invoke: ${cmd}`);
	};
	const session = makeSession();
	await session.loadMarkdown('/docs/big.md');
	const tab = tabManager.activeTab!;
	assert.equal(tab.isTruncated, true, 'precondition: the buffer is partial');
	assert.equal(tab.hasReplacementChars, false, 'precondition: the preview decoded cleanly');
	return { session, tab };
}

test('completing a partial buffer carries the tail\'s own verdict', async () => {
	// The case the old comment called safe: the preview covered the first 50KB
	// and decoded cleanly, but a file can be valid UTF-8 up to there and not
	// after. With the bare command the tab kept the preview's verdict and the
	// next auto-save wrote U+FFFD over the file.
	const { session, tab } = await openPartial();

	handleInvoke = (cmd) => {
		if (cmd === 'read_file_content_checked') return [FULL, true];
		throw new Error(`unexpected invoke: ${cmd}`);
	};

	assert.equal(await session.ensureFullContent(tab.id), true);
	assert.equal(tab.rawContent, FULL);
	assert.equal(tab.hasReplacementChars, true, 'the completed buffer must carry its own fidelity');
});

test('completing a clean tail also clears a stale flag', async () => {
	// The same mechanism in the other direction: a verdict that is decided on
	// every read cannot go stale.
	const { session, tab } = await openPartial();
	tabManager.setTabDecodedLossy(tab.id, true);

	handleInvoke = (cmd) => {
		if (cmd === 'read_file_content_checked') return [FULL, false];
		throw new Error(`unexpected invoke: ${cmd}`);
	};

	assert.equal(await session.ensureFullContent(tab.id), true);
	assert.equal(tab.hasReplacementChars, false);
});

test('the completed buffer is refused or accepted according to that verdict', async () => {
	// End to end: the flag is not decoration, it decides the write.
	const { session, tab } = await openPartial();
	handleInvoke = (cmd) => {
		if (cmd === 'read_file_content_checked') return [FULL, true];
		if (cmd === 'save_file_content') return null;
		throw new Error(`unexpected invoke: ${cmd}`);
	};
	await session.ensureFullContent(tab.id);

	assert.equal(await session.saveContent(tab.id), false, 'a lossy buffer must not overwrite its file');
	assert.equal(session.isLossySaveRefused(tab.id), true);
	assert.ok(errors.length > 0, 'and the user is told once');
});

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
