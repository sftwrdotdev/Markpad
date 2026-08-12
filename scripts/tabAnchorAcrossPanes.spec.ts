/**
 * One tab, two panes, one anchor line — and a document with front matter, which
 * is the only kind of document that can tell whether the two panes agree about
 * what a line number means.
 *
 * `tab.anchorLine` is where the reader was. The preview writes it off
 * `data-sourcepos`, which counts from the first line of the BODY; the editor
 * writes it off Monaco, which counts from the first line of the FILE. Each pane
 * read its own writes back the way it made them, so each looked correct on its
 * own, and every switch between them landed the height of the front matter
 * away. Without front matter the two numberings coincide and the defect is
 * invisible — which is what every earlier fixture was, and why this one is not.
 *
 * So both directions are driven end to end here, and what is asserted is where
 * the READER ends up, not the number in the field:
 *
 *   preview scroll offset -> anchor -> editor's reveal line -> the text there
 *   editor top line       -> anchor -> preview's anchor element -> its text
 *
 * The pieces are the real ones on both sides — `processMarkdownHtml`'s output,
 * `getSourceLineAtPreviewOffset`, `findAnchorElement`, `getAnchorScrollTop`,
 * the real `TabManager` — and the crossing itself is imported rather than
 * re-implemented, because a test that re-derives the shift cannot notice the
 * component forgetting it.
 *
 * What is injected is layout: jsdom has none, and `measure` is a parameter of
 * the mapping for exactly this reason. The numbers below are not a claim about
 * how a browser lays a paragraph out; the property under test only needs blocks
 * to be somewhere, in order.
 */

import assert from 'node:assert/strict';

import { test } from 'vitest';

(window as any).__TAURI_INTERNALS__ = {
	metadata: { currentWindow: { label: 'main' }, currentWebview: { windowLabel: 'main', label: 'main' } },
	invoke: (cmd: string) => Promise.resolve(cmd === 'get_os_type' ? 'macos' : null),
};

const { tabManager } = await import('../src/lib/stores/tabs.svelte.js');
const { processMarkdownHtml } = await import('../src/lib/utils/markdown.js');
const { findAnchorElement, getAnchorScrollTop, getSourceLineAtPreviewOffset, PREVIEW_ANCHOR_OFFSET } = await import(
	'../src/lib/utils/previewAnchor.js'
);
const {
	asBufferLine,
	asRendererLine,
	editorTopLineForTabAnchor,
	lineCoordinates,
	tabAnchorForEditorTopLine,
	EDITOR_ANCHOR_LINE_OFFSET,
} = await import('../src/lib/utils/lineCoordinates.js');

/* ------------------------------------------------------------------ */
/* one document, written twice: as a file and as its render            */
/* ------------------------------------------------------------------ */

/**
 * comrak's shape, as the render-protocol fixtures record it: a `data-sourcepos`
 * range on every block, counted from the first line of the BODY. The file the
 * user edits is built line for line beside it, front matter included, so the
 * two differ by exactly the thing under test.
 */
class Fixture {
	readonly bodyLines: string[] = [];
	private readonly parts: string[] = [];
	private readonly lines = new Map<string, number>();

	private push(source: string, html: (line: number) => string) {
		this.bodyLines.push(source, '');
		const line = this.bodyLines.length - 1;
		this.lines.set(source, line);
		this.parts.push(html(line));
	}

	heading(text: string, slug: string) {
		this.push(
			`## ${text}`,
			(line) =>
				`<h2 data-sourcepos="${line}:1-${line}:${text.length + 3}">` +
				`<a href="#${slug}" aria-hidden="true" class="anchor" id="${slug}"></a>${text}</h2>`,
		);
	}

	paragraph(text: string) {
		this.push(text, (line) => `<p data-sourcepos="${line}:1-${line}:${text.length}">${text}</p>`);
	}

	html() {
		return this.parts.join('\n') + '\n';
	}
}

/** Five lines of YAML and the blank line after it: the body starts at file line 7. */
const FRONT_MATTER = ['---', 'title: Anchored', 'tags:', '  - front matter', '---', ''];

const DOC = new Fixture();
for (const section of ['alpha', 'beta', 'gamma', 'delta']) {
	DOC.heading(`${section} section`, `${section}-section`);
	for (let p = 1; p <= 4; p += 1) {
		DOC.paragraph(`${section} paragraph ${p}, a sentence of prose.`);
	}
}

const FILE_LINES = [...FRONT_MATTER, ...DOC.bodyLines];
const RAW = FILE_LINES.join('\n');
const COORDS = lineCoordinates(RAW);
const PATH = '/notes/anchored.md';

/** The line of the FILE a block sits on: 1-based, front matter counted. */
function fileLine(text: string): number {
	const index = FILE_LINES.indexOf(text);
	assert.notEqual(index, -1, `${text} is not a line of the fixture`);
	return index + 1;
}

/** The document the preview walks: `.markdown-body`, holding the real pipeline's output. */
const BODY = (() => {
	const body = document.createElement('div');
	body.className = 'markdown-body';
	body.innerHTML = processMarkdownHtml(DOC.html(), PATH, new Set<string>());
	return body;
})();

/* ------------------------------------------------------------------ */
/* the layout jsdom does not have                                      */
/* ------------------------------------------------------------------ */

const BLOCK_HEIGHT = 100;

