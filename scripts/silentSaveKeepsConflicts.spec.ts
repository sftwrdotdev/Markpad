import assert from 'node:assert/strict';

import ts from 'typescript';
import { test } from 'vitest';

import { reviewDirtyTabs } from '../src/lib/sessions/closeReview.js';
import { functionSource, readSource } from './sourceTree.js';

// An unanswered external-change conflict is a question only the user can
// answer. The viewer's saves that nobody asked for — leaving the editor or
// split view, and the exit's auto-save — used to go through the same wrapper as
// Cmd+S, which authorises the overwrite whenever the bar is up. So Ctrl+E or
// quitting wrote the buffer over the other program's change and took the bar
// down without asking.
//
// The functions are lifted out of MarkdownViewer.svelte and RUN against the
// real document session, so what is asserted is what reaches the disk.

const disk = new Map<string, string>();

(window as any).__TAURI_INTERNALS__ = {
	metadata: { currentWindow: { label: 'main' }, currentWebview: { windowLabel: 'main', label: 'main' } },
	invoke: (cmd: string, args: any) => {
		if (cmd === 'canonicalize_path') return Promise.resolve(args.path);
		if (cmd === 'read_file_content_checked') return Promise.resolve([disk.get(args.path) ?? '', false, 'UTF-8']);
		if (cmd === 'open_markdown_preview') return Promise.resolve([disk.get(args.path) ?? '', true, false, 'UTF-8']);
		if (cmd === 'save_file_content') {
			disk.set(args.path, args.content);
			return Promise.resolve(null);
		}
		if (cmd === 'get_os_type') return Promise.resolve('macos');
		return Promise.resolve(null);
	},
};

const { tabManager } = await import('../src/lib/stores/tabs.svelte.js');
const { createDocumentSession } = await import('../src/lib/sessions/documentSession.svelte.js');

const LIFTED = [
	'hasExternalChangeConflict',
	'noteExternalChangeConflict',
	'clearExternalChangeConflict',
	'resolveExternalChangeByKeepingBuffer',
	'saveContent',
	'saveSilently',
	'flushBeforeLeavingEditableMode',
	'settleForExit',
];

function makeViewer() {
	const closeQuestions: boolean[] = [];
	const toasts: string[] = [];
	const scope: Record<string, unknown> = {
		tabManager,
		externalChangeConflicts: {},
		comparison: null,
		settings: { autoSave: true, language: 'en', restoreStateOnReopen: false },
		t: (key: string) => key,
		addToast: (message: string) => void toasts.push(message),
		invoke: async () => null,
		tick: async () => {},
		reviewDirtyTabs,
		isCloseWalkActive: false,
		pinFilesAtClose: null,
		openFilePaths: () => [],
		savePinnedTagIfNeeded: async () => {},
		persistWindowState: async () => {},
	};
	const session = createDocumentSession({
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
		renderRichContent: () => {},
		onError: () => {},
		onDiskChangedUnderSave: (id: string) => (fns.noteExternalChangeConflict as (id: string) => void)(id),
		cancelPendingAutoSave: () => {},
		askClose: async (_title: string, diskMoved: boolean) => {
			closeQuestions.push(diskMoved);
			return 'cancel' as const;
		},
		onCloseSaveNewerEdits: () => {},
		onCloseAutoSaveFailed: () => {},
		onPartialCopySaved: () => {},
	});
	scope.documentSession = session;
	scope.canCloseTab = (id: string) => session.canCloseTab(id);

	const source = readSource('src/lib/MarkdownViewer.svelte');
	const declarations = LIFTED.map((name) => `const ${name} = ${functionSource(source, name)};`).join('\n');
	const js = ts.transpileModule(declarations, {
		compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
	}).outputText;
	const fns = new Function('scope', `with (scope) { ${js}\nreturn { ${LIFTED.join(', ')} }; }`)(
		new Proxy(scope, { has: (target, key) => key in target }),
	) as Record<string, (...args: any[]) => Promise<unknown>>;
	return { fns, scope, closeQuestions, toasts };
}

