/**
 * A tab that is pointed at a different document must forget where the reader
 * was in the old one.
 *
 * `Tab` records the reading position four times, and both restore paths are
 * fallback cascades that stop at the first entry that resolves: the preview
 * tries `anchorLine`, then `scrollPercentage`, then `scrollTop`
 * (`MarkdownViewer.svelte:1133-1162`), and the editor tries `editorViewState`,
 * then `anchorLine`, then `scrollPercentage` (`components/Editor.svelte:290-311`).
 *
 * `navigate()` used to end with `tab.scrollTop = 0` and nothing else, which is
 * the entry each cascade consults LAST. For any tab that had actually been
 * scrolled, that reset was unreachable, and the next activation of the tab
 * restored the previous document's position into the new document. `goBack` and
 * `goForward` repoint a tab the same way and cleared nothing at all.
 *
 * Two things are checked here, and neither reads an implementation file as text:
 *
 *   - the REAL `TabManager`, driven through every route that changes which
 *     document a tab shows and every route that changes only its path;
 *   - the REAL `findAnchorElement` over the REAL `processMarkdownHtml` output of
 *     two DIFFERENT documents, which is what turns "the field is stale" into a
 *     rate: how often a line number carried over from document A resolves to
 *     some unrelated block of document B, so the cascade stops there and the
 *     later entries are never consulted.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS A `.spec.ts`
 *
 * It used to call `installShimDom()` from `renderProtocolDom.ts` and hand-write
 * the runes onto `globalThis`. Both are stand-ins, and under vitest both are
 * worse than what the environment already has: the shim ASSIGNS
 * `globalThis.document`, so it would replace jsdom's, and a hand-written
 * `$state` is not the compiler's — no deep proxying, and `$effect` never
 * re-runs. Every one of them is gone. `TabManager` is built by the Svelte
 * compiler and the document is jsdom's, so `DOMParser`, the HTML parser it
 * feeds, and `processMarkdownHtml`'s own DOM surgery are all the real ones.
 *
 * WHAT THE REAL DOM DOES AND DOES NOT SETTLE
 *
 * `findAnchorElement` is a walk over `data-sourcepos` ranges, `classList` and
 * `childNodes` — structure and attributes, every one of which jsdom answers
 * for real. It never measures anything, so nothing below needs a layout.
 *
 * jsdom has no layout: `offsetTop`, `offsetHeight` and every rect are 0. So the
 * question of WHERE a resolved anchor lands — `getAnchorScrollTop`, the
 * offset->line mapping, a collapsed fold's zero height — cannot be asked here
 * and is not asked here. Those tests supply their own geometry on purpose
 * (`scrollSyncAcrossFolds.test.ts` lays the document out with folds in it,
 * `anchorJumpUnderZoom.spec.ts` builds elements whose rects carry a zoom
 * factor). "It resolves" is a real answer; "it lands at 1420px" would not be.
 */

import assert from 'node:assert/strict';

import { test } from 'vitest';

// The runes are the compiler's, not ours: vitest builds `.svelte.ts` through the
// Svelte plugin. Only the Tauri backend, which jsdom cannot provide, is stubbed
// — `get_os_type` because importing the store boots the settings singleton, and
// a `null` answer to that one leaves the font defaults it indexes undefined.
(window as any).__TAURI_INTERNALS__ = {
	metadata: { currentWindow: { label: 'main' }, currentWebview: { windowLabel: 'main', label: 'main' } },
	invoke: (cmd: string) => Promise.resolve(cmd === 'get_os_type' ? 'macos' : null),
};

const { tabManager } = await import('../src/lib/stores/tabs.svelte.js');
const { processMarkdownHtml } = await import('../src/lib/utils/markdown.js');
const {
	findAnchorElement,
	parseSourceposLineRange,
	PREVIEW_ANCHOR_OFFSET,
	restorePreviewReadingPosition,
} = await import('../src/lib/utils/previewAnchor.js');
type AnchorNode = Parameters<typeof findAnchorElement>[0];
type AnchorBox = ReturnType<Parameters<typeof restorePreviewReadingPosition>[3]>;
const { asRendererLine, lineCoordinates } = await import('../src/lib/utils/lineCoordinates.js');
const { snapshotTab, validateTransferPayload } = await import('../src/lib/utils/tabTransfer.js');

type Tab = (typeof tabManager.tabs)[number];

