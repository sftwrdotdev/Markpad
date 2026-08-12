import assert from 'node:assert/strict';
import test from 'node:test';

import { readSource } from './sourceTree.js';

import {
	adjustPreviewMaxWidth,
	DEFAULT_PREVIEW_MAX_WIDTH,
	getPreviewContentWidth,
	getStoredPreviewFullWidth,
	MAX_PREVIEW_MAX_WIDTH,
	MIN_PREVIEW_MAX_WIDTH,
	normalizePreviewMaxWidth,
} from '../src/lib/utils/previewWidth.js';

const settingsSource = readSource(new URL('../src/lib/stores/settings.svelte.ts', import.meta.url));
const viewerSource = readSource(new URL('../src/lib/MarkdownViewer.svelte', import.meta.url));
const settingsComponentSource = readSource(new URL('../src/lib/components/Settings.svelte', import.meta.url));
const tocOverlaySource = readSource(new URL('../src/lib/utils/tocOverlay.ts', import.meta.url));

test('preview width defaults and clamps persisted numeric values', () => {
	assert.equal(DEFAULT_PREVIEW_MAX_WIDTH, 880);
	assert.equal(normalizePreviewMaxWidth(null), DEFAULT_PREVIEW_MAX_WIDTH);
	assert.equal(normalizePreviewMaxWidth('not-a-number'), DEFAULT_PREVIEW_MAX_WIDTH);
	assert.equal(normalizePreviewMaxWidth('639'), MIN_PREVIEW_MAX_WIDTH);
	assert.equal(normalizePreviewMaxWidth('1601'), MAX_PREVIEW_MAX_WIDTH);
	assert.equal(normalizePreviewMaxWidth('921.8'), 922);
});

test('preview width accepts only finite numeric values', () => {
	assert.equal(normalizePreviewMaxWidth(Number.NaN), DEFAULT_PREVIEW_MAX_WIDTH);
	assert.equal(normalizePreviewMaxWidth(Number.POSITIVE_INFINITY), DEFAULT_PREVIEW_MAX_WIDTH);
	assert.equal(normalizePreviewMaxWidth(1200), 1200);
});

test('full mode has no configured content-width cap', () => {
	assert.equal(getPreviewContentWidth(1200, false), 1200);
	assert.equal(getPreviewContentWidth(1200, true), null);
});

test('preview width shortcut adjustments retain the configured bounds', () => {
	assert.equal(adjustPreviewMaxWidth(DEFAULT_PREVIEW_MAX_WIDTH, 40), 920);
	assert.equal(adjustPreviewMaxWidth(MIN_PREVIEW_MAX_WIDTH, -40), MIN_PREVIEW_MAX_WIDTH);
	assert.equal(adjustPreviewMaxWidth(MAX_PREVIEW_MAX_WIDTH, 40), MAX_PREVIEW_MAX_WIDTH);
});

test('the dedicated full-width preference takes priority over its legacy key', () => {
	assert.equal(getStoredPreviewFullWidth('true', 'false'), true);
	assert.equal(getStoredPreviewFullWidth('false', 'true'), false);
	assert.equal(getStoredPreviewFullWidth(null, 'true'), true);
	assert.equal(getStoredPreviewFullWidth(null, null), false);
});

test('settings load, persist, and reset the preview width through one normalizer', () => {
	assert.match(settingsSource, /previewMaxWidth = \$state\(DEFAULT_PREVIEW_MAX_WIDTH\)/);
	// Persistence moved from one all-fields effect to one entry per localStorage
	// key (so that a change in one window stops rewriting every other key from a
	// stale snapshot). The preview width still round-trips under the same key and
	// through the same normalizer; only the plumbing that reads and writes it is
	// now shared. See scripts/settingsPersistence.test.ts.
	assert.match(settingsSource, /key: 'preview\.maxWidth'/);
	assert.match(settingsSource, /read: \(s\) => String\(s\.previewMaxWidth\)/);
	assert.match(settingsSource, /normalizePreviewMaxWidth\(savedPreviewMaxWidth\)/);
	assert.match(settingsSource, /resetPreviewMaxWidth\(\)[\s\S]*this\.previewMaxWidth = DEFAULT_PREVIEW_MAX_WIDTH/);
});

