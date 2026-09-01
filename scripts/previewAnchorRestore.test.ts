/**
 * Preview scroll restore: does an anchor line actually resolve to an element?
 *
 * The restore path in `MarkdownViewer.svelte` takes the saved `tab.anchorLine`
 * and looks for the rendered element whose `data-sourcepos` range contains that
 * line. Before this fix it only walked `body.children`, but `processMarkdownHtml`
 * moves everything after a heading into a JS-created `.foldable-content-wrapper`
 * that carries no `data-sourcepos` — so the only top-level elements left with a
 * source range are the *shallowest* headings. An anchor resolved only when it
 * happened to land exactly on one of those heading lines.
 *
 * This file measures that as a rate rather than asserting "it runs":
 *
 *   - `legacyTopLevelMatch` is the pre-fix algorithm, restated verbatim over
 *     the same DOM. It is kept here as the control; if the fix ever regresses
 *     into a top-level-only scan the two rates collapse into each other.
 *   - `findAnchorElement` is the shipped implementation.
 *
 * Both run over real `processMarkdownHtml` output (via the `renderProtocolDom`
 * shim, same as `renderProtocol.test.ts`). The input HTML is generated in the
 * shape comrak emits — the tag/attribute shape is taken from the recorded
 * `convert_markdown` output in `renderProtocolFixtures.ts`.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { installShimDom, parseHtml, NODE_ELEMENT, type ShimElement } from './renderProtocolDom.ts';
import { readSource } from './sourceTree.js';

installShimDom();

const { processMarkdownHtml } = await import('../src/lib/utils/markdown.ts');
const { findAnchorElement, getAnchorScrollTop, parseSourceposLineRange } = await import(
	'../src/lib/utils/previewAnchor.ts'
);

const FILE_PATH = '/documents/notes.md';

/* ------------------------------------------------------------------ */
/* comrak-shaped document generator                                    */
/* ------------------------------------------------------------------ */

type Block = { startLine: number; endLine: number };

class DocumentBuilder {
	private line = 1;
	private readonly parts: string[] = [];
	readonly blocks: Block[] = [];

	blank() {
		this.line += 1;
	}

	heading(level: number, text: string, slug: string) {
		const line = this.line;
		this.line += 1;
		this.blocks.push({ startLine: line, endLine: line });
		this.parts.push(
			`<h${level} data-sourcepos="${line}:1-${line}:${level + 1 + text.length}">` +
				`<a href="#${slug}" aria-hidden="true" class="anchor" id="${slug}"></a>${text}</h${level}>`,
		);
	}

	paragraph(text: string) {
		const line = this.line;
		this.line += 1;
		this.blocks.push({ startLine: line, endLine: line });
		this.parts.push(`<p data-sourcepos="${line}:1-${line}:${text.length}">${text}</p>`);
	}

	list(items: string[]) {
		const start = this.line;
		const end = start + items.length - 1;
		const itemHtml = items.map((item, index) => {
			const itemLine = start + index;
			return `<li data-sourcepos="${itemLine}:1-${itemLine}:${item.length + 2}">${item}</li>`;
		});
		this.blocks.push({ startLine: start, endLine: end });
		this.parts.push(`<ul data-sourcepos="${start}:1-${end}:${items[items.length - 1].length + 2}">\n${itemHtml.join('\n')}\n</ul>`);
		this.line = end + 1;
	}

	/**
	 * A paragraph the author soft-wrapped over several source lines.
	 * `convert_markdown` sets `render.hardbreaks`, so comrak ends every line but
	 * the last with `<br data-sourcepos="…" />` — the exact shape recorded in
	 * `renderProtocolFixtures.ts`. Every one of those `br`s is a `[data-sourcepos]`
	 * element that `findAnchorElement` can descend into and that reports
	 * `offsetTop === 0, offsetHeight === 0` to the restore.
	 */
	wrappedParagraph(lines: string[]) {
		const start = this.line;
		const end = start + lines.length - 1;
		const html = lines
			.map((text, index) =>
				index === lines.length - 1
					? text
					: `${text}<br data-sourcepos="${start + index}:${text.length + 1}-${start + index}:${text.length + 1}" />\n`,
			)
			.join('');
		this.blocks.push({ startLine: start, endLine: end });
		this.parts.push(`<p data-sourcepos="${start}:1-${end}:${lines[lines.length - 1].length}">${html}</p>`);
		this.line = end + 1;
	}

