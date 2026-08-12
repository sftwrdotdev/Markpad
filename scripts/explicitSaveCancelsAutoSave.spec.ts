import assert from 'node:assert/strict';

import { test } from 'vitest';

import { readSource } from './sourceTree.js';

// An explicit save and the 1.5s auto-save debounce can both be aimed at one
// tab. The debounce is armed on the last keystroke and disarmed by the
// auto-save effect only once `isDirty` goes false — which happens *after* the
// write resolves. So a timer that expires while an explicit save is still in
// flight starts a SECOND write of the same file, and the two race to the
// rename:
//
//   manual save   takes snapshot A ──┐
//   user types (buffer becomes B)    ├── both in flight, order undefined
//   timer fires   takes snapshot B ──┘
//
//   if A lands last: disk holds A, the tab recorded B as saved, isDirty is
//   false. The buffer reads clean while the file is a revision behind, and it
//   stays that way until the next keystroke.
//
// `atomic_write` was hardened separately so two concurrent writers cannot
// corrupt the file or fail each other — but that is a safety property, not an
// ordering one, and it cannot fix a stale winner. The ordering fix is simply
// not to start the second write: whoever is about to save disarms the timer.
//
// The point of these tests is the *placement* of that duty. It used to sit at
// the call sites, where three of six explicit-save entry points remembered it
// and three did not; it now sits inside `saveContent`, so no entry point has
// to know. These assert the duty is discharged there, and that no call site
// has quietly taken it back.

// The runes are the compiler's, not ours: vitest builds `.svelte.ts` through the
// Svelte plugin, so the store and the session run under real reactivity, and jsdom
// supplies `window` and `localStorage`. Only the Tauri backend is stubbed.

const disk = new Map<string, string>();
/**
 * Cancels and writes in the order they happened. One list on purpose: the
 * question is not whether both occurred but which came first, and two counters
 * cannot answer that.
 */
const events: string[] = [];
/** What the Save As dialog returns next. `null` is the user pressing Cancel. */
let nextSaveTarget: string | null = null;

(window as any).__TAURI_INTERNALS__ = {
	metadata: { currentWindow: { label: 'main' }, currentWebview: { windowLabel: 'main', label: 'main' } },
	invoke: (cmd: string, args: any) => {
		if (cmd === 'canonicalize_path') return Promise.resolve(args.path);
		if (cmd === 'read_file_content_checked') return Promise.resolve([disk.get(args.path) ?? '', false]);
		if (cmd === 'open_markdown_preview') return Promise.resolve(['', disk.get(args.path) ?? '', true, false]);
		if (cmd === 'save_file_content') {
			events.push(`write:${args.path}`);
			disk.set(args.path, args.content);
			return Promise.resolve(null);
		}
		if (cmd === 'plugin:dialog|save') return Promise.resolve(nextSaveTarget);
		if (cmd === 'get_os_type') return Promise.resolve('macos');
		return Promise.resolve(null);
	},
};

const { tabManager } = await import('../src/lib/stores/tabs.svelte.js');
const { createDocumentSession } = await import('../src/lib/sessions/documentSession.svelte.js');

function makeSession() {
	return createDocumentSession({
		setShowHome: () => {},
		currentFile: () => tabManager.activeTab?.path ?? '',
		resetScrollHistory: () => {},
		renderMarkdown: async (raw: string) => raw,
		afterLoad: async () => {},
		saveRecentFile: () => {},
		deleteRecentFile: () => {},
		setLoadingTabs: () => {},
		measureInitialViewport: () => {},
		isScrolling: () => false,
		renderRichContent: () => {},
		onError: () => {},
		selfWriteGraceMs: 400,
		cancelPendingAutoSave: (tabId: string) => void events.push(`cancel:${tabId}`),
		askClose: async () => 'discard' as const,
		onCloseSaveNewerEdits: () => {},
		onCloseAutoSaveFailed: () => {},
		onPartialCopySaved: () => {},
	});
}

function reset() {
	tabManager.closeAll();
	tabManager.recentlyClosed.length = 0;
	localStorage.clear();
	disk.clear();
	events.length = 0;
	nextSaveTarget = null;
}

test('an explicit save disarms the debounce before it issues the write', async () => {
	// Order is the whole assertion. Cancelling *after* the write would leave
	// the timer free to fire during the very await this is meant to protect —
	// which is the race, not the fix.
	reset();
	const session = makeSession();
	disk.set('/notes/a.md', 'original');

	await session.loadMarkdown('/notes/a.md');
	const tabId = tabManager.activeTabId!;
	tabManager.updateTabRawContent(tabId, 'edited');

	assert.equal(await session.saveContent(tabId), true);
	assert.deepEqual(events, [`cancel:${tabId}`, 'write:/notes/a.md']);
});

test('a save reached without naming a tab disarms that tab too', async () => {
	// Cmd+S and the toolbar button call `saveContent()` with no argument and
	// let it find the active tab. That is one of the three entry points that
	// never cancelled, so it is the one most worth pinning.
	reset();
	const session = makeSession();
	disk.set('/notes/b.md', 'original');

	await session.loadMarkdown('/notes/b.md');
	const tabId = tabManager.activeTabId!;
	tabManager.updateTabRawContent(tabId, 'edited');

	assert.equal(await session.saveContent(), true);
	assert.deepEqual(events, [`cancel:${tabId}`, 'write:/notes/b.md']);
});

test('a Save dialog the user cancels leaves the timer armed', async () => {
	// The standing rule for `cancelPendingAutoSave`: never disarm on a path the
	// user can still back out of. Cancelling the dialog is exactly that — the
	// tab keeps its edits, so it must keep the writer that will flush them.
	// (An untitled tab has no timer of its own, since the auto-save effect only
	// arms tabs that already have a path; what this really pins is that the
	// cancel sits after the dialog, not before it.)
	reset();
	const session = makeSession();
	tabManager.addTab('');
	const tabId = tabManager.activeTabId!;
	tabManager.updateTabRawContent(tabId, 'unsaved draft');

	nextSaveTarget = null;
	assert.equal(await session.saveContent(tabId), false);
	assert.deepEqual(events, [], 'no cancel, and nothing written');
});

test('no call site takes the cancel duty back from saveContent', async () => {
	// The regression this guards is not a broken save — it is the duty
	// drifting back out to the call sites, where the next entry point can
	// forget it again. A cancel immediately before a `saveContent` is the
	// shape that says someone stopped trusting the function to do it.
	for (const path of ['src/lib/MarkdownViewer.svelte', 'src/lib/sessions/documentSession.svelte.ts']) {
		const body = readSource(path);
		assert.doesNotMatch(
			body,
			/cancelPendingAutoSave\([^)]*\);\s*(?:\/\/[^\n]*\n\s*)*(?:const \w+ = )?(?:await |return )*saveContent\(/,
			`${path} pairs a manual cancel with a save; saveContent already does this`,
		);
	}

	// And the duty is discharged before the write, not after — the source-level
	// mirror of the ordering test above, so a refactor that reorders the two
	// inside `saveContent` is caught even if the stub harness stops seeing it.
	const session = readSource('src/lib/sessions/documentSession.svelte.ts');
	const saveContentBody = session.slice(session.indexOf('async function saveContent('));
	const cancel = saveContentBody.indexOf('options.cancelPendingAutoSave(');
	const write = saveContentBody.indexOf("invoke('save_file_content'");
	assert.ok(cancel !== -1, 'saveContent must cancel the pending auto-save');
	assert.ok(cancel < write, 'the cancel must come before the write it protects');
});
