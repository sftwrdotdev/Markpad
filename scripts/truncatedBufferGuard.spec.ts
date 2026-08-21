import assert from 'node:assert/strict';

import { test } from 'vitest';

import { functionSource, readSource, sliceBetween, sliceFrom } from './sourceTree.js';

// A markdown file larger than 50KB is opened twice: `open_markdown_preview`
// returns the first 50KB so something renders immediately, and a background
// `read_file_content` fills in the rest. Between the two, the tab's ONLY
// buffer is a partial copy of the document. Anything that writes that buffer
// back — auto-save, Cmd+S, a task checkbox, a tab moved to another window —
// permanently truncates the user's file.
//
// These tests drive the real TabManager and the real document session with a
// stubbed Tauri bridge, so they lock the behaviour, not the wording.

// The runes are the compiler's, not ours: vitest builds `.svelte.ts` through the
// Svelte plugin, so the store and the session run under real reactivity, and jsdom
// supplies `window` and `localStorage`. Only the Tauri backend is stubbed.

const PREVIEW_BYTES = 50000;
const FULL = `# big\n\n${'x'.repeat(PREVIEW_BYTES)}\n\ntail that must never be lost\n`;
const PARTIAL = FULL.slice(0, PREVIEW_BYTES);

let invokeCalls: Array<{ cmd: string; args: any }> = [];
/** Set per test. Return a never-settling promise to freeze the partial state. */
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

const viewer = readSource('src/lib/MarkdownViewer.svelte');

const errors: string[] = [];
/** Non-failure notices the session raised, in order. */
const notices: string[] = [];
/** What the close dialog answers next. Set per test. */
let closeAnswer: 'save' | 'discard' | 'cancel' = 'discard';

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
		onDiskChangedUnderSave: () => {},
		cancelPendingAutoSave: () => {},
		askClose: async () => closeAnswer,
		onCloseSaveNewerEdits: () => {},
		onCloseAutoSaveFailed: () => {},
		onPartialCopySaved: () => notices.push('partialCopySaved'),
	});
}

function reset() {
	tabManager.closeAll();
	invokeCalls = [];
	errors.length = 0;
	notices.length = 0;
	closeAnswer = 'discard';
}

/** Open a >50KB file and leave the background full read pending forever. */
async function openPartial(path = '/docs/big.md') {
	handleInvoke = (cmd) => {
		if (cmd === 'open_markdown_preview') return ['<p>preview</p>', PARTIAL, false, false];
		if (cmd === 'read_file_content_checked') return new Promise(() => {});
		throw new Error(`unexpected invoke: ${cmd}`);
	};
	const session = makeSession();
	await session.loadMarkdown(path);
	const tab = tabManager.activeTab!;
	assert.equal(tab.rawContent, PARTIAL, 'precondition: the buffer is the partial read');
	return { session, tab };
}

test('a partially loaded buffer is marked as incomplete', async () => {
	reset();
	const { tab } = await openPartial();

	// Without this flag nothing downstream can tell a 50KB document from the
	// first 50KB of a 5MB one — the buffer looks authoritative and clean.
	assert.equal(tab.isTruncated, true);
	assert.equal(tab.isDirty, false);
});

test('a fully loaded buffer is not marked as incomplete', async () => {
	reset();
	handleInvoke = (cmd) => {
		if (cmd === 'open_markdown_preview') return ['<p>full</p>', FULL, true, false];
		throw new Error(`unexpected invoke: ${cmd}`);
	};
	const session = makeSession();
	await session.loadMarkdown('/docs/small.md');

	assert.notEqual(tabManager.activeTab!.isTruncated, true);
	assert.equal(tabManager.activeTab!.rawContent, FULL);
});

test('saving refuses to write a partial buffer over the file', async () => {
	reset();
	const { session, tab } = await openPartial();

	const saved = await session.saveContent(tab.id);

	assert.equal(saved, false);
	assert.equal(
		invokeCalls.some((call) => call.cmd === 'save_file_content'),
		false,
		'the partial buffer must never reach save_file_content',
	);
	assert.ok(errors.length > 0, 'the refusal is reported, not silent');
});