	code(lines: string[]) {
		const start = this.line;
		const end = start + lines.length + 1;
		this.blocks.push({ startLine: start, endLine: end });
		this.parts.push(
			`<pre data-sourcepos="${start}:1-${end}:3"><code class="language-sh">${lines.join('\n')}\n</code></pre>`,
		);
		this.line = end + 1;
	}

	get lineCount() {
		return this.line - 1;
	}

	html() {
		return this.parts.join('\n') + '\n';
	}
}

/**
 * One section body: the block mix a real document repeats between headings.
 * Sized at 20 source lines so a 477-heading document lands near the 10k lines
 * the audit measured.
 */
function sectionBody(doc: DocumentBuilder, seed: number) {
	doc.blank();
	doc.paragraph(`Prose paragraph ${seed} explaining the section in a sentence.`);
	doc.blank();
	doc.list([`item ${seed} alpha`, `item ${seed} beta`, `item ${seed} gamma`]);
	doc.blank();
	doc.paragraph(`Second prose paragraph ${seed} with a little more detail.`);
	doc.blank();
	doc.code([`echo section-${seed}`, `run --flag ${seed}`]);
	doc.blank();
	doc.paragraph(`Third prose paragraph ${seed}, the one after the code block.`);
	doc.blank();
	doc.list([`follow-up ${seed} one`, `follow-up ${seed} two`, `follow-up ${seed} three`]);
	doc.blank();
}

/** A flat document: every heading is an `h2`, so all of them stay top level. */
function buildFlatDocument(sections: number) {
	const doc = new DocumentBuilder();
	doc.paragraph('Intro paragraph before the first heading.');
	doc.blank();
	for (let i = 1; i <= sections; i += 1) {
		doc.heading(2, `Section ${i}`, `section-${i}`);
		sectionBody(doc, i);
	}
	return doc;
}

/** A nested document: `h1 > h2 > h3`, so only the `h1`s stay top level. */
function buildNestedDocument(chapters: number) {
	const doc = new DocumentBuilder();
	doc.paragraph('Intro paragraph before the first heading.');
	doc.blank();
	for (let c = 1; c <= chapters; c += 1) {
		doc.heading(1, `Chapter ${c}`, `chapter-${c}`);
		sectionBody(doc, c * 100);
		doc.heading(2, `Chapter ${c} Section`, `chapter-${c}-section`);
		sectionBody(doc, c * 100 + 1);
		doc.heading(3, `Chapter ${c} Unit`, `chapter-${c}-unit`);
		sectionBody(doc, c * 100 + 2);
	}
	return doc;
}

/* ------------------------------------------------------------------ */
/* measurement                                                         */
/* ------------------------------------------------------------------ */

function elementChildren(node: ShimElement): ShimElement[] {
	return node.childNodes.filter((child): child is ShimElement => child.nodeType === NODE_ELEMENT);
}

/**
 * The pre-fix restore loop, restated: scan `body.children` only, take the first
 * child whose own `data-sourcepos` range contains the line.
 */
function legacyTopLevelMatch(body: ShimElement, line: number) {
	for (const el of elementChildren(body)) {
		const sourcepos = el.getAttribute('data-sourcepos');
		if (!sourcepos) continue;
		const [start, end] = sourcepos.split('-');
		const startLine = parseInt(start.split(':')[0], 10);
		const endLine = parseInt(end.split(':')[0], 10);
		if (Number.isNaN(startLine) || Number.isNaN(endLine)) continue;
		if (line >= startLine && line <= endLine) return { startLine, endLine };
	}
	return null;
}

