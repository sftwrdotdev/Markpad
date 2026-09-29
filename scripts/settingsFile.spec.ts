import assert from 'node:assert/strict';

import { flushSync } from 'svelte';
import { onTestFinished, test } from 'vitest';

// Settings export and import (#134). Runs under vitest for the same reason as
// settingsPersistence.spec.ts: the store is a runes module.
(window as any).__TAURI_INTERNALS__ = { invoke: async () => 'macos' };

const { SettingsStore, ZOOM_LEVEL_RANGE, applySettings, createSettingsPersistence, exportSettings, parseSettingsFile } = await import(
	'../src/lib/stores/settings.svelte.js'
);

type Store = InstanceType<typeof SettingsStore>;

function freshStore(): Store {
	localStorage.clear();
	const store = new SettingsStore();
	onTestFinished(() => store.dispose());
	store.osType = 'macos';
	flushSync();
	return store;
}

function importSettings(store: Store, text: string) {
	applySettings(store, parseSettingsFile(text).settings);
}

function storedValues(store: Store): Record<string, string | null> {
	return Object.fromEntries(createSettingsPersistence().map((entry) => [entry.key, entry.read(store)]));
}

test('an exported file imported into a fresh store reproduces every setting', () => {
	const source = freshStore();
	source.minimap = true;
	source.wordWrap = 'off';
	source.zoomLevel = 130;
	source.theme = 'dark';
	source.editorFont = 'Fira Code';
	source.editorToolbarHidden = ['fmt-italic'];
	source.tocSide = 'right';
	const expected = storedValues(source);
	const file = exportSettings(source);

	const target = freshStore();
	importSettings(target, file);
	flushSync();

	assert.deepEqual(storedValues(target), expected);
	assert.equal(localStorage.getItem('editor.minimap'), 'true');
});

test('the file holds booleans, numbers and lists as JSON, not strings', () => {
	const store = freshStore();
	store.minimap = true;
	store.zoomLevel = 130;
	store.editorToolbarHidden = ['fmt-italic'];
	const { markpadSettings, settings } = JSON.parse(exportSettings(store));

	assert.equal(markpadSettings, 1);
	assert.equal(settings['editor.minimap'], true);
	assert.equal(settings.zoomLevel, 130);
	assert.deepEqual(settings['editor.toolbarHidden'], ['fmt-italic']);
	assert.equal(settings['editor.wordWrap'], 'on');
});

test('a font family left at the OS default is not exported', () => {
	const store = freshStore();
	store.editorFont = 'Menlo';
	store.previewFont = 'Georgia';
	const { settings } = JSON.parse(exportSettings(store));

	assert.equal('editor.font' in settings, false);
	assert.equal(settings['preview.font'], 'Georgia');
});

test('imported values are validated, and keys the file omits are kept', () => {
	const store = freshStore();
	store.wordWrap = 'off';
	importSettings(
		store,
		JSON.stringify({
			markpadSettings: 1,
			settings: { zoomLevel: 99999, theme: 5, 'editor.minimap': true, 'no.such.key': 1 },
		}),
	);

	assert.equal(store.zoomLevel, ZOOM_LEVEL_RANGE.max);
	assert.equal(store.theme, 'system');
	assert.equal(store.minimap, true);
	assert.equal(store.wordWrap, 'off');
});

test('a file that is not a settings file is rejected before anything is applied', () => {
	const store = freshStore();
	for (const text of ['not json', 'null', '{"settings":{"editor.minimap":true}}', '{"markpadSettings":1,"settings":[]}']) {
		assert.throws(() => importSettings(store, text), text);
	}
	assert.equal(store.minimap, false);
});

test('installed themes travel with the file, and non-string entries are dropped', () => {
	const store = freshStore();
	store.theme = 'vscode:ayu-dark';
	const theme = '{"type":"dark","colors":{}}';
	const file = parseSettingsFile(exportSettings(store, { 'ayu-dark': theme }));

	assert.deepEqual(file.themes, { 'ayu-dark': theme });
	assert.equal(file.settings.theme, 'vscode:ayu-dark');
	assert.deepEqual(
		parseSettingsFile('{"markpadSettings":1,"settings":{},"themes":{"a":"{}","b":{"type":"dark"}}}').themes,
		{ a: '{}' },
	);
});