test('completing a partial buffer replaces it with the whole file and unblocks saving', async () => {
	reset();
	const { session, tab } = await openPartial();

	handleInvoke = (cmd) => {
		if (cmd === 'read_file_content_checked') return [FULL, false];
		if (cmd === 'save_file_content') return null;
		throw new Error(`unexpected invoke: ${cmd}`);
	};

	assert.equal(await session.ensureFullContent(tab.id), true);
	assert.equal(tab.rawContent, FULL);
	assert.notEqual(tab.isTruncated, true);

	assert.equal(await session.saveContent(tab.id), true);
	const write = invokeCalls.find((call) => call.cmd === 'save_file_content');
	assert.equal(write?.args.content, FULL);
});

test('completing a buffer that is already whole does not re-read the file', async () => {
	reset();
	handleInvoke = (cmd) => {
		if (cmd === 'open_markdown_preview') return ['<p>full</p>', FULL, true, false];
		throw new Error(`unexpected invoke: ${cmd}`);
	};
	const session = makeSession();
	await session.loadMarkdown('/docs/small.md');
	const before = invokeCalls.length;

	assert.equal(await session.ensureFullContent(tabManager.activeTabId!), true);
	assert.equal(invokeCalls.length, before);
});

test('a partial buffer that already carries edits is never silently discarded', async () => {
	reset();
	const { session, tab } = await openPartial();
	// Should be unreachable now that every editing entry point completes the
	// buffer first, but if it ever happens the fix must not trade one kind of
	// data loss for another.
	tabManager.updateTabRawContent(tab.id, `${PARTIAL}edited`);

	handleInvoke = (cmd) => {
		if (cmd === 'read_file_content_checked') return [FULL, false];
		throw new Error(`unexpected invoke: ${cmd}`);
	};

	assert.equal(await session.ensureFullContent(tab.id), false);
	assert.equal(tab.rawContent, `${PARTIAL}edited`);
	assert.equal(await session.saveContent(tab.id), false);
});

test('a load into an editable pane reads the whole file instead of the preview slice', async () => {
	// F5 / "reload from disk" preserves edit state. Taking the preview
	// shortcut there hands the editor a partial buffer, and the next keystroke
	// arms auto-save on it.
	reset();
	handleInvoke = (cmd) => {
		if (cmd === 'open_markdown_preview') return ['<p>preview</p>', PARTIAL, false, false];
		if (cmd === 'read_file_content_checked') return [FULL, false];
		throw new Error(`unexpected invoke: ${cmd}`);
	};
	tabManager.addTab('/docs/big.md', '');
	const tab = tabManager.activeTab!;
	tab.isEditing = true;
	const session = makeSession();

	await session.loadMarkdown('/docs/big.md', { preserveEditState: true, skipTabManagement: true });

	assert.equal(tab.rawContent, FULL);
	assert.notEqual(tab.isTruncated, true);
	assert.equal(
		invokeCalls.some((call) => call.cmd === 'open_markdown_preview'),
		false,
	);
});

test('toggling a task checkbox completes the buffer before writing it', async () => {
	reset();
	const doc = `- [ ] first\n\n${'y'.repeat(PREVIEW_BYTES)}\n\n- [ ] last\n`;
	const partial = doc.slice(0, PREVIEW_BYTES);
	handleInvoke = (cmd) => {
		if (cmd === 'open_markdown_preview') return ['<p>preview</p>', partial, false, false];
		if (cmd === 'read_file_content_checked') return new Promise(() => {});
		throw new Error(`unexpected invoke: ${cmd}`);
	};
	const session = makeSession();
	await session.loadMarkdown('/docs/tasks.md');
	const tab = tabManager.activeTab!;
	assert.equal(tab.rawContent, partial);

	handleInvoke = (cmd) => {
		if (cmd === 'read_file_content_checked') return [doc, false];
		if (cmd === 'save_file_content') return null;
		throw new Error(`unexpected invoke: ${cmd}`);
	};
	await session.toggleTaskCheckbox(1, true);

	const write = invokeCalls.find((call) => call.cmd === 'save_file_content');
	assert.ok(write, 'the checkbox toggle still saves');
	assert.equal(write!.args.content, doc.replace('- [ ] first', '- [x] first'));
	assert.ok(
		(write!.args.content as string).includes('- [ ] last'),
		'the part of the file past the preview window survives',
	);
});

