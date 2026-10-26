import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { asBufferLine, asRendererLine, lineCoordinates, tabAnchorForEditorTopLine } from '../src/lib/utils/lineCoordinates.js';
import { outwardSign, planPaneSlide } from '../src/lib/utils/paneSlide.js';
import { getScrollSyncPositionFromPixels, getScrollTopForSyncPosition, type ScrollSyncPosition } from '../src/lib/utils/scrollSync.js';
import { splitRatioAfterMove } from '../src/lib/utils/splitPanes.ts';
import { activeTocIdForLine, sourceLineOf, type TocLineEntry } from '../src/lib/utils/tocFollow.js';
import { isTocOverhanging, isTocOverPreview } from '../src/lib/utils/tocOverlay.ts';
import { bindScrollSync } from '../src/lib/utils/editorJumps.js';

describe('scroll sync section mapping', () => {
	// These tests import and run the mapping. The previous scroll-sync tests read
	// Editor.svelte as text, so the defect that set the sync threshold to a value
	// which disabled sync outright left all 23 of their assertions green (#433).
	// Every assertion below is on a returned number, so an arithmetic change that
	// stops the panes tracking each other fails here.

	type Pane = { scrollMax: number; frontMatterEnd: number };

	// The same document in the two panes. Front matter is ordinary text in the
	// editor and a fixed-height panel in the preview, so it takes 20% of the
	// editor's scroll range and 10% of the preview's. Those proportions differing
	// is the entire reason the mapping carries a section rather than one ratio.
	const EDITOR: Pane = { scrollMax: 1000, frontMatterEnd: 200 };
	const PREVIEW: Pane = { scrollMax: 600, frontMatterEnd: 60 };

	function positionIn(pane: Pane, scrollTop: number): ScrollSyncPosition {
		return getScrollSyncPositionFromPixels(scrollTop, pane.scrollMax, pane.frontMatterEnd);
	}

	function scrollTopIn(pane: Pane, position: ScrollSyncPosition): number {
		return getScrollTopForSyncPosition(position, pane.scrollMax, pane.frontMatterEnd);
	}

	// What split view actually does on every scroll event: read a position out of
	// the pane the user moved, and turn it into pixels for the other pane.
	function across(from: Pane, to: Pane, scrollTop: number): number {
		return scrollTopIn(to, positionIn(from, scrollTop));
	}

	function assertClose(actual: number, expected: number, what: string) {
		assert.ok(
			Math.abs(actual - expected) < 1e-9,
			`${what}: expected ${expected}, got ${actual}`,
		);
	}

	test('the front-matter boundary in one pane lands on the boundary in the other', () => {
		// The measurement the whole design exists for. A single global
		// scrollTop/scrollMax ratio would put the editor's boundary at
		// (200 / 1000) * 600 = 120px in the preview — twice past the end of the
		// preview's own front matter, i.e. already scrolled into the body.
		//
		// That 120 used to be asserted. It is arithmetic over the two fixture
		// constants above and never reaches `src/`, so it belongs in this comment
		// and not in an assert; the two assertions below are the claim, and they
		// are on numbers the mapping returned.
		assert.equal(across(EDITOR, PREVIEW, 200), 60, 'editor boundary must land on the preview boundary');
		assert.equal(across(PREVIEW, EDITOR, 60), 200, 'preview boundary must land on the editor boundary');
	});

	test('front matter maps onto front matter by its own share of the section', () => {
		assert.deepEqual(positionIn(EDITOR, 100), { section: 'frontmatter', ratio: 0.5 });
		assert.equal(across(EDITOR, PREVIEW, 100), 30);
		assert.equal(across(EDITOR, PREVIEW, 50), 15);
		assert.equal(across(PREVIEW, EDITOR, 30), 100);
	});

	test('body maps onto body by its share of the body range, not of the whole pane', () => {
		// Half way down the editor's body is (600 - 200) / (1000 - 200).
		assert.deepEqual(positionIn(EDITOR, 600), { section: 'body', ratio: 0.5 });
		// ...which is 60 + (600 - 60) * 0.5 in the preview, not 600/1000 * 600 = 360.
		assert.equal(across(EDITOR, PREVIEW, 600), 330);
		assert.equal(across(PREVIEW, EDITOR, 330), 600);
	});

	test('top and bottom are fixed points of the mapping', () => {
		assert.equal(across(EDITOR, PREVIEW, 0), 0);
		assert.equal(across(EDITOR, PREVIEW, EDITOR.scrollMax), PREVIEW.scrollMax);
		assert.equal(across(PREVIEW, EDITOR, 0), 0);
		assert.equal(across(PREVIEW, EDITOR, PREVIEW.scrollMax), EDITOR.scrollMax);
	});

	test('scrolling one pane down always moves the other pane down', () => {
		// The shape of the defect that went undetected last time: sync that reports
		// a constant, so the other pane never follows. An inverted ratio fails here
		// too — this is the only property that covers the whole range at once.
		const sweep = [0, 1, 50, 100, 150, 199, 200, 201, 400, 600, 800, 999, 1000];
		const mapped = sweep.map((scrollTop) => across(EDITOR, PREVIEW, scrollTop));

		for (let i = 1; i < sweep.length; i += 1) {
			assert.ok(
				mapped[i] > mapped[i - 1],
				`editor ${sweep[i - 1]} -> ${sweep[i]} must move the preview forward, got ${mapped[i - 1]} -> ${mapped[i]}`,
			);
		}
	});

	test('a position round-trips through pixels in the pane it came from', () => {
		for (const pane of [EDITOR, PREVIEW]) {
			const sweep = [0, 1, pane.frontMatterEnd - 1, pane.frontMatterEnd, pane.frontMatterEnd + 1, pane.scrollMax / 2, pane.scrollMax - 1, pane.scrollMax];

			for (const scrollTop of sweep) {
				const back = scrollTopIn(pane, positionIn(pane, scrollTop));
				assertClose(back, scrollTop, `scrollTop ${scrollTop} in pane max=${pane.scrollMax} fm=${pane.frontMatterEnd}`);

				// ...and the position recovered from those pixels is the same position.
				assert.deepEqual(positionIn(pane, back), positionIn(pane, scrollTop));
			}
		}
	});

	test('the boundary pixel belongs to the body, not to the front matter', () => {
		// Both labels put the same pixel on screen (frontmatter at ratio 1 and body
		// at ratio 0 both resolve to frontMatterEnd in every pane), so this can only
		// be asserted on the label. It is what makes the `<` in the section test an
		// invariant rather than an arbitrary choice: scrolling one pixel further
		// must not jump back to a ratio of 1.
		assert.deepEqual(positionIn(EDITOR, 199), { section: 'frontmatter', ratio: 0.995 });
		assert.equal(positionIn(EDITOR, 200).section, 'body');
		assert.equal(positionIn(EDITOR, 200).ratio, 0);
		assert.equal(positionIn(EDITOR, 201).section, 'body');

		assert.equal(scrollTopIn(EDITOR, { section: 'frontmatter', ratio: 1 }), EDITOR.frontMatterEnd);
		assert.equal(scrollTopIn(EDITOR, { section: 'body', ratio: 0 }), EDITOR.frontMatterEnd);
	});

	test('a document with no front matter is one body range', () => {
		const plain: Pane = { scrollMax: 800, frontMatterEnd: 0 };

		assert.deepEqual(positionIn(plain, 0), { section: 'body', ratio: 0 });
		assert.deepEqual(positionIn(plain, 200), { section: 'body', ratio: 0.25 });
		assert.deepEqual(positionIn(plain, 800), { section: 'body', ratio: 1 });
		assert.equal(scrollTopIn(plain, { section: 'body', ratio: 0.25 }), 200);

		// A front-matter position arriving from a pane that has one scrolls this
		// pane to the top, because its front matter occupies no pixels.
		assert.equal(scrollTopIn(plain, { section: 'frontmatter', ratio: 1 }), 0);
		assert.equal(across(EDITOR, plain, 100), 0);
	});

	test('a document shorter than the viewport has no scroll range and no division by zero', () => {
		const short: Pane = { scrollMax: 0, frontMatterEnd: 0 };

		assert.deepEqual(positionIn(short, 0), { section: 'body', ratio: 0 });
		assert.deepEqual(positionIn(short, 500), { section: 'body', ratio: 0 });
		assert.equal(scrollTopIn(short, { section: 'body', ratio: 1 }), 0);
		assert.equal(scrollTopIn(short, { section: 'frontmatter', ratio: 1 }), 0);

		// scrollMax 0 with a measured front matter height: the height clamps away
		// with the range, rather than dividing by a range that is not there.
		const shortWithFrontMatter: Pane = { scrollMax: 0, frontMatterEnd: 120 };
		assert.deepEqual(positionIn(shortWithFrontMatter, 60), { section: 'body', ratio: 0 });
		assert.equal(scrollTopIn(shortWithFrontMatter, { section: 'frontmatter', ratio: 0.5 }), 0);
	});

	test('front matter taller than the scroll range leaves no body range', () => {
		// Reachable: a long YAML block in a short document. frontMatterEnd clamps to
		// scrollMax, so the body range is exactly zero.
		const allFrontMatter: Pane = { scrollMax: 100, frontMatterEnd: 400 };

		assert.deepEqual(positionIn(allFrontMatter, 50), { section: 'frontmatter', ratio: 0.5 });
		assert.deepEqual(positionIn(allFrontMatter, 100), { section: 'body', ratio: 0 });
		assert.equal(scrollTopIn(allFrontMatter, { section: 'frontmatter', ratio: 0.5 }), 50);

		// A zero-width body must not swallow the bottom of the pane: a body position
		// arriving from the other pane still lands at the end of the scroll range.
		assert.equal(scrollTopIn(allFrontMatter, { section: 'body', ratio: 0 }), 100);
		assert.equal(scrollTopIn(allFrontMatter, { section: 'body', ratio: 1 }), 100);
		assert.equal(across(EDITOR, allFrontMatter, 1000), 100);
	});

	test('out-of-range pixels clamp instead of escaping the pane', () => {
		assert.deepEqual(positionIn(EDITOR, -500), { section: 'frontmatter', ratio: 0 });
		assert.deepEqual(positionIn(EDITOR, 5000), { section: 'body', ratio: 1 });
		assert.equal(across(EDITOR, PREVIEW, -500), 0);
		assert.equal(across(EDITOR, PREVIEW, 5000), PREVIEW.scrollMax);

		// A negative scrollMax or frontMatterEnd is floored at 0 rather than
		// inverting the arithmetic.
		assert.deepEqual(getScrollSyncPositionFromPixels(100, -1000, 200), { section: 'body', ratio: 0 });
		assert.deepEqual(getScrollSyncPositionFromPixels(100, 1000, -200), { section: 'body', ratio: 0.1 });
		assert.equal(getScrollTopForSyncPosition({ section: 'body', ratio: 1 }, -1000, 200), 0);
		assert.equal(getScrollTopForSyncPosition({ section: 'body', ratio: 1 }, 1000, -200), 1000);
	});

	test('a non-finite measurement or ratio never reaches setScrollTop', () => {
		// Monaco and the DOM both return measurements that can be NaN mid-layout,
		// and the position travels across a component boundary before it is used.
		assert.deepEqual(positionIn(EDITOR, Number.NaN), { section: 'body', ratio: 0 });
		assert.deepEqual(positionIn(EDITOR, Number.POSITIVE_INFINITY), { section: 'body', ratio: 1 });

		for (const ratio of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, -1, 2]) {
			for (const section of ['frontmatter', 'body'] as const) {
				const scrollTop = scrollTopIn(PREVIEW, { section, ratio });
				assert.ok(
					Number.isFinite(scrollTop) && scrollTop >= 0 && scrollTop <= PREVIEW.scrollMax,
					`ratio ${ratio} in ${section} produced ${scrollTop}`,
				);
			}
		}

		// Out-of-range finite ratios clamp to the ends of their section; non-finite
		// ones are rejected outright and read as 0, not as the nearest end.
		assert.equal(scrollTopIn(PREVIEW, { section: 'body', ratio: 2 }), PREVIEW.scrollMax);
		assert.equal(scrollTopIn(PREVIEW, { section: 'body', ratio: Number.POSITIVE_INFINITY }), PREVIEW.frontMatterEnd);
	});
});

