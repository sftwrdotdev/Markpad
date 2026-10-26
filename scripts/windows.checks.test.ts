import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
	filesMatching,
	functionSource,
	readRustBackend,
	readSource,
	readSourceFiles,
} from './sourceTree.js';

// The plugin's builder flags cannot be read back, and the mock runtime keeps no
// window geometry, so this pairing stays a source check. The move/resize save
// itself is tested in Rust (`a_move_or_resize_schedules_a_geometry_save`,
// `setup_manages_the_geometry_saver`).
describe('window geometry is saved while the app runs', () => {
	const rust = readRustBackend();

	test('the running save and the plugin keep the same fields', () => {
		assert.match(rust, /\.with_state_flags\(window_runtime::geometry_flags\(\)\)/);
		assert.match(rust, /app\.save_window_state\(geometry_flags\(\)\)/);
	});
});

describe('moving tabs between windows', () => {
	// `WebviewWindowBuilder::build()` deadlocks when called from a
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
});

describe('startup keeps the window handle it built', () => {
	const backend = readRustBackend();

	test('startup reuses the window handle returned by the builder', () => {
		// Not vacuous: the build call the rule below is about still exists, so
		// "nobody re-finds the window" cannot pass by the builder having gone away.
		assert.match(backend, /window_builder\s*\.\s*build\(\)/);

		// The defect (#318): building the window, then throwing the handle away and
		// looking it back up by label — an `Option` that startup unwrapped, which is
		// a panic on the one path where the lookup misses.
		//
		// The binding's spelling is deliberately NOT pinned. This used to also
		// assert `/let window = window_builder\.build\(\)\?;/`, which is a claim
		// about what the local is CALLED: renaming it to `win`, or letting rustfmt
		// wrap the line, turned this red with the behaviour untouched. The pattern
		// below is widened for the same reason — it no longer requires the receiver
		// to be spelled `app`, so the lookup cannot come back through an alias.
		assert.doesNotMatch(backend, /get_webview_window\([^)]*\)\s*\.\s*unwrap\(\)/);
	});
});

// Windows are equal views of one session. "main" is only the name Tauri gives
// the window it builds at launch, and only startup tells that window apart:
// adoption, the launch's files and the quiet first show, all in Rust behind
// `LAUNCH_LABEL`. A frontend branch on the label is a second, unequal kind of
// window, and executing the one code path that exists cannot see it.

describe('windows are equal views of one session', () => {
	test('no frontend code tells the launch window apart', () => {
		const sources = readSourceFiles('src');
		assert.deepEqual(filesMatching(sources, /['"`]main['"`]/), []);
		assert.deepEqual(filesMatching(sources, /isMain(Window)?\b/), []);
	});

	test('Rust names the launch window once', () => {
		const runtime = readSource('src-tauri/src/window_runtime.rs');
		const code = runtime.slice(0, runtime.indexOf('#[cfg(test)]'));
		assert.deepEqual(code.match(/"main"/g), ['"main"']);
		assert.match(code, /pub const LAUNCH_LABEL: &str = "main";/);
	});
});

describe('a cold start does not steal focus', () => {
	const backend = readRustBackend();

	test('no window builder opts out of focus', () => {
		// `.focused(false)` on a window built hidden leaves WebView2 on Windows with
		// no drop target, so every file dragged onto the window is refused (#768,
		// tauri-apps/wry#1639). Comments are stripped first: the builder explains
		// why the call is absent by naming it.
		const code = backend.replace(/\/\/.*$/gm, '');
		const found = code.match(/\.focused\(false\)/g)?.length ?? 0;
		assert.equal(found, 0, `found ${found} .focused(false) in the Rust backend`);
	});
});

describe('the recent-file list is written through one helper', () => {
	// --- wiring ------------------------------------------------------------------

	const viewer = readSource('src/lib/MarkdownViewer.svelte');

	test('nothing writes the key directly any more', () => {
		// Any surviving `setItem('recent-files', ...)` is a window publishing its
		// own snapshot again, which is the whole defect.
		assert.doesNotMatch(viewer, /setItem\('recent-files'/);
		assert.doesNotMatch(viewer, /getItem\('recent-files'/);
	});

	test('removing a recent entry leaves its open tab alone', () => {
		// The × on the active document's entry closed the tab through the bare
		// `tabManager.closeTab`, with no unsaved-changes prompt.
		assert.doesNotMatch(functionSource(viewer, 'removeRecentFile'), /closeTab/);
	});
});

describe('window state restore', () => {
	const viewer = readSource('src/lib/MarkdownViewer.svelte');
	const session = readSource('src/lib/sessions/windowSession.svelte.ts');

	// Session restore persists WINDOW state only: which files are open, the
	// active tab, and per-tab UI (edit mode, split, scroll). Document content
	// always lives on disk — the snapshot never carries rawContent, so unsaved
	// changes are handled exclusively by the per-tab close dialogs.

	test('v2 snapshots are invisible to legacy builds (Rust file, localStorage keys removed)', () => {
		// Behaviour: windows.sessionRestore.spec.ts. What stays here is the
		// contract: the localStorage key older builds read, and the Rust commands
		// that hold the snapshot now.
		assert.match(viewer, /const WINDOW_STATE_KEY = 'savedTabsDataV2';/);
		assert.match(session, /write: \(json\) => invoke\('save_window_state'/);
		assert.match(session, /invoke\('load_window_state'\)/);
		assert.match(session, /invoke\('clear_window_state'\)/);
	});

});

describe('window tags and pinned sessions', () => {
	const runtime = readSource('src-tauri/src/window_runtime.rs');
	const home = readSource('src/lib/components/HomePage.svelte');

	test('only explicitly pinned tags create reusable sessions', () => {
		assert.match(runtime, /pub fn save_pinned_tag/);
		assert.match(runtime, /pub fn remove_pinned_tag/);
		assert.match(home, /onopenPinnedTag/);
	});
});
