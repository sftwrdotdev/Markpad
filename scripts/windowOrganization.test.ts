import assert from 'node:assert/strict';
import test from 'node:test';

import { readRustBackend, readSource, sliceBetween } from './sourceTree.js';

const runtime = readSource('src-tauri/src/window_runtime.rs');
const session = readSource('src/lib/sessions/windowSession.svelte.ts');
const viewer = readSource('src/lib/MarkdownViewer.svelte');
const tab = readSource('src/lib/components/Tab.svelte');
const titleBar = readSource('src/lib/components/TitleBar.svelte');

test('the runtime registers live viewer windows in stable creation order', () => {
	assert.match(runtime, /window_counter/);
	assert.match(runtime, /pub fn set_window_meta/);
	assert.match(runtime, /pub fn list_viewer_windows/);
	assert.match(runtime, /list\.sort_by_key\(\|entry\| entry\.meta\.number\)/);

	// Deregistration, read inside the arm that has to do it. The previous form
	// was `/window_registry[\s\S]*?remove\(window\.label\(\)\)/` over the whole
	// file: `window_registry` is the struct field at the top, `remove(window
	// .label())` is the *watcher* cleanup ~430 lines down, and nothing required
	// the two to be one statement. Measured — deleting the registry removal from
	// the `Destroyed` arm left the suite green, and every closed window stayed in
	// `list_viewer_windows` as a transfer target that no longer exists.
	const destroyed = sliceBetween(runtime, 'tauri::WindowEvent::Destroyed => {', '\n        }');
	assert.match(
		destroyed,
		/window_registry\)\.remove\(window\.label\(\)\)/,
		'a destroyed window must be deregistered, or it is still offered as a move target',
	);
});

test('moving to an existing window uses the acknowledged transfer protocol', () => {
	assert.match(session, /async function transfer\(/);
	assert.match(session, /invoke\('complete_detached_tab', \{ token \}\)/);
	assert.match(session, /onTransferClaimed\(tabId\)/);
	assert.match(session, /async function acceptOfferedTransfer/);
	assert.match(viewer, /invoke\('offer_tab_to_window', \{ targetLabel, token \}\)/);
});

// Salvaged from `tabContextMenuIsolation.test.ts`, which was deleted for pinning
// the exact text of two inline Svelte event handlers. This assertion is not
// about spelling: `WebviewWindowBuilder::build()` deadlocks when called from a
// *synchronous* Tauri command on Windows/WebView2, because the main thread is
// blocked inside the command while WebView2 waits for that same thread to pump
// messages (tauri-apps/tauri#12521). Both forms compile everywhere, and CI's
// `cargo test` runs on a host where the deadlock cannot happen, so dropping the
// `async` is invisible until "Move to New Window" freezes a Windows user's app
// hard enough to need a force-kill. Issue #356.
test('create_transfer_window is async so window creation cannot deadlock the main thread', () => {
	const lib = readRustBackend();

	assert.match(lib, /#\[tauri::command\]\n(?:pub )?async fn create_transfer_window\(/);
	assert.doesNotMatch(lib, /#\[tauri::command\]\n(?:pub )?fn create_transfer_window\(/);
});

test('window organization exposes move, merge, and carry actions', () => {
	assert.match(tab, /list_viewer_windows/);
	assert.match(tab, /menu-tab-move/);
	assert.match(viewer, /async function mergeAllWindowsHere/);
	assert.match(viewer, /async function carryActiveTabToNextWindow/);
	assert.match(viewer, /cmdOrCtrl && e\.shiftKey && key === 'm'/);
	assert.match(titleBar, /onmergeAllWindows/);
});
