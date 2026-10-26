import assert from 'node:assert/strict';

import { afterAll, beforeAll, describe, test } from 'vitest';

// Importing the store boots the settings singleton, which asks for the OS type.
(window as any).__TAURI_INTERNALS__ = {
	metadata: { currentWindow: { label: 'main' }, currentWebview: { windowLabel: 'main', label: 'main' } },
	invoke: (cmd: string) => Promise.resolve(cmd === 'get_os_type' ? 'macos' : null),
};

const { tabManager } = await import('../src/lib/stores/tabs.svelte.js');
const { settings } = await import('../src/lib/stores/settings.svelte.js');
const { createExternalChange } = await import('../src/lib/sessions/externalChange.svelte.js');
const { createViewMode } = await import('../src/lib/sessions/viewMode.svelte.js');
const { asBufferLine, lineCoordinates } = await import('../src/lib/utils/lineCoordinates.js');

type Tab = NonNullable<typeof tabManager.activeTab>;
type ViewModeOptions = Parameters<typeof createViewMode>[0];

// Issue #168, second report by @dayeggpi: "allow user to switch to rendered
// view without saving/creating file ... no way to see rendered view until file
// is saved".
//
// The cause was that reading mode was drawn from DISK: leaving the editor
// called `loadMarkdown(tab.path)`, so a dirty tab had to be flushed first —
// silently with auto-save on, through a modal otherwise — or the reader would
// have shown the pre-edit file. The modal was never protecting the buffer; the
// buffer survives a view toggle. It was protecting the screen from lying.
//
// Reading mode now renders the buffer.

/*
 * The viewer's view toggles and scroll sync, run through `sessions/viewMode`
 * against the real tab store and the real flush from `externalChange`. The
 * doubles are the backend (the file read, the Rust render, the disk) and the
 * two panes, whose measurements are not what these tests are about.
 */
