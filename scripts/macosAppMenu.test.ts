import assert from 'node:assert/strict';
import test from 'node:test';

import { buildMenuModel, type MenuNode, type MenuState } from '../src/lib/utils/appMenu.js';
import type { ViewMode } from '../src/lib/utils/titlebarToolbar.js';
import { SHORTCUTS } from '../src/lib/utils/shortcuts.js';
import { translations } from './allTranslations.js';

// The macOS menu bar as each window builds it. This replaced #281's minimal
// native menu (App, Edit, Window) when the maintainer chose a full one.

void translations; // every locale loaded, so `t` answers in each language

const base: MenuState = {
	language: 'en',
	viewMode: 'preview',
	liveMode: true,
	hasEditorPane: false,
	showToc: true,
	showTabs: true,
	showEditorToolbar: true,
	previewFullWidth: false,
};

function flatten(nodes: readonly MenuNode[]): MenuNode[] {
	return nodes.flatMap((node) => (node.kind === 'submenu' ? [node, ...flatten(node.items)] : [node]));
}

function find(nodes: readonly MenuNode[], text: string): MenuNode {
	const node = flatten(nodes).find((candidate) => 'text' in candidate && candidate.text === text);
	assert.ok(node, `no menu item reads ${text}`);
	return node;
}

test('every label is a translation, in English and in Chinese', () => {
	for (const language of ['en', 'zh-CN', 'zh-TW'] as const) {
		for (const node of flatten(buildMenuModel({ ...base, language }))) {
			if (!('text' in node)) continue;
			// A predefined item without text shows AppKit's English default.
			assert.ok(node.text, `${language}: a ${node.kind} item has no text`);
			assert.doesNotMatch(node.text, /^[a-z]+\.[A-Za-z0-9.]+$/, `${language}: ${node.text} is an untranslated key`);
		}
	}
	const zh = buildMenuModel({ ...base, language: 'zh-CN' });
	assert.deepEqual(
		zh.map((node) => (node as { text: string }).text),
		['Markpad', '文件', '编辑', '视图', '窗口'],
	);
	find(zh, '退出 Markpad');
	find(zh, '切换全屏');
	find(buildMenuModel({ ...base, language: 'zh-TW' }), '切換全螢幕');
});

function check(state: MenuState, text: string) {
	const node = find(buildMenuModel(state), text);
	assert.ok(node.kind === 'check', `${text} is not a check item`);
	return node;
}

test('Edit Mode is checked while the editor shows, and disabled in split where ⌘E does nothing', () => {
	for (const [viewMode, checked, enabled] of [
		['preview', false, true],
		['edit', true, true],
		['split', true, false],
		[null, false, true],
	] as const) {
		const item = check({ ...base, viewMode }, 'Edit Mode');
		assert.equal(item.checked, checked, `${viewMode}: checked`);
		assert.equal(item.enabled ?? true, enabled, `${viewMode}: enabled`);
		assert.deepEqual(item.action, { viewer: 'toggle-edit-view' });
	}
});

test('Split View is checked exactly in split', () => {
	for (const viewMode of ['preview', 'edit', 'split', null] as (ViewMode | null)[]) {
		const item = check({ ...base, viewMode }, 'Split View');
		assert.equal(item.checked, viewMode === 'split');
		assert.deepEqual(item.action, { viewer: 'toggle-split-view' });
	}
});

test('each View toggle is a check item that follows its own state', () => {
	const toggles = [
		['Auto-Reload', 'liveMode'],
		['Table of Contents', 'showToc'],
		['Tab Bar', 'showTabs'],
		['Editor Toolbar', 'showEditorToolbar'],
		['Full Width', 'previewFullWidth'],
	] as const;
	for (const [text, key] of toggles) {
		for (const on of [true, false]) assert.equal(check({ ...base, [key]: on }, text).checked, on, `${text} with ${key}=${on}`);
	}
});

test('Edit Mode, Split View and Tab Bar carry the registry chords', () => {
	const model = buildMenuModel(base);
	for (const [text, id] of [
		['Edit Mode', 'view-toggle-edit'],
		['Split View', 'view-toggle-split'],
		['Tab Bar', 'toggle-tabs'],
	] as const) {
		const item = find(model, text);
		const chord = SHORTCUTS.find((row) => row.id === id)!.chords[0];
		assert.equal(item.kind === 'check' && item.accelerator, chord.replace(/^Mod\b/, 'CmdOrCtrl'), text);
	}
});

test('the View toggles read as state names in Chinese', () => {
	const zh = { ...base, language: 'zh-CN' } as const;
	for (const text of ['编辑模式', '分屏视图', '自动重载', '目录', '标签栏', '编辑器工具栏', '全宽']) check(zh, text);
});

test('View has no radio group of modes left', () => {
	const view = buildMenuModel(base)[3];
	assert.ok(view.kind === 'submenu');
	const checks = view.items.flatMap((node) => (node.kind === 'check' ? [node.text] : []));
	assert.deepEqual(checks, ['Edit Mode', 'Split View', 'Auto-Reload', 'Table of Contents', 'Tab Bar', 'Editor Toolbar', 'Full Width']);
	assert.ok(flatten(buildMenuModel(base)).every((node) => !('action' in node) || !('viewMode' in node.action)));
});

test('Format acts on the editor, so it is disabled without one', () => {
	for (const hasEditorPane of [false, true]) {
		const formatting = flatten(buildMenuModel({ ...base, hasEditorPane })).filter(
			(node) => node.kind === 'item' && 'editor' in node.action,
		);
		assert.equal(formatting.length, 15);
		assert.ok(formatting.every((node) => node.kind === 'item' && node.enabled === hasEditorPane));
	}
});

test('Back, Forward and tab cycling carry no accelerator', () => {
	// ⌥←/→ and ⌘[/] belong to the editor's caret and indent; Ctrl+Tab is
	// answered by the page, not reliably by AppKit.
	const model = buildMenuModel(base);
	for (const text of ['Back', 'Forward', 'Next Tab', 'Previous Tab']) {
		const item = find(model, text);
		assert.equal(item.kind === 'item' && item.accelerator, undefined, `${text} has an accelerator`);
	}
});

test('Edit keeps the system text commands that WKWebView fields rely on (#526)', () => {
	const edit = buildMenuModel(base)[2];
	assert.ok(edit.kind === 'submenu');
	const predefined = edit.items.flatMap((node) => (node.kind === 'predefined' ? [node.item] : []));
	assert.deepEqual(predefined, ['Undo', 'Redo', 'Cut', 'Copy', 'Paste', 'SelectAll']);
});

test('Quit runs the app exit path, so hot exit still sees it (#962)', () => {
	const quit = find(buildMenuModel(base), 'Quit Markpad');
	assert.ok(quit.kind === 'item');
	assert.deepEqual(quit.action, { viewer: 'app-exit' });
	assert.equal(quit.accelerator, 'CmdOrCtrl+Q');
});
