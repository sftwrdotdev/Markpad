/**
 * Settings whose label did not describe what the code did.
 *
 * Three of them, found in one sweep of the panel, and all three are the same
 * failure: a control whose effect depends on another control, with nothing in
 * the UI saying so.
 *
 *   * "Auto-save edits" + "Ask for confirmation before saving" — four
 *     combinations, two behaviours, and one of them turned auto-save off while
 *     showing it on. Merged into the single switch every call site already
 *     evaluated. `autoSaveSetting.ts` holds the migration.
 *
 *   * "Wrap Column" — fed to Monaco as `wordWrapColumn`, which Monaco reads
 *     only in one of the three "Word Wrap" modes. It sat ABOVE that select and
 *     was always editable, so the two settings' relationship was invisible.
 *
 *   * "Word Count" — rendered inside the status bar. With the status bar off,
 *     turning it on shows nothing at all.
 *
 * A fourth — that "Restore State on Reopen" also decides whether resolved tabs
 * stay open when a window closes — was left alone. Saying so needs a real
 * tooltip, and a `title` attribute is not one: it only changes the cursor and
 * waits a second before a browser chrome bubble the app does not control.
 *
 * The first is a behaviour change and is tested as one. The other two are the
 * UI admitting a dependency that was always there, so what is pinned is the
 * gate, plus the layout rule that the prerequisite is the row above.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { readSource } from './sourceTree.js';

import { DEFAULT_AUTO_SAVE, resolveAutoSave } from '../src/lib/utils/autoSaveSetting.js';

const settingsSource = readSource(new URL('../src/lib/stores/settings.svelte.ts', import.meta.url));
const settingsComponentSource = readSource(new URL('../src/lib/components/Settings.svelte', import.meta.url));
const viewerSource = readSource(new URL('../src/lib/MarkdownViewer.svelte', import.meta.url));
const sessionSource = readSource(new URL('../src/lib/sessions/documentSession.svelte.ts', import.meta.url));

/* ------------------------------------------------- A: one save preference */

test('every old combination keeps the behaviour it already had', () => {
	// The expression the whole app used to evaluate, one row per combination.
	//        autoSave  confirmBeforeSave        silently saves?
	assert.equal(resolveAutoSave(null, 'true', 'false'), true);
	assert.equal(resolveAutoSave(null, 'true', 'true'), false); // the contradictory one
	assert.equal(resolveAutoSave(null, 'false', 'false'), false);
	assert.equal(resolveAutoSave(null, 'false', 'true'), false);
});

test('an install that never touched either switch keeps the default', () => {
	assert.equal(resolveAutoSave(null, null, null), DEFAULT_AUTO_SAVE);
	assert.equal(DEFAULT_AUTO_SAVE, true);
	// Auto-save on by default, so an absent `confirmBeforeSave` must not read
	// as "confirm" and silently turn saving off for everybody.
	assert.equal(resolveAutoSave(null, null, 'false'), true);
	assert.equal(resolveAutoSave(null, null, 'true'), false);
});

test('the old pair stops being consulted once the merged key exists', () => {
	// Otherwise a reader who upgrades with both switches on, then turns
	// auto-save back on, has the stale veto disable it again on next launch.
	assert.equal(resolveAutoSave('true', 'true', 'true'), true);
	assert.equal(resolveAutoSave('false', 'true', 'false'), false);
});

test('the merged preference is stored under its own key, and the old ones are read-only', () => {
	assert.match(settingsSource, /key: 'editor\.autoSaveEdits'/);
	assert.match(settingsSource, /const LEGACY_AUTO_SAVE_KEY = 'editor\.autoSave'/);
	assert.match(settingsSource, /const LEGACY_CONFIRM_BEFORE_SAVE_KEY = 'editor\.confirmBeforeSave'/);
	// A rollback finds both of the old keys where it left them.
	assert.doesNotMatch(settingsSource, /key: 'editor\.autoSave'/);
	assert.doesNotMatch(settingsSource, /key: 'editor\.confirmBeforeSave'/);
});

test('nothing evaluates the pair any more', () => {
	// Four sites read `autoSave && !confirmBeforeSave`; a survivor would be a
	// path that still consults a preference no UI can set.
	for (const source of [viewerSource, sessionSource, settingsComponentSource, settingsSource]) {
		assert.doesNotMatch(source, /settings\.confirmBeforeSave/);
	}
	// And the four decisions are still there, now reading the one switch.
	assert.match(viewerSource, /if \(!settings\.autoSave\) return;/); // leaving an editable pane
	assert.match(viewerSource, /if \(!settings\.autoSave\) \{/); // the debounce
	assert.match(viewerSource, /if \(settings\.autoSave\) \{/); // the close-window walk
	// Closing a tab. The condition grew a third term — a file that changed
	// under the buffer is a question for the user, not something auto-save may
	// answer by writing — but it is still this one switch that decides whether
	// the silent save happens at all.
	assert.match(sessionSource, /if \(settings\.autoSave && tab\.path !== '' && !diskMoved\)/);
});

/* ---------------------------------------------- B & C: visible dependency */

test('the wrap column sits under the wrap mode, and is inert without it', () => {
	const wrapMode = settingsComponentSource.indexOf('<label for="editor-word-wrap">');
	const wrapColumn = settingsComponentSource.indexOf('<label for="editor-max-width">');
	assert.ok(wrapMode > 0 && wrapColumn > 0);
	assert.ok(wrapMode < wrapColumn, 'the prerequisite must be the row above the setting it gates');

	// Monaco reads `wordWrapColumn` only in this mode — `Editor.svelte` passes
	// the value unconditionally, and Monaco ignores it in the other two.
	const gate = /settings\.wordWrap !== 'wordWrapColumn'/g;
	assert.equal((settingsComponentSource.match(gate) ?? []).length, 4, 'the row, its input and both steppers');
});

test('the word count is greyed out when there is no status bar to show it in', () => {
	assert.match(settingsComponentSource, /class:inactive=\{!settings\.statusBar\}/);
	assert.match(
		settingsComponentSource,
		/id="editor-word-count"[^>]*disabled=\{!settings\.statusBar\}/,
	);
	const statusBar = settingsComponentSource.indexOf('<label for="editor-status-bar">');
	const wordCount = settingsComponentSource.indexOf('<label for="editor-word-count">');
	assert.ok(statusBar > 0 && statusBar < wordCount, 'same rule: the prerequisite is the row above');
});

test('an inactive row is dimmed rather than hidden', () => {
	// Hiding it would answer "where did that setting go?" with nothing.
	assert.match(settingsComponentSource, /\.setting-item\.inactive[\s\S]{0,200}?opacity: 0\.45/);
});

