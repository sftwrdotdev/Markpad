import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { buildExportDocument, exportAsHtml, exportAsPdf, exportContentMaxWidth, exportThemeAttribute } from '../src/lib/utils/export.ts';
import { DEFAULT_PREVIEW_MAX_WIDTH, getPreviewContentWidth, MAX_PREVIEW_MAX_WIDTH, MIN_PREVIEW_MAX_WIDTH } from '../src/lib/utils/previewWidth.js';
import { plainAppearance } from './exportFixtures.ts';
import { parseFrontMatter } from '../src/lib/utils/frontMatter.js';
import { isAssetUrl, normalizeAssetPath, renderStaticFrontMatterPanel, resolveExportImagePath, rewriteMarkdownHrefForExport } from '../src/lib/utils/exportHtml.js';
import { hasMarkdownLinkExtension, MARKDOWN_LINK_EXTENSIONS, resolveMarkdownTargetPath } from '../src/lib/utils/markdownLinks.js';
import { askToOpenExportedFile } from '../src/lib/utils/openExportedFile.js';
import { fontFamilyValue } from '../src/lib/utils/fontFamily.js';
import { absolutizeKatexFontUrls, collectUsedKatexFamilies, findKatexFontFaces, inlineKatexFontFaces, katexFontUrlsToEmbed } from '../src/lib/utils/exportFonts.ts';
import { renderRichContent } from '../src/lib/utils/richContent.ts';
import { ALLOWED_MARKDOWN_URI_REGEXP } from '../src/lib/utils/sanitize.js';
import { readDiagramSource, rememberDiagramSource, resolveMermaidTheme } from '../src/lib/utils/mermaidPrint.js';
import { useShimDom } from './preview.domShim.ts';

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
 * `save_file_content`, on the harness `export.test.ts` established.
 */
describe('exported content width', () => {
	// The shim stands in for the DOM `exportAsHtml` builds into. Without a real DOM
	// DOMPurify is a no-op object; what it does and where it sits in the pipeline is
	// `export.checks.test.ts`'s subject, not this one's.
	useShimDom({ window: globalThis, location: { href: 'http://tauri.localhost/' } }, { identitySanitize: true });

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
			appearance: plainAppearance,
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
			appearance: plainAppearance,
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
			buildExportDocument({ theme: 'light', title: 'Notes', styles: '', articleHtml: '<p>body</p>', contentWidth: null, appearance: plainAppearance }),
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
				appearance: plainAppearance,
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
			newlineBreaks: true,
			libraries: {
				hljs: { getLanguage: () => null },
				katex: { renderToString: () => '' },
				renderMathInElement() {},
				mermaid: { initialize() {}, async render() { return { svg: '' }; } },
			} as any,
			contentWidth,
			appearance: plainAppearance,
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
});

