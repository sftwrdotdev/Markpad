import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
	canGoBackInHistory,
	canGoForwardInHistory,
	createFileHistory,
	goBackInHistory,
	goForwardInHistory,
	navigateFileHistory,
	replaceCurrentHistoryEntry,
} from '../src/lib/utils/tabHistory.js';
import {
	getMarkdownLinkTarget,
	isOpenInNewTabMarkdownTarget,
	resolveMarkdownTargetPath,
} from '../src/lib/utils/markdownLinks.js';
import { readSource } from './sourceTree.js';

test('new file tabs start history with their path', () => {
	assert.deepEqual(createFileHistory('/notes/a.md'), {
		history: ['/notes/a.md'],
		historyIndex: 0,
	});
});

// Entries exist to be re-opened, and an untitled buffer cannot be. See the
// behaviour this protects in scripts/tabNavigationHistory.spec.ts.
test('an untitled tab starts with no history entry at all', () => {
	assert.deepEqual(createFileHistory(''), {
		history: [],
		historyIndex: 0,
	});
});

test('navigating out of an untitled tab leaves nothing to go back to', () => {
	// Both shapes an untitled tab can arrive in: no entry, and — for a tab
	// transferred from an older window — the `''` its source seeded.
	for (const history of [[], ['']]) {
		assert.deepEqual(
			navigateFileHistory({
				currentPath: '',
				targetPath: '/notes/a.md',
				history,
				historyIndex: 0,
			}),
			{ history: ['/notes/a.md'], historyIndex: 0 }
		);
	}
});

// History is a list of PATHS. `createFileHistory` used to take the tab's
// initial content as an ignored second parameter, and all three callers passed
// one — which is how `addNewTab` came to seed a history with a content string
// in it. A source assertion because that is the whole of what the parameter
// was: nothing reads it, so no behaviour can fail when it comes back, and
// `Function.length` cannot see an optional one either.
test('no caller hands a file history anything but a path', () => {
	const declaration = readSource('src/lib/utils/tabHistory.ts').match(/export function createFileHistory\([^)]*\)/);
	assert.ok(declaration);
	assert.equal(declaration[0], 'export function createFileHistory(path: string)');

	for (const call of readSource('src/lib/stores/tabs.svelte.ts').matchAll(/createFileHistory\([^)]*\)/g)) {
		assert.doesNotMatch(call[0], /,/, `${call[0]} passes something that is not a path`);
	}
});

// `goBackInHistory`/`goForwardInHistory` move an index inside the array they
// were handed; they never rewrite it. Returning it made both store callers
// assign `tab.history` back over itself before assigning the index that
// actually moved.
test('moving through history returns only the index and the path', () => {
	assert.deepEqual(Object.keys(goBackInHistory({ history: ['/a.md', '/b.md'], historyIndex: 1 })).sort(), [
		'historyIndex',
		'path',
	]);
	assert.deepEqual(Object.keys(goForwardInHistory({ history: ['/a.md', '/b.md'], historyIndex: 1 })).sort(), [
		'historyIndex',
		'path',
	]);
});

test('navigating appends paths and truncates forward entries', () => {
	const history = ['/notes/a.md', '/notes/b.md', '/notes/c.md'];
	const afterBack = goBackInHistory({ history, historyIndex: 1 });

	assert.equal(afterBack.path, '/notes/a.md');
	assert.equal(afterBack.historyIndex, 0);

	const afterNavigate = navigateFileHistory({
		currentPath: afterBack.path!,
		targetPath: '/notes/d.md',
		history,
		historyIndex: afterBack.historyIndex,
	});

	assert.deepEqual(afterNavigate.history, ['/notes/a.md', '/notes/d.md']);
	assert.equal(afterNavigate.historyIndex, 1);
	assert.equal(canGoBackInHistory(afterNavigate), true);
	assert.equal(canGoForwardInHistory(afterNavigate), false);
});

test('back and forward stay inside history bounds', () => {
	const initial = {
		history: ['/notes/a.md', '/notes/b.md'],
		historyIndex: 0,
	};

	assert.equal(canGoBackInHistory(initial), false);
	assert.equal(goBackInHistory(initial).path, null);

	const forward = goForwardInHistory(initial);
	assert.equal(forward.path, '/notes/b.md');
	assert.equal(forward.historyIndex, 1);
	assert.equal(canGoForwardInHistory({ history: initial.history, historyIndex: forward.historyIndex }), false);
});

test('replacing current history entry keeps file history path-based', () => {
	assert.deepEqual(
		replaceCurrentHistoryEntry({
			targetPath: '/notes/saved.md',
			history: [],
			historyIndex: 0,
		}),
		{
			history: ['/notes/saved.md'],
			historyIndex: 0,
		}
	);
});

test('markdown link target detection accepts local markdown and rejects external links', () => {
	assert.deepEqual(getMarkdownLinkTarget('../docs/Guide%20One.md#intro'), {
		path: '../docs/Guide One.md',
		hash: 'intro',
	});
	assert.equal(getMarkdownLinkTarget('https://example.com/docs/readme.md'), null);
	assert.equal(getMarkdownLinkTarget('//example.com/readme.md'), null);
	assert.equal(getMarkdownLinkTarget('#local-anchor'), null);
	assert.equal(getMarkdownLinkTarget('../docs/image.png'), null);
});

test('open-in-new-tab target requires a resolvable local markdown link', () => {
	assert.equal(isOpenInNewTabMarkdownTarget('../docs/guide.md', '/vault/current.md'), true);
	assert.equal(isOpenInNewTabMarkdownTarget('../docs/guide.md', ''), false);
	assert.equal(isOpenInNewTabMarkdownTarget('/vault/guide.md', ''), true);
	assert.equal(isOpenInNewTabMarkdownTarget('https://example.com/guide.md', '/vault/current.md'), false);
});

test('relative markdown target resolves against the source file directory', () => {
	const target = getMarkdownLinkTarget('../docs/guide.md#usage');
	assert.ok(target);
	assert.equal(resolveMarkdownTargetPath('/vault/notes/current.md', target), '/vault/docs/guide.md');
});
