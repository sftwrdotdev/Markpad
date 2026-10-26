import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { describe, test } from 'node:test';

import { LIST_MARKER, TASK_BOX } from '../src/lib/utils/listSyntax.js';
import { MARKDOWN_LINK_EXTENSIONS } from '../src/lib/utils/markdownLinks.js';
import { DEFAULT_OPEN_FILE_MODE } from '../src/lib/utils/openFileMode.js';
import {
	callbackBodies,
	filesMatching,
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

	// --- the repeating toast ------------------------------------------------------

	test('the session can tell a refusal from a failure', () => {
		// `saveContent` returns false for both, which is why the auto-save timer
		// could not tell them apart. The predicate is no longer set membership on
		// its own: the set records what was SAID, and whether the refusal still
		// stands is asked of the tab. `lossySaveRefusalScope.spec.ts` exercises
		// both halves for real; this only pins that the tab is consulted at all,
		// since a predicate that answers from memory alone is the defect.
		const body = sliceBetween(
			readSource('src/lib/sessions/documentSession.svelte.ts'),
			'function isLossySaveRefused(',
			'function updateLoading',
		);
		assert.match(body, /lossySaveWarnedTabs\.has\(tabId\)/);
		assert.match(body, /hasReplacementChars/, 'the live tab decides whether anything is still being refused');
	});

	test('a tab that can only be refused stops re-arming the timer', () => {
		// The eligibility rule runs in documents.test.ts "auto-save debounce". What
		// is left: "Save As" to a new file forgets that the refusal was said, so a
		// later lossy load into the same tab is explained again.
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
	const windowSession = readSource('src/lib/sessions/windowSession.svelte.ts');
	const tabs = readSource('src/lib/stores/tabs.svelte.ts');
	const rust = readRustBackend();

	const loadMarkdown = () => sliceBetween(session, 'async function loadMarkdown', 'async function saveContent');
	const saveContent = () => sliceBetween(session, 'async function saveContent(', 'async function saveContentAs');
	const saveContentAs = () => sliceBetween(session, 'async function saveContentAs', 'async function toggleTaskCheckbox');
	const guard = () => sliceBetween(session, 'function refuseIfLossilyDecoded', 'function updateLoading');

	test('one decoder, and it reports what it destroyed', () => {
		// The fact is known exactly once — when the bytes are decoded — and was
		// thrown away. Detection (#372) made the decode able to succeed where it
		// used to substitute, but not able to always succeed, so the decoder still
		// carries the verdict rather than growing a second path.
		assert.match(rust, /struct DecodedText \{[^}]*\bcontent: String,[^}]*\blossy: bool/s);
		assert.match(rust, /fn decode_text\(bytes: &\[u8\]\) -> DecodedText/);
		assert.match(rust, /fn read_to_string_lossy\(path: &str\) -> std::io::Result<DecodedText>/);
		assert.equal(rust.match(/fn decode_text\(/g)?.length, 1, 'exactly one decoder');
	});

	test('both read commands can report fidelity', () => {
		assert.match(rust, /async fn open_markdown_preview\([^)]*\)\s*-> Result<\(String, bool, bool, String\), String>/s);
		assert.match(rust, /async fn read_file_content_checked\(path: String\) -> Result<\(String, bool, String\), String>/);
		assert.match(rust, /read_file_content_checked,/, 'the command must be registered');
	});

	test('a preview cut inside a multi-byte character is not called lossy', () => {
		// The preview stops at a fixed byte count, so a perfectly valid UTF-8 file
		// is routinely cut mid-character. Reporting that as lossy would lock every
		// large CJK/emoji document out of saving — a guard worse than the bug.
		const preview = sliceBetween(rust, 'fn build_markdown_preview', '#[tauri::command]');
		const trim = offsetOf(preview, 'utf8_truncation_boundary');
		assert.ok(trim < offsetOf(preview, 'decode_text('), 'the split tail is dropped before fidelity is judged');
	});

	test('the tab carries the fidelity of its buffer', () => {
		// Required, not optional: a construction site that forgot it would default
		// to "safe to overwrite", and the failure mode is a destroyed document.
		assert.match(tabs, /hasReplacementChars: boolean;/);
		assert.doesNotMatch(tabs, /hasReplacementChars\?: boolean;/);
		assert.match(tabs, /setTabDecodedLossy\(id: string, lossy: boolean\)/);
		assert.equal(tabs.match(/hasReplacementChars: false/g)?.length, 4);
	});

	test('every load decides the flag instead of leaving it stale', () => {
		// A reload of a file the user has since converted to UTF-8 must clear it.
		const body = loadMarkdown();
		assert.match(body, /as \[string, boolean, boolean, string\]/);
		assert.match(body, /setTabDecodedLossy\(activeId, lossy\)/);
		// The full load REPLACES the preview's buffer, so it brings its own
		// verdict: a file can be valid UTF-8 for the first 50KB and not after.
		assert.match(body, /read_file_content_checked/);
		assert.match(body, /setTabDecodedLossy\(activeId, fullLossy\)/);
	});

	test('the editable-pane shortcut reports fidelity too', () => {
		// #374 added a second way into loadMarkdown: a pane that can WRITE skips
		// the preview and reads the whole file up front. That branch fills an
		// editable buffer, so it is exactly the kind of caller that must not use
		// the bare command — it would hand the editor unflagged mojibake.
		const body = loadMarkdown();
		assert.match(
			body,
			/if \(initialIsEditing \|\| initialIsSplit\) \{\s*\[content, lossy, encoding\] = \(await invoke\('read_file_content_checked'/,
		);
		// `ensureFullContent` was the one place the bare command survived, and only
		// because it re-read a file whose tab loadMarkdown had already flagged —
		// an invariant enforced by two call sites agreeing rather than by the code.
		// It now reads the fidelity itself, so no writable buffer in this file is
		// filled by a command that cannot report one.
		const bare = session.match(/invoke\('read_file_content'/g)?.length ?? 0;
		assert.equal(bare, 0, 'no writable buffer may be filled by the unchecked command');
		assert.match(
			sliceBetween(session, 'async function ensureFullContent', 'const lossySaveWarnedTabs'),
			/invoke\('read_file_content_checked'/,
		);
		assert.match(
			sliceBetween(session, 'async function ensureFullContent', 'const lossySaveWarnedTabs'),
			/setTabDecodedLossy\(tabId, lossy\)/,
		);
	});

	test('the flag is set before the buffer can reach a writer', () => {
		const body = loadMarkdown();
		const set = offsetOf(body, 'setTabDecodedLossy(activeId, lossy)');
		const buffer = offsetOf(body, 'setTabRawContent(activeId, content');
		assert.ok(set < buffer, 'the flag must be set before the buffer it describes');
		assert.doesNotMatch(body.slice(set, buffer), /await /, 'and in the same synchronous block');
	});

	test('window restore cannot launder the flag away', () => {
		// Restore reads each file back into an editable buffer. With the bare
		// command it produced mojibake that looked safe to save, so reopening the
		// app was a way around the guard. It now reads through `loadMarkdown`,
		// which sets the flag on every load, and reads nothing itself.
		assert.doesNotMatch(windowSession, /invoke\('read_file/);
		assert.match(sliceBetween(session, 'function readRestoredTab', 'function readActiveIfUnread'), /return loadMarkdown\(tab\.path,/);
		assert.match(loadMarkdown(), /tabManager\.setTabDecodedLossy\(activeId, lossy\)/);
	});

	test('saveContent refuses to write a lossy buffer over its own file', () => {
		const body = saveContent();
		const refusal = offsetOf(body, 'refuseIfLossilyDecoded');
		assert.match(body.slice(refusal, refusal + 120), /return false;/);
		assert.ok(
			refusal < offsetOf(body, "invoke('save_file_content'"),
			'the guard must run before save_file_content is invoked',
		);
	});

	test('the guard protects the source file only', () => {
		const body = guard();
		// An untitled buffer has no source file to destroy, and any other path is
		// a new UTF-8 file — neither is blocked.
		assert.match(body, /targetPath === ''/);
		assert.match(body, /targetPath !== tab\.path/);
		assert.match(body, /return true;/);
	});

	test('saveContent is the choke point auto-save and the close dialogs share', () => {
		// Auto-save lives in MarkdownViewer.svelte's debounce effect and the close
		// flow in canCloseTab; both reach saveContent, so guarding it covers them
		// without touching either.
		assert.match(session, /const success = await saveContent\(tabId\);/);
		const viewer = readSource('src/lib/MarkdownViewer.svelte');
		assert.match(viewer, /saveSilently\(s\.id\)\.then\(/);
		const saves = readSource('src/lib/sessions/externalChange.svelte.ts');
		assert.match(functionSource(saves, 'saveSilently'), /documentSession\.saveContent\(tabId\)/);
	});

	test('Save As to a new file stays open as the escape hatch', () => {
		const body = saveContentAs();
		// Explicitly UTF-8, never the tab's own encoding: the copy exists to be
		// readable when the original could not be read, or could not represent
		// what the user typed into it.
		assert.match(body, /invoke\('save_file_content', \{ path: selected, content: snapshot, encoding: 'UTF-8' \}\)/);
		// Once written, the buffer matches a UTF-8 file of its own.
		assert.match(body, /setTabDecodedLossy\(tab\.id, false\)/);
		assert.match(body, /setTabEncoding\(tab\.id, 'UTF-8'\)/);
	});

	test('Save As onto the same file is still a destructive overwrite', () => {
		const body = saveContentAs();
		// "The same file", not "the same string": the dialog can come back with
		// another spelling of the source file — a different case, or accents
		// composed differently — and on macOS and Windows that still lands on the
		// same bytes. The guard is therefore handed the target's resolved identity
		// as well as its path. See pathIdentityCaseFolding.spec.ts, which drives
		// that refusal for real instead of reading for it.
		const refusal = offsetOf(body, 'refuseIfLossilyDecoded(tab, selected');
		assert.ok(
			refusal < offsetOf(body, "invoke('save_file_content'"),
			'the guard must run before save_file_content is invoked',
		);
	});

	test('the refusal tells the user what to do and is not repeated per keystroke', () => {
		// Auto-save re-arms on every edit; an undeduplicated toast would fire
		// every 1.5s. The message names "Save As" because that is the only exit.
		const body = guard();
		assert.match(body, /toast\.lossySaveBlocked/);
		assert.match(body, /lossySaveWarnedTabs\.has\(tab\.id\)/);
		const i18n = readDictionarySource();
		assert.match(i18n, /lossySaveBlocked: 'Not saved: parts of this file could not be read in any encoding/);
		assert.match(i18n, /use "Save As" to write a copy/);
	});
});

describe('unsaved recovery', () => {
	test('the close decision commands are spelled the same in the viewer and in Rust', () => {
		// Cross-language contract: only the string connects invoke() to the command.
		const viewer = readSource('src/lib/sessions/windowExit.ts');
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

	test('the watcher follows the active file instead of retaining a previous tab watcher', () => {
		assert.match(viewer, /if \(currentFile\) \{\n\t\t\tinvoke\('watch_file', \{ path: currentFile \}\)/);

		// The defect #296 fixed was `documentSession` re-issuing `watch_file` on
		// every load, so the watcher followed whichever document loaded last rather
		// than the active one. It used to be pinned as
		// `/isLiveMode\(\)\) invoke\('watch_file'/` — the exact one-line spelling
		// the defect happened to be written in, against a file where neither token
		// occurs any more. Rewriting the same call as an ordinary `if (…) { … }`
		// evaded it. What has to hold is who may call it: the effect above, alone.
		const watchers = filesMatching(readSourceFiles('src'), /invoke\(\s*'watch_file'/);
		assert.deepEqual(watchers, ['src/lib/MarkdownViewer.svelte'], 'one owner for the file watcher');

		const watchingEffects = callbackBodies(viewer, '$effect').filter((body) => /'watch_file'/.test(body));
		assert.equal(watchingEffects.length, 1, 'and one effect inside it');
		assert.match(watchingEffects[0], /invoke\('unwatch_file'\)/, 'the same effect gives the watcher up');

		const toggleLiveMode = sliceBetween(viewer, 'function toggleLiveMode', 'async function saveImageAs');
		assert.doesNotMatch(toggleLiveMode, /loadMarkdown\(/);
	});
});

describe('editor line ending', () => {
	test('the status bar renders the measured label and no longer a translation key', () => {
		const editor = readSource('src/lib/components/Editor.svelte');
		const statusBar = sliceBetween(editor, '<div class="status-bar">', '</div>\n{/if}');

		assert.match(statusBar, /<div class="status-item">\{lineEnding\}<\/div>/, 'the line-ending item shows the state');
		assert.doesNotMatch(editor, /editor\.status\.crlf/, 'the hardcoded CRLF string is gone');
		assert.match(
			editor,
			/lineEnding = lineEndingLabel\(model\)/,
			'and it is filled from the model, in the function that refreshes document-wide readings',
		);

		// One line-ending decision reaches this component. A second one — a `\r\n`
		// test of its own over `getValue()` — is the defect this fix replaces, in a
		// new place.
		assert.doesNotMatch(editor, /includes\('\\r\\n'\)/, 'no hand-rolled line-ending detection in the editor');
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

	test('the Save dialogs offer the same document extensions', () => {
		// Both hard-coded `['md']`, so a `.txt` note saved under a new name had to
		// go through "All Files".
		const session = readSource('src/lib/sessions/documentSession.svelte.ts');

		assert.equal(session.match(/\{ name: 'Markdown', extensions: MARKDOWN_LINK_EXTENSIONS \}/g)?.length, 2);
		assert.doesNotMatch(session, /extensions: \['md/);
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
	const sessionSource = readSource(new URL('../src/lib/sessions/documentSession.svelte.ts', import.meta.url));
	const settingsSource = readSource(new URL('../src/lib/stores/settings.svelte.ts', import.meta.url));
	const settingsComponentSource = readSource(new URL('../src/lib/components/Settings.svelte', import.meta.url));
	const tabsSource = readSource(new URL('../src/lib/stores/tabs.svelte.ts', import.meta.url));

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

	/* ------------------------------------------------------------- the wiring */

	test('opening a document applies the choice, split through the same door the toggle uses', () => {
		assert.match(sessionSource, /tab\.isEditing = settings\.openFileMode === 'editor'/);
		assert.match(
			sessionSource,
			/if \(settings\.openFileMode === 'split'\) tabManager\.setSplitEnabled\(tab\.id, true\)/,
		);
		// The premise of point 1 above: a fresh tab has sync off, and
		// `setSplitEnabled` is the only place the preference is applied.
		assert.match(tabsSource, /isScrollSynced: false/);
		assert.match(
			tabsSource,
			/setSplitEnabled\(id: string, enabled: boolean\)[\s\S]{0,200}?tab\.isScrollSynced = this\.splitScrollSyncPreference/,
		);
	});

	test('the choice is applied before the load decides how much of the file to read', () => {
		const applied = sessionSource.indexOf("if (settings.openFileMode === 'split')");
		const read = sessionSource.indexOf('const initialIsSplit = tab?.isSplit ?? false');
		const fullRead = sessionSource.indexOf('if (initialIsEditing || initialIsSplit)');

		assert.ok(applied > 0 && read > 0 && fullRead > 0);
		assert.ok(
			applied < read && read < fullRead,
			'a document opening into an editable mode must take the full-read branch, ' +
				'or the editor is bound to the 50KB preview slice',
		);
	});

	test('it applies to a newly opened document only', () => {
		// Not to a reload that is preserving the mode, and not to a file already
		// open in a tab — reopening a document must not flip the mode the reader
		// chose for it. The same guard the checkbox always had.
		assert.match(sessionSource, /if \(tab && !loadOptions\.preserveEditState && !existing\) \{/);
	});

	test('a new empty document keeps its own preference', () => {
		// `Ctrl+N` asks a different question — what an empty buffer opens as — and
		// answers it with `newFileDefaultMode`. This change must not annex it.
		assert.match(tabsSource, /isEditing: settings\.newFileDefaultMode/);
	});

	test('the setting is one control, defaulting to preview', () => {
		assert.match(settingsSource, /openFileMode = \$state<OpenFileMode>\(DEFAULT_OPEN_FILE_MODE\)/);
		assert.equal(DEFAULT_OPEN_FILE_MODE, 'preview');
		assert.match(settingsComponentSource, /<select id="files-open-file-mode" bind:value=\{settings\.openFileMode\}>/);
		for (const value of ['preview', 'editor', 'split']) {
			assert.match(settingsComponentSource, new RegExp(`<option value="${value}">`));
		}
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
	// ---------------------------------------------------------- the status bar
	//
	// Detection without an indicator is worse than no detection: a GBK document
	// now opens, reads correctly and saves back as GBK, and the slot that is
	// supposed to name the encoding was still rendering the literal `UTF-8` it
	// had rendered since before Markpad could open the file at all. The one place
	// the user could have caught a misdetection was asserting the opposite.
	//
	// This is the same defect #540 fixed one slot to the left, where the line
	// ending was hardcoded `CRLF`.

	test('the status bar names the encoding the document was decoded from', () => {
		const editor = readSource('src/lib/components/Editor.svelte');
		const statusBar = sliceBetween(editor, '<div class="status-bar">', '</div>\n{/if}');

		assert.match(statusBar, /<div class="status-item">\{encoding\}<\/div>/, 'the slot shows the state');
		assert.doesNotMatch(editor, /editor\.status\.utf8/, 'the hardcoded UTF-8 string is gone');

		// Off the tab, not off Monaco: the encoding belongs to the file the buffer
		// was decoded from, and the store is what carries it through a save.
		assert.match(
			editor,
			/let encoding = \$derived\(tabManager\.activeTab\?\.encoding \?\? 'UTF-8'\)/,
			'and it is read from the tab rather than kept as a synced copy',
		);
	});

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

	test('the code is turned into the translation, and only that code is', () => {
		const session = readSource('src/lib/sessions/documentSession.svelte.ts');
		const describe = functionSource(session, 'describeSaveFailure');

		assert.match(describe, /toast\.encodingUnmappable/);
		assert.match(describe, /replace\('\{\{encoding\}\}', tab\.encoding\)/,
			'the encoding comes off the tab, not back out of the error');
		assert.match(describe, /return \{ message: 'Failed to save file', detail: error \}/,
			'an I/O failure still reads as one, OS message and all');

		// `onError` renders `${message}: ${detail}`, so returning the raw error as
		// the detail printed the code the user was never meant to see:
		//   …请用"另存为"写入一份 UTF-8 副本: ENCODING_UNMAPPABLE:GBK
		// The translated branch sends the document's path instead, which is what
		// `toast.lossySaveBlocked` has always done.
		assert.match(describe, /detail: tab\.path,/, 'the marker never reaches the toast');
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

	test('turning Live Mode on does not reload', () => {
		// Enabling reload is not a request to discard the buffer, and this was
		// the one loadMarkdown call in the app with no canCloseTab in front of it.
		//
		// An absence claim on a one-line toggle. lint-candidate: no-restricted-syntax
		// on `CallExpression[callee.name='loadMarkdown']` inside
		// `FunctionDeclaration[id.name='toggleLiveMode']`.
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
		// An absence claim: the view toggles live in `sessions/viewMode`, which
		// is not handed Live Mode at all. lint-candidate: no-restricted-syntax on
		// `liveMode` / `toggleLiveMode` identifiers in that module.
		const viewMode = readSource('src/lib/sessions/viewMode.svelte.ts');
		assert.doesNotMatch(viewMode, /toggleLiveMode|liveMode/);
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

	test('the diff view owns its models and never edits the document', () => {
		// Handing it the tab's live model would put a second editor on a buffer
		// Editor.svelte owns, and a read-only view of a document is not a place to
		// change it from.
		const overlay = readSource('src/lib/components/DiffOverlay.svelte');
		assert.match(overlay, /createModel\(/);
		assert.match(overlay, /readOnly: true/);
		assert.match(overlay, /originalEditable: false/);
		// Every model it creates is disposed, or opening the view repeatedly leaks
		// one document's worth of text each time.
		assert.match(overlay, /for \(const model of models\) model\.dispose\(\)/);
	});
});

describe('large file load revision', () => {
	const sessionPath = 'src/lib/sessions/documentSession.svelte.ts';
	const session = existsSync(sessionPath) ? readSource(sessionPath) : '';

	test('large-file completion requires the current clean load revision and unchanged view mode', () => {
		// The revision, the path and the untouched buffer are `claimTabForRead`'s
		// test; the view mode is the completion's own.
		assert.match(session, /const mayApplyFull = claimTabForRead\(activeId\);/);
		assert.match(
			session,
			/mayApplyFull\(\) && targetTab\?\.isEditing === initialIsEditing && targetTab\?\.isSplit === initialIsSplit/,
		);
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
	// nearby state. The two revert commands (Reload on the conflict bar, Reload
	// from disk) declare it; `documents.conflicts.spec.ts` runs both. Anything
	// else that starts passing this flag is a caller claiming the user chose to
	// lose work.
	test('nothing else in the viewer asks to discard a buffer', () => {
		assert.equal(viewer.match(/discardUnsavedBuffer: true/g), null);
		const saves = readSource('src/lib/sessions/externalChange.svelte.ts');
		assert.equal(saves.match(/discardUnsavedBuffer: true/g)?.length, 2);
	});
});

describe('truncated buffer guard', () => {
	const viewer = readSource('src/lib/MarkdownViewer.svelte');

	// --- wiring that cannot be executed outside a Svelte runtime ---

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

	const sessionSource = readSource('src/lib/sessions/documentSession.svelte.ts');

	test('it is marked before anything can be awaited', () => {
		// The render effect arms its 16ms timer the moment the buffer changes and
		// checks the field BEFORE that — so marking after an `await` would be too
		// late to prevent the render it has already scheduled.
		const fn = sliceBetween(sessionSource, 'async function toggleTaskCheckbox(', '\n\tasync function ');
		const marked = fn.indexOf('tab.previewedRawContent = updated;');
		const awaited = fn.indexOf('await saveContent');
		assert.ok(marked > 0, 'the toggle marks the preview');
		assert.ok(marked < awaited, 'marked before the first await after the write');
	});
});
