import { save } from '@tauri-apps/plugin-dialog';
import { invoke } from '@tauri-apps/api/core';
import { getMarkdownBodyWithoutFrontMatter, parseFrontMatter } from './frontMatter.js';
import { processMarkdownHtml } from './markdown.js';
import {
	escapeHtml,
	renderStaticFrontMatterPanel,
	resolveExportImagePath,
	rewriteMarkdownHrefForExport,
} from './exportHtml.js';
import { sanitizeMarkdownHtml } from './sanitize.js';
import {
	loadRichContentLibraries,
	renderRichContent,
	type RichContentLibraries,
} from './richContent.js';
import {
	absolutizeKatexFontUrls,
	collectUsedKatexFamilies,
	fetchFontDataUrls,
	inlineKatexFontFaces,
	katexFontUrlsToEmbed,
} from './exportFonts.js';
import { normalizePreviewMaxWidth } from './previewWidth.js';

interface ExportContext {
	rawContent: string;
	tabTitle: string;
	tabPath: string;
	/**
	 * The cap the preview is currently reading at, i.e. the value
	 * `getPreviewContentWidth(settings.previewMaxWidth, isFullWidth)` hands the
	 * live `.markdown-body` as `--preview-max-width`. `null` is full-width mode.
	 * The export follows it rather than carrying a width of its own — see
	 * `exportContentMaxWidth`.
	 */
	contentWidth: number | null;
	/**
	 * Mermaid's theme name for the appearance this export is being made in.
	 * Unlike the PDF route — paper is always white, so that one forces a light
	 * theme — an HTML export deliberately carries the author's theme (see
	 * `exportThemeAttribute` below), so the diagrams have to be baked to match.
	 */
	mermaidTheme: string;
	/**
	 * The libraries the preview is already using, handed in the same way
	 * `renderDiagramsForPrint` takes `mermaid` and `sanitizeSvg`. Passing the
	 * viewer's own instances is what guarantees the exported document was
	 * produced by the same highlight.js language registry and the same KaTeX
	 * the user was looking at. `null` (an export triggered before the lazy load
	 * finished) falls back to the shared loader.
	 */
	libraries: RichContentLibraries | null;
}

type ExportHtmlResult = {
	path: string;
	embeddedImages: number;
	missingImages: number;
};

export interface PdfExportContext {
	tabPath: string;
	osType: 'macos' | 'windows' | 'linux' | 'unknown';
}

// An exported file leaves the app: it is opened in the user's default browser
// straight from the export prompt, mailed on, dropped in a shared folder. None
// of the app's own protections travel with it, so it carries its own policy as
// a second, independent line of defence behind the sanitizer — a bug in the
// filter should not be enough to get script into someone else's browser.
//
// Everything an export needs is inline or embedded, so the document needs no
// network privileges beyond images and media. Verified against a real export
// shape in Chrome (both over http: and as a `file://` document, where the meta
// tag is enforced the same way):
//   - `style-src 'unsafe-inline'` keeps the copied stylesheet and the inline
//     `style` attributes (`max-width:100%` on media) working; without it the
//     page loses all layout.
//   - `img-src`/`media-src data:` keeps embedded images and the `mask-image`
//     data URIs in the copied CSS working; `https:`/`http:` keeps images the
//     export deliberately leaves remote working.
//   - the only things the policy blocks are things that were already dead in an
//     exported file: `asset:` URLs left behind by an image that failed to embed,
//     and KaTeX's relative `@font-face` URLs, which 404 without the policy too.
//   - link navigation, `<details>` toggling and text selection are unaffected.
const EXPORT_CSP = [
	"default-src 'none'",
	'img-src data: https: http:',
	'media-src data: https: http:',
	"style-src 'unsafe-inline'",
	'font-src data:',
	"base-uri 'none'",
	"form-action 'none'",
].join('; ');

