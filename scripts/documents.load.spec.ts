import assert from 'node:assert/strict';

import { afterAll, beforeAll, describe, test } from 'vitest';

// Each describe installs its own Tauri stub in `beforeAll`. This one only
// answers the settings store, which boots when the modules below are imported.
(window as any).__TAURI_INTERNALS__ = {
	metadata: { currentWindow: { label: 'main' }, currentWebview: { windowLabel: 'main', label: 'main' } },
	invoke: (cmd: string) => Promise.resolve(cmd === 'get_os_type' ? 'macos' : null),
};

const { tabManager } = await import('../src/lib/stores/tabs.svelte.js');
const { settings } = await import('../src/lib/stores/settings.svelte.js');
const { createDocumentSession } = await import('../src/lib/sessions/documentSession.svelte.js');

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
describe('checked read migration', () => {
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
	beforeAll(() => {
		(window as any).__TAURI_INTERNALS__ = {
			metadata: { currentWindow: { label: 'main' }, currentWebview: { windowLabel: 'main', label: 'main' } },
			invoke: (command: string, args: Record<string, unknown>) =>
				Promise.resolve(handleInvoke(command.replace(/^plugin:[^|]*\|/, ''), args ?? {})),
			transformCallback: (fn: unknown) => fn,
		};
	});

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
			onError: (message) => errors.push(message),
			onDiskChangedUnderSave: () => {},
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
			if (cmd === 'open_markdown_preview') return [PARTIAL, false, false];
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
});

// A read can fail on a file that is perfectly fine a moment later: a watcher
// fires while another process is replacing the file, a network volume blinks,
// a sync client swaps the inode. Closing the tab on that error throws away the
// buffer the user could still have saved somewhere else, and dropping the
// recent-file entry throws away the way back to it.
//
// This was asserted by matching documentSession for `/tabManager\.closeTab/`
// and for the exact `options.onError('Error loading file', error);` call. The
// first is satisfied by any file that happens not to contain those characters
// — including one that closes the tab through a differently spelled route —
// and the second pins a string literal. `createDocumentSession` takes its
// collaborators as plain callbacks, and eleven other files in this suite
// already build one, so the failure can be run instead of described.
describe('document load failure', () => {
	// The runes are the compiler's, not ours: vitest builds `.svelte.ts` through the
	// Svelte plugin, so the store and the session run under real reactivity. Only
	// the Tauri backend, which jsdom cannot provide, is stubbed.
	let handleInvoke: (cmd: string, args: any) => unknown = (cmd) => {
		throw new Error(`unexpected invoke: ${cmd}`);
	};
	beforeAll(() => {
		(window as any).__TAURI_INTERNALS__ = {
			metadata: { currentWindow: { label: 'main' }, currentWebview: { windowLabel: 'main', label: 'main' } },
			invoke: (cmd: string, args: any) => Promise.resolve(handleInvoke(cmd, args)),
		};
	});

	const errors: { message: string; error: unknown }[] = [];
	const deletedRecents: string[] = [];

	function makeSession(overrides: Record<string, unknown> = {}) {
		return createDocumentSession({
			setShowHome: () => {},
			currentFile: () => tabManager.activeTab?.path ?? '',
			resetScrollHistory: () => {},
			renderMarkdown: async () => '',
			afterLoad: async () => {},
			saveRecentFile: () => {},
			deleteRecentFile: (path: string) => void deletedRecents.push(path),
			setLoadingTabs: () => {},
			measureInitialViewport: () => {},
			isScrolling: () => false,
			onError: (message: string, error: unknown) => void errors.push({ message, error }),
			onDiskChangedUnderSave: () => {},
			cancelPendingAutoSave: () => {},
			askClose: async () => 'discard' as const,
			onCloseSaveNewerEdits: () => {},
			onCloseAutoSaveFailed: () => {},
			onPartialCopySaved: () => {},
			...overrides,
		});
	}

	/** Every read of `path` fails; anything else the load path asks for is absent too. */
	function readsFail() {
		handleInvoke = () => {
			throw new Error('No such file or directory (os error 2)');
		};
	}

	test('a read that fails keeps the open tab, its buffer and its recent entry', async () => {
		tabManager.closeAll();
		errors.length = 0;
		deletedRecents.length = 0;

		const session = makeSession();
		tabManager.addTab('/notes/a.md', 'the text the reader can still rescue');
		const before = tabManager.activeTab!;
		readsFail();

		await session.loadMarkdown('/notes/a.md');

		assert.equal(tabManager.tabs.length, 1, 'the tab is not closed');
		assert.equal(tabManager.tabs[0].id, before.id, 'and it is the same tab, not a replacement');
		assert.equal(
			tabManager.tabs[0].rawContent,
			'the text the reader can still rescue',
			'the buffer is not replaced by the failed read',
		);
		assert.deepEqual(deletedRecents, [], 'the recent-file entry survives, so the file can be reopened');
	});

	test('the failure is reported rather than swallowed', async () => {
		tabManager.closeAll();
		errors.length = 0;

		const session = makeSession();
		tabManager.addTab('/notes/a.md', 'buffer');
		readsFail();

		await session.loadMarkdown('/notes/a.md');

		assert.equal(errors.length, 1, 'exactly one error reaches the caller');
		assert.equal(errors[0].message, 'Error loading file');
		assert.ok(errors[0].error instanceof Error, 'the cause is passed on, not flattened to a string');
	});
});

