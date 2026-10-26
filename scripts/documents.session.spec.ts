import assert from 'node:assert/strict';

import { afterAll, beforeAll, beforeEach, describe, test } from 'vitest';

import { runeEffect } from './runeEffect.svelte.js';
import { t } from '../src/lib/utils/i18n.js';
import { MARKDOWN_LINK_EXTENSIONS } from '../src/lib/utils/markdownLinks.js';

// Importing the store boots the settings singleton, which asks for the OS type.
(window as any).__TAURI_INTERNALS__ = {
	metadata: { currentWindow: { label: 'main' }, currentWebview: { windowLabel: 'main', label: 'main' } },
	invoke: (cmd: string) => Promise.resolve(cmd === 'get_os_type' ? 'macos' : null),
};

const { tabManager } = await import('../src/lib/stores/tabs.svelte.js');
const { settings } = await import('../src/lib/stores/settings.svelte.js');
const { createDocumentSession } = await import('../src/lib/sessions/documentSession.svelte.js');

/*
 * The document session driven end to end against a scripted disk: the store
 * and the session run under the compiler's runes, only Tauri is stubbed.
 *
 * Every read path decodes leniently (#371), so a file nothing can decode opens
 * with U+FFFD in place of the bytes it lost. Writing that buffer back over its
 * own file destroys the document, so the tab carries the decode's verdict and
 * the session refuses that one write — while Save As to another file stays
 * open as the way out.
 */
