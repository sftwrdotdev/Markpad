import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
// @ts-expect-error jsdom ships no types and @types/jsdom is not installed.
import { JSDOM } from 'jsdom';
import postcss from 'postcss';
import { compile } from 'svelte/compiler';
import { buildExportDocument } from '../src/lib/utils/export.ts';
import { DEFAULT_PREVIEW_MAX_WIDTH, MIN_PREVIEW_MAX_WIDTH } from '../src/lib/utils/previewWidth.js';
import { plainAppearance } from './exportFixtures.ts';
import { readSource } from './sourceTree.js';

/**
 * The print/PDF route and the HTML export are both answered by the cascade, so
 * these tests let jsdom resolve it and read `getComputedStyle`. jsdom applies
 * screen media and ignores `@media print`. For paper, `prepare` unwraps every
 * print block in place (same position in the sheet, so source order is kept)
 * before the document is loaded.
 */
const appStyles = readSource(new URL('../src/styles.css', import.meta.url));

/** The viewer's own `<style>`, compiled the way the app ships it (`:global` unwrapped, the rest scoped). */
const viewerStyles = compile(readSource(new URL('../src/lib/MarkdownViewer.svelte', import.meta.url)), {
	filename: 'MarkdownViewer.svelte',
	css: 'external',
}).css!.code;

type Media = 'screen' | 'print';

function prepare(css: string, media: Media): string {
	const root = postcss.parse(css);
	if (media === 'print') {
		root.walkAtRules('media', (rule) => {
			if (/\bprint\b/.test(rule.params)) rule.replaceWith(rule.nodes ?? []);
		});
	}
	// ponytail: jsdom 30 keeps `overflow` and `overflow-x/-y` as unrelated
	// properties, so a longhand anywhere beats an `overflow: … !important`
	// (measured). Expanding the one shorthand these tests read restores the
	// cascade. Expand others here if a test starts reading them.
	root.walkDecls('overflow', (decl) => {
		const [x, y = x] = decl.value.split(/\s+/);
		decl.replaceWith(
			decl.clone({ prop: 'overflow-x', value: x }),
			decl.clone({ prop: 'overflow-y', value: y }),
		);
	});
	return root.toString();
}

/** A window for `html`, its `<style>` blocks seen as `media` sees them. */
function page(html: string, media: Media): Window {
	const { window } = new JSDOM(html);
	for (const style of window.document.querySelectorAll('style')) style.textContent = prepare(style.textContent ?? '', media);
	return window as unknown as Window;
}

/** The app and viewer sheets over `body`, the way the live viewer prints. */
function appPage(body: string, media: Media): Window {
	return page(`<!DOCTYPE html><html><head><style>${appStyles}</style><style>${viewerStyles}</style></head><body>${body}</body></html>`, media);
}

function exportPage(media: Media, articleHtml: string, contentWidth: number | null = DEFAULT_PREVIEW_MAX_WIDTH): Window {
	const html = buildExportDocument({ theme: 'light', title: 'T', styles: appStyles, articleHtml, contentWidth, appearance: plainAppearance });
	return page(html, media);
}

/** The computed `property` of the element `selector` picks in `window`. */
function computed(window: Window, selector: string, property: string): string {
	const element = window.document.querySelector(selector);
	assert.ok(element, `fixture has no ${selector}`);
	return window.getComputedStyle(element).getPropertyValue(property);
}