// Live Mode reloads the open file when something else writes it — git
// checkout, a cloud sync, a second Markpad window. The reload path
// replaces rawContent AND originalContent, so a buffer with unsaved edits is
// not just overwritten, it stops looking dirty afterwards: the user cannot
// even tell what they lost. Turning Live Mode ON must likewise never pull
// disk content over the buffer.
//
// Whether an event is somebody else's write used to be guessed from the clock:
// each of our own writes opened a 400ms window in which events for that path
// were discarded. Both directions of that guess were wrong and both are tested
// below — a foreign write inside the window was DROPPED and then overwritten by
// the next auto-save, and a late event about our own write raised a conflict
// bar about nothing. `originalContent` answers the question exactly, and the
// same answer now also guards the write itself, which is the half that works
// when the watcher does not.
describe('external change reload', () => {
	// The runes are the compiler's, not ours: vitest builds `.svelte.ts` through the
	// Svelte plugin, so the store and the session run under real reactivity, and jsdom
	// supplies `window` and `localStorage`. Only the Tauri backend is stubbed.

	/**
	 * The filesystem, as far as these tests are concerned. Real enough for the
	 * question every test here asks — "what does the file say right now?" — and the
	 * reason the suite no longer needs to fake a clock.
	 */
	const disk = new Map<string, string>();

	let handleInvoke: (cmd: string, args: any) => unknown = (cmd, args) => {
		if (cmd === 'canonicalize_path') return args.path;
		if (cmd === 'read_file_content_checked') {
			if (!disk.has(args.path)) throw new Error(`no such file: ${args.path}`);
			return [disk.get(args.path), false, 'UTF-8'];
		}
		if (cmd === 'save_file_content') {
			disk.set(args.path, args.content);
			return null;
		}
		throw new Error(`unexpected invoke: ${cmd}`);
	};
	beforeAll(() => {
		(window as any).__TAURI_INTERNALS__ = {
			metadata: { currentWindow: { label: 'main' }, currentWebview: { windowLabel: 'main', label: 'main' } },
			invoke: (cmd: string, args: any) => Promise.resolve(handleInvoke(cmd, args)),
		};
	});

	let refusedSaves: string[] = [];
	let closeQuestions: boolean[] = [];
	let closeAnswer: 'save' | 'discard' | 'cancel' = 'discard';

	function makeSession(overrides: Record<string, unknown> = {}) {
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
			onError: () => {},
			onDiskChangedUnderSave: (tabId: string) => refusedSaves.push(tabId),
			cancelPendingAutoSave: () => {},
			askClose: async (_title: string, diskMoved: boolean) => {
				closeQuestions.push(diskMoved);
				return closeAnswer;
			},
			onCloseSaveNewerEdits: () => {},
			onCloseAutoSaveFailed: () => {},
			onPartialCopySaved: () => {},
			...overrides,
		});
	}

	/** A file on disk, open in a tab whose buffer matches it. */
	function open(path: string, content: string) {
		disk.set(path, content);
		tabManager.addTab(path, content);
		const tab = tabManager.activeTab!;
		tab.originalContent = content;
		return tab;
	}

	function reset() {
		tabManager.closeAll();
		disk.clear();
		refusedSaves = [];
		closeQuestions = [];
		closeAnswer = 'discard';
	}

	test('a clean tab that owns the changed file is reloaded', async () => {
		reset();
		const session = makeSession();
		const tab = open('/notes/a.md', 'on disk');
		disk.set('/notes/a.md', 'somebody else wrote this');

		assert.deepEqual(await session.resolveExternalChange('/notes/a.md'), {
			action: 'reload',
			tabId: tab.id,
			path: '/notes/a.md',
		});
	});

	test('a tab with unsaved edits is never reloaded behind the user', async () => {
		reset();
		const session = makeSession();
		const tab = open('/notes/a.md', 'on disk');
		tabManager.updateTabRawContent(tab.id, 'my unsaved paragraph');
		disk.set('/notes/a.md', 'somebody else wrote this');

		const outcome = await session.resolveExternalChange('/notes/a.md');

		assert.equal(outcome.action, 'conflict');
		assert.equal((outcome as { tabId: string }).tabId, tab.id);
		// The buffer and its dirty marker must both survive: overwriting
		// originalContent is what made the loss invisible after the fact.
		assert.equal(tab.rawContent, 'my unsaved paragraph');
		assert.equal(tab.originalContent, 'on disk');
		assert.equal(tab.isDirty, true);
	});

	test('a restored backup whose file changed while closed is reported, without touching it', async () => {
		// No watcher saw that change, so startup has to ask. A missing file counts
		// as changed, like every other unreadable read here.
		reset();
		const session = makeSession();
		const moved = open('/notes/moved.md', 'baseline');
		tabManager.updateTabRawContent(moved.id, 'backup text');
		disk.set('/notes/moved.md', 'edited elsewhere');
		const gone = open('/notes/gone.md', 'baseline');
		tabManager.updateTabRawContent(gone.id, 'backup text');
		disk.delete('/notes/gone.md');
		const same = open('/notes/same.md', 'baseline');
		tabManager.updateTabRawContent(same.id, 'backup text');
		const clean = open('/notes/clean.md', 'baseline');
		disk.set('/notes/clean.md', 'edited elsewhere');

		assert.deepEqual(await session.dirtyTabsChangedOnDisk(), [moved.id, gone.id]);
		assert.equal(moved.rawContent, 'backup text');
		assert.equal(moved.originalContent, 'baseline');
		assert.equal(clean.rawContent, 'baseline');
	});

	test('the changed path decides which tab is affected, not whichever tab is active', async () => {
		reset();
		const session = makeSession();
		const a = open('/notes/a.md', 'a on disk');
		const b = open('/notes/b.md', 'b on disk');
		tabManager.setActive(b.id);
		tabManager.updateTabRawContent(b.id, 'b unsaved');
		disk.set('/notes/a.md', 'a changed');

		const outcome = await session.resolveExternalChange('/notes/a.md');

		// Reloading here would pull b.md's disk content over b's unsaved buffer
		// because a.md changed. Whatever the outcome, it must not name tab b.
		assert.notEqual((outcome as { tabId?: string }).tabId, b.id);
		assert.equal(b.rawContent, 'b unsaved');
		assert.notEqual(a.id, b.id);
	});

	test('a change to a file no tab holds is ignored', async () => {
		reset();
		const session = makeSession();
		open('/notes/a.md', 'a on disk');

		assert.deepEqual(await session.resolveExternalChange('/notes/elsewhere.md'), { action: 'ignore' });
		assert.deepEqual(await session.resolveExternalChange(''), { action: 'ignore' });
	});

	test('our own write is not an external change, however late the event arrives', async () => {
		reset();
		const session = makeSession();
		const tab = open('/notes/a.md', 'on disk');
		tabManager.updateTabRawContent(tab.id, 'my edit');
		assert.equal(await session.saveContent(tab.id), true);

		// No clock is consulted, so there is no window to be outside of. The old
		// guard answered this correctly for 400ms and then started answering it
		// wrong; a slow watcher, a network share or a synced folder is all it took.
		assert.deepEqual(await session.resolveExternalChange('/notes/a.md'), { action: 'ignore' });
		assert.deepEqual(await session.resolveExternalChange('/notes/a.md'), { action: 'ignore' });
	});

	test('a late event about our own save is not raised as a conflict', async () => {
		// The second failure of the clock, and the one that costs trust rather than
		// data: with the user typing again after a save, an event that arrived after
		// the window found a dirty tab and asked "this file changed on disk" about
		// their own keystrokes. Zed is disliked for exactly this
		// (zed-industries/zed#42108) — a question that is sometimes false gets
		// dismissed the times it is true.
		reset();
		const session = makeSession();
		const tab = open('/notes/a.md', 'on disk');
		tabManager.updateTabRawContent(tab.id, 'my edit');
		assert.equal(await session.saveContent(tab.id), true);
		tabManager.updateTabRawContent(tab.id, 'my edit, and more');

		assert.deepEqual(await session.resolveExternalChange('/notes/a.md'), { action: 'ignore' });
		assert.equal(tab.isDirty, true, 'and the later typing is still unsaved');
	});

	test('a foreign write moments after our own is still reported', async () => {
		// The direction that lost data. Inside the old 400ms window this event was
		// DISCARDED with nothing re-queued: the buffer held our text, the disk held
		// theirs, the tab looked clean, and the next keystroke's auto-save put ours
		// back over theirs. Nothing anywhere said so.
		reset();
		const session = makeSession();
		const tab = open('/notes/a.md', 'on disk');
		tabManager.updateTabRawContent(tab.id, 'my edit');
		assert.equal(await session.saveContent(tab.id), true);

		disk.set('/notes/a.md', 'their edit, one moment later');

		assert.deepEqual(await session.resolveExternalChange('/notes/a.md'), {
			action: 'reload',
			tabId: tab.id,
			path: '/notes/a.md',
		});
	});

	// --- the guard that does not depend on the watcher ---

	test('a save is refused when the disk moved under it', async () => {
		// The watcher's events can be missed, so this is the check every editor
		// that does not lose work has: VS Code refuses the save
		// ("The content of the file is newer"), Vim re-stats before each write, and
		// Vim has no watcher at all.
		reset();
		const session = makeSession();
		const tab = open('/notes/a.md', 'on disk');
		tabManager.updateTabRawContent(tab.id, 'my edit');
		disk.set('/notes/a.md', 'their edit');

		assert.equal(await session.saveContent(tab.id), false);
		assert.equal(disk.get('/notes/a.md'), 'their edit', 'their work was overwritten anyway');
		assert.deepEqual(refusedSaves, [tab.id], 'the refusal was not reported, so nothing asked the user');
		assert.equal(tab.rawContent, 'my edit', 'and the refusal must not cost the user their buffer');
		assert.equal(tab.isDirty, true);
	});

	test('answering "keep mine" authorises the next save, and only the next one', async () => {
		reset();
		const session = makeSession();
		const tab = open('/notes/a.md', 'on disk');
		tabManager.updateTabRawContent(tab.id, 'my edit');
		disk.set('/notes/a.md', 'their edit');
		assert.equal(await session.saveContent(tab.id), false);

		session.allowOverwriteOnce(tab.id);
		assert.equal(await session.saveContent(tab.id), true);
		assert.equal(disk.get('/notes/a.md'), 'my edit');

		// A third program writing a minute later is a new question the user has not
		// answered, so the authorisation must not still be lying around.
		tabManager.updateTabRawContent(tab.id, 'my later edit');
		disk.set('/notes/a.md', 'somebody else again');
		assert.equal(await session.saveContent(tab.id), false);
		assert.equal(disk.get('/notes/a.md'), 'somebody else again');
	});

	test('an ordinary save of an untouched file still just saves', async () => {
		// The guard has to be invisible in the common case, which is every save.
		reset();
		const session = makeSession();
		const tab = open('/notes/a.md', 'on disk');
		tabManager.updateTabRawContent(tab.id, 'my edit');

		assert.equal(await session.saveContent(tab.id), true);
		assert.equal(disk.get('/notes/a.md'), 'my edit');
		assert.deepEqual(refusedSaves, []);
		assert.equal(tab.isDirty, false);
	});

	// --- closing must not answer the question for the user ---

	test('closing a tab whose file changed asks, instead of auto-saving over it', async () => {
		// Auto-save is on by default, and `canCloseTab` used to hand a dirty tab
		// straight to it — which is the same answer as "keep mine", to a question
		// the user was shown and did not answer, in the direction that destroys the
		// other program's work. VS Code prompts here.
		reset();
		const session = makeSession();
		const tab = open('/notes/a.md', 'on disk');
		tabManager.updateTabRawContent(tab.id, 'my edit');
		disk.set('/notes/a.md', 'their edit');

		closeAnswer = 'cancel';
		assert.equal(await session.canCloseTab(tab.id), false);
		assert.deepEqual(closeQuestions, [true], 'the dialog was not told the disk had moved');
		assert.equal(disk.get('/notes/a.md'), 'their edit', 'and nothing was written behind the question');
	});

	test('answering Save to that dialog does overwrite, rather than failing silently', async () => {
		// The write guard refuses a changed file, so without the authorisation this
		// answer carries, Save would return false and the tab would refuse to close
		// — a dialog whose Save button does nothing.
		reset();
		const session = makeSession();
		const tab = open('/notes/a.md', 'on disk');
		tabManager.updateTabRawContent(tab.id, 'my edit');
		disk.set('/notes/a.md', 'their edit');

		closeAnswer = 'save';
		assert.equal(await session.canCloseTab(tab.id), true);
		assert.equal(disk.get('/notes/a.md'), 'my edit');
	});

	test('closing an untouched file still just saves and closes', async () => {
		// The question is for the case that earned it. Every other close keeps the
		// behaviour it had.
		reset();
		const session = makeSession();
		const tab = open('/notes/a.md', 'on disk');
		tabManager.updateTabRawContent(tab.id, 'my edit');

		assert.equal(await session.canCloseTab(tab.id), true);
		assert.equal(disk.get('/notes/a.md'), 'my edit');
		assert.deepEqual(closeQuestions, [], 'nothing was asked');
	});

	// --- #692: the editor is where the reload has to land ---

	test('reloading a clean tab does not throw the user out of the editor', async () => {
		// The gate on the Auto-Reload button used to hide it in edit mode, so this
		// path was reachable only by enabling Live Mode in the preview and then
		// pressing Edit. Now that editing is the case the button is FOR, a reload
		// that dropped the tab back to preview would be the visible bug.
		//
		// `loadMarkdown(path)` with no options is exactly the call the
		// `file-changed` listener makes for a `reload` outcome.
		const session = makeSession();
		const tab = open('/notes/live.md', 'before');
		tab.isEditing = true;

		handleInvoke = (cmd) => {
			if (cmd === 'canonicalize_path') return '/notes/live.md';
			// An editing pane always gets the whole file, never the 5MB preview
			// slice — an editor bound to a partial buffer auto-saves it back over
			// the document's tail.
			if (cmd === 'read_file_content_checked') return ['after', false, 'UTF-8'];
			throw new Error(`unexpected invoke: ${cmd}`);
		};

		await session.loadMarkdown('/notes/live.md');

		assert.equal(tabManager.activeTab?.rawContent, 'after', 'the disk version did not arrive');
		assert.equal(tabManager.activeTab?.isEditing, true, 'the reload left the editor');
		assert.equal(tabManager.activeTab?.isDirty, false, 'the reloaded buffer is not an edit');
	});
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
describe('large file load revision', () => {
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

	beforeAll(() => {
		(window as any).__TAURI_INTERNALS__ = {
			metadata: { currentWindow: { label: 'main' }, currentWebview: { windowLabel: 'main', label: 'main' } },
			invoke: (cmd: string, args: any) => Promise.resolve(handleInvoke(cmd, args)),
		};
	});

	// `settings` is one store for the whole file: put back what this block changes.
	let settingsBefore: { openFileMode: typeof settings.openFileMode };
	beforeAll(() => {
		settingsBefore = { openFileMode: settings.openFileMode };
	});
	afterAll(() => {
		Object.assign(settings, settingsBefore);
	});

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
			onError: (message) => errors.push(message),
			onDiskChangedUnderSave: () => {},
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
				return wait(delay).then(() => [PARTIAL, false, false, 'UTF-8']);
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
});