describe('split pane ratio', () => {
	test('the editor grows when the bar moves away from it, whichever side it is on', () => {
		// Editor on the left: rightward travel is more editor.
		assert.equal(splitRatioAfterMove(0.5, 0.1, 'left'), 0.6);
		assert.equal(splitRatioAfterMove(0.5, -0.1, 'left'), 0.4);

		// Editor on the right: the same motion has to mean the opposite, because
		// the ratio is the editor's share and the editor is now on the far side.
		assert.equal(splitRatioAfterMove(0.5, 0.1, 'right'), 0.4);
		assert.equal(splitRatioAfterMove(0.5, -0.1, 'right'), 0.6);
	});
});

describe('pane slide on view mode switch', () => {
	const preview = { editor: false, viewer: true };
	const edit = { editor: true, viewer: false };
	const split = { editor: true, viewer: true };

	test('each view mode switch names the pane that comes and the one that goes', () => {
		assert.deepEqual(planPaneSlide(preview, split), { entering: 'editor', leaving: null });
		assert.deepEqual(planPaneSlide(split, preview), { entering: null, leaving: 'editor' });
		assert.deepEqual(planPaneSlide(edit, split), { entering: 'viewer', leaving: null });
		assert.deepEqual(planPaneSlide(split, edit), { entering: null, leaving: 'viewer' });
		assert.deepEqual(planPaneSlide(preview, edit), { entering: 'editor', leaving: 'viewer' });
		assert.deepEqual(planPaneSlide(edit, preview), { entering: 'viewer', leaving: 'editor' });
	});

	test('the same panes on screen is no slide', () => {
		for (const mode of [preview, edit, split]) assert.equal(planPaneSlide(mode, mode), null);
	});

	test('a pane slides from its own outer edge, whichever side the editor is on', () => {
		assert.equal(outwardSign('editor', false), -1);
		assert.equal(outwardSign('viewer', false), 1);
		assert.equal(outwardSign('editor', true), 1);
		assert.equal(outwardSign('viewer', true), -1);
	});
});

