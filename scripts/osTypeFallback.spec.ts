import assert from 'node:assert/strict';

import { flushSync } from 'svelte';
import { onTestFinished, test } from 'vitest';

/*
 * `initOSType` caught a *rejection* and answered `'unknown'`, but a successful
 * `null` went through `as OSType` into the field. `DEFAULT_FONTS[null]` is
 * `undefined`, and the constructor reads `.editorFont` off it on the next line
 * — so the store threw while starting, before any setting had been applied.
 *
 * The shipped app cannot reach it: the Rust command always answers a string.
 * It surfaced in #635, where the vitest move began booting the real singleton
 * against a bridge stub that answered `null` to everything, and the fix there
 * was to correct the two stubs. This closes the store's half.
 */

let osTypeAnswer: unknown = 'macos';
(window as any).__TAURI_INTERNALS__ = {
	invoke: async (command: string) => (command === 'get_os_type' ? osTypeAnswer : null),
};

const { DEFAULT_FONTS, SettingsStore, isOSType } = await import('../src/lib/stores/settings.svelte.js');

function bootWith(answer: unknown) {
	osTypeAnswer = answer;
	localStorage.clear();
	const store = new SettingsStore();
	onTestFinished(() => store.dispose());
	return store;
}

test('the guard admits the four the backend can answer with, and nothing else', () => {
	for (const ok of ['macos', 'windows', 'linux', 'unknown']) assert.equal(isOSType(ok), true);
	for (const bad of [null, undefined, '', 'Darwin', 'macOS', 0, {}]) assert.equal(isOSType(bad), false);
});

test('a backend that answers null leaves the store on a usable OS type', async () => {
	// THE BUG: `as OSType` put `null` in the field, and the font defaults are
	// indexed by it. Awaiting a macrotask lets the constructor's own
	// `initOSType().then(…)` settle — that continuation is where it threw.
	const store = bootWith(null);
	await new Promise((resolve) => setTimeout(resolve, 0));
	flushSync();

	assert.equal(store.osType, 'unknown');
	assert.equal(store.editorFont, DEFAULT_FONTS.unknown.editorFont);
	assert.equal(store.previewFont, DEFAULT_FONTS.unknown.previewFont);
	assert.equal(store.codeFont, DEFAULT_FONTS.unknown.codeFont);
});

test('a string the union does not contain is treated the same way', async () => {
	// A future backend answering `'Darwin'` is the same defect wearing a string:
	// it typechecks through a cast and indexes to `undefined` just as well.
	const store = bootWith('Darwin');
	await new Promise((resolve) => setTimeout(resolve, 0));
	flushSync();

	assert.equal(store.osType, 'unknown');
	assert.equal(store.editorFont, DEFAULT_FONTS.unknown.editorFont);
});

test('a real answer is still honoured', async () => {
	const store = bootWith('macos');
	await new Promise((resolve) => setTimeout(resolve, 0));
	flushSync();

	assert.equal(store.osType, 'macos');
	assert.equal(store.editorFont, DEFAULT_FONTS.macos.editorFont);
});
