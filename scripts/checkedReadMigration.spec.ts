/**
 * The behavioural half of `checkedReadMigration.test.ts`: `ensureFullContent`,
 * driven for real.
 *
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
 * These three tests are here rather than in the `.test.ts` because they run the
 * store and the session, and both are runes modules. Under `node --test` they
 * only ran at all because the file installed `$state`/`$derived`/`$effect` onto
 * `globalThis` itself, and a hand-written rune is not the compiler's: no deep
 * proxying, no `$derived` laziness, and `$effect` never re-runs. `tab.isTruncated`
 * and `tab.hasReplacementChars` are read straight back out of the store here,
 * so the shim was standing exactly where the assertions look.
 *
 * The six that stayed behind are the two never-migrate categories: that the
 * unchecked command exists nowhere in `src` and is gone from the Rust crate,
 * and the four `.svelte` source-shape assertions about the component call
 * sites. Nothing this file could run would observe any of them.
 */

import assert from 'node:assert/strict';

import { test } from 'vitest';

const PARTIAL = 'first half';
const FULL = 'first half and the rest';

/** Set per test. `get_os_type` is the settings store booting on import. */
let handleInvoke: (cmd: string, args: Record<string, unknown>) => unknown = (cmd) => {
	if (cmd === 'get_os_type') return 'macos';
	throw new Error(`unexpected invoke: ${cmd}`);
};
const errors: string[] = [];

// The runes are the compiler's, not ours: vitest builds `.svelte.ts` through the
// Svelte plugin. Only the Tauri backend, which jsdom cannot provide, is stubbed.
(window as any).__TAURI_INTERNALS__ = {
	metadata: { currentWindow: { label: 'main' }, currentWebview: { windowLabel: 'main', label: 'main' } },
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

test("completing a partial buffer carries the tail's own verdict", async () => {
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