test('preview layout derives width and ToC geometry from the same preference', () => {
	assert.match(viewerSource, /getPreviewContentWidth\(settings\.previewMaxWidth, settings\.previewFullWidth\)/);
	// The gutter arithmetic moved to `tocOverlay.ts` with #176, which added the
	// question the inline expression could not answer: whether the pane under
	// the outline is the preview at all. Both halves still feed on this same
	// preference — see scripts/tocOverlay.test.ts for the geometry itself.
	assert.match(viewerSource, /isTocOverhanging\(\{[\s\S]*?previewContentWidth,[\s\S]*?\}\)/);
	assert.match(tocOverlaySource, /input\.viewerWidth - input\.previewContentWidth/);
	assert.match(viewerSource, /--preview-max-width:/);
	assert.match(viewerSource, /max-width: var\(--preview-max-width, 880px\)/);
});

test('Settings exposes a bounded preview-width input and reset action', () => {
	assert.match(settingsComponentSource, /id="preview-max-width"/);
	assert.match(settingsComponentSource, /min=\{MIN_PREVIEW_MAX_WIDTH\}/);
	assert.match(settingsComponentSource, /max=\{MAX_PREVIEW_MAX_WIDTH\}/);
	assert.match(settingsComponentSource, /bind:value=\{settings\.previewMaxWidth\}/);
	assert.match(settingsComponentSource, /settings\.resetPreviewMaxWidth\(\)/);
});

test('preview width keyboard shortcuts avoid editable controls and app modals', () => {
	assert.match(viewerSource, /function canUsePreviewWidthShortcut\(target: EventTarget \| null, isSplit: boolean\)/);
	assert.match(viewerSource, /showSettings \|\| modalState\.show \|\| promptModal\.show \|\| showHome/);
	assert.match(viewerSource, /closest\('input, textarea, select, \[contenteditable="true"\], \[role="textbox"\]'\)/);
	assert.match(viewerSource, /cmdOrCtrl && e\.altKey && !e\.shiftKey && \(code === 'BracketLeft' \|\| code === 'BracketRight'\)/);
	assert.match(viewerSource, /settings\.previewFullWidth = false/);
	assert.match(viewerSource, /settings\.previewMaxWidth = adjustPreviewMaxWidth\(settings\.previewMaxWidth, code === 'BracketLeft' \? -40 : 40\)/);
});

test('preview full-width state migrates from the legacy localStorage key', () => {
	// The pair the migration is made of, asserted on the function rather than on
	// its call site: `??` is what makes the new key win once it exists.
	assert.equal(getStoredPreviewFullWidth('true', null), true);
	assert.equal(getStoredPreviewFullWidth(null, 'true'), true, 'the legacy key still decides while the new one is absent');
	assert.equal(getStoredPreviewFullWidth('false', 'true'), false, 'the new key wins outright, it is not OR-ed with the old one');
	assert.equal(getStoredPreviewFullWidth(null, null), false);

	// It is a persisted setting like every other one now, which is what gets it
	// cross-window sync — the viewer used to read and write `preview.fullWidth`
	// with bare localStorage calls and no `storage` listener, so a second window
	// only noticed after a restart. See scripts/settingsPersistence.test.ts.
	assert.match(settingsSource, /key: 'preview\.fullWidth'/);
	assert.match(settingsSource, /read: \(s\) => String\(s\.previewFullWidth\)/);
	assert.match(settingsSource, /getStoredPreviewFullWidth\(raw, readStoredKey\(LEGACY_PREVIEW_FULL_WIDTH_KEY\)\)/);
	assert.match(settingsSource, /const LEGACY_PREVIEW_FULL_WIDTH_KEY = 'isFullWidth';/);
});
