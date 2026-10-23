/**
 * Choosing a VS Code theme and then another theme before the first finished
 * loading left the window in the VS Code theme while the setting said the other
 * one, and a failed load reset the setting to `system` over the newer choice.
 *
 * Two awaits sit between the choice and the paint: the `read_vscode_theme`
 * round-trip, and Monaco's first `import()` inside the parse. The test holds
 * each open and makes the newer choice inside it.
 */

import { beforeEach, expect, test, vi } from 'vitest';

const monaco = vi.hoisted(() => {
	let release!: () => void;
	const loaded = new Promise<void>((resolve) => (release = resolve));
	return { loaded, release, setTheme: vi.fn(), defineTheme: vi.fn() };
});

vi.mock('monaco-editor', async () => {
	await monaco.loaded;
	return { editor: { setTheme: monaco.setTheme, defineTheme: monaco.defineTheme } };
});

import { clearVscodeTheme, loadVscodeTheme } from '../src/lib/utils/theme.js';

const THEME = JSON.stringify({ type: 'dark', colors: { 'editor.background': '#101010' } });

/** What the `light` branch of the viewer's theme effect does. */
function chooseLight() {
	document.documentElement.dataset.theme = 'light';
	document.documentElement.dataset.themeType = 'light';
	clearVscodeTheme();
}

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (reason: unknown) => void;
	const promise = new Promise<T>((res, rej) => ((resolve = res), (reject = rej)));
	return { promise, resolve, reject };
}

beforeEach(() => {
	delete document.documentElement.dataset.theme;
	delete document.documentElement.dataset.themeType;
	document.getElementById('vscode-theme-style')?.remove();
});

test('a theme read that returns after a newer choice does not paint over it', async () => {
	const read = deferred<string>();
	const load = loadVscodeTheme('Dark Thing', () => read.promise);

	chooseLight();
	read.resolve(THEME);

	expect(await load).toBe(false);
	expect(document.documentElement.dataset.theme).toBe('light');
	expect(document.getElementById('vscode-theme-style')).toBeNull();
});

test('a theme read that fails after a newer choice does not report the failure', async () => {
	const read = deferred<string>();
	const load = loadVscodeTheme('Missing', () => read.promise);

	chooseLight();
	read.reject(new Error('no such theme'));

	// The viewer resets the setting to `system` on a rejection.
	expect(await load).toBe(false);
});

test('a theme read that fails while it is still the choice does report it', async () => {
	await expect(loadVscodeTheme('Missing', () => Promise.reject(new Error('no such theme')))).rejects.toThrow(
		'no such theme',
	);
});

test('Monaco loading for the first time does not repaint the editor after a newer choice', async () => {
	const load = loadVscodeTheme('Dark Thing', async () => THEME);
	// Let the read land and the parse reach `import('monaco-editor')`.
	await vi.waitFor(() => expect(document.documentElement.dataset.theme).toBe('vscode'));

	chooseLight();
	monaco.release();

	expect(await load).toBe(false);
	expect(monaco.setTheme).not.toHaveBeenCalled();

	// And a load nobody replaced still reaches the editor.
	expect(await loadVscodeTheme('Dark Thing', async () => THEME)).toBe(true);
	expect(monaco.setTheme).toHaveBeenCalledWith('vscode-custom');
});
