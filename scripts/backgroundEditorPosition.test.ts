import assert from 'node:assert/strict';
import test from 'node:test';

import { outgoingTabAnchorLine, type StoredTabPosition } from '../src/lib/utils/editorPosition.js';
import { asRendererLine, EDITOR_ANCHOR_LINE_OFFSET } from '../src/lib/utils/lineCoordinates.js';
import { readSource, offsetOf, sliceFrom } from './sourceTree.js';

// A tab left in EDIT-ONLY mode in the background is the one population neither
// writer of `Tab.anchorLine` covers: the preview writes only the active tab and
// is not on screen for this one, and the single editor has moved on to another
// model. What covers it in memory is `editorViewState`, which survives neither
// the window-state snapshot nor the cross-window payload -- so the anchor is
// recovered from it at those two gates. Everything below is about which tabs
// that applies to, because the tabs it must NOT apply to already have a better
// record than the view state.

/** A view state as Monaco writes one, cut down to the field the derivation reads. */
function viewStateAtLine(lineNumber: number) {
	return { viewState: { firstPosition: { lineNumber, column: 1 }, firstPositionDeltaTop: 0 } };
}

function tab(over: Partial<StoredTabPosition> = {}): StoredTabPosition {
	return {
		id: 'background',
		isEditing: true,
		isSplit: false,
		editorViewState: viewStateAtLine(40),
		rawContent: 'body\n'.repeat(200),
		anchorLine: asRendererLine(0),
		...over,
	};
}

test('a background edit-only tab is recorded where its view state says it was', () => {
	// This is the defect: nothing wrote `anchorLine` for this tab, so `0` is
	// what would be persisted -- the top of the document.
	assert.equal(
		outgoingTabAnchorLine(tab(), 'some-other-tab'),
		40 + EDITOR_ANCHOR_LINE_OFFSET,
	);
});

test('the recovered anchor crosses out of the editor numbering, front matter and all', () => {
	// `firstPosition.lineNumber` is a BUFFER line and the tab's anchor is a
	// RENDERER line. The crossing has one home and this reuses it rather than
	// making its own -- the defect shape `lineCoordinates.ts` exists to prevent.
	const rawContent = '---\ntitle: t\n---\n\n' + 'body\n'.repeat(200);
	assert.equal(
		outgoingTabAnchorLine(tab({ rawContent, editorViewState: viewStateAtLine(40) }), null),
		40 + EDITOR_ANCHOR_LINE_OFFSET - 4,
	);
});

test('a tab that left edit mode keeps the position its preview wrote', () => {
	// THE regression this change could introduce. Nothing clears
	// `editorViewState` when a tab leaves edit mode, so a tab the reader edited,
	// switched to reading mode and then scrolled carries a stale view state
	// under a fresh `anchorLine`. Deriving there would replace a correct record
	// with an older one, on the commoner path.
	const stale = tab({ isEditing: false, anchorLine: asRendererLine(120) });
	assert.equal(outgoingTabAnchorLine(stale, 'some-other-tab'), 120);
});

test('a split tab keeps the position its preview wrote', () => {
	// A split tab has its preview on screen writing `anchorLine` on every scroll
	// event, and the editor beside it is scrolled independently unless
	// `isScrollSynced`. Its record is a real reading position; the view state is
	// a second opinion about a different pane.
	const split = tab({ isSplit: true, anchorLine: asRendererLine(120) });
	assert.equal(outgoingTabAnchorLine(split, 'some-other-tab'), 120);
});

test('the active tab keeps what the live editor just flushed onto it', () => {
	// #735 flushes the active tab from the live editor immediately before both
	// gates, and that reading is the better one AND a different one: Monaco's
	// `saveViewState` records the first PARTIALLY visible line, while
	// `getVisibleRanges()` -- what the flush reads -- starts at the first
	// completely visible one. Deriving over the flush would move the active tab
	// by a line at most scroll positions.
	const active = tab({ id: 'live', anchorLine: asRendererLine(120) });
	assert.equal(outgoingTabAnchorLine(active, 'live'), 120);
});

test('a tab with no saved view state is left exactly as it is', () => {
	// Restored from disk, or transferred in: `editorViewState` starts null on
	// both routes and there is nothing to recover from.
	const fresh = tab({ editorViewState: null, anchorLine: asRendererLine(7) });
	assert.equal(outgoingTabAnchorLine(fresh, null), 7);
});

test('a view state written by an older Monaco is left exactly as it is', () => {
	// `firstPosition` is what `reduceRestoreState` falls back from when it is
	// missing, so the shape is real and reachable rather than defensive.
	const legacy = tab({ editorViewState: { scrollTop: 900 }, anchorLine: asRendererLine(7) });
	assert.equal(outgoingTabAnchorLine(legacy, null), 7);
});

test('a percentage is not invented to go with the anchor', () => {
	// The view state carries `scrollTop` but neither height, so no fraction of
	// the scrollable range can be computed from it. `anchorLine` is the first
	// entry of both restore cascades, so recovering it is what decides where the
	// tab opens; writing a percentage nobody can justify is not.
	const source = readSource('src/lib/utils/editorPosition.ts');
	const derivation = sliceFrom(source, 'export function outgoingTabAnchorLine');
	assert.doesNotMatch(derivation, /scrollPercentage/);
});

test('both gates that drop the view state ask for the anchor first', () => {
	// The two moments a tab's position leaves memory. Neither carries
	// `editorViewState`: `serializeState` omits it and `restoreState` seeds
	// null, and `tabTransfer.ts` excludes it as a live Monaco object.
	const store = readSource('src/lib/stores/tabs.svelte.ts');
	const serialize = sliceFrom(store, 'serializeState(): string {');
	assert.match(serialize, /anchorLine: outgoingTabAnchorLine\(t, this\.activeTabId\)/);

	const viewer = readSource('src/lib/MarkdownViewer.svelte');
	const payload = sliceFrom(viewer, 'transferPayload: (tabId) => {');
	assert.match(payload, /anchorLine: outgoingTabAnchorLine\(tab, tabManager\.activeTabId\)/);
	// After the spread, or the snapshot's own field would win.
	assert.ok(offsetOf(payload, '...snapshotTab(tab)') < offsetOf(payload, 'outgoingTabAnchorLine'));
});