function reset() {
	tabManager.closeAll();
	tabManager.recentlyClosed.length = 0;
	localStorage.clear();
}

/** A tab whose reader is a long way down a document, all four fields written. */
function openScrolledTab(path: string): Tab {
	tabManager.addTab(path, '# doc\n');
	const tab = tabManager.tabs.find((item) => item.path === path)!;
	tab.scrollTop = 4820;
	tab.scrollPercentage = 0.73;
	tab.anchorLine = asRendererLine(812);
	tab.editorViewState = { cursorState: 'monaco-live-object' };
	return tab;
}

/** Every field either restore cascade reads, in the order it reads them. */
function readingPosition(tab: Tab) {
	return {
		editorViewState: tab.editorViewState,
		anchorLine: tab.anchorLine,
		scrollPercentage: tab.scrollPercentage,
		scrollTop: tab.scrollTop,
	};
}

const AT_TOP = { editorViewState: null, anchorLine: 0, scrollPercentage: 0, scrollTop: 0 };

// --------------------------------------------- the routes that change document

test('following a link to another file leaves the tab at the top of it', () => {
	reset();
	const tab = openScrolledTab('/notes/a.md');

	tabManager.navigate(tab.id, '/notes/b.md');

	assert.equal(tab.path, '/notes/b.md');
	assert.deepEqual(readingPosition(tab), AT_TOP);
});

test('going back to the previous file leaves the tab at the top of it', () => {
	reset();
	const tab = openScrolledTab('/notes/a.md');
	tabManager.navigate(tab.id, '/notes/b.md');
	tab.anchorLine = asRendererLine(44);
	tab.scrollPercentage = 0.2;
	tab.scrollTop = 900;
	tab.editorViewState = { cursorState: 'monaco-live-object' };

	const back = tabManager.goBack(tab.id);

	assert.equal(back, '/notes/a.md');
	assert.equal(tab.path, '/notes/a.md');
	assert.deepEqual(readingPosition(tab), AT_TOP);
});

test('going forward again leaves the tab at the top of that file', () => {
	reset();
	const tab = openScrolledTab('/notes/a.md');
	tabManager.navigate(tab.id, '/notes/b.md');
	tabManager.goBack(tab.id);
	tab.anchorLine = asRendererLine(300);
	tab.scrollPercentage = 0.5;
	tab.scrollTop = 2000;
	tab.editorViewState = { cursorState: 'monaco-live-object' };

	const forward = tabManager.goForward(tab.id);

	assert.equal(forward, '/notes/b.md');
	assert.equal(tab.path, '/notes/b.md');
	assert.deepEqual(readingPosition(tab), AT_TOP);
});

// ------------------------------------- the routes that change only the path
//
// The document on screen does not change in either of these, so the reader has
// not moved and the position must survive. This is the half of the rule a
// blanket "clear on every path write" would break.

test('Save As renames the tab without moving the reader', () => {
	reset();
	const tab = openScrolledTab('/notes/a.md');
	const before = readingPosition(tab);

	tabManager.updateTabPath(tab.id, '/notes/copy.md');

	assert.equal(tab.path, '/notes/copy.md');
	assert.deepEqual(readingPosition(tab), before);
});

test('renaming the file on disk does not move the reader', () => {
	reset();
	const tab = openScrolledTab('/notes/a.md');
	const before = readingPosition(tab);

	tabManager.renameTab(tab.id, '/notes/renamed.md');

	assert.equal(tab.path, '/notes/renamed.md');
	assert.deepEqual(readingPosition(tab), before);
});

test('a link that resolves to the file already open is not a navigation', () => {
	reset();
	const tab = openScrolledTab('/notes/a.md');
	const before = readingPosition(tab);

	tabManager.navigate(tab.id, '/notes/a.md');

	assert.deepEqual(readingPosition(tab), before);
});

/* ------------------------------------------------------------------ */
/* what a carried-over anchor line does to the next document           */
/* ------------------------------------------------------------------ */

// comrak's shape, as recorded in renderProtocolFixtures.ts: every block carries
// a `data-sourcepos` line range, and `processMarkdownHtml` then re-parents
// everything after a heading into a wrapper that carries none.

class DocumentBuilder {
	private line = 1;
	private readonly parts: string[] = [];
	readonly lines: number[] = [];

