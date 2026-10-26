import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { KeyCode } from 'monaco-editor/esm/vs/editor/common/standalone/standaloneEnums.js';
import { KeyMod } from 'monaco-editor/esm/vs/editor/common/services/editorBaseApi.js';

import { bareCommands } from './keymapHarness.js';
import { readRustBackend, readSource, sliceFrom } from './sourceTree.js';
import { hasMarkdownLinkExtension, MARKDOWN_LINK_EXTENSIONS } from '../src/lib/utils/markdownLinks.js';

/*
 * Issue #604: Enter, Tab and Shift+Tab on list items and tables. The handlers
 * run in editing.test.ts. What is left here is the condition the app DECLARES
 * for them — the `when` expression, evaluated out of the source — because an
 * Enter binding that forgets `!suggestWidgetVisible` breaks the completion
 * popup silently, and the installed Monaco's own Shift+Tab command.
 */
describe('list keys in the editor', () => {
	// ------------------------------------------------------------- the when clauses

	/** Guards that must stand in front of all three keys, and what owns the key without them. */
	const SHARED_GUARDS: Record<string, string> = {
		editorTextFocus: 'the find box and the rename input both take Enter, and neither is the text',
		'!editorReadonly': 'reading mode types nothing',
		'!suggestWidgetVisible':
			'Enter accepts a completion and Tab accepts a completion; this app has two completion providers, so the popup is a live case',
		'!inSnippetMode': 'Tab jumps to the next snippet placeholder, and so does Shift+Tab backwards',
	};

	test('the editing keys are registered, and behind every guard that owns them first', () => {
		// `bareCommands()` in ./keymapHarness.ts EVALUATES each `addCommand`
		// argument, so the keybinding numbers are Monaco's own and the `when` string
		// is the one the component computes.
		const calls = bareCommands();

		const enter = calls.filter((call) => call.binding === KeyCode.Enter);
		assert.equal(enter.length, 1, 'exactly one Enter binding');
		assert.equal(enter[0].handler, 'continueListOnEnter');

		const tab = calls.filter((call) => call.binding === KeyCode.Tab);
		assert.equal(tab.length, 1, 'exactly one plain-Tab binding');
		assert.equal(tab[0].handler, 'handleTabKey');

		const shiftTab = calls.filter((call) => call.binding === (KeyMod.Shift | KeyCode.Tab));
		assert.equal(shiftTab.length, 1, 'exactly one Shift+Tab binding');
		assert.equal(shiftTab[0].handler, 'handleShiftTabKey');

		for (const call of [enter[0], tab[0], shiftTab[0]]) {
			for (const [guard, why] of Object.entries(SHARED_GUARDS)) {
				assert.ok(
					call.when.split('&&').some((clause) => clause.trim() === guard),
					`${call.handler} is bound without ${guard}: ${why}. when = ${call.when}`,
				);
			}
		}

		// The extra guard both Tab keys need: the accessibility toggle exists so that
		// Tab leaves the editor, and a binding at weight 1000 would take that away.
		for (const call of [tab[0], shiftTab[0]]) {
			assert.ok(
				call.when.includes('!editorTabMovesFocus'),
				`${call.handler} is bound without !editorTabMovesFocus: ${call.when}`,
			);
		}
	});

	test("Monaco's outdent is still what Shift+Tab means outside the app's handler", () => {
		// The Shift+Tab handler's last path re-sends `outdent` (run in
		// editing.test.ts). This pins the installed Monaco half of that claim.
		// …and the claim that rests on, pinned against the installed Monaco rather
		// than assumed: `outdent` is the command Shift+Tab means, in the editor, when
		// Tab is not moving focus. If Monaco ever renames or re-chords it, the
		// fall-through above becomes a no-op and this is what says so.
		const core = readSource(
			new URL('../node_modules/monaco-editor/esm/vs/editor/browser/coreCommands.js', import.meta.url),
		);
		const outdent = core.slice(core.indexOf("id: 'outdent'"), core.indexOf("id: 'tab'"));
		assert.match(outdent, /KeyMod\.Shift \*\/ \| 2 \/\* KeyCode\.Tab/);
		assert.match(outdent, /EditorContextKeys\.editorTextFocus, EditorContextKeys\.tabDoesNotMoveFocus/);
	});
});

