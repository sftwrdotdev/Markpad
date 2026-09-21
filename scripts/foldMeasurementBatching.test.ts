import assert from 'node:assert/strict';
import { test } from 'node:test';

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
