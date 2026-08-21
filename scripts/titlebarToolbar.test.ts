import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
	DEFAULT_TITLEBAR_TOOLBAR_ORDER,
	getConfiguredTitlebarToolbarIds,
	getTitlebarToolbarAdjacentMove,
	getTitlebarToolbarReorderMove,
	normalizeTitlebarToolbarHidden,
	normalizeTitlebarToolbarOrder,
	normalizeTitlebarToolbarPlacement,
	visibleTitlebarActionIds,
} from '../src/lib/utils/titlebarToolbar.js';

test('normalizeTitlebarToolbarOrder drops unknown ids, deduplicates, and appends defaults', () => {
	assert.deepEqual(
		normalizeTitlebarToolbarOrder([
			'settings',
			'unknown-action',
			'reload',
			'settings',
		]),
		[
			'settings',
			'reload',
			...DEFAULT_TITLEBAR_TOOLBAR_ORDER.filter((id) => id !== 'settings' && id !== 'reload'),
		],
	);
});

test('normalizeTitlebarToolbarHidden keeps only known optional actions', () => {
	assert.deepEqual(
		normalizeTitlebarToolbarHidden(['reload', 'settings', 'unknown-action', 'find']),
		['reload', 'find'],
	);
});

test('normalizeTitlebarToolbarPlacement keeps known bar and menu values', () => {
	const placement = normalizeTitlebarToolbarPlacement({
		reload: 'menu',
		find: 'bar',
		settings: 'bar',
		unknown: 'bar',
		edit: 'hidden',
	});

	assert.equal(placement.reload, 'menu');
	assert.equal(placement.find, 'bar');
	assert.equal(placement.settings, 'bar');
	assert.equal(placement.edit, 'bar');
	assert.equal('unknown' in placement, false);
});

test('getConfiguredTitlebarToolbarIds applies context, order, hidden ids, and placement', () => {
	const configured = getConfiguredTitlebarToolbarIds(
		['back', 'forward', 'reload', 'find', 'settings', 'open_loc'],
		['settings', 'find', 'reload', 'back', 'forward'],
		['forward'],
		{ find: 'bar', reload: 'menu', settings: 'menu' },
	);

	assert.deepEqual(configured.visibleIds, ['settings', 'find', 'reload', 'back']);
	assert.deepEqual(configured.barIds, ['find', 'back']);
	assert.deepEqual(configured.menuIds, ['settings', 'reload']);
});

test('titlebar toolbar reorder helpers resolve drag and keyboard moves', () => {
	const order = ['back', 'reload', 'settings'];

	assert.deepEqual(getTitlebarToolbarReorderMove(order, 'settings', 'back'), { fromIndex: 2, toIndex: 0 });
	assert.deepEqual(getTitlebarToolbarAdjacentMove(order, 'reload', 'down'), { fromIndex: 1, toIndex: 2 });
	assert.equal(getTitlebarToolbarReorderMove(order, 'back', 'back'), null);
	assert.equal(getTitlebarToolbarAdjacentMove(order, 'back', 'up'), null);
});

/*
 * #692: editing a file in Markpad while VS Code writes the same file, and
 * Markpad not noticing until the mode was toggled.
 *
 * Auto-Reload is what that user wanted and it already existed. Its two
 * surfaces disagreed about where it existed, and their answers were exact
 * complements: the button was drawn only in the preview (`!isEditing`,
 * `!isSplit`), while `Mod+L` was only an `editorAction` in shortcuts.ts and
 * therefore only on Monaco — which exists only in edit and split. Whether a
 * user got the feature depended on which surface they happened to find, and
 * pressing the chord in the editor armed the watcher with nothing on screen
 * to show it had.
 *
 * The answer is one condition, in one place, with the chord routed through
 * the same `toggleLiveMode` (`shortcutRegistry.test.ts` holds the chord end
 * up, `externalChangeReload.spec.ts` holds the reload end).
 */

const documentContext = {
	hasActiveTab: true,
	showHome: false,
	currentFile: '/notes/a.md',
	isSplit: false,
	isEditing: false,
};

test('Auto-Reload is offered in every mode that has a file on disk', () => {
	// An external writer can surprise all three equally: what varies between
	// them is which pane is on screen, not whether the file can change.
	for (const mode of [
		{ label: 'preview' },
		{ label: 'edit', isEditing: true },
		{ label: 'split', isSplit: true },
	]) {
		assert.ok(
			visibleTitlebarActionIds({ ...documentContext, ...mode }).includes('live'),
			`Auto-Reload was missing in ${mode.label} mode`,
		);
	}
});

test('Auto-Reload needs a file on disk to watch', () => {
	assert.ok(
		!visibleTitlebarActionIds({ ...documentContext, currentFile: '' }).includes('live'),
	);
});

test('the rest of the toolbar still answers to the mode it is in', () => {
	const view = visibleTitlebarActionIds(documentContext);
	const edit = visibleTitlebarActionIds({ ...documentContext, isEditing: true });
	const split = visibleTitlebarActionIds({ ...documentContext, isSplit: true });

	// Find: Monaco owns Ctrl+F in pure edit mode, so the preview's Find hides
	// there and comes back in split, where a preview is on screen again.
	assert.deepEqual([view, edit, split].map((ids) => ids.includes('find')), [true, false, true]);
	// The formatting toolbar is the mirror image: only where a pane can write.
	assert.deepEqual([view, edit, split].map((ids) => ids.includes('editorToolbar')), [false, true, true]);
	// Sync Scroll and Swap Panes both need two panes; Edit is meaningless once
	// both are showing.
	assert.deepEqual([view, edit, split].map((ids) => ids.includes('sync')), [false, false, true]);
	assert.deepEqual([view, edit, split].map((ids) => ids.includes('swap')), [false, false, true]);
	assert.deepEqual([view, edit, split].map((ids) => ids.includes('edit')), [true, true, false]);
});

test('a non-Markdown file gets none of the Markdown actions', () => {
	// `.txt` would not do here: it is in MARKDOWN_LINK_EXTENSIONS.
	const ids = visibleTitlebarActionIds({ ...documentContext, currentFile: '/notes/data.json' });
	for (const id of ['toc', 'fullWidth', 'live', 'split', 'edit', 'find']) {
		assert.ok(!ids.includes(id), `${id} was offered for a .json file`);
	}
	// An unsaved buffer has no extension to read and is treated as Markdown.
	assert.ok(visibleTitlebarActionIds({ ...documentContext, currentFile: '' }).includes('split'));
});

test('the home screen offers only the actions that are not about a document', () => {
	assert.deepEqual(visibleTitlebarActionIds({ ...documentContext, showHome: true }), [
		'theme',
		'settings',
	]);
	assert.deepEqual(visibleTitlebarActionIds({ ...documentContext, hasActiveTab: false }), [
		'theme',
		'settings',
	]);
});

test('Reset Zoom appears only away from 100%', () => {
	assert.ok(!visibleTitlebarActionIds({ ...documentContext, zoomLevel: 100 }).includes('zoom'));
	assert.ok(!visibleTitlebarActionIds(documentContext).includes('zoom'));
	assert.ok(visibleTitlebarActionIds({ ...documentContext, zoomLevel: 125 }).includes('zoom'));
});