// Opening a file that is ALREADY open in a tab with unsaved edits must not
// re-read it from disk. `setTabRawContent` replaces rawContent AND
// originalContent, so the edits would not merely be overwritten — the tab
// would look clean afterwards and the user could not tell what was lost.
//
// This is the same loss `resolveExternalChange` already refuses for a watcher
// event (#374), reached through the ordinary open path instead: recent files,
// drag-and-drop, the OS handing us a path, or a link opened in a new tab.
// Discarding a buffer stays what it is everywhere else — an explicit command
// ("Reload from disk", the external-change "Reload"), never a side effect of
// asking to see a file.
describe('reopening a dirty document', () => {
	// The runes are the compiler's, not ours: vitest builds `.svelte.ts` through the
	// Svelte plugin, so the store and the session run under real reactivity. Only
	// the Tauri backend, which jsdom cannot provide, is stubbed.

	// What the file says right now, and every read the session performed.
	const disk = new Map<string, string>();
	const reads: string[] = [];

	beforeAll(() => {
		(window as any).__TAURI_INTERNALS__ = {
			metadata: { currentWindow: { label: 'main' }, currentWebview: { windowLabel: 'main', label: 'main' } },
			invoke: (cmd: string, args: any) => {
				if (cmd === 'read_file_content_checked') {
					reads.push(args.path);
					return Promise.resolve([disk.get(args.path) ?? '', false]);
				}
				if (cmd === 'open_markdown_preview') {
					reads.push(args.path);
					return Promise.resolve([disk.get(args.path) ?? '', true, false]);
				}
				if (cmd === 'get_os_type') return Promise.resolve('macos');
				return Promise.resolve(null);
			},
		};
	});

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
			onError: () => {},
			onDiskChangedUnderSave: () => {},
			cancelPendingAutoSave: () => {},
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
		reads.length = 0;
	}

	/** A tab holding `path`, edited but not saved. */
	function openEdited(path: string, onDisk: string, edits: string) {
		disk.set(path, onDisk);
		tabManager.addTab(path, onDisk);
		const id = tabManager.activeTabId!;
		tabManager.updateTabRawContent(id, edits);
		return tabManager.tabs.find((tab) => tab.id === id)!;
	}

	// --- opening a file must never cost a buffer ---

	// `addTab` followed by a load with `skipTabManagement` is the shape back/forward
	// and a few other routes use: whatever tab `addTab` leaves active is the one
	// the disk content lands in. Today that is always a fresh tab, so this passes
	// without the guard — it is pinned here because it is the invariant, and any
	// future change to how an already-open path is resolved has to keep it.
	//
	// It asserts ONLY that the edits survive: no tab counts, no active-tab
	// identity, nothing about how the request was routed. A failure here means
	// work was destroyed, and nothing else.
	test('following a link into a new tab never costs the target tab its unsaved edits', async () => {
		reset();
		const session = makeSession();
		const edited = openEdited('/notes/target.md', 'on disk', 'my unsaved paragraph');
		tabManager.addTab('/notes/from.md', 'from text');

		tabManager.addTab('/notes/target.md');
		await session.loadMarkdown('/notes/target.md', { skipTabManagement: true, resetScrollHistory: true });

		assert.equal(edited.rawContent, 'my unsaved paragraph');
		assert.equal(edited.originalContent, 'on disk', 'the saved baseline is intact, so the tab can still tell you what changed');
		assert.equal(edited.isDirty, true, 'the tab still knows it has something to save');
	});

	// One tab per path makes `addTab` resolve the click to the tab that already
	// holds the file instead of building a second one — which is what hands that
	// edited buffer to the loader in the first place. The test above is what makes
	// that safe; this one is what makes it useful.
	test('following a link into a new tab shows the tab that already holds the file', async () => {
		reset();
		const session = makeSession();
		const edited = openEdited('/notes/target.md', 'on disk', 'my unsaved paragraph');
		tabManager.addTab('/notes/from.md', 'from text');

		tabManager.addTab('/notes/target.md');
		await session.loadMarkdown('/notes/target.md', { skipTabManagement: true, resetScrollHistory: true });

		assert.equal(tabManager.tabs.filter((tab) => tab.path === '/notes/target.md').length, 1);
		assert.equal(tabManager.activeTabId, edited.id);
		assert.deepEqual(reads, [], 'the file is not even read');
	});

	// --- the pre-existing loss, independent of one-tab-per-path ---

	test('re-opening an edited file from recents activates its tab instead of reloading it', async () => {
		reset();
		const session = makeSession();
		const edited = openEdited('/notes/a.md', 'on disk', 'my unsaved paragraph');
		tabManager.addTab('/notes/b.md', 'b');

		await session.loadMarkdown('/notes/a.md');

		assert.equal(edited.rawContent, 'my unsaved paragraph');
		assert.equal(edited.originalContent, 'on disk');
		assert.equal(edited.isDirty, true);
		assert.equal(tabManager.activeTabId, edited.id);
		assert.deepEqual(reads, []);
	});

	test('re-opening the edited file already in front does not reload it either', async () => {
		reset();
		const session = makeSession();
		const edited = openEdited('/notes/a.md', 'on disk', 'my unsaved paragraph');

		// The Home screen is an overlay, not a tab switch: opening the file you are
		// already editing leaves activeTabId alone, so "did we switch tabs?" is not
		// a safe test for this.
		await session.loadMarkdown('/notes/a.md');

		assert.equal(edited.rawContent, 'my unsaved paragraph');
		assert.equal(edited.isDirty, true);
		assert.deepEqual(reads, []);
	});

	// --- the guard must not block the ordinary paths ---

	test('a clean tab is reloaded from disk as before', async () => {
		reset();
		const session = makeSession();
		disk.set('/notes/a.md', 'first');
		tabManager.addTab('/notes/a.md', 'first');
		const id = tabManager.activeTabId!;

		disk.set('/notes/a.md', 'second');
		await session.loadMarkdown('/notes/a.md');

		const tab = tabManager.tabs.find((item) => item.id === id)!;
		assert.equal(tab.rawContent, 'second');
		assert.equal(tab.isDirty, false);
		assert.deepEqual(reads, ['/notes/a.md']);
	});

	test('an edited tab following a link to a DIFFERENT file still loads it', async () => {
		reset();
		const session = makeSession();
		disk.set('/notes/b.md', 'b on disk');
		const edited = openEdited('/notes/a.md', 'a on disk', 'edits');

		// `navigate` rewrites this tab's path; the caller has already dealt with the
		// buffer (canCloseTab) before getting here.
		await session.loadMarkdown('/notes/b.md', { navigate: true });

		assert.equal(edited.path, '/notes/b.md');
		assert.equal(edited.rawContent, 'b on disk');
		assert.deepEqual(reads, ['/notes/b.md']);
	});

	test('a Reload of a file changed under unsaved edits replaces the buffer', async () => {
		reset();
		const session = makeSession();
		const edited = openEdited('/notes/a.md', 'on disk', 'my unsaved paragraph');

		disk.set('/notes/a.md', 'someone else wrote this');
		const outcome = await session.resolveExternalChange('/notes/a.md');
		assert.equal(outcome.action, 'conflict', 'the watcher never reloads it on its own');
		// Deciding that took a read of its own — comparing the file against the
		// tab's baseline is how "who wrote this" is answered now. `reads` is here
		// to measure what the OPEN does, so the resolution's read is cleared first.
		reads.length = 0;

		// The options resolveExternalChangeByReloading passes, verbatim.
		await session.loadMarkdown('/notes/a.md', {
			preserveEditState: true,
			skipTabManagement: true,
			resetScrollHistory: true,
			discardUnsavedBuffer: true,
		});

		assert.equal(edited.rawContent, 'someone else wrote this');
		assert.equal(edited.isDirty, false);
		assert.deepEqual(reads, ['/notes/a.md']);
	});

	test('a conflict alone does not authorize the next open to discard the buffer', async () => {
		reset();
		const session = makeSession();
		const edited = openEdited('/notes/a.md', 'on disk', 'my unsaved paragraph');

		disk.set('/notes/a.md', 'someone else wrote this');
		await session.resolveExternalChange('/notes/a.md');
		reads.length = 0;

		// Same tab, same path, conflict outstanding — but this is an open, and it
		// did not ask to discard anything.
		await session.loadMarkdown('/notes/a.md');

		assert.equal(edited.rawContent, 'my unsaved paragraph');
		assert.equal(edited.isDirty, true);
		assert.deepEqual(reads, []);
	});
});

