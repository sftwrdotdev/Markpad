import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { LIST_MARKER, TASK_BOX } from '../src/lib/utils/listSyntax.js';
import { MARKDOWN_LINK_EXTENSIONS } from '../src/lib/utils/markdownLinks.js';
import {
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
 * assertions look. It is `documents.load.spec.ts` now. `documents.checks.test.ts`
 * and `documents.save.spec.ts` cover the store behaviour these source
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
// written back as itself — `documents.save.spec.ts` drives that.
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

	test('the refusal names Save As, the only exit', () => {
		// i18n wording. That the session raises this message once per tab is
		// driven in documents.session.spec.ts.
		const i18n = readDictionarySource();
		assert.match(i18n, /lossySaveBlocked: 'Not saved: parts of this file could not be read in any encoding/);
		assert.match(i18n, /use "Save As" to write a copy/);
	});
});

describe('live mode watched path', () => {
	const runtime = readSource('src-tauri/src/window_runtime.rs');
	const viewer = readSource('src/lib/MarkdownViewer.svelte');

	test('a watcher notification is routed to its watched path', () => {
		// The event name across Rust and TypeScript. What the viewer does with the
		// event runs in documents.conflicts.spec.ts (handleFileChanged).
		assert.match(runtime, /FileChanged\(watched_path\.clone\(\)\)\.emit_to\(&handle, event_label\.as_str\(\)\)/);
		assert.match(viewer, /await appWindow\.listen\('file-changed', \(event\) => externalChange\.handleFileChanged\(event\.payload as string, liveMode\)\)/);
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

		// The list itself runs in documents.test.ts. What stays is that the viewer's
		// Open dialog uses it: a literal list is how the two drifted apart.
		assert.match(viewer, /filters: MARKDOWN_OPEN_FILTERS,/);
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

	test('the unsupported-drop toast names the file with toast.unsupportedFile', () => {
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
	test('no call site takes the cancel duty back from saveContent', () => {
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
	});
});

describe('external change reload', () => {
	const viewer = readSource('src/lib/MarkdownViewer.svelte');

	// --- wiring that cannot be executed outside a Svelte runtime ---

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
});

describe('reopening a dirty document', () => {
	// Cwd-relative, not `import.meta.url`: see the note on `readSource`.
	const viewer = readSource('src/lib/MarkdownViewer.svelte');

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

describe('task toggle line endings', () => {
	test('the marker grammar the renderer reads still matches listSyntax.ts', () => {
		// The last cross-language copy of this vocabulary. The rewrite above only
		// gets a chance to run on lines the *renderer* turned into a task item, and
		// `TASK_SOURCE_RE` is what decides that — so a marker one side accepts and
		// the other does not is a checkbox that draws and then refuses to toggle.
		// Every TypeScript reader imports the fragments from utils/listSyntax.ts
		// (pinned by release.checks.test.ts); Rust cannot, so the
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
