import assert from 'node:assert/strict';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';

import { patchPreview } from '../src/lib/utils/previewPatch.js';
import { asRendererLine } from '../src/lib/utils/lineCoordinates.js';
import { flushSync } from 'svelte';

// Importing the store boots the settings singleton, which asks for the OS type,
// so a backend answering it has to be in place before the imports below. Each
// describe installs its own backend in `beforeAll`.
(window as any).__TAURI_INTERNALS__ = {
	metadata: { currentWindow: { label: 'main' }, currentWebview: { windowLabel: 'main', label: 'main' } },
	invoke: (cmd: string) => Promise.resolve(cmd === 'get_os_type' ? 'macos' : null),
};

const { tabManager } = await import('../src/lib/stores/tabs.svelte.js');
const { createDocumentSession, claimTabForRead } = await import('../src/lib/sessions/documentSession.svelte.js');
const { createWindowSession } = await import('../src/lib/sessions/windowSession.svelte.js');
const { settings } = await import('../src/lib/stores/settings.svelte.js');
const { createTabMovers, createTransferOptions } = await import('../src/lib/sessions/windowTransfer.js');
const { snapshotTab } = await import('../src/lib/utils/tabTransfer.js');
const { outgoingTabAnchorLine } = await import('../src/lib/utils/editorPosition.js');
type Tab = import('../src/lib/stores/tabs.svelte.js').Tab;

describe('a preview host per tab', () => {
	function patchPreviewBlocks(host: HTMLElement, html: string) {
		return patchPreview(host, html, '/docs/a.md', new Set());
	}

	/**
	 * Switching tabs must not rebuild the document being switched to.
	 *
	 * The preview used to have ONE `.markdown-blocks` host for every tab, so a
	 * switch handed that host the other document's markup. Two documents share no
	 * block keys, so the diff replaced essentially every node: `renderRichContent`
	 * ran over the whole document again, the folds re-measured, and the reading
	 * position was restored against a layout that was still settling. That is one
	 * cause with three symptoms — a visible reload, motion, and a position that
	 * moved after it had been restored.
	 *
	 * There is a host per tab now, and this is the property that makes the switch
	 * free. It is a property of `patchPreview` plus the per-host record it keeps
	 * (`states`, a `WeakMap` keyed on the container), not of any new module:
	 * re-patching a host that already holds that document matches every key and
	 * changes nothing.
	 *
	 * What this cannot check is the wiring in `MarkdownViewer.svelte` that gives
	 * each tab its own host — that component cannot be mounted outside Tauri. What
	 * it does check is the mechanism the wiring depends on, and it is the half that
	 * would fail silently: a keying change in `previewPatch.ts` would still look
	 * correct on screen and quietly put the whole cost back.
	 */

	/** The renderer's output with `splitBlocks`: one block per `\0`. */
	function doc(title: string, paragraphs: string[]): string {
		return [
			`<h1 data-sourcepos="1:1-1:${title.length}" id="${title}">${title}</h1>`,
			...paragraphs.map((text, i) => `<p data-sourcepos="${i + 3}:1-${i + 3}:${text.length}">${text}</p>`),
		].join('\0\n');
	}

	const A = doc('alpha', ['one', 'two', 'three']);
	const B = doc('beta', ['four', 'five']);

	let hostA: HTMLElement;
	let hostB: HTMLElement;

	beforeEach(() => {
		document.body.innerHTML = '';
		hostA = document.createElement('div');
		hostB = document.createElement('div');
		document.body.append(hostA, hostB);
	});

	test('re-showing a tab replaces no nodes and asks for no enrichment', () => {
		patchPreviewBlocks(hostA, A);
		patchPreviewBlocks(hostB, B);

		const backToA = patchPreviewBlocks(hostA, A);

		expect(backToA.replaced).toBe(0);
		expect(backToA.inserted).toEqual([]);
	});

	test('the nodes the reader was looking at are the same objects afterwards', () => {
		patchPreviewBlocks(hostA, A);
		const before = [...hostA.querySelectorAll('.content-inner > p')];

		patchPreviewBlocks(hostB, B);
		patchPreviewBlocks(hostA, A);

		const after = [...hostA.querySelectorAll('.content-inner > p')];
		expect(after).toEqual(before);
		// Identity, not equality: a rebuilt tree passes `toEqual` on the markup and
		// is still a different set of boxes with different layout.
		after.forEach((node, i) => expect(node).toBe(before[i]));
	});

	test('each host remembers its own document, so neither switch disturbs the other', () => {
		patchPreviewBlocks(hostA, A);
		patchPreviewBlocks(hostB, B);
		patchPreviewBlocks(hostA, A);
		patchPreviewBlocks(hostB, B);

		expect(hostA.querySelector('h1')!.textContent).toBe('alpha');
		expect(hostB.querySelector('h1')!.textContent).toBe('beta');
	});

	test('a document that changed while its tab was hidden is patched, not rebuilt, on the way back', () => {
		patchPreviewBlocks(hostA, A);
		const wrapper = hostA.querySelector('.foldable-content-wrapper')!;

		// What a background render does: the tab's `content` is rewritten while the
		// host is off screen. The host is untouched until the tab is shown again.
		const edited = doc('alpha', ['one', 'two EDITED', 'three']);
		const patch = patchPreviewBlocks(hostA, edited);

		expect(patch.inserted.length).toBe(1);
		expect(hostA.querySelector('.foldable-content-wrapper')).toBe(wrapper);
		expect(hostA.textContent).toContain('two EDITED');
	});

	test('the same host given a different document does replace everything — the case being avoided', () => {
		patchPreviewBlocks(hostA, A);
		const patch = patchPreviewBlocks(hostA, B);

		expect(patch.replaced).toBeGreaterThan(0);
		// Without this the three tests above would pass against a patch function
		// that never replaces anything at all.
	});
});