	heading(text: string, slug: string) {
		const line = this.line;
		this.line += 2;
		this.lines.push(line);
		this.parts.push(
			`<h2 data-sourcepos="${line}:1-${line}:${text.length + 3}">` +
				`<a href="#${slug}" aria-hidden="true" class="anchor" id="${slug}"></a>${text}</h2>`,
		);
	}

	paragraph(text: string) {
		const line = this.line;
		this.line += 2;
		this.lines.push(line);
		this.parts.push(`<p data-sourcepos="${line}:1-${line}:${text.length}">${text}</p>`);
	}

	html() {
		return this.parts.join('\n') + '\n';
	}
}

/**
 * Two different documents. `paragraphsPerSection` is what makes them different
 * documents rather than two renders of one: the same source line lands in a
 * different section of each.
 */
function buildDocument(name: string, sections: number, paragraphsPerSection: number) {
	const doc = new DocumentBuilder();
	for (let s = 1; s <= sections; s += 1) {
		doc.heading(`${name} section ${s}`, `${name}-section-${s}`);
		for (let p = 1; p <= paragraphsPerSection; p += 1) {
			doc.paragraph(`${name} section ${s} paragraph ${p}, a sentence of prose.`);
		}
	}
	return doc;
}

const DOC_A = buildDocument('alpha', 60, 6);
const DOC_B = buildDocument('beta', 40, 11);

/**
 * The rendered article, in the element the restore actually walks: the preview
 * hands `findAnchorElement` its `.markdown-body` container
 * (`MarkdownViewer.svelte:1223`), which is the element the sanitized string was
 * parsed into.
 */
function render(doc: DocumentBuilder, path: string): HTMLElement {
	const body = document.createElement('div');
	body.className = 'markdown-body';
	body.innerHTML = processMarkdownHtml(doc.html(), path, new Set<string>());
	return body;
}

const BODY_B = render(DOC_B, '/notes/b.md');

test('a line number carried over from the previous document resolves into this one', () => {
	// The fixture is the real pipeline's output, so say what it produced: a
	// document of nothing but headings and paragraphs is one where every block
	// after the first heading is inside a `.foldable-content-wrapper` that
	// carries no source range of its own, which is the shape the descent exists
	// for.
	const blocks = BODY_B.querySelectorAll('[data-sourcepos]').length;
	assert.equal(blocks, 40 + 40 * 11, 'every block of document B is annotated');
	assert.ok(
		BODY_B.querySelectorAll('.foldable-content-wrapper:not([data-sourcepos])').length > 0,
		'and the sections are wrapped in containers that are not',
	);

	// Every source line the reader could have been parked on in document A.
	const carried = DOC_A.lines;

	let resolved = 0;
	for (const line of carried) {
		if (findAnchorElement(BODY_B, line)) resolved += 1;
	}
	const percent = Math.round((resolved / carried.length) * 1000) / 10;

	// This is the mechanism, not a property of these two fixtures: while the
	// carried line is inside the other document's range it resolves, the first
	// cascade entry reports success, and `scrollPercentage` and `scrollTop` —
	// the field the old `navigate()` reset — are never consulted.
	assert.ok(
		percent > 50,
		`a stale anchor line is expected to resolve in a document of similar length, ` +
			`got ${resolved}/${carried.length} (${percent}%) over ${blocks} annotated blocks`,
	);

	// And it resolves to the wrong text: the block at that line in B, which
	// says `beta`, has nothing to do with the block the reader left in A.
	const sample = DOC_A.lines[Math.floor(DOC_A.lines.length / 2)];
	const match = findAnchorElement(BODY_B, sample);
	assert.ok(match, `expected line ${sample} to resolve inside document B`);
	assert.match(
		(match.element as Element).textContent ?? '',
		/beta/,
		`line ${sample} of document A resolves to a block of document B`,
	);
});

test('a cleared reading position resolves to nothing, so the cascade falls through to the top', () => {
	reset();
	const tab = openScrolledTab('/notes/a.md');
	tabManager.navigate(tab.id, '/notes/b.md');

	// Stage 1 of the preview cascade is guarded on `anchorLine > 0`, and
	// `findAnchorElement` refuses a non-positive line outright. Asserted as a
	// boolean: a returned match holds a live DOM node whose parent chain the
	// assertion printer would try to serialize.
	assert.ok(
		findAnchorElement(BODY_B, tab.anchorLine) === null,
		'a cleared anchorLine must not resolve to an element in the new document',
	);
	// Stage 2 is guarded on `scrollPercentage > 0`, so the cascade reaches
	// stage 3 — and stage 3 is the top of the document.
	assert.equal(tab.scrollPercentage, 0);
	assert.equal(tab.scrollTop, 0);
});