/** Every source line the renderer attributed to some block, sampled evenly. */
function sampleAnchorLines(blocks: Block[], count: number): number[] {
	const lines = new Set<number>();
	for (const block of blocks) {
		for (let line = block.startLine; line <= block.endLine; line += 1) lines.add(line);
	}
	const all = [...lines].sort((a, b) => a - b);
	const step = all.length / count;
	const sampled: number[] = [];
	for (let i = 0; i < count; i += 1) sampled.push(all[Math.floor(i * step)]);
	return sampled;
}

type Rate = { hits: number; total: number; percent: number };

function rate(hits: number, total: number): Rate {
	return { hits, total, percent: Math.round((hits / total) * 1000) / 10 };
}

function measure(doc: DocumentBuilder, sampleSize: number) {
	const body = parseHtml(processMarkdownHtml(doc.html(), FILE_PATH, new Set())).body;
	const anchors = sampleAnchorLines(doc.blocks, sampleSize);

	let legacyHits = 0;
	let fixedHits = 0;
	for (const line of anchors) {
		const legacy = legacyTopLevelMatch(body, line);
		if (legacy && line >= legacy.startLine && line <= legacy.endLine) legacyHits += 1;

		const fixed = findAnchorElement(body, line);
		if (fixed && line >= fixed.startLine && line <= fixed.endLine) fixedHits += 1;
	}

	const topLevel = elementChildren(body);
	return {
		body,
		anchors,
		annotatedElements: body.querySelectorAll('[data-sourcepos]').length,
		topLevelChildren: topLevel.length,
		topLevelWithSourcepos: topLevel.filter((el) => el.getAttribute('data-sourcepos') !== null).length,
		legacy: rate(legacyHits, anchors.length),
		fixed: rate(fixedHits, anchors.length),
	};
}

/* ------------------------------------------------------------------ */
/* tests                                                               */
/* ------------------------------------------------------------------ */

test('flat h2 document: anchor lines resolve to an element', (t) => {
	const doc = buildFlatDocument(477);
	const result = measure(doc, 300);

	t.diagnostic(`flat: ${doc.lineCount} source lines, ${result.annotatedElements} elements with data-sourcepos`);
	t.diagnostic(`flat: ${result.topLevelChildren} top-level children, ` +
		`${result.topLevelWithSourcepos} of them with data-sourcepos`);
	t.diagnostic(`flat: legacy top-level scan ${result.legacy.hits}/${result.legacy.total} (${result.legacy.percent}%)`);
	t.diagnostic(`flat: findAnchorElement ${result.fixed.hits}/${result.fixed.total} (${result.fixed.percent}%)`);

	// The control: the pre-fix scan only ever matched a top-level heading line.
	assert.ok(
		result.legacy.percent < 15,
		`the pre-fix top-level scan is expected to miss almost everything, got ${result.legacy.percent}%`,
	);
	// The fix: every sampled anchor line resolves.
	assert.equal(result.fixed.hits, result.fixed.total);
});

test('nested h1/h2/h3 document: anchor lines resolve to an element', (t) => {
	const doc = buildNestedDocument(159);
	const result = measure(doc, 300);

	t.diagnostic(`nested: ${doc.lineCount} source lines, ${result.annotatedElements} elements with data-sourcepos`);
	t.diagnostic(`nested: ${result.topLevelChildren} top-level children, ` +
		`${result.topLevelWithSourcepos} of them with data-sourcepos`);
	t.diagnostic(`nested: legacy top-level scan ${result.legacy.hits}/${result.legacy.total} (${result.legacy.percent}%)`);
	t.diagnostic(`nested: findAnchorElement ${result.fixed.hits}/${result.fixed.total} (${result.fixed.percent}%)`);

	assert.ok(
		result.legacy.percent < 15,
		`the pre-fix top-level scan is expected to miss almost everything, got ${result.legacy.percent}%`,
	);
	assert.equal(result.fixed.hits, result.fixed.total);
});

