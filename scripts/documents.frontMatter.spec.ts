import assert from 'node:assert/strict';

import { beforeAll, describe, test } from 'vitest';

// Importing the store boots the settings singleton, which asks for the OS type.
let handleInvoke: (cmd: string, args: Record<string, unknown>) => unknown = (cmd) => (cmd === 'get_os_type' ? 'macos' : null);
(window as any).__TAURI_INTERNALS__ = {
	metadata: { currentWindow: { label: 'main' }, currentWebview: { windowLabel: 'main', label: 'main' } },
	invoke: (cmd: string, args?: Record<string, unknown>) => Promise.resolve(handleInvoke(cmd, args ?? {})),
};

const { tabManager } = await import('../src/lib/stores/tabs.svelte.js');
const { settings } = await import('../src/lib/stores/settings.svelte.js');
const { createDocumentSession } = await import('../src/lib/sessions/documentSession.svelte.js');
const { createFrontMatterEdit } = await import('../src/lib/sessions/frontMatterEdit.js');
const { updateFrontMatterField } = await import('../src/lib/utils/frontMatter.js');

type Tab = NonNullable<typeof tabManager.activeTab>;

/*
 * The front matter panel is editable from reading mode, which a large file
 * reaches while its buffer is still the preview slice. Rewriting the slice and
 * saving it would drop the rest of the document, so an edit completes the
 * buffer first, through the real `documentSession.ensureFullContent`.
 */
describe('front matter edits in preview mode', () => {
	const PARTIAL = '---\ntitle: old\n---\n# first half';
	const FULL = '---\ntitle: old\n---\n# first half\n\nand the rest of the file\n';
	const field = { key: 'title', value: 'old', kind: 'string', displayValue: 'old', editable: true } as const;

	beforeAll(() => {
		handleInvoke = (cmd) => {
			if (cmd === 'get_os_type') return 'macos';
			if (cmd === 'read_file_content_checked') return [FULL, false, 'UTF-8'];
			throw new Error(`unexpected invoke: ${cmd}`);
		};
	});

	function build() {
		const session = createDocumentSession({
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
			onDiskChangedUnderSave: () => {},
			cancelPendingAutoSave: () => {},
			askClose: async () => 'discard' as const,
			onCloseSaveNewerEdits: () => {},
			onCloseAutoSaveFailed: () => {},
			onPartialCopySaved: () => {},
		});
		const applied: string[] = [];
		const toasts: string[] = [];
		// The viewer's `applyFrontMatter`: rewrite the field in the buffer it is handed.
		const applyFrontMatter = async (tab: Tab, f: { key: string }, nextValue: () => unknown) => {
			applied.push(tab.rawContent);
			tabManager.updateTabRawContent(tab.id, updateFrontMatterField(tab.rawContent, f.key, nextValue()));
		};
		const edit = createFrontMatterEdit({
			tabManager,
			settings,
			documentSession: session,
			addToast: (message: string) => void toasts.push(message),
			t: (key: string) => key,
			applyFrontMatter,
		});
		return { edit, applied, toasts };
	}

	/** A large file in reading mode whose buffer is still the preview slice. */
	function partialTab() {
		tabManager.closeAll();
		tabManager.addTab('/docs/big.md');
		const tab = tabManager.activeTab!;
		tabManager.setTabRawContent(tab.id, PARTIAL, true);
		assert.equal(tab.isTruncated, true, 'precondition: the buffer is partial');
		return tab;
	}

	test('a field edit completes the buffer before rewriting it', async () => {
		const tab = partialTab();
		const { edit, applied } = build();

		await edit.handleFrontMatterEdit(field, 'new');

		assert.deepEqual(applied, [FULL], 'the edit is applied to the whole file, not the slice');
		assert.equal(tab.isTruncated, false);
		assert.match(tab.rawContent, /title: new/);
		assert.match(tab.rawContent, /and the rest of the file/, 'the rest of the document survives the edit');
	});

	test('a list edit completes the buffer before rewriting it', async () => {
		const tab = partialTab();
		const { edit, applied } = build();

		await edit.handleFrontMatterListChange({ ...field, key: 'tags', kind: 'list' } as never, ['a']);

		assert.deepEqual(applied, [FULL]);
		assert.match(tab.rawContent, /and the rest of the file/);
	});

	test('an edit that cannot complete the buffer is refused, not applied to the slice', async () => {
		// A partial buffer that is already dirty cannot be completed from disk.
		const tab = partialTab();
		tabManager.updateTabRawContent(tab.id, PARTIAL + ' typed');
		tabManager.setTabRawContent(tab.id, tab.rawContent, true);
		tab.originalContent = PARTIAL;
		assert.equal(tab.isDirty && tab.isTruncated, true, 'precondition: dirty and partial');
		const { edit, applied, toasts } = build();

		await edit.handleFrontMatterEdit(field, 'new');
		await edit.handleFrontMatterListChange({ ...field, key: 'tags', kind: 'list' } as never, ['a']);

		assert.deepEqual(applied, [], 'nothing rewrites the slice');
		assert.deepEqual(toasts, ['toast.partialDocument', 'toast.partialDocument']);
	});
});
