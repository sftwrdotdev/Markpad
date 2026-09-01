import assert from 'node:assert/strict';
import test from 'node:test';

import { readSource, sliceBetween } from './sourceTree.js';

import type { Tab } from '../src/lib/stores/tabs.svelte.js';
import { asRendererLine } from '../src/lib/utils/lineCoordinates.js';
import {
	buildTransferredTab,
	snapshotTab,
	transferredTabTitle,
	validateTransferPayload,
	type TransferableTab,
} from '../src/lib/utils/tabTransfer.js';

// Cross-window tab transfer: snapshot in the source window → JSON through
// the Rust broker → strict validation → rebuild in the destination. The
// snapshot is independent of serializeState (window shape only, no content):
// a transferred tab MUST carry its unsaved buffer. Validation is strict and
// rejecting — a past bug built tabs with undefined rawContent, the editor
// attributed a stale buffer to them, and auto-save destroyed real files.

function makeTab(overrides: Partial<Tab> = {}): Tab {
	return {
		id: 'source-id',
		path: '/notes/todo.md',
		title: 'todo.md',
		content: '<p>rendered</p>',
		rawContent: '# unsaved edits',
		originalContent: '# saved on disk',
		scrollTop: 120,
		isDirty: true,
		isEditing: true,
		history: ['/notes/readme.md', '/notes/todo.md'],
		historyIndex: 1,
		editorViewState: { cursorState: 'monaco-live-object' },
		scrollPercentage: 0.42,
		anchorLine: asRendererLine(7),
		isSplit: true,
		splitRatio: 0.3,
		isScrollSynced: true,
		hasReplacementChars: false,
		encoding: 'UTF-8',
		scrollHistory: [],
		scrollFuture: [],
		foldOverrides: new Set<string>(),
		...overrides,
	};
}

/**
 * The snapshot as a mutable bag, for the tests that corrupt one field and
 * re-serialize. A copy, so the `TransferableTab` contract stays intact for
 * every other caller.
 */
function snapshotBag(tab: Tab): Record<string, unknown> {
	return { ...snapshotTab(tab) };
}

function roundTrip(tab: Tab): TransferableTab {
	const snap = snapshotTab(tab);
	const validated = validateTransferPayload(JSON.stringify(snap));
	assert.ok(validated, 'a snapshot of a real tab must validate');
	return validated;
}

test('snapshot → JSON → validate → insert preserves the tab, including unsaved content', () => {
	const source = makeTab();
	const arrived = buildTransferredTab(roundTrip(source), [], 'Untitled');

	assert.equal(arrived.path, source.path);
	assert.equal(arrived.title, source.title);
	assert.equal(arrived.rawContent, source.rawContent);
	assert.equal(arrived.originalContent, source.originalContent);
	assert.equal(arrived.isDirty, true);
	assert.equal(arrived.isEditing, true);
	assert.equal(arrived.isSplit, true);
	assert.equal(arrived.splitRatio, source.splitRatio);
	assert.equal(arrived.isScrollSynced, true);
	assert.equal(arrived.scrollTop, source.scrollTop);
	assert.equal(arrived.scrollPercentage, source.scrollPercentage);
	assert.equal(arrived.anchorLine, source.anchorLine);
	assert.deepEqual(arrived.history, source.history);
	assert.equal(arrived.historyIndex, source.historyIndex);

	// regenerated / non-serializable state starts fresh at the destination
	assert.equal(arrived.content, '');
	assert.equal(arrived.editorViewState, null);
	assert.notEqual(arrived.id, source.id);
});

test('each insert gets a fresh id', () => {
	const snap = snapshotTab(makeTab());
	const a = buildTransferredTab(snap, [], 'Untitled');
	const b = buildTransferredTab(snap, [], 'Untitled');
	assert.notEqual(a.id, b.id);
});

test('snapshot never mutates the source tab', () => {
	const source = makeTab();
	const snap = snapshotTab(source);

	snap.history.push('/injected.md');
	snap.rawContent = 'clobbered';
	snap.title = 'clobbered';

	assert.deepEqual(source.history, ['/notes/readme.md', '/notes/todo.md']);
	assert.equal(source.rawContent, '# unsaved edits');
	assert.equal(source.title, 'todo.md');
	assert.equal(source.editorViewState.cursorState, 'monaco-live-object');
});

test('the snapshot excludes rendered content and editorViewState', () => {
	const snap = snapshotBag(makeTab());
	assert.ok(!('content' in snap));
	assert.ok(!('editorViewState' in snap));
	assert.ok(!('id' in snap));
});

test('validation rejects invalid JSON', () => {
	assert.equal(validateTransferPayload('not json {'), null);
	assert.equal(validateTransferPayload(''), null);
});

test('validation rejects non-object payloads', () => {
	assert.equal(validateTransferPayload('null'), null);
	assert.equal(validateTransferPayload('[]'), null);
	assert.equal(validateTransferPayload('"a tab"'), null);
});

