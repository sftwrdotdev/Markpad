/**
 * #467: "Is there a way how to change the width of exported HTML?" — there was
 * not. The exporter wrote `max-width: 900px` into every file it produced, which
 * is neither the user's Preview → Max width (#346–#349, renamed in #456) nor
 * even the app's own default of 880.
 *
 * Everything below resolves the stylesheet the export actually emits, rather
 * than matching on the source of the template that emits it. A test that
 * grepped `export.ts` for a width would stay green with the value going
 * nowhere: the declaration only means something once it is inside the `<style>`
 * block of a built document, attached to a selector the exported `<article
 * class="markdown-body">` matches, and last in the cascade. The last two tests
 * run the real `exportAsHtml` end to end and read the bytes it hands to
 * `save_file_content`, on the harness `exportRichContent.test.ts` established.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
	DEFAULT_PREVIEW_MAX_WIDTH,
	getPreviewContentWidth,
	MAX_PREVIEW_MAX_WIDTH,
	MIN_PREVIEW_MAX_WIDTH,
} from '../src/lib/utils/previewWidth.js';
import { installShimDom } from './renderProtocolDom.ts';
import { functionSource, readSource } from './sourceTree.js';

// The shim has to be in place before `export.ts` is evaluated, so the module is
// imported dynamically here exactly as it is in `exportRichContent.test.ts`.
installShimDom();
(globalThis as any).window = globalThis;
(globalThis as any).location = { href: 'http://tauri.localhost/' };

const DOMPurify = (await import('dompurify')).default as any;
// Without a real DOM the filter is a no-op object; what it does and where it
// sits in the pipeline is `exportSanitize.test.ts`'s subject, not this file's.
DOMPurify.sanitize = (html: string) => html;

const { buildExportDocument, exportAsHtml, exportContentMaxWidth } = await import('../src/lib/utils/export.ts');

const appStyles = readSource(new URL('../src/styles.css', import.meta.url));
const viewerSource = readSource(new URL('../src/lib/MarkdownViewer.svelte', import.meta.url));

type Rule = { selectors: string[]; declarations: string; media: 'screen' | 'print' };
type Declaration = { value: string; important: boolean };

function stripComments(css: string): string {
	return css.replace(/\/\*[\s\S]*?\*\//g, '');
}

/**
 * Flattens a stylesheet into rules, remembering whether each one is inside a
 * print block. Brace-aware rather than regex-per-rule, because the sheet under
 * test is the app's real one: `@media`, `@supports` and `@font-face` all nest.
 */
function parseRules(css: string, media: Rule['media'] = 'screen'): Rule[] {
	const rules: Rule[] = [];
	let index = 0;

	while (index < css.length) {
		const open = css.indexOf('{', index);
		if (open === -1) break;
		const prelude = css.slice(index, open).trim();

		let depth = 0;
		let close = open;
		for (; close < css.length; close += 1) {
			if (css[close] === '{') depth += 1;
			else if (css[close] === '}') {
				depth -= 1;
				if (depth === 0) break;
			}
		}
		if (close >= css.length) break;

		const body = css.slice(open + 1, close);
		if (prelude.startsWith('@')) {
			if (/^@(?:media|supports|layer|container)\b/.test(prelude)) {
				rules.push(...parseRules(body, /\bprint\b/.test(prelude) ? 'print' : media));
			}
		} else if (prelude) {
			rules.push({ selectors: prelude.split(',').map((s) => s.trim()), declarations: body, media });
		}

		index = close + 1;
	}

	return rules;
}

/** The `<style>` block of a built export, comments removed. */
function exportedStylesheet(document_: string): string {
	const match = document_.match(/<style>([\s\S]*?)<\/style>/);
	assert.ok(match, 'the export must carry a stylesheet');
	return stripComments(match[1]);
}

/** Every `property` declared for a bare `.markdown-body`, in cascade order. */
function declarationsFor(css: string, property: string, media: Rule['media']): Declaration[] {
	const found: Declaration[] = [];
	for (const rule of parseRules(css)) {
		if (rule.media !== media || !rule.selectors.includes('.markdown-body')) continue;
		for (const piece of rule.declarations.split(';')) {
			const colon = piece.indexOf(':');
			if (colon === -1) continue;
			if (piece.slice(0, colon).trim().toLowerCase() !== property) continue;
			let value = piece.slice(colon + 1).trim();
			const important = /!important$/i.test(value);
			if (important) value = value.replace(/!important$/i, '').trim();
			found.push({ value, important });
		}
	}
	return found;
}

