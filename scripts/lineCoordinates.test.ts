/**
 * The shift between the editor's line numbers and the preview's.
 *
 * `renderMarkdownPreview` hands comrak the body with the front matter stripped
 * off, so every `data-sourcepos` — and the outline, the tab's reading position
 * and both halves of scroll sync with it — counts from the first line of the
 * BODY, while the editor holds the whole file. The difference is exactly the
 * number of buffer lines the front matter occupies, and it is ZERO in a
 * document that has none.
 *
 * That zero is why this file exists. Every fixture in the suite this module was
 * extracted from was a document without front matter, so both numberings agreed
 * and a crossing that forgot to convert passed everything. The tests here are
 * the ones that only say something when the offset is not zero: the round trip
 * through both directions, the range, and — the half no arithmetic test can
 * reach — the trip out to a pixel in the preview and back.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
	asBufferLine,
	asRendererLine,
	lineCoordinates,
	type BufferLine,
} from '../src/lib/utils/lineCoordinates.ts';

/** Six buffer lines of YAML, so the body starts on buffer line 7. */
const WITH_FRONT_MATTER = ['---', 'title: "T"', 'tags:', '  - a', '---', '', '# Title'].join('\n') + '\n';
const FRONT_MATTER_LINES = 6;

test('the offset is the number of buffer lines above the body', () => {
	assert.equal(lineCoordinates(WITH_FRONT_MATTER).frontMatterLines, FRONT_MATTER_LINES);
	assert.equal(lineCoordinates('# Title\n\nbody\n').frontMatterLines, 0);
	// `\r\n` contains a `\n`, so the count is the same one.
	assert.equal(lineCoordinates(['---', 'title: "T"', '---', '', '# Title'].join('\r\n') + '\r\n').frontMatterLines, 4);
});

test('the two directions are inverses, with front matter in the way', () => {
	const coords = lineCoordinates(WITH_FRONT_MATTER);

	// The heading is line 1 of the body and line 7 of the buffer.
	assert.equal(coords.toBufferLine(asRendererLine(1)), 7);
	assert.equal(coords.toRendererLine(asBufferLine(7)), 1);

	// And the round trip closes from either end. This is the assertion the old
	// suite could not have failed: with `frontMatterEnd = 0` everywhere, both
	// conversions were the identity and so was the composition of two wrong
	// ones.
	for (const line of [1, 2, 3, 40, 1_000, 13_419]) {
		assert.equal(coords.toBufferLine(coords.toRendererLine(asBufferLine(line))), line, `buffer line ${line}`);
		assert.equal(coords.toRendererLine(coords.toBufferLine(asRendererLine(line))), line, `renderer line ${line}`);
	}

	// A fractional line — scroll sync sends one on every event — shifts the same
	// way, because the offset is a whole number of lines whatever the fraction.
	assert.equal(coords.toBufferLine(asRendererLine(12.25)), 18.25);
	assert.equal(coords.toRendererLine(asBufferLine(18.25)), 12.25);
});

test('a document without front matter is left exactly where it is', () => {
	const coords = lineCoordinates('# Title\n\nbody\n');
	for (const line of [1, 17, 900]) {
		assert.equal(coords.toBufferLine(asRendererLine(line)), line);
		assert.equal(coords.toRendererLine(asBufferLine(line)), line);
	}
});

test('a range shifts at both ends, so it still covers the same text', () => {
	const coords = lineCoordinates(WITH_FRONT_MATTER);
	assert.deepEqual(coords.toBufferRange({ startLine: 1, endLine: 4 }), { startLine: 7, endLine: 10 });
	// Same width in, same width out: a range that grew or slid would open the
	// editor on the wrong lines even when its start happened to be right.
	assert.deepEqual(coords.toBufferRange({ startLine: 9, endLine: 9 }), { startLine: 15, endLine: 15 });
});