describe('document session', () => {
	type File = { body: string; lossy?: boolean; encoding?: string };
	const disk = new Map<string, File>();
	let calls: Array<{ cmd: string; args: any }> = [];
	/** What the Save dialog answers next. */
	let dialogAnswer: string | null = null;
	/** Overrides for one test; return undefined to fall through to the disk. */
	let override: (cmd: string, args: any) => unknown = () => undefined;
	let errors: Array<{ message: string; detail: unknown }> = [];

	beforeAll(() => {
		(window as any).__TAURI_INTERNALS__ = {
			metadata: { currentWindow: { label: 'main' }, currentWebview: { windowLabel: 'main', label: 'main' } },
			invoke: (cmd: string, args: any) => {
				calls.push({ cmd, args });
				const answer = override(cmd, args);
				if (answer !== undefined) return Promise.resolve(answer);
				const file = disk.get(args?.path);
				switch (cmd) {
					case 'get_os_type':
						return Promise.resolve('macos');
					case 'canonicalize_path':
						return Promise.resolve(args.path);
					case 'open_markdown_preview':
						return Promise.resolve([file?.body ?? '', true, file?.lossy ?? false, file?.encoding ?? 'UTF-8']);
					case 'read_file_content_checked':
						return file
							? Promise.resolve([file.body, file.lossy ?? false, file.encoding ?? 'UTF-8'])
							: Promise.reject(new Error('No such file or directory (os error 2)'));
					case 'save_file_content':
						disk.set(args.path, { body: args.content, encoding: args.encoding });
						return Promise.resolve(null);
					case 'plugin:dialog|save':
						return Promise.resolve(dialogAnswer);
					default:
						return Promise.resolve(null);
				}
			},
		};
	});

	let settingsBefore: Pick<typeof settings, 'openFileMode' | 'newFileDefaultMode' | 'splitScrollSync' | 'autoSave'>;
	beforeAll(() => {
		settingsBefore = {
			openFileMode: settings.openFileMode,
			newFileDefaultMode: settings.newFileDefaultMode,
			splitScrollSync: settings.splitScrollSync,
			autoSave: settings.autoSave,
		};
	});
	afterAll(() => {
		Object.assign(settings, settingsBefore);
		tabManager.closeAll();
		tabManager.recentlyClosed.length = 0;
		localStorage.clear();
	});

	beforeEach(() => {
		Object.assign(settings, settingsBefore, { openFileMode: 'preview' });
		tabManager.closeAll();
		disk.clear();
		calls = [];
		dialogAnswer = null;
		override = () => undefined;
		errors = [];
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
			onError: (message, detail) => void errors.push({ message, detail }),
			onDiskChangedUnderSave: () => {},
			cancelPendingAutoSave: () => {},
			askClose: async () => 'discard' as const,
			onCloseSaveNewerEdits: () => {},
			onCloseAutoSaveFailed: () => {},
			onPartialCopySaved: () => {},
		});
	}

	const writes = () => calls.filter((call) => call.cmd === 'save_file_content').map((call) => call.args);
	const dialogs = () => calls.filter((call) => call.cmd === 'plugin:dialog|save').map((call) => call.args.options);
	const LOSSY = '# legacy ��';

	// --- the flag -----------------------------------------------------------------

	test('the tab carries the fidelity of its buffer', () => {
		// Required, not optional: a construction site that forgot it would read
		// as "safe to overwrite", and the failure mode is a destroyed document.
		tabManager.restoreState(JSON.stringify({ version: 2, tabs: [{ path: '/notes/restored.md' }] }));
		tabManager.addTab('/notes/a.md');
		tabManager.addNewTab();
		tabManager.addHomeTab();
		for (const tab of tabManager.tabs) assert.equal(tab.hasReplacementChars, false, `${tab.title} starts undecided`);

		const id = tabManager.activeTabId!;
		tabManager.setTabDecodedLossy(id, true);
		assert.equal(tabManager.activeTab!.hasReplacementChars, true);
	});

	test('every load decides the flag instead of leaving it stale', async () => {
		// A reload of a file the user has since converted to UTF-8 must clear it.
		const session = makeSession();
		disk.set('/notes/legacy.md', { body: LOSSY, lossy: true });
		await session.loadMarkdown('/notes/legacy.md');
		assert.equal(tabManager.activeTab!.hasReplacementChars, true);

		disk.set('/notes/legacy.md', { body: '# legacy, converted' });
		await session.loadMarkdown('/notes/legacy.md', { skipTabManagement: true, discardUnsavedBuffer: true });
		assert.equal(tabManager.activeTab!.hasReplacementChars, false);
	});

	test('the editable-pane shortcut reports fidelity too', async () => {
		// A pane that can WRITE skips the preview and reads the whole file up
		// front (#374); that read must flag the buffer like the preview does.
		const session = makeSession();
		disk.set('/notes/legacy.md', { body: LOSSY, lossy: true });
		tabManager.addTab('/notes/legacy.md');
		tabManager.activeTab!.isEditing = true;

		await session.loadMarkdown('/notes/legacy.md', { skipTabManagement: true, preserveEditState: true });

		assert.equal(calls.some((call) => call.cmd === 'open_markdown_preview'), false, 'precondition: the full read ran');
		assert.equal(tabManager.activeTab!.hasReplacementChars, true);
		tabManager.updateTabRawContent(tabManager.activeTabId!, `${LOSSY} edited`);
		assert.equal(await session.saveContent(), false);
		assert.deepEqual(writes(), []);
	});

	test('the flag is set before the buffer can reach a writer', async () => {
		// The auto-save effect reacts to the new buffer. Whenever it first sees
		// the lossy text, it must already see the flag that refuses it.
		const session = makeSession();
		disk.set('/notes/legacy.md', { body: LOSSY, lossy: true });
		const seen: boolean[] = [];
		const stop = runeEffect(() => {
			const tab = tabManager.activeTab;
			if (tab?.rawContent === LOSSY) seen.push(tab.hasReplacementChars);
		});
		try {
			await session.loadMarkdown('/notes/legacy.md');
		} finally {
			stop();
		}
		assert.ok(seen.length > 0, 'precondition: the buffer was published');
		assert.deepEqual([...new Set(seen)], [true]);
	});

	test('window restore cannot launder the flag away', async () => {
		// Restore reads each file back into an editable buffer. Reopening the app
		// must not turn a lossy buffer into one that looks safe to save.
		const session = makeSession();
		disk.set('/notes/legacy.md', { body: LOSSY, lossy: true });
		tabManager.restoreState(JSON.stringify({ version: 2, tabs: [{ path: '/notes/legacy.md', isEditing: true }] }));
		const tab = tabManager.activeTab!;

		await session.readRestoredTab(tab.id);

		assert.equal(tab.rawContent, LOSSY);
		assert.equal(tab.hasReplacementChars, true);
		tabManager.updateTabRawContent(tab.id, `${LOSSY} edited`);
		assert.equal(await session.saveContent(tab.id), false);
		assert.deepEqual(writes(), []);
	});

	// --- the guard ----------------------------------------------------------------

	test('the guard protects the source file only', async () => {
		// An untitled buffer has no source file to destroy, and any other path is
		// a new UTF-8 file — neither is blocked.
		const session = makeSession();
		tabManager.addNewTab();
		const untitled = tabManager.activeTab!;
		tabManager.updateTabRawContent(untitled.id, LOSSY);
		tabManager.setTabDecodedLossy(untitled.id, true);
		dialogAnswer = '/notes/rescued.md';
		assert.equal(await session.saveContent(untitled.id), true);

		disk.set('/notes/legacy.md', { body: LOSSY, lossy: true });
		await session.loadMarkdown('/notes/legacy.md');
		dialogAnswer = '/notes/copy.md';
		assert.equal(await session.saveContentAs(), true);

		assert.deepEqual(writes().map((write) => write.path), ['/notes/rescued.md', '/notes/copy.md']);
		assert.deepEqual(errors, []);
	});

	test('Save As to a new file stays open as the escape hatch', async () => {
		// Written as UTF-8 whatever the tab was read as: the copy exists to be
		// readable when the original could not be. Afterwards the tab is a UTF-8
		// document of its own, so ordinary saves work again.
		const session = makeSession();
		disk.set('/notes/legacy.md', { body: LOSSY, lossy: true, encoding: 'GBK' });
		await session.loadMarkdown('/notes/legacy.md');
		const tab = tabManager.activeTab!;
		tabManager.setTabEncoding(tab.id, 'GBK');

		dialogAnswer = '/notes/copy.md';
		assert.equal(await session.saveContentAs(), true);
		assert.deepEqual(writes(), [{ path: '/notes/copy.md', content: LOSSY, encoding: 'UTF-8' }]);
		assert.equal(tab.hasReplacementChars, false);
		assert.equal(tab.encoding, 'UTF-8');

		tabManager.updateTabRawContent(tab.id, 'fixed by hand');
		assert.equal(await session.saveContent(tab.id), true);
		assert.equal(disk.get('/notes/copy.md')?.body, 'fixed by hand');
	});

	test('the refusal tells the user what to do and is not repeated per keystroke', async () => {
		// Auto-save re-arms on every edit; an undeduplicated toast would fire
		// every 1.5s. The one message is the Save As explanation.
		const session = makeSession();
		disk.set('/notes/legacy.md', { body: LOSSY, lossy: true });
		await session.loadMarkdown('/notes/legacy.md');
		const tab = tabManager.activeTab!;
		for (const text of ['a', 'ab', 'abc']) {
			tabManager.updateTabRawContent(tab.id, text);
			assert.equal(await session.saveContent(tab.id), false);
		}
		assert.deepEqual(errors, [{ message: t('toast.lossySaveBlocked', settings.language), detail: '/notes/legacy.md' }]);
	});

	// --- save failures and dialogs ------------------------------------------------

	test('the code is turned into the translation, and only that code is', async () => {
		// `onError` renders `${message}: ${detail}`, so the raw code must never be
		// the detail: the translated branch names the document instead.
		const session = makeSession();
		disk.set('/notes/gbk.md', { body: 'text', encoding: 'GBK' });
		await session.loadMarkdown('/notes/gbk.md');
		const tab = tabManager.activeTab!;
		tabManager.setTabEncoding(tab.id, 'GBK');
		override = (cmd) => (cmd === 'save_file_content' ? Promise.reject('ENCODING_UNMAPPABLE:GBK') : undefined);
		tabManager.updateTabRawContent(tab.id, 'text 😀');
		assert.equal(await session.saveContent(tab.id), false);
		assert.deepEqual(errors, [
			{
				message: t('toast.encodingUnmappable', settings.language).replace('{{encoding}}', 'GBK'),
				detail: '/notes/gbk.md',
			},
		]);

		// An I/O failure keeps the OS's own words.
		errors = [];
		const io = new Error('Permission denied (os error 13)');
		override = (cmd) => (cmd === 'save_file_content' ? Promise.reject(io) : undefined);
		assert.equal(await session.saveContent(tab.id), false);
		assert.deepEqual(errors, [{ message: 'Failed to save file', detail: io }]);
	});

	test('the Save dialogs offer the same document extensions', async () => {
		// Both hard-coded `['md']` once, so a `.txt` note saved under a new name
		// had to go through "All Files".
		const session = makeSession();
		tabManager.addNewTab();
		await session.saveContent();
		disk.set('/notes/a.md', { body: 'a' });
		await session.loadMarkdown('/notes/a.md');
		await session.saveContentAs();

		const offered = dialogs().map((options) => options.filters);
		assert.equal(offered.length, 2);
		for (const filters of offered) {
			assert.deepEqual(filters[0], { name: 'Markdown', extensions: MARKDOWN_LINK_EXTENSIONS });
			assert.ok(filters[0].extensions.includes('txt'));
		}
	});

	test('the untitled save dialog prefills the numbered tab title', async () => {
		const session = makeSession();
		tabManager.addNewTab();
		tabManager.addNewTab();
		await session.saveContent();
		assert.equal(dialogs()[0].defaultPath, tabManager.activeTab!.title);
		assert.match(tabManager.activeTab!.title, / 2$/);
	});

	test('save-as writes a snapshot rather than the buffer as it stands', async () => {
		// A keystroke landing during the write is not in the file and leaves the
		// tab unsaved.
		const session = makeSession();
		disk.set('/notes/a.md', { body: 'before' });
		await session.loadMarkdown('/notes/a.md');
		const tab = tabManager.activeTab!;
		tabManager.updateTabRawContent(tab.id, 'saved text');
		let finishWrite!: () => void;
		override = (cmd, args) => {
			if (cmd !== 'save_file_content') return undefined;
			// Typed after the snapshot was taken, while the write is out.
			tabManager.updateTabRawContent(tab.id, 'saved text, then more');
			disk.set(args.path, { body: args.content });
			return new Promise<null>((resolve) => (finishWrite = () => resolve(null)));
		};
		dialogAnswer = '/notes/b.md';
		const saving = session.saveContentAs();
		while (!finishWrite) await Promise.resolve();
		finishWrite();
		assert.equal(await saving, true);

		assert.equal(disk.get('/notes/b.md')?.body, 'saved text');
		assert.equal(tab.rawContent, 'saved text, then more');
		assert.equal(tab.isDirty, true);
	});

	// --- open file mode (#183) ----------------------------------------------------

	test('opening a document applies the choice, split through the same door the toggle uses', async () => {
		// Split carries the scroll-sync preference the toggle would have given
		// it; a fresh tab is created with sync off and would drop it.
		const session = makeSession();
		settings.openFileMode = 'split';
		settings.splitScrollSync = true;
		disk.set('/notes/a.md', { body: '# a' });
		await session.loadMarkdown('/notes/a.md');
		const tab = tabManager.activeTab!;
		assert.equal(tab.isSplit, true);
		assert.equal(tab.isEditing, false);
		assert.equal(tab.isScrollSynced, true);

		settings.openFileMode = 'editor';
		disk.set('/notes/b.md', { body: '# b' });
		await session.loadMarkdown('/notes/b.md');
		assert.equal(tabManager.activeTab!.isEditing, true);
		assert.equal(tabManager.activeTab!.isSplit, false);
	});

	test('the choice is applied before the load decides how much of the file to read', async () => {
		// An editor bound to the preview slice is one keystroke away from
		// auto-saving it back over the whole file.
		for (const mode of ['editor', 'split'] as const) {
			tabManager.closeAll();
			calls = [];
			settings.openFileMode = mode;
			const session = makeSession();
			disk.set('/notes/big.md', { body: 'the whole file' });
			override = (cmd) => (cmd === 'open_markdown_preview' ? ['the whole', false, false, 'UTF-8'] : undefined);
			await session.loadMarkdown('/notes/big.md');
			const tab = tabManager.activeTab!;
			assert.equal(calls.some((call) => call.cmd === 'open_markdown_preview'), false, `${mode} read the preview slice`);
			assert.equal(tab.rawContent, 'the whole file');
			assert.notEqual(tab.isTruncated, true);
		}
	});

	test('it applies to a newly opened document only', async () => {
		// Not to a file already open in a tab, and not to a reload preserving
		// the mode: reopening a document must not flip the mode the reader chose.
		const session = makeSession();
		disk.set('/notes/a.md', { body: '# a' });
		await session.loadMarkdown('/notes/a.md');
		const tab = tabManager.activeTab!;
		assert.equal(tab.isEditing, false);

		settings.openFileMode = 'editor';
		await session.loadMarkdown('/notes/a.md');
		assert.equal(tabManager.tabs.length, 1);
		assert.equal(tab.isEditing, false, 'reopening an open file kept its mode');

		await session.loadMarkdown('/notes/a.md', { skipTabManagement: true, preserveEditState: true });
		assert.equal(tab.isEditing, false, 'a reload kept its mode');
	});

	test('a new empty document keeps its own preference', () => {
		// Ctrl+N answers what an empty buffer opens as with `newFileDefaultMode`.
		settings.openFileMode = 'split';
		for (const preference of [true, false]) {
			settings.newFileDefaultMode = preference;
			tabManager.addNewTab();
			assert.equal(tabManager.activeTab!.isEditing, preference);
			assert.equal(tabManager.activeTab!.isSplit, false);
		}
	});

	// --- reads that land later ----------------------------------------------------

	test('large-file completion requires the current clean load revision and unchanged view mode', async () => {
		// The background full read is not applied after the user switched mode:
		// the pane that now shows the buffer was entered with its own read.
		const session = makeSession();
		disk.set('/notes/big.md', { body: 'the whole file' });
		let finishFull!: () => void;
		override = (cmd) => {
			if (cmd === 'open_markdown_preview') return ['the whole', false, false, 'UTF-8'];
			if (cmd === 'read_file_content_checked') {
				return new Promise((resolve) => (finishFull = () => resolve(['the whole file', false, 'UTF-8'])));
			}
			return undefined;
		};
		await session.loadMarkdown('/notes/big.md');
		const tab = tabManager.activeTab!;
		assert.equal(tab.rawContent, 'the whole');

		tab.isEditing = true;
		finishFull();
		await new Promise((resolve) => setTimeout(resolve, 300));
		assert.equal(tab.rawContent, 'the whole', 'the completion landed in a pane it was not read for');
	});

	test('it is marked before anything can be awaited', async () => {
		// The preview render effect compares `previewedRawContent` with the
		// buffer the moment the buffer changes; marking later than that rebuilds
		// the article the reader just ticked a box in, and loses the scroll.
		const session = makeSession();
		settings.autoSave = true;
		disk.set('/notes/tasks.md', { body: '- [ ] one\n' });
		await session.loadMarkdown('/notes/tasks.md');
		const tab = tabManager.activeTab!;
		override = (cmd) => (cmd === 'save_file_content' ? new Promise(() => {}) : undefined);
		const stale: string[] = [];
		const stop = runeEffect(() => {
			if (tab.rawContent !== '- [ ] one\n' && tab.previewedRawContent !== tab.rawContent) stale.push(tab.rawContent);
		});
		try {
			void session.toggleTaskCheckbox(1, true);
			for (let i = 0; i < 20; i++) await Promise.resolve();
		} finally {
			stop();
		}
		assert.equal(tab.rawContent, '- [x] one\n', 'precondition: the box was ticked');
		assert.deepEqual(stale, []);
	});
});
