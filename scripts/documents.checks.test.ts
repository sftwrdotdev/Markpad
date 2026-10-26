import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { LIST_MARKER, TASK_BOX } from '../src/lib/utils/listSyntax.js';
import { MARKDOWN_LINK_EXTENSIONS } from '../src/lib/utils/markdownLinks.js';
import { viewerCommandTable } from './keymapHarness.js';
import {
	functionSource,
	offsetOf,
	readDictionarySource,
	readRustBackend,
	readSource,
	readSourceFiles,
	sliceBetween,
	sliceFrom,
} from './sourceTree.js';

/*
 * #379 made every read that fills a WRITABLE buffer report whether the decode
 * was lossy, so the tab can refuse to write U+FFFD back over a file that was
 * merely in another encoding. Three reads kept the bare command:
 * `ensureFullContent`, and the two in MarkdownViewer that fill the editor and
 * the split pane. They were safe — but only because each re-read a file whose
 * tab `loadMarkdown` had already flagged. That is an invariant held by call
 * sites agreeing with each other, and the failure mode when one stops agreeing
 * is a destroyed document. It is now held by the code: every one of them reads
 * the fidelity itself.
 *
 * WHAT IS LEFT IN THIS FILE, AND WHY IT IS HERE RATHER THAN UNDER VITEST
 *
 * Every assertion below reads source text, and each one is of a kind no run can
 * reach:
 *
 *   - that the unchecked command exists NOWHERE. An absence is not observable
 *     at run time: executing the checked read cannot prove there is no other
 *     caller of the unchecked one. The same claim then crosses into the Rust
 *     crate, where nothing but the spelling connects the two sides.
 *   - the two MarkdownViewer call sites, and the two auto-save ones. They are
 *     in a `.svelte` component, and mounting one here would put jsdom in for
 *     Monaco, mermaid and KaTeX to earn a weaker claim than the text does —
 *     what these pin is the ORDER of statements inside a handler (flag the tab
 *     before the buffer is published; recognise the refusal before raising the
 *     generic toast), which is a property of the code as written.
 *
 * `ensureFullContent` is not here: it is a runes module driven for real, and
 * running it under a hand-written `$state` was standing exactly where the
 * assertions look. It is `checkedReadMigration.spec.ts` now. `lossyDecodeSaveGuard.test.ts`
 * and `lossySaveRefusalScope.spec.ts` cover the store behaviour these source
 * assertions deliberately stop short of.
 *
 * The second half of this file is the toast the guard's refusal used to
 * trigger every 1.5 seconds.
 */