/** a.md was saved, another program then changed it, and the user typed once more. */
function conflicted(viewer: ReturnType<typeof makeViewer>) {
	tabManager.closeAll();
	disk.clear();
	disk.set('/notes/a.md', 'saved');
	tabManager.addTab('/notes/a.md', 'saved');
	const tab = tabManager.activeTab!;
	tab.originalContent = 'saved';
	tab.isEditing = true;
	disk.set('/notes/a.md', 'theirs');
	tabManager.updateTabRawContent(tab.id, 'saved!');
	(viewer.fns.noteExternalChangeConflict as unknown as (id: string) => void)(tab.id);
	return tab;
}

test('leaving the editor keeps the edit in the buffer and the bar up', async () => {
	const viewer = makeViewer();
	const tab = conflicted(viewer);

	await viewer.fns.flushBeforeLeavingEditableMode(tab);

	assert.equal(disk.get('/notes/a.md'), 'theirs', 'the other program\'s change was overwritten');
	assert.equal(tab.rawContent, 'saved!');
	assert.equal(viewer.fns.hasExternalChangeConflict(tab.id), true, 'the bar came down');
	assert.deepEqual(viewer.toasts, [], 'the bar already says why nothing was written');
});

test('closing the window asks about a conflicted tab instead of saving it', async () => {
	const viewer = makeViewer();
	const tab = conflicted(viewer);

	assert.equal(await viewer.fns.settleForExit(), false);

	assert.equal(disk.get('/notes/a.md'), 'theirs', 'the other program\'s change was overwritten');
	assert.equal(tab.rawContent, 'saved!');
	assert.deepEqual(viewer.closeQuestions, [true], 'the walk asked the changed-on-disk question');
});

test('the exit still auto-saves the other dirty tabs', async () => {
	const viewer = makeViewer();
	conflicted(viewer);
	disk.set('/notes/b.md', 'b');
	tabManager.addTab('/notes/b.md', 'b');
	const b = tabManager.activeTab!;
	b.originalContent = 'b';
	tabManager.updateTabRawContent(b.id, 'b edited');

	await viewer.fns.settleForExit();

	assert.equal(disk.get('/notes/b.md'), 'b edited');
	assert.equal(disk.get('/notes/a.md'), 'theirs');
});

test('Cmd+S on a conflicted tab is still the answer "keep mine"', async () => {
	const viewer = makeViewer();
	const tab = conflicted(viewer);

	assert.equal(await viewer.fns.saveContent(tab.id), true);

	assert.equal(disk.get('/notes/a.md'), 'saved!');
	assert.equal(viewer.fns.hasExternalChangeConflict(tab.id), false);
});

test('"Keep mine" from the comparison answers for the tab it was opened on', async () => {
	const viewer = makeViewer();
	const a = conflicted(viewer);
	// The user switched tabs with the comparison open: b.md is in front, edited,
	// and another program has just written it too.
	disk.set('/notes/b.md', 'b');
	tabManager.addTab('/notes/b.md', 'b');
	const b = tabManager.activeTab!;
	b.originalContent = 'b';
	tabManager.updateTabRawContent(b.id, 'b edited');
	disk.set('/notes/b.md', 'b theirs');

	// What the overlay's button passes: the tab the comparison was opened on.
	await viewer.fns.resolveExternalChangeByKeepingBuffer(a.id);
	await viewer.fns.saveSilently(b.id);

	assert.equal(disk.get('/notes/b.md'), 'b theirs', 'b.md was overwritten on an answer given about a.md');
	assert.equal(await viewer.fns.saveSilently(a.id), true, 'a.md did not get the answer');
});

test('a conflict does not follow its tab onto another file', async () => {
	const viewer = makeViewer();
	const tab = conflicted(viewer);
	// A link in a.md: the close dialog is answered Don't Save, and b.md loads
	// into the same tab.
	disk.set('/notes/b.md', 'b');
	tab.rawContent = tab.originalContent;
	await (viewer.scope.documentSession as { loadMarkdown: (path: string, options: object) => Promise<void> })
		.loadMarkdown('/notes/b.md', { navigate: true });
	assert.equal(tab.path, '/notes/b.md');

	// b.md is edited, and changed by another program before the watcher says so.
	tabManager.updateTabRawContent(tab.id, 'b edited');
	disk.set('/notes/b.md', 'b theirs');

	assert.equal(await viewer.fns.saveContent(tab.id), false);
	assert.equal(disk.get('/notes/b.md'), 'b theirs', 'Cmd+S used the answer about a.md to overwrite b.md');
});