describe('fold measurement batching', () => {
	// `--fold-content-height` is resolved into `height` by styles.css, so writing it
	// invalidates layout and any measurement that follows forces a synchronous
	// reflow. Measuring one wrapper at a time therefore costs one
	// full-document reflow per foldable heading. There is no DOM here to time a
	// real reflow, so these tests drive the real `observeFoldLayout` through a
	// recording stand-in for the DOM and lock the structural property that makes
	// the reflows constant: no style write may sit between two measurements.

	type LayoutEvent =
		| { type: 'clear'; id: string }
		| { type: 'read'; id: string }
		| { type: 'write'; id: string; value: string }
		| { type: 'suppress'; id: string }
		| { type: 'restore'; id: string }
		| { type: 'commit' };

	const isWrite = (event: LayoutEvent) => event.type !== 'read' && event.type !== 'commit';

	function createFoldRoot(specs: { id: string; height: number | null }[], zoom = 1) {
		const events: LayoutEvent[] = [];

		const wrappers = specs.map(({ id, height }) => {
			const content =
				height === null
					? null
					: {
							getBoundingClientRect() {
								events.push({ type: 'read', id });
								return { height };
							},
						};

			return {
				style: {
					set transition(value: string) {
						events.push({ type: value === 'none' ? 'suppress' : 'restore', id });
					},
					setProperty(name: string, value: string) {
						events.push({ type: 'write', id, value: `${name}:${value}` });
					},
					removeProperty(name: string) {
						events.push({ type: 'clear', id: `${id}:${name}` });
					},
				},
				querySelector: () => content,
			};
		});

		// `previewZoomFactor` reads both of these off the root to recover the CSS
		// `zoom` the preview applies above it. Recorded as measurements so the
		// batching assertions below cover them too: a zoom read taken after the
		// first height is published would cost the same per-wrapper reflow the
		// content reads are batched to avoid.
		const LAYOUT_WIDTH = 800;
		const root = {
			// The article, which is never itself a fold wrapper.
			matches: () => false,
			querySelectorAll: () => wrappers,
			get offsetWidth() {
				events.push({ type: 'read', id: 'root:zoom' });
				return LAYOUT_WIDTH;
			},
			getBoundingClientRect() {
				events.push({ type: 'read', id: 'root:zoom' });
				return { width: LAYOUT_WIDTH * zoom };
			},
			get offsetHeight() {
				events.push({ type: 'commit' });
				return 0;
			},
		};

		return { root, events };
	}

	async function runFoldLayout(specs: { id: string; height: number | null }[], zoom = 1) {
		// Imported before the stubs go in, so only the synchronous run below sees them.
		const { observeFoldLayout } = await import('../src/lib/utils/foldLayout.js');
		const { root, events } = createFoldRoot(specs, zoom);
		const frames: (() => void)[] = [];
		const globals = globalThis as Record<string, unknown>;
		const saved = {
			requestAnimationFrame: globals.requestAnimationFrame,
			cancelAnimationFrame: globals.cancelAnimationFrame,
			ResizeObserver: globals.ResizeObserver,
			window: globals.window,
		};

		globals.requestAnimationFrame = (callback: () => void) => frames.push(callback);
		globals.cancelAnimationFrame = () => {};
		globals.ResizeObserver = class {
			observe() {}
			disconnect() {}
		};
		globals.window = { addEventListener() {}, removeEventListener() {} };

		try {
			const observation = observeFoldLayout(root as unknown as HTMLElement);
			for (const frame of frames.splice(0)) frame();
			observation.stop();
			return events;
		} finally {
			Object.assign(globals, saved);
		}
	}

	test('fold measurement reads every height before it writes any of them', async () => {
		const events = await runFoldLayout([
			{ id: 'outer', height: 300 },
			{ id: 'inner', height: 120.4 },
			{ id: 'deepest', height: 40 },
		]);

		const firstRead = events.findIndex((event) => event.type === 'read');
		const lastRead = events.map((event) => event.type).lastIndexOf('read');
		const interleaved = events.slice(firstRead, lastRead + 1).filter(isWrite);

		assert.deepEqual(
			interleaved,
			[],
			'a style write between two measurements forces one synchronous reflow per wrapper',
		);

		const reads = events.filter((event) => event.type === 'read').map((event) => (event as { id: string }).id);
		assert.deepEqual(reads.slice().sort(), ['deepest', 'inner', 'outer', 'root:zoom', 'root:zoom']);

		const firstHeightWrite = events.findIndex((event) => event.type === 'write');
		assert.ok(firstHeightWrite > lastRead, 'every height must be published after the last measurement');
	});

	test('each wrapper is measured at its natural height, not at its stale published one', async () => {
		const events = await runFoldLayout([
			{ id: 'outer', height: 300 },
			{ id: 'inner', height: 120 },
		]);

		const firstRead = events.findIndex((event) => event.type === 'read');
		const cleared = events
			.slice(0, firstRead)
			.filter((event) => event.type === 'clear')
			.map((event) => (event as { id: string }).id);

		assert.deepEqual(cleared, ['outer:--fold-content-height', 'inner:--fold-content-height']);
	});

	// The published height used to be `Math.ceil(content.scrollHeight)`. Both
	// halves of that were wrong for maths: `scrollHeight` is the scrollable extent,
	// which KaTeX's negative margins push several pixels past the height `auto`
	// resolves to, and the rounding then threw away what precision survived. A
	// wrapper an integer taller than its content moves everything below it on every
	// keystroke, because `{@html}` rebuilds the wrapper unpublished each time.
	//
	// So a fractional measurement must reach the style property unrounded.
	test('measured heights are published at the precision they were measured', async () => {
		const events = await runFoldLayout([
			{ id: 'outer', height: 300 },
			{ id: 'inner', height: 120.4 },
		]);

		assert.deepEqual(
			events.filter((event) => event.type === 'write'),
			[
				{ type: 'write', id: 'outer', value: '--fold-content-height:300px' },
				{ type: 'write', id: 'inner', value: '--fold-content-height:120.4px' },
			],
		);

		const commit = events.findIndex((event) => event.type === 'commit');
		const lastWrite = events.map((event) => event.type).lastIndexOf('write');
		const firstRestore = events.findIndex((event) => event.type === 'restore');

		assert.equal(events.filter((event) => event.type === 'commit').length, 1);
		assert.ok(lastWrite < commit, 'the reflow must come after every height write');
		assert.ok(commit < firstRestore, 'transitions may only come back once the heights are committed');
	});

	test('wrappers without rendered content are skipped instead of measured', async () => {
		const events = await runFoldLayout([
			{ id: 'empty', height: null },
			{ id: 'real', height: 80 },
		]);

		assert.deepEqual(
			events.filter((event) => (event as { id?: string }).id?.startsWith('empty')),
			[],
		);
		assert.deepEqual(
			events.filter((event) => event.type === 'write'),
			[{ type: 'write', id: 'real', value: '--fold-content-height:80px' }],
		);
	});

	// A rect is reported in viewport pixels, which have the preview's CSS `zoom`
	// folded in; `height` is resolved in the wrapper's own pixels, which get that
	// zoom applied again. Publishing the rect as measured made every expanded
	// wrapper exactly `zoom` times too short, so its content overflowed and the
	// next section was drawn on top of it — worse the further the reader zoomed
	// out (#807). The published number has to be the layout height, whatever the
	// zoom, so these lock the conversion rather than any one factor.
	test('published heights are converted out of the zoomed pixels they were measured in', async () => {
		for (const zoom of [0.7, 0.9, 1.5]) {
			const events = await runFoldLayout([{ id: 'section', height: 240 * zoom }], zoom);
			const writes = events.filter((event) => event.type === 'write') as { id: string; value: string }[];

			assert.equal(writes.length, 1);
			assert.equal(writes[0].id, 'section');

			const published = Number(writes[0].value.replace('--fold-content-height:', '').replace('px', ''));
			// Not an exact comparison: the round trip through the test's own
			// `240 * zoom` is what carries the float error, not the conversion.
			assert.ok(
				Math.abs(published - 240) < 0.001,
				`a rect measured at zoom ${zoom} must publish the wrapper's own layout height, got ${published}`,
			);
		}
	});

	// `previewZoomFactor` is a ratio of two measurements, and a container that is
	// not being laid out reports 0 for both. Dividing by the zoom that falls out of
	// that would publish `Infinity` or `NaN` onto every wrapper in the document.
	test('a root with no rendered width publishes the measured height unchanged', async () => {
		const events = await runFoldLayout([{ id: 'section', height: 240 }], 0);

		assert.deepEqual(
			events.filter((event) => event.type === 'write'),
			[{ type: 'write', id: 'section', value: '--fold-content-height:240px' }],
		);
	});
});

