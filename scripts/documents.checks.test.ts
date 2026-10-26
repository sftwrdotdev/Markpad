import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { readSource, sliceBetween } from './sourceTree.js';

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

describe('live mode watched path', () => {
	const viewer = readSource('src/lib/MarkdownViewer.svelte');

	test('toggling Live Mode does not reload the document', () => {
		// The watcher half of this case is driven in documents.session.spec.ts
		// (fileWatch.svelte.ts). The toggle is one assignment inside the viewer.
		const toggleLiveMode = sliceBetween(viewer, 'function toggleLiveMode', 'async function saveImageAs');
		assert.doesNotMatch(toggleLiveMode, /loadMarkdown\(/);
	});
});

describe('file associations', () => {
	// The other half of the policy in documents.test.ts "installer associates
	// every Markdown extension except txt". Claiming `.txt` in the installer takes
	// the Text Document association away from Notepad (#179), but Markpad does
	// open, render and save `.txt` like any other note, so the Open dialog has to
	// offer them.
	test('the Open dialog offers every extension Markpad treats as a document', () => {
		const viewer = readSource('src/lib/MarkdownViewer.svelte');

		// The list itself runs in documents.test.ts. What stays is that the viewer's
		// Open dialog uses it: a literal list is how the two drifted apart.
		assert.match(viewer, /filters: MARKDOWN_OPEN_FILTERS,/);
		assert.doesNotMatch(viewer, /extensions: \['md/);
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