describe('HTML export paths and front matter', () => {
	test('normalizeAssetPath decodes Tauri asset URLs for Windows drive paths and UNC paths', () => {
		assert.equal(
			normalizeAssetPath('asset://localhost/C:/Users/Daniel/My%20Pictures/diagram.png'),
			'C:/Users/Daniel/My Pictures/diagram.png',
		);
		assert.equal(
			normalizeAssetPath('asset://localhost/%5C%5Cserver%5Cshare%5Cimage.png'),
			'\\\\server\\share\\image.png',
		);
	});

	test('normalizeAssetPath accepts the shape convertFileSrc actually emits on Windows', () => {
		// convertFileSrc returns `http://asset.localhost/...` on Windows and Android,
		// and `asset://localhost/...` elsewhere. Only the second form was handled, so
		// no local image was ever inlined into a Windows export.
		assert.equal(
			normalizeAssetPath('http://asset.localhost/C%3A%2FUsers%2FDaniel%2Fimg%2Fdiagram.png'),
			'C:/Users/Daniel/img/diagram.png',
		);
		assert.equal(
			normalizeAssetPath('https://asset.localhost/C%3A%2FDocs%2Fa%20b.png'),
			'C:/Docs/a b.png',
		);
		// Look-alike hosts must stay remote.
		assert.equal(normalizeAssetPath('http://asset.localhost.evil.test/C:/secret.png'), null);
		assert.equal(normalizeAssetPath('http://asset.localhostx/C:/secret.png'), null);
		assert.equal(normalizeAssetPath('https://example.test/a.png'), null);
	});

	test('isAssetUrl distinguishes asset URLs from ordinary remote ones', () => {
		assert.equal(isAssetUrl('asset://localhost/a.png'), true);
		assert.equal(isAssetUrl('http://asset.localhost/a.png'), true);
		assert.equal(isAssetUrl('https://asset.localhost/a.png'), true);
		assert.equal(isAssetUrl('http://asset.localhost.evil.test/a.png'), false);
		assert.equal(isAssetUrl('https://example.test/a.png'), false);
	});

	test('a Windows asset URL is inlined rather than treated as a remote image', () => {
		// The remote-scheme bail-out used to run first, so the Windows asset URL was
		// dropped before it could be recognised: not inlined, and not counted as a
		// missing image either, so the export silently shipped a dead link.
		assert.equal(
			resolveExportImagePath('http://asset.localhost/C%3A%2FDocs%2Fimg%2Fa.png', 'C:\\Docs\\note.md'),
			'C:/Docs/img/a.png',
		);
		assert.equal(resolveExportImagePath('http://asset.localhost.evil.test/a.png', 'C:\\Docs\\note.md'), null);
	});

	test('resolveExportImagePath preserves remote/data images and resolves local paths cross-platform', () => {
		assert.equal(resolveExportImagePath('https://example.test/a.png', 'C:\\Docs\\note.md'), null);
		assert.equal(resolveExportImagePath('data:image/png;base64,abc', '/home/daniel/note.md'), null);
		assert.equal(resolveExportImagePath('img/a%20b.png', 'C:\\Docs\\note.md'), 'C:/Docs/img/a b.png');
		assert.equal(resolveExportImagePath('./img/a.png', '/home/daniel/docs/note.md'), '/home/daniel/docs/img/a.png');
		assert.equal(resolveExportImagePath('/home/daniel/assets/a.png', '/home/daniel/docs/note.md'), '/home/daniel/assets/a.png');
	});

	test('the path resolver for documents and the one for hrefs differ on purpose', () => {
		// The document and href resolvers differ on purpose; their three differences
		// are pinned here, through the public entry points, since the href one is
		// private to its module.
		//
		// The image side is `resolveDocumentRelativePath` (via resolveExportImagePath),
		// the link side `resolveHrefRelativePath` (via resolveMarkdownTargetPath).
		const target = (path: string) => ({ path, hash: '' });

		// 1. `\` in the relative half. An image path is a filesystem path: a Windows
		//    author's `img\a.png` names a directory. An href is a URL: `\` is an
		//    ordinary character and the name must survive intact.
		assert.equal(resolveExportImagePath('img\\a.png', '/notes/index.md'), '/notes/img/a.png');
		assert.equal(
			resolveMarkdownTargetPath('/notes/index.md', target('sub\\other.md')),
			'/notes/sub\\other.md',
		);

		// 2. Empty segments. A path is bytes for the OS; an href gets tidied.
		assert.equal(resolveExportImagePath('a//b.png', '/notes/index.md'), '/notes/a//b.png');
		assert.equal(resolveMarkdownTargetPath('/notes/index.md', target('a//b.md')), '/notes/a/b.md');

		// 3. A base with no separator. The href side would answer `/other.md` — the
		//    filesystem root, a real and wrong directory — so its caller refuses the
		//    empty base outright. The document side answers relatively and lets
		//    resolveLocalFileLinkPath do the refusing (see preview.test.ts).
		assert.equal(resolveExportImagePath('a.png', ''), 'a.png');
		assert.equal(resolveMarkdownTargetPath('', target('other.md')), null);
	});

	test('rewriteMarkdownHrefForExport rewrites local Markdown links and preserves query/hash', () => {
		assert.equal(rewriteMarkdownHrefForExport('notes/Plan%20A.md#todo'), 'notes/Plan%20A.html#todo');
		assert.equal(rewriteMarkdownHrefForExport('../x/readme.markdown?raw=1#top'), '../x/readme.html?raw=1#top');
		assert.equal(rewriteMarkdownHrefForExport('C:/Docs/spec.mdown#sec'), 'C:/Docs/spec.html#sec');
		assert.equal(rewriteMarkdownHrefForExport('https://example.test/a.md'), 'https://example.test/a.md');
		assert.equal(rewriteMarkdownHrefForExport('mailto:test@example.test'), 'mailto:test@example.test');
	});

	test('renderStaticFrontMatterPanel exports a collapsed, non-interactive properties block', () => {
		const parsed = parseFrontMatter(`---
type: plan
keywords: [logger, synlog]
draft: false
---

# Body
`);

		const html = renderStaticFrontMatterPanel(parsed);

		assert.match(html, /<details class="frontmatter-panel export-frontmatter-panel">/);
		assert.match(html, /<summary class="frontmatter-summary">/);
		assert.match(html, /<span class="frontmatter-title">Properties<\/span>/);
		assert.match(html, /<span class="frontmatter-tag">logger<\/span>/);
		assert.match(html, /<span class="frontmatter-tag">synlog<\/span>/);
		assert.doesNotMatch(html, /\sopen(?:\s|>)/);
		assert.doesNotMatch(html, /<(?:input|button|textarea|select)\b/i);
	});

	test('renderStaticFrontMatterPanel titles the panel in the language it is handed', () => {
		const parsed = parseFrontMatter('---\ntype: plan\n---\n');
		assert.match(renderStaticFrontMatterPanel(parsed, '属性'), /<span class="frontmatter-title">属性<\/span>/);
		assert.match(renderStaticFrontMatterPanel(parsed, '<b>'), /<span class="frontmatter-title">&lt;b&gt;<\/span>/);
	});
});

describe('open the exported file', () => {
	test('askToOpenExportedFile opens the exported file after user confirmation', async () => {
		const opened: string[] = [];
		const asked: Array<{ message: string; options?: unknown }> = [];

		const result = await askToOpenExportedFile('C:/Docs/export.html', 'HTML', {
			ask: async (message, options) => {
				asked.push({ message, options });
				return true;
			},
			openPath: async (path) => {
				opened.push(path);
			},
			labels: {
				title: 'Open exported file?',
				message: 'Open exported HTML file now?',
			},
		});

		assert.equal(result, 'opened');
		assert.deepEqual(opened, ['C:/Docs/export.html']);
		assert.equal(asked[0]?.message, 'Open exported HTML file now?');
		assert.deepEqual(asked[0]?.options, {
			title: 'Open exported file?',
			kind: 'info',
		});
	});

	test('askToOpenExportedFile leaves the file closed when user declines', async () => {
		const opened: string[] = [];

		const result = await askToOpenExportedFile('/tmp/export.html', 'HTML', {
			ask: async () => false,
			openPath: async (path) => {
				opened.push(path);
			},
			labels: {
				title: 'Open exported file?',
				message: 'Open exported HTML file now?',
			},
		});

		assert.equal(result, 'declined');
		assert.deepEqual(opened, []);
	});

	test('askToOpenExportedFile reports opener failures without throwing', async () => {
		const errors: unknown[] = [];

		const result = await askToOpenExportedFile('/tmp/export.html', 'HTML', {
			ask: async () => true,
			openPath: async () => {
				throw new Error('no default app');
			},
			onError: (error) => {
				errors.push(error);
			},
			labels: {
				title: 'Open exported file?',
				message: 'Open exported HTML file now?',
			},
		});

		assert.equal(result, 'failed');
		assert.equal(errors.length, 1);
		assert.match(String(errors[0]), /no default app/);
	});
});