// The app paints itself from CSS variables that are selected by an attribute on
// the root element: `:root[data-theme="dark"]`, `:root[data-theme="light"]` and
// — for an imported VS Code theme — `:root[data-theme="vscode"]`, whose rule is
// generated into a `<style>` tag and therefore travels with the copied
// stylesheet. Without the attribute on the exported document none of those
// selectors can ever match, so a file exported from a dark or an imported theme
// arrived looking like neither.
//
// `system` is the deliberate exception. It is not a colour, it is the
// instruction "use the colours of the machine I am reading this on", and the
// app implements it by removing the attribute and letting
// `@media (prefers-color-scheme: dark)` decide. An export carrying no attribute
// reproduces exactly that: the same document, the same cascade, resolved
// wherever it is opened. Freezing the exporter's momentary system colour
// instead would produce a file that disagrees with the author's own screen the
// next time their machine switches at sunset.
//
// The value is validated rather than trusted: it is interpolated into markup,
// and `data-theme` is a plain string that a future import path could take from
// a theme file. Anything unexpected degrades to the no-attribute (viewer's
// system) case rather than escaping the attribute's quotes.
const SAFE_EXPORT_THEME = /^[A-Za-z0-9_-]{1,32}$/;

export function exportThemeAttribute(theme: string | null | undefined): string {
	if (typeof theme !== 'string' || !SAFE_EXPORT_THEME.test(theme)) return '';
	return ` data-theme="${theme}"`;
}

export interface ExportDocumentInput {
	/** `document.documentElement.dataset.theme`, i.e. undefined for `system`. */
	theme: string | null | undefined;
	title: string;
	/** The app's own stylesheets, already serialised. */
	styles: string;
	/** The finished `.markdown-body` content. */
	articleHtml: string;
	/** See `ExportContext.contentWidth` and `exportContentMaxWidth`. */
	contentWidth: number | null;
}

/**
 * The `max-width` an exported `.markdown-body` is given.
 *
 * The export used to hard-code `900px`, which was nobody's number: not the
 * user's Preview → Max width (#346–#349, renamed in #456), and not even the
 * app's own default of 880. So a document read at 640 or at 1600 arrived at
 * 900 regardless, and the setting that governs every other rendering of the
 * same document silently stopped at the file dialog. It follows the setting
 * now: one source of truth, and what leaves the app is the measure it was
 * written and read at.
 *
 * `null` is full-width mode, and it becomes `none` rather than the preview's
 * `100%`. The two are equivalent for this element — `.markdown-body` is a block
 * child of `<body>`, so a percentage cap resolves to the width it already has —
 * but `none` says the intended thing without depending on that reasoning, and
 * it cannot interact with `box-sizing` the way a percentage can. `margin: 0
 * auto` then centres nothing (there is no slack to distribute) and the
 * `padding: 40px !important` still holds the text off the window edge, which is
 * exactly how the preview behaves in full-width mode.
 *
 * The value is normalized here rather than trusted, because this is the seam
 * where it stops being a number and becomes a CSS declaration: `previewMaxWidth`
 * is restored from localStorage, and a corrupted or hand-edited key must not be
 * able to interpolate itself raw into the exported stylesheet. An unusable value
 * degrades to the app default the same way the preview's does.
 */
export function exportContentMaxWidth(contentWidth: number | null): string {
	return contentWidth === null ? 'none' : `${normalizePreviewMaxWidth(contentWidth)}px`;
}

/**
 * Assembles the single file that leaves the app. Kept separate from
 * `exportAsHtml` (which owns the file dialog, the renderer round trip and the
 * image embedding) so the shape of the artefact can be asserted directly.
 */