test('the resolved element is the narrowest block containing the line', () => {
	const doc = new DocumentBuilder();
	doc.heading(2, 'Heading', 'heading');
	doc.blank();
	doc.list(['first', 'second', 'third']);
	const body = parseHtml(processMarkdownHtml(doc.html(), FILE_PATH, new Set())).body;

	// The list occupies lines 3-5; the anchor for line 4 must be that `li`,
	// not the enclosing `ul` and not the heading's fold wrapper.
	const match = findAnchorElement(body, 4);
	assert.ok(match);
	assert.equal((match.element as ShimElement).tagName, 'LI');
	assert.deepEqual({ startLine: match.startLine, endLine: match.endLine }, { startLine: 4, endLine: 4 });
});

test('a collapsed fold resolves to the collapsed wrapper, not to its hidden contents', () => {
	const doc = new DocumentBuilder();
	doc.heading(2, 'Heading', 'heading');
	doc.blank();
	doc.paragraph('Hidden body text.');
	const body = parseHtml(processMarkdownHtml(doc.html(), FILE_PATH, new Set(['heading']))).body;

	// Line 3 is the paragraph inside the collapsed section. Its geometry is
	// meaningless while the wrapper is `height: 0; overflow: hidden`, so the
	// wrapper itself — which sits at the right scroll offset — is the answer.
	const match = findAnchorElement(body, 3);
	assert.ok(match);
	const element = match.element as ShimElement;
	assert.ok(element.classList.contains('foldable-content-wrapper'));
	assert.ok(element.classList.contains('is-collapsed'));
});

/**
 * A document with no headings at all: `processMarkdownHtml` creates no fold
 * wrappers, so every rendered block stays a top-level child. Issue #153's
 * follow-up report is about exactly this shape.
 */
function buildTextOnlyDocument(paragraphs: number) {
	const doc = new DocumentBuilder();
	for (let i = 1; i <= paragraphs; i += 1) {
		doc.wrappedParagraph([
			`Paragraph ${i} first line of prose the author soft-wrapped.`,
			`Paragraph ${i} second line, still the same markdown block.`,
			`Paragraph ${i} third and final line of the block.`,
		]);
		doc.blank();
	}
	return doc;
}

/**
 * The resolver may only return an element that can tell the restore where it
 * is. `getAnchorScrollTop` is handed `offsetTop` and `offsetHeight`, and a `br`
 * reports `0` for both in every browser — so resolving to one is not a near
 * miss, it is `scrollTop = 0`: the reader is thrown to the top of the document.
 *
 * Measured in Chrome over this pipeline's own output: an anchor resolved to a
 * `br` restored to 0 from scroll offsets of 219, 328, 438, 547, 657 and 766 px.
 * The shim has no layout, so this is asserted structurally instead — that is
 * also why the rates above could read 100% while the round trip was broken.
 */
test('a soft-wrapped paragraph resolves to the paragraph, never to its <br>', () => {
	const doc = new DocumentBuilder();
	doc.wrappedParagraph(['first line', 'second line', 'third line']);
	const body = parseHtml(processMarkdownHtml(doc.html(), FILE_PATH, new Set())).body;

	assert.ok(body.querySelectorAll('br[data-sourcepos]').length > 0, 'fixture must contain annotated hard breaks');

	for (const line of [1, 2, 3]) {
		const match = findAnchorElement(body, line);
		assert.ok(match, `line ${line} must resolve`);

		const element = match.element as ShimElement;
		assert.notEqual(element.tagName, 'BR', `line ${line} resolved to a boxless element`);

		// Lines after the first now resolve to the soft-line anchor that
		// `processSoftLineAnchors` puts beside each break — a narrower answer
		// than the paragraph, and a better one: it reports the position of that
		// line rather than the top of the block containing it. The anchor is an
		// empty inline-block, so unlike the `<br>` it has a box to measure,
		// which is the property this test exists to protect.
		if (element.getAttribute('class') === 'source-line-anchor') {
			assert.deepEqual(
				{ startLine: match.startLine, endLine: match.endLine },
				{ startLine: line, endLine: line },
				`the anchor for line ${line} must name that line`,
			);
			continue;
		}

		assert.equal(element.tagName, 'P', `line ${line} resolved to ${element.tagName}`);
		assert.deepEqual({ startLine: match.startLine, endLine: match.endLine }, { startLine: 1, endLine: 3 });
	}
});

