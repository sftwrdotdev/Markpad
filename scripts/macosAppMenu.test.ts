import assert from 'node:assert/strict';
import test from 'node:test';

import { buildMenuModel, type MenuNode, type MenuState } from '../src/lib/utils/appMenu.js';
import type { ViewMode } from '../src/lib/utils/titlebarToolbar.js';
import { translations } from './allTranslations.js';

// The macOS menu bar as each window builds it. This replaced #281's minimal
// native menu (App, Edit, Window) when the maintainer chose a full one.

void translations; // every locale loaded, so `t` answers in each language

const base: MenuState = { language: 'en', viewMode: 'preview', liveMode: true, hasEditorPane: false };

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

test('the view modes are one exclusive choice that follows the active tab', () => {
	const modes = (state: MenuState) =>
		flatten(buildMenuModel(state)).flatMap((node) =>
			node.kind === 'check' && 'viewMode' in node.action ? [[node.action.viewMode, node.checked] as const] : [],
		);
	for (const viewMode of ['preview', 'split', 'edit'] as ViewMode[]) {
		const shown = modes({ ...base, viewMode });
		assert.equal(shown.length, 3);
		assert.deepEqual(shown.filter(([, checked]) => checked).map(([mode]) => mode), [viewMode]);
	}
	assert.ok(modes({ ...base, viewMode: null }).every(([, checked]) => !checked), 'no tab, no mode');
});

test('Auto-Reload is checked exactly when live mode is on', () => {
	for (const liveMode of [true, false]) {
		const item = find(buildMenuModel({ ...base, liveMode }), 'Auto-Reload');
		assert.equal(item.kind === 'check' && item.checked, liveMode);
	}
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
