import assert from 'node:assert/strict';

import { afterEach, beforeAll, describe, test } from 'vitest';

// Importing the store boots the settings singleton, which asks for the OS type.
(window as any).__TAURI_INTERNALS__ = {
	metadata: { currentWindow: { label: 'main' }, currentWebview: { windowLabel: 'main', label: 'main' } },
	invoke: (cmd: string) => Promise.resolve(cmd === 'get_os_type' ? 'macos' : null),
};

const { tabManager } = await import('../src/lib/stores/tabs.svelte.js');
const { settings } = await import('../src/lib/stores/settings.svelte.js');
const { createViewMode } = await import('../src/lib/sessions/viewMode.svelte.js');
const { createColdEnrichmentRestore } = await import('../src/lib/sessions/coldEnrichmentRestore.js');
const { asBufferLine, EDITOR_ANCHOR_LINE_OFFSET, lineCoordinates } = await import('../src/lib/utils/lineCoordinates.js');

type Tab = NonNullable<typeof tabManager.activeTab>;
type ViewModeOptions = Parameters<typeof createViewMode>[0];

beforeAll(() => {
	(window as any).__TAURI_INTERNALS__ = {
		metadata: { currentWindow: { label: 'main' }, currentWebview: { windowLabel: 'main', label: 'main' } },
		invoke: () => Promise.reject(new Error('no invoke expected in these tests')),
	};
});

afterEach(() => {
	window.getSelection()?.removeAllRanges();
	document.body.innerHTML = '';
});

/** Three lines of front matter: renderer line N is buffer line N + 3. */
const FRONT_MATTER = 3;
const coords = lineCoordinates('---\na: 1\n---\n# body\n');

/*
 * "Edit this fragment": the context menu's Edit, ⌘E and the title bar's Edit
 * button, run through `sessions/viewMode` against the real tab store and a
 * real jsdom selection. The doubles are the file read and the render.
 */