describe('checked read migration', () => {
	// --- the two component call sites -------------------------------------------

	const viewer = readSource('src/lib/MarkdownViewer.svelte');

	test('the unchecked read command is gone, and nothing calls it', () => {
		// This was a three-file allowlist — the files #379 migrated. That is the
		// wrong shape for a rule that means "nobody, anywhere": a fourth file
		// added the call and the test still passed. Two changes fix it. The scan
		// below covers the whole tree, so a new file cannot slip under it. And the
		// Rust command itself is deleted, which is what turns the rule from a
		// convention into a fact: `read_file_content` is not registered any more,
		// so invoking it fails loudly instead of quietly filling a buffer with
		// mojibake nothing flagged.
		const offenders = readSourceFiles('src')
			.filter(({ text }) => /invoke\('read_file_content'/.test(text))
			.map(({ path }) => path);
		assert.deepEqual(offenders, [], 'read_file_content no longer exists; read_file_content_checked is the read');

		const rust = readRustBackend();
		assert.doesNotMatch(rust, /\basync fn read_file_content\(/, 'the unchecked command must stay deleted');
		assert.doesNotMatch(rust, /^\s*read_file_content,\s*$/m, 'and must not be registered again');
	});

	test('entering the editor reads the fidelity and stores it', () => {
		const toggle = sliceBetween(viewer, 'async function toggleEdit', 'async function saveContent');
		assert.match(toggle, /\[content, lossy, encoding\] = \(await invoke\('read_file_content_checked', \{ path: tab\.path \}\)\)/);
		const read = offsetOf(toggle, 'read_file_content_checked');
		const flag = offsetOf(toggle, 'setTabDecodedLossy(tab.id, lossy)');
		const store = offsetOf(toggle, 'setTabRawContent(tab.id, content)');
		assert.ok(read < flag && flag < store, 'flag the tab before the buffer is published');
	});

	test('entering split view reads the fidelity and stores it', () => {
		const enter = sliceBetween(viewer, 'async function toggleSplitView', '} else {');
		assert.match(enter, /\[content, lossy, encoding\] = \(await invoke\('read_file_content_checked', \{ path: tab\.path \}\)\)/);
		const flag = offsetOf(enter, 'setTabDecodedLossy(tab.id, lossy)');
		const store = offsetOf(enter, 'setTabRawContent(tab.id, content)');
		assert.ok(flag < store, 'flag the tab before the buffer is published');
	});

	// --- the repeating toast ------------------------------------------------------

	test('a refused save does not add a generic toast to its own explanation', () => {
		const body = sliceBetween(viewer, 'Auto-save effect.', 'for (const id of [');
		const check = offsetOf(body, 'if (documentSession.isLossySaveRefused(s.id)) return;');
		const toast = offsetOf(body, "t('toast.autoSaveFailed'");
		assert.ok(check < toast, 'the refusal must be recognised before the generic toast is raised');
	});

	test('a tab that can only be refused stops re-arming the timer', () => {
		// Auto-save re-arms on every keystroke. Without this the guard was reached
		// again every 1.5s for as long as the user kept typing — each time
		// producing the console warning, the wasted round trip, and (before the
		// test above) the toast.
		const body = sliceBetween(viewer, 'Auto-save effect.', 'for (const id of [');
		assert.match(body, /decodedLossily: tab\.hasReplacementChars/);
		assert.match(body, /const eligible = [^;]*!\(s\.decodedLossily && documentSession\.isLossySaveRefused\(s\.id\)\)/);
		// The FIRST attempt must still happen: it is what produces the explanation.
		// `isLossySaveRefused` is false until the guard has spoken, so eligibility
		// only drops afterwards — and "Save As" to a new file clears
		// `hasReplacementChars`, which restores it.
		assert.match(
			readSource('src/lib/sessions/documentSession.svelte.ts'),
			/lossySaveWarnedTabs\.delete\(tab\.id\)/,
		);
	});
});

// Every read path decodes leniently (#371): a file it cannot read opens with
// U+FFFD substituted for the bytes it could not, instead of failing. U+FFFD is
// not reversible — the original bytes are gone from the buffer. Writing that
// buffer back over the source file (auto-save does it 1.5s after the first
// keystroke) destroys the document permanently.
//
// Detection (#372) removed the common cause rather than the guard: a legacy
// encoding (GBK, Big5, Shift-JIS, CP-1252 ...) is now read properly and
// written back as itself — `documentEncodingRoundTrip.spec.ts` drives that.
// What is left here is the file NO encoding can read, which is still a buffer
// that must never reach its own file.
//
// The guard: Rust reports the fidelity of every decode, the tab carries it —
// through window restore and cross-window moves — and `documentSession`
// refuses to write such a buffer over the file it came from. That is the
// single choke point every writer shares, including MarkdownViewer's
// auto-save timer and the close dialogs. "Save As" to a *different* path
// stays open: the new file is genuinely UTF-8, so writing it is correct, and
// it is the user's only way out.
describe('lossy decode save guard', () => {
	const session = readSource('src/lib/sessions/documentSession.svelte.ts');
	const rust = readRustBackend();

	test('both read commands can report fidelity', () => {
		assert.match(rust, /async fn open_markdown_preview\([^)]*\)\s*-> Result<\(String, bool, bool, String\), String>/s);
		assert.match(rust, /async fn read_file_content_checked\(path: String\) -> Result<\(String, bool, String\), String>/);
		assert.match(rust, /read_file_content_checked,/, 'the command must be registered');
	});

	test('saveContent is the choke point auto-save and the close dialogs share', () => {
		// Auto-save lives in MarkdownViewer.svelte's debounce effect and the close
		// flow in canCloseTab; both reach saveContent, so guarding it covers them
		// without touching either.
		assert.match(session, /const success = await saveContent\(tabId\);/);
		const viewer = readSource('src/lib/MarkdownViewer.svelte');
		assert.match(viewer, /saveSilently\(s\.id\)\.then\(/);
		assert.match(functionSource(viewer, 'saveSilently'), /documentSession\.saveContent\(tabId\)/);
	});

	test('the refusal names Save As, the only exit', () => {
		// i18n wording. That the session raises this message once per tab is
		// driven in documents.session.spec.ts.
		const i18n = readDictionarySource();
		assert.match(i18n, /lossySaveBlocked: 'Not saved: parts of this file could not be read in any encoding/);
		assert.match(i18n, /use "Save As" to write a copy/);
	});
});

describe('save from reading mode', () => {
	test('the browser save dialog is always suppressed', () => {
		// preventDefault has to run for every mode, including the no-op case, or
		// reading mode would surface the webview's own Save Page dialog. It is one
		// unconditional call on the command rather than one per branch now, so this
		// reads the six-line handler rather than the branch it used to sit in — and
		// covers all twenty-two commands instead of Save alone.
		const handler = functionSource(readSource('src/lib/MarkdownViewer.svelte'), 'handleKeyDown');
		assert.match(
			handler,
			/if \(!command\) return;\s*\n\s*e\.preventDefault\(\);/,
			'a command that runs must have had the keystroke prevented first',
		);
	});

	/*
	 * The three below are the residue of this seam, and they say so.
	 *
	 * What Ctrl+S DOES is a closure over `tabManager.activeTab` inside the
	 * component, which is the one thing that could not move: see the note on
	 * `viewerCommandTable` in `keymapHarness.ts`. They are still text assertions —
	 * but text anchored on a `case 'save':` label rather than on a chord condition,
	 * so the rename that reddened five of these in #647 no longer reaches them.
	 */
	const saveCommand = () => viewerCommandTable()['save'];

	test('an untitled buffer can be saved from reading mode', () => {
		// `path === ''` is the untitled case; documentSession.saveContent opens
		// the Save dialog for it, so no extra plumbing is needed here.
		assert.match(saveCommand(), /saveTarget\.path === ''/);
	});

	test('a saved, unmodified document does not write on Ctrl+S', () => {
		// Writing unconditionally would touch mtime and wake the file watcher,
		// which in live mode reloads the tab -- a keystroke that reads as a no-op
		// to the user should not move the document underneath them.
		assert.match(saveCommand(), /saveTarget\.isDirty \|\| saveTarget\.path === ''/);
	});

	test('the HOME tab is not savable', () => {
		// HOME carries the sentinel path 'HOME' and is never dirty, so the guard
		// excludes it without naming it. This pins that reasoning: if the guard
		// ever becomes unconditional, HOME would start opening a Save dialog.
		assert.doesNotMatch(saveCommand(), /^\s*saveContent\(\);\s*$/m);
	});
});

describe('unsaved recovery', () => {
	test('the close decision commands are spelled the same in the viewer and in Rust', () => {
		// Cross-language contract: only the string connects invoke() to the command.
		const viewer = readSource('src/lib/MarkdownViewer.svelte');
		const rust = readSource('src-tauri/src/window_runtime.rs');
		for (const name of ['keeps_unsaved_on_close', 'set_quitting']) {
			assert.ok(viewer.includes(`invoke<boolean>('${name}'`) || viewer.includes(`invoke('${name}'`), `viewer does not invoke ${name}`);
			assert.match(rust, new RegExp(`pub fn ${name}\\(`), `Rust does not declare ${name}`);
		}
	});
});

describe('live mode watched path', () => {
	const runtime = readSource('src-tauri/src/window_runtime.rs');
	const viewer = readSource('src/lib/MarkdownViewer.svelte');

	test('a watcher notification is routed to its watched path', () => {
		assert.match(runtime, /emit_to\(event_label\.as_str\(\), "file-changed", watched_path\.clone\(\)\)/);
		// `async` because deciding what an event means now reads the file: the
		// answer to "did somebody else write this" is the file itself, not a clock.
		assert.match(viewer, /await appWindow\.listen\('file-changed', async \(event\) => \{/);
		assert.match(viewer, /const changedPath = event\.payload as string;/);
		// The listener no longer compares the payload with the active file itself:
		// resolveExternalChange looks up the tab that OWNS the changed path (and
		// refuses to reload it when it has unsaved edits). See
		// externalChangeReload.spec.ts for the routing behaviour.
		assert.match(viewer, /await documentSession\.resolveExternalChange\(changedPath\)/);
		// A conflict is reported with Live Mode off too; Live Mode gates only the reload.
		assert.match(viewer, /if \(liveMode\) loadMarkdown\(outcome\.path\);/);
		const session = readSource('src/lib/sessions/documentSession.svelte.ts');
		assert.match(session, /tabManager\.tabs\.find\(\(tab\) => tab\.path === changedPath\)/);
	});

	test('toggling Live Mode does not reload the document', () => {
		// The watcher half of this case is driven in documents.session.spec.ts
		// (fileWatch.svelte.ts). The toggle is one assignment inside the viewer.
		const toggleLiveMode = sliceBetween(viewer, 'function toggleLiveMode', 'async function saveImageAs');
		assert.doesNotMatch(toggleLiveMode, /loadMarkdown\(/);
	});
});

describe('file associations', () => {
	const config = JSON.parse(readSource('src-tauri/tauri.conf.json')) as {
		bundle: {
			fileAssociations: Array<{ ext: string[]; contentTypes?: string[]; mimeType?: string; name: string }>;
		};
	};

	// Every extension Markpad treats as a Markdown document is associated, except
	// `.txt`. An extension added to either list fails here until the other follows.
	test('installer associates every Markdown extension except txt', () => {
		const extensions = config.bundle.fileAssociations.flatMap((association) => association.ext);
		assert.deepEqual(
			extensions,
			MARKDOWN_LINK_EXTENSIONS.filter((ext) => ext !== 'txt'),
		);
	});

	// macOS ignores `ext` once an association has a content type, and its
	// Markdown type (net.daringfireball.markdown, owned by the system) only tags
	// .md and .markdown. Any other extension must sit in an association with no
	// content type or MIME type, or it gets a dynamic UTI that no association
	// claims and Markpad drops out of Finder's Open With. One name keeps a single
	// Windows ProgID, which hooks.nsi registers under.
	test('macOS claims extensions outside the system Markdown type by extension', () => {
		for (const association of config.bundle.fileAssociations) {
			if (association.contentTypes) {
				assert.deepEqual(association.ext, ['md', 'markdown']);
			} else {
				assert.equal(association.mimeType, undefined);
			}
			assert.equal(association.name, 'Markdown File');
		}
	});

	// The other half of the same policy, kept in this file so neither side moves
	// without the reader seeing both. Claiming `.txt` in the installer takes the
	// Text Document association away from Notepad (#179), which is why the test
	// above exists — but Markpad does open, render and save `.txt` like any other
	// note, so the Open dialog has to offer them.
	test('the Open dialog offers every extension Markpad treats as a document', () => {
		const viewer = readSource('src/lib/MarkdownViewer.svelte');
		const links = readSource('src/lib/utils/markdownLinks.ts');

		assert.match(links, /MARKDOWN_LINK_EXTENSIONS = \[[^\]]*'txt'/);
		assert.match(viewer, /\{ name: 'Markdown', extensions: MARKDOWN_LINK_EXTENSIONS \}/);
		// A literal list is how the two drifted apart in the first place.
		assert.doesNotMatch(viewer, /extensions: \['md/);
	});
});

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
describe('open file mode', () => {
	const settingsSource = readSource(new URL('../src/lib/stores/settings.svelte.ts', import.meta.url));

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

});

describe('file drop routing', () => {
	const viewerSource = readSource(new URL('../src/lib/MarkdownViewer.svelte', import.meta.url));

	test('the viewer routes both panes through it, and acts on all three answers', () => {
		const dropHandler = sliceBetween(
			viewerSource,
			"} else if (event.payload.type === 'drop') {",
			'isDragging = false;',
		);

		assert.match(dropHandler, /const pane = dropPaneFor\(dragTarget, !!currentEditor\);/);
		assert.match(dropHandler, /switch \(routeDroppedFile\(path, pane\)\)/);
		assert.match(dropHandler, /case 'insert':[\s\S]{0,120}?handleDroppedFile\(path, x, y\)/);
		assert.match(dropHandler, /case 'open':[\s\S]{0,80}?loadMarkdown\(path\)/);
		assert.match(dropHandler, /case 'unsupported':[\s\S]{0,80}?reportUnsupportedDrop\(path\)/);
		// One toast helper for both panes: the message used to be built inline in
		// the preview branch, which is part of why the editor branch had nothing
		// to say.
		assert.match(
			viewerSource,
			/function reportUnsupportedDrop\(path: string\)[\s\S]{0,300}?t\('toast\.unsupportedFile', settings\.language\)/,
		);
	});
});

describe('document encoding round trip', () => {
	test('no locale still translates a hardcoded UTF-8 label', () => {
		// A dead key reads like a supported feature to whoever finds it next.
		assert.doesNotMatch(readDictionarySource(), /utf8:/);
	});

	// ------------------------------------------- saying why a save was refused
	//
	// Refusing is only half of it. The user pasted an emoji into a GBK document
	// and got "auto-save failed, unsaved changes still in memory" — true, and no
	// help at all: it names neither the character nor the encoding, and the way
	// out (Save As, which writes UTF-8) is not in it.
	//
	// Rust sends a code and this side owns the wording, so the reason a save was
	// refused reaches the user in the language the rest of the app is in. The
	// generic English `Failed to save file: <OS message>` stays for genuine I/O
	// failures, which the user cannot act on beyond reading the OS.

	test('the unmappable-character refusal crosses as a code, not as English prose', () => {
		const rust = readRustBackend();
		assert.match(rust, /const UNMAPPABLE_CODE: &str = "ENCODING_UNMAPPABLE";/);
		assert.match(rust, /return Err\(UNMAPPABLE_CODE\.to_owned\(\)\)/, 'a marker, carrying nothing');

		// The sentence it replaced must not come back: a translated toast and an
		// English one saying the same thing is worse than either alone.
		assert.doesNotMatch(rust, /cannot represent every character it now contains/);
	});

	test('every locale can say which encoding refused the save', () => {
		const i18n = readDictionarySource();
		const locales = i18n.match(/lossySaveBlocked:/g) ?? [];
		const translated = i18n.match(/encodingUnmappable:/g) ?? [];

		assert.ok(locales.length >= 5, 'precondition: the sibling refusal is translated');
		assert.equal(translated.length, locales.length, 'both refusals reach the same languages');

		// The encoding is named, not implied — "some characters cannot be saved"
		// leaves the user with nothing to search for.
		for (const line of i18n.split('\n').filter((l) => l.includes('encodingUnmappable:'))) {
			assert.match(line, /\{\{encoding\}\}/, `no encoding placeholder: ${line.trim().slice(0, 60)}`);
		}
	});
});

describe('explicit save cancels auto-save', () => {
	test('no call site takes the cancel duty back from saveContent', async () => {
		// The regression this guards is not a broken save — it is the duty
		// drifting back out to the call sites, where the next entry point can
		// forget it again. A cancel immediately before a `saveContent` is the
		// shape that says someone stopped trusting the function to do it.
		for (const path of ['src/lib/MarkdownViewer.svelte', 'src/lib/sessions/documentSession.svelte.ts']) {
			const body = readSource(path);
			assert.doesNotMatch(
				body,
				/cancelPendingAutoSave\([^)]*\);\s*(?:\/\/[^\n]*\n\s*)*(?:const \w+ = )?(?:await |return )*saveContent\(/,
				`${path} pairs a manual cancel with a save; saveContent already does this`,
			);
		}

		// And the duty is discharged before the write, not after — the source-level
		// mirror of the ordering test above, so a refactor that reorders the two
		// inside `saveContent` is caught even if the stub harness stops seeing it.
		const session = readSource('src/lib/sessions/documentSession.svelte.ts');
		const saveContentBody = session.slice(session.indexOf('async function saveContent('));
		const cancel = saveContentBody.indexOf('options.cancelPendingAutoSave(');
		const write = saveContentBody.indexOf("invoke('save_file_content'");
		assert.ok(cancel !== -1, 'saveContent must cancel the pending auto-save');
		assert.ok(cancel < write, 'the cancel must come before the write it protects');
	});
});

describe('external change reload', () => {
	const viewer = readSource('src/lib/MarkdownViewer.svelte');

	// --- wiring that cannot be executed outside a Svelte runtime ---

	test('the watcher listener routes every event through the guarded resolution', () => {
		const body = sliceBetween(viewer, "listen('file-changed'", '}),');
		assert.match(body, /resolveExternalChange/);
		// The old body called loadMarkdown(currentFile) directly.
		assert.doesNotMatch(body, /loadMarkdown\(currentFile\)/);
	});

	test('a conflict is surfaced with both choices instead of resolving itself', () => {
		assert.match(viewer, /externalChangeConflicts/);
		assert.match(viewer, /t\('externalChange\.reload'/);
		assert.match(viewer, /t\('externalChange\.keepMine'/);
	});

	test('the debounced auto-save is held back while a conflict is unanswered', () => {
		// Otherwise the 1.5s timer fires while the bar is still asking "reload or
		// keep mine": the user's edits survive, but the external change is gone
		// from disk before either answer can be given.
		const body = sliceBetween(viewer, 'Auto-save effect.', 'for (const id of [');
		assert.match(body, /hasPendingConflict: hasExternalChangeConflict\(tab\.id\)/);
		assert.match(body, /const eligible = [^;]*!s\.hasPendingConflict/);
	});

	test('an explicit save answers the conflict and takes the bar down', () => {
		// Pressing Cmd+S is a decision. Leaving the bar up afterwards would ask a
		// question the user already answered.
		const body = sliceBetween(viewer, 'async function saveContent(tabId?: string)', 'async function saveContentAs');
		assert.match(body, /clearExternalChangeConflict/);
	});

	test('turning Live Mode on does not reload', () => {
		// Enabling reload is not a request to discard the buffer, and this was
		// the one loadMarkdown call in the app with no canCloseTab in front of it.
		const body = sliceBetween(viewer, 'function toggleLiveMode', '\n\t}');
		assert.doesNotMatch(body, /loadMarkdown/);
	});

	test('entering split view no longer turns Live Mode off behind the user', () => {
		// #692. Split used to kill live mode on the way in, with no comment and no
		// way back — the setting was silently dropped and stayed dropped after
		// leaving. That line arrived with the original split-view commit and reads
		// as a consequence of the Auto-Reload button being hidden there (nothing
		// left to turn it off with) rather than a decision that a split pane should
		// not follow the file. The button and the chord are now offered in all
		// three modes; a kill here would take the state straight back off.
		//
		// An absence claim about a component that cannot be imported, so it is
		// matched as source text — the same reason as the four assertions above.
		const body = sliceBetween(viewer, 'async function toggleSplitView', '\n\t}');
		assert.doesNotMatch(body, /toggleLiveMode|liveMode\s*=/);
	});

	// --- #4: the irreversible answer is now visible before it is given ---

	test('the conflict bar offers Compare beside the two answers', () => {
		// Reload replaces the buffer and `setValue` clears the undo stack with it,
		// so the bar asks for an irreversible decision. VS Code and Sublime both
		// put a Compare next to the same two choices.
		const bar = sliceBetween(viewer, 'external-change-bar', '{/if}');
		assert.match(bar, /t\('externalChange\.compare'/);
		assert.match(bar, /t\('externalChange\.reload'/);
		assert.match(bar, /t\('externalChange\.keepMine'/);
	});

	test('Compare reads the file at the moment it is asked, not when the bar went up', () => {
		// The bar can stand for a while. What the user needs to see is the file as
		// it is when they are actually answering.
		const fn = sliceBetween(viewer, 'async function compareExternalChange', '\n\t}');
		assert.match(fn, /read_file_content_checked/);
		assert.match(fn, /tab\.rawContent/);
	});

	test('answering the bar closes the comparison with it', () => {
		// Otherwise the overlay outlives the question and shows a diff against a
		// version that is no longer either side of anything.
		for (const name of ['resolveExternalChangeByReloading', 'resolveExternalChangeByKeepingBuffer']) {
			const fn = sliceBetween(viewer, `function ${name}`, '\n\t}');
			assert.match(fn, /comparison = null/, `${name} left the comparison open`);
		}
	});
});

describe('reopening a dirty document', () => {
	// Cwd-relative, not `import.meta.url`: see the note on `readSource`.
	const viewer = readSource('src/lib/MarkdownViewer.svelte');

	// A link opened in a new tab takes the ordinary open path, which resolves the
	// file's identity before picking a tab. Putting the path on a tab first and
	// loading with `skipTabManagement` compared spellings, so `C:/n/b.md` from a
	// link opened a second tab beside the `C:\n\b.md` the user already had open.
	test('a link opened in a new tab goes through the ordinary open path', () => {
		const fn = sliceBetween(viewer, 'async function openMarkdownTargetInNewTab', '\n\tasync function');
		assert.doesNotMatch(fn, /tabManager\.addTab\(/);
		assert.match(fn, /await loadMarkdown\(resolved, \{ inNewTab: true \}\);/);
	});

	// --- reverting is still possible, and only by saying so ---
	//
	// Authorization is declared by the caller, never inferred by the session from
	// nearby state. An earlier draft let an unanswered external-change conflict
	// stand in for the user's "Reload" click; that is guessing intent from an
	// adjacent flag, and two callers can be in that state for different reasons.

	// The two revert commands, and only those two. Anything else that starts
	// passing this flag is a caller claiming the user chose to lose work.
	for (const name of ['resolveExternalChangeByReloading', 'reloadFromDisk']) {
		test(`${name} declares that it is discarding the buffer`, () => {
			const fn = sliceBetween(viewer, `async function ${name}`, '\n\t}');
			assert.match(fn, /loadMarkdown\(/);
			assert.match(fn, /discardUnsavedBuffer: true/);
		});
	}

	test('nothing else in the viewer asks to discard a buffer', () => {
		assert.equal(viewer.match(/discardUnsavedBuffer: true/g)?.length, 2);
	});
});

describe('truncated buffer guard', () => {
	const viewer = readSource('src/lib/MarkdownViewer.svelte');

	// --- wiring that cannot be executed outside a Svelte runtime ---

	test('entering split view completes a partial buffer instead of trusting it', () => {
		// The old guard was `!tab.rawContent`, which a partial buffer satisfies:
		// split view opened on the truncated text, the first keystroke made it
		// dirty, and auto-save wrote it back 1.5s later.
		const enter = sliceBetween(viewer, 'async function toggleSplitView', '} else {');
		assert.match(enter, /ensureFullContent/);
		// And it has to stop when the buffer could not be completed, rather than
		// opening an editor over the partial text anyway.
		assert.match(enter, /if \(!\(await documentSession\.ensureFullContent\(tab\.id\)\)\) \{[\s\S]*?return;/);
		// The empty-buffer read must go through the store so the tab does not keep
		// a stale "partial" flag that would then block every save.
		assert.match(enter, /tabManager\.setTabRawContent\(tab\.id, content\)/);
	});

	test('a partial buffer cannot be handed to another window', () => {
		// The destination rebuilds the tab from the payload alone and has no way
		// to know the text is incomplete, so its auto-save would truncate the file.
		//
		// Each subject is extracted by its own name. The previous form sliced
		// `'canTransfer: (tabId)'` → `'transferPayload:'`, which ran past
		// `canDetach`, and `'async function handleDetach'` → `'async function
		// carryActiveTabToNextWindow'`, which ran past `moveTabToWindow`. Both
		// swallowed neighbours end in a character-identical copy of the guard being
		// asserted, so the `assert.match` was satisfied either way: deleting
		// `&& !tab.isTruncated` from `canTransfer`, and separately deleting the whole
		// four-line `ensureFullContent` guard from `handleDetach`, each left the
		// suite green — on the transfer-then-auto-save path this file is named for.
		//
		// The two neighbours were therefore never asserted about, only stood in
		// front of. Both are the same guard on the same path, so both are named.
		for (const predicate of ['canTransfer', 'canDetach']) {
			assert.match(
				functionSource(viewer, predicate),
				/!tab\.isTruncated/,
				`${predicate} must refuse a tab whose buffer is still the preview slice`,
			);
		}
		for (const mover of ['handleDetach', 'moveTabToWindow']) {
			assert.match(
				functionSource(viewer, mover),
				/if \(!\(await documentSession\.ensureFullContent\(tabId\)\)\) \{[\s\S]*?return false;/,
				`${mover} must complete the buffer before the payload is built, and stop when it cannot`,
			);
		}
	});

	test('front matter edits in preview mode complete the buffer first', () => {
		for (const entry of ['async function handleFrontMatterEdit', 'async function handleFrontMatterListChange']) {
			// One handler is followed by a `function`, the other by an `async
			// function`, so the slice ends at whichever comes first. The previous
			// expression was `indexOf(a) + 1 || indexOf(b) + 1`, which reads as
			// "or else" but is really "or else, if the first is absent *or at
			// offset 0*" — and when the first form appeared later in the file than
			// the second it won anyway, widening the body past the handler and
			// letting a neighbouring function satisfy the `assert.match` below.
			const handler = sliceFrom(viewer, entry);
			const ends = ['\n\tfunction ', '\n\tasync function ']
				.map((marker) => handler.indexOf(marker))
				.filter((at) => at !== -1);
			assert.ok(ends.length > 0, `${entry} must be followed by a declaration that bounds it`);
			const body = handler.slice(0, Math.min(...ends));
			assert.match(body, /ensureFullContent/, `${entry} must not edit a partial buffer`);
		}
	});
});

describe('task toggle line endings', () => {
	test('the marker grammar the renderer reads still matches listSyntax.ts', () => {
		// The last cross-language copy of this vocabulary. The rewrite above only
		// gets a chance to run on lines the *renderer* turned into a task item, and
		// `TASK_SOURCE_RE` is what decides that — so a marker one side accepts and
		// the other does not is a checkbox that draws and then refuses to toggle.
		// Every TypeScript reader imports the fragments from utils/listSyntax.ts
		// (pinned by singleImplementationConvention.test.ts); Rust cannot, so the
		// drift is caught here instead, by reading the pattern back out of the
		// source and looking for the fragments inside it.
		//
		// Fragments rather than the whole pattern, deliberately: what surrounds them
		// is allowed to differ. Rust asks a yes/no question about one line and may
		// spell its whitespace `\s`; the rewrite above works over the whole body
		// with `/m` and may not (see the comment at the call site). The marker
		// itself is the only part that has to be the same on both sides.
		const declared = sliceFrom(readRustBackend(), 'static TASK_SOURCE_RE');
		const pattern = /Regex::new\(r"([^"]*)"\)/.exec(declared);
		assert.notEqual(pattern, null, 'TASK_SOURCE_RE no longer holds a raw regex literal');

		for (const fragment of [LIST_MARKER, TASK_BOX]) {
			assert.ok(
				pattern![1].includes(fragment),
				`the Rust renderer reads ${JSON.stringify(pattern![1])}, which does not contain ${fragment} — the two sides disagree about what a list item is`,
			);
		}
	});
});