test('heading-less document: every anchor line resolves to an element with a box', (t) => {
	const doc = buildTextOnlyDocument(150);
	const result = measure(doc, 300);

	t.diagnostic(`text-only: ${doc.lineCount} source lines, ${result.annotatedElements} elements with data-sourcepos`);
	t.diagnostic(`text-only: ${result.topLevelChildren} top-level children, ` +
		`${result.topLevelWithSourcepos} of them with data-sourcepos`);
	t.diagnostic(`text-only: findAnchorElement ${result.fixed.hits}/${result.fixed.total} (${result.fixed.percent}%)`);

	assert.equal(result.fixed.hits, result.fixed.total);

	// Every source line the renderer attributed to a block, not just the sample:
	// the failure is per-line, and two of every three lines of a soft-wrapped
	// paragraph are `br` lines.
	let boxless = 0;
	let total = 0;
	for (const block of doc.blocks) {
		for (let line = block.startLine; line <= block.endLine; line += 1) {
			total += 1;
			const match = findAnchorElement(result.body, line);
			if (match && ['BR', 'WBR'].includes((match.element as ShimElement).tagName)) boxless += 1;
		}
	}
	t.diagnostic(`text-only: ${boxless}/${total} anchor lines resolved to a boxless element`);
	assert.equal(boxless, 0, `${boxless}/${total} anchor lines resolved to an element with no box`);
});

test('an anchor line past the end of the document does not resolve', () => {
	const doc = buildFlatDocument(3);
	const body = parseHtml(processMarkdownHtml(doc.html(), FILE_PATH, new Set())).body;
	assert.equal(findAnchorElement(body, doc.lineCount + 500), null);
});

test('scroll target interpolates inside the resolved element', () => {
	const range = { startLine: 10, endLine: 20 };
	assert.equal(getAnchorScrollTop(1000, 200, range, 10, 60), 940);
	assert.equal(getAnchorScrollTop(1000, 200, range, 15, 60), 1040);
	assert.equal(getAnchorScrollTop(1000, 200, range, 20, 60), 1140);
	// Single-line blocks have no interior to interpolate over.
	assert.equal(getAnchorScrollTop(1000, 200, { startLine: 7, endLine: 7 }, 7, 60), 940);
	// Never scrolls above the top of the document.
	assert.equal(getAnchorScrollTop(10, 20, { startLine: 1, endLine: 1 }, 1, 60), 0);
});

test('source position ranges parse the way comrak writes them', () => {
	assert.deepEqual(parseSourceposLineRange('12:1-14:9'), { startLine: 12, endLine: 14 });
	assert.equal(parseSourceposLineRange(''), null);
	assert.equal(parseSourceposLineRange(null), null);
	assert.equal(parseSourceposLineRange('nonsense'), null);
});

/**
 * The assertions below are source assertions, not behavior assertions: the
 * restore is triggered from inside a Svelte component and that effect cannot be
 * imported. They pin the wiring — that the component restores through the
 * measured cascade, and that the top-level-only scan the rates above were
 * measured against does not come back.
 *
 * The cascade itself moved out of the component and into
 * `restorePreviewReadingPosition`, next to the resolvers it runs, when the
 * arrival of a transferred tab needed to run the same one after its document
 * lands (see tabTransferHandoff.test.ts). So "it resolves through the measured
 * helpers" is now a behavior claim, made by calling the function — every test
 * above this one, and the arrival tests in tabReadingPosition.spec.ts. What is
 * left here is what a source assertion is for: that there is no second copy.
 */
