import assert from 'node:assert/strict';
import test from 'node:test';

import { readRustBackend, readSource, sliceBetween } from './sourceTree.js';

const tauriLib = readRustBackend();
const viewer = readSource('src/lib/MarkdownViewer.svelte');

const menuSetup = sliceBetween(
	tauriLib,
	'#[cfg(target_os = "macos")]\n            {\n                use tauri::menu',
	'\n            let config_dir',
);

test('macOS native menu keeps document actions out', () => {
	assert.match(menuSetup, /MenuItemBuilder::with_id\("menu-app-settings", "Settings…"\)\s*\.accelerator\("CmdOrCtrl\+,"\)/);
	assert.match(menuSetup, /MenuItemBuilder::with_id\("check-updates", "Check for Updates…"\)/);
	assert.match(menuSetup, /PredefinedMenuItem::services\(app, None\)/);
	assert.match(menuSetup, /PredefinedMenuItem::hide\(app, None\)/);
	assert.doesNotMatch(menuSetup, /PredefinedMenuItem::(?:hide_others|show_all)/);
	assert.match(menuSetup, /\.items\(&\[&app_submenu, &edit_submenu, &window_submenu\]\)/);
	assert.doesNotMatch(menuSetup, /SubmenuBuilder::new\(app, "File"\)/);
	// New/Open/Save/Close, zoom, preview width and tab cycling are all bound in
	// `MarkdownViewer.handleKeyDown`, which is web-side and needs no menu item.
	assert.doesNotMatch(menuSetup, /PredefinedMenuItem::close_window/);
});

// Document actions stay in the in-window controls (#281). What the menu still
// owes macOS is the commands the web side cannot bind at all: text editing,
// which AppKit routes through the main menu to the first responder (#526), and
// the two window-server actions below.
test('macOS menu keeps the standard Edit items so text fields can paste', () => {
	assert.match(menuSetup, /SubmenuBuilder::new\(app, "Edit"\)/);
	for (const item of ['undo', 'redo', 'cut', 'copy', 'paste', 'select_all']) {
		assert.match(menuSetup, new RegExp(`PredefinedMenuItem::${item}\\(app, None\\)`));
	}
});

test('macOS menu carries ⌘M and ⌃⌘F, which have no web-side equivalent', () => {
	assert.match(menuSetup, /SubmenuBuilder::new\(app, "Window"\)/);
	assert.match(menuSetup, /PredefinedMenuItem::minimize\(app, None\)/);
	assert.match(menuSetup, /PredefinedMenuItem::fullscreen\(app, None\)/);
});

test('native Settings opens only the focused window settings modal', () => {
	assert.match(tauriLib, /if id == "menu-app-settings" \{\s*let _ = app\.emit_to\(window\.label\(\), "menu-app-settings", \(\)\);/);
	assert.match(viewer, /appWindow\.listen\('menu-app-settings', \(\) => \{\s*showSettings = true;\s*\}\)/);
});