// A file path identifies a tab. Two tabs on one file are two buffers with two
// dirty flags and two auto-save timers writing the same file in turn, so
// whichever lands last silently overwrites the other's work. Every way to
// reach that state goes through a different caller — a link opened in a new
// tab, Save As onto an open file, back/forward, a tab moved in from another
// window — so the constraint belongs to the store.
//
// These tests drive the real TabManager: they assert behaviour, not wording.
describe('one tab per file', () => {
	beforeAll(() => {
		// The runes are the compiler's, not ours: vitest builds `.svelte.ts` through the
		// Svelte plugin, so `$state`/`$derived`/`$effect` behave here exactly as they do
		// in the app. Only the things jsdom genuinely does not have are stubbed.
		(window as any).__TAURI_INTERNALS__ = {
			metadata: { currentWindow: { label: 'main' }, currentWebview: { windowLabel: 'main', label: 'main' } },
			invoke: (cmd: string) => Promise.resolve(cmd === 'get_os_type' ? 'macos' : null),
		};
	});

	afterAll(() => {
		// One store for the whole file: leave it empty for the next describe.
		tabManager.closeAll();
		tabManager.recentlyClosed.length = 0;
		localStorage.clear();
	});

	function reset() {
		tabManager.closeAll();
		tabManager.recentlyClosed.length = 0;
		localStorage.clear();
	}

	function tabsFor(path: string) {
		return tabManager.tabs.filter((tab) => tab.path === path);
	}

	// --- one tab per file ---

	test('opening a file that is already open activates that tab instead of duplicating it', () => {
		reset();
		tabManager.addTab('/notes/a.md', 'first');
		const first = tabManager.activeTabId;
		tabManager.addTab('/notes/b.md');

		tabManager.addTab('/notes/a.md');

		assert.equal(tabsFor('/notes/a.md').length, 1);
		assert.equal(tabManager.activeTabId, first, 'the request resolves to the existing tab');
		assert.equal(tabManager.tabs.length, 2);
	});

	// Scope: this proves the STORE does not clobber the buffer when an open file
	// is opened again. It does not prove the whole open flow is safe —
	// `documentSession.loadMarkdown` re-reads the file into the tab it activates,
	// which is a pre-existing behaviour of the ordinary open path and lives
	// outside this file.
	test('re-opening a file does not overwrite the unsaved edits in its tab', () => {
		reset();
		tabManager.addTab('/notes/a.md', 'saved text');
		const id = tabManager.activeTabId!;
		tabManager.updateTabRawContent(id, 'unsaved edits');

		tabManager.addTab('/notes/a.md', 'saved text');

		const tab = tabManager.tabs.find((item) => item.id === id)!;
		assert.equal(tab.rawContent, 'unsaved edits');
		assert.equal(tab.isDirty, true);
	});

	test('following a link to an open file leaves exactly one tab holding it', () => {
		reset();
		tabManager.addTab('/notes/target.md', 'target text');
		tabManager.addTab('/notes/from.md', 'from text');
		const walker = tabManager.activeTabId!;

		tabManager.navigate(walker, '/notes/target.md');

		assert.equal(tabsFor('/notes/target.md').length, 1);
		assert.equal(tabsFor('/notes/target.md')[0].id, walker);
		// The clean loser is a copy of the file the winner now holds, so closing it
		// costs nothing — and it lands on the reopen stack like any other close.
		assert.ok(tabManager.recentlyClosed.includes('/notes/target.md'));
	});

	test('a tab with unsaved edits is never closed to resolve a path conflict', () => {
		reset();
		tabManager.addTab('/notes/target.md', 'target text');
		const resident = tabManager.activeTabId!;
		tabManager.updateTabRawContent(resident, 'work in progress');
		tabManager.addTab('/notes/from.md', 'from text');
		const walker = tabManager.activeTabId!;

		tabManager.navigate(walker, '/notes/target.md');

		const kept = tabManager.tabs.find((tab) => tab.id === resident);
		assert.ok(kept, 'the dirty buffer survives');
		assert.equal(kept!.rawContent, 'work in progress');
		assert.equal(kept!.isDirty, true);
		// It keeps the text and gives up the path: nothing is discarded, and
		// nothing can auto-save over the file behind the user's back.
		assert.equal(kept!.path, '');
		assert.equal(tabsFor('/notes/target.md').length, 1);
		assert.equal(tabsFor('/notes/target.md')[0].id, walker);
	});

	test('Save As onto a file that is already open does not leave two tabs on it', () => {
		reset();
		tabManager.addTab('/notes/target.md', 'target text');
		tabManager.addNewTab();
		const untitled = tabManager.activeTabId!;

		// saveContentAs writes the file first and then re-points the tab.
		tabManager.updateTabPath(untitled, '/notes/target.md');

		assert.equal(tabsFor('/notes/target.md').length, 1);
		assert.equal(tabsFor('/notes/target.md')[0].id, untitled);
	});

	test('Save As from a saved file onto an open one does not leave two tabs on it', () => {
		reset();
		tabManager.addTab('/notes/target.md', 'target text');
		tabManager.addTab('/notes/other.md', 'other text');
		const moved = tabManager.activeTabId!;

		tabManager.updateTabPath(moved, '/notes/target.md');

		assert.equal(tabsFor('/notes/target.md').length, 1);
		assert.equal(tabsFor('/notes/target.md')[0].id, moved);
	});

	test('going back to a file another tab has since opened does not duplicate it', () => {
		reset();
		tabManager.addTab('/notes/a.md', 'a');
		const walker = tabManager.activeTabId!;
		tabManager.navigate(walker, '/notes/b.md');
		tabManager.addTab('/notes/a.md');

		assert.equal(tabManager.goBack(walker), '/notes/a.md');

		assert.equal(tabsFor('/notes/a.md').length, 1);
		assert.equal(tabsFor('/notes/a.md')[0].id, walker);
	});

	test('a tab arriving from another window does not duplicate a file open here', () => {
		reset();
		tabManager.addTab('/notes/shared.md', 'resident copy');

		tabManager.insertTransferredTab({
			path: '/notes/shared.md',
			title: 'shared.md',
			rawContent: 'edited elsewhere',
			originalContent: 'resident copy',
			isDirty: true,
			isEditing: true,
			scrollTop: 0,
			scrollPercentage: 0,
			anchorLine: asRendererLine(0),
			isSplit: false,
			splitRatio: 0.5,
			isScrollSynced: false,
			hasReplacementChars: false,
			encoding: 'UTF-8',
			history: ['/notes/shared.md'],
			historyIndex: 0,
		});

		assert.equal(tabsFor('/notes/shared.md').length, 1);
		assert.equal(tabsFor('/notes/shared.md')[0].rawContent, 'edited elsewhere');
	});

	test('untitled tabs are not files and do not collide', () => {
		reset();
		tabManager.addNewTab();
		tabManager.addNewTab();
		tabManager.addNewTab();

		assert.equal(tabManager.tabs.length, 3);
		assert.equal(tabsFor('').length, 3);
	});

	test('the home tab is a singleton on its own terms, not through the path rule', () => {
		reset();
		tabManager.addHomeTab();
		const home = tabManager.activeTabId;
		tabManager.addTab('/notes/a.md');
		tabManager.addHomeTab();

		assert.equal(tabsFor('HOME').length, 1);
		assert.equal(tabManager.activeTabId, home);
	});
});