test('the viewer restores through the measured resolver', async () => {
	const viewer = readSource('src/lib/MarkdownViewer.svelte');

	// Read out of the one import statement rather than matched across the whole
	// file: `import \{[\s\S]*restorePreviewReadingPosition[\s\S]*\} from
	// '…previewAnchor.js'` starts at the first import in the file and runs past
	// every brace in between, so forking the cascade into another module while
	// leaving the rest of the import behind satisfied it.
	const anchorImport = viewer.match(/import \{([^}]*)\} from '\.\/utils\/previewAnchor\.js'/);
	assert.ok(anchorImport, 'the viewer must import from previewAnchor.js');
	const imported = anchorImport[1].split(',').map((name) => name.trim()).filter(Boolean);
	assert.ok(
		imported.includes('restorePreviewReadingPosition'),
		'the restore must go through the shared cascade, not a fork of it',
	);
	// And the component must not grow one of its own back: the cascade is an
	// ORDER, and a second site consulting the same three fields in a different
	// one is a different answer for the same tab.
	assert.doesNotMatch(viewer, /scrollTop = getAnchorScrollTop\(/);
	assert.doesNotMatch(viewer, /tab\.scrollPercentage/);
	assert.doesNotMatch(viewer, /Array\.from\(body\.children\)/);
});

/**
 * The cold start: the rich-content libraries arrive after the document is
 * already in the preview and after the position has been restored against it.
 *
 * Measured in Chromium — the numbers and the method are in the patch effect's
 * comment in `MarkdownViewer.svelte` — the anchored text moves down by up to
 * 812px when the enrichment lands, and re-running this cascade afterwards
 * brings it back to within 0.8px. jsdom has no layout, so that magnitude cannot
 * be asserted here and this is a source assertion like the one above: what it
 * pins is that the second restore is wired up at all, and that nothing has
 * quietly gone back to the arrangement that had no owner for this case.
 */
test('a cold start restores again once its enrichment has landed', async () => {
	const viewer = readSource('src/lib/MarkdownViewer.svelte');

	// The patch effect is the owner: when the libraries land, the diff finds
	// nothing to do, so the roots are the host and the restore follows it.
	assert.match(
		viewer,
		/const cold = patch\.inserted\.length === 0 && !enrichedHosts\.has\(host\)/,
		'the patch effect must recognise a document that was patched in without the libraries',
	);
	assert.match(
		viewer,
		/renderRichContent\(cold \? \[host\] : patch\.inserted\)/,
		'the cold pass must enrich the whole host — `patch.inserted` is empty on that run',
	);
	assert.match(
		viewer,
		/if \(cold\) restoreAfterColdEnrichment\(/,
		'and only that run may re-restore, or every no-op patch would move the reader',
	);

	// The restore itself goes through the shared cascade, waits for the
	// enrichment, and speaks only for the tab still on screen.
	const helper = viewer.match(
		/async function restoreAfterColdEnrichment\([\s\S]*?\n\t\}/,
	)?.[0];
	assert.ok(helper, 'restoreAfterColdEnrichment must exist');
	assert.match(helper, /await enrichment;/);
	assert.match(helper, /tabManager\.activeTabId !== tabId/);
	assert.match(helper, /restorePreviewReadingPosition\(body, tab,/);

	// And the accident that used to stand in for it must not come back. The
	// theme effect's `renderRichContent()` reads `richLibraries` before its
	// first await, so without `untrack` that effect re-runs when the libraries
	// land — re-enriching every open tab's host on top of the pass below, and
	// leaving the reading position where the old layout put it.
	//
	// Matched on the `untrack`, not on the guard beside it: the guard was
	// `markdownBody && !isEditing` when this was written and is `markdownBody`
	// alone now (scripts/diagramThemeRefresh.spec.ts owns that question). What
	// this test is for is the tracking.
	assert.match(
		viewer,
		/untrack\(\(\) => \{? ?if \(markdownBody\) renderRichContent\(\);/,
		'the theme effect must depend on the theme, not on the libraries arriving',
	);
});