/**
 * #932: a custom Preview font reached neither export, and neither did the code
 * font, its size or the highlight colour. All of them are inline styles on the
 * live preview, on elements the exported article is not inside.
 */
describe('export carries the preview appearance', () => {
	// As in `export.test.ts`: the shim, and DOMPurify as the identity.
	useShimDom({ window: globalThis, location: { href: 'http://tauri.localhost/' }, addEventListener: () => {} }, { identitySanitize: true });

	const appearance = {
		fontFamily: fontFamilyValue('Georgia', 'sans-serif'),
		fontSize: 20,
		codeFontFamily: fontFamilyValue('Menlo', 'monospace'),
		codeFontSize: 18,
		highlightColor: 'rgba(67, 138, 243, 0.4)',
	};

	const declared = {
		'font-family': '"Georgia", sans-serif',
		'font-size': '20px',
		'--code-font': '"Menlo", monospace',
		'--code-font-size': '18px',
		'--highlight-color': 'rgba(67, 138, 243, 0.4)',
	};

	function exportedDocument(appearance_: typeof appearance, styles = ''): string {
		return buildExportDocument({
			theme: 'light',
			title: 'Notes',
			styles,
			articleHtml: '<p>body</p>',
			contentWidth: null,
			appearance: appearance_,
		});
	}

	test('an exported HTML file carries the preview appearance', () => {
		// The app's own `.markdown-body` rule travels in the copied stylesheet at
		// the same specificity, so the export's has to come after it to win.
		const appRule = '.markdown-body { font-family: -apple-system; font-size: 16px; }';
		const file = exportedDocument(appearance, appRule);
		const own = /\.markdown-body \{([^}]*)\}/.exec(file.slice(file.indexOf(appRule) + appRule.length))?.[1] ?? '';
		for (const [property, value] of Object.entries(declared)) {
			assert.ok(own.includes(`\t${property}: ${value};`), `${property} must be ${value}`);
		}
	});

	test('a font name cannot close the exported stylesheet', () => {
		const file = exportedDocument({
			...plainAppearance,
			fontFamily: fontFamilyValue('x</style><p>injected</p>', 'sans-serif'),
		});
		assert.equal(file.split('</style>').length - 1, 1);
	});

	test('a PDF is printed in the preview appearance', async () => {
		const style = new Map<string, string>();
		let printedWith: Record<string, string> | null = null;
		(globalThis as any).window.__TAURI_INTERNALS__ = {
			invoke: async (command: string) => {
				if (command === 'render_markdown') return '<p>body</p>';
				if (command === 'print_pdf') {
					printedWith = Object.fromEntries(style);
					return null;
				}
				throw new Error(`unexpected command ${command}`);
			},
		};

		await exportAsPdf({
			rawContent: 'body\n',
			tabTitle: 'Notes',
			tabPath: '/documents/notes.md',
			mermaidTheme: 'neutral',
			newlineBreaks: true,
			libraries: {
				hljs: { getLanguage: () => null },
				katex: { renderToString: () => '' },
				renderMathInElement() {},
				mermaid: { initialize() {}, async render() { return { svg: '' }; } },
			} as any,
			contentWidth: null,
			appearance,
			osType: 'macos',
			// The element is the viewer's; only what `exportAsPdf` touches is stood in.
			printRoot: {
				style: { setProperty: (property: string, value: string) => style.set(property, value) },
				replaceChildren() {},
				querySelectorAll: () => [],
			} as any,
		});

		assert.deepEqual(printedWith, { '--preview-max-width': 'none', ...declared });
	});
});

/**
 * The HTML export has to contain rendered rich content, not the source of it.
 *
 * Before this, `exportAsHtml` ran `render_markdown → sanitize →
 * processMarkdownHtml` and stopped. `renderRichContent` — highlight.js, KaTeX,
 * Mermaid — was a function inside `MarkdownViewer.svelte` that only the preview
 * could reach. So an exported file, the artefact whose entire purpose is being
 * read by someone without Markpad, arrived with
 * `<p data-math="display" data-math-source="E = mc^2">E = mc^2</p>`,
 * `<pre><code class="language-mermaid">` and code blocks with no highlight
 * classes at all.
 *
 * These tests run the real `exportAsHtml` and assert on the bytes it hands to
 * `save_file_content`. Two things are stood in for, both at a library boundary
 * rather than at one of ours:
 *
 *   - highlight.js, KaTeX and Mermaid. All three need a real browser DOM
 *     (measured against the shim: `hljs.highlightElement` and `katex.render`
 *     both throw on it, and Mermaid needs layout to size a node). They are
 *     injected through the same `libraries` field the app fills from the
 *     preview's own instances, so what is exercised here is Markpad's pipeline
 *     — which elements get handed to which library, and where the results end
 *     up — and not the libraries' own output.
 *   - `DOMPurify.sanitize`, which is a no-op object without a real DOM. It is
 *     replaced by the identity function. What the filter does and where it sits
 *     in the pipeline is pinned by `export.checks.test.ts`; the relevant fact
 *     here is only that the diagram filter and the document filter are separate
 *     calls, which the diagram test below covers from the other side.
 */
