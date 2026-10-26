import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { describe, test } from 'node:test';


import { viewerCommandFor } from '../src/lib/utils/viewerKeymap.js';
import {
	filesMatching,
	functionSource,
	offsetOf,
	readRustBackend,
	readSource,
	readSourceFiles,
	sliceBetween,
	sliceFrom,
} from './sourceTree.js';

// Window close (issue #189): instead of one aggregate "you have N unsaved
// files" modal, the red close button walks the dirty tabs one at a time —
// activating each and showing the SAME localized unsaved-changes dialog a
// single tab close shows (canCloseTab). Cancel stops the walk; the window
// stays open with the remaining tabs.
describe('the window close handler', () => {
	const documentSessionPath = 'src/lib/sessions/documentSession.svelte.ts';
	const documentSession = existsSync(documentSessionPath) ? readSource(documentSessionPath) : '';

	test('the untitled save dialog prefills the numbered tab title', () => {
		const scope = sliceBetween(documentSession, 'async function saveContent', 'async function saveContentAs');
		assert.match(scope, /defaultPath: tab\.title/);
	});

	test('save-as writes a snapshot rather than the buffer as it stands', () => {
		// The other half — that a keystroke landing during that write is still
		// unsaved afterwards — is `isDirty` reading the two buffers, and it runs
		// for real in oneWritePerTabInFlight.spec.ts.
		const fn = sliceFrom(documentSession, 'async function saveContentAs');
		assert.match(fn, /const snapshot = tab\.rawContent;/);
	});

});

