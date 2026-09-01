import assert from 'node:assert/strict';
import test from 'node:test';

import { editorReadingPosition } from '../src/lib/utils/editorPosition.js';
import { EDITOR_ANCHOR_LINE_OFFSET } from '../src/lib/utils/lineCoordinates.js';
import { readSource, offsetOf, sliceFrom } from './sourceTree.js';

const editor = readSource('src/lib/components/Editor.svelte');
const viewer = readSource('src/lib/MarkdownViewer.svelte');

// A tab records where its reader was, and two panes write those fields. The
// preview writes them on every scroll event; the editor writes them when it
// comes down. Everything below is about the second one being asked at the
// moments something reads a tab's position while the editor is still up.

test('the percentage is where the reading puts the reader back', () => {
	const { scrollPercentage } = editorReadingPosition({
		scrollTop: 300,
		contentHeight: 1600,
		viewportHeight: 1000,
		topLine: null,
		text: '',
	});
	assert.equal(scrollPercentage, 0.5);
});

test('a document that fits the viewport has no percentage rather than zero', () => {
	// Zero is a position — the top of the document — and writing it would move
	// a reader who had not scrolled anywhere.
	const { scrollPercentage } = editorReadingPosition({
		scrollTop: 0,
		contentHeight: 400,
		viewportHeight: 1000,
		topLine: null,
		text: 'short',
	});
	assert.equal(scrollPercentage, null);
});

test('the anchor crosses out of the editor numbering, front matter and all', () => {
	// Monaco counts from the first line of the FILE; the tab's anchor counts
	// from the first line of the BODY. Both shifts apply: the four lines of
	// front matter, and the offset that anchors the reader on the line they
	// were reading rather than the one the viewport cut in half.
	const text = '---\ntitle: t\n---\n\nbody line one\nbody line two\nbody line three\n';
	const { anchorLine } = editorReadingPosition({
		scrollTop: 0,
		contentHeight: 2000,
		viewportHeight: 1000,
		topLine: 5,
		text,
	});
	assert.equal(anchorLine, 5 + EDITOR_ANCHOR_LINE_OFFSET - 4);
});

test('an editor with nothing laid out yet reports no anchor', () => {
	const { anchorLine } = editorReadingPosition({
		scrollTop: 0,
		contentHeight: 2000,
		viewportHeight: 1000,
		topLine: null,
		text: 'body',
	});
	assert.equal(anchorLine, null);
});

test('the editor derives the anchor in exactly one place', () => {
	// The teardown used to build it inline. A flush that built its own would be
	// a second crossing of the same two numberings, which is the defect shape
	// `lineCoordinates.ts` exists to prevent.
	assert.doesNotMatch(editor, /tabAnchorForEditorTopLine/);
	assert.equal((editor.match(/editorReadingPosition\(/g) ?? []).length, 1);
});

test('the flush refuses a tab the editor is not holding', () => {
	// One Editor per window, swapping models between tabs: an unguarded flush
	// would copy the active tab's position onto the record the caller named.
	const flush = sliceFrom(editor, 'export function flushPositionTo');
	assert.match(flush, /if \(!editorReady \|\| !editor \|\| currentTabId !== tabId\) return;/);
});

test('the transfer payload flushes before it snapshots the tab', () => {
	// `snapshotTab` is synchronous and runs with the editor still mounted, so
	// without this the tab travels at the position of the last teardown.
	const flushAt = offsetOf(viewer, 'editorPane?.flushPositionTo(tabId);');
	const snapshotAt = offsetOf(viewer, 'JSON.stringify(snapshotTab(tab))');
	assert.ok(flushAt < snapshotAt);
});

test('the window-state snapshot flushes too', () => {
	// Same staleness at window close: `serializeState` persists the same three
	// fields and the editor has not come down yet.
	const serialize = sliceFrom(viewer, 'serializeState: () => {');
	const flushAt = offsetOf(serialize, 'flushPositionTo(tabManager.activeTabId)');
	const stateAt = offsetOf(serialize, 'return tabManager.serializeState();');
	assert.ok(flushAt < stateAt);
});
