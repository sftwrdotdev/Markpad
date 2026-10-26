import assert from 'node:assert/strict';
import { flushSync } from 'svelte';
import { afterEach, describe, test, vi } from 'vitest';

import { followTheme } from '../src/lib/utils/themeEffect.svelte.js';
import { runeEffect } from './runeEffect.svelte.js';
import { runeProps } from './runeProps.svelte.js';

// The VS Code branch parses the theme through Monaco; only its two calls are needed.
vi.mock('monaco-editor', () => ({ editor: { setTheme: vi.fn(), defineTheme: vi.fn() } }));

/** The theme effect, driven by a real `$state` and real effects. */
function harness(theme: string) {
	const state = runeProps({ theme, mode: 'view' });
	const calls: string[] = [];
	let loaded!: () => void;
	const settled = new Promise<void>((resolve) => (loaded = resolve));
	const dispose = runeEffect(() =>
		followTheme(() => state.theme, {
			saveStartupAppearance: (appearance) => {
				calls.push(`startup:${appearance}`);
				if (state.theme.startsWith('vscode:')) loaded();
			},
			readVscodeTheme: async (name) => JSON.stringify({ type: name.includes('Light') ? 'light' : 'dark', colors: {} }),
			// Reads reactive state the way `renderRichContent` does before its first await.
			recolourDiagrams: () => void calls.push(`recolour:${state.mode}`),
			onLoadFailed: (e) => void calls.push(`failed:${e}`),
		}),
	);
	flushSync();
	return { state, calls, settled, dispose };
}

let dispose: (() => void) | undefined;
afterEach(() => {
	dispose?.();
	dispose = undefined;
});

/**
 * Switching theme has to re-draw the diagrams: Mermaid bakes its colours into
 * the SVG. The guard used to be `markdownBody && !isEditing`, which made the
 * whole effect re-run on every mode toggle, with nothing about the theme having
 * moved, and skipped the re-colour for a tab in edit mode whose split preview
 * is on screen.
 */
describe('diagram theme refresh', () => {
	test('the theme effect re-colours in every mode, and does not re-run on a mode change', async () => {
		const run = harness('light');
		dispose = run.dispose;
		assert.deepEqual(run.calls, ['startup:light', 'recolour:view']);

		run.state.mode = 'edit';
		flushSync();
		assert.equal(run.calls.length, 2, 'a mode change is not a theme change');

		run.state.theme = 'dark';
		flushSync();
		assert.deepEqual(run.calls.slice(2), ['startup:dark', 'recolour:edit']);

		// The `vscode:` branch re-colours too, once its appearance is known.
		run.state.theme = 'vscode:Night Owl';
		flushSync();
		await run.settled;
		await Promise.resolve();
		assert.deepEqual(run.calls.slice(4), ['startup:dark', 'recolour:edit']);
	});
});

/**
 * `app.rs` paints a window's background before the webview exists, reading
 * `theme.txt`. Its vocabulary is "dark", "light" and "anything else means ask
 * the OS" — so every `vscode:` name fell into that last arm, and a dark VS Code
 * theme on a light desktop flashed white on every launch. Whether such a theme
 * is dark is inside its own JSON, which only the frontend parses, so the
 * resolved answer is what gets sent.
 */
describe('startup appearance', () => {
	test('the startup background is told the appearance, not the theme name', async () => {
		for (const theme of ['system', 'light', 'dark']) {
			const run = harness(theme);
			assert.equal(run.calls[0], `startup:${theme}`);
			run.dispose();
		}

		for (const [theme, appearance] of [
			['vscode:Night Owl', 'dark'],
			['vscode:Quiet Light', 'light'],
		]) {
			const run = harness(theme);
			// Nothing is sent before the parse, because that is when the appearance
			// becomes knowable.
			assert.deepEqual(run.calls, []);
			await run.settled;
			assert.equal(run.calls[0], `startup:${appearance}`);
			run.dispose();
		}
	});
});