export function buildExportDocument(input: ExportDocumentInput): string {
	return `<!DOCTYPE html>
<html lang="en"${exportThemeAttribute(input.theme)}>
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${EXPORT_CSP}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${escapeHtml(input.title || 'Export')}</title>
<style>
${input.styles}
html, body {
	overflow: auto !important;
	height: auto !important;
	min-height: 100vh;
	background-color: var(--color-canvas-default, #ffffff);
	margin: 0;
	padding: 0;
}
.markdown-body {
	padding: 40px !important;
	max-width: ${exportContentMaxWidth(input.contentWidth)};
	margin: 0 auto;
	height: auto !important;
	overflow: visible !important;
	min-height: 100%;
}
.lang-label {
	display: none !important;
}
.export-frontmatter-panel {
	margin: 0 0 24px 0;
}
.export-frontmatter-panel .frontmatter-grid {
	display: grid;
	grid-template-columns: max-content minmax(0, 1fr);
	gap: 8px 16px;
	padding: 12px 0 0 0;
}
.export-frontmatter-panel .frontmatter-key {
	color: var(--color-fg-muted, #57606a);
	font-weight: 600;
}
.export-frontmatter-panel .frontmatter-tags {
	display: flex;
	flex-wrap: wrap;
	gap: 6px;
}
.export-frontmatter-panel .frontmatter-tag {
	border: 1px solid var(--color-border-default, #d0d7de);
	border-radius: 999px;
	padding: 2px 8px;
	background: var(--color-neutral-muted, rgba(175, 184, 193, 0.2));
}
.markdown-body pre {
	white-space: pre-wrap !important;
	word-break: break-word !important;
}
/* Nothing in an exported file can open a fold: the policy above forbids
   script, and the app's toggles are not there to click. A section that ships
   collapsed therefore ships unreadable — its text is in the file, clipped to
   zero height at zero opacity, with nothing that could ever reveal it.
   Heading folds arrive open already (the render above is handed an empty fold
   state); a callout written as "> [!note]-" carries its collapsed state in the
   markup itself and has to be opened here. The print/PDF route takes the same
   position from the other side, in the @media print block of styles.css. */
.foldable-content-wrapper.is-collapsed {
	height: auto !important;
	opacity: 1 !important;
	overflow: visible !important;
}
.markdown-alert-content.is-collapsed {
	grid-template-rows: 1fr !important;
	opacity: 1 !important;
	overflow: visible !important;
}
.foldable-content-wrapper .content-inner,
.markdown-alert-content .content-inner {
	overflow: visible !important;
}
.header-fold-icon,
.callout-fold-icon {
	display: none !important;
}
</style>
</head>
<body>
<article class="markdown-body">
${input.articleHtml}
</article>
</body>
</html>`;
}

/**
 * Runs the preview's renderer over the detached export DOM.
 *
 * Placed *after* `sanitizeMarkdownHtml` on purpose, and the document-level
 * filter is deliberately not run again afterwards. Two reasons, and they point
 * the same way:
 *
 *   - The filter's job is to see the untrusted document, which it already did:
 *     everything added from here on is markup Markpad's own libraries generate.
 *     highlight.js re-emits the code block as escaped text; KaTeX builds nodes
 *     itself and runs with its default `trust: false`, so `\href`, `\url` and
 *     `\includegraphics` are inert; Mermaid's SVG goes through
 *     `sanitizeDiagramSvg`, the same filter the preview uses.
 *   - Running the document policy over Mermaid's SVG would destroy it.
 *     `MARKDOWN_SANITIZE_CONFIG` sets `FORBID_TAGS: ['style']`, and Mermaid
 *     ships every diagram's fills, strokes and label colours as a `<style>`
 *     inside the SVG. Strip it and the diagram arrives as an unstyled skeleton.
 *
 * That `<style>` is the one genuinely new thing an export now carries, so it is
 * worth being explicit about why it is acceptable here:
 *
 *   - It is namespaced. Mermaid compiles the block through stylis with a
 *     middleware that prefixes every rule with `#<svg-id>` and drops any at-rule
 *     outside a small allowlist (`@import` and `@font-face` are removed). The
 *     id is one Markpad generates, not one the document chose. So the block
 *     cannot restyle anything outside its own diagram, and cannot pull in a
 *     remote stylesheet or font.
 *   - It is not a new capability. A diagram's `classDef` declarations do reach
 *     the block, so a hostile document could in principle land a
 *     `url(https://…)` in it and have the exported file phone home when opened.
 *     But the export already leaves remote `<img src="https://…">` exactly as
 *     the author wrote it, and the export CSP allows `img-src https: http:`
 *     precisely so those keep working. A document that wants to beacon on open
 *     can already do it in one line of Markdown, with no diagram involved.
 *   - The exported file is a *less* privileged place for it than the preview,
 *     which has been injecting this same `<style>` into the app's live document
 *     since diagrams were added. There, `<style>` is worth forbidding at the
 *     document level (it can hide the title bar); in a standalone file whose
 *     entire content is the user's own document, there is nothing to hide.
 */