describe('path identity on a case-folding volume', () => {
	beforeAll(() => {
		(window as any).__TAURI_INTERNALS__ = {
			metadata: { currentWindow: { label: 'main' }, currentWebview: { windowLabel: 'main', label: 'main' } },
			invoke: (cmd: string, args: any) => {
				if (cmd === 'canonicalize_path') {
					const resolved = lookup(args.path);
					// A name nothing answers to is still a legal target (Save As to a
					// new file); the backend resolves its directory and keeps the name.
					return Promise.resolve(resolved ?? args.path);
				}
				if (cmd === 'read_file_content_checked') {
					const file = disk.get(lookup(args.path) ?? args.path);
					return Promise.resolve([file?.body ?? '', file?.lossy ?? false]);
				}
				if (cmd === 'open_markdown_preview') {
					const file = disk.get(lookup(args.path) ?? args.path);
					return Promise.resolve([file?.body ?? '', true, file?.lossy ?? false]);
				}
				if (cmd === 'save_file_content') {
					writes.push({ path: args.path, content: args.content });
					disk.set(lookup(args.path) ?? args.path, { body: args.content, lossy: false });
					return Promise.resolve(null);
				}
				// The Save As dialog. `@tauri-apps/plugin-dialog`'s `save()` is a thin
				// wrapper over this command, so stubbing it here needs no module
				// patching and exercises the real wrapper.
				if (cmd === 'plugin:dialog|save') return Promise.resolve(nextSaveTarget);
				if (cmd === 'get_os_type') return Promise.resolve('macos');
				return Promise.resolve(null);
			},
		};
	});

	afterAll(() => {
		// One store for the whole file: leave it empty for the next describe.
		tabManager.closeAll();
		tabManager.recentlyClosed.length = 0;
		localStorage.clear();
	});

	// On macOS and Windows the filesystem folds case: `/notes/A.md` and
	// `/notes/a.md` are ONE file. (APFS folds Unicode normalization too, so the
	// NFC and NFD spellings of `café.md` are one file as well — which no amount of
	// case folding in the frontend could ever reach.) Markpad compared paths with
	// exact string equality in three places, and each of them broke differently
	// when the same file arrived under two spellings:
	//
	//   1. the lossy-decode save guard let a Save As typed `/notes/Legacy.md`
	//      overwrite the non-UTF-8 file the tab had opened as `/notes/legacy.md`,
	//      destroying it — the one thing that guard exists to prevent;
	//   2. one-tab-per-file gave two tabs on one file, i.e. two buffers with two
	//      auto-save timers taking turns overwriting each other;
	//   3. the reopen guard did not recognise its own file, so opening it again
	//      read disk content over a buffer full of unsaved edits.
	//
	// All three now ask the filesystem what file a path names (the Rust
	// `canonicalize_path`), once, when the path enters the app, and compare that.
	//
	// These tests drive the real TabManager and the real documentSession against a
	// backend stubbed to behave like a case-insensitive volume. They assert
	// behaviour — buffers kept, files not written, tab counts — never wording.

	// The runes are the compiler's, not ours: vitest builds `.svelte.ts` through the
	// Svelte plugin, so the store and the session run under real reactivity, and
	// jsdom supplies `window` and `localStorage`. Only the Tauri backend is stubbed.

	/** Files by their on-disk name, and whether each decoded lossily. */
	const disk = new Map<string, { body: string; lossy: boolean }>();
	/** Every write the session actually performed, in order. */
	const writes: { path: string; content: string }[] = [];

	/**
	 * A case-insensitive volume, modelled the way a real one behaves: a lookup
	 * matches any spelling, and what comes back is the name the DIRECTORY holds —
	 * which is exactly what `realpath` reports and what `canonicalize_path`
	 * returns. Nothing here lowercases a path; the on-disk name is the answer.
	 */
	function lookup(path: string): string | null {
		const wanted = path.toLowerCase();
		for (const name of disk.keys()) {
			if (name.toLowerCase() === wanted) return name;
		}
		return null;
	}

	/** What the dialog will return next. */
	let nextSaveTarget: string | null = null;

	const errors: string[] = [];

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
			onError: (message: string) => void errors.push(message),
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
		writes.length = 0;
		errors.length = 0;
		nextSaveTarget = null;
	}

	// --- gap 1: the lossy-decode save guard -----------------------------------

	test('Save As in a different case is still an overwrite of the source file', async () => {
		// The file is GBK, so its buffer is U+FFFD mojibake and writing it back
		// destroys the document — that is what `refuseIfLossilyDecoded` stops. The
		// user opened it as `/notes/legacy.md`; the Save As dialog comes back with
		// `/notes/Legacy.md`. On this volume that is the SAME FILE, so the refusal
		// has to hold, or the guard is one autocomplete away from being bypassed.
		reset();
		const session = makeSession();
		disk.set('/notes/legacy.md', { body: '# �� mojibake', lossy: true });

		await session.loadMarkdown('/notes/legacy.md');
		assert.equal(tabManager.activeTab?.hasReplacementChars, true, 'precondition: the buffer is known lossy');

		nextSaveTarget = '/notes/Legacy.md';
		const saved = await session.saveContentAs();

		assert.equal(saved, false, 'the refusal must hold');
		assert.deepEqual(writes, [], 'nothing may be written over the source file');
		assert.equal(disk.get('/notes/legacy.md')?.body, '# �� mojibake', 'the document is intact');
	});

	test('Save As to a genuinely different file stays open as the escape hatch', async () => {
		// The other direction, and the one that must not regress: the whole point
		// of refusing is that the user can still write a UTF-8 copy somewhere else.
		reset();
		const session = makeSession();
		disk.set('/notes/legacy.md', { body: '# �� mojibake', lossy: true });

		await session.loadMarkdown('/notes/legacy.md');
		nextSaveTarget = '/notes/legacy-utf8.md';
		const saved = await session.saveContentAs();

		assert.equal(saved, true);
		assert.equal(writes.length, 1);
		assert.equal(writes[0].path, '/notes/legacy-utf8.md');
		assert.equal(tabManager.activeTab?.hasReplacementChars, false, 'the copy is UTF-8, so the tab is savable again');
	});

	// --- gap 2: one tab per file ----------------------------------------------

	test('opening one file under two spellings leaves one tab, not two', async () => {
		// Two tabs on one file are two buffers with two dirty flags and two
		// auto-save timers writing the same file in turn; whichever lands last
		// silently overwrites the other's work.
		reset();
		const session = makeSession();
		disk.set('/notes/A.md', { body: 'shared body', lossy: false });

		await session.loadMarkdown('/notes/A.md');
		const first = tabManager.activeTabId;
		await session.loadMarkdown('/notes/a.md');

		assert.equal(tabManager.tabs.length, 1, 'one file, one tab');
		assert.equal(tabManager.activeTabId, first, 'the request resolved to the tab that already held it');
	});

	test('two genuinely different files still get their own tabs', async () => {
		// The guard against over-merging: nothing above may collapse files that
		// differ by more than spelling.
		reset();
		const session = makeSession();
		disk.set('/notes/a.md', { body: 'a', lossy: false });
		disk.set('/notes/b.md', { body: 'b', lossy: false });

		await session.loadMarkdown('/notes/a.md');
		await session.loadMarkdown('/notes/b.md');

		assert.equal(tabManager.tabs.length, 2);
	});

	// Back/forward and a tab arriving from another window put a path on a tab
	// before anything has resolved it, so their claim compares spellings. The
	// identity arrives a moment later, and the claim has to be made again then.
	test('going back to a file open in another tab under another spelling leaves one tab', async () => {
		reset();
		const session = makeSession();
		disk.set('/notes/A.md', { body: 'a', lossy: false });
		disk.set('/notes/b.md', { body: 'b', lossy: false });

		await session.loadMarkdown('/notes/A.md');
		const walker = tabManager.activeTabId!;
		await session.loadMarkdown('/notes/b.md', { navigate: true });
		await session.loadMarkdown('/notes/a.md');
		tabManager.setActive(walker);

		const path = tabManager.goBack(walker)!;
		await session.loadMarkdown(path, { skipTabManagement: true });

		assert.equal(tabManager.tabs.length, 1, 'one file, one tab');
		assert.equal(tabManager.activeTabId, walker);
	});

	test('a tab arriving from another window under another spelling leaves one tab', async () => {
		reset();
		const session = makeSession();
		disk.set('/notes/A.md', { body: 'resident copy', lossy: false });
		await session.loadMarkdown('/notes/A.md');

		const arrived = tabManager.insertTransferredTab({
			path: '/notes/a.md',
			title: 'a.md',
			rawContent: 'edited elsewhere',
			originalContent: 'resident copy',
			isDirty: true,
			isEditing: true,
			scrollTop: 0,
			scrollPercentage: 0,
			anchorLine: asRendererLine(0),
			isSplit: false,
			splitRatio: 0.5,
			isScrollSynced: false,
			hasReplacementChars: false,
			encoding: 'UTF-8',
			history: ['/notes/a.md'],
			historyIndex: 0,
		});
		// The path is resolved in the background; let that answer land.
		await new Promise((resolve) => setTimeout(resolve, 0));

		assert.equal(tabManager.tabs.length, 1, 'one file, one tab');
		assert.equal(tabManager.tabs[0].id, arrived);
		assert.equal(tabManager.tabs[0].rawContent, 'edited elsewhere');
	});

	test('Save As onto a file already open under another spelling does not leave two tabs on it', async () => {
		// Reached through `updateTabPath` rather than `addTab`, and the file is
		// already written by the time the store hears about it — so the loser's
		// buffer is stale no matter which way the name was spelled.
		reset();
		const session = makeSession();
		disk.set('/notes/A.md', { body: 'original', lossy: false });
		await session.loadMarkdown('/notes/A.md');

		tabManager.addNewTab();
		const draft = tabManager.activeTabId!;
		tabManager.updateTabRawContent(draft, 'replacement');

		nextSaveTarget = '/notes/a.md';
		assert.equal(await session.saveContentAs(), true);

		assert.equal(
			tabManager.tabs.filter((tab) => tab.path !== '').length,
			1,
			'exactly one tab may claim the file',
		);
		assert.equal(tabManager.activeTabId, draft, 'the tab that owns the bytes on disk keeps it');
	});

	// --- gap 3: the reopen guard ----------------------------------------------

	// The guard runs on the tab the content is about to land in, so it only sees a
	// mis-spelled path on the routes that pick the tab themselves and pass
	// `navigate` / `skipTabManagement`: a link followed in place, and back/forward.
	// A link written `./A.md` inside a document whose tab is open as `/notes/a.md`
	// is that case exactly — and it is the ordinary way to reach it, since link
	// text is typed by the document's author, not by the filesystem.
	test('following a link that spells the current file differently does not overwrite its unsaved edits', async () => {
		// `setTabRawContent` replaces rawContent AND originalContent, so the reload
		// would not merely lose the edits — the tab would look clean afterwards and
		// the user could not tell what went missing.
		reset();
		const session = makeSession();
		disk.set('/notes/a.md', { body: 'on disk', lossy: false });

		await session.loadMarkdown('/notes/a.md');
		const id = tabManager.activeTabId!;
		tabManager.updateTabRawContent(id, 'my unsaved paragraph');

		await session.loadMarkdown('/notes/A.md', { navigate: true });

		const tab = tabManager.tabs.find((item) => item.id === id)!;
		assert.equal(tab.rawContent, 'my unsaved paragraph', 'the edits survive');
		assert.equal(tab.originalContent, 'on disk', 'the saved baseline is intact, so the tab can still say what changed');
		assert.equal(tab.isDirty, true, 'the tab still knows it has something to save');
	});

	test('an explicit revert still discards the buffer whatever the spelling', async () => {
		// "Reload from disk" and the external-change "Reload" pass
		// `discardUnsavedBuffer`; the identity fix must not make them unreachable.
		reset();
		const session = makeSession();
		disk.set('/notes/a.md', { body: 'on disk', lossy: false });

		await session.loadMarkdown('/notes/a.md');
		const id = tabManager.activeTabId!;
		tabManager.updateTabRawContent(id, 'my unsaved paragraph');

		await session.loadMarkdown('/notes/A.md', { navigate: true, discardUnsavedBuffer: true });

		const tab = tabManager.tabs.find((item) => item.id === id)!;
		assert.equal(tab.rawContent, 'on disk');
		assert.equal(tab.isDirty, false);
	});

	// --- the fallback ----------------------------------------------------------

	test('a path the backend cannot resolve is compared exactly, as before', async () => {
		// An unreachable network volume, a deleted parent directory, or any route
		// that has not resolved a path yet must cost the improvement and nothing
		// more: the literal comparison is what every one of these sites did before.
		const { isSameFilePath } = await import('../src/lib/utils/pathIdentity.js');

		assert.equal(isSameFilePath({ path: '/notes/A.md' }, { path: '/notes/a.md' }), false);
		assert.equal(isSameFilePath({ path: '/notes/A.md' }, { path: '/notes/A.md' }), true);
		// A key is trusted only when BOTH sides have one: `/notes/today.md` may be
		// a symlink whose key is `/archive/2026-08-03.md`, so a bare path that
		// happens to equal someone else's key proves nothing.
		assert.equal(
			isSameFilePath({ path: '/notes/today.md', pathKey: '/archive/x.md' }, { path: '/archive/x.md' }),
			false,
		);
		assert.equal(
			isSameFilePath(
				{ path: '/notes/today.md', pathKey: '/archive/x.md' },
				{ path: '/archive/x.md', pathKey: '/archive/x.md' },
			),
			true,
		);
		// Untitled buffers and the home sentinel are not files and never collide.
		assert.equal(isSameFilePath({ path: '' }, { path: '' }), false);
		assert.equal(isSameFilePath({ path: 'HOME' }, { path: 'HOME' }), false);
	});
});