/* ------------------------------------------------------------------ */
/* which numbering the anchor is in                                    */
/* ------------------------------------------------------------------ */
//
// `anchorLine` is a RENDERER line. `getPreviewScrollAnchor` writes it off
// `data-sourcepos` and the restore above reads it back with
// `findAnchorElement` against the same attributes, and both of those count
// from the first line of the BODY — while the editor's own line numbers count
// from the first line of the FILE. In a document with front matter the two
// differ by its height, and #607 made that difference a TYPE so that a
// crossing which forgets to convert cannot compile.
//
// The brand has no run-time representation, so the assertion cannot be an
// `assert`. It is the `@ts-expect-error` comments below, which invert into
// exactly the failure wanted: if the brand is ever dropped, those lines start
// compiling, and `npm run check` fails them as unused directives.

/** Six buffer lines of YAML above the body, so the two numberings differ by 6. */
const WITH_FRONT_MATTER = ['---', 'title: "T"', 'tags:', '  - a', '---', '', '# Title'].join('\n') + '\n';

test('the tab anchor is a renderer line, and only converts one way round', () => {
	reset();
	const tab = openScrolledTab('/notes/a.md');
	const coords = lineCoordinates(WITH_FRONT_MATTER);

	// What the brand permits, and the conversion any caller aiming the EDITOR
	// with this field owes: line 812 of the body is line 818 of the buffer.
	assert.equal(coords.toBufferLine(tab.anchorLine), 818);
	assert.equal(coords.toRendererLine(coords.toBufferLine(tab.anchorLine)), 812);

	// What it forbids. First the crossing read backwards — treating the anchor
	// as if it were already on the editor's numbering, which is the shape a
	// caller reaches for when it does not know which side of the shift it is
	// on.
	// @ts-expect-error `Tab.anchorLine` is a RendererLine; `toRendererLine` wants a BufferLine
	coords.toRendererLine(tab.anchorLine);

	// Then the write. This one is last because it does go through at run time:
	// a Monaco line stored as the reading position, which is what sends the
	// preview restore the height of the front matter too far down the
	// document. Before the brand it compiled.
	// @ts-expect-error a BufferLine is not assignable to `Tab.anchorLine`
	tab.anchorLine = coords.toBufferLine(tab.anchorLine);
});

test('branding both sides of a snapshot changes none of its bytes', () => {
	reset();
	const tab = openScrolledTab('/notes/a.md');

	// The brand is phantom, so it cannot survive JSON and nothing on the wire
	// should have moved. Both persisted forms are checked, because both were
	// re-declared on the way back in: the cross-window transfer payload, and
	// the window-state snapshot in localStorage.
	const wire = JSON.stringify(snapshotTab(tab));
	assert.equal(JSON.parse(wire).anchorLine, 812);

	const arrived = validateTransferPayload(wire);
	assert.ok(arrived, 'a snapshot of a real tab must validate');
	assert.equal(arrived.anchorLine, 812);

	tabManager.restoreState(tabManager.serializeState());
	assert.equal(tabManager.tabs.find((item) => item.path === '/notes/a.md')?.anchorLine, 812);
});

/* ------------------------------------------------------------------ */
/* the arrival of a tab from another window                            */
/* ------------------------------------------------------------------ */
//
// The transfer payload carries all three fields (`tabTransfer.ts`), so the
// destination has everything it needs — and used to open the document at the
// top anyway, because of WHEN it asked.
//
// `insertTransferredTab` pushes the tab and activates it synchronously, while
// its rendered `content` is still the `''` every construction site seeds. The
// preview's restore effect runs on that activation, against a host holding no
// document; `acceptTransferredTab` only awaits `renderTabPreviewFromRaw`
// afterwards, and nothing re-triggers the effect when that document lands (it
// depends on the tab id, the article and the path — deliberately not on the
// render, which also fires on every debounced re-render while the reader is
// typing in split view).
//
// The two tests below are the two moments, run against the REAL cascade over
// the REAL `processMarkdownHtml` output of the document being transferred.
// What they cannot be is a live drag: two windows and a Rust broker are not
// reachable from here, so the sequence is replayed rather than performed, and
// the wiring that performs it is asserted in `tabTransferHandoff.test.ts`.

