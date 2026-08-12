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
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { installShimDom, parseHtml, type ShimElement } from './renderProtocolDom.ts';

// ---------------------------------------------------------------- environment

const g = globalThis as any;
const runeEffect = (fn: () => void) => {
	void fn;
};
runeEffect.root = (fn: () => unknown) => fn();
g.$state = (value: unknown) => value;
g.$state.raw = (value: unknown) => value;
g.$state.snapshot = (value: unknown) => value;
g.$derived = (value: unknown) => value;
g.$derived.by = (fn: () => unknown) => fn();
g.$effect = runeEffect;
g.window = g.window ?? {};
g.window.__TAURI_INTERNALS__ = g.window.__TAURI_INTERNALS__ ?? {
	metadata: { currentWindow: { label: 'main' }, currentWebview: { windowLabel: 'main', label: 'main' } },
	invoke: (cmd: string) => Promise.resolve(cmd === 'get_os_type' ? 'macos' : null),
};

const localStore = new Map<string, string>();
g.localStorage = g.localStorage ?? {
	getItem: (key: string) => (localStore.has(key) ? localStore.get(key)! : null),
	setItem: (key: string, value: string) => void localStore.set(key, String(value)),
	removeItem: (key: string) => void localStore.delete(key),
	clear: () => localStore.clear(),
};

installShimDom();

const { tabManager } = await import('../src/lib/stores/tabs.svelte.js');
const { processMarkdownHtml } = await import('../src/lib/utils/markdown.ts');
const { findAnchorElement } = await import('../src/lib/utils/previewAnchor.ts');
const { asRendererLine, lineCoordinates } = await import('../src/lib/utils/lineCoordinates.ts');
const { snapshotTab, validateTransferPayload } = await import('../src/lib/utils/tabTransfer.ts');

type Tab = (typeof tabManager.tabs)[number];

function reset() {
	tabManager.closeAll();
	tabManager.recentlyClosed.length = 0;
	localStore.clear();
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

function render(doc: DocumentBuilder, path: string): ShimElement {
	return parseHtml(processMarkdownHtml(doc.html(), path, new Set<string>())).body;
}

const BODY_B = render(DOC_B, '/notes/b.md');

function textOf(element: unknown): string {
	return String((element as { textContent?: string }).textContent ?? '');
}

test('a line number carried over from the previous document resolves into this one', (t) => {
	// Every source line the reader could have been parked on in document A.
	const carried = DOC_A.lines;

	let resolved = 0;
	for (const line of carried) {
		if (findAnchorElement(BODY_B, line)) resolved += 1;
	}
	const percent = Math.round((resolved / carried.length) * 1000) / 10;

	t.diagnostic(`document A: ${carried.length} anchorable source lines`);
	t.diagnostic(`document B: ${BODY_B.querySelectorAll('[data-sourcepos]').length} blocks with data-sourcepos`);
	t.diagnostic(`carried anchors resolving inside document B: ${resolved}/${carried.length} (${percent}%)`);

	// This is the mechanism, not a property of these two fixtures: while the
	// carried line is inside the other document's range it resolves, the first
	// cascade entry reports success, and `scrollPercentage` and `scrollTop` —
	// the field the old `navigate()` reset — are never consulted.
	assert.ok(
		percent > 50,
		`a stale anchor line is expected to resolve in a document of similar length, got ${percent}%`,
	);

	// And it resolves to the wrong text: the block at that line in B, which
	// says `beta`, has nothing to do with the block the reader left in A.
	const sample = DOC_A.lines[Math.floor(DOC_A.lines.length / 2)];
	const match = findAnchorElement(BODY_B, sample)!;
	t.diagnostic(`line ${sample} of A resolves to B's ${textOf(match.element).trim().slice(0, 48)}`);
	assert.ok(match, `expected line ${sample} to resolve inside document B`);
	assert.match(textOf(match.element), /beta/);
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
