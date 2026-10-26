import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { describe, test } from 'node:test';

import ts from 'typescript';

import { reviewDirtyTabs } from '../src/lib/sessions/closeReview.js';
import { isHomePath } from '../src/lib/utils/homeTab.js';
import { openPinnedTagWindow, pinnedTagFromWindowLabel, pinnedWindowToken } from '../src/lib/utils/pinnedTagWindow.js';
import { hasRealFilePath } from '../src/lib/utils/tabFileActions.js';
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
	const viewer = readSource('src/lib/MarkdownViewer.svelte');
	const documentSessionPath = 'src/lib/sessions/documentSession.svelte.ts';
	const documentSession = existsSync(documentSessionPath) ? readSource(documentSessionPath) : '';

	function closeHandler(): string {
		return sliceBetween(viewer, 'appWindow.onCloseRequested', 'onDragDropEvent');
	}

	/** The walk and the snapshot, which the in-app update runs too (#761). */
	function settle(): string {
		return functionSource(viewer, 'settleForExit');
	}

	test('the aggregate unsaved-files modal is gone from the close handler', () => {
		for (const scope of [closeHandler(), settle()]) {
			assert.doesNotMatch(scope, /youHaveUnsavedFiles/);
			// and the old "clear all dirty flags then close" discard path with it.
			// Pinned as the assignment rather than as the `forEach` one-liner it was
			// written in: the same silent discard spelled `for (const t of
			// tabManager.tabs) t.isDirty = false;` passed the old regex, and the walk
			// below then found nothing to review.
			assert.doesNotMatch(scope, /\.isDirty\s*=\s*false/);
		}
	});

	test('the close is prevented synchronously before the walk starts', () => {
		const handler = closeHandler();
		// Not the re-entry guard's `preventDefault`: the one between that guard and
		// the walk.
		const guardEnd = offsetOf(handler, 'return;', offsetOf(handler, 'if (isCloseWalkActive)'));
		const walk = offsetOf(handler, 'await settleForExit(');
		const prevent = handler.lastIndexOf('event.preventDefault()', walk);
		assert.ok(guardEnd < prevent, 'the close is prevented before the walk starts');
		assert.match(settle(), /reviewDirtyTabs\(\{/, 'and the walk is what settleForExit runs');
	});

	test('the window closes only after every dirty tab is resolved', () => {
		const handler = closeHandler();
		const walk = offsetOf(handler, 'await settleForExit(');
		const close = offsetOf(handler, 'appWindow.close()', walk);
		assert.ok(walk < close, 'the window closes after the walk, not during it');
	});

	test('a cancelled walk stops the handler before it persists or closes', () => {
		const body = settle();
		const walk = offsetOf(body, 'reviewDirtyTabs({');
		const bail = offsetOf(body, 'return false;', offsetOf(body, 'if (!resolved)', walk));
		assert.ok(bail < offsetOf(body, 'persistWindowState(', walk), 'cancel returns before the snapshot');

		const handler = closeHandler();
		const stop = offsetOf(handler, 'return;', offsetOf(handler, 'if (!(await settleForExit(endsSession))) {'));
		assert.ok(stop < offsetOf(handler, 'appWindow.close()', stop), 'and before the close is re-triggered');
	});

	test('a second close request cannot start a competing walk', () => {
		// The native red button bypasses the dialog overlay; re-entry must be
		// swallowed while a walk is active, or two walks fight over setActive
		// and the highlighted tab stops matching the dialog.
		assert.match(closeHandler(), /if \(isCloseWalkActive\) \{\s*event\.preventDefault\(\);\s*return;\s*\}/);
		// and the flag is always released, even when the user cancels mid-walk
		assert.match(settle(), /finally \{\s*isCloseWalkActive = false;\s*\}/);
	});

	test('the walk proceeds in strict tab-strip order', () => {
		// Which tab is next is the component's half of the walk: the order comes
		// from the tab array, and an active-first shortcut made the sequence look
		// random to the reader. The walking itself is covered above.
		const body = settle();
		assert.match(body, /nextDirtyTab: \(\) => tabManager\.tabs\.find\(\(t\) => t\.isDirty\)/);
		assert.doesNotMatch(body, /active\?\.isDirty/);
	});

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

	test('the restore-on-reopen branch persists window state via the shared helper', () => {
		assert.match(settle(), /persistWindowState\(await remember\(\)\);/);
		// no durable-write experiment left behind
		assert.doesNotMatch(viewer, /saveSessionState|sessionState\.js/);
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

	test('moving to an existing window uses the acknowledged transfer protocol', () => {
		assert.match(session, /async function transfer\(/);
		assert.match(session, /invoke\('complete_detached_tab', \{ token \}\)/);
		assert.match(session, /onTransferClaimed\(tabId\)/);
		assert.match(session, /async function acceptOfferedTransfer/);
		assert.match(viewer, /invoke\('offer_tab_to_window', \{ targetLabel, token \}\)/);
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

/*
 * A pinned tag's file list is written when its window ends. Every way of ending
 * a window closes tabs on the way — the last tab's ×, the close review with
 * restore off, a merge into another window — and the pin used to be written
 * after they were gone, so Home showed the group with no files.
 *
 * The window-ending functions are lifted out of MarkdownViewer.svelte and RUN
 * against a stub window; what is asserted is the last list sent to
 * `update_pinned_tag`.
 */

describe('a pinned tag keeps its files when its window ends', () => {
	const LIFTED = [
		'openFilePaths',
		'savePinnedTagIfNeeded',
		'closeTabAndWindowIfLast',
		'destroyWindowAfterTabsClosed',
		'settleForExit',
		'settleForUpdate',
		'mergeSelfInto',
		'openPinnedTag',
	];

	type Tab = { id: string; path: string; isDirty: boolean };

	function pinnedWindow(tabs: Tab[], settings: { closeWindowWithLastTab?: boolean; restoreStateOnReopen?: boolean } = {}) {
		const viewer = readSource('src/lib/MarkdownViewer.svelte');
		const source = LIFTED.map((name) => functionSource(viewer, name)).join('\n');
		const js = ts.transpileModule(source, {
			compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
		}).outputText;

		const saves: string[][] = [];
		// Whether the pin file still has this window's entry. Another window can
		// unpin the tag from Home while this one holds it.
		const pin = { exists: true };
		const calls: string[] = [];
		const loaded: string[] = [];
		let destroyed = false;
		const closeTab = (id: string) => {
			const at = tabs.findIndex((tab) => tab.id === id);
			if (at !== -1) tabs.splice(at, 1);
		};
		const tabManager = {
			tabs,
			windowTag: { name: 'work', color: '#f00', pinned: true } as object | null,
			closeTab,
			setActive: () => {},
			setWindowTag: (tag: object | null) => void (tabManager.windowTag = tag),
		};
		const known: Record<string, unknown> = {
			tabManager,
			settings: { closeWindowWithLastTab: true, restoreStateOnReopen: false, autoSave: false, language: 'en', ...settings },
			invoke: async (command: string, args?: { files?: string[]; token?: string }) => {
				if (command === 'update_pinned_tag') {
					saves.push([...args!.files!]);
					return pin.exists;
				}
				if (command === 'save_pinned_tag') throw new Error('a closing window recreated its pin');
				calls.push(args?.token ? `${command}:${pinnedTagFromWindowLabel(`window-${args.token}`)}` : command);
			},
			pinnedTagHolder: async () => undefined,
			pinnedWindowToken,
			loadMarkdown: async (file: string) => void loaded.push(file),
			appWindow: { label: 'main', destroy: async () => void (destroyed = true) },
			canCloseTab: async (id: string) => {
				const tab = tabs.find((item) => item.id === id);
				if (tab) tab.isDirty = false;
				return true;
			},
			moveTabToWindow: async (id: string) => (closeTab(id), true),
			persistWindowState: async () => {},
			tick: async () => {},
			reviewDirtyTabs,
			hasRealFilePath,
			isHomePath,
			liveMode: false,
			isCloseWalkActive: false,
		};
		// Anything else the functions keep between calls lands here, as it would
		// on the component.
		const scope = new Proxy(known, {
			has: () => true,
			get: (target, key) => (key in target ? target[key as string] : (globalThis as any)[key]),
		});
		const build = new Function('scope', `with (scope) { ${js}\nreturn { ${LIFTED.join(', ')} }; }`);
		const fns = build(scope) as Record<string, (...args: any[]) => Promise<unknown>>;
		return { fns, tabs, saves, pin, calls, loaded, tabManager, isDestroyed: () => destroyed };
	}

	const twoFiles = (): Tab[] => [
		{ id: 'a', path: '/notes/a.md', isDirty: false },
		{ id: 'b', path: '/notes/b.md', isDirty: false },
	];

	test('closing every tab with × keeps the last file in the pin', async () => {
		const w = pinnedWindow(twoFiles());
		await w.fns.closeTabAndWindowIfLast('a');
		await w.fns.closeTabAndWindowIfLast('b');
		assert.equal(w.isDestroyed(), true);
		assert.deepEqual(w.saves.at(-1), ['/notes/b.md']);
	});

	test('with the window kept open, closing the empty window later does not empty the pin', async () => {
		const w = pinnedWindow(twoFiles(), { closeWindowWithLastTab: false });
		await w.fns.closeTabAndWindowIfLast('a');
		await w.fns.closeTabAndWindowIfLast('b');
		assert.equal(w.isDestroyed(), false);
		assert.equal(await w.fns.settleForExit(async () => true), true);
		assert.deepEqual(w.saves.at(-1), ['/notes/b.md']);
	});

	test('the close review with restore off keeps the dirty tabs it closes in the pin', async () => {
		const tabs = twoFiles();
		tabs[0].isDirty = true;
		const w = pinnedWindow(tabs);
		assert.equal(await w.fns.settleForExit(async () => true), true);
		assert.deepEqual(w.tabs.map((tab) => tab.id), ['b'], 'the review closed the dirty tab');
		// The handler re-triggers the close after a review, and settles again.
		assert.equal(await w.fns.settleForExit(async () => true), true);
		assert.deepEqual(w.saves.at(-1), ['/notes/a.md', '/notes/b.md']);

		// A window that lives on after that (an update that failed to install)
		// saves what it has open, not the list the review started from.
		w.tabs.push({ id: 'c', path: '/notes/c.md', isDirty: false });
		assert.equal(await w.fns.settleForExit(async () => true), true);
		assert.deepEqual(w.saves.at(-1), ['/notes/b.md', '/notes/c.md']);
	});

	test('an update whose install fails leaves no stale review list behind', async () => {
		// The update settles like a close but is not followed by one: when the
		// install fails the window stays, and a later last-tab close saved the
		// list the update's review started from.
		const tabs = twoFiles();
		tabs[0].isDirty = true;
		const w = pinnedWindow(tabs);
		assert.equal(await w.fns.settleForUpdate(), true);
		assert.deepEqual(w.saves.at(-1), ['/notes/a.md', '/notes/b.md']);

		w.tabs.push({ id: 'c', path: '/notes/c.md', isDirty: false });
		await w.fns.closeTabAndWindowIfLast('b');
		await w.fns.closeTabAndWindowIfLast('c');
		assert.deepEqual(w.saves.at(-1), ['/notes/c.md']);
	});

	test('merging a pinned window into another keeps its files in the pin', async () => {
		const w = pinnedWindow(twoFiles());
		await w.fns.mergeSelfInto('other');
		assert.equal(w.isDestroyed(), true);
		assert.deepEqual(w.saves.at(-1), ['/notes/a.md', '/notes/b.md']);
	});

	test('a pin another window removed stays removed when this window closes', async () => {
		const w = pinnedWindow(twoFiles());
		w.pin.exists = false;
		assert.equal(await w.fns.settleForExit(async () => true), true);
		assert.deepEqual(w.tabManager.windowTag, { name: 'work', color: '#f00', pinned: false }, 'the window still claims the pin');
	});

	const research = { name: 'research', color: '#0a0', files: ['/papers/x.md', '/papers/y.md'] };

	test('opening a pinned group in a window with tabs opens a new window for it', async () => {
		const w = pinnedWindow(twoFiles());
		await w.fns.openPinnedTag(research);
		assert.deepEqual(w.calls, ['create_transfer_window:research'], 'the new window reads the group from its label');
		assert.deepEqual(w.loaded, [], 'no file of the group joins this window');
		assert.deepEqual(w.tabs.map((tab) => tab.id), ['a', 'b']);
		assert.deepEqual(w.tabManager.windowTag, { name: 'work', color: '#f00', pinned: true });
	});

	test('an empty window adopts the pinned group in place', async () => {
		const w = pinnedWindow([]);
		w.tabManager.windowTag = null;
		await w.fns.openPinnedTag(research);
		assert.deepEqual(w.calls, []);
		assert.deepEqual(w.loaded, research.files);
		assert.deepEqual(w.tabManager.windowTag, { ...research, pinned: true });
	});
});

describe('a pinned group opens in a window that holds it', () => {
	test('a window opened for a pinned group is created as the group\'s holder', async () => {
		// The window reports its tag only once it has mounted and read the group.
		// Until then the registry knew nothing of it, so a second click on the same
		// group opened a second window. `tagName` has the backend record the holder
		// as it creates the window.
		const calls: { cmd: string; args: any }[] = [];
		(globalThis as any).window = {
			__TAURI_INTERNALS__: {
				invoke: async (cmd: string, args: any) => {
					calls.push({ cmd, args });
					return cmd === 'list_viewer_windows' ? [] : null;
				},
			},
		};
		try {
			await openPinnedTagWindow('Work');
		} finally {
			delete (globalThis as any).window;
		}
		const create = calls.find((call) => call.cmd === 'create_transfer_window');
		assert.equal(create?.args.tagName, 'Work');
		assert.equal(pinnedTagFromWindowLabel(`window-${create?.args.token}`), 'Work');

		// The other route that opens a pinned group in a new window says the same.
		const viewer = readSource('src/lib/MarkdownViewer.svelte');
		const pinnedCreates = viewer.match(/invoke\('create_transfer_window', \{[^}]*pinnedWindowToken[^}]*\}\)/g) ?? [];
		assert.ok(pinnedCreates.length > 0, 'MarkdownViewer no longer opens a pinned group in a new window');
		for (const call of pinnedCreates) {
			assert.match(call, /tagName:/, call);
		}
		// And the window does not report itself, clearing that name, before it has
		// adopted the group.
		assert.match(viewer, /\$effect\(\(\) => \{\n\t\tif \(!windowMetaReady\) return;\n\t\tinvoke\('set_window_meta'/);
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

	test('every mutation goes through the read-modify-write helper', () => {
		assert.match(viewer, /recentFiles = updateStoredRecentFiles\(\((\w+)\) => promoteRecentFile\(\1, path\)\)/);
		assert.match(viewer, /recentFiles = updateStoredRecentFiles\(\((\w+)\) => dropRecentFile\(\1, path\)\)/);
		assert.match(viewer, /recentFiles = updateStoredRecentFiles\(\((\w+)\) => renameRecentFile\(\1, oldPath, newPath\)\)/);
		assert.equal(viewer.match(/updateStoredRecentFiles\(/g)?.length, 3, 'exactly three call sites, all of them shown above');
	});

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

	test('a window folds in what its siblings did', () => {
		// localStorage fires `storage` in every OTHER same-origin document. Without
		// this the home screen showed a stale list until restart — and that stale
		// list was what the next write published.
		assert.match(viewer, /isRecentFilesStorageEvent\(event\)\) recentFiles = readStoredRecentFiles\(\)/);
		assert.match(viewer, /window\.addEventListener\('storage', onStorage\)/);
		assert.match(viewer, /window\.removeEventListener\('storage', onStorage\)/);
	});
});

describe('window state restore', () => {
	const tabs = readSource('src/lib/stores/tabs.svelte.ts');
	const viewer = readSource('src/lib/MarkdownViewer.svelte');
	const session = readSource('src/lib/sessions/windowSession.svelte.ts');

	// Session restore persists WINDOW state only: which files are open, the
	// active tab, and per-tab UI (edit mode, split, scroll). Document content
	// always lives on disk — the snapshot never carries rawContent, so unsaved
	// changes are handled exclusively by the per-tab close dialogs.

	/** What the close handler and the in-app update run before the window goes away. */
	function settleForExit(): string {
		return functionSource(viewer, 'settleForExit');
	}

	test('startup restore reads content from disk, not from the snapshot', () => {
		const restore = sliceBetween(session, 'async function restore', 'async function claimTransferredTab');
		// The tab on screen is read the way an open reads it, through the document
		// session's `loadMarkdown`; restore itself reads no file, and never takes a
		// document's text from the snapshot (sessionRestoreResilience.spec.ts).
		assert.match(restore, /await options\.loadRestoredTab\(active\.id\);/);
		assert.doesNotMatch(restore, /invoke\('read_file/);
		assert.match(viewer, /loadRestoredTab: \(tabId\) => documentSession\.readRestoredTab\(tabId\),/);
		// Its read is taken before the first await, so the activation effect cannot
		// start a second one while the breadcrumb is being written.
		assert.ok(
			offsetOf(restore, 'tabManager.takeUnread(active.id)') < offsetOf(restore, 'progress.pending = active.path'),
			'the read is taken before the breadcrumb write',
		);
		// the others wait unread; a deferred document is unavailable instead, so
		// activation does not read it behind the breadcrumb's back
		assert.match(restore, /tabManager\.markTabContentUnavailable\(tab\.id\);/);
		assert.match(restore, /else tabManager\.markTabUnread\(tab\.id\);/);
		// dropping is reserved for an entry that is not a file at all — a legacy
		// 'HOME' sentinel (homeSentinelSnapshot.spec.ts)
		assert.match(restore, /if \(!hasRealFilePath\(tab\.path\)\) \{\s*\n\s*options\.dropRestoredTab\(tab\.id\);/);
		assert.match(viewer, /await windowSession\.restore\(\);/);
	});

	test('an editor on a buffer that is not the whole file refuses typing', () => {
		// An unread or unreadable tab in edit mode shows an empty buffer that no
		// save will ever accept. Read-only at the keyboard, not a toast at the save.
		assert.match(viewer, /readOnly=\{tabManager\.activeTab\.isTruncated === true\}/);
		const editor = readSource('src/lib/components/Editor.svelte');
		assert.match(editor, /editor\.updateOptions\(\{ \.\.\.editorOptionsFromSettings\(settings, zoomLevel, fontIsMonospace\), readOnly \}\)/);
	});

	test('the close flow resolves dirty tabs before serializing window state', () => {
		const body = settleForExit();
		const walk = offsetOf(body, 'reviewDirtyTabs({');
		const persist = offsetOf(body, 'persistWindowState(');
		assert.ok(walk < persist, 'dirty tabs must be resolved before the snapshot is written');
	});

	test('v2 snapshots are invisible to legacy builds (Rust file, localStorage keys removed)', () => {
		// An older build restoring a snapshot it cannot understand ends up with
		// undefined tab content; its editor then attributes a stale buffer to the
		// wrong tab and auto-save writes it to disk. The snapshot now lives in a
		// Rust-written file (setItem is an async message to the WebKit storage
		// process and loses a flush race when the last window's close ends the
		// process); both localStorage keys are removed on write, so a downgraded
		// build starts a fresh session instead of misreading anything.
		const scope = sliceBetween(session, 'async function persistState', 'async function restore');
		// Through the session's one snapshot writer, which calls the Rust command.
		assert.match(scope, /snapshots\.flush\(/);
		assert.match(session, /write: \(json\) => invoke\('save_window_state'/);
		assert.doesNotMatch(scope, /setItem\(/);
		assert.match(scope, /removeItem\(options\.windowStateKey\)/);
		assert.match(scope, /removeItem\(options\.legacyStateKey\)/);
		assert.match(viewer, /const WINDOW_STATE_KEY = 'savedTabsDataV2';/);
		// startup prefers the Rust file and falls back to the localStorage keys
		// (v2 first, then legacy) for one-time migration of older snapshots
		assert.match(session, /invoke\('load_window_state'\)/);
		assert.match(
			session,
			/localStorage\.getItem\(options\.windowStateKey\) \?\?\n?\s*localStorage\.getItem\(options\.legacyStateKey\)/,
		);
		// The shared helper clears the Rust snapshot and both localStorage keys.
		// Only turning the setting off uses it: a restore that goes wrong must never
		// delete the record of which documents were open, and quitting writes the
		// snapshot rather than discarding it.
		const discardScope = sliceBetween(session, 'async function discardPersistedState', 'async function readProgress');
		assert.match(discardScope, /clear_window_state/);
		assert.match(discardScope, /removeItem\(options\.windowStateKey\)/);
		assert.match(discardScope, /removeItem\(options\.legacyStateKey\)/);
	});

	test('quitting writes the session instead of discarding it', () => {
		// ⌘Q used to discard the snapshot, so it and the red button disagreed
		// about whether the session came back — silently, because the dialog that
		// explained the difference only appeared when a tab was dirty (#390).
		// Quitting now closes every window and each one persists through its own
		// close handler.
		const exitScope = sliceBetween(viewer, 'async function appExit', '\n\t}');
		assert.doesNotMatch(exitScope, /discardPersistedWindowState/);
		assert.match(exitScope, /await getAllWindows\(\)/, 'every window is asked, not just the focused one');
		assert.match(exitScope, /other\.label !== appWindow\.label/, 'this window closes last');
		// Nothing may skip the close handler's review and persist step any more.
		assert.doesNotMatch(viewer, /isForceExiting/);
	});

	test('with restore enabled resolved titled tabs stay open for the snapshot', () => {
		const handler = settleForExit();
		// tabs are closed one-by-one only when restore is off (or untitled).
		// The walk itself is covered by windowClosePerTab, which runs it; what is
		// asserted here is the policy the component hands it.
		assert.match(handler, /!settings\.restoreStateOnReopen \|\| tab\.path === ''/);
	});

	test('auto-save fast path silently saves titled tabs before the walk', () => {
		const handler = settleForExit();
		const fastPath = offsetOf(handler, 'if (settings.autoSave) {');
		const walk = offsetOf(handler, 'reviewDirtyTabs({');
		assert.ok(fastPath < walk, 'the silent save runs before the per-tab walk');
	});
});

describe('window tags and pinned sessions', () => {
	const runtime = readSource('src-tauri/src/window_runtime.rs');
	const viewer = readSource('src/lib/MarkdownViewer.svelte');
	const titleBar = readSource('src/lib/components/TitleBar.svelte');
	const home = readSource('src/lib/components/HomePage.svelte');

	test('only explicitly pinned tags create reusable sessions', () => {
		assert.match(runtime, /pub fn save_pinned_tag/);
		assert.match(runtime, /pub fn remove_pinned_tag/);
		assert.match(viewer, /if \(!tag\?\.pinned\) return;/);
		assert.match(viewer, /savePinnedTagIfNeeded/);
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