/* ------------------------------------------------------------------ */
/* out to a pixel and back                                             */
/* ------------------------------------------------------------------ */
//
// The other half of the module: the preview's own line <-> pixel mapping with
// the shift applied around it, which is what the viewer calls on every scroll
// event. A fake tree is enough here — `scrollSyncBlockMapping.test.ts` drives
// the same pair over real `processMarkdownHtml` output — because what is under
// test is the composition, not the descent.

type FakeBlock = {
	nodeType: number;
	tagName: string;
	childNodes: FakeBlock[];
	getAttribute(name: string): string | null;
	top: number;
	height: number;
};

function block(line: number, top: number, height: number): FakeBlock {
	return {
		nodeType: 1,
		tagName: 'P',
		childNodes: [],
		getAttribute: (name) => (name === 'data-sourcepos' ? `${line}:1-${line}:10` : null),
		top,
		height,
	};
}

/**
 * Three rendered blocks, on BODY lines 1, 5 and 9. They start 200px down
 * because the front matter renders as a panel above them — which is the point:
 * neither the pixels nor the `data-sourcepos` lines know anything about the six
 * buffer lines of YAML the editor is holding.
 */
const BLOCKS = [block(1, 200, 40), block(5, 300, 40), block(9, 500, 60)];
const ROOT: FakeBlock = {
	nodeType: 1,
	tagName: 'DIV',
	childNodes: BLOCKS,
	getAttribute: () => null,
	top: 0,
	height: 600,
};

const measure = (node: unknown) => ({ top: (node as FakeBlock).top, height: (node as FakeBlock).height });

test('a preview offset answers in buffer lines, and takes them back', () => {
	const coords = lineCoordinates(WITH_FRONT_MATTER);

	// The first block is body line 1, which is buffer line 7.
	assert.equal(coords.bufferLineAtPreviewOffset(ROOT, 200, measure), 7);
	assert.equal(coords.previewOffsetForBufferLine(ROOT, asBufferLine(7), measure), 200);

	// Halfway between the first two samples in lines is halfway in pixels.
	assert.equal(coords.bufferLineAtPreviewOffset(ROOT, 250, measure), 9);
	assert.equal(coords.previewOffsetForBufferLine(ROOT, asBufferLine(9), measure), 250);

	// Every sample, both ways round.
	for (const line of [7, 9, 11, 13, 15] as BufferLine[]) {
		const offset = coords.previewOffsetForBufferLine(ROOT, line, measure);
		assert.ok(offset !== null, `no offset for buffer line ${line}`);
		assert.equal(coords.bufferLineAtPreviewOffset(ROOT, offset, measure), line, `buffer line ${line}`);
	}
});

test('the same preview, read without the shift, is six lines out', () => {
	// The control, and the defect this module exists to make unrepresentable: a
	// caller that treats the preview's own numbering as the editor's is off by
	// the height of the front matter everywhere, uniformly, however good the
	// block mapping underneath it is.
	const plain = lineCoordinates('# Title\n');
	assert.equal(plain.bufferLineAtPreviewOffset(ROOT, 200, measure), 1);
	assert.equal(
		lineCoordinates(WITH_FRONT_MATTER).bufferLineAtPreviewOffset(ROOT, 200, measure)! -
			plain.bufferLineAtPreviewOffset(ROOT, 200, measure)!,
		FRONT_MATTER_LINES,
	);
});

test('a preview with nothing annotated in it answers nothing, not line zero', () => {
	// The caller falls back to the proportional mapping on `null`. A `0` would
	// be a buffer line, and would send the pane to the top of the document.
	const coords = lineCoordinates(WITH_FRONT_MATTER);
	const empty: FakeBlock = { nodeType: 1, tagName: 'DIV', childNodes: [], getAttribute: () => null, top: 0, height: 0 };

	assert.equal(coords.bufferLineAtPreviewOffset(empty, 400, measure), null);
	assert.equal(coords.previewOffsetForBufferLine(empty, asBufferLine(12), measure), null);
});