/**
 * What an exported `<article class="markdown-body">` is actually capped at.
 *
 * All the candidates have identical specificity (one class, no `!important`
 * among them today), so the winner is the last one in the sheet — which is what
 * makes this worth resolving rather than reading off the template: the export's
 * own rules are appended *after* the app's copied stylesheet, and a future
 * `.markdown-body { max-width: … }` added anywhere below would take the file
 * back off the setting without touching `export.ts` at all.
 */
function exportedMaxWidth(contentWidth: number | null, styles = ''): string {
	const document_ = buildExportDocument({
		theme: 'light',
		title: 'Notes',
		styles,
		articleHtml: '<p>body</p>',
		contentWidth,
	});
	const declared = declarationsFor(exportedStylesheet(document_), 'max-width', 'screen');
	assert.ok(declared.length >= 1, 'the export must cap .markdown-body');
	const important = declared.filter((d) => d.important);
	return (important.length ? important : declared).at(-1)!.value;
}

test('the exported file is capped at the width the preview was reading at', () => {
	// The whole of #467, stated as the four corners of the setting plus the
	// default. Each one is a real document built by the real template.
	for (const width of [MIN_PREVIEW_MAX_WIDTH, 720, DEFAULT_PREVIEW_MAX_WIDTH, 1240, MAX_PREVIEW_MAX_WIDTH]) {
		assert.equal(exportedMaxWidth(width), `${width}px`, `an export made at ${width} must cap at ${width}`);
	}

	// And the number it used to ship regardless is gone from the artefact.
	const document_ = buildExportDocument({
		theme: 'light',
		title: 'Notes',
		styles: '',
		articleHtml: '<p>body</p>',
		contentWidth: DEFAULT_PREVIEW_MAX_WIDTH,
	});
	assert.doesNotMatch(document_, /max-width:\s*900px/);
});

test('changing the setting changes the file that comes out', () => {
	// The claim the reporter cares about is not "some width is emitted" but
	// "moving the setting moves the export", so two exports of the same document
	// at two widths have to differ, and differ only there.
	const narrow = exportedMaxWidth(getPreviewContentWidth(700, false));
	const wide = exportedMaxWidth(getPreviewContentWidth(1400, false));
	assert.equal(narrow, '700px');
	assert.equal(wide, '1400px');
	assert.notEqual(narrow, wide);

	// Same source of truth as the preview: whatever `getPreviewContentWidth`
	// hands `--preview-max-width` is what the exported cap is built from, for
	// every combination of stored value and full-width state.
	for (const stored of [MIN_PREVIEW_MAX_WIDTH, 880, 1000, MAX_PREVIEW_MAX_WIDTH]) {
		for (const isFullWidth of [false, true]) {
			const contentWidth = getPreviewContentWidth(stored, isFullWidth);
			assert.equal(
				exportedMaxWidth(contentWidth),
				isFullWidth ? 'none' : `${stored}px`,
				`stored ${stored}, full-width ${isFullWidth}`,
			);
		}
	}
});

test('a full-width export is uncapped, still padded and still centred', () => {
	// `getPreviewContentWidth` returns null for full-width mode, and in a
	// standalone file that means "no cap": `none` rather than the preview's
	// `100%`. The two are equivalent for a block child of <body>, but `none` does
	// not depend on that reasoning and cannot interact with `box-sizing`.
	assert.equal(getPreviewContentWidth(1200, true), null);
	assert.equal(exportedMaxWidth(null), 'none');

	// The rest of the layout has to survive the cap being removed: `margin: 0
	// auto` now has no slack to distribute (which is correct — that is what
	// full-width means), and the padding is what still holds the text off the
	// window edge.
	const css = exportedStylesheet(
		buildExportDocument({ theme: 'light', title: 'Notes', styles: '', articleHtml: '<p>body</p>', contentWidth: null }),
	);
	assert.deepEqual(declarationsFor(css, 'margin', 'screen'), [{ value: '0 auto', important: false }]);
	assert.deepEqual(declarationsFor(css, 'padding', 'screen'), [{ value: '40px', important: true }]);
});

