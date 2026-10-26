import { describe, expect, test, vi } from 'vitest';

import { defineAppThemes, monacoThemeName } from '../src/lib/utils/editorTheme.js';
import { loadVscodeTheme } from '../src/lib/utils/theme.js';

// Module-level on purpose: vitest hoists `vi.mock` and `vi.hoisted` to the top of the file.
const defined = vi.hoisted(() => new Set<string>());

vi.mock('monaco-editor', () => ({
	editor: { setTheme: () => {}, defineTheme: (name: string) => void defined.add(name) },
}));

describe('editor theme names', () => {
	test('every name the seam returns is a theme somebody defines', async () => {
		// `setTheme` on a name Monaco has never been given silently falls back to
		// `vs`. The app defines two themes when the editor mounts, and an imported
		// VS Code theme is defined when it loads.
		defineAppThemes({ editor: { defineTheme: (name: string) => void defined.add(name) } } as never);
		const theme = JSON.stringify({ type: 'dark', colors: { 'editor.background': '#101010' } });
		expect(await loadVscodeTheme('Dark Thing', async () => theme)).toBe(true);

		for (const setting of ['system', 'light', 'dark', 'vscode:whatever']) {
			for (const prefersDark of [false, true]) {
				const name = monacoThemeName(setting, prefersDark);
				expect(defined, `nothing defines ${name}; Monaco would fall back to vs`).toContain(name);
			}
		}
	});
});
