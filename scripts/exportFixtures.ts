import type { ExportAppearance } from '../src/lib/utils/export.ts';

/** For export tests whose subject is something other than the appearance. */
export const plainAppearance: ExportAppearance = {
	fontFamily: 'sans-serif',
	fontSize: 16,
	codeFontFamily: 'monospace',
	codeFontSize: 14,
	highlightColor: 'rgba(255, 208, 0, 0.4)',
};
