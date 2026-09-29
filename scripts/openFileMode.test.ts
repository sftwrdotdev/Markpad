/**
 * #183: "I'd like it to remember that I had the split screen option turned on
 * when opening a new session."
 *
 * Half of it already worked — a session restore replays each tab's saved
 * `isSplit` — but every newly opened document was created `isSplit: false`, so
 * the reporter pressed the split button again for each file. There was a
 * preference for the neighbouring case and none for this one.
 *
 * It is ONE preference with three answers rather than a second checkbox beside
 * the first, because `isEditing` and `isSplit` are independent flags on the tab:
 * two booleans can say "editor AND split", which is not a state the reader can
 * be in. That made the checkbox that already existed part of this change, and
 * an existing install must not notice — hence the migration below.
 *
 * The two implementation details pinned here are the ones that are quietly
 * expensive to get wrong:
 *
 *   1. Split must go through `setSplitEnabled`, not a bare `tab.isSplit = true`.
 *      A fresh tab is created `isScrollSynced: false`, and `setSplitEnabled` is
 *      what applies the remembered scroll-sync preference — assigning the flag
 *      directly opens split view with sync silently off.
 *
 *   2. Both must be applied BEFORE `initialIsSplit` is read. That variable is
 *      what sends the load down the full-read branch: `open_markdown_preview`
 *      returns only the first 50KB, and a split pane is an editor, so a document
 *      that opened split on a partial buffer would be one keystroke away from
 *      auto-saving the truncation back over the file.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { readSource } from './sourceTree.js';

import {
	DEFAULT_OPEN_FILE_MODE,
	isOpenFileMode,
	resolveOpenFileMode,
} from '../src/lib/utils/openFileMode.js';

const sessionSource = readSource(new URL('../src/lib/sessions/documentSession.svelte.ts', import.meta.url));
const settingsSource = readSource(new URL('../src/lib/stores/settings.svelte.ts', import.meta.url));
const settingsComponentSource = readSource(new URL('../src/lib/components/Settings.svelte', import.meta.url));
const tabsSource = readSource(new URL('../src/lib/stores/tabs.svelte.ts', import.meta.url));

/* ------------------------------------------------- the stored preference */

test('a stored choice is honoured, and anything else is not', () => {
	assert.equal(resolveOpenFileMode('preview', null), 'preview');
	assert.equal(resolveOpenFileMode('editor', null), 'editor');
	assert.equal(resolveOpenFileMode('split', null), 'split');

	// A value from a newer version, or a hand-edited one.
	assert.equal(resolveOpenFileMode('wysiwyg', null), DEFAULT_OPEN_FILE_MODE);
	assert.equal(resolveOpenFileMode('', null), DEFAULT_OPEN_FILE_MODE);
	assert.ok(!isOpenFileMode('Editor'));
});

test('an install upgrading from the checkbox opens files exactly as it did', () => {
	// The whole point of the migration: nobody who upgrades sees their app
	// behave differently on the first launch.
	assert.equal(resolveOpenFileMode(null, 'true'), 'editor');
	assert.equal(resolveOpenFileMode(null, 'false'), 'preview');
	// Never set it at all — the default, which is what that install did.
	assert.equal(resolveOpenFileMode(null, null), 'preview');
});

test('the old boolean stops being consulted once a choice exists', () => {
	// Otherwise a reader who upgrades, picks "preview", and relaunches gets
	// "editor" back — the old key is still sitting in localStorage saying true.
	assert.equal(resolveOpenFileMode('preview', 'true'), 'preview');
	assert.equal(resolveOpenFileMode('split', 'true'), 'split');
});

test('the old key is read, never written — a rollback still finds its setting', () => {
	assert.match(settingsSource, /const LEGACY_START_IN_EDITOR_KEY = 'editor\.startInEditor'/);
	assert.match(settingsSource, /read: \(s\) => s\.openFileMode/);
	assert.match(
		settingsSource,
		/resolveOpenFileMode\(raw, readStoredKey\(LEGACY_START_IN_EDITOR_KEY\)\)/,
	);
	// One `key:` per persisted entry, and this entry's is the new one: the
	// legacy name must not appear as a key this store writes back.
	assert.doesNotMatch(settingsSource, /key: 'editor\.startInEditor'/);
});

/* ------------------------------------------------------------- the wiring */

test('opening a document applies the choice, split through the same door the toggle uses', () => {
	assert.match(sessionSource, /tab\.isEditing = settings\.openFileMode === 'editor'/);
	assert.match(
		sessionSource,
		/if \(settings\.openFileMode === 'split'\) tabManager\.setSplitEnabled\(tab\.id, true\)/,
	);
	// The premise of point 1 above: a fresh tab has sync off, and
	// `setSplitEnabled` is the only place the preference is applied.
	assert.match(tabsSource, /isScrollSynced: false/);
	assert.match(
		tabsSource,
		/setSplitEnabled\(id: string, enabled: boolean\)[\s\S]{0,200}?tab\.isScrollSynced = this\.splitScrollSyncPreference/,
	);
});

test('the choice is applied before the load decides how much of the file to read', () => {
	const applied = sessionSource.indexOf("if (settings.openFileMode === 'split')");
	const read = sessionSource.indexOf('const initialIsSplit = tab?.isSplit ?? false');
	const fullRead = sessionSource.indexOf('if (initialIsEditing || initialIsSplit)');

	assert.ok(applied > 0 && read > 0 && fullRead > 0);
	assert.ok(
		applied < read && read < fullRead,
		'a document opening into an editable mode must take the full-read branch, ' +
			'or the editor is bound to the 50KB preview slice',
	);
});

test('it applies to a newly opened document only', () => {
	// Not to a reload that is preserving the mode, and not to a file already
	// open in a tab — reopening a document must not flip the mode the reader
	// chose for it. The same guard the checkbox always had.
	assert.match(sessionSource, /if \(tab && !loadOptions\.preserveEditState && !existing\) \{/);
});

test('a new empty document keeps its own preference', () => {
	// `Ctrl+N` asks a different question — what an empty buffer opens as — and
	// answers it with `newFileDefaultMode`. This change must not annex it.
	assert.match(tabsSource, /isEditing: settings\.newFileDefaultMode/);
});

test('the setting is one control, defaulting to preview', () => {
	assert.match(settingsSource, /openFileMode = \$state<OpenFileMode>\(DEFAULT_OPEN_FILE_MODE\)/);
	assert.equal(DEFAULT_OPEN_FILE_MODE, 'preview');
	assert.match(settingsComponentSource, /<select id="files-open-file-mode" bind:value=\{settings\.openFileMode\}>/);
	for (const value of ['preview', 'editor', 'split']) {
		assert.match(settingsComponentSource, new RegExp(`<option value="${value}">`));
	}
});