describe('a read lands in its own tab', () => {
	beforeAll(() => {
		(window as any).__TAURI_INTERNALS__ = {
			metadata: { currentWindow: { label: 'main' }, currentWebview: { windowLabel: 'main', label: 'main' } },
			invoke: (cmd: string, args: any) => {
				const hold = held.get(cmd);
				if (hold) {
					held.delete(cmd);
					return hold.promise.then(() => answer(cmd, args));
				}
				return Promise.resolve(answer(cmd, args));
			},
		};
	});

	afterAll(() => {
		// One store for the whole file: leave it empty for the next describe.
		tabManager.closeAll();
		tabManager.recentlyClosed.length = 0;
		localStorage.clear();
	});

	// A disk read that fills a tab is an await, and the tab can change under it:
	// the user switches to another tab, types, ticks a task, navigates, or closes
	// it. `claimTabForRead` pins the tab, its file and its buffer when the read
	// departs, and refuses the result if any of them moved by the time it lands.
	//
	// Each test holds one backend call open, changes the tab while it is out, then
	// lets it answer — the "old result arrives late" order — and checks the stale
	// result was refused. The real TabManager, document session and window session
	// run under vitest; only the Tauri bridge is stubbed.

	type Deferred = { promise: Promise<unknown>; resolve: (value: unknown) => void };
	function deferred(): Deferred {
		let resolve!: (value: unknown) => void;
		const promise = new Promise<unknown>((r) => (resolve = r));
		return { promise, resolve };
	}

	const disk = new Map<string, string>();
	/** Calls to hold open, by command name, until the test resolves them. */
	const held = new Map<string, Deferred>();
	let storedSnapshot: string | null = null;

	function answer(cmd: string, args: any): unknown {
		switch (cmd) {
			case 'canonicalize_path':
				return args.path;
			case 'open_markdown_preview':
				return [disk.get(args.path) ?? '', true, false, 'UTF-8'];
			case 'read_file_content_checked':
				return [disk.get(args.path) ?? '', false, 'UTF-8'];
			case 'load_window_state':
				return storedSnapshot;
			default:
				return null;
		}
	}

	function makeSession() {
		return createDocumentSession({
			setShowHome: () => {},
			currentFile: () => tabManager.activeTab?.path ?? '',
			resetScrollHistory: () => {},
			renderMarkdown: async (raw: string) => `<p>${raw}</p>`,
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
		disk.clear();
		held.clear();
		storedSnapshot = null;
		settings.openFileMode = 'preview';
	}

	function hold(cmd: string) {
		const d = deferred();
		held.set(cmd, d);
		return d;
	}

	const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
	const tabById = (id: string) => tabManager.tabs.find((tab) => tab.id === id)!;

	test('Reload from disk lands in the tab it was asked for, not the one switched to', async () => {
		reset();
		const session = makeSession();
		disk.set('/notes/a.md', 'a on disk');
		tabManager.addTab('/notes/a.md', 'a old');
		const a = tabManager.activeTabId!;
		tabManager.addTab('/notes/b.md', 'b text');
		const b = tabManager.activeTabId!;
		tabManager.setActive(a);

		const gate = hold('canonicalize_path');
		const load = session.loadMarkdown('/notes/a.md', { preserveEditState: true, skipTabManagement: true, discardUnsavedBuffer: true });
		tabManager.setActive(b);
		gate.resolve(undefined);
		await load;

		assert.equal(tabById(b).rawContent, 'b text', 'the tab switched to must keep its own text');
		assert.equal(tabById(b).path, '/notes/b.md');
		assert.equal(tabById(a).rawContent, 'a on disk', 'the reload belongs to the tab it was asked for');
	});

	test('Back lands in the tab it was pressed in', async () => {
		reset();
		const session = makeSession();
		disk.set('/notes/prev.md', 'prev on disk');
		tabManager.addTab('/notes/prev.md', 'prev on disk');
		const a = tabManager.activeTabId!;
		tabManager.navigate(a, '/notes/next.md');
		tabManager.setTabRawContent(a, 'next text');
		tabManager.addTab('/notes/b.md', 'b text');
		const b = tabManager.activeTabId!;
		tabManager.setActive(a);

		const path = tabManager.goBack(a)!;
		const gate = hold('canonicalize_path');
		const load = session.loadMarkdown(path, { skipTabManagement: true });
		tabManager.setActive(b);
		gate.resolve(undefined);
		await load;

		assert.equal(tabById(b).rawContent, 'b text');
		assert.equal(tabById(a).rawContent, 'prev on disk');
	});

	test('typing during a Live Mode reload is kept, and the tab stays dirty', async () => {
		for (const mode of ['preview', 'editor'] as const) {
			reset();
			settings.openFileMode = mode;
			const session = makeSession();
			disk.set('/notes/a.md', 'changed by another program');
			tabManager.addTab('/notes/a.md', 'original');
			const a = tabManager.activeTabId!;
			tabById(a).isEditing = mode === 'editor';

			const gate = hold(mode === 'editor' ? 'read_file_content_checked' : 'open_markdown_preview');
			const load = session.loadMarkdown('/notes/a.md');
			await settle();
			tabManager.updateTabRawContent(a, 'original plus typing');
			gate.resolve(undefined);
			await load;

			assert.equal(tabById(a).rawContent, 'original plus typing', `typing lost (${mode})`);
			assert.equal(tabById(a).isDirty, true, `edits must still read as unsaved (${mode})`);
		}
	});

	test('typing during a non-markdown reload is kept', async () => {
		reset();
		const session = makeSession();
		disk.set('/notes/a.json', 'changed by another program');
		tabManager.addTab('/notes/a.json', 'original');
		const a = tabManager.activeTabId!;

		const gate = hold('read_file_content_checked');
		const load = session.loadMarkdown('/notes/a.json');
		await settle();
		tabManager.updateTabRawContent(a, 'original plus typing');
		gate.resolve(undefined);
		await load;

		assert.equal(tabById(a).rawContent, 'original plus typing');
		assert.equal(tabById(a).isDirty, true);
	});

	test('completing a partial buffer does not land on a tab that navigated away', async () => {
		reset();
		const session = makeSession();
		disk.set('/notes/big.md', 'the whole big file');
		tabManager.addTab('/notes/big.md', '');
		const a = tabManager.activeTabId!;
		tabManager.setTabRawContent(a, 'the whole', true);

		const gate = hold('read_file_content_checked');
		const completing = session.ensureFullContent(a);
		tabManager.navigate(a, '/notes/other.md');
		tabManager.setTabRawContent(a, 'other text');
		gate.resolve(undefined);
		assert.equal(await completing, true, 'the buffer the tab now holds is whole');

		assert.equal(tabById(a).rawContent, 'other text');
		assert.equal(tabById(a).path, '/notes/other.md');
	});

	// The read Cmd+E and split view make (MarkdownViewer.svelte) use the claim
	// directly. A task ticked while it is out is saved by auto-save, so the tab is
	// clean again when the read lands: "not dirty" alone would let the read, which
	// left before the tick, put the unticked text back.
	test('a read that left before a ticked-and-saved task is refused', () => {
		reset();
		tabManager.addTab('/notes/a.md', '- [ ] task');
		const a = tabManager.activeTabId!;

		const mayApply = claimTabForRead(a);
		tabManager.setTabRawContent(a, '- [x] task');

		assert.equal(tabById(a).isDirty, false);
		assert.equal(mayApply(), false);
	});

	test('of two reads of one tab, only the newer may land', () => {
		reset();
		tabManager.addTab('/notes/a.md', 'text');
		const a = tabManager.activeTabId!;

		const older = claimTabForRead(a);
		const newer = claimTabForRead(a);

		assert.equal(older(), false);
		assert.equal(newer(), true);
	});

	test('a read of a closed tab is refused', () => {
		reset();
		tabManager.addTab('/notes/a.md', 'text');
		const a = tabManager.activeTabId!;
		const mayApply = claimTabForRead(a);
		tabManager.closeTab(a);
		assert.equal(mayApply(), false);
	});

	test('typing into a restored tab before its read lands is kept', async () => {
		reset();
		tabManager.addTab('/notes/a.md', '');
		storedSnapshot = tabManager.serializeState();
		tabManager.closeAll();
		localStorage.clear();
		disk.set('/notes/a.md', 'a on disk');
		const session = makeSession();

		const windowSession = createWindowSession({
			windowStateKey: 'readLandsState',
			legacyStateKey: 'readLandsLegacy',
			restoreInProgressKey: 'readLandsProgress',
			serializeState: () => tabManager.serializeState(),
			shouldRestoreState: () => true,
			isDisposed: () => false,
			restoreState: (json) => tabManager.restoreState(json),
			restoredTabs: () => tabManager.tabs.map((tab) => ({ id: tab.id, path: tab.path })),
			loadRestoredTab: (tabId) => session.readRestoredTab(tabId),
			dropRestoredTab: (tabId) => tabManager.closeTab(tabId),
			canTransfer: () => true,
			canDetach: () => true,
			transferPayload: () => '',
			onTransferClaimed: () => {},
			acceptTransferredTab: async () => 'arrived',
			onError: () => {},
			onWarning: () => {},
			onInterrupted: () => {},
		});

		// A preview tab: restore reads it the way an open does, through the slice.
		const gate = hold('open_markdown_preview');
		const restoring = windowSession.restore();
		while (tabManager.tabs.length === 0 || held.has('open_markdown_preview')) await settle();
		const a = tabManager.tabs[0].id;
		tabManager.updateTabRawContent(a, 'typed while restoring');
		gate.resolve(undefined);
		await restoring;

		assert.equal(tabById(a).rawContent, 'typed while restoring');
		assert.equal(tabById(a).isDirty, true);
	});
});

describe('the first read measures its own tab', () => {
	beforeAll(() => {
		(window as any).__TAURI_INTERNALS__ = {
			metadata: { currentWindow: { label: 'main' }, currentWebview: { windowLabel: 'main', label: 'main' } },
			invoke: (cmd: string, args: any) => Promise.resolve(handleInvoke(cmd, args)),
		};
	});

	afterAll(() => {
		// One store for the whole file: leave it empty for the next describe.
		tabManager.closeAll();
		tabManager.recentlyClosed.length = 0;
		localStorage.clear();
	});

	/**
	 * Opening a large file is two reads: a 5MB slice that puts something on screen,
	 * and a background read that completes it. The slice arrives after three awaits,
	 * and the reader can switch tabs inside any of them.
	 *
	 * Every write the first stage makes is addressed by tab id, so a switch costs
	 * nothing — with a preview host per tab, the HTML lands on the tab that asked
	 * for it and is shown when that tab is next displayed. The exception was the
	 * viewport measurement: there is one article on screen and one `isAtBottom`
	 * flag, so measuring after a switch answers "does this document fit the
	 * viewport" for the tab the reader moved to, and a short one sets the flag that
	 * raises the "loading full document" chip on the tab still loading — at the top
	 * of a slice nobody has scrolled.
	 *
	 * The switch here happens inside `renderMarkdown`, which is where the real one
	 * has the most room: rendering 5MB of markdown is the longest await on the path.
	 */

	let handleInvoke: (cmd: string, args: any) => unknown = (cmd) => {
		throw new Error(`unexpected invoke: ${cmd}`);
	};

	const BIG = '/notes/big.md';
	const SMALL = '/notes/small.md';

	/** The first stage returns a slice (`isFull` false); the completion never lands. */
	function readsATruncatedFile() {
		handleInvoke = (cmd, args) => {
			if (cmd === 'get_os_type') return 'macos';
			if (cmd === 'canonicalize_path') return args.path;
			if (cmd === 'open_markdown_preview') return ['the first five megabytes', false, false, 'UTF-8'];
			// The background completion, left in flight: this is about the tab the
			// first stage lands on, not about what finishes afterwards.
			if (cmd === 'read_file_content_checked') return new Promise(() => {});
			throw new Error(`unexpected invoke: ${cmd}`);
		};
	}

	function openTwoTabs() {
		tabManager.closeAll();
		tabManager.addTab(BIG);
		tabManager.addTab(SMALL);
		const big = tabManager.tabs.find((tab) => tab.path === BIG)!.id;
		const small = tabManager.tabs.find((tab) => tab.path === SMALL)!.id;
		tabManager.setActive(big);
		return { big, small };
	}

	function makeSession(overrides: Record<string, unknown> = {}) {
		return createDocumentSession({
			setShowHome: () => {},
			currentFile: () => tabManager.activeTab?.path ?? '',
			resetScrollHistory: () => {},
			renderMarkdown: async () => 'rendered',
			afterLoad: async () => {},
			saveRecentFile: () => {},
			deleteRecentFile: () => {},
			setLoadingTabs: () => {},
			measureInitialViewport: () => {},
			isScrolling: () => false,
			onError: (message: string, error: unknown) => {
				throw new Error(`${message}: ${String(error)}`);
			},
			onDiskChangedUnderSave: () => {},
			cancelPendingAutoSave: () => {},
			askClose: async () => 'discard' as const,
			onCloseSaveNewerEdits: () => {},
			onCloseAutoSaveFailed: () => {},
			onPartialCopySaved: () => {},
			...overrides,
		});
	}

	test('a switch during the first read leaves the other document unmeasured', async () => {
		readsATruncatedFile();
		const { big, small } = openTwoTabs();

		const measuredWhileActive: (string | null)[] = [];
		let loading: string[] = [];
		const session = makeSession({
			renderMarkdown: async () => {
				tabManager.setActive(small);
				return 'rendered';
			},
			setLoadingTabs: (ids: string[]) => (loading = ids),
			measureInitialViewport: () => measuredWhileActive.push(tabManager.activeTabId),
		});

		await session.loadMarkdown(BIG);

		assert.deepEqual(measuredWhileActive, [], 'the article showing the other tab is not measured');
		// The rest of the path was already right, and stays that way: the slice and
		// its rendered HTML are addressed by id, and so is the loading set the chip
		// asks about.
		assert.equal(tabManager.tabs.find((tab) => tab.id === big)!.content, 'rendered');
		assert.equal(tabManager.tabs.find((tab) => tab.id === big)!.isTruncated, true);
		assert.equal(tabManager.tabs.find((tab) => tab.id === small)!.content, '');
		assert.deepEqual(loading, [big], 'the loading tab is the one that is loading, not the one on screen');
	});

	test('with no switch, the tab that loaded is the tab measured', async () => {
		readsATruncatedFile();
		const { big } = openTwoTabs();

		const measuredWhileActive: (string | null)[] = [];
		const session = makeSession({
			measureInitialViewport: () => measuredWhileActive.push(tabManager.activeTabId),
		});

		await session.loadMarkdown(BIG);

		assert.deepEqual(measuredWhileActive, [big], 'the ordinary open still measures, exactly once');
	});
});

describe('tab transfer races', () => {
	beforeAll(() => {
		(window as any).__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => {} };
		(window as any).__TAURI_INTERNALS__ = {
			metadata: {
				currentWindow: { label: 'main' },
				currentWebview: { windowLabel: 'main', label: 'main' },
			},
			transformCallback: (fn: unknown) => fn,
			invoke: async (cmd: string, args: any) => {
				if (cmd === 'plugin:event|listen') {
					const id = nextListener++;
					listeners.set(id, { event: args.event, handler: args.handler });
					return id;
				}
				if (cmd === 'plugin:event|unlisten') {
					listeners.delete(args.eventId);
					return null;
				}
				if (cmd === 'get_os_type') return 'macos';
				calls.push({ cmd, args });
				return respond(cmd, args);
			},
		};
	});

	afterAll(() => {
		// One store for the whole file: leave it empty for the next describe.
		tabManager.closeAll();
		tabManager.recentlyClosed.length = 0;
		localStorage.clear();
	});

	/*
	 * Moving a tab to another window takes a snapshot when it starts and closes
	 * the source tab when the destination completes, one to two seconds later.
	 * These drive the source and destination halves of `windowSession` against a
	 * scripted broker: the session and the tab store run for real, only the Tauri
	 * backend is stubbed.
	 */

	type Handler = (event: { event: string; id: number; payload: unknown }) => void;

	const listeners = new Map<number, { event: string; handler: Handler }>();
	let nextListener = 1;
	let calls: Array<{ cmd: string; args: any }> = [];
	let respond: (cmd: string, args: any) => unknown = () => null;

	const TOKEN = 'tok';

	function emit(event: string, payload: unknown) {
		for (const [id, listener] of listeners) {
			if (listener.event === event) listener.handler({ event, id, payload });
		}
	}

	/** Lets pending IPC promises resolve and effects flush. */
	async function settle() {
		for (let i = 0; i < 20; i++) {
			flushSync();
			await Promise.resolve();
		}
	}

	function makeSession(accept: () => Promise<string | null> = async () => null) {
		const claimed: string[] = [];
		const session = createWindowSession({
			windowStateKey: 'savedTabsDataV2',
			legacyStateKey: 'savedTabsData',
			restoreInProgressKey: 'markpad-window-restore-in-progress',
			serializeState: () => '',
			shouldRestoreState: () => false,
			isDisposed: () => false,
			restoreState: () => {},
			restoredTabs: () => [],
			loadRestoredTab: async () => {},
			dropRestoredTab: () => {},
			canTransfer: () => true,
			canDetach: () => true,
			transferPayload: (tabId) => tabManager.tabs.find((tab) => tab.id === tabId)!.rawContent,
			onTransferClaimed: (tabId) => {
				claimed.push(tabId);
				tabManager.closeTab(tabId);
			},
			acceptTransferredTab: accept,
			onError: () => {},
			onWarning: () => {},
			onInterrupted: () => {},
		});
		return { session, claimed };
	}

	function openTab(text: string) {
		tabManager.addTab('/notes/a.md', text);
		return tabManager.activeTabId!;
	}

	afterEach(() => {
		vi.useRealTimers();
		tabManager.closeAll();
		listeners.clear();
		calls = [];
		respond = () => null;
	});

	test('typing before the destination claims travels with the tab', async () => {
		respond = (cmd) => (cmd === 'stage_detached_tab' ? TOKEN : cmd === 'refresh_detached_tab' ? 'updated' : null);
		const tabId = openTab('first');
		const { session } = makeSession();

		const moving = session.transfer(tabId, async () => {});
		await settle();
		tabManager.updateTabRawContent(tabId, 'first, then more');
		await settle();

		const refresh = calls.find((call) => call.cmd === 'refresh_detached_tab');
		assert.ok(refresh, 'the edit never reached the broker; the destination claims the stale snapshot');
		assert.equal(refresh.args.payload, 'first, then more');

		emit('tab-transfer-claimed', TOKEN);
		assert.equal(await moving, true);
		assert.equal(tabManager.tabs.length, 0);
	});

	test('an edit after the claim withdraws the transfer and the source keeps its tab', async () => {
		respond = (cmd) => (cmd === 'stage_detached_tab' ? TOKEN : cmd === 'refresh_detached_tab' ? 'revoked' : null);
		const tabId = openTab('first');
		const { session, claimed } = makeSession();

		const moving = session.transfer(tabId, async () => {});
		await settle();
		tabManager.updateTabRawContent(tabId, 'typed while the new window rendered');
		await settle();

		assert.equal(await moving, false);
		assert.deepEqual(claimed, []);
		assert.equal(tabManager.tabs[0]?.rawContent, 'typed while the new window rendered');
	});

	test('a completion that overtook the last edit does not close the edited tab', async () => {
		// The refresh lands after `complete` took the entry: the broker says
		// `gone` and `tab-transfer-claimed` is already on its way.
		respond = (cmd) => (cmd === 'stage_detached_tab' ? TOKEN : cmd === 'refresh_detached_tab' ? 'gone' : null);
		const tabId = openTab('first');
		const { session, claimed } = makeSession();

		const moving = session.transfer(tabId, async () => {});
		await settle();
		tabManager.updateTabRawContent(tabId, 'last keystroke');
		await settle();
		emit('tab-transfer-claimed', TOKEN);

		assert.equal(await moving, false);
		assert.deepEqual(claimed, []);
		assert.equal(tabManager.tabs[0]?.rawContent, 'last keystroke');
	});

	test('a destination whose completion is refused drops the tab it built', async () => {
		respond = (cmd) => {
			if (cmd === 'claim_detached_tab') {
				return JSON.stringify({
					path: '/notes/a.md',
					title: 'a.md',
					rawContent: 'old',
					originalContent: 'old',
					isDirty: false,
					isEditing: false,
					isSplit: false,
					isScrollSynced: false,
					hasReplacementChars: false,
					encoding: 'UTF-8',
					splitRatio: 0.5,
					scrollTop: 0,
					scrollPercentage: 0,
					anchorLine: 0,
					historyIndex: 0,
					history: [],
				});
			}
			if (cmd === 'complete_detached_tab') {
				return Promise.reject('TRANSFER_NOT_FOUND: the staged tab is gone; the source window kept it');
			}
			return null;
		};
		const { session } = makeSession(async () => openTab('old'));

		assert.equal(await session.acceptOfferedTransfer(TOKEN), false);
		assert.equal(tabManager.tabs.length, 0, 'the source kept the tab, so this copy is a duplicate');
	});

	test('a claim the destination never completes is handed back after its grace', async () => {
		vi.useFakeTimers();
		// Claimed, then the destination window died: the broker protects the
		// claim for a while and then lets the source cancel it.
		const outcomes = [
			{ cancelled: false, claimed: true },
			{ cancelled: false, claimed: true },
			{ cancelled: true, claimed: true },
		];
		respond = (cmd) => (cmd === 'stage_detached_tab' ? TOKEN : cmd === 'cancel_detached_tab' ? outcomes.shift() : null);
		const tabId = openTab('doc');
		const { session } = makeSession();

		let result: boolean | undefined;
		void session.transfer(tabId, async () => {}).then((moved) => (result = moved));
		for (let i = 0; i < 4; i++) {
			await vi.advanceTimersByTimeAsync(15_000);
			await settle();
		}

		assert.equal(result, false, 'the source stopped asking after one refusal and stayed stuck');
		assert.equal(tabManager.tabs.length, 1);
		// The tab is movable again.
		assert.equal(calls.filter((call) => call.cmd === 'stage_detached_tab').length, 1);
		void session.transfer(tabId, async () => {});
		await settle();
		assert.equal(calls.filter((call) => call.cmd === 'stage_detached_tab').length, 2);
	});

	// --- the viewer's side: what this window sends and how it takes a tab in ---

	function makeTransfer(overrides: Partial<Parameters<typeof createTransferOptions>[0]> = {}) {
		return createTransferOptions({
			editorPane: () => null,
			windowStateJson: () => tabManager.serializeState(),
			isCloseWalkActive: () => false,
			isDisposed: () => false,
			renderPreview: async () => {},
			restoreReadingPosition: () => {},
			...overrides,
		});
	}

	/** A payload as another window would send it, with this store left empty. */
	function arrivingSnapshot() {
		const tabId = openTab('# arriving');
		const snapshot = snapshotTab(tabManager.tabs.find((tab) => tab.id === tabId)!);
		tabManager.closeAll();
		return snapshot;
	}

	test('a failed render undoes the inserted tab', async () => {
		// The tab must exist before it can be rendered, so the destination owns a
		// document the source still shows until the render succeeds.
		const snapshot = arrivingSnapshot();
		const failing = makeTransfer({ renderPreview: () => Promise.reject(new Error('render failed')) });
		await assert.rejects(failing.acceptTransferredTab(snapshot), /render failed/);
		assert.equal(tabManager.tabs.length, 0);

		let disposed = false;
		const closing = makeTransfer({ isDisposed: () => disposed, renderPreview: async () => void (disposed = true) });
		assert.equal(await closing.acceptTransferredTab(snapshot), null);
		assert.equal(tabManager.tabs.length, 0, 'a window torn down mid-render keeps no half-arrived tab');
	});

	test('the arriving tab is put back where its reader was, after its document lands', async () => {
		// `insertTransferredTab` activates the tab while its preview is still
		// empty, so a restore before the render has nothing to scroll.
		const snapshot = arrivingSnapshot();
		const log: string[] = [];
		const transfer = makeTransfer({
			renderPreview: async () => {
				await Promise.resolve();
				log.push('rendered');
			},
			restoreReadingPosition: (tab) => log.push(`restored ${tab.path}`),
		});
		const id = await transfer.acceptTransferredTab(snapshot);
		assert.equal(id, tabManager.activeTabId);
		assert.deepEqual(log, ['rendered', 'restored /notes/a.md']);

		// Only the active tab's host is displayed: a reader who switched away
		// during the render must not have the document on screen moved.
		tabManager.closeAll();
		log.length = 0;
		const switching = makeTransfer({
			renderPreview: async () => void tabManager.addTab('/notes/other.md', 'other'),
			restoreReadingPosition: () => log.push('restored'),
		});
		await switching.acceptTransferredTab(snapshot);
		assert.deepEqual(log, []);
	});

	test('both gates that drop the view state ask for the anchor first', () => {
		// The two moments a tab's position leaves memory. Neither carries
		// `editorViewState`, so a background edit-only tab would leave at the
		// anchor of its last preview scroll.
		const lines = Array.from({ length: 80 }, (_, index) => `line ${index + 1}`).join('\n');
		const backgroundId = openTab(lines);
		tabManager.addTab('/notes/active.md', 'active');
		const background = tabManager.tabs.find((tab) => tab.id === backgroundId)!;
		background.isEditing = true;
		background.anchorLine = 3 as typeof background.anchorLine;
		background.editorViewState = { viewState: { firstPosition: { lineNumber: 40, column: 1 } } };
		const expected = outgoingTabAnchorLine(background, tabManager.activeTabId);
		assert.notEqual(expected, 3);

		const transfer = makeTransfer();
		assert.equal(JSON.parse(transfer.transferPayload(backgroundId)).anchorLine, expected);
		const saved = JSON.parse(transfer.serializeState()).tabs.find((tab: { path: string; anchorLine: number }) => tab.anchorLine === expected);
		assert.ok(saved, 'the window snapshot records the editor position too');
	});

	test('the transfer payload flushes before it snapshots the tab', () => {
		// The editor holds the live position; without the flush the tab travels
		// at the position of the last teardown.
		const tabId = openTab('doc');
		const editorPane = {
			flushPositionTo: (id: string) => {
				tabManager.tabs.find((tab) => tab.id === id)!.anchorLine = 12 as Tab['anchorLine'];
			},
		};
		const transfer = makeTransfer({ editorPane: () => editorPane });
		assert.equal(JSON.parse(transfer.transferPayload(tabId)).anchorLine, 12);
	});

	test('the window-state snapshot flushes too', () => {
		// Same staleness at window close: the editor has not come down yet.
		openTab('doc');
		const flushed: string[] = [];
		const editorPane = {
			flushPositionTo: (id: string) => {
				flushed.push(id);
				tabManager.tabs.find((tab) => tab.id === id)!.anchorLine = 12 as Tab['anchorLine'];
			},
		};
		const transfer = makeTransfer({ editorPane: () => editorPane });
		assert.equal(JSON.parse(transfer.serializeState()).tabs[0].anchorLine, 12);
		assert.deepEqual(flushed, [tabManager.activeTabId]);
	});

	test('a partial buffer cannot be handed to another window', async () => {
		// The destination rebuilds the tab from the payload alone and cannot know
		// the text is incomplete, so its auto-save would truncate the file.
		const tabId = openTab('first 50KB');
		tabManager.addTab('/notes/another.md', 'another');
		const transfer = makeTransfer();
		assert.equal(transfer.canTransfer(tabId), true);
		assert.equal(transfer.canDetach(tabId), true);
		tabManager.tabs.find((tab) => tab.id === tabId)!.isTruncated = true;
		assert.equal(transfer.canTransfer(tabId), false);
		assert.equal(transfer.canDetach(tabId), false);

		// The movers complete the buffer first, and stop when they cannot.
		const asked: string[] = [];
		let partial = 0;
		const movers = createTabMovers({
			ensureFullContent: async () => false,
			onPartialDocument: () => partial++,
			session: {
				detach: async (id) => (asked.push(`detach ${id}`), true),
				transfer: async (id) => (asked.push(`transfer ${id}`), true),
			},
		});
		assert.equal(await movers.handleDetach(tabId), false);
		assert.equal(await movers.moveTabToWindow(tabId, 'w2'), false);
		assert.deepEqual(asked, []);
		assert.equal(partial, 2);
	});

	test('moving to an existing window uses the acknowledged transfer protocol', async () => {
		respond = (cmd) => (cmd === 'stage_detached_tab' ? TOKEN : null);
		const tabId = openTab('doc');
		const { session } = makeSession();
		const movers = createTabMovers({ ensureFullContent: async () => true, onPartialDocument: () => {}, session });

		const moving = movers.moveTabToWindow(tabId, 'w2', true);
		await settle();
		const offer = calls.find((call) => call.cmd === 'offer_tab_to_window');
		assert.deepEqual(offer?.args, { targetLabel: 'w2', token: TOKEN });
		assert.equal(tabManager.tabs.length, 1, 'the source keeps the tab until the target acknowledges');

		emit('tab-transfer-claimed', TOKEN);
		assert.equal(await moving, true);
		assert.equal(tabManager.tabs.length, 0);
		assert.deepEqual(calls.find((call) => call.cmd === 'focus_window')?.args, { label: 'w2' });
	});
});