describe('view mode without saving', () => {
	beforeAll(() => {
		(window as any).__TAURI_INTERNALS__ = {
			metadata: { currentWindow: { label: 'main' }, currentWebview: { windowLabel: 'main', label: 'main' } },
			invoke: () => Promise.reject(new Error('no invoke expected in these tests')),
		};
	});

	// `settings` is one store for the whole file: put back what this block changes.
	let settingsBefore: Pick<typeof settings, 'autoSave' | 'tocFollows' | 'previewCursor'>;
	beforeAll(() => {
		settingsBefore = { autoSave: settings.autoSave, tocFollows: settings.tocFollows, previewCursor: settings.previewCursor };
	});
	afterAll(() => {
		Object.assign(settings, settingsBefore);
	});

	type Fakes = {
		disk: Map<string, string>;
		/** What `read_file_content_checked` answers with besides the text. */
		lossy: boolean;
		encoding: string;
		saveCalls: string[];
		readCalls: string[];
		renderedFrom: string[];
		toasts: string[];
		saveFails: boolean;
		/** Text the "user" appends while the save is awaiting (TOCTOU). */
		typeDuringSave: string;
		fullContent: boolean;
	};

	/** The Rust render's stand-in: the output names what it was given. */
	const rendered = (raw: string) => `<html>${raw}</html>`;

	/** Three lines of front matter, so the two line numberings differ by 3. */
	const coords = lineCoordinates('---\na: 1\n---\n# body\n');

	/** A scroll-sync position in the body, at buffer line `line`. */
	const at = (line: number, ratio = 0.5) => ({ section: 'body' as const, ratio, line: asBufferLine(line) });

	function freshFakes(): Fakes {
		return {
			disk: new Map(),
			lossy: false,
			encoding: 'UTF-8',
			saveCalls: [],
			readCalls: [],
			renderedFrom: [],
			toasts: [],
			saveFails: false,
			typeDuringSave: '',
			fullContent: true,
		};
	}

	function buildViewMode(fakes: Fakes, panes: Partial<ViewModeOptions> = {}) {
		// Mirrors documentSession.saveContent for a tab that has a path.
		const saveSilently = async (tabId: string) => {
			fakes.saveCalls.push(tabId);
			const tab = tabManager.tabs.find((item) => item.id === tabId)!;
			if (fakes.saveFails) return false;
			const snapshot = tab.rawContent;
			await Promise.resolve();
			if (fakes.typeDuringSave) tab.rawContent = snapshot + fakes.typeDuringSave;
			fakes.disk.set(tab.path, snapshot);
			tab.originalContent = snapshot;
			return true;
		};
		const { flushBeforeLeavingEditableMode } = createExternalChange({
			tabManager,
			settings,
			documentSession: { saveContent: saveSilently, allowOverwriteOnce: () => {}, resolveExternalChange: async () => ({ action: 'ignore' as const }) },
			loadMarkdown: async () => {},
			canCloseTab: async () => true,
			readFile: async () => ['', false, 'UTF-8'],
			editorLanguageFor: () => 'markdown',
			addToast: (message: string) => void fakes.toasts.push(message),
			t: (key: string) => key,
		});
		return createViewMode({
			tabManager,
			settings,
			documentSession: { ensureFullContent: async () => fakes.fullContent },
			flushBeforeLeavingEditableMode,
			readFile: async (path: string) => {
				fakes.readCalls.push(path);
				return [fakes.disk.get(path) ?? '', fakes.lossy, fakes.encoding];
			},
			renderTabPreviewFromRaw: async (tab: Tab) => {
				fakes.renderedFrom.push(tab.rawContent);
				tabManager.updateTabContent(tab.id, rendered(tab.rawContent));
			},
			tick: async () => {},
			addToast: (message: string) => void fakes.toasts.push(message),
			t: (key: string) => key,
			// No panes unless a test asks: where the reader lands (#799) is not
			// what most of this file is about.
			editorPane: undefined,
			markdownBody: undefined,
			previewBlocks: undefined,
			lineCoords: coords,
			readRendererLine: () => '',
			getPreviewScrollSyncPosition: () => at(40),
			scrollPreviewToSyncPosition: () => {},
			getPreviewScrollAnchor: () => null,
			...panes,
		} as ViewModeOptions);
	}

	const ON_DISK = '# saved heading\n';
	const IN_BUFFER = '# saved heading\n\nan edit that was never written to disk\n';

	/**
	 * A tab holding unsaved edits to a real file, in whichever editable pane the
	 * caller names, with the file on disk still carrying the pre-edit text.
	 */
	function dirtyTab(mode: 'edit' | 'split', path = '/notes/note.md') {
		tabManager.closeAll();
		const fakes = freshFakes();
		fakes.disk.set(path, ON_DISK);
		tabManager.addTab(path);
		const tab = tabManager.activeTab!;
		tabManager.setTabRawContent(tab.id, ON_DISK);
		tab.isEditing = mode === 'edit';
		tabManager.setSplitEnabled(tab.id, mode === 'split');
		tabManager.updateTabRawContent(tab.id, IN_BUFFER);
		assert.equal(tab.isDirty, true, 'precondition: the tab is dirty');
		return { tab, fakes, viewMode: buildViewMode(fakes) };
	}

	/** A saved, clean file in reading mode whose buffer holds what the read left. */
	function readingTab(raw: string, path = '/notes/note.md') {
		tabManager.closeAll();
		tabManager.addTab(path);
		const tab = tabManager.activeTab!;
		tabManager.setTabRawContent(tab.id, raw);
		return tab;
	}

	// ------------------------------------------------------- leaving edit mode

	test('a dirty file switches to reading mode without a modal and without writing', async () => {
		settings.autoSave = false;
		const { tab, fakes, viewMode } = dirtyTab('edit');

		await viewMode.toggleEdit();

		assert.deepEqual(fakes.saveCalls, [], 'nothing is written to disk');
		assert.equal(fakes.disk.get(tab.path), ON_DISK, 'the file is untouched');
		assert.equal(tab.isEditing, false, 'the user actually reaches reading mode');
		assert.equal(tab.isDirty, true, 'the edits are still unsaved, and still flagged as such');
		assert.equal(tab.rawContent, IN_BUFFER, 'the buffer is intact');
	});

	test('reading mode shows the buffer, not the file', async () => {
		settings.autoSave = false;
		const { tab, viewMode, fakes } = dirtyTab('edit');

		await viewMode.toggleEdit();

		// The whole point of the bug: with a disk read here, this is `ON_DISK`.
		assert.equal(tab.content, rendered(IN_BUFFER));
		assert.deepEqual(fakes.renderedFrom, [IN_BUFFER], 'the preview is rendered once, from the buffer');
	});

	test('an untitled buffer never reaches the Save dialog on a view toggle', async () => {
		settings.autoSave = true;
		tabManager.closeAll();
		const fakes = freshFakes();
		tabManager.addTab('');
		const tab = tabManager.activeTab!;
		tab.isEditing = true;
		tabManager.updateTabRawContent(tab.id, '# untitled\n');

		await buildViewMode(fakes).toggleEdit();

		assert.deepEqual(fakes.saveCalls, [], 'saveContent would open the Save dialog for a pathless tab');
		assert.equal(tab.isEditing, false);
		assert.equal(tab.content, rendered('# untitled\n'));
	});

	test('auto-save still flushes on the way out, because the debounce is about to be dropped', async () => {
		// The auto-save effect requires `isEditing || isSplit`, so this is the last
		// chance to honour "save automatically" for these edits.
		settings.autoSave = true;
		const { tab, fakes, viewMode } = dirtyTab('edit');

		await viewMode.toggleEdit();

		assert.deepEqual(fakes.saveCalls, [tab.id]);
		assert.equal(fakes.disk.get(tab.path), IN_BUFFER, 'the flush actually wrote the buffer');
		assert.equal(tab.isDirty, false);
		assert.equal(tab.isEditing, false);
		assert.equal(tab.content, rendered(IN_BUFFER));
	});

	test('a file that cannot be written no longer traps the user in the editor', async () => {
		// Read-only path, or a buffer the lossy-decode guard refuses: saveContent
		// returns false forever, and the old code returned early on that, so
		// reading mode was unreachable for the life of the tab.
		settings.autoSave = true;
		const { tab, fakes, viewMode } = dirtyTab('edit');
		fakes.saveFails = true;

		await viewMode.toggleEdit();

		assert.deepEqual(fakes.saveCalls, [tab.id], 'the flush was attempted');
		assert.ok(fakes.toasts.includes('toast.autoSaveFailed'), 'and the failure was reported');
		assert.equal(tab.isEditing, false, 'but the view still switches');
		assert.equal(tab.content, rendered(IN_BUFFER));
		assert.equal(tab.isDirty, true, 'the buffer is still there to be rescued');
	});

	test('edits typed during the flush are shown, and reported as not yet on disk', async () => {
		settings.autoSave = true;
		const { tab, fakes, viewMode } = dirtyTab('edit');
		fakes.typeDuringSave = 'typed while saving\n';

		await viewMode.toggleEdit();

		assert.equal(tab.isDirty, true);
		assert.ok(fakes.toasts.includes('toast.savedNewerEdits'), 'the disk is one revision behind');
		assert.equal(tab.isEditing, false, 'the TOCTOU case is no longer a reason to stay in the editor');
		assert.equal(
			tab.content,
			rendered(IN_BUFFER + 'typed while saving\n'),
			'the preview shows the newest text, which is exactly what is NOT on disk',
		);
	});

	// --------------------------------------------------- closing the split view

	test('closing split view on a dirty file neither asks nor writes', async () => {
		settings.autoSave = false;
		const { tab, fakes, viewMode } = dirtyTab('split');

		await viewMode.toggleSplitView(tab.id);

		assert.deepEqual(fakes.saveCalls, []);
		assert.equal(fakes.disk.get(tab.path), ON_DISK, 'the file is untouched');
		assert.equal(tab.isSplit, false);
		assert.equal(tab.isDirty, true);
		assert.equal(tab.content, rendered(IN_BUFFER), 'the surviving pane keeps showing the buffer');
	});

	test('closing split view honours auto-save the same way leaving edit mode does', async () => {
		settings.autoSave = true;
		const { tab, fakes, viewMode } = dirtyTab('split');

		await viewMode.toggleSplitView(tab.id);

		assert.deepEqual(fakes.saveCalls, [tab.id]);
		assert.equal(tab.isSplit, false);
		assert.equal(tab.content, rendered(IN_BUFFER));
	});

	test('the view toggles no longer re-read the file to leave an editable pane', async () => {
		settings.autoSave = false;
		const edit = dirtyTab('edit');
		await edit.viewMode.toggleEdit();
		assert.deepEqual(edit.fakes.readCalls, [], 'leaving the editor read the file');

		const split = dirtyTab('split');
		await split.viewMode.toggleSplitView(split.tab.id);
		assert.deepEqual(split.fakes.readCalls, [], 'closing the split read the file');
		assert.equal(split.tab.rawContent, IN_BUFFER);
	});

	// ------------------------------------------- entering an editable pane (#379)

	test('entering the editor reads the fidelity and stores it', async () => {
		// The buffer is about to be handed to the editor, which arms auto-save:
		// the tab must carry the verdict of this read, not one a load left behind.
		const tab = readingTab('# stale\n');
		tabManager.setTabDecodedLossy(tab.id, false);
		const fakes = freshFakes();
		fakes.disk.set(tab.path, '# caf�\n');
		fakes.lossy = true;
		fakes.encoding = 'windows-1252';

		await buildViewMode(fakes).toggleEdit();

		assert.deepEqual(fakes.readCalls, [tab.path]);
		assert.equal(tab.isEditing, true);
		assert.equal(tab.hasReplacementChars, true, 'the lossy decode was not recorded on the tab');
		assert.equal(tab.encoding, 'windows-1252');
		assert.equal(tab.rawContent, '# caf�\n');
	});

	test('entering split view reads the fidelity and stores it', async () => {
		// An empty buffer (a restored tab not read yet) is read before the split
		// opens, and that read decides the flag too.
		const tab = readingTab('');
		tabManager.setTabDecodedLossy(tab.id, false);
		const fakes = freshFakes();
		fakes.disk.set(tab.path, '# caf�\n');
		fakes.lossy = true;
		fakes.encoding = 'windows-1252';

		await buildViewMode(fakes).toggleSplitView(tab.id);

		assert.deepEqual(fakes.readCalls, [tab.path]);
		assert.equal(tab.isSplit, true);
		assert.equal(tab.hasReplacementChars, true, 'the lossy decode was not recorded on the tab');
		assert.equal(tab.encoding, 'windows-1252');
		assert.equal(tab.rawContent, '# caf�\n');
	});

	test('entering split view completes a partial buffer instead of trusting it', async () => {
		// The old guard was `!tab.rawContent`, which a partial buffer satisfies:
		// split view opened on the truncated text, the first keystroke made it
		// dirty, and auto-save wrote it back 1.5s later.
		const partial = readingTab('# the first 50KB\n');
		const fakes = freshFakes();
		fakes.fullContent = false;

		await buildViewMode(fakes).toggleSplitView(partial.id);

		assert.equal(partial.isSplit, false, 'split view opened over a buffer that could not be completed');
		assert.deepEqual(fakes.toasts, ['toast.partialDocument']);

		// The empty-buffer read goes through the store, so a tab restored empty
		// and flagged partial stops being flagged once the file is in.
		const unread = readingTab('');
		tabManager.markTabContentUnavailable(unread.id);
		assert.equal(unread.isTruncated, true, 'precondition: an unread tab is partial');
		const reads = freshFakes();
		reads.disk.set(unread.path, '# whole file\n');

		await buildViewMode(reads).toggleSplitView(unread.id);

		assert.equal(unread.isSplit, true);
		assert.equal(unread.rawContent, '# whole file\n');
		assert.equal(unread.isTruncated, false, 'the read left the tab flagged partial');
	});

	// ------------------------------------------------ where the reader lands (#799)

	test('Ctrl+E hands each pane the line the other one was showing', async () => {
		settings.autoSave = false;
		const { tab, fakes } = dirtyTab('edit');
		const fromEditor = at(120, 0.4);
		const fromPreview = at(300, 0.7);
		const synced: unknown[] = [];
		const restored: unknown[] = [];
		const viewMode = buildViewMode(fakes, {
			editorPane: {
				scrollSyncPosition: () => fromEditor,
				syncScrollToPosition: (position) => void synced.push(position),
				setCursor: () => {},
			},
			markdownBody: document.createElement('article'),
			getPreviewScrollSyncPosition: () => fromPreview,
			scrollPreviewToSyncPosition: (position) => void restored.push(position),
		});

		await viewMode.toggleEdit();
		await Promise.resolve();
		assert.equal(tab.isEditing, false);
		assert.deepEqual(restored, [fromEditor], 'the preview was not sent to the editor\'s line');

		await viewMode.toggleEdit();
		assert.equal(tab.isEditing, true);
		assert.deepEqual(synced, [fromPreview], 'the editor was not sent to the preview\'s line');
	});

	test('Ctrl+E brings the cursor on screen only when the outline follows it', async () => {
		// An outline marking the cursor's heading while the editor shows another
		// one reads as wrong, so with 'cursor' the handoff moves a cursor left off
		// screen. With 'scroll' the outline never looks at the cursor, and moving
		// it would only lose the reader's place.
		const asked: unknown[] = [];
		try {
			for (const follows of ['cursor', 'scroll'] as const) {
				settings.tocFollows = follows;
				const { tab, fakes } = dirtyTab('edit');
				tab.isEditing = false;
				await buildViewMode(fakes, {
					editorPane: {
						syncScrollToPosition: (_position, options) => void asked.push(options),
						scrollSyncPosition: () => null,
						setCursor: () => {},
					},
					markdownBody: document.createElement('article'),
				}).toggleEdit();
			}
		} finally {
			settings.tocFollows = 'scroll';
		}
		assert.deepEqual(asked, [{ cursorIntoView: true }, { cursorIntoView: false }]);
	});

	// Scroll sync is split view's. The tab keeps `isScrollSynced` after the split
	// closes, and out of split the other pane is still mounted at zero width, so
	// syncing through it dragged the visible pane off its line on every Ctrl+E.
	test('scroll sync left on in split view stays off once the split closes', () => {
		tabManager.closeAll();
		tabManager.addTab('/notes/note.md');
		const tab = tabManager.activeTab!;
		tabManager.setSplitEnabled(tab.id, true);
		if (!tab.isScrollSynced) tabManager.toggleScrollSync(tab.id);
		const toPreview: unknown[] = [];
		const toEditor: unknown[] = [];
		const viewMode = buildViewMode(freshFakes(), {
			scrollPreviewToSyncPosition: (position) => void toPreview.push(position),
			editorPane: {
				syncScrollToPosition: (position) => void toEditor.push(position),
				scrollSyncPosition: () => null,
				setCursor: () => {},
			},
		});
		const position = at(40);
		const preview = document.createElement('article');

		viewMode.handleEditorScrollSync(position);
		viewMode.syncEditorToPreviewScroll(preview);
		assert.equal(toPreview.length, 1, 'precondition: split view syncs the preview');
		assert.equal(toEditor.length, 1, 'precondition: split view syncs the editor');

		tabManager.setSplitEnabled(tab.id, false);
		tab.isEditing = true;
		assert.equal(tab.isScrollSynced, true, 'the tab still remembers the choice');

		viewMode.handleEditorScrollSync(position);
		viewMode.syncEditorToPreviewScroll(preview);
		assert.equal(toPreview.length, 1, 'the hidden preview was scrolled from the editor');
		assert.equal(toEditor.length, 1, 'the editor was scrolled from the hidden preview');
		// Editor top line 40 is anchor line 42 in the buffer, 39 in the body.
		assert.equal(viewMode.tocActiveLine, 39, 'the outline still follows the editor');
	});

	test('leaving the editor moves the outline to the line the preview lands on', async () => {
		tabManager.closeAll();
		tabManager.addTab('/notes/note.md');
		const tab = tabManager.activeTab!;
		tab.isEditing = false;
		const viewMode = buildViewMode(freshFakes(), {
			markdownBody: document.createElement('article'),
			getPreviewScrollAnchor: () => 57 as never,
		});

		await viewMode.restoreAfterLeavingEditor(tab.id, at(58));

		assert.equal(tab.anchorLine, 57);
		assert.equal(viewMode.tocActiveLine, 57, 'the outline kept the entry from before the switch');
	});

	// #799: "the table of contents should follow the cursor". An editor setting,
	// because only the editor has one: the preview alone always follows the scroll.
	describeOutlineSource('cursor', true, (v) => {
		v.handleEditorCursor(20 as never, 1);
		assert.equal(v.tocActiveLine, 17, 'the cursor line, in the outline\'s numbering');
		v.handleEditorScrollSync(at(60));
		assert.equal(v.tocActiveLine, 17, 'scrolling the editor left it on the cursor');
		v.handleEditorCursor(30 as never, 1);
		assert.equal(v.tocActiveLine, 27);
	});

	describeOutlineSource('cursor', false, async (v) => {
		v.handleEditorCursor(20 as never, 1);
		assert.equal(v.tocActiveLine, null, 'no editor on screen, so no cursor to follow');
		await v.restoreAfterLeavingEditor(tabManager.activeTab!.id, at(58));
		assert.equal(v.tocActiveLine, 57, 'the preview alone follows its scroll');
	});

	describeOutlineSource('scroll', true, (v) => {
		v.handleEditorCursor(20 as never, 1);
		assert.equal(v.tocActiveLine, null, 'the default ignores the cursor');
		v.handleEditorScrollSync(at(60));
		assert.equal(v.tocActiveLine, 59);
		// The editor alone keeps the preview mounted at zero width, and its
		// scroll events put the outline on a heading from that layout.
		v.followToc('preview', 90 as never);
		assert.equal(v.tocActiveLine, 59, 'the hidden preview moved the outline');
	});

	function describeOutlineSource(
		follows: 'cursor' | 'scroll',
		editorOnScreen: boolean,
		run: (viewMode: ReturnType<typeof buildViewMode>) => void | Promise<void>,
	) {
		test(`the outline follows the ${follows} setting with the editor ${editorOnScreen ? 'on' : 'off'} screen`, async () => {
			tabManager.closeAll();
			tabManager.addTab('/notes/note.md');
			tabManager.activeTab!.isEditing = editorOnScreen;
			settings.tocFollows = follows;
			try {
				await run(buildViewMode(freshFakes(), {
					markdownBody: document.createElement('article'),
					getPreviewScrollAnchor: () => 57 as never,
				}));
			} finally {
				settings.tocFollows = 'scroll';
			}
		});
	}

	test('the preview does not move the outline after Ctrl+E until it is placed', async () => {
		// Its scroll events before that report the old position, and the outline
		// flashed the first headings until the preview was placed.
		settings.autoSave = false;
		const { tab, fakes } = dirtyTab('edit');
		let place!: () => void;
		let ticks = 0;
		const viewMode = buildViewMode(fakes, {
			editorPane: {
				scrollSyncPosition: () => at(58),
				syncScrollToPosition: () => {},
				setCursor: () => {},
			},
			markdownBody: document.createElement('article'),
			getPreviewScrollAnchor: () => 57 as never,
			// The restore waits for the render's flush; hold that one back.
			tick: () => (++ticks === 1 ? new Promise<void>((resolve) => (place = resolve)) : Promise.resolve()),
		});

		viewMode.handleEditorScrollSync(at(40));
		assert.equal(viewMode.tocActiveLine, 39);
		await viewMode.toggleEdit();
		assert.equal(tab.isEditing, false);
		viewMode.followToc('preview', 2 as never);
		assert.equal(viewMode.tocActiveLine, 39, 'an unplaced preview put the outline on its own line');

		place();
		await new Promise((resolve) => setTimeout(resolve, 0));
		assert.equal(viewMode.tocActiveLine, 57, 'the placed preview decides');
		viewMode.followToc('preview', 60 as never);
		assert.equal(viewMode.tocActiveLine, 60, 'and keeps deciding once placed');
	});

	test('reading with a cursor placed, the outline stays on it only while the preview draws it', () => {
		/** A reading tab whose editor left its cursor on buffer line 20. */
		const withCursor = () => {
			tabManager.closeAll();
			tabManager.addTab('/notes/note.md');
			const tab = tabManager.activeTab!;
			tab.isEditing = true;
			const viewMode = buildViewMode(freshFakes());
			viewMode.handleEditorCursor(20 as never, 3);
			tab.isEditing = false;
			return viewMode;
		};
		settings.tocFollows = 'cursor';
		try {
			settings.previewCursor = true;
			const drawn = withCursor();
			drawn.followToc('cursor', 17 as never);
			drawn.followToc('preview', 90 as never);
			assert.equal(drawn.tocActiveLine, 17, 'the preview scroll moved the outline off the drawn cursor');

			// Off, the editor's last cursor is still there for Ctrl+E, but the
			// preview shows nothing, so an outline pinned to it would look stuck.
			settings.previewCursor = false;
			const hidden = withCursor();
			hidden.followToc('cursor', 17 as never);
			hidden.followToc('preview', 90 as never);
			assert.equal(hidden.tocActiveLine, 90, 'the outline stayed on a cursor the preview does not show');

			settings.previewCursor = true;
			tabManager.closeAll();
			tabManager.addTab('/notes/note.md');
			const without = buildViewMode(freshFakes());
			without.followToc('preview', 90 as never);
			assert.equal(without.tocActiveLine, 90, 'with no cursor yet, the outline follows the scroll');
		} finally {
			settings.tocFollows = 'scroll';
			settings.previewCursor = false;
		}
	});

	test('a click in the preview places the cursor only with its setting on, whatever the outline follows', () => {
		// #799: the shared cursor is an editing aid in its own right, so Ctrl+E
		// lands on the clicked character in either outline mode. The drawn caret
		// is visual noise to some readers, so the whole aid is off by default.
		const root = document.createElement('div');
		root.innerHTML = '<p data-sourcepos="2:1-2:11">hello world</p>';
		const text = root.querySelector('p')!.firstChild!;
		(document as any).caretRangeFromPoint = () => {
			const range = document.createRange();
			range.setStart(text, 6);
			return range;
		};
		const click = () => {
			tabManager.closeAll();
			tabManager.addTab('/notes/note.md');
			const viewMode = buildViewMode(freshFakes(), {
				previewBlocks: root,
				readRendererLine: (line) => (line === 2 ? 'hello world' : ''),
			});
			viewMode.placePreviewCursor({ detail: 1, clientX: 0, clientY: 0 } as MouseEvent);
			return viewMode;
		};
		try {
			settings.tocFollows = 'cursor';
			const off = click();
			assert.equal(off.activeCursor, null, 'off by default: the click leaves the cursor alone');
			assert.equal(off.tocActiveLine, null);

			settings.previewCursor = true;
			for (const follows of ['scroll', 'cursor'] as const) {
				settings.tocFollows = follows;
				const viewMode = click();
				// Body line 2 is buffer line 5 under three lines of front matter.
				assert.deepEqual(viewMode.activeCursor, { line: 5, column: 7 }, `${follows}: the click placed the cursor on the "w"`);
				assert.equal(viewMode.tocActiveLine, follows === 'cursor' ? 2 : null, `${follows}: the outline`);
			}
		} finally {
			settings.tocFollows = 'scroll';
			settings.previewCursor = false;
			delete (document as any).caretRangeFromPoint;
		}
	});
});