async function renderExportRichContent(root: HTMLElement, ctx: ExportContext): Promise<void> {
	try {
		const libraries = ctx.libraries ?? (await loadRichContentLibraries());
		await renderRichContent({
			// One root, and always the whole thing: an exported file is a string,
			// so there is no previous DOM to keep any of. The preview's split from
			// this — same render, same filter, same detached parse, then either
			// serialize it or diff it into the article — is the whole reason
			// `blockPatch.ts` takes an already-sanitized string and produces nodes
			// rather than owning a render of its own.
			roots: [root],
			libraries,
			mermaidTheme: ctx.mermaidTheme,
			onError: (error) => console.error('Rich content failed to render for HTML export', error),
			// `onCopyCode` is deliberately not passed: an exported file cannot
			// run script, so the language label there is a static label rather
			// than a copy button that silently does nothing.
		});
	} catch (error) {
		// An export that ships the raw block is worse than one that does not,
		// but it is much better than an export that never happens.
		console.error('Failed to render rich content for HTML export', error);
	}
}

async function buildExportArticle(ctx: ExportContext): Promise<{ root: HTMLElement; embeddedImages: number; missingImages: number }> {
	const body = getMarkdownBodyWithoutFrontMatter(ctx.rawContent);
	const rendered = (await invoke('render_markdown', { content: body })) as string;
	// The export used to write `rendered` to disk untouched. comrak runs with
	// `unsafe_ = true`, so a script the preview had filtered out was still live
	// in the exported file — and the exported file has no CSP of the app's, gets
	// opened in the user's default browser straight from the export prompt, and
	// gets forwarded to other people. Sanitize here, at the seam where the
	// untrusted document enters the pipeline, rather than after
	// `processMarkdownHtml`: everything that function emits (fold wrappers,
	// chevron SVGs, callout containers, `<video>`/`<audio>` replacements) plus
	// the front-matter panel below is markup Markpad builds itself, and running
	// the filter over our own output only creates a way for a future tightening
	// of the policy to silently delete parts of the export. Nothing downstream
	// can reintroduce untrusted markup: `processMarkdownHtml` parses with
	// DOMParser (inert — no script execution, no resource loads) and only ever
	// assigns `innerHTML` from its own constant SVG strings.
	const safeHtml = sanitizeMarkdownHtml(rendered);
	// No collapsed headers, ever. An export is the act of handing the document
	// to someone who does not have the app, the fold state or a way to open one,
	// so every section ships expanded — a fold is a reading convenience of this
	// session, not part of the document. The print/PDF path is held to the same
	// rule from the other end (see the `@media print` block in styles.css, which
	// un-collapses folds instead of clipping them to zero height), so the two
	// export routes cannot disagree about what is in the file.
	const processed = processMarkdownHtml(safeHtml, ctx.tabPath, new Set());
	const wrapper = document.createElement('div');
	wrapper.innerHTML = renderStaticFrontMatterPanel(parseFrontMatter(ctx.rawContent)) + processed;

	// Highlight, typeset and draw before the link and image passes, so those see
	// the markup that actually ships. The renderer works on this detached
	// element exactly as it works on the live preview: nothing an exported file
	// contains can be produced by the file itself, because the policy above
	// grants it no script privilege, so all of it has to be baked in here.
	await renderExportRichContent(wrapper, ctx);

	for (const link of Array.from(wrapper.querySelectorAll('a[href]'))) {
		const href = link.getAttribute('href');
		if (!href) continue;
		link.setAttribute('href', rewriteMarkdownHrefForExport(href));
	}

	let embeddedImages = 0;
	let missingImages = 0;
	for (const img of Array.from(wrapper.querySelectorAll('img[src]'))) {
		const src = img.getAttribute('src');
		if (!src) continue;

		const localPath = resolveExportImagePath(src, ctx.tabPath);
		if (!localPath) continue;

		try {
			const dataUrl = (await invoke('read_file_as_data_url', { path: localPath })) as string;
			img.setAttribute('src', dataUrl);
			embeddedImages += 1;
		} catch (e) {
			missingImages += 1;
			img.setAttribute('data-markpad-export-missing-src', src);
			console.warn('Failed to embed image for HTML export', localPath, e);
		}
	}

	return {
		root: wrapper,
		embeddedImages,
		missingImages,
	};
}

