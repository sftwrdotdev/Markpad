import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';

import { test } from 'vitest';

import { readSource } from './sourceTree.js';

const sessionPath = 'src/lib/sessions/documentSession.svelte.ts';
const session = existsSync(sessionPath) ? readSource(sessionPath) : '';

test('large-file completion requires the current clean load revision and unchanged view mode', () => {
	assert.match(session, /const loadRevisionByTab = new Map<string, number>\(\);/);
	assert.match(session, /const fullLoadRevision = \(loadRevisionByTab\.get\(activeId\) \?\? 0\) \+ 1;/);
	assert.match(session, /loadRevisionByTab\.set\(activeId, fullLoadRevision\);/);
	assert.match(
		session,
		/loadRevisionByTab\.get\(activeId\) === fullLoadRevision[\s\S]*!targetTab\.isDirty[\s\S]*targetTab\.isEditing === initialIsEditing[\s\S]*targetTab\.isSplit === initialIsSplit/,
	);
});

// #547. The revision above guarded the SECOND stage only. The first stage wrote
// the buffer, the encoding and the truncation flag unconditionally, across two
// awaits — so when two loads overlapped on one tab and the older one's preview
// read landed last, it overwrote the winner's complete buffer with its 50KB
// slice and re-raised `isTruncated`. Its own second stage was then correctly
// rejected by the revision it had just lost. Nothing retried, nothing recorded
// it, and from then on every save was refused.
//
// Two loads overlap because the startup path is delivered on two channels that
// nothing dedupes: `RunEvent::Opened` stashes it for `send_markdown_path` AND
// emits `file-path`, and argv is read by both.
//
// These drive the real TabManager and the real document session, so they lock
// the outcome rather than the shape of the guard.

// The runes are the compiler's, not ours: vitest builds `.svelte.ts` through the
// Svelte plugin, so the store and the session run under real reactivity, and jsdom
// supplies `window` and `localStorage`. Only the Tauri backend is stubbed.

// The preview always returns isFull=false to exercise the two-stage path
// regardless of the actual threshold — no need for a multi-MB test string.
const FULL = '# big\n\n' + 'x'.repeat(200) + '\n\ntail that must never be lost\n';
const PARTIAL = FULL.slice(0, 40) + '…';

/** Per-call delays, so the two concurrent loads can be ordered deliberately. */
let previewDelays: number[] = [];
let previewCall = 0;
let savedContent: string | null = null;

let handleInvoke: (cmd: string, args: any) => unknown = () => {
	throw new Error('unexpected invoke');
};

(window as any).__TAURI_INTERNALS__ = {
	metadata: { currentWindow: { label: 'main' }, currentWebview: { windowLabel: 'main', label: 'main' } },
	invoke: (cmd: string, args: any) => Promise.resolve(handleInvoke(cmd, args)),
};

const { tabManager } = await import('../src/lib/stores/tabs.svelte.js');
const { createDocumentSession } = await import('../src/lib/sessions/documentSession.svelte.js');
const { settings } = await import('../src/lib/stores/settings.svelte.js');

const errors: string[] = [];
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

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
		onError: (message) => errors.push(message),
		selfWriteGraceMs: 400,
		cancelPendingAutoSave: () => {},
		askClose: async () => 'discard' as const,
		onCloseSaveNewerEdits: () => {},
		onCloseAutoSaveFailed: () => {},
		onPartialCopySaved: () => {},
	});
}

function reset() {
	tabManager.closeAll();
	errors.length = 0;
	previewCall = 0;
	savedContent = null;
	settings.openFileMode = 'preview';
	handleInvoke = (cmd, args) => {
		if (cmd === 'canonicalize_path') return '/docs/big.md';
		if (cmd === 'open_markdown_preview') {
			const delay = previewDelays[previewCall++] ?? 0;
			// Always return isFull=false to exercise the two-stage load path
			return wait(delay).then(() => ['<p>preview</p>', PARTIAL, false, false, 'UTF-8']);
		}
		if (cmd === 'read_file_content_checked') return [FULL, false, 'UTF-8'];
		if (cmd === 'save_file_content') {
			savedContent = args.content;
			return null;
		}
		throw new Error(`unexpected invoke: ${cmd}`);
	};
}

/** Both startup channels deliver the same path; only the timing differs. */
async function loadTwice() {
	const session = makeSession();
	// The `file-path` listener does not await its load; `send_markdown_path` does.
	const first = session.loadMarkdown('/docs/big.md');
	const second = session.loadMarkdown('/docs/big.md');
	await Promise.all([first, second]);
	await wait(500);
	return { session, tab: tabManager.activeTab! };
}

test('an overtaken load cannot leave the tab holding its preview slice', async () => {
	reset();
	// The first load's preview read is slow, so it lands after the second load
	// has already completed the tab. This is the ordering that stranded it.
	previewDelays = [120, 10];
	const { tab } = await loadTwice();

	assert.equal(tab.rawContent, FULL, 'the complete file must survive the stale preview');
	assert.notEqual(tab.isTruncated, true);
});

test('a tab left by overlapping loads can still be saved, in full', async () => {
	reset();
	previewDelays = [120, 10];
	const { session, tab } = await loadTwice();

	assert.equal(await session.saveContent(tab.id), true, `save was refused: ${errors.join('; ')}`);
	// The refusal is the only thing between this state and a truncated write,
	// so a save that succeeds must be a save of the whole document.
	assert.equal(savedContent, FULL);
});

test('overlapping loads settle on the whole file whichever preview read wins', async () => {
	for (const delays of [
		[10, 120], // the first load lands first — the ordering that always worked
		[0, 0], // both resolve on the same tick
		[120, 10], // the first load lands last
	]) {
		reset();
		previewDelays = delays;
		const { tab } = await loadTwice();
		assert.equal(tab.rawContent, FULL, `stranded a slice with delays ${delays.join(',')}`);
		assert.notEqual(tab.isTruncated, true, `left truncated with delays ${delays.join(',')}`);
	}
});

test('a single load of a large file is unaffected', async () => {
	reset();
	previewDelays = [0];
	const session = makeSession();
	await session.loadMarkdown('/docs/big.md');
	await wait(400);

	const tab = tabManager.activeTab!;
	assert.equal(tab.rawContent, FULL);
	assert.notEqual(tab.isTruncated, true);
});