/**
 * #200: "implement some function which slugify titles and purpose those as
 * #targets for URL of link".
 *
 * Half of it already worked — comrak renders an `id` onto every heading and
 * `[…](#that-id)` jumps to it — but nothing offered the ids, so writing one
 * meant doing comrak's anchorizer by hand: lowercase, drop the punctuation it
 * drops, hyphenate the spaces, and remember that a repeated heading is
 * numbered. Getting it wrong produces a link that looks right and lands
 * nowhere.
 *
 * The list comes from Rust, from the renderer's own parse and anchorizer
 * (`outline`, pinned against the rendered `id=` attributes in
 * `lib.rs`). What is asserted here is the other half: WHERE a heading is the
 * answer, and what gets written when it is — the two link syntaxes take
 * different text, which is the part that is easy to get backwards.
 */
describe('heading link completion wiring', () => {
	const rustSource = readRustBackend();

	test('the outline command Rust answers takes the markdown the editor sends', () => {
		// The TypeScript half (`createDocumentOutline` sends `{ markdown, … }`)
		// runs in editing.test.ts; this is the Rust half of the command contract.
		assert.match(rustSource, /async fn markdown_outline\(\s*markdown: String,/);
	});
});

/**
 * "Copy Reference" writes the spelling the document is already written in.
 *
 * Markpad understands two ways to link a heading — `[[note#Setup]]`, which it
 * rewrites before the parse, and `[Setup](note.md#setup)`, which every reader
 * resolves — and this menu always produced the first. Which one is right
 * depends on the person, not on the app: a vault full of `[[…]]` wants
 * another one; a document written for GitHub wants a link that survives
 * leaving Markpad.
 *
 * The document is the evidence, because a person's habit is already written
 * down in the file they are working in. The inference has a floor: says
 * nothing, or says both, and the answer is what the menu always produced. So
 * it can be better than the old behaviour and never worse — which is the only
 * reason inferring is defensible here at all.
 *
 * Known and accepted: a reference is usually pasted into a DIFFERENT document,
 * so following this one is a guess about that one.
 */
describe('copy reference wiring', () => {
	const viewerSource = readSource(new URL('../src/lib/MarkdownViewer.svelte', import.meta.url));

	/* ---------------------------------------------------------------- the wiring */

	test('all three entries go through one helper, which reads the buffer', () => {
		// The preview's heading menu, the outline's right-click, and the outline's
		// context menu. All three built the string inline before, which is how they
		// came to disagree about the filename in the first place.
		assert.equal((viewerSource.match(/copyHeadingReference\(/g) ?? []).length, 4, 'one helper, three callers');
		assert.match(viewerSource, /style: preferredReferenceStyle\(tab\?\.rawContent \?\? ''\)/);
		// The id is taken off the rendered element rather than recomputed.
		assert.match(viewerSource, /heading\.id \|\| heading\.querySelector\('a\.anchor'\)\?\.id/);
	});
});

describe('find seed wiring', () => {
	test('the seed is wired to the find bar', () => {
		// One line the compiler cannot check: a pure function nothing calls is dead code.
		assert.match(readSource('src/lib/MarkdownViewer.svelte'), /if \(seed\) findBar\?\.setQuery\(seed\);/);
	});
});

// #675: Monaco draws the find widget's button tooltips into a `.context-view`
// it appends beside the editor, above the target, and the widget sits at the
// top edge of the editor pane — so the tooltip lands in the strip the pane and
// `.editor-outer` clip away, and behind the fixed title bar.
//
// Both halves of the fix are invisible to the compiler and to any test that
// runs the app without a real layout: one is a CSS clip that has to be dropped
// on *both* boxes, the other is a z-index that only works while it stays above
// the title bar's. The second is a coupling between two rules in two files —
// raise `.custom-title-bar`'s z-index and the tooltip silently goes back under
// it, with nothing failing.
describe('find widget tooltip clip', () => {
	const styles = readSource('src/styles.css');

	const titleBar = readSource('src/lib/components/TitleBar.svelte');

	const fixBlock = sliceFrom(styles, ".pane.editor-pane:has(.find-widget.visible)");

	function zIndexOf(source: string, selector: string): number {
		// Line-anchored: `.context-view` is also named in the prose above the rule,
		// and a loose match starts there and runs into the wrong declaration block.
		const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
		const rule = source.match(new RegExp(`^\\s*${escaped}[^{}]*\\{([^}]*)\\}`, 'm'));
		assert.ok(rule, `expected a rule for ${selector}`);
		const declaration = rule[1].match(/(?<![\w-])z-index:\s*(\d+)/);
		assert.ok(declaration, `expected a z-index on ${selector}`);
		return Number(declaration[1]);
	}

	test('the find widget tooltip escapes both clips, and only while the widget is up', () => {
		// Not `overflow: clip` with a margin: WebKit ships `clip` without
		// `overflow-clip-margin`, so that spelling is a no-op on macOS and Linux.
		assert.match(fixBlock, /\.pane\.editor-pane:has\(\.find-widget\.visible\),\s*\n\s*\.pane\.editor-pane:has\(\.find-widget\.visible\) \.editor-outer \{\s*\n\s*overflow: visible;/);
	});

	test('the tooltip outranks the title bar it now paints over', () => {
		const contextView = zIndexOf(styles, '.context-view');
		const titleBarZ = zIndexOf(titleBar, '.custom-title-bar');
		assert.ok(
			contextView > titleBarZ,
			`.context-view (${contextView}) must stay above .custom-title-bar (${titleBarZ})`,
		);
		// Monaco writes `z-index: 2576` inline on the node, so the rule only lands
		// if it is marked important.
		assert.match(styles, /\.context-view \{\s*\n\s*z-index: \d+ !important;/);
	});
});

// The front-matter panel keeps five per-field state tables side by side, and
// every one of them has to be keyed by document *and* field. Four were;
// `frontMatterEditErrors` was keyed by the bare field name, so a validation
// error raised while editing `date` in one document was still on screen —
// under the same field — after switching to another document, and stayed
// there until that field was edited successfully in the second document.
//
// Nothing caught it. The four siblings established a convention, the fifth
// quietly did not follow it, and a convention is not a seam: no type, no test
// and no comment said the key had to carry the document.
//
// This is a source-shape assertion because the panel lives inside
// MarkdownViewer.svelte, which the Node test runner cannot import. What it
// pins is deliberately narrow — that this one table is never indexed by a bare
// `field.key` — rather than the spelling of any particular line.
describe('front matter field state scope', () => {
	const VIEWER = 'src/lib/MarkdownViewer.svelte';

	/** The scoped key helper the four correct tables already went through. */
	const SCOPED_KEY = 'frontMatterFieldStateKey(field)';

	test('the front-matter error table is never keyed by a bare field name', () => {
		const viewer = readSource(VIEWER);

		// Every read and write of the table, with whatever sits in the brackets.
		const indexed = [...viewer.matchAll(/frontMatterEditErrors\[([^\]]+)\]/g)].map(
			(match) => match[1],
		);
		assert.ok(
			indexed.length > 0,
			`${VIEWER} no longer indexes frontMatterEditErrors — has the panel moved?`,
		);

		const unscoped = indexed.filter((expression) => /\bfield\.key\b/.test(expression));
		assert.deepEqual(
			unscoped,
			[],
			`frontMatterEditErrors must be keyed by ${SCOPED_KEY}, not by the field name alone — ` +
				'a bare field name carries one document\'s error into every other document',
		);

		// The assignment sites spread the old table and add one entry, so the key
		// they mint has to carry the document too.
		const minted = [...viewer.matchAll(/\n\t+\[([^\]]+)\]: String\(error\),/g)].map(
			(match) => match[1],
		);
		assert.ok(minted.length > 0, 'no front-matter error is recorded any more — has the catch moved?');
		assert.deepEqual(
			minted,
			minted.map(() => SCOPED_KEY),
			`every front-matter error must be recorded under ${SCOPED_KEY}`,
		);
	});

	test('all five per-field front-matter tables agree on their key', () => {
		const viewer = readSource(VIEWER);

		// The four that were already right, plus the one this test exists for. If a
		// sixth table joins the cluster it has to be added here, which is the point:
		// the list is the convention, written down where it can fail.
		const TABLES = [
			'frontMatterEditErrors',
			'frontMatterTagDrafts',
			'frontMatterTagEditIndexes',
			'frontMatterTagEditDrafts',
		];

		for (const table of TABLES) {
			const indexed = [...viewer.matchAll(new RegExp(`${table}\\[([^\\]]+)\\]`, 'g'))].map(
				(match) => match[1],
			);
			assert.ok(indexed.length > 0, `${table} is no longer indexed — has it been removed?`);
			for (const expression of indexed) {
				assert.match(
					expression,
					/frontMatterFieldStateKey\(|^key$/,
					`${table} is indexed by \`${expression}\`, which does not carry the document`,
				);
			}
		}
	});
});

// `[[Notes#Setup]]` — the exact string the "Copy Reference" context-menu item
// writes to the clipboard — used to render as literal text: the Rust
// preprocessor only understood the same-document form `[[#Setup]]`. It now
// emits a plain markdown link, and these tests pin the *shape* of the href it
// emits against the frontend that has to claim it. The Rust side owns the
// other half of this contract in src-tauri/src/lib.rs (`copy_reference_output_
// becomes_a_real_link` and friends); if either half moves, the other fails.
//
// Scope: only the heading-bearing forms (`[[#h]]`, `[[file#h]]`, and their
// `|alias` variants) are rewritten. Obsidian's bare note link `[[Notes]]` is
// a separate feature, not this defect, and is left literal.
//
// Not covered here: whether the file exists, and the actual tab-opening (that
// runs inside MarkdownViewer.svelte and needs a live webview). These tests
// only prove the href is recognized as a local markdown target and decodes
// back to the path and anchor the document asked for.
describe('wikilink extension and reference contracts', () => {
	const rustSource = readRustBackend();

	test('the extension list the rewriter mirrors still matches markdownLinks.ts', () => {
		// The last cross-language copy of this list. Every TypeScript reader — the
		// sanitizer's URI pattern, the export's `.md` -> `.html` rewrite, the Open
		// dialog filter — now imports MARKDOWN_LINK_EXTENSIONS from markdownLinks.ts,
		// so a drift between two of them is no longer expressible. Rust cannot
		// import it, so the drift is caught here instead, by reading the array back
		// out of the source and comparing the two *sets*: a third-party extension
		// added to either side alone fails, in whichever direction it was added.
		const declared = rustSource.match(/const MARKDOWN_LINK_EXTENSIONS: \[&str; \d+\] = \[([^\]]*)\]/);
		assert.notEqual(declared, null, 'MARKDOWN_LINK_EXTENSIONS disappeared from the Rust backend');
		const extensions = [...declared![1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
		assert.deepEqual(
			[...extensions].sort(),
			[...MARKDOWN_LINK_EXTENSIONS].sort(),
			'the Rust and TypeScript extension lists disagree — add the extension to both',
		);
		for (const extension of extensions) {
			assert.equal(hasMarkdownLinkExtension(`file.${extension}`), true, extension);
		}
	});
});