// --- the refusal itself: what each writer does when the buffer stays partial ---
//
// Everything above proves the guard lets a COMPLETED buffer through. The
// branch it exists for — `ensureFullContent` answering false — had no test
// driving a writer into it, and an audit that deleted the verdict check from
// `toggleTaskCheckbox` outright left the whole suite green.
//
// `ensureFullContent` answers false in exactly three states, and each is
// exercised below:
//
//   1. the tab is gone — a transfer or detach whose tab closed mid-flight,
//   2. the partial buffer already carries edits: replacing it would trade the
//      user's typing for the file's tail, so it is left alone,
//   3. the re-read itself failed — the only one of the three that reports.
//
// The two writers that do not consult it, `saveContent` and `saveContentAs`,
// carry the same refusal as their own `isTruncated` backstop, so they are
// driven into it here too.
//
// A buffer that is still partial afterwards is unusable in both directions: it
// cannot be written (that truncates the file) and it can no longer be completed
// (state 2 is permanent once the buffer is dirty). So every test asserts the
// same pair — nothing reached `save_file_content`, and the buffer was left
// exactly as it was found.

/** Did anything at all get written to disk in this test? */
const wroteToDisk = () => invokeCalls.some((call) => call.cmd === 'save_file_content');

const TASKS = `- [ ] first\n\n${'y'.repeat(PREVIEW_BYTES)}\n\n- [ ] last\n`;
const TASKS_PARTIAL = TASKS.slice(0, PREVIEW_BYTES);

/** Open the >50KB task list and leave it holding only its preview slice. */
async function openPartialTasks() {
	handleInvoke = (cmd) => {
		if (cmd === 'open_markdown_preview') return ['<p>preview</p>', TASKS_PARTIAL, false, false];
		if (cmd === 'read_file_content_checked') return new Promise(() => {});
		throw new Error(`unexpected invoke: ${cmd}`);
	};
	const session = makeSession();
	await session.loadMarkdown('/docs/tasks.md');
	const tab = tabManager.activeTab!;
	assert.equal(tab.rawContent, TASKS_PARTIAL, 'precondition: the buffer is the partial read');
	return { session, tab };
}

/**
 * From here on the file's tail cannot be read — an unplugged drive, a network
 * volume that went away, a file another process replaced. Writes are allowed
 * through so that a guard which stops refusing is caught by the write it lets
 * happen, not by an "unexpected invoke" from the stub.
 */
/**
 * The original file's tail cannot be read any more — the case Save As exists to
 * rescue. `/docs/copy.md`, the file the rescue writes, is readable: it is a new
 * file the process just created, and every save checks the disk against its own
 * baseline before overwriting.
 */
function makeTailUnreadable() {
	const written = new Map<string, string>();
	handleInvoke = (cmd, args) => {
		if (cmd === 'read_file_content_checked') {
			const saved = written.get(args.path);
			if (saved !== undefined) return [saved, false, 'UTF-8'];
			return Promise.reject(new Error('Os { code: 5, kind: Uncategorized }'));
		}
		if (cmd === 'save_file_content') {
			written.set(args.path, args.content);
			return null;
		}
		if (cmd === 'canonicalize_path') return '/docs/copy.md';
		if (cmd === 'plugin:dialog|save') return '/docs/copy.md';
		throw new Error(`unexpected invoke: ${cmd}`);
	};
}

test('a re-read that fails leaves the buffer partial, still flagged, and reported', async () => {
	reset();
	const { session, tab } = await openPartial();
	makeTailUnreadable();

	assert.equal(await session.ensureFullContent(tab.id), false, 'a buffer that is still partial must be reported as such');
	assert.equal(tab.rawContent, PARTIAL, 'a failed read must not leave a half-filled buffer behind');
	assert.equal(tab.isTruncated, true, 'and the flag must survive, or every writer downstream stops refusing');
	assert.equal(tab.isDirty, false, 'nothing was edited, so nothing may be marked unsaved');
	assert.deepEqual(errors, ['Error loading the rest of the file'], 'the user is told why the document cannot be edited');
});

test('completing the buffer of a tab that is gone is refused, not assumed', async () => {
	// `handleDetach` and `moveTabToWindow` pass an id, and the tab behind it can
	// be closed while the call is in flight. "No such tab" is not "nothing to
	// do": answering true would hand the transfer a buffer nobody owns.
	reset();
	const { session, tab } = await openPartial();
	const id = tab.id;
	tabManager.closeTab(id);
	const before = invokeCalls.length;

	assert.equal(await session.ensureFullContent(id), false, 'there is no buffer to vouch for');
	assert.equal(invokeCalls.length, before, 'and nothing is read for it either');
});