describe('jump to the selected fragment', () => {
	type Fakes = { readCalls: string[]; readFails: boolean; duringRead: () => void };

	function build(fakes: Fakes) {
		return createViewMode({
			tabManager,
			settings,
			documentSession: { ensureFullContent: async () => true },
			flushBeforeLeavingEditableMode: async () => {},
			readFile: async (path: string) => {
				fakes.readCalls.push(path);
				fakes.duringRead();
				if (fakes.readFails) throw new Error('No such file or directory (os error 2)');
				return ['---\na: 1\n---\n# body\n', false, 'UTF-8'];
			},
			renderTabPreviewFromRaw: async () => {},
			tick: async () => {},
			addToast: () => {},
			t: (key: string) => key,
			editorPane: undefined,
			markdownBody: undefined,
			previewBlocks: undefined,
			lineCoords: coords,
			readRendererLine: () => '',
			getPreviewScrollSyncPosition: () => ({ section: 'body', ratio: 0 }),
			scrollPreviewToSyncPosition: () => {},
			getPreviewScrollAnchor: () => null,
		} as ViewModeOptions);
	}

	/** A saved, clean file in the given mode, and a preview with two blocks. */
	function setup(mode: 'read' | 'edit' | 'split' | 'edit+split') {
		tabManager.closeAll();
		tabManager.addTab('/notes/note.md');
		const tab = tabManager.activeTab!;
		tabManager.setTabRawContent(tab.id, '---\na: 1\n---\n# body\n');
		tab.isEditing = mode === 'edit' || mode === 'edit+split';
		tabManager.setSplitEnabled(tab.id, mode === 'split' || mode === 'edit+split');
		document.body.innerHTML =
			'<article><p id="first" data-sourcepos="1:1-1:9">first block</p>' +
			'<p id="picked" data-sourcepos="7:4-9:3">the <em>picked</em> fragment</p></article>';
		const fakes: Fakes = { readCalls: [], readFails: false, duringRead: () => {} };
		return { tab, fakes, viewMode: build(fakes) };
	}

	const select = (id: string) => window.getSelection()!.selectAllChildren(document.getElementById(id)!);
	const rightClickOn = (id: string) => ({ target: document.getElementById(id)!.firstChild }) as unknown as MouseEvent;

	/** `picked` is renderer lines 7–9, so buffer lines 10–12. */
	const PICKED = { startLine: 7 + FRONT_MATTER, endLine: 9 + FRONT_MATTER };

	test('the Edit entry resolves its target while the selection still exists', async () => {
		const { tab, viewMode } = setup('read');
		select('picked');

		// The menu opens on the right-click; the reader then clicks "Edit", and
		// that click is what clears the selection.
		const edit = viewMode.editSourceRangeAt(rightClickOn('first'));
		window.getSelection()!.removeAllRanges();
		await edit();

		assert.equal(tab.isEditing, true);
		assert.deepEqual(viewMode.pendingEditReveal, PICKED, 'the editor opens on the selection, not on what is under the pointer');
	});

	test('Edit with a target never leaves edit mode', async () => {
		// In split view the editor is already on screen, and "edit this
		// fragment" is the one thing that cannot mean "close the editor".
		const { tab, fakes, viewMode } = setup('edit+split');

		await viewMode.editSourceRange({ startLine: 7, endLine: 9 } as never);

		assert.equal(tab.isEditing, true, 'still editing');
		assert.equal(tab.isSplit, true, 'and the layout is unchanged');
		assert.deepEqual(fakes.readCalls, [], 'no mode change, so no read');
		assert.deepEqual(viewMode.pendingEditReveal, PICKED);
	});

	test('a jump whose read failed is not armed for the next document', async () => {
		const { tab, fakes, viewMode } = setup('read');
		fakes.readFails = true;

		await viewMode.editSourceRange({ startLine: 7, endLine: 9 } as never);

		assert.equal(tab.isEditing, false, 'the failed read leaves the tab in reading mode');
		assert.equal(viewMode.pendingEditReveal, null, 'and nothing waits to fire at whatever is edited next');
	});

	test('the target is a source range and never a column', async () => {
		// `data-sourcepos="7:4-9:3"` carries columns; the jump selects whole
		// lines, and the editor is never aimed with the `:col` half.
		const { viewMode } = setup('read');

		assert.deepEqual(viewMode.getContextMenuSourceRange(rightClickOn('picked')), { startLine: 7, endLine: 9 });
		await viewMode.editSourceRangeAt(rightClickOn('picked'))();

		assert.deepEqual(viewMode.pendingEditReveal, PICKED);
		assert.deepEqual(Object.keys(viewMode.pendingEditReveal!).sort(), ['endLine', 'startLine']);
	});

	test('every renderer line reaching the editor goes through the shift', async () => {
		// The context menu's target, ⌘E's selection: both are renderer lines off
		// `data-sourcepos`, and the editor counts the front matter too.
		const viaMenu = setup('read');
		await viaMenu.viewMode.editSourceRangeAt(rightClickOn('first'))();
		assert.deepEqual(viaMenu.viewMode.pendingEditReveal, { startLine: 1 + FRONT_MATTER, endLine: 1 + FRONT_MATTER });

		const viaChord = setup('read');
		select('picked');
		await viaChord.viewMode.toggleEditView();
		assert.deepEqual(viaChord.viewMode.pendingEditReveal, PICKED);
	});

	test('the selection is read before anything switches mode', async () => {
		// Entering the editor takes the reader's focus, and with it the
		// preview's selection. Read after that, ⌘E would answer for nothing.
		const { tab, fakes, viewMode } = setup('read');
		select('picked');
		fakes.duringRead = () => window.getSelection()!.removeAllRanges();

		await viewMode.toggleEditView();

		assert.equal(tab.isEditing, true);
		assert.deepEqual(viewMode.pendingEditReveal, PICKED);
	});

	test("the title bar's Edit button means what ⌘E means", async () => {
		// From reading mode, Edit with a selection opens the editor on it, the
		// same as the chord and the context menu.
		const { tab, viewMode } = setup('read');
		select('picked');

		await viewMode.setViewMode('edit');

		assert.equal(tab.isEditing, true);
		assert.deepEqual(viewMode.pendingEditReveal, PICKED);
	});

	test('split view with nothing selected is deliberately inert', async () => {
		// The editor is already on screen, so the ability ⌘E asks for is already
		// granted; with no selection there is nothing to travel to either.
		const { tab, fakes, viewMode } = setup('split');

		await viewMode.toggleEditView();

		assert.equal(tab.isSplit, true, 'the chord never changes the layout');
		assert.equal(tab.isEditing, false);
		assert.deepEqual(fakes.readCalls, []);
		assert.equal(viewMode.pendingEditReveal, null);
	});
});

