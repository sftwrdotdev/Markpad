import { afterAll, beforeAll, describe, test } from 'vitest';
import assert from 'node:assert/strict';
import { asRendererLine } from '../src/lib/utils/lineCoordinates.js';

describe('rendered HTML field', () => {
	// ---------------------------------------------------------------- environment
	// The runes are the compiler's, not ours: vitest builds `.svelte.ts` through the
	// Svelte plugin, so the store and the session run under real reactivity, and jsdom
	// supplies `window` and `localStorage`. Only the Tauri backend is stubbed, and it
	// has to be in place before the stores are imported, so both happen in beforeAll.
	let tabManager: (typeof import('../src/lib/stores/tabs.svelte.js'))['tabManager'];
	let settings: (typeof import('../src/lib/stores/settings.svelte.js'))['settings'];

	beforeAll(async () => {
		(window as any).__TAURI_INTERNALS__ = {
			metadata: { currentWindow: { label: 'main' }, currentWebview: { windowLabel: 'main', label: 'main' } },
			invoke: (cmd: string) => Promise.resolve(cmd === 'get_os_type' ? 'macos' : null),
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
});