/** Does anything in here carry a source range? Anything else gets no box. */
function isAnnotated(element: Element): boolean {
	return element.hasAttribute('data-sourcepos') || Array.from(element.children).some(isAnnotated);
}

/**
 * Every annotated block gets a top and a height, children stacked inside their
 * parent in document order — bottom-up, so a container's box really does
 * contain its children's, which is the one property the descent relies on.
 */
const BOXES = (() => {
	const boxes = new Map<Element, { top: number; height: number }>();

	const place = (element: Element, top: number): number => {
		const children = Array.from(element.children).filter(isAnnotated);
		if (children.length === 0) {
			boxes.set(element, { top, height: BLOCK_HEIGHT });
			return BLOCK_HEIGHT;
		}

		let cursor = top;
		for (const child of children) cursor += place(child, cursor);
		boxes.set(element, { top, height: cursor - top });
		return cursor - top;
	};

	place(BODY, 0);
	return boxes;
})();

const measure = (node: unknown) => BOXES.get(node as Element) ?? { top: 0, height: 0 };

function blockAt(text: string): Element {
	const element = Array.from(BODY.querySelectorAll('[data-sourcepos]')).find((node) => node.textContent === text);
	assert.ok(element, `${text} was not rendered as a block of its own`);
	return element;
}

function openTab() {
	tabManager.closeAll();
	localStorage.clear();
	tabManager.addTab(PATH, RAW);
	return tabManager.tabs.find((item) => item.path === PATH)!;
}

/** Not the first paragraph of its section, so the two lines above it are prose. */
const READING = 'gamma paragraph 3, a sentence of prose.';

test('the fixture is a document whose two numberings differ', () => {
	assert.equal(COORDS.frontMatterLines, FRONT_MATTER.length);
	assert.equal(fileLine(READING), COORDS.toBufferLine(asRendererLine(fileLine(READING) - FRONT_MATTER.length)));
});

/* ------------------------------------------------------------------ */
/* preview -> editor                                                   */
/* ------------------------------------------------------------------ */

test('a tab scrolled in the preview opens the editor on the line the reader was reading', () => {
	const tab = openTab();

	// What the reader did: scrolled the preview until READING sat at the offset
	// the anchor is measured at. `getPreviewScrollAnchor` rounds what the
	// mapping answers and hands it straight over.
	const anchor = getSourceLineAtPreviewOffset(BODY, measure(blockAt(READING)).top, measure);
	assert.ok(anchor !== null, 'the preview must resolve a source line for a block it laid out');
	tabManager.updateTabAnchorLine(tab.id, asRendererLine(Math.round(anchor)));

	// What the editor does with it: reveals a line near the top of its viewport.
	const top = editorTopLineForTabAnchor(COORDS, tab.anchorLine);

	assert.equal(
		FILE_LINES[top - 1],
		'gamma paragraph 2, a sentence of prose.',
		'the editor opens with the paragraph before the reader at the top of the viewport',
	);
	assert.equal(
		FILE_LINES[top - 1 + EDITOR_ANCHOR_LINE_OFFSET],
		READING,
		'and the paragraph the reader was on where the anchor puts it',
	);
});

/* ------------------------------------------------------------------ */
/* editor -> preview                                                   */
/* ------------------------------------------------------------------ */

test('a tab scrolled in the editor opens the preview on the block the reader was reading', () => {
	const tab = openTab();

	// What Monaco reports on the way out: the buffer line at the top of the
	// viewport, with READING the anchor's distance below it.
	const topLine = asBufferLine(fileLine(READING) - EDITOR_ANCHOR_LINE_OFFSET);
	tabManager.updateTabAnchorLine(tab.id, tabAnchorForEditorTopLine(COORDS, topLine));

	const match = findAnchorElement(BODY, tab.anchorLine);
	assert.ok(match, 'the recorded anchor must resolve to a rendered block');
	assert.equal(
		(match.element as unknown as Element).textContent,
		READING,
		'the preview restores to the block the reader left the editor on',
	);

	// And it puts that block where the capture side measures from, so a reader
	// bouncing between the panes stays put rather than creeping down the page.
	const box = measure(match.element);
	assert.equal(
		getAnchorScrollTop(box.top, box.height, match, tab.anchorLine, PREVIEW_ANCHOR_OFFSET),
		Math.max(0, box.top - PREVIEW_ANCHOR_OFFSET),
	);
});

/* ------------------------------------------------------------------ */
/* that the brand is still there                                       */
/* ------------------------------------------------------------------ */
//
// The brand has no run-time representation, so this cannot be an `assert`. It
// is the `@ts-expect-error` directives below, which invert into the failure
// wanted: if `updateTabAnchorLine` ever goes back to taking a plain `number`,
// these lines compile and `npm run check` fails them as UNUSED directives.

test('the anchor cannot be written in the editor’s numbering by accident', () => {
	const tab = openTab();
	tabManager.updateTabAnchorLine(tab.id, asRendererLine(12));

	// A Monaco line, which is what this call used to be handed.
	// @ts-expect-error `updateTabAnchorLine` takes a RendererLine; this is a BufferLine
	tabManager.updateTabAnchorLine(tab.id, COORDS.toBufferLine(tab.anchorLine));

	// And a bare number, which does not say which of the two it is.
	// @ts-expect-error a plain `number` no longer claims a numbering
	tabManager.updateTabAnchorLine(tab.id, 812);
});