test('a task checkbox is not toggled into a buffer that could not be completed', async () => {
	// The audit's injected defect: `toggleTaskCheckbox` calling
	// `ensureFullContent` and ignoring what it says. Reading mode shows the
	// preview slice with its checkboxes already clickable, so this is reachable
	// with one click on a large file whose tail never arrived.
	reset();
	const { session, tab } = await openPartialTasks();
	makeTailUnreadable();

	assert.equal(await session.toggleTaskCheckbox(1, true), false, 'the toggle must report failure so the checkbox springs back');
	assert.equal(wroteToDisk(), false, 'a partial buffer must never reach save_file_content');
	assert.equal(tab.rawContent, TASKS_PARTIAL, 'and the buffer must not be edited either');
	assert.equal(tab.isDirty, false, 'a dirty partial buffer can never be completed again — that is the trap');
	assert.ok(errors.length > 0, 'the refusal is reported, not silent');
});

test('a task checkbox is not toggled into a partial buffer that already carries edits', async () => {
	// The other refusal state, and the one that is silent by design: the tail is
	// readable, but taking it would overwrite what the user typed. The toggle's
	// `false` is the whole signal — the caller in MarkdownViewer puts the
	// checkbox back with it.
	reset();
	const { session, tab } = await openPartialTasks();
	const edited = `${TASKS_PARTIAL}\n- [ ] typed by hand\n`;
	tabManager.updateTabRawContent(tab.id, edited);
	handleInvoke = (cmd) => {
		if (cmd === 'read_file_content_checked') return [TASKS, false];
		if (cmd === 'save_file_content') return null;
		throw new Error(`unexpected invoke: ${cmd}`);
	};

	assert.equal(await session.toggleTaskCheckbox(1, true), false, 'the toggle must report failure so the checkbox springs back');
	assert.equal(wroteToDisk(), false, 'the preview slice must not be written over the document');
	assert.equal(tab.rawContent, edited, 'and the edits it carries must not be traded for the file’s tail');
});

test('Save As completes the buffer first, so the copy is whole when it can be', async () => {
	// Reaching for Save As is not a reason to write less than the document. The
	// tail is readable and the buffer is clean, so there is nothing stopping this
	// copy from being the whole file — and nothing to warn about.
	reset();
	const { session, tab } = await openPartial();
	handleInvoke = (cmd) => {
		if (cmd === 'read_file_content_checked') return [FULL, false, 'UTF-8'];
		if (cmd === 'save_file_content') return null;
		if (cmd === 'canonicalize_path') return '/docs/copy.md';
		if (cmd === 'plugin:dialog|save') return '/docs/copy.md';
		throw new Error(`unexpected invoke: ${cmd}`);
	};

	assert.equal(await session.saveContentAs(), true);
	assert.equal(invokeCalls.find((call) => call.cmd === 'save_file_content')?.args.content, FULL);
	assert.deepEqual(notices, [], 'a whole copy is not worth a warning');
	assert.notEqual(tab.isTruncated, true);
});

test('Save As is the way out of a partial buffer that carries edits', async () => {
	// The one write a partial buffer may make. A copy is a NEW file at a path the
	// user chose, so it destroys nothing they had — and refusing it too left the
	// edits below with no exit at all, which is a worse answer than a short copy
	// the user is told about. `refuseIfLossilyDecoded` has always reasoned this
	// way, and this is the same trade.
	reset();
	const { session, tab } = await openPartial();
	const edited = `${PARTIAL}edited`;
	tabManager.updateTabRawContent(tab.id, edited);
	// Completing the buffer is not on the table here: the tail is gone, and even
	// if it were readable, reading it would discard the edits this is rescuing.
	makeTailUnreadable();

	assert.equal(await session.saveContentAs(), true, 'the rescue must be allowed to happen');
	assert.equal(invokeCalls.find((call) => call.cmd === 'save_file_content')?.args.content, edited);
	assert.deepEqual(notices, ['partialCopySaved'], 'and the reader is told where the copy stops');
	assert.deepEqual(errors, [], 'it is not a failure');
	// The flag described the file the tab used to point at. It now points at the
	// copy and holds all of it, so leaving the flag on would free the text and
	// then trap it again — every later save refused, from a whole document.
	assert.notEqual(tab.isTruncated, true);
	assert.equal(await session.saveContent(tab.id), true, 'and the tab saves normally from here on');
});

