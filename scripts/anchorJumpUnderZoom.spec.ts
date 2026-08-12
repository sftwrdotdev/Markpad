import assert from 'node:assert/strict';

import { test } from 'vitest';

import { anchorScrollTop, previewZoomFactor, PREVIEW_ANCHOR_OFFSET } from '../src/lib/utils/previewAnchor.js';

/*
 * #621: "Custom viewport zoom bogusly offsets anchor jumps (in preview mode)".
 * At 150% a link scrolled past its heading, at 50% it stopped short, and at
 * 100% it was right.
 *
 * The preview sets CSS `zoom` on `.markdown-container`, an ANCESTOR of the
 * scrolling element. `getBoundingClientRect()` reports viewport pixels, which
 * carry that zoom; `scrollTop` counts the scroller's own pixels, which do not.
 * Both call sites added one straight to the other, so the error was exactly the
 * zoom factor — invisible at 100%, and the wrong sign on either side of it.
 *
 * jsdom has no layout, so the elements here are stand-ins that report the
 * geometry a browser would at a given zoom: a rect scaled by the factor, and an
 * `offsetWidth` that is not. That is the whole relationship under test.
 */

/** An element whose rect is `zoom`× its layout box, as a zoomed ancestor makes it. */
function zoomedElement(layoutTop: number, layoutWidth: number, zoom: number) {
	return {
		offsetWidth: layoutWidth,
		getBoundingClientRect: () => ({ top: layoutTop * zoom, width: layoutWidth * zoom }),
	} as unknown as HTMLElement;
}

function scroller(zoom: number, scrollTop: number) {
	const el = zoomedElement(0, 800, zoom) as unknown as { scrollTop: number };
	el.scrollTop = scrollTop;
	return el as unknown as HTMLElement;
}

test('the zoom factor is measured off the container, not read from settings', () => {
	assert.equal(previewZoomFactor(scroller(1, 0)), 1);
	assert.equal(previewZoomFactor(scroller(1.5, 0)), 1.5);
	assert.equal(previewZoomFactor(scroller(0.5, 0)), 0.5);
});

test('a container with no layout reports 1 rather than a division by zero', () => {
	const detached = {
		offsetWidth: 0,
		scrollTop: 0,
		getBoundingClientRect: () => ({ top: 0, width: 0 }),
	} as unknown as HTMLElement;
	assert.equal(previewZoomFactor(detached), 1);
	assert.ok(Number.isFinite(anchorScrollTop(detached, detached)));
});

test('an anchor lands the same distance down the document at every zoom', () => {
	// The heading sits 1000 layout pixels below the top of the scroller, which
	// is already scrolled to 200. Wherever the zoom is, the answer is the same
	// number of the scroller's own pixels.
	const expected = 200 + 1000 - PREVIEW_ANCHOR_OFFSET;

	for (const zoom of [0.5, 1, 1.5, 2]) {
		const container = scroller(zoom, 200);
		const heading = zoomedElement(1000, 400, zoom);
		assert.equal(
			anchorScrollTop(container, heading),
			expected,
			`zoom ${zoom} must land at ${expected}`,
		);
	}
});

test('the pre-fix arithmetic is what overshot, and by exactly the zoom factor', () => {
	// Kept as the shape of the defect: rect delta added straight to scrollTop.
	// It is only correct at 100%, which is why the bug went unseen — and the
	// error is the factor itself, matching the report's "way past" at 150% and
	// "way before" at 50%.
	const preFix = (container: HTMLElement, el: HTMLElement) =>
		el.getBoundingClientRect().top -
		container.getBoundingClientRect().top +
		container.scrollTop -
		PREVIEW_ANCHOR_OFFSET;

	const correct = 200 + 1000 - PREVIEW_ANCHOR_OFFSET;

	for (const [zoom, sign] of [
		[1.5, 'past'],
		[0.5, 'short'],
	] as const) {
		const container = scroller(zoom, 200);
		const heading = zoomedElement(1000, 400, zoom);
		const old = preFix(container, heading);
		assert.notEqual(old, correct, `at zoom ${zoom} the old form must be wrong (${sign})`);
		// The whole error is the un-divided delta.
		assert.equal(old - correct, 1000 * zoom - 1000);
		assert.equal(anchorScrollTop(container, heading), correct);
	}

	// …and identical at 100%, which is why nobody saw it.
	const container = scroller(1, 200);
	const heading = zoomedElement(1000, 400, 1);
	assert.equal(preFix(container, heading), anchorScrollTop(container, heading));
});