/**
 * A layout in which every source line is `LINE_HEIGHT` tall.
 *
 * jsdom reports 0 for every offset, so the geometry is the fixture — as in
 * `scrollSyncAcrossFolds.test.ts` and `anchorJumpUnderZoom.spec.ts`. Deriving
 * it from the element's own `data-sourcepos` is what makes the expected
 * scrollTop below a number this file can state rather than read back.
 */
const LINE_HEIGHT = 24;

function measureBySourcepos(node: AnchorNode): AnchorBox {
	const range = parseSourceposLineRange(node.getAttribute?.('data-sourcepos'));
	if (!range) return { top: Number.NaN, height: Number.NaN };
	return {
		top: (range.startLine - 1) * LINE_HEIGHT,
		height: (range.endLine - range.startLine + 1) * LINE_HEIGHT,
	};
}

/**
 * The article the preview scrolls. Its scroll range is passed to the restore
 * rather than read off it, so it is stated here: nothing to scroll while the
 * host is empty, a tall document once one has been patched in.
 */
function emptyPreview(): HTMLElement {
	const host = document.createElement('div');
	host.className = 'markdown-body';
	return host;
}

function scrollMaxOf(host: HTMLElement): number {
	return host.innerHTML === '' ? 0 : 40_000 - 900;
}

/** A tab that left another window with its reader parked on `anchorLine`. */
function arriveFromAnotherWindow(anchorLine: number): Tab {
	tabManager.addTab('/notes/b.md', DOC_B.html());
	const source = tabManager.tabs.find((item) => item.path === '/notes/b.md')!;
	source.scrollTop = 4820;
	source.scrollPercentage = 0.73;
	source.anchorLine = asRendererLine(anchorLine);

	const payload = validateTransferPayload(JSON.stringify(snapshotTab(source)));
	assert.ok(payload, 'a snapshot of a real tab must validate');

	// The destination window, which has never seen this document.
	tabManager.closeAll();
	const id = tabManager.insertTransferredTab(payload);
	return tabManager.tabs.find((item) => item.id === id)!;
}

/** A heading line, so the block spans one line and the interpolation is exact. */
const ARRIVAL_LINE = DOC_B.lines[Math.floor(DOC_B.lines.length / 2)];

test('a transferred tab is activated before its document exists, so the restore then has nothing to work with', () => {
	reset();
	const arrived = arriveFromAnotherWindow(ARRIVAL_LINE);

	// The three fields survived the wire, and the tab is already the active one.
	assert.equal(arrived.anchorLine, ARRIVAL_LINE);
	assert.equal(arrived.scrollPercentage, 0.73);
	assert.equal(arrived.scrollTop, 4820);
	assert.equal(tabManager.activeTabId, arrived.id);
	assert.equal(arrived.content, '', 'the rendered document has not been built yet');

	const host = emptyPreview();

	// Every entry of the cascade in turn: no block owns the line because there
	// are no blocks, there is no scroll range for the percentage, and the pixel
	// offset has nowhere to go. Asserted on the returned entry rather than on
	// `host.scrollTop`, because jsdom stores whatever is assigned to `scrollTop`
	// while a real container clamps it to a range that here is empty.
	assert.equal(restorePreviewReadingPosition(host, arrived, scrollMaxOf(host), measureBySourcepos), 'nothing');
	assert.equal(findAnchorElement(host, arrived.anchorLine), null);
});

test('the same cascade, run once the arriving document is in, puts the reader back', () => {
	reset();
	const arrived = arriveFromAnotherWindow(ARRIVAL_LINE);
	const host = emptyPreview();

	// What `renderTabPreviewFromRaw` leaves behind: the tab's own buffer through
	// the real pipeline, patched into the host it just awaited a flush for.
	host.innerHTML = processMarkdownHtml(DOC_B.html(), arrived.path, new Set<string>());

	assert.equal(restorePreviewReadingPosition(host, arrived, scrollMaxOf(host), measureBySourcepos), 'anchor');
	// The first entry of the cascade answered, so the answer is the anchor's:
	// the line's own box, pinned `PREVIEW_ANCHOR_OFFSET` below the top.
	assert.equal(host.scrollTop, (ARRIVAL_LINE - 1) * LINE_HEIGHT - PREVIEW_ANCHOR_OFFSET);
	assert.notEqual(host.scrollTop, 0);
});