/**
 * Replaces KaTeX's `@font-face` rules in the copied stylesheet with the fonts
 * the finished article actually references, inline as data URIs, and deletes
 * the rest. See `exportFonts.ts` for why this is now worth doing and why it is
 * done per family. A document with no math loses ~5 KB of dead rules and gains
 * nothing else.
 */
async function embedExportFonts(styles: string, root: HTMLElement): Promise<string> {
	try {
		const usedFamilies = collectUsedKatexFamilies(root, styles);
		const dataUrls = usedFamilies.size
			? await fetchFontDataUrls(katexFontUrlsToEmbed(styles, usedFamilies))
			: new Map<string, string>();
		return inlineKatexFontFaces(styles, usedFamilies, dataUrls);
	} catch (error) {
		// Worst case the export keeps the rules it has always had, which resolve
		// to nothing next to the file. That is the pre-existing behaviour, not a
		// regression, and it must not cost the user the export.
		console.error('Failed to embed export fonts', error);
		return styles;
	}
}

export async function exportAsHtml(ctx: ExportContext): Promise<ExportHtmlResult | null> {
	if (!ctx.rawContent) return null;

	const defaultName = ctx.tabPath ? ctx.tabPath.replace(/\.[^.]+$/, '.html') : 'export.html';

	const selected = await save({
		filters: [{ name: 'HTML', extensions: ['html', 'htm'] }],
		defaultPath: defaultName,
	});
	if (!selected) return null;

	let styles = '';
	for (const sheet of document.styleSheets) {
		try {
			for (const rule of sheet.cssRules) {
				// The stylesheet's own URL is the base KaTeX's relative font
				// sources resolve against, and it is only available here.
				styles += absolutizeKatexFontUrls(rule.cssText, sheet.href) + '\n';
			}
		} catch {
			// cross-origin sheets
		}
	}

	const article = await buildExportArticle(ctx);
	styles = await embedExportFonts(styles, article.root);

	const fullHtml = buildExportDocument({
		theme: document.documentElement.dataset.theme,
		title: ctx.tabTitle,
		styles,
		articleHtml: article.root.innerHTML,
		contentWidth: ctx.contentWidth,
	});

	try {
		await invoke('save_file_content', { path: selected, content: fullHtml, encoding: 'UTF-8' });
		return {
			path: selected,
			embeddedImages: article.embeddedImages,
			missingImages: article.missingImages,
		};
	} catch (e) {
		console.error('Failed to export HTML', e);
		return null;
	}
}

export async function exportAsPdf(ctx: PdfExportContext) {
	if (ctx.osType !== 'windows') {
		await invoke('print_pdf');
		return;
	}

	const defaultName = ctx.tabPath ? ctx.tabPath.replace(/\.[^.]+$/, '.pdf') : 'export.pdf';
	const selected = await save({
		filters: [{ name: 'PDF', extensions: ['pdf'] }],
		defaultPath: defaultName,
	});
	if (!selected) return;

	await invoke('export_pdf_windows', { path: selected });
}