test('a corrupted stored width is clamped instead of reaching the stylesheet raw', () => {
	// `previewMaxWidth` is restored from localStorage, so the value arriving here
	// is only as trustworthy as that key. The export is where it stops being a
	// number and becomes a CSS declaration, so it is normalized at that seam too
	// — a hand-edited key must not be able to write its own rules.
	const hostile: [unknown, string][] = [
		[99999, `${MAX_PREVIEW_MAX_WIDTH}px`],
		[-40, `${MIN_PREVIEW_MAX_WIDTH}px`],
		[0, `${MIN_PREVIEW_MAX_WIDTH}px`],
		['1e9', `${MAX_PREVIEW_MAX_WIDTH}px`],
		['not-a-number', `${DEFAULT_PREVIEW_MAX_WIDTH}px`],
		['900px; } body { display: none; } .x {', `${DEFAULT_PREVIEW_MAX_WIDTH}px`],
		[Number.NaN, `${DEFAULT_PREVIEW_MAX_WIDTH}px`],
		[Number.POSITIVE_INFINITY, `${DEFAULT_PREVIEW_MAX_WIDTH}px`],
		[921.8, '922px'],
	];

	for (const [stored, expected] of hostile) {
		const contentWidth = getPreviewContentWidth(stored, false);
		assert.equal(exportedMaxWidth(contentWidth), expected, `stored ${JSON.stringify(stored)}`);

		// Nothing that arrived as a string got out of the declaration.
		const document_ = buildExportDocument({
			theme: 'light',
			title: 'Notes',
			styles: '',
			articleHtml: '<p>body</p>',
			contentWidth,
		});
		assert.doesNotMatch(document_, /body \{ display: none/);
		assert.equal(parseRules(exportedStylesheet(document_)).filter((r) => r.selectors.includes('body')).length, 1);
	}

	// Stated as a shape as well as a table, so a future value that is neither a
	// clamped pixel count nor `none` cannot pass by being plausible.
	for (const stored of hostile.map(([value]) => value).concat([null, '', undefined, {}, []])) {
		assert.match(exportContentMaxWidth(getPreviewContentWidth(stored, false)), /^(?:6[4-9]\d|[7-9]\d\d|1[0-5]\d\d|1600)px$/);
	}
	assert.equal(exportContentMaxWidth(getPreviewContentWidth(undefined, true)), 'none');
});

test('the export cap loses to the print block, so the PDF route is unchanged', () => {
	// `@media print` in styles.css already forces `.markdown-body` to
	// `max-width: 100% !important` with its own .75in padding, and that block
	// travels into the export with the rest of the sheet. Printing an exported
	// file therefore never saw the 900px and must not start seeing the setting
	// either — the two routes stay separate concerns.
	const css = exportedStylesheet(exportDocumentWithAppStyles(MIN_PREVIEW_MAX_WIDTH));
	const printed = declarationsFor(css, 'max-width', 'print');
	assert.ok(printed.length >= 1, 'the print block must still cap .markdown-body');
	assert.deepEqual(printed.at(-1), { value: '100%', important: true });
	assert.deepEqual(declarationsFor(css, 'padding', 'print').at(-1), { value: '0.75in', important: true });
});

test('the app stylesheet copied into an export does not out-rank the cap', () => {
	// The export appends its rules after the copied sheet, so with real styles in
	// front of them the resolved screen cap still has to be the configured one.
	// If it ever is not, the setting is dead again and this is where it shows.
	assert.equal(exportedMaxWidth(1240, appStyles), '1240px');
	assert.equal(exportedMaxWidth(null, appStyles), 'none');
});

function exportDocumentWithAppStyles(contentWidth: number | null): string {
	return buildExportDocument({
		theme: 'light',
		title: 'Notes',
		styles: appStyles,
		articleHtml: '<p>body</p>',
		contentWidth,
	});
}

// ------------------------------------------------- the whole export, for real

/**
 * Runs `exportAsHtml` and returns the bytes it hands `save_file_content`.
 *
 * The stand-ins are the Tauri boundary (the save dialog, the comrak round trip,
 * the write) and the rich-content libraries, all of which need either a real
 * browser or a real backend. Everything between the `contentWidth` field and
 * the finished file is Markpad's own code, running.
 *
 * `copiedStyles` stands for the app's stylesheets, which `exportAsHtml` reads
 * out of `document.styleSheets` and copies in ahead of the export's own rules.
 * It carries a decoy `.markdown-body { max-width: 900px }` so the run also
 * answers "does the export's cap actually win the cascade" rather than merely
 * "is it present in the file".
 */
async function exportedFile(contentWidth: number | null): Promise<string> {
	let saved: { path: string; content: string } | null = null;

	(globalThis as any).window.__TAURI_INTERNALS__ = {
		convertFileSrc: (path: string) => `asset://localhost/${path}`,
		invoke: async (command: string, args: any) => {
			switch (command) {
				case 'plugin:dialog|save':
					return '/tmp/notes.html';
				case 'render_markdown':
					return '<h1>Notes</h1>\n<p>body</p>';
				case 'save_file_content':
					saved = { path: args.path, content: args.content };
					return null;
				default:
					throw new Error(`unexpected command ${command}`);
			}
		},
	};

	const copiedStyles = ['.markdown-body { color: red; }', '.markdown-body { max-width: 900px; }'];
	(globalThis as any).document.styleSheets = [
		{ href: 'http://tauri.localhost/_app/immutable/assets/2.C6eSkZFI.css', cssRules: copiedStyles.map((cssText) => ({ cssText })) },
	];

	const result = await exportAsHtml({
		rawContent: '# Notes\n',
		tabTitle: 'Notes',
		tabPath: '/documents/notes.md',
		mermaidTheme: 'neutral',
		libraries: {
			hljs: { getLanguage: () => null },
			katex: { renderToString: () => '' },
			renderMathInElement() {},
			mermaid: { initialize() {}, async render() { return { svg: '' }; } },
		} as any,
		contentWidth,
	});

	assert.equal(result?.path, '/tmp/notes.html', 'the export must have been written');
	assert.ok(saved, 'save_file_content must have been called');
	return (saved as unknown as { content: string }).content;
}

test('a real export writes a file capped at the configured width', async () => {
	// End to end: the field on the context the component fills, through the
	// renderer round trip, the sanitizer, the font pass and the copied
	// stylesheet, to the bytes on disk.
	for (const width of [MIN_PREVIEW_MAX_WIDTH, DEFAULT_PREVIEW_MAX_WIDTH, 1240, MAX_PREVIEW_MAX_WIDTH]) {
		const file = await exportedFile(width);
		assert.match(file, /<article class="markdown-body">/, 'the cap must apply to the element the export ships');
		assert.equal(
			declarationsFor(exportedStylesheet(file), 'max-width', 'screen').at(-1)!.value,
			`${width}px`,
			`an export made at ${width} must be readable at ${width}`,
		);
	}

	// Full-width mode, likewise, all the way to the file.
	assert.equal(
		declarationsFor(exportedStylesheet(await exportedFile(null)), 'max-width', 'screen').at(-1)!.value,
		'none',
	);
});

test('a real export is not capped by a stale width in the copied stylesheet', async () => {
	// The copied sheet in the harness declares `.markdown-body { max-width:
	// 900px }` at the same specificity. The export's own rules are appended
	// after it, so the file the reader opens is at the setting — which is the
	// property that would break silently if the template ever moved.
	const file = await exportedFile(1240);
	assert.match(file, /max-width: 900px/, 'the decoy must really be in the copied sheet');
	assert.equal(declarationsFor(exportedStylesheet(file), 'max-width', 'screen').at(-1)!.value, '1240px');
});

test('the exporter is handed the preview\'s own derived width', () => {
	// The one link in the chain that cannot be executed here: `exportAsHtml`
	// lives in a `.svelte` component, which the Node test runner cannot import
	// (see sourceTree.ts). So the field is checked in the source of that one
	// function — `functionSource` rather than a whole-file match, so a
	// `contentWidth:` appearing anywhere else in a 3700-line component cannot
	// satisfy it.
	const exportCall = functionSource(viewerSource, 'exportAsHtml');
	assert.match(exportCall, /contentWidth: previewContentWidth,/);

	// And `previewContentWidth` is the same derived value the live preview
	// renders with, which is what makes "one source of truth" true rather than
	// merely intended. (previewWidth.test.ts holds the other end of this.)
	assert.match(viewerSource, /previewContentWidth = \$derived\(getPreviewContentWidth\(settings\.previewMaxWidth, settings\.previewFullWidth\)\)/);
	assert.match(viewerSource, /--preview-max-width: \{previewContentWidth === null \? '100%' : `\$\{previewContentWidth\}px`\}/);
});