// A markdown file larger than 50KB is opened twice: `open_markdown_preview`
// returns the first 50KB so something renders immediately, and a background
// `read_file_content` fills in the rest. Between the two, the tab's ONLY
// buffer is a partial copy of the document. Anything that writes that buffer
// back — auto-save, Cmd+S, a task checkbox, a tab moved to another window —
// permanently truncates the user's file.
//
// These tests drive the real TabManager and the real document session with a
// stubbed Tauri bridge, so they lock the behaviour, not the wording.
describe('truncated buffer guard', () => {
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

	beforeAll(() => {
		(window as any).__TAURI_INTERNALS__ = {
			metadata: { currentWindow: { label: 'main' }, currentWebview: { windowLabel: 'main', label: 'main' } },
			invoke: (cmd: string, args: any) => {
				invokeCalls.push({ cmd, args });
				return Promise.resolve(handleInvoke(cmd, args)).then((value) => value);
			},
		};
	});

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
			if (cmd === 'open_markdown_preview') return [PARTIAL, false, false];
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
			if (cmd === 'open_markdown_preview') return [FULL, true, false];
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
			if (cmd === 'open_markdown_preview') return [FULL, true, false];
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
			if (cmd === 'open_markdown_preview') return [PARTIAL, false, false];
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
			if (cmd === 'open_markdown_preview') return [partial, false, false];
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
			if (cmd === 'open_markdown_preview') return [TASKS_PARTIAL, false, false];
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
});
