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

function createFoldRoot(specs: { id: string; height: number | null }[]) {
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

	const root = {
		querySelectorAll: () => wrappers,
		get offsetHeight() {
			events.push({ type: 'commit' });
			return 0;
		},
	};

	return { root, events };
}

async function runFoldLayout(specs: { id: string; height: number | null }[]) {
	// Imported before the stubs go in, so only the synchronous run below sees them.
	const { observeFoldLayout } = await import('../src/lib/utils/foldLayout.js');
	const { root, events } = createFoldRoot(specs);
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
		const stop = observeFoldLayout(root as unknown as HTMLElement);
		for (const frame of frames.splice(0)) frame();
		stop();
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
	assert.deepEqual(reads.slice().sort(), ['deepest', 'inner', 'outer']);

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
