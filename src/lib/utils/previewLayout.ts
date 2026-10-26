import type { ExportAppearance, ExportContext } from './export';
import { fontFamilyValue } from './fontFamily.js';
import { t, type LanguageCode } from './i18n.js';
import { getPreviewContentWidth } from './previewWidth.js';
import type { SplitEditorSide } from './splitPanes.js';
import { isTocOverhanging, type TocSide } from './tocOverlay.js';

const HIGHLIGHT_COLORS: Record<string, string> = {
	default: 'color-mix(in srgb, var(--color-accent-fg) 40%, transparent)',
	yellow: 'rgba(255, 208, 0, 0.4)',
	orange: 'rgba(255, 140, 0, 0.4)',
	red: 'rgba(255, 60, 60, 0.4)',
	pink: 'rgba(255, 105, 180, 0.4)',
	purple: 'rgba(164, 108, 244, 0.4)',
	blue: 'rgba(67, 138, 243, 0.4)',
	cyan: 'rgba(43, 185, 178, 0.4)',
	green: 'rgba(77, 177, 88, 0.4)',
};

/** The slice of the settings store the preview's look is derived from. */
export type PreviewAppearanceSettings = {
	previewFont: string;
	previewFontSize: number;
	codeFont: string;
	codeFontSize: number;
	highlightColor: string;
};

/** The preview's fonts and highlight, which the exports carry as well. */
export function previewAppearanceFrom(settings: PreviewAppearanceSettings): ExportAppearance {
	return {
		fontFamily: fontFamilyValue(settings.previewFont, 'sans-serif'),
		fontSize: settings.previewFontSize,
		codeFontFamily: fontFamilyValue(settings.codeFont, 'monospace'),
		codeFontSize: settings.codeFontSize,
		highlightColor: HIGHLIGHT_COLORS[settings.highlightColor] || HIGHLIGHT_COLORS.yellow,
	};
}

export type PreviewLayoutSettings = {
	previewMaxWidth: unknown;
	previewFullWidth: boolean;
	tocSide: TocSide;
	splitEditorSide: SplitEditorSide;
	tocWidth: number;
};

export type PreviewView = { isEditing: boolean; isSplit: boolean; viewerWidth: number };

/**
 * The preview's measure and whether the outline covers it. Both come from the
 * one content width, so the outline cannot think there is a gutter the preview
 * does not leave.
 */
export function previewLayout(settings: PreviewLayoutSettings, view: PreviewView) {
	const contentWidth = getPreviewContentWidth(settings.previewMaxWidth, settings.previewFullWidth);
	return {
		contentWidth,
		/** The live `.markdown-body`'s `--preview-max-width`. */
		maxWidthCss: contentWidth === null ? '100%' : `${contentWidth}px`,
		isOverhanging: isTocOverhanging({
			...view,
			tocSide: settings.tocSide,
			splitEditorSide: settings.splitEditorSide,
			isFullWidth: settings.previewFullWidth,
			previewContentWidth: contentWidth,
			tocWidth: settings.tocWidth,
		}),
	};
}

export type ExportSettings = PreviewLayoutSettings &
	PreviewAppearanceSettings & { previewNewlineBreaks: boolean; language: LanguageCode };

/**
 * What both export routes are handed. The width is the preview's own, so the
 * exported file is read at the measure it was written at.
 */
export function exportContextFrom(
	settings: ExportSettings,
	doc: { rawContent: string; tabTitle: string; tabPath: string; mermaidTheme: string },
): ExportContext {
	return {
		...doc,
		contentWidth: getPreviewContentWidth(settings.previewMaxWidth, settings.previewFullWidth),
		appearance: previewAppearanceFrom(settings),
		newlineBreaks: settings.previewNewlineBreaks,
		frontMatterTitle: t('frontMatter.properties', settings.language),
	};
}
