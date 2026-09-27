import assert from 'node:assert/strict';
import test from 'node:test';

import ts from 'typescript';

import { reviewDirtyTabs } from '../src/lib/sessions/closeReview.js';
import { isHomePath } from '../src/lib/utils/homeTab.js';
import { pinnedTagFromWindowLabel, pinnedWindowToken } from '../src/lib/utils/pinnedTagWindow.js';
import { hasRealFilePath } from '../src/lib/utils/tabFileActions.js';
import { functionSource, readSource } from './sourceTree.js';

/*
 * A pinned tag's file list is written when its window ends. Every way of ending
 * a window closes tabs on the way — the last tab's ×, the close review with
 * restore off, a merge into another window — and the pin used to be written
 * after they were gone, so Home showed the group with no files.
 *
 * The window-ending functions are lifted out of MarkdownViewer.svelte and RUN
 * against a stub window; what is asserted is the last list sent to
 * `save_pinned_tag`.
 */

const LIFTED = [
	'openFilePaths',
	'savePinnedTagIfNeeded',
	'closeTabAndWindowIfLast',
	'destroyWindowAfterTabsClosed',
	'settleForExit',
	'mergeSelfInto',
	'openPinnedTag',
];

type Tab = { id: string; path: string; isDirty: boolean };

function pinnedWindow(tabs: Tab[], settings: { closeWindowWithLastTab?: boolean; restoreStateOnReopen?: boolean } = {}) {
	const viewer = readSource('src/lib/MarkdownViewer.svelte');
	const source = LIFTED.map((name) => functionSource(viewer, name)).join('\n');
	const js = ts.transpileModule(source, {
		compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
	}).outputText;

	const saves: string[][] = [];
	const calls: string[] = [];
	const loaded: string[] = [];
	let destroyed = false;
	const closeTab = (id: string) => {
		const at = tabs.findIndex((tab) => tab.id === id);
		if (at !== -1) tabs.splice(at, 1);
	};
	const tabManager = {
		tabs,
		windowTag: { name: 'work', color: '#f00', pinned: true } as object | null,
		closeTab,
		setActive: () => {},
		setWindowTag: (tag: object | null) => void (tabManager.windowTag = tag),
	};
	const known: Record<string, unknown> = {
		tabManager,
		settings: { closeWindowWithLastTab: true, restoreStateOnReopen: false, autoSave: false, language: 'en', ...settings },
		invoke: async (command: string, args?: { files?: string[]; token?: string }) => {
			if (command === 'save_pinned_tag') saves.push([...args!.files!]);
			else calls.push(args?.token ? `${command}:${pinnedTagFromWindowLabel(`window-${args.token}`)}` : command);
		},
		pinnedTagHolder: async () => undefined,
		pinnedWindowToken,
		loadMarkdown: async (file: string) => void loaded.push(file),
		appWindow: { label: 'main', destroy: async () => void (destroyed = true) },
		canCloseTab: async (id: string) => {
			const tab = tabs.find((item) => item.id === id);
			if (tab) tab.isDirty = false;
			return true;
		},
		moveTabToWindow: async (id: string) => (closeTab(id), true),
		persistWindowState: async () => {},
		tick: async () => {},
		reviewDirtyTabs,
		hasRealFilePath,
		isHomePath,
		liveMode: false,
		isCloseWalkActive: false,
	};
	// Anything else the functions keep between calls lands here, as it would
	// on the component.
	const scope = new Proxy(known, {
		has: () => true,
		get: (target, key) => (key in target ? target[key as string] : (globalThis as any)[key]),
	});
	const build = new Function('scope', `with (scope) { ${js}\nreturn { ${LIFTED.join(', ')} }; }`);
	const fns = build(scope) as Record<string, (...args: any[]) => Promise<unknown>>;
	return { fns, tabs, saves, calls, loaded, tabManager, isDestroyed: () => destroyed };
}

const twoFiles = (): Tab[] => [
	{ id: 'a', path: '/notes/a.md', isDirty: false },
	{ id: 'b', path: '/notes/b.md', isDirty: false },
];

test('closing every tab with × keeps the last file in the pin', async () => {
	const w = pinnedWindow(twoFiles());
	await w.fns.closeTabAndWindowIfLast('a');
	await w.fns.closeTabAndWindowIfLast('b');
	assert.equal(w.isDestroyed(), true);
	assert.deepEqual(w.saves.at(-1), ['/notes/b.md']);
});

test('with the window kept open, closing the empty window later does not empty the pin', async () => {
	const w = pinnedWindow(twoFiles(), { closeWindowWithLastTab: false });
	await w.fns.closeTabAndWindowIfLast('a');
	await w.fns.closeTabAndWindowIfLast('b');
	assert.equal(w.isDestroyed(), false);
	assert.equal(await w.fns.settleForExit(), true);
	assert.deepEqual(w.saves.at(-1), ['/notes/b.md']);
});

test('the close review with restore off keeps the dirty tabs it closes in the pin', async () => {
	const tabs = twoFiles();
	tabs[0].isDirty = true;
	const w = pinnedWindow(tabs);
	assert.equal(await w.fns.settleForExit(), true);
	assert.deepEqual(w.tabs.map((tab) => tab.id), ['b'], 'the review closed the dirty tab');
	// The handler re-triggers the close after a review, and settles again.
	assert.equal(await w.fns.settleForExit(), true);
	assert.deepEqual(w.saves.at(-1), ['/notes/a.md', '/notes/b.md']);

	// A window that lives on after that (an update that failed to install)
	// saves what it has open, not the list the review started from.
	w.tabs.push({ id: 'c', path: '/notes/c.md', isDirty: false });
	assert.equal(await w.fns.settleForExit(), true);
	assert.deepEqual(w.saves.at(-1), ['/notes/b.md', '/notes/c.md']);
});

test('merging a pinned window into another keeps its files in the pin', async () => {
	const w = pinnedWindow(twoFiles());
	await w.fns.mergeSelfInto('other');
	assert.equal(w.isDestroyed(), true);
	assert.deepEqual(w.saves.at(-1), ['/notes/a.md', '/notes/b.md']);
});

const research = { name: 'research', color: '#0a0', files: ['/papers/x.md', '/papers/y.md'] };

test('opening a pinned group in a window with tabs opens a new window for it', async () => {
	const w = pinnedWindow(twoFiles());
	await w.fns.openPinnedTag(research);
	assert.deepEqual(w.calls, ['create_transfer_window:research'], 'the new window reads the group from its label');
	assert.deepEqual(w.loaded, [], 'no file of the group joins this window');
	assert.deepEqual(w.tabs.map((tab) => tab.id), ['a', 'b']);
	assert.deepEqual(w.tabManager.windowTag, { name: 'work', color: '#f00', pinned: true });
});

test('an empty window adopts the pinned group in place', async () => {
	const w = pinnedWindow([]);
	w.tabManager.windowTag = null;
	await w.fns.openPinnedTag(research);
	assert.deepEqual(w.calls, []);
	assert.deepEqual(w.loaded, research.files);
	assert.deepEqual(w.tabManager.windowTag, { ...research, pinned: true });
});
