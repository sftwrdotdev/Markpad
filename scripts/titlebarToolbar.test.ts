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
 * Auto-Reload is what that user wanted and it already existed, but the button
 * was gated on `!isEditing` — so in the one mode the feature is for, it was
 * unreachable. Its chord answered the same question the other way: `Mod+L` is
 * `editorAction: true` in shortcuts.ts, which registers it on Monaco, so the
 * chord works in edit mode ONLY. Two answers, exactly complementary, nothing
 * requiring them to agree. Ctrl+L in the editor flipped the state with no
 * indicator anywhere on screen.
 */

const documentContext = {
	hasActiveTab: true,
	showHome: false,
	currentFile: '/notes/a.md',
	isSplit: false,
	isEditing: false,
};

test('Auto-Reload is offered in edit mode, where Mod+L already toggles it', () => {
	assert.ok(
		visibleTitlebarActionIds({ ...documentContext, isEditing: true }).includes('live'),
		'the editor is where a file changing underneath you matters most',
	);
	assert.ok(visibleTitlebarActionIds(documentContext).includes('live'));
});

test('Auto-Reload is not offered in split view, whose preview renders the buffer', () => {
	assert.ok(
		!visibleTitlebarActionIds({ ...documentContext, isSplit: true }).includes('live'),
	);
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
	// Sync Scroll needs two panes; Edit is meaningless once both are showing.
	assert.deepEqual([view, edit, split].map((ids) => ids.includes('sync')), [false, false, true]);
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
