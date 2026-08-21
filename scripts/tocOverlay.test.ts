import assert from 'node:assert/strict';
import test from 'node:test';

import { readSource } from './sourceTree.js';

import { isTocOverPreview, isTocOverhanging } from '../src/lib/utils/tocOverlay.ts';

const DEFAULTS = {
	// TOC_WIDTH_RANGE.default and DEFAULT_PREVIEW_MAX_WIDTH.
	tocWidth: 240,
	previewContentWidth: 880 as number | null,
	isFullWidth: false,
};

const reading = { isEditing: false, isSplit: false, splitEditorSide: 'left' } as const;
const editingOnly = { isEditing: true, isSplit: false, splitEditorSide: 'left' } as const;
const split = { isEditing: true, isSplit: true, splitEditorSide: 'left' } as const;
const splitSwapped = { ...split, splitEditorSide: 'right' } as const;

test('the pane under the outline follows from the panes that are rendered', () => {
	// One pane on screen fills the container and holds both edges, so the side
	// the outline is pinned to cannot change the answer.
	assert.equal(isTocOverPreview({ ...reading, tocSide: 'left' }), true);
	assert.equal(isTocOverPreview({ ...reading, tocSide: 'right' }), true);

	assert.equal(isTocOverPreview({ ...split, tocSide: 'left' }), false);
	assert.equal(isTocOverPreview({ ...split, tocSide: 'right' }), true);

	// The viewer pane is `flex: 0` here — neither side lands on the preview.
	assert.equal(isTocOverPreview({ ...editingOnly, tocSide: 'left' }), false);
	assert.equal(isTocOverPreview({ ...editingOnly, tocSide: 'right' }), false);
});

test('swapping the split panes moves the outline onto the other one', () => {
	// The reason this cannot be read off the DOM: `splitEditorSide` reverses
	// the row with `flex-direction`, so the editor is still the first child
	// while the preview is the one on the left.
	assert.equal(isTocOverPreview({ ...splitSwapped, tocSide: 'left' }), true);
	assert.equal(isTocOverPreview({ ...splitSwapped, tocSide: 'right' }), false);

	// Nothing else has two panes to order, so nothing else moves.
	for (const mode of [reading, editingOnly]) {
		for (const tocSide of ['left', 'right'] as const) {
			assert.equal(
				isTocOverPreview({ ...mode, splitEditorSide: 'right', tocSide }),
				isTocOverPreview({ ...mode, splitEditorSide: 'left', tocSide }),
			);
		}
	}
});

test('a swapped split hands the gutter test the pane that actually has a gutter', () => {
	// The outline is pinned left and the preview is now the left pane, so the
	// preview's gutter is what decides — the same question the unswapped
	// right-side case asks, and the opposite of what the unswapped left-side
	// case answers.
	const swappedLeft = { ...DEFAULTS, ...splitSwapped, tocSide: 'left' } as const;
	assert.equal(isTocOverhanging({ ...swappedLeft, viewerWidth: 1400 }), false);
	assert.equal(isTocOverhanging({ ...swappedLeft, viewerWidth: 1000 }), true);

	// Unswapped, the same outline sits on the editor, which has no gutter to
	// lend at any width.
	const unswappedLeft = { ...DEFAULTS, ...split, tocSide: 'left' } as const;
	assert.equal(isTocOverhanging({ ...unswappedLeft, viewerWidth: 1400 }), true);
});

test('in reading mode the gutter decides, and the default one is not wide enough', () => {
	const at = (viewerWidth: number) =>
		isTocOverhanging({ ...DEFAULTS, ...reading, tocSide: 'left', viewerWidth });

	// 240 > (W - 880) / 2  ⟺  W < 1360. This is the finding in #176: the
	// unpinned outline covers the text in any window narrower than that, which
	// is most of them.
	assert.equal(at(1359), true);
	assert.equal(at(1360), false);
	assert.equal(at(1600), false);
	assert.equal(at(1200), true);
});

test('a full-width preview has no gutter at all', () => {
	assert.equal(
		isTocOverhanging({
			...DEFAULTS,
			...reading,
			tocSide: 'left',
			isFullWidth: true,
			previewContentWidth: null,
			viewerWidth: 3000,
		}),
		true,
	);
});

test('covering the editor always counts, however wide the window is', () => {
	// The regression #176 turns on: `viewerWidth` is 0 while the viewer pane is
	// collapsed, so the old expression fell through to "no overlap" and the
	// panel sat on the code with no shadow to say so.
	assert.equal(
		isTocOverhanging({ ...DEFAULTS, ...editingOnly, tocSide: 'left', viewerWidth: 0 }),
		true,
	);
	assert.equal(
		isTocOverhanging({ ...DEFAULTS, ...editingOnly, tocSide: 'right', viewerWidth: 0 }),
		true,
	);
	// Split view is the same defect wearing a different hat: the outline is over
	// the editor, but the measurement was taken from the preview.
	assert.equal(
		isTocOverhanging({ ...DEFAULTS, ...split, tocSide: 'left', viewerWidth: 2000 }),
		true,
	);
	// The right-hand side in split view really is over the preview, so it goes
	// back to arithmetic.
	assert.equal(
		isTocOverhanging({ ...DEFAULTS, ...split, tocSide: 'right', viewerWidth: 2000 }),
		false,
	);
});

test('a narrow preview keeps the floor at 50px rather than going negative', () => {
	// (600 - 880) / 2 is negative; without the floor any outline would count as
	// overhanging, including one narrower than the panel it is compared with.
	assert.equal(
		isTocOverhanging({ ...DEFAULTS, ...reading, tocSide: 'left', viewerWidth: 600, tocWidth: 40 }),
		false,
	);
	assert.equal(
		isTocOverhanging({ ...DEFAULTS, ...reading, tocSide: 'left', viewerWidth: 600, tocWidth: 60 }),
		true,
	);
});

test('the outline collapses itself only when it is in the way', () => {
	const viewer = readSource('src/lib/MarkdownViewer.svelte');
	// Both auto-collapse paths are gated on the same predicate, so a window wide
	// enough to hold the outline beside the text keeps the old behaviour.
	assert.match(viewer, /isOverhanging && !settings\.pinnedToc/);
	// Click-outside must not fight the toggle button, which owns its own click.
	assert.match(viewer, /tocToggleEl\?\.contains\(target\)/);
});

test('the outline\'s toggle drops the editor toolbar\'s offset once it is over the outline', () => {
	// Collapsed, the button floats over the editor pane and `--pane-top-chrome`
	// is what keeps it clear of the toolbar. Expanded it floats over the OUTLINE,
	// which has no toolbar — and the offset pushed it onto the outline's first
	// entry instead. This is an absence, and an absence in CSS is not reachable
	// from a runtime test in this suite: jsdom applies no stylesheet.
	const viewer = readSource('src/lib/MarkdownViewer.svelte');

	const base = viewer.match(/\.toc-toggle-floating \{([^}]*)\}/);
	assert.ok(base, 'the floating toggle rule moved or was renamed');
	assert.match(base[1], /top:\s*calc\([^)]*--pane-top-chrome/);

	const expanded = viewer.match(/\.toc-toggle-floating\.expanded \{([^}]*)\}/);
	assert.ok(expanded, 'the expanded rule moved or was renamed');
	assert.match(expanded[1], /top:\s*\d+px/);
	assert.equal(
		/--pane-top-chrome/.test(expanded[1]),
		false,
		'the expanded toggle is over the outline, which has no editor toolbar to clear',
	);
});