describe('exported content width', () => {
	test('the export cap loses to the print block, so the PDF route is unchanged', () => {
		// `@media print` in styles.css forces `.markdown-body` to `max-width: 100%`
		// with its own .75in padding, and that block travels into the export with
		// the rest of the sheet. Printing an exported file never saw the width
		// setting and must not start seeing it.
		const printed = exportPage('print', '<p>body</p>', MIN_PREVIEW_MAX_WIDTH);
		assert.equal(computed(printed, '.markdown-body', 'max-width'), '100%');
		// The PDF route itself prints the live viewer's `#print-root`, not an export.
		// 0.75in, computed to px.
		const viewer = appPage('<div id="app"><div id="print-root"><article class="markdown-body"></article></div></div>', 'print');
		assert.equal(computed(viewer, '.markdown-body', 'max-width'), '100%');
		assert.equal(computed(viewer, '.markdown-body', 'padding-top'), '72px');
		assert.equal(computed(viewer, '.markdown-body', 'padding-left'), '72px');
	});

	test('the app stylesheet copied into an export does not out-rank the cap', () => {
		// The export appends its rules after the copied sheet, so with real styles in
		// front of them the screen cap still has to be the configured one.
		assert.equal(computed(exportPage('screen', '<p>body</p>', 1240), '.markdown-body', 'max-width'), '1240px');
		assert.equal(computed(exportPage('screen', '<p>body</p>', null), '.markdown-body', 'max-width'), 'none');
	});
});

describe('folds in print and export', () => {
	// The HTML route renders every heading fold open in TypeScript. The print
	// route prints the live DOM with its folds still collapsed, so on paper a
	// collapsed section surviving is a cascade question.
	const article = `<article class="markdown-body">
		<h2 class="foldable-header is-collapsed" id="collapsed-heading"><span class="header-fold-icon"></span>Folded</h2>
		<div class="foldable-content-wrapper is-collapsed" id="collapsed-section"><div class="content-inner" id="collapsed-section-inner">
			<h3 class="foldable-header" id="nested-heading"><span class="header-fold-icon"></span>Nested</h3>
		</div></div>
		<div class="foldable-content-wrapper" id="open-section"><div class="content-inner"><p>open</p></div></div>
		<div class="markdown-alert callout-foldable is-collapsed" id="collapsed-callout">
			<p class="markdown-alert-title callout-toggle"><svg class="callout-fold-icon" id="callout-chevron"></svg>Note</p>
			<div class="markdown-alert-content is-collapsed" id="collapsed-callout-content"><div class="content-inner" id="collapsed-callout-inner">
				<div class="markdown-alert callout-foldable">
					<p class="markdown-alert-title callout-toggle"><svg class="callout-fold-icon" id="nested-callout-chevron"></svg>Inner</p>
				</div>
			</div></div>
		</div>
		<div class="markdown-alert" id="open-callout"><div class="markdown-alert-content" id="open-callout-content"><div class="content-inner"><p>open</p></div></div></div>
	</article>`;

	const paper = appPage(`<div id="app"><div id="print-root">${article}</div></div>`, 'print');
	const screen = appPage(`<div id="app">${article}</div>`, 'screen');
	const exported = exportPage('screen', article);

	test('a collapsed heading section is printed, not clipped away', () => {
		// The PDF is the copy the reader gets. Clipping a fold to zero height
		// deletes text from it with no sign that anything is missing.
		assert.equal(computed(paper, '#collapsed-section', 'height'), 'auto');
		assert.notEqual(computed(paper, '#collapsed-section', 'overflow-y'), 'hidden');
		// Height alone is not enough: the screen rule pairs it with opacity: 0.
		assert.notEqual(computed(paper, '#collapsed-section', 'opacity'), '0');
		assert.notEqual(computed(paper, '#collapsed-section-inner', 'overflow-y'), 'hidden');
	});

	test('a collapsed callout is printed too', () => {
		// Callouts collapse with a 0fr grid track instead of a height, so a fix
		// aimed only at headings leaves half the document disappearing.
		assert.equal(computed(paper, '#collapsed-callout-content', 'grid-template-rows'), 'minmax(0, 1fr)');
		assert.notEqual(computed(paper, '#collapsed-callout-content', 'opacity'), '0');
		assert.notEqual(computed(paper, '#collapsed-callout-inner', 'overflow-y'), 'hidden');
	});

	test('folding still works on screen', () => {
		// The print rules reveal the fold. They must not disable the feature.
		assert.equal(computed(screen, '#collapsed-section', 'height'), '0px');
		assert.equal(computed(screen, '#collapsed-section', 'opacity'), '0');
		assert.equal(computed(screen, '#collapsed-callout-content', 'grid-template-rows'), 'minmax(0, 0fr)');
	});

	test('an open callout sizes its row with minmax, not a bare fr', () => {
		// #850. WebKit keeps the height a bare `1fr` row was given at a narrower
		// width: a callout laid out in the zero-width preview pane stayed ~500px tall
		// after Ctrl+E widened the pane to 860px. Measured in a WKWebView.
		// `minmax(0, 1fr)` re-sizes it. jsdom has no layout, so the value is what
		// this can hold.
		assert.equal(computed(screen, '#open-callout-content', 'grid-template-rows'), 'minmax(0, 1fr)');
		assert.equal(computed(paper, '#open-callout-content', 'grid-template-rows'), 'minmax(0, 1fr)');
	});

	test('an expanded section is unaffected by the reveal', () => {
		assert.notEqual(computed(paper, '#open-section', 'height'), '0px');
		assert.notEqual(computed(paper, '#open-section', 'opacity'), '0');
	});

	test('the fold controls do not print as misleading decoration', () => {
		// A collapsed chevron points at content that now prints expanded, and it
		// is a control for an interaction paper does not have.
		assert.equal(computed(paper, '#collapsed-heading .header-fold-icon', 'display'), 'none');
		assert.equal(computed(paper, '#callout-chevron', 'display'), 'none');
	});

	test('folding a section turns its own chevron, not the ones nested inside it', () => {
		// A heading's content wrapper holds the headings below it, and a callout's
		// content can hold another callout. `.is-collapsed .header-fold-icon` matched
		// every one of those, so they turned while the section animated shut.
		assert.equal(computed(screen, '#collapsed-heading .header-fold-icon', 'transform'), 'rotate(-90deg)');
		assert.equal(computed(screen, '#nested-heading .header-fold-icon', 'transform'), 'none');
		assert.equal(computed(screen, '#nested-heading .header-fold-icon', 'opacity'), '0');
		assert.equal(computed(screen, '#callout-chevron', 'transform'), 'rotate(-90deg)');
		assert.equal(computed(screen, '#nested-callout-chevron', 'transform'), 'none');
	});

	test('a callout collapsed in the source is still readable in an exported file', () => {
		// `> [!note]-` puts `is-collapsed` in the markup itself, and an exported file
		// has no toggle and a policy that forbids the script one. Verified in Chrome
		// against a real exported file before the fix: the collapsed callout's
		// content box measured 0px at opacity 0.
		assert.equal(computed(exported, '#collapsed-callout-content', 'grid-template-rows'), 'minmax(0, 1fr)');
		assert.notEqual(computed(exported, '#collapsed-callout-content', 'opacity'), '0');
		assert.notEqual(computed(exported, '#collapsed-callout-inner', 'overflow-y'), 'hidden');
		// The same for a heading fold, whatever fold state a caller hands the renderer.
		assert.notEqual(computed(exported, '#collapsed-section', 'height'), '0px');
		assert.notEqual(computed(exported, '#collapsed-section', 'opacity'), '0');
	});

	test('an exported file does not offer controls it cannot honour', () => {
		assert.equal(computed(exported, '#callout-chevron', 'display'), 'none');
	});
});

