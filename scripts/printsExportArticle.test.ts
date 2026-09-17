import assert from 'node:assert/strict';
import test from 'node:test';

import { offsetOf, readSource, sliceBetween } from './sourceTree.js';

const styles = readSource('src/styles.css');
const viewer = readSource('src/lib/MarkdownViewer.svelte');
const exporter = readSource('src/lib/utils/export.ts');

/** The `@media print` block only — not everything that follows it in the file. */
function extractPrintBlock(source: string): string {
	const start = offsetOf(source, '@media print {');
	let depth = 0;
	for (let i = offsetOf(source, '{', start); i < source.length; i += 1) {
		if (source[i] === '{') depth += 1;
		else if (source[i] === '}') {
			depth -= 1;
			if (depth === 0) return source.slice(start, i + 1);
		}
	}
	throw new Error('unterminated @media print block');
}

const printBlock = extractPrintBlock(styles);
const pdfExport = sliceBetween(exporter, 'export async function exportAsPdf', '\nasync function waitForImages');

test('a PDF is rendered from the document, not from the window', () => {
	// `window.print()` over the live window made the paper whatever was on
	// screen, and every new part of the interface had to be subtracted back out
	// in the print sheet. Fifteen issues over five months were that list missing
	// an entry (#668). The article is built the way the HTML export builds it.
	assert.match(pdfExport, /await buildExportArticle\(/);
	assert.match(pdfExport, /ctx\.printRoot\.replaceChildren\(\.\.\.Array\.from\(article\.root\.childNodes\)\)/);
});

test('the article is taken down when printing ends, not when the command returns', () => {
	// `print_pdf` opens the platform print sheet and returns while it is still
	// up. Clearing the article at that point races the sheet for the page it is
	// about to render, and losing that race prints nothing at all.
	assert.match(pdfExport, /addEventListener\('afterprint', \(\) => ctx\.printRoot\.replaceChildren\(\), \{ once: true \}\)/);
	assert.doesNotMatch(pdfExport, /\} finally \{/);
	// A platform that never sends the event leaves it mounted, so the next
	// export has to start from empty rather than print the last document.
	const reset = offsetOf(pdfExport, 'ctx.printRoot.replaceChildren();');
	assert.ok(reset < offsetOf(pdfExport, 'await buildExportArticle('), 'the reset happens before the new article is built');
});

test('the document is on the page before the print command runs', () => {
	// An image that has not decoded prints as an empty box, which is the
	// failure that looks most like a successful export.
	const wait = offsetOf(pdfExport, 'waitForImages(ctx.printRoot)');
	assert.ok(wait < offsetOf(pdfExport, "invoke('print_pdf')"), 'images decode before the native print');
	assert.ok(wait < offsetOf(pdfExport, "invoke('export_pdf_windows'"), 'and before the Windows PDF writer');
	// An unreachable image must not hold the export open for ever.
	const waitHelper = sliceBetween(exporter, 'async function waitForImages', '\n}');
	assert.match(waitHelper, /setTimeout\(resolve, IMAGE_LOAD_TIMEOUT_MS\)/);
});

test('the print sheet reveals the article and hides everything else', () => {
	// `#app` is `display: contents`, so the app's markup and the print article
	// are siblings. Hiding by structure rather than by name is what keeps a
	// part of the interface added tomorrow off the page.
	assert.match(printBlock, /#app > :not\(#print-root\)\s*\{[^}]*display:\s*none\s*!important;/);
	assert.match(printBlock, /body > :not\(#app\)\s*\{[^}]*display:\s*none\s*!important;/);
	assert.match(printBlock, /#print-root\s*\{[^}]*display:\s*block\s*!important;/);
	// And it is not in the way on screen.
	assert.match(styles.slice(offsetOf(styles, '\n#print-root {')), /#print-root \{\n\tdisplay: none;/);
});

test('the print sheet names no part of the interface', () => {
	// The regression this change exists to prevent: one selector per app part,
	// growing by one every time a part is added, and silently wrong until
	// someone finds their find-bar highlights in a PDF.
	for (const selector of [
		'.custom-title-bar',
		'.tab-area',
		'.window-controls-left',
		'.title-actions-container',
		'.pane.editor-pane',
		'.pane.viewer-pane',
		'.split-bar',
		'.find-bar',
		'.toc-overlay-wrapper',
		'.markpad-find-match',
		'.home-menu-container',
		'.theme-dropdown-container',
	]) {
		assert.doesNotMatch(
			printBlock,
			new RegExp(selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
			`${selector} is app state — the printed article cannot contain it, so the print sheet must not mention it`,
		);
	}
});

test('the viewer hands over an article rather than its own preview', () => {
	assert.match(viewer, /<article id="print-root" class="markdown-body" bind:this=\{printRootEl\}><\/article>/);
	const pdf = sliceBetween(viewer, 'async function exportAsPdf', '\n	}');
	assert.match(pdf, /printRoot: printRootEl/);
	// The preview's own DOM, its fold state and its theme have nothing to do
	// with what prints now, so nothing refreshes or re-themes it for an export.
	assert.doesNotMatch(viewer, /syncPreviewForPrint/);
	assert.doesNotMatch(viewer, /renderDiagramsForPrint/);
});
