import assert from 'node:assert/strict';

import { test } from 'vitest';

/*
 * `isLossySaveRefused` is read by the auto-save timer's FAILURE handler:
 *
 *     if (documentSession.isLossySaveRefused(s.id)) return;   // no toast
 *     addToast(t('toast.autoSaveFailed'), 'error');
 *
 * The intent is right — a refused save already explained itself, naming the
 * file and the way out, so "auto-save failed" on top says nothing new. But the
 * predicate was `lossySaveWarnedTabs.has(tabId)`, membership in a set that is
 * only ever cleared by `loadMarkdown` and `saveContentAs`. The tab's decode
 * fidelity is re-decided by four other sites — `ensureFullContent`, entering
 * the editor, entering split view, a cross-window arrival — every one of which
 * can clear `hasReplacementChars` for a file converted to UTF-8 since the load,
 * and none of which touches the set.
 *
 * So a tab could stop decoding lossily, start auto-saving again (the
 * eligibility gate is `decodedLossily && isLossySaveRefused`, which correctly
 * re-opens), and then have every subsequent auto-save failure — disk full,
 * permission denied, a network volume that went away — silently swallow its
 * toast, for the rest of that tab's life.
 *
 * The condition the name promises is "this tab's saves are being refused for
 * the lossy-decode reason, right now", and "right now" is a property of the
 * tab, not a memory of what was once said about it.
 */

// The runes are the compiler's, not ours: vitest builds `.svelte.ts` through the
// Svelte plugin, so the store and the session run under real reactivity. Only
// the Tauri backend, which jsdom cannot provide, is stubbed.

/** Whether `save_file_content` succeeds. Set per test. */
let writeFails = false;
const LOSSY = 'text with � in it';

(window as any).__TAURI_INTERNALS__ = {
	metadata: { currentWindow: { label: 'main' }, currentWebview: { windowLabel: 'main', label: 'main' } },
	invoke: (command: string, args: Record<string, unknown>) => {
		const cmd = command.replace(/^plugin:[^|]*\|/, '');
		if (cmd === 'get_os_type') return Promise.resolve('macos');
		if (cmd === 'canonicalize_path') return Promise.resolve(args.path);
		if (cmd === 'open_markdown_preview') return Promise.resolve(['', LOSSY, true, true]);
		if (cmd === 'read_file_content_checked') return Promise.resolve([LOSSY, true]);
		if (cmd === 'save_file_content') {
			return writeFails ? Promise.reject(new Error('Os { code: 28, kind: StorageFull }')) : Promise.resolve(null);
		}
		return Promise.resolve(null);
	},
};

const { tabManager } = await import('../src/lib/stores/tabs.svelte.js');
const { createDocumentSession } = await import('../src/lib/sessions/documentSession.svelte.js');

/** Every message the user would actually see, in order. */
let toasts: string[] = [];

function makeSession() {
	return createDocumentSession({
		setShowHome: () => {},
		currentFile: () => tabManager.activeTab?.path ?? '',
		resetScrollHistory: () => {},
		renderMarkdown: async () => '',
		afterLoad: async () => {},
		saveRecentFile: () => {},
		deleteRecentFile: () => {},
		setLoadingTabs: () => {},
		measureInitialViewport: () => {},
		isScrolling: () => false,
		renderRichContent: () => {},
		onError: (message) => void toasts.push(message),
		selfWriteGraceMs: 400,
		cancelPendingAutoSave: () => {},
		askClose: async () => 'discard' as const,
		onCloseSaveNewerEdits: () => {},
		onCloseAutoSaveFailed: () => {},
		onPartialCopySaved: () => {},
	});
}

/**
 * A tab holding a buffer that came out of a lossy decode, edited, and refused
 * once — which is the state the refusal set records.
 */
async function refusedTab() {
	tabManager.closeAll();
	toasts = [];
	writeFails = false;
	const session = makeSession();
	await session.loadMarkdown('/notes/legacy.md');
	const tab = tabManager.activeTab!;
	assert.equal(tab.hasReplacementChars, true, 'precondition: the decode was lossy');

	tabManager.updateTabRawContent(tab.id, 'edited');
	assert.equal(await session.saveContent(tab.id), false, 'the guard must refuse this write');
	assert.equal(toasts.length, 1, 'and explain itself exactly once');
	assert.equal(session.isLossySaveRefused(tab.id), true);
	return { session, tab };
}

test('a refusal still speaks once, and stays quiet afterwards', async () => {
	// The behaviour that must survive: while the tab still decodes lossily,
	// every further attempt is the same standing condition, already explained.
	const { session, tab } = await refusedTab();

	tabManager.updateTabRawContent(tab.id, 'edited again');
	assert.equal(await session.saveContent(tab.id), false);
	tabManager.updateTabRawContent(tab.id, 'and again');
	assert.equal(await session.saveContent(tab.id), false);

	assert.equal(toasts.length, 1, 'a standing condition is not re-reported');
	assert.equal(session.isLossySaveRefused(tab.id), true, 'and the timer keeps its toast suppressed');
});

test('a tab that no longer decodes lossily is no longer being refused', async () => {
	// The file was converted to UTF-8 and the tab re-read it. This is what
	// `ensureFullContent`, `toggleEdit`, split view and a cross-window arrival
	// all do — none of them goes through `loadMarkdown`, so none of them
	// clears the set.
	const { session, tab } = await refusedTab();
	tabManager.setTabDecodedLossy(tab.id, false);

	assert.equal(session.isLossySaveRefused(tab.id), false, 'nothing is being refused any more');
});

test('a real auto-save failure on that tab is still reportable', async () => {
	// End to end, in the shape the auto-save timer sees it: `saveContent`
	// returns false, and the predicate the timer consults before deciding
	// whether to raise `toast.autoSaveFailed` must not claim this was a
	// refusal. Under the stale-set predicate it did, and the user was left
	// believing a full disk had saved their work.
	const { session, tab } = await refusedTab();
	tabManager.setTabDecodedLossy(tab.id, false);
	writeFails = true;

	tabManager.updateTabRawContent(tab.id, 'work the user expects to be saved');
	assert.equal(await session.saveContent(tab.id), false, 'the write really did fail');
	assert.equal(
		session.isLossySaveRefused(tab.id),
		false,
		'a failure is not a refusal, so the timer must be free to report it',
	);
});

test('the flag goes back up if the file is lossy again', async () => {
	// Symmetry: the predicate answers about the tab as it is now, in both
	// directions. A tab that was converted back (or a second file opened into
	// the same tab that is lossy) is refused again — and having already been
	// told once, it is not told twice.
	const { session, tab } = await refusedTab();
	tabManager.setTabDecodedLossy(tab.id, false);
	tabManager.setTabDecodedLossy(tab.id, true);

	assert.equal(session.isLossySaveRefused(tab.id), true);
	assert.equal(await session.saveContent(tab.id), false);
	assert.equal(toasts.length, 1, 'still only the one explanation');
});

test('a closed tab is not remembered as refused', async () => {
	// `closeTab` splices the tab out with no dispose hook, so the set keeps
	// the id forever. Ids are `crypto.randomUUID()` and never reused, so this
	// is a bounded leak rather than a correctness problem — but the predicate
	// must not answer "yes" about a tab that no longer exists.
	const { session, tab } = await refusedTab();
	const id = tab.id;
	tabManager.closeTab(id);

	assert.equal(session.isLossySaveRefused(id), false);
});