test('answering “Save” to the close dialog cannot flush a partial buffer', async () => {
	// The close path is the one place a refused save is not merely reported:
	// `canCloseTab` returning true here closes the tab, and the buffer — the only
	// copy of those edits — goes with it. A save that was refused is not a save.
	reset();
	const { session, tab } = await openPartial();
	tabManager.updateTabRawContent(tab.id, `${PARTIAL}edited`);
	makeTailUnreadable();
	closeAnswer = 'save';

	assert.equal(await session.canCloseTab(tab.id), false, 'a tab whose save was refused must stay open');
	assert.equal(wroteToDisk(), false);
	assert.ok(errors.length > 0, 'the user is told why the tab will not close');
});

// --- wiring that cannot be executed outside a Svelte runtime ---

test('entering split view completes a partial buffer instead of trusting it', () => {
	// The old guard was `!tab.rawContent`, which a partial buffer satisfies:
	// split view opened on the truncated text, the first keystroke made it
	// dirty, and auto-save wrote it back 1.5s later.
	const enter = sliceBetween(viewer, 'async function toggleSplitView', '} else {');
	assert.match(enter, /ensureFullContent/);
	// And it has to stop when the buffer could not be completed, rather than
	// opening an editor over the partial text anyway.
	assert.match(enter, /if \(!\(await documentSession\.ensureFullContent\(tab\.id\)\)\) \{[\s\S]*?return;/);
	// The empty-buffer read must go through the store so the tab does not keep
	// a stale "partial" flag that would then block every save.
	assert.match(enter, /tabManager\.setTabRawContent\(tab\.id, content\)/);
});

test('a partial buffer cannot be handed to another window', () => {
	// The destination rebuilds the tab from the payload alone and has no way
	// to know the text is incomplete, so its auto-save would truncate the file.
	//
	// Each subject is extracted by its own name. The previous form sliced
	// `'canTransfer: (tabId)'` → `'transferPayload:'`, which ran past
	// `canDetach`, and `'async function handleDetach'` → `'async function
	// carryActiveTabToNextWindow'`, which ran past `moveTabToWindow`. Both
	// swallowed neighbours end in a character-identical copy of the guard being
	// asserted, so the `assert.match` was satisfied either way: deleting
	// `&& !tab.isTruncated` from `canTransfer`, and separately deleting the whole
	// four-line `ensureFullContent` guard from `handleDetach`, each left the
	// suite green — on the transfer-then-auto-save path this file is named for.
	//
	// The two neighbours were therefore never asserted about, only stood in
	// front of. Both are the same guard on the same path, so both are named.
	for (const predicate of ['canTransfer', 'canDetach']) {
		assert.match(
			functionSource(viewer, predicate),
			/!tab\.isTruncated/,
			`${predicate} must refuse a tab whose buffer is still the preview slice`,
		);
	}
	for (const mover of ['handleDetach', 'moveTabToWindow']) {
		assert.match(
			functionSource(viewer, mover),
			/if \(!\(await documentSession\.ensureFullContent\(tabId\)\)\) \{[\s\S]*?return false;/,
			`${mover} must complete the buffer before the payload is built, and stop when it cannot`,
		);
	}
});

test('front matter edits in preview mode complete the buffer first', () => {
	for (const entry of ['async function handleFrontMatterEdit', 'async function handleFrontMatterListChange']) {
		// One handler is followed by a `function`, the other by an `async
		// function`, so the slice ends at whichever comes first. The previous
		// expression was `indexOf(a) + 1 || indexOf(b) + 1`, which reads as
		// "or else" but is really "or else, if the first is absent *or at
		// offset 0*" — and when the first form appeared later in the file than
		// the second it won anyway, widening the body past the handler and
		// letting a neighbouring function satisfy the `assert.match` below.
		const handler = sliceFrom(viewer, entry);
		const ends = ['\n\tfunction ', '\n\tasync function ']
			.map((marker) => handler.indexOf(marker))
			.filter((at) => at !== -1);
		assert.ok(ends.length > 0, `${entry} must be followed by a declaration that bounds it`);
		const body = handler.slice(0, Math.min(...ends));
		assert.match(body, /ensureFullContent/, `${entry} must not edit a partial buffer`);
	}
});