describe('rich content in the HTML export', () => {
	// The app resolves the bundled font assets against its own origin.
	useShimDom({ window: globalThis, location: { href: 'http://tauri.localhost/' } }, { identitySanitize: true });

	// ---------------------------------------------------------------- fixtures

	/** The shape comrak emits for the document below, after `processMarkdownHtml`. */
	const RENDERED = [
		'<h1>Notes</h1>',
		'<p data-math="display" data-math-source="E = mc^2">E = mc^2</p>',
		'<p>and inline \\(a_i\\) too</p>',
		'<pre><code class="language-js">const answer = 42;</code></pre>',
		'<pre><code class="language-mermaid">graph TD; A--&gt;B;</code></pre>',
	].join('\n');

	/**
	 * A slice of `katex.min.css` in the shape `CSSRule.cssText` produces, with the
	 * hashed, *stylesheet-relative* asset URLs the real build emits (verified
	 * against `build/_app/immutable/assets/*.css`: `url(./KaTeX_Main-Regular.
	 * B22Nviop.woff2)`). Three families are declared; only the ones the article
	 * references should survive into the export.
	 */
	const SHEET_HREF = 'http://tauri.localhost/_app/immutable/assets/2.C6eSkZFI.css';

	const KATEX_CSS = `
.katex { font: normal 1.21em KaTeX_Main,Times New Roman,serif; }
.katex .mathnormal { font-family: KaTeX_Math; font-style: italic; }
.katex .mathcal { font-family: KaTeX_Caligraphic; }
@font-face { font-family: KaTeX_Main; src: url("./KaTeX_Main-Regular.B22Nviop.woff2") format("woff2"), url("./KaTeX_Main-Regular.Dr94JaBh.woff") format("woff"); font-weight: normal; font-style: normal; }
@font-face { font-family: KaTeX_Math; src: url("./KaTeX_Math-Italic.woff2") format("woff2"); font-weight: normal; font-style: italic; }
@font-face { font-family: KaTeX_Caligraphic; src: url("./KaTeX_Caligraphic-Regular.woff2") format("woff2"); font-weight: normal; font-style: normal; }
`;

	function fakeLibraries(record: { mermaidThemes: string[]; mathCalls: string[] }) {
		return {
			hljs: {
				getLanguage: (name: string) => (name === 'js' ? { name } : null),
				highlight(code: string, options: { language: string }) {
					return { value: `<span class="hljs-keyword">${code}</span>`, language: options.language };
				},
			},
			katex: {
				renderToString(source: string, options: any) {
					record.mathCalls.push(`${options.displayMode ? 'display' : 'inline'}:${source}`);
					return `<span class="katex"><span class="mord mathnormal">${source}</span></span>`;
				},
			},
			renderMathInElement(root: any) {
				// Stands in for KaTeX's auto-render over `\(…\)`, which the renderer
				// runs after the `[data-math]` pass.
				for (const paragraph of root.querySelectorAll('p')) {
					const html = paragraph.innerHTML;
					if (!html.includes('\\(')) continue;
					record.mathCalls.push(`inline:${html.replace(/^[\s\S]*\\\((.*?)\\\)[\s\S]*$/, '$1')}`);
					paragraph.innerHTML = html.replace(
						/\\\((.*?)\\\)/g,
						'<span class="katex"><span class="mord mathnormal">$1</span></span>',
					);
				}
			},
			mermaid: {
				initialize(config: { theme: string }) {
					record.mermaidThemes.push(config.theme);
				},
				async render(id: string, source: string) {
					return {
						svg:
							`<svg id="${id}" role="graphics-document">` +
							`<style>#${id} .node rect{fill:#eee;}</style>` +
							`<foreignObject><div>${source.trim()}</div></foreignObject>` +
							`</svg>`,
					};
				},
			},
		};
	}

	interface ExportRun {
		document: string;
		savedTo: string | null;
		mermaidThemes: string[];
		mathCalls: string[];
		fetched: string[];
	}

	async function runExport(
		options: { css?: string; theme?: string; mermaidTheme?: string; newlineBreaks?: boolean; rendered?: string } = {},
	): Promise<ExportRun> {
		const record = { mermaidThemes: [] as string[], mathCalls: [] as string[] };
		const fetched: string[] = [];
		let saved: { path: string; content: string } | null = null;

		(globalThis as any).window.__TAURI_INTERNALS__ = {
			convertFileSrc: (path: string) => `asset://localhost/${path}`,
			invoke: async (command: string, args: any) => {
				switch (command) {
					case 'plugin:dialog|save':
						return '/tmp/notes.html';
					case 'render_markdown':
						return options.rendered ?? RENDERED;
					case 'save_file_content':
						saved = { path: args.path, content: args.content };
						return null;
					default:
						throw new Error(`unexpected command ${command}`);
				}
			},
		};

		(globalThis as any).fetch = async (url: string) => {
			fetched.push(url);
			return {
				ok: true,
				// Deterministic bytes so the base64 in the assertions is stable.
				arrayBuffer: async () => new Uint8Array([119, 79, 70, 50]).buffer,
			};
		};

		// CSSOM hands out one rule at a time, each with the sheet that owns it —
		// which is the only place the base for a relative font URL exists.
		(globalThis as any).document.styleSheets = [
			{
				href: SHEET_HREF,
				cssRules: (options.css ?? KATEX_CSS)
					.trim()
					.split('\n')
					.map((cssText) => ({ cssText })),
			},
		];
		if (options.theme) (globalThis as any).document.documentElement.setAttribute('data-theme', options.theme);
		else (globalThis as any).document.documentElement.removeAttribute('data-theme');

		await exportAsHtml({
			rawContent: '# Notes\n',
			tabTitle: 'Notes',
			tabPath: '/documents/notes.md',
			mermaidTheme: options.mermaidTheme ?? 'neutral',
			libraries: fakeLibraries(record) as any,
			// The width the preview was reading at, which the export follows (#467).
			// Irrelevant to what this file asserts; `export.test.ts` owns it.
			contentWidth: DEFAULT_PREVIEW_MAX_WIDTH,
			appearance: plainAppearance,
			newlineBreaks: options.newlineBreaks ?? true,
		});

		return {
			document: saved ? (saved as any).content : '',
			savedTo: saved ? (saved as any).path : null,
			mermaidThemes: record.mermaidThemes,
			mathCalls: record.mathCalls,
			fetched,
		};
	}

	// ------------------------------------------------------------------- tests

	test('Every Newline Breaks the Line off drops only the soft breaks from the file (#967)', async () => {
		const rendered = '<p>soft<br class="softbreak" />\nhard<br />\nend</p>';
		const kept = await runExport({ rendered });
		assert.match(kept.document, /soft<br class="softbreak"\s*\/?>\s*hard<br\s*\/?>\s*end/);

		const joined = await runExport({ rendered, newlineBreaks: false });
		assert.doesNotMatch(joined.document, /softbreak/);
		assert.match(joined.document, /soft\s+hard<br\s*\/?>\s*end/);
	});

	test('an exported file contains typeset math, not its LaTeX source', async () => {
		const run = await runExport();

		assert.equal(run.savedTo, '/tmp/notes.html');
		// The regression, stated as the reader sees it: where the formula belongs,
		// the exported page must hold the formula and not its source. (KaTeX renders
		// into the element and leaves `data-math-source` on it, which is why the
		// assertion is about what the element *contains*.)
		assert.match(
			run.document,
			/<p data-math="display" data-math-source="E = mc\^2"><span class="katex">/,
		);
		assert.doesNotMatch(run.document, /<p data-math="display"[^>]*>E = mc\^2<\/p>/);

		// Display and inline math both reach KaTeX, with the source the renderer
		// preserved rather than the text comrak happened to leave behind.
		assert.deepEqual(run.mathCalls, ['display:E = mc^2', 'inline:a_i']);
		assert.doesNotMatch(run.document, /\\\(/);
	});

	test('an exported file contains highlighted code', async () => {
		const run = await runExport();

		assert.match(run.document, /class="hljs-keyword"/);
		assert.match(run.document, /<code class="language-js hljs">/);
		// The shell the preview builds around a code block travels too, so the
		// exported page uses the same stylesheet rules the app does.
		assert.match(run.document, /class="code-block-shell"/);
		// The label is created for both paths but hidden in the export; it must not
		// arrive as a button that looks clickable and is not.
		assert.match(run.document, /\.lang-label \{\s*display: none !important;/);
	});

	test('an exported file contains drawn diagrams, not mermaid source', async () => {
		const run = await runExport({ mermaidTheme: 'dark' });

		assert.doesNotMatch(run.document, /language-mermaid/);
		// The diagram source travels on the container, which is what lets a later
		// PDF export re-render it in a light theme (#359).
		assert.match(run.document, /class="mermaid-diagram" data-mermaid-source="graph TD; A-->B;"/);
		assert.match(run.document, /<svg id="mermaid-/);
		// Mermaid's `<style>` is what carries a diagram's fills and strokes. It has
		// to survive into the export — the document-level policy forbids `<style>`
		// and would flatten every diagram, so the export must not re-run that filter
		// over the rendered output.
		assert.match(run.document, /<style>#mermaid-[^{]*\.node rect\{fill:#eee;\}<\/style>/);
		// The stand-in Mermaid above emits `foreignObject`; the real one no longer
		// does, and the diagram filter no longer allows it (see
		// scripts/preview.richContent.test.ts). What is pinned here is unchanged by
		// that: the export must hand the *diagram* filter's output through, not the
		// document policy's. Case-insensitive because the shim lower-cases tag names
		// on serialisation where a real browser keeps `foreignObject`.
		assert.match(run.document, /<foreignobject>/i);

		// The exported page carries the theme it was made in, so the diagrams are
		// baked for that theme rather than for paper.
		assert.deepEqual(run.mermaidThemes, ['dark']);
	});

	test('the export still assembles the same document around the rendered article', async () => {
		const run = await runExport({ theme: 'dark' });

		assert.match(run.document, /^<!DOCTYPE html>\n<html lang="en" data-theme="dark">/);
		assert.match(run.document, /<meta http-equiv="Content-Security-Policy" content="default-src 'none';/);
		assert.match(run.document, /<article class="markdown-body">/);
		// The heading still goes through `processMarkdownHtml`'s fold wrapping —
		// rich rendering is added to that pipeline, not substituted for it.
		assert.match(run.document, /<h1 class="foldable-header"[^>]*>.*Notes<\/h1>/);
	});

	test('a document with math carries only the KaTeX fonts it uses', async () => {
		const run = await runExport();

		// `.katex` implies KaTeX_Main; the `mathnormal` span implies KaTeX_Math.
		// KaTeX_Caligraphic is declared in the stylesheet and referenced by nothing,
		// so it must not be paid for.
		//
		// The URLs are fetched absolute, resolved against the *stylesheet* rather
		// than the page. Resolving against `location.href` — the obvious thing, and
		// what the first draft did — silently produces
		// `http://tauri.localhost/KaTeX_Main-Regular…woff2`, which 404s, drops the
		// face and leaves the formula in Times without anything looking broken.
		assert.deepEqual(run.fetched, [
			'http://tauri.localhost/_app/immutable/assets/KaTeX_Main-Regular.B22Nviop.woff2',
			'http://tauri.localhost/_app/immutable/assets/KaTeX_Math-Italic.woff2',
		]);

		assert.match(run.document, /font-family: KaTeX_Main; src: url\(data:font\/woff2;base64,d09GMg==\) format\("woff2"\)/);
		assert.match(run.document, /font-family: KaTeX_Math; src: url\(data:font\/woff2;base64,d09GMg==\) format\("woff2"\)/);
		assert.doesNotMatch(run.document, /KaTeX_Caligraphic-Regular\.woff2/);
		// No app-internal URL survives into the file, absolute or relative.
		assert.doesNotMatch(run.document, /tauri\.localhost/);
		assert.doesNotMatch(run.document, /url\("\.\//);
	});

	test('a document with no math carries no KaTeX fonts at all', async () => {
		// The state #382 measured and decided was fine: nothing references the
		// families, so the rules were dead weight whose relative URLs 404 next to
		// the file. They now go, rather than travelling as a lie about what the
		// document needs.
		const cssOnly = KATEX_CSS;
		// Every face's bytes are in hand, so the family filter is the only thing
		// left that can drop them. Handing this an empty byte map — which is what
		// it used to do — deletes every face through the "bytes could not be read"
		// branch instead, and deleting the family filter outright stayed green.
		const bytes = new Map(
			findKatexFontFaces(cssOnly).map((face) => [face.woff2Url!, 'data:font/woff2;base64,d09GMg==']),
		);
		assert.equal(bytes.size, 3, 'the fixture stylesheet declares three faces, all with woff2 bytes');

		const document = inlineKatexFontFaces(cssOnly, new Set(), bytes);
		assert.doesNotMatch(document, /@font-face/);
		assert.match(document, /\.katex \{/);
	});

	// ------------------------------------------------- the pieces, on their own

	test('the renderer works on a detached element', async () => {
		// The property that makes one implementation possible for both paths: the
		// export renders into a `<div>` that is in no document, so nothing in the
		// renderer may reach for a global element.
		const record = { mermaidThemes: [] as string[], mathCalls: [] as string[] };
		const root = (globalThis as any).document.createElement('div');
		root.innerHTML = RENDERED;
		assert.equal(root.parentNode, null);

		await renderRichContent({
			roots: [root],
			libraries: fakeLibraries(record) as any,
			mermaidTheme: 'neutral',
			idFactory: (index: number) => `diagram-${index}`,
		});

		assert.match(root.innerHTML, /<svg id="diagram-0"/);
		assert.match(root.innerHTML, /class="katex"/);
		assert.match(root.innerHTML, /class="hljs-keyword"/);
	});

	test('the font pass reads the stylesheet rather than a hard-coded family list', () => {
		const faces = findKatexFontFaces(KATEX_CSS);
		assert.deepEqual(
			faces.map((face) => [face.family, face.woff2Url]),
			[
				['KaTeX_Main', './KaTeX_Main-Regular.B22Nviop.woff2'],
				['KaTeX_Math', './KaTeX_Math-Italic.woff2'],
				['KaTeX_Caligraphic', './KaTeX_Caligraphic-Regular.woff2'],
			],
		);

		// Only KaTeX's own faces are made absolute, and only while the sheet that
		// owns them is still known.
		assert.equal(
			absolutizeKatexFontUrls(
				'@font-face { font-family: KaTeX_Main; src: url("./KaTeX_Main-Regular.B22Nviop.woff2") format("woff2"); }',
				SHEET_HREF,
			),
			'@font-face { font-family: KaTeX_Main; src: url("http://tauri.localhost/_app/immutable/assets/KaTeX_Main-Regular.B22Nviop.woff2") format("woff2"); }',
		);
		assert.equal(
			absolutizeKatexFontUrls('@font-face{font-family:codicon;src:url(./codicon.ttf)}', SHEET_HREF),
			'@font-face{font-family:codicon;src:url(./codicon.ttf)}',
		);

		const root = (globalThis as any).document.createElement('div');
		root.innerHTML = '<span class="katex"><span class="mord mathcal">L</span></span>';
		const families = collectUsedKatexFamilies(root, KATEX_CSS);
		// `.katex` alone pulls in KaTeX_Main; `mathcal` adds Caligraphic; nothing
		// asks for KaTeX_Math.
		assert.deepEqual([...families].sort(), ['KaTeX_Caligraphic', 'KaTeX_Main']);
		assert.deepEqual(katexFontUrlsToEmbed(KATEX_CSS, families), [
			'./KaTeX_Main-Regular.B22Nviop.woff2',
			'./KaTeX_Caligraphic-Regular.woff2',
		]);

		// A face whose bytes could not be read is deleted, not left pointing at a
		// URL that does not exist next to the exported file.
		const withoutBytes = inlineKatexFontFaces(KATEX_CSS, families, new Map());
		assert.doesNotMatch(withoutBytes, /@font-face/);
	});

	test('an element with no math needs no fonts', () => {
		const root = (globalThis as any).document.createElement('div');
		root.innerHTML = '<p>plain text</p>';
		assert.equal(collectUsedKatexFamilies(root, KATEX_CSS).size, 0);
	});
});

describe('export sanitizing', () => {
	// DOMPurify itself needs a real DOM, which the Node test runner does not have,
	// so these tests exercise the two halves of the policy that are checkable here:
	// the URI decision (a pure regexp, applied exactly the way DOMPurify applies it,
	// see purify.es.mjs line ~1041) and the configuration that decides what the
	// filter may keep. The behavioural half was verified against the real DOMPurify
	// build in Chrome: `sanitizeMarkdownHtml(POC)` returns `<img src="x">` — the
	// event handler, and with it the whole payload, is gone.
	const ATTR_WHITESPACE = /[\u0000-\u0020\u00A0\u1680\u180E\u2000-\u2029\u205F\u3000]/g;

	function uriIsAllowed(value: string): boolean {
		return ALLOWED_MARKDOWN_URI_REGEXP.test(value.replace(ATTR_WHITESPACE, ''));
	}

	test('dangerous URIs are rejected by the shared policy', () => {
		const rejected = [
			'javascript:alert(1)',
			'JaVaScRiPt:alert(1)',
			// DOMPurify strips whitespace and control characters before testing, so
			// the classic obfuscations collapse onto the same decision.
			'java\tscript:alert(1)',
			' javascript:alert(1)',
			'java\u0000script:alert(1)',
			'data:text/html,<script>alert(1)</script>',
			'data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==',
			'vbscript:msgbox(1)',
		];

		for (const uri of rejected) {
			assert.equal(uriIsAllowed(uri), false, `${uri} must not be an allowed URI`);
		}

		// `data:` on an `<a href>` is rejected above; DOMPurify separately permits
		// `data:` on `<img>`/`<video>`/`<audio>` sources regardless of this regexp
		// (DATA_URI_TAGS), which is what keeps embedded export images working.
		assert.equal(uriIsAllowed('data:image/png;base64,iVBORw0KGgo='), false);
	});

	test('the link shapes real documents use still pass', () => {
		const allowed = [
			'https://example.com/page?a=b#c',
			'http://example.com/page',
			'ftp://files.example.com/x.txt',
			'mailto:someone@example.com',
			'tel:+15551234567',
			'#section-heading',
			'./notes/other.md',
			'../images/diagram.png',
			'images/pic.png',
			'assets/a b.png',
			// Local images after `convertFileSrc`, in both shapes it emits.
			'asset://localhost/Users/x/notes/pic.png',
			'http://asset.localhost/C%3A%2FDocs%2Fimg%2Fa.png',
			'tauri://localhost/x',
			// A Windows drive path pointing at another markdown document, which the
			// viewer opens as an internal navigation and the export rewrites to .html.
			'C:\\notes\\other.md',
			'D:/notes/other.markdown#heading',
		];

		for (const uri of allowed) {
			assert.equal(uriIsAllowed(uri), true, `${uri} must remain an allowed URI`);
		}
	});

	test('the sanitizer and the link resolver agree on markdown extensions', () => {
		// The URI pattern splices this list into a regexp, so a divergence would
		// silently make some internal markdown links unclickable.
		for (const ext of MARKDOWN_LINK_EXTENSIONS) {
			assert.equal(hasMarkdownLinkExtension(`note.${ext}`), true, `.${ext} must be a markdown link extension`);
			assert.equal(uriIsAllowed(`C:\\notes\\note.${ext}`), true, `C:\\notes\\note.${ext} must be allowed`);
		}
		assert.equal(hasMarkdownLinkExtension('note.html'), false);
		assert.equal(uriIsAllowed('C:\\notes\\note.exe'), false);
	});
});

describe('exported theme', () => {
	/** The opening `<html …>` tag of a built export. */
	function htmlTag(document: string): string {
		const match = document.match(/<html[^>]*>/);
		assert.ok(match, 'the export must contain an <html> tag');
		return match[0];
	}

	/** Does `<html …>` satisfy a `[data-theme="…"]` attribute selector? */
	function matchesThemeSelector(document: string, theme: string): boolean {
		return new RegExp(`<html[^>]*\\sdata-theme="${theme}"`).test(htmlTag(document));
	}

	function build(theme: string | null | undefined, extra: Partial<{ styles: string; title: string; articleHtml: string }> = {}) {
		return buildExportDocument({
			theme,
			title: extra.title ?? 'Notes',
			styles: extra.styles ?? '',
			articleHtml: extra.articleHtml ?? '<p>body</p>',
			contentWidth: DEFAULT_PREVIEW_MAX_WIDTH,
			appearance: plainAppearance,
		});
	}

	test('an explicitly themed window exports a document wearing that theme', () => {
		// Every dark variable in the app hangs off `:root[data-theme="dark"]`. The
		// rule is copied into the export with the rest of the stylesheet, so
		// without the attribute the copied rule is dead weight and the file falls
		// back to the light `:root` block (or, on a dark machine, to the
		// `prefers-color-scheme` block) — never to what the exporter was looking at.
		for (const theme of ['dark', 'light']) {
			assert.ok(matchesThemeSelector(build(theme), theme), `an export from the ${theme} theme must carry data-theme="${theme}"`);
		}
	});

	test('an imported VS Code theme survives the export', () => {
		// `parseAndApplyVscodeTheme` writes `:root[data-theme="vscode"] { … }` into a
		// <style> tag, which `document.styleSheets` hands to the export like any
		// other sheet. The attribute is the only thing that can make it match.
		const doc = build('vscode', { styles: ':root[data-theme="vscode"] { --color-canvas-default: #1e1e1e; }' });
		assert.ok(matchesThemeSelector(doc, 'vscode'));
		assert.match(doc, /:root\[data-theme="vscode"\]/);
	});

	test('the theme attribute cannot break out of the tag', () => {
		// `data-theme` is a string read back off the DOM and interpolated into
		// markup. Nothing writes a hostile one today; the export must not be the
		// place that finds out when something does.
		const hostile = ['x" onload="alert(1)', '"><script>alert(1)</script>', "dark'", 'dark theme', 'a'.repeat(33), '../../etc'];
		for (const theme of hostile) {
			assert.equal(exportThemeAttribute(theme), '', `${theme} must not reach the markup`);
			assert.match(htmlTag(build(theme)), /^<html lang="en">$/);
		}
		assert.equal(exportThemeAttribute(42 as unknown as string), '');
	});

	test('theming the document did not cost it any of its other protections', () => {
		// #376 put a CSP and a title escape in this template; extracting the
		// template must carry both across unchanged.
		const doc = build('dark', { title: '<script>alert(1)</script>' });
		assert.match(doc, /<meta http-equiv="Content-Security-Policy" content="default-src 'none'; /);
		assert.doesNotMatch(doc, /script-src/);
		assert.match(doc, /<title>&lt;script&gt;alert\(1\)&lt;\/script&gt;<\/title>/);
		assert.doesNotMatch(doc, /<title><script>/);
		assert.match(build('dark', { title: '' }), /<title>Export<\/title>/);
	});

	test('the copied stylesheet and the article still land in the document', () => {
		const doc = build('dark', { styles: '.sentinel { color: red; }', articleHtml: '<p id="sentinel">hello</p>' });
		assert.match(doc, /<style>[\s\S]*\.sentinel \{ color: red; \}/);
		assert.match(doc, /<article class="markdown-body">\n<p id="sentinel">hello<\/p>/);
		assert.match(doc, /^<!DOCTYPE html>\n/);
	});
});

describe('mermaid print theme', () => {
	/** Minimal stand-in for the container the source is remembered on. */
	class FakeElement {
		attributes = new Map<string, string>();
		innerHTML = '';
		constructor(public className = '') {}
		setAttribute(name: string, value: string) {
			this.attributes.set(name, value);
		}
		getAttribute(name: string) {
			return this.attributes.has(name) ? this.attributes.get(name)! : null;
		}
	}

	/** The fake seen as the `Element` the helpers' signatures ask for. */
	const asElement = (element: FakeElement) => element as unknown as Element;

	function diagram(source: string | null, html: string) {
		const element = new FakeElement('mermaid-diagram');
		if (source !== null) rememberDiagramSource(asElement(element), source, 'dark');
		element.innerHTML = html;
		return element;
	}

	test('the diagram theme follows the app appearance', () => {
		assert.equal(resolveMermaidTheme({ theme: 'dark', systemPrefersDark: false }), 'dark');
		assert.equal(resolveMermaidTheme({ theme: 'light', systemPrefersDark: true }), 'neutral');
		assert.equal(resolveMermaidTheme({ theme: 'system', systemPrefersDark: true }), 'dark');
		assert.equal(resolveMermaidTheme({ theme: 'system', systemPrefersDark: false }), 'neutral');
		// A VS Code theme reports its polarity through the dataset instead.
		assert.equal(
			resolveMermaidTheme({ theme: 'vscode:whatever', datasetThemeType: 'dark', systemPrefersDark: false }),
			'dark',
		);
	});

	test('the source is kept on the container so the diagram can be rebuilt', () => {
		const element = diagram('flowchart TD\n A --> B', '<svg>screen</svg>');
		assert.equal(readDiagramSource(asElement(element)), 'flowchart TD\n A --> B');
		// A diagram rendered before the source was remembered reads as null rather
		// than as an empty source.
		assert.equal(readDiagramSource(asElement(diagram(null, '<svg/>'))), null);
	});
});

/**
 * #968: a Windows PDF export ran with nothing on screen, so a reader could not
 * tell it from a finished one. `exportAsPdf` now says when the work starts and
 * which file it wrote, and the viewer turns those into a toast and the open
 * prompt the HTML export already had.
 */
describe('PDF export result', () => {
	// As in `export.test.ts`: the shim, and DOMPurify as the identity.
	useShimDom({ window: globalThis, location: { href: 'http://tauri.localhost/' }, addEventListener: () => {} }, { identitySanitize: true });

	function exportWith(osType: 'windows' | 'macos', savePath: string | null) {
		const events: string[] = [];
		(globalThis as any).window.__TAURI_INTERNALS__ = {
			invoke: async (command: string, args: any) => {
				events.push(command);
				if (command === 'plugin:dialog|save') return savePath;
				if (command === 'render_markdown') return '<p>body</p>';
				if (command === 'export_pdf_windows') {
					assert.equal(args.path, savePath);
					return null;
				}
				if (command === 'print_pdf') return null;
				throw new Error(`unexpected command ${command}`);
			},
		};
		const result = exportAsPdf({
			rawContent: 'body\n',
			tabTitle: 'Notes',
			tabPath: 'C:/Docs/notes.md',
			mermaidTheme: 'neutral',
			newlineBreaks: true,
			libraries: {
				hljs: { getLanguage: () => null },
				katex: { renderToString: () => '' },
				renderMathInElement() {},
				mermaid: { initialize() {}, async render() { return { svg: '' }; } },
			} as any,
			contentWidth: null,
			appearance: plainAppearance,
			osType,
			printRoot: {
				style: { setProperty() {} },
				replaceChildren() {},
				querySelectorAll: () => [],
			} as any,
			onStart: () => events.push('start'),
		});
		return { result, events };
	}

	test('a Windows export reports its start, then the file it wrote', async () => {
		const { result, events } = exportWith('windows', 'C:/Docs/notes.pdf');
		assert.equal(await result, 'C:/Docs/notes.pdf');
		assert.deepEqual(
			events.filter((e) => e !== 'render_markdown'),
			['plugin:dialog|save', 'start', 'export_pdf_windows'],
		);
	});

	test('cancelling the Windows save dialog starts nothing', async () => {
		const { result, events } = exportWith('windows', null);
		assert.equal(await result, null);
		assert.deepEqual(events, ['plugin:dialog|save']);
	});

	test('the print sheet owns the path, so there is no file to report', async () => {
		const { result, events } = exportWith('macos', null);
		assert.equal(await result, null);
		assert.deepEqual(
			events.filter((e) => e !== 'render_markdown'),
			['start', 'print_pdf'],
		);
	});
});