test('validation rejects a missing rawContent — no default, no coercion', () => {
	const snap = snapshotBag(makeTab());
	delete snap.rawContent;
	assert.equal(validateTransferPayload(JSON.stringify(snap)), null);
});

test('validation rejects a non-string rawContent', () => {
	const snap = snapshotBag(makeTab());
	snap.rawContent = 5;
	assert.equal(validateTransferPayload(JSON.stringify(snap)), null);
});

test('validation rejects a history that is not an array', () => {
	const snap = snapshotBag(makeTab());
	snap.history = 'nope';
	assert.equal(validateTransferPayload(JSON.stringify(snap)), null);
});

test('validation rejects history entries that are not strings', () => {
	const snap = snapshotBag(makeTab());
	snap.history = [1, 2];
	assert.equal(validateTransferPayload(JSON.stringify(snap)), null);
});

test('validation is strict for every field — even cosmetic numerics get no default', () => {
	for (const field of [
		'path',
		'title',
		'originalContent',
		'isDirty',
		'isEditing',
		'isSplit',
		'isScrollSynced',
		'splitRatio',
		'scrollTop',
		'scrollPercentage',
		'anchorLine',
		'historyIndex',
	]) {
		const snap = snapshotBag(makeTab());
		delete snap[field];
		assert.equal(validateTransferPayload(JSON.stringify(snap)), null, `missing ${field}`);
	}
});

test('validation rejects non-finite numbers (NaN serializes to null)', () => {
	const snap = snapshotBag(makeTab());
	snap.scrollTop = NaN; // JSON.stringify turns this into null
	assert.equal(validateTransferPayload(JSON.stringify(snap)), null);
});

test('untitled arrivals keep their title unless the destination has taken it', () => {
	const source = makeTab({ path: '', title: 'Untitled 2' });
	const snap = roundTrip(source);

	// The title is the document's identity: a fresh detach window (or any
	// destination without a clash) never renames.
	assert.equal(transferredTabTitle(snap, [], 'Untitled'), 'Untitled 2');
	assert.equal(transferredTabTitle(snap, ['Untitled 1'], 'Untitled'), 'Untitled 2');
	assert.equal(transferredTabTitle(snap, ['notes.md'], 'Untitled'), 'Untitled 2');

	// Only an exact clash re-numbers, to the destination's smallest free
	// number per untitledTitle semantics.
	assert.equal(
		transferredTabTitle(snap, ['Untitled 1', 'Untitled 2'], 'Untitled'),
		'Untitled 3',
	);
	assert.equal(transferredTabTitle(snap, ['Untitled 2'], 'Untitled'), 'Untitled 1');

	const arrived = buildTransferredTab(snap, ['Untitled 1', 'Untitled 2'], 'Untitled');
	assert.equal(arrived.title, 'Untitled 3');
	// the buffer still travels even when the title changed
	assert.equal(arrived.rawContent, source.rawContent);
});

test('file-backed arrivals keep their title', () => {
	const snap = roundTrip(makeTab());
	assert.equal(transferredTabTitle(snap, ['todo.md'], 'Untitled'), 'todo.md');
});

// insertTransferredTab lives in the Svelte store ($state rune, not loadable
// in node), so — like windowStateRestore.test.ts — the thin store wrapper is
// checked statically; all decision logic above is exercised directly.
test('insertTransferredTab is a thin wrapper: build, push, activate, return the id', () => {
	const tabs = readSource('src/lib/stores/tabs.svelte.ts');
	const fn = sliceBetween(tabs, 'insertTransferredTab(', 'closeTab(');

	assert.match(fn, /buildTransferredTab\(/);
	// untitled re-numbering uses this window's titles and localized base
	assert.match(fn, /this\.tabs\.map\(\(tab\) => tab\.title\)/);
	assert.match(fn, /t\('tabs\.untitled', settings\.language\)/);
	// the new tab is pushed, activated, and its id returned
	assert.match(fn, /this\.tabs\.push\(tab\);/);
	assert.match(fn, /this\.activeTabId = tab\.id;/);
	assert.match(fn, /return tab\.id;/);
});

test('serializeState still persists window shape only (untouched by transfer)', () => {
	const tabs = readSource('src/lib/stores/tabs.svelte.ts');
	const fn = sliceBetween(tabs, 'serializeState()', 'restoreState(');
	assert.doesNotMatch(fn, /rawContent/);
	assert.doesNotMatch(fn, /TransferableTab/);
});

test('source removal waits for destination completion', () => {
	const broker = readSource('src-tauri/src/tab_transfer.rs');
	const session = readSource('src/lib/sessions/windowSession.svelte.ts');

	assert.match(broker, /pub fn complete_detached_tab/);
	const claim = sliceBetween(broker, 'pub fn claim_detached_tab', 'pub fn complete_detached_tab');
	assert.doesNotMatch(claim, /tab-transfer-claimed/);
	assert.match(session, /invoke\('complete_detached_tab', \{ token \}\)/);
});