describe('oversized media in print', () => {
	// `@page { margin: 0 }` makes the page box the whole sheet, and `.markdown-body`
	// pads 0.75in top and bottom, so the printable column is the sheet minus 1.5in.
	const LETTER_PRINTABLE_IN = 11 - 1.5;
	const A4_PRINTABLE_IN = 11.69 - 1.5;

	const body = `<div id="app"><div id="print-root"><article class="markdown-body">
		<img id="image" src="data:,">
		<div class="mermaid-diagram" id="diagram"><svg id="diagram-svg"><rect id="diagram-shape"></rect></svg></div>
	</article></div></div>
	<style>#diagram-svg { fill: rgb(1, 2, 3); stroke: rgb(4, 5, 6); } #diagram-svg rect { fill: rgb(7, 8, 9); stroke: rgb(10, 11, 12); }</style>`;
	const paper = appPage(body, 'print');
	const screen = appPage(body, 'screen');

	/** jsdom computes absolute lengths to px (96 per inch). A relative cap stays relative and fails here. */
	function inches(value: string): number {
		const match = value.match(/^([\d.]+)px$/);
		assert.ok(match, `the cap must be an absolute length, not: ${value}`);
		return Number(match[1]) / 96;
	}

	test('the print block caps media height at a size both papers can hold', () => {
		// A replaced element cannot be fragmented, so `break-inside: avoid` alone
		// turns anything taller than the column into a cropped image.
		// jsdom resolves vh/% against its window, so the cap is computed at two
		// window heights: only an absolute length reads the same at both.
		const shortWindow = appPage(body, 'print');
		Object.defineProperty(shortWindow, 'innerHeight', { value: 100 });
		for (const selector of ['#image', '#diagram-svg']) {
			assert.equal(computed(shortWindow, selector, 'max-height'), computed(paper, selector, 'max-height'), 'the cap must not depend on the window');
			const cap = inches(computed(paper, selector, 'max-height'));
			assert.ok(cap <= LETTER_PRINTABLE_IN, `${cap}in overflows Letter (${LETTER_PRINTABLE_IN}in)`);
			assert.ok(cap <= A4_PRINTABLE_IN, `${cap}in overflows A4 (${A4_PRINTABLE_IN}in)`);
			assert.ok(cap >= 6, `${cap}in shrinks every full-page figure needlessly`);
		}
	});

	test('oversized images are scaled to a page instead of being clipped', () => {
		assert.notEqual(computed(paper, '#image', 'max-height'), computed(screen, '#image', 'max-height'));
		inches(computed(paper, '#image', 'max-height'));
	});

	test('oversized mermaid diagrams are scaled to a page too', () => {
		inches(computed(paper, '#diagram-svg', 'max-height'));
	});

	test('the cap preserves aspect ratio rather than squashing', () => {
		// `height: auto` is what lets the cap scale the width down proportionally.
		assert.equal(computed(paper, '#image', 'object-fit'), 'contain');
		assert.equal(computed(paper, '#image', 'height'), 'auto');
		assert.equal(computed(paper, '#image', 'max-width'), '100%');
	});

	test('the diagram container does not clip the capped diagram', () => {
		// The viewer gives `.mermaid-diagram` `overflow-x: auto` for the screen, which
		// computes overflow-y to `auto` as well and would crop on paper. jsdom does
		// not apply that coupling, so overflow-x is the value this can hold.
		assert.equal(computed(screen, '#diagram', 'overflow-x'), 'auto');
		assert.equal(computed(paper, '#diagram', 'overflow-x'), 'visible');
	});

	test('the media caps do not undo the existing print handling', () => {
		// #359 moved diagram colours out of CSS into a light-theme re-render
		// (utils/mermaidPrint.ts). Paper must paint the diagram as the screen does.
		// The fixture's `<style>` stands in for the paint Mermaid writes.
		for (const selector of ['#diagram', '#diagram-svg', '#diagram-shape']) {
			for (const property of ['fill', 'stroke']) {
				assert.equal(computed(paper, selector, property), computed(screen, selector, property), `${selector} ${property}`);
			}
		}
		// Now that they fit, `break-inside: avoid` moves them to the next page.
		assert.equal(computed(paper, '#image', 'break-inside'), 'avoid');
		assert.equal(computed(paper, '#diagram', 'break-inside'), 'avoid');
	});
});

describe('PDF prints the export article', () => {
	// `#app` is `display: contents`, so the app's markup and the print article are
	// siblings. Hiding by structure rather than by name keeps a part of the
	// interface added tomorrow off the page.
	const body = `<div id="app"><div class="title-bar" id="chrome"></div><div id="print-root"><article class="markdown-body"></article></div></div><div class="toast" id="outside"></div>`;

	test('the print sheet reveals the article and hides everything else', () => {
		const paper = appPage(body, 'print');
		assert.equal(computed(paper, '#chrome', 'display'), 'none');
		assert.equal(computed(paper, '#outside', 'display'), 'none');
		assert.equal(computed(paper, '#print-root', 'display'), 'block');
		// And it is not in the way on screen.
		assert.equal(computed(appPage(body, 'screen'), '#print-root', 'display'), 'none');
	});
});