describe('the outline is fed body lines from both panes', () => {
	test("the editor's scroll moves the outline in body lines", () => {
		tabManager.closeAll();
		tabManager.addTab('/notes/note.md');
		const tab = tabManager.activeTab!;
		tab.isEditing = true;
		const before = settings.tocFollows;
		settings.tocFollows = 'scroll';
		try {
			const viewMode = createViewMode({
				tabManager,
				settings,
				lineCoords: coords,
				scrollPreviewToSyncPosition: () => {},
			} as unknown as ViewModeOptions);

			// Monaco's top line is buffer line 20; the tab would record the line
			// `EDITOR_ANCHOR_LINE_OFFSET` below it, counted from the body.
			viewMode.handleEditorScrollSync({ section: 'body', ratio: 0.5, line: asBufferLine(20) });

			assert.equal(viewMode.tocActiveLine, 20 + EDITOR_ANCHOR_LINE_OFFSET - FRONT_MATTER);
		} finally {
			settings.tocFollows = before;
		}
	});
});

/*
 * The cold start: the rich-content libraries arrive after the document is
 * already in the preview and after the position has been restored against it,
 * and the enrichment moves the text by up to 812px (measured in Chromium; see
 * the patch effect in MarkdownViewer.svelte). The second restore runs once per
 * host, after the enrichment, for the tab still on screen.
 */
describe('a cold start restores again once its enrichment has landed', () => {
	function deferred() {
		let resolve!: () => void;
		const promise = new Promise<void>((r) => (resolve = r));
		return { promise, resolve };
	}
	const settle = async () => {
		for (let i = 0; i < 5; i++) await Promise.resolve();
	};

	function setup() {
		tabManager.closeAll();
		tabManager.addTab('/notes/a.md');
		tabManager.addTab('/notes/b.md');
		const body = document.createElement('article');
		const restored: string[] = [];
		const coldRestore = createColdEnrichmentRestore({
			tabManager,
			tick: async () => {},
			markdownBody: body,
			restore: (_body: HTMLElement, tab: Tab) => void restored.push(tab.path),
		});
		return { body, restored, coldRestore };
	}

	test("a host's first enrichment restores after it lands", async () => {
		const { body, restored, coldRestore } = setup();
		const enrichment = deferred();

		coldRestore.afterEnrichment(body, 3, enrichment.promise);
		await settle();
		assert.deepEqual(restored, [], 'not before the layout has changed');

		enrichment.resolve();
		await settle();
		assert.deepEqual(restored, [tabManager.activeTab!.path]);
	});

	test('later patches of the same host do not move the reader', async () => {
		const { body, restored, coldRestore } = setup();

		coldRestore.afterEnrichment(body, 3, Promise.resolve());
		await settle();
		coldRestore.afterEnrichment(body, 2, Promise.resolve());
		await settle();

		assert.equal(restored.length, 1, 'only the first enrichment of a host restores');
	});

	test('a patch that inserted nothing is not a cold start', async () => {
		const { body, restored, coldRestore } = setup();

		coldRestore.afterEnrichment(body, 0, Promise.resolve());
		await settle();

		assert.deepEqual(restored, []);
	});

	test('a tab switch during the enrichment cancels the restore', async () => {
		const { body, restored, coldRestore } = setup();
		const enrichment = deferred();

		coldRestore.afterEnrichment(body, 3, enrichment.promise);
		tabManager.setActive(tabManager.tabs[0].id);
		enrichment.resolve();
		await settle();

		assert.deepEqual(restored, [], "another tab's position is never restored into the article");
	});
});