/**
 * #169: the outline highlights the heading you are reading, but only ever
 * answered to the PREVIEW.
 *
 * `Toc.svelte` decided by rendered box — `querySelector` each visible entry
 * out of the preview and measure it against the container, per entry, per
 * scroll event. That question has no answer while the editor is the pane being
 * scrolled: in editor-only mode the preview never scrolls, and in split view
 * it moves only while scroll sync is on. So the outline sat still exactly
 * where the reporter said it did.
 *
 * A SOURCE LINE is something both panes can produce — the editor sends one on
 * every scroll, and the preview already computes one for the tab's reading
 * position — so the rule is now one comparison over a list, fed by either.
 * That the two panes share it is the property worth having: in split view with
 * sync on both are live at once, and two rules could disagree as the panes
 * settle and flicker the highlight between two entries.
 */
describe('outline follows the editor', () => {
	/**
	 * Every line in the outline is a BODY line, because the outline is built out of
	 * `data-sourcepos` and that attribute counts from the first line of the body.
	 * The alias is here so each fixture below says which of the two numberings it
	 * is written in — the distinction this whole file turns on.
	 */
	const bodyLine = asRendererLine;

	/** An outline of a document whose headings are 20 source lines apart. */
	const OUTLINE: TocLineEntry[] = [
		{ id: 'intro', line: bodyLine(1) },
		{ id: 'setup', line: bodyLine(21) },
		{ id: 'a-block-anchor', line: null },
		{ id: 'usage', line: bodyLine(41) },
		{ id: 'api', line: bodyLine(61) },
	];

	test('the active entry is the last heading at or above the editor position', () => {
		assert.equal(activeTocIdForLine(OUTLINE, bodyLine(1)), 'intro');
		assert.equal(activeTocIdForLine(OUTLINE, bodyLine(20)), 'intro');
		assert.equal(activeTocIdForLine(OUTLINE, bodyLine(21)), 'setup');
		assert.equal(activeTocIdForLine(OUTLINE, bodyLine(40.7)), 'setup');
		assert.equal(activeTocIdForLine(OUTLINE, bodyLine(41)), 'usage');
		assert.equal(activeTocIdForLine(OUTLINE, bodyLine(4000)), 'api');
	});

	test('a position above every heading takes the first entry, as the preview does', () => {
		// Answering `null` here would blank the outline on the way past the top of
		// a document scrolled in the editor.
		assert.equal(activeTocIdForLine([{ id: 'later', line: bodyLine(12) }], bodyLine(3)), 'later');
	});

	test('an entry with no source range never becomes active, and never hides one that has', () => {
		// Block anchors (`^id`) are in the outline and carry no range of their own.
		// A `null` must not be read as line 0 and swallow every position after it.
		assert.equal(activeTocIdForLine(OUTLINE, bodyLine(45)), 'usage');
		assert.equal(activeTocIdForLine([{ id: 'block', line: null }], bodyLine(900)), 'block');
	});

	test('nothing to follow yields nothing, rather than a stale entry', () => {
		assert.equal(activeTocIdForLine([], bodyLine(12)), null);
		assert.equal(activeTocIdForLine(OUTLINE, bodyLine(Number.NaN)), null);
	});

	test('the start line comes from the sourcepos comrak wrote, or nothing', () => {
		assert.equal(sourceLineOf('42:1-44:9'), 42);
		assert.equal(sourceLineOf('7:1-7:12'), 7);
		assert.equal(sourceLineOf(undefined), null);
		assert.equal(sourceLineOf(''), null);
		assert.equal(sourceLineOf('0:1-0:1'), null);
		assert.equal(sourceLineOf('nonsense'), null);
	});

	test('the editor position is converted before the outline compares it', () => {
		// What the assertion above cannot see, and what a regular expression over
		// the viewer's source never could: whether the conversion is the RIGHT one.
		// This is the shift itself, over the outline's own rule.
		const raw = ['---', 'title: "T"', 'tags:', '  - a', '---', '', '# Intro'].join('\n') + '\n';
		const coords = lineCoordinates(raw);
		assert.equal(coords.frontMatterLines, 6, 'the fixture must actually have front matter');

		// The top of the editor's viewport is body line 18, which is buffer line
		// 24 because six lines of YAML sit above it. The reader's anchor sits two
		// lines below that, on body line 20: the last line of the intro section.
		const topLine = asBufferLine(18 + coords.frontMatterLines);
		assert.equal(activeTocIdForLine(OUTLINE, tabAnchorForEditorTopLine(coords, topLine)), 'intro');

		// Handed over unconverted it is past the next heading, and the outline
		// highlights the section the reader has not reached yet. That is the whole
		// defect, and it is invisible in a document without front matter — which is
		// every other fixture in this file.
		assert.equal(activeTocIdForLine(OUTLINE, asRendererLine(topLine)), 'setup');

		// And with the top line one short of a heading — the heading is the first
		// line fully on screen, the line above it is the one the viewport cuts —
		// the anchor is on the heading and the outline has moved on. Fed the raw
		// top line it would still say `intro`, one entry behind what the reader
		// sees at the top of the editor.
		const cutLine = asBufferLine(19 + coords.frontMatterLines);
		assert.equal(activeTocIdForLine(OUTLINE, tabAnchorForEditorTopLine(coords, cutLine)), 'setup');
		assert.equal(activeTocIdForLine(OUTLINE, coords.toRendererLine(cutLine)), 'intro');
	});
});

describe('outline overlay placement', () => {
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
});

describe('scroll sync input', () => {
	test('typing does not initiate split scroll synchronization', () => {
		// The editor-to-preview sync listens to scrolling. A caret move by itself,
		// which every keystroke is, must not drag the other pane along.
		const listeners: Record<string, ((e: unknown) => void)[]> = { scroll: [], cursor: [] };
		const on = (kind: string) => (listener: (e: unknown) => void) => {
			listeners[kind].push(listener);
			return { dispose: () => listeners[kind].splice(listeners[kind].indexOf(listener), 1) };
		};
		const editor = { onDidScrollChange: on('scroll'), onDidChangeCursorPosition: on('cursor') };
		let synced = 0;
		const binding = bindScrollSync(editor as never, () => synced++);

		for (const listener of listeners.cursor) listener({ position: { lineNumber: 2, column: 4 } });
		for (const listener of listeners.scroll) listener({ scrollTopChanged: false, scrollLeftChanged: true });
		assert.equal(synced, 0);

		for (const listener of listeners.scroll) listener({ scrollTopChanged: true });
		assert.equal(synced, 1);

		binding.dispose();
		assert.deepEqual(listeners, { scroll: [], cursor: [] });
	});
});
