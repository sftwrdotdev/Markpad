/**
 * Paper needs light diagrams, but Mermaid bakes the theme into the SVG it
 * emits: fills, strokes and label colours are attributes on the generated
 * elements, not variables a stylesheet can retarget.
 *
 * Overriding them from the print stylesheet means enumerating Mermaid's
 * internal class names, and those differ per diagram type and drift between
 * releases — flowchart nodes sit under `g.node`, sequence actors are a bare
 * `rect.actor`, flowchart labels moved into `foreignObject` in v11 while
 * sequence labels are still `<text>`. Miss one and the result is worse than
 * no override at all: the label rule lands, the fill rule does not, and dark
 * text ends up painted on a dark box.
 *
 * So instead of recolouring the output we re-render it: the export draws its
 * own copy of the document with `MERMAID_PRINT_THEME` (see `exportAsPdf`),
 * which is correct for every diagram type, including ones added by future
 * Mermaid versions, and needs no print CSS at all.
 */

const SOURCE_ATTR = 'data-mermaid-source';

/**
 * The Mermaid theme the SVG on the container was drawn with.
 *
 * Kept next to the source because the colours are IN that SVG, so "is this
 * diagram current" is a question about the drawing and not about the document.
 * `renderRichContent` re-draws the containers whose answer no longer matches
 * the theme it was asked for; without it a theme change reached no diagram at
 * all, because a drawn diagram no longer has the `<pre>` that pass looks for.
 *
 */
const THEME_ATTR = 'data-mermaid-theme';

export const MERMAID_PRINT_THEME = 'neutral';

export interface MermaidConfig {
	startOnLoad: boolean;
	theme: string;
	htmlLabels: boolean;
}

interface MermaidRenderer {
	initialize(config: MermaidConfig): void;
	render(id: string, source: string): Promise<{ svg: string }>;
}

/**
 * The only place in the app that says how Mermaid is configured, because
 * `initialize` is not a merge. `setSiteConfig` rebuilds the config from
 * Mermaid's defaults on every call (`assignWithDepth({}, defaultConfig)`, then
 * the caller's keys on top of that), so a key one caller sends is gone the
 * moment another caller initializes without it.
 *
 * That is what `htmlLabels: false` is doing here. It keeps a diagram's text in
 * the picture: with Mermaid's default every flowchart, class, state, ER,
 * mindmap, block and kanban label is HTML inside a `<foreignObject>`, and
 * `sanitizeDiagramSvg` — like any DOMPurify — deletes HTML children of an SVG
 * element, so the labels arrive as empty shapes. The preview learned that in
 * `renderRichContent`; the print re-render below did not, and re-themed the
 * diagrams straight back into empty shapes on the way to the PDF (#717).
 * Handing both callers the same object is what stops the two from drifting
 * again. See scripts/mermaidDiagramLabels.test.ts for the measurement.
 */
export function mermaidConfig(theme: string): MermaidConfig {
	return { startOnLoad: false, theme, htmlLabels: false };
}

/**
 * Mermaid's own theme choice for the current appearance. Shared by the
 * on-screen render and the print restore so the two cannot drift.
 */
export function resolveMermaidTheme(input: {
	theme: string;
	datasetThemeType?: string;
	systemPrefersDark: boolean;
}): string {
	const isDark =
		input.datasetThemeType === 'dark' ||
		input.theme === 'dark' ||
		(input.theme === 'system' && input.systemPrefersDark);
	return isDark ? 'dark' : 'neutral';
}

/** Keeps the source and the theme next to the rendered diagram so it can be rebuilt later. */
export function rememberDiagramSource(container: Element, source: string, theme: string) {
	container.setAttribute(SOURCE_ATTR, source);
	container.setAttribute(THEME_ATTR, theme);
}

export function readDiagramSource(container: Element): string | null {
	return container.getAttribute(SOURCE_ATTR);
}

export function readDiagramTheme(container: Element): string | null {
	return container.getAttribute(THEME_ATTR);
}

