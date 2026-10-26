import { afterAll, beforeAll, describe, test } from 'vitest';
import assert from 'node:assert/strict';
import { asRendererLine } from '../src/lib/utils/lineCoordinates.js';
import { exportAsHtml } from '../src/lib/utils/export.js';
import { canExportTab } from '../src/lib/utils/tabFileActions.js';
import { refreshesPreviewCache } from '../src/lib/utils/previewRefresh.js';

describe('rendered HTML field', () => {
	// ---------------------------------------------------------------- environment
	// The runes are the compiler's, not ours: vitest builds `.svelte.ts` through the
	// Svelte plugin, so the store and the session run under real reactivity, and jsdom
	// supplies `window` and `localStorage`. Only the Tauri backend is stubbed, and it
	// has to be in place before the stores are imported, so both happen in beforeAll.
	let tabManager: (typeof import('../src/lib/stores/tabs.svelte.js'))['tabManager'];
	let settings: (typeof import('../src/lib/stores/settings.svelte.js'))['settings'];
	const commands: string[] = [];

	beforeAll(async () => {
		(window as any).__TAURI_INTERNALS__ = {
			metadata: { currentWindow: { label: 'main' }, currentWebview: { windowLabel: 'main', label: 'main' } },
			invoke: (cmd: string) => {
				commands.push(cmd);
				// The save dialog answers "cancelled": asking it is all exportWouldRun reads.
				return Promise.resolve(cmd === 'get_os_type' ? 'macos' : null);
			},
		};
		({ tabManager } = await import('../src/lib/stores/tabs.svelte.js'));
		({ settings } = await import('../src/lib/stores/settings.svelte.js'));
	});

	afterAll(() => {
		delete (window as any).__TAURI_INTERNALS__;
	});

	// ----------------------------------------------------------------- fixtures

	function reset() {
		tabManager.closeAll();
		localStorage.clear();
		settings.showToc = false;
		settings.newFileDefaultMode = true;
	}

	test('the preview HTML cache is not refreshed while editing with the TOC closed', () => {
		// Ctrl+T, then type: an untitled buffer being edited, TOC closed, not split.
		// The premise of the bug, taken from the shipping condition rather than
		// asserted by hand. Without this, a repro would be a test fixture choosing
		// its own outcome.
		reset();
		tabManager.addNewTab();
		const tab = tabManager.activeTab!;
		tab.isEditing = true;
		tabManager.updateTabRawContent(tab.id, '# notes\n\nsomething worth exporting\n');

		assert.equal(tab.isSplit, false);
		assert.equal(refreshesPreviewCache(tab, tab.isEditing, settings.showToc), false, 'nothing re-renders tab.content in this state');
		assert.equal(tab.content, '', 'so the rendered-HTML cache is still empty');
		assert.notEqual(tab.rawContent, '', 'while the document itself is not');
	});

	// ------------------------------------------------- addTab's Markdown argument
	//
	// The same three fields, confused in the other direction. `addTab(path,
	// content = '')` assigned its argument to `content`, `rawContent` AND
	// `originalContent` — coherent when they were one field, but it meant the
	// signature accepted Markdown into the field that is injected via {@html}.
	// Both callers in the app pass `''`, so nothing shipped broken; the ~25 test
	// callers that pass real Markdown are what says the argument is the buffer.

	test('addTab puts its argument in the buffer, not in the rendered-HTML field', () => {
		reset();
		const markdown = '# heading\n\n<script>alert(1)</script>\n';
		tabManager.addTab('/notes/a.md', markdown);
		const tab = tabManager.activeTab!;

		assert.equal(tab.rawContent, markdown, 'the argument is the Markdown buffer');
		assert.equal(tab.originalContent, markdown, 'and the saved baseline, so the tab opens clean');
		assert.equal(tab.isDirty, false);
		assert.equal(
			tab.content,
			'',
			'the rendered-HTML field starts empty and is filled by the first render, as at every other ' +
				'Tab construction site — seeding it here routes Markdown into the {@html} sink',
		);
	});

	test('every Tab construction site starts the rendered-HTML field empty', () => {
		// The invariant the fix restores. `updateTabContent` is the only writer.
		reset();
		// restoreState REPLACES the tab list, so it goes first.
		tabManager.restoreState(JSON.stringify({ tabs: [{ path: '/notes/b.md', title: 'b.md' }] }));
		tabManager.addTab('/notes/a.md', '# a\n');
		tabManager.addNewTab();
		tabManager.addHomeTab();
		tabManager.insertTransferredTab({
			path: '/notes/c.md',
			title: 'c.md',
			rawContent: '# c\n',
			originalContent: '# c\n',
			scrollTop: 0,
			isDirty: false,
			isEditing: false,
			history: ['/notes/c.md'],
			historyIndex: 0,
			scrollPercentage: 0,
			anchorLine: asRendererLine(0),
			isSplit: false,
			splitRatio: 0.5,
			isScrollSynced: false,
			hasReplacementChars: false,
			encoding: 'UTF-8',
		});

		assert.equal(tabManager.tabs.length, 5, 'precondition: every construction site produced a tab');
		for (const tab of tabManager.tabs) {
			assert.equal(tab.content, '', `${tab.path || tab.title} was constructed with a non-empty content field`);
		}
	});

	// ------------------------------------------------------- the Home menu's export
	//
	// The menu used to gate on `content`, the rendered-preview HTML, which is
	// still empty for a new file edited with the TOC closed: it hid an export
	// that would have produced a file. It now asks the buffer, as the exports do.

	test('an untitled buffer being edited is offered the export commands', () => {
		reset();
		tabManager.addNewTab();
		const tab = tabManager.activeTab!;
		tab.isEditing = true;
		tabManager.updateTabRawContent(tab.id, '# notes\n\nsomething worth exporting\n');
		assert.equal(tab.content, '', 'precondition: nothing has rendered this buffer');

		assert.equal(canExportTab(tabManager.activeTab), true, 'the Home menu hid the exports for a document that exports fine');
	});

	test('a window with no tab at all offers no export', () => {
		reset();

		assert.equal(canExportTab(tabManager.activeTab), false);
	});

	test('a saved file is offered the export commands', () => {
		reset();
		tabManager.addTab('/notes/a.md');
		tabManager.setTabRawContent(tabManager.activeTab!.id, '# a\n');

		assert.equal(canExportTab(tabManager.activeTab), true);
	});

	test('a saved file with an empty buffer is offered nothing to export', () => {
		// A saved empty file, or a tab whose read has not landed yet. The menu used
		// to list the exports on the path alone, so Export as HTML then did nothing
		// and Export as PDF printed a blank page.
		reset();
		tabManager.addTab('/notes/a.md');
		tabManager.updateTabContent(tabManager.activeTab!.id, '<p>a stale render</p>');
		assert.equal(tabManager.activeTab!.rawContent, '', 'precondition: the buffer is empty');

		assert.equal(canExportTab(tabManager.activeTab), false);
	});

	/** Whether Export as HTML, given the active tab, would go as far as asking where to save. */
	async function exportWouldRun(): Promise<boolean> {
		const tab = tabManager.activeTab;
		if (!tab) return false;
		commands.length = 0;
		await exportAsHtml({ rawContent: tab.rawContent, tabPath: tab.path, tabTitle: tab.title } as Parameters<typeof exportAsHtml>[0]);
		return commands.includes('plugin:dialog|save');
	}

	function untitledBufferBeingEdited(text = '# notes\n\nsomething worth exporting\n') {
		reset();
		tabManager.addNewTab();
		const tab = tabManager.activeTab!;
		tab.isEditing = true;
		tabManager.updateTabRawContent(tab.id, text);
		return tab;
	}

	test('the menu is never stricter than the export it fronts', async () => {
		// The invariant behind the fix, over the states a tab can be in. Being
		// STRICTER is the defect this test is for; being looser is pinned by the
		// empty-buffer tests.
		const states: Array<[string, () => void]> = [
			['untitled, edited, TOC closed', () => void untitledBufferBeingEdited()],
			['untitled, edited, TOC open', () => { untitledBufferBeingEdited(); settings.showToc = true; }],
			['untitled, split view', () => tabManager.setSplitEnabled(untitledBufferBeingEdited().id, true)],
			['untitled, reading mode', () => { untitledBufferBeingEdited().isEditing = false; }],
			[
				'saved file, edited, TOC closed',
				() => {
					reset();
					tabManager.addTab('/notes/a.md');
					const tab = tabManager.activeTab!;
					tabManager.setTabRawContent(tab.id, '# a\n');
					tab.isEditing = true;
				},
			],
		];

		const hidden: string[] = [];
		for (const [name, arrange] of states) {
			arrange();
			const offered = canExportTab(tabManager.activeTab);
			if ((await exportWouldRun()) && !offered) hidden.push(name);
		}
		assert.deepEqual(hidden, [], 'the export is possible in these states and the menu hides it');
	});

	test('an empty untitled buffer is offered nothing to export', async () => {
		// A gate that simply always returned true would pass the test above.
		reset();
		tabManager.addNewTab();
		tabManager.activeTab!.isEditing = true;

		assert.equal(await exportWouldRun(), false, 'precondition: exportAsHtml returns null for an empty buffer');
		assert.equal(canExportTab(tabManager.activeTab), false, 'so the menu must not offer it either');
	});
});