// The window-state plugin saves only on a clean exit, so after a crash every
// window came back at its default size. Moving or resizing a window has to
// reach the plugin's save while the app runs. Needs a live window to execute;
// the 500 ms bound is `coalesced`, tested in Rust.
describe('window geometry is saved while the app runs', () => {
	const rust = readRustBackend();

	test('a move or resize schedules a geometry save', () => {
		const handler = sliceBetween(rust, 'pub fn handle_window_event', 'tauri::WindowEvent::Focused(true)');
		assert.match(handler, /WindowEvent::Moved\(_\) \| tauri::WindowEvent::Resized\(_\)/);
		assert.match(handler, /try_state::<GeometrySaver>\(\)/);
		assert.match(rust, /app\.manage\(window_runtime::GeometrySaver::new\(/);
	});

	test('the running save and the plugin keep the same fields', () => {
		assert.match(rust, /\.with_state_flags\(window_runtime::geometry_flags\(\)\)/);
		assert.match(rust, /app\.save_window_state\(geometry_flags\(\)\)/);
	});
});

describe('moving tabs between windows', () => {
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

	test('window organization exposes move, merge, and carry actions', () => {
		assert.match(tab, /list_viewer_windows/);
		assert.match(tab, /menu-tab-move/);
		assert.match(viewer, /async function mergeAllWindowsHere/);
		assert.match(viewer, /async function carryActiveTabToNextWindow/);
		// The chord itself moved to `viewerKeymap.ts`, so it is asked rather
		// than matched — and the answer names the command, not the local variable the
		// branch happened to be written with.
		assert.equal(
			viewerCommandFor(
				{ key: 'm', code: 'KeyM', ctrlKey: true, metaKey: false, shiftKey: true, altKey: false },
				{ mode: 'app', osType: 'windows', isSplit: false, overlayOpen: false, dialogOpen: false, isEditing: false, editorHasFocus: false },
			),
			'move-tab-to-next-window',
		);
		assert.match(titleBar, /onmergeAllWindows/);
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

describe('window title capability', () => {
	test('all Markpad windows may update their native title', () => {
		const capability = JSON.parse(readSource('src-tauri/capabilities/default.json')) as {
			permissions: string[];
		};

		assert.ok(
			capability.permissions.includes('core:window:allow-set-title'),
			'window tags and active document names call appWindow.setTitle(), which requires this permission',
		);
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

	function showWindowSource(): string {
		const match = /pub async fn show_window\([\s\S]*?\n\}/.exec(backend);
		assert.ok(match, 'show_window is gone: this file no longer states anything');
		return match[0];
	}

	test('the launch window is shown without being activated on a cold start', () => {
		const showWindow = showWindowSource();

		// The defect (#702): the window is built hidden and revealed once the
		// frontend mounts, seconds after launch, and the reveal called `set_focus`
		// unconditionally — pulling the user out of whatever they had switched to.
		// The label and the one-shot flag together are what make it the FIRST show
		// of the LAUNCH window that stays quiet.
		assert.match(showWindow, /window\.label\(\)\s*==\s*LAUNCH_LABEL/);
		assert.match(showWindow, /MAIN_WINDOW_SHOWN\.swap\(true,/);

		// Not vacuous: the other callers — a detached tab window, the close walk
		// needing its dialog visible — still activate, so this cannot pass by
		// `set_focus` having been deleted outright.
		assert.match(showWindow, /set_focus\(\)/);

		// And the quiet path returns before reaching it.
		const guard = showWindow.indexOf('return;');
		const focus = showWindow.indexOf('set_focus()');
		assert.ok(guard > 0 && guard < focus, 'the cold-start path falls through to set_focus');
	});

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

describe('every opened document path reaches a window', () => {
	const runtime = readSource('src-tauri/src/window_runtime.rs');
	const tauriLib = readRustBackend();
	const viewer = readSource('src/lib/MarkdownViewer.svelte');

	test('macOS open-document events preserve every delivered file path', () => {
		assert.match(runtime, /startup_files: Mutex<Option<Vec<String>>>/);
		// Every delivered url is pushed, and the queue is taken whole: the
		// defect this guards against was consuming only `urls.first()`.
		assert.match(tauriLib, /for url in urls/);
		assert.match(tauriLib, /deliver_opened_path\(/);
		assert.match(runtime, /paths\.push\(path\.clone\(\)\)/);
		assert.match(runtime, /startup_files\)\.take\(\)/);
		assert.match(runtime, /for path in opened\.into_iter\(\)\.rev\(\)/);
		assert.match(viewer, /for \(const path of args\) await loadMarkdown\(path\);/);
	});

	test('a second launch hands every argv path to the running window', () => {
		// `markpad a.md b.md` with Markpad already running arrives here instead of
		// at `send_markdown_path`. Taking only the first path opened a.md alone.
		const secondInstance = sliceBetween(runtime, 'pub fn handle_single_instance', 'fn create_transfer_window');
		assert.match(secondInstance, /startup_paths\(/);
		// Windows Explorer's per-file launches must share the macOS pending-open
		// implementation: emitting directly loses files before the listener exists.
		assert.match(secondInstance, /deliver_opened_path\(/);
		assert.doesNotMatch(secondInstance, /emit_to/);
		assert.doesNotMatch(secondInstance, /\.next\(\)|\.first\(\)/);
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

	test('startup restore reads content from disk, not from the snapshot', () => {
		// The session half runs in windows.sessionRestore.spec.ts. This is the
		// viewer's wiring of it: the tab on screen is read through the document
		// session, the way an open reads it.
		assert.match(viewer, /loadRestoredTab: \(tabId\) => documentSession\.readRestoredTab\(tabId\),/);
		assert.match(viewer, /await windowSession\.restore\(\);/);
	});

	test('an editor on a buffer that is not the whole file refuses typing', () => {
		// An unread or unreadable tab in edit mode shows an empty buffer that no
		// save will ever accept. Read-only at the keyboard, not a toast at the save.
		assert.match(viewer, /readOnly=\{tabManager\.activeTab\.isTruncated === true\}/);
		const editor = readSource('src/lib/components/Editor.svelte');
		assert.match(editor, /editor\.updateOptions\(\{ \.\.\.editorOptionsFromSettings\(settings, zoomLevel, fontIsMonospace\), readOnly \}\)/);
	});

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
	const titleBar = readSource('src/lib/components/TitleBar.svelte');
	const home = readSource('src/lib/components/HomePage.svelte');

	test('only explicitly pinned tags create reusable sessions', () => {
		assert.match(runtime, /pub fn save_pinned_tag/);
		assert.match(runtime, /pub fn remove_pinned_tag/);
		assert.match(home, /onopenPinnedTag/);
	});

	test('the title bar exposes a named color chip and pin control', () => {
		assert.match(titleBar, /tagColors/);
		assert.match(titleBar, /window-tag-chip/);
		assert.match(titleBar, /togglePinnedTag/);
	});

	test('the Home menu groups window organization below export actions', () => {
		const exportIndex = offsetOf(titleBar, "t('menu.exportPdf', currentLanguage)");
		const tagIndex = offsetOf(titleBar, "t('menu.setWindowTag', currentLanguage)");
		const mergeIndex = offsetOf(titleBar, "t('menu.mergeAllWindows', currentLanguage)");
		const exitIndex = offsetOf(titleBar, "t('menu.exit', currentLanguage)");

		assert.ok(exportIndex < tagIndex);
		assert.ok(tagIndex < mergeIndex);
		assert.ok(mergeIndex < exitIndex);
		assert.match(titleBar, /homeMenuOpen = false;\s*openTagEditor\(\);/);
	});
});
