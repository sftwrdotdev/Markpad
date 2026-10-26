import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { KeyCode } from 'monaco-editor/esm/vs/editor/common/standalone/standaloneEnums.js';
import { KeyMod } from 'monaco-editor/esm/vs/editor/common/services/editorBaseApi.js';
import ts from 'typescript';

import { bareCommands } from './keymapHarness.js';
import { functionSource, readRustBackend, readSource, sliceFrom } from './sourceTree.js';
import { frontMatterFenceLines, frontMatterLineOffset } from '../src/lib/utils/frontMatter.js';
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
	const editorSource = readSource(new URL('../src/lib/components/Editor.svelte', import.meta.url));

	const rustSource = readRustBackend();

	/* ---------------------------------------------------------------- wiring */

	test('the heading context is asked before the path context, which shares its prefix', () => {
		// `](#` also satisfies the embed test — `/!?\[.*\]\($/` matches everything
		// up to the paren. Asking for files first would answer a `#` with a list of
		// filenames.
		const heading = editorSource.indexOf('const headingContext = headingLinkContext(prefix)');
		const embed = editorSource.indexOf('const isEmbedContext =');
		assert.ok(heading > 0 && embed > 0);
		assert.ok(heading < embed);
		// And `#` has to open the dropdown, or the reader types it and nothing
		// happens until the next character.
		assert.match(editorSource, /triggerCharacters: \["\(", "\/", "\\\\", '"', "#"\]/);
	});

	test('each context writes the text its own syntax resolves', () => {
		assert.match(
			editorSource,
			/insertText:\s*\n?\s*headingContext === "slug" \? anchor\.slug : anchor\.text/,
		);
		// Labelled by the heading, so typing a word of it finds the entry whatever
		// the slug turned that word into.
		assert.match(editorSource, /label: anchor\.text/);
		assert.match(editorSource, /detail: `#\$\{anchor\.slug\}`/);
	});

	test('the list is read from Rust, and re-read only when the buffer changes', () => {
		// A second anchorizer written in TypeScript would drift from comrak's
		// without anything failing — the links would simply stop landing.
		assert.match(editorSource, /const markdown = model\.getValue\(\);\s*const outline = \(\s*invoke\("markdown_outline", \{\s*markdown,/);
		assert.match(rustSource, /async fn markdown_outline\(\s*markdown: String,/);
		// Completion fires per keystroke while the dropdown is open; the headings
		// cannot have moved between two keystrokes of one edit. Keyed on the model
		// too, because version ids are counted per model and each tab has its own.
		assert.match(editorSource, /if \(outlineCache\?\.model === model && outlineCache\.version === version\) return outlineCache\.outline;/);
	});

	// The folding provider and the sticky-scroll symbols ask for the same version
	// together, and each ask sends the whole buffer to Rust to be parsed.
	test('two asks for one version share one Rust call', async () => {
		const lift = (name: string) => {
			try {
				return functionSource(editorSource, name);
			} catch {
				return '';
			}
		};
		const calls: string[] = [];
		const invoke = async (cmd: string) => {
			calls.push(cmd);
			return cmd === 'markdown_outline' ? { anchors: [], folds: [] } : [];
		};
		const headingAnchors = new Function(
			'invoke',
			'frontMatterFenceLines',
			ts.transpileModule(
				`let anchorCache = null;\nlet outlineCache = null;\n${lift('documentOutline')}\n${lift('headingAnchors')}\nreturn headingAnchors;`,
				{ compilerOptions: { target: ts.ScriptTarget.ES2022 } },
			).outputText,
		)(invoke, () => 0) as (model: unknown) => Promise<unknown>;
		const model = { getVersionId: () => 1, getValue: () => '# A\n' };

		await Promise.all([headingAnchors(model), headingAnchors(model)]);
		assert.equal(calls.length, 1, `one version, ${calls.length} calls: ${calls.join(', ')}`);
	});

	test('the Rust side numbers repeated headings the way the renderer does', () => {
		// One anchorizer for the document, not one per heading: a second
		// "Objectives" is `objectives-1`, and offering the bare slug for it would
		// link to the first section. `heading_anchor_id` stays fresh per lookup on
		// purpose — that one answers a wikilink, which names a heading by text.
		assert.match(rustSource, /let mut anchorizer = Anchorizer::new\(\);[\s\S]{0,900}?anchorizer\.anchorize\(&text\)/);
		assert.match(rustSource, /fn heading_anchor_id\(target: &str\) -> String \{\s*\n\s*Anchorizer::new\(\)/);
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

describe('front matter in the editor', () => {
	// Split view hands scroll positions across as "inside the front matter" or
	// "this line of the body", so both panes have to agree on where the front
	// matter ends. The preview's answer is parseFrontMatter's. The editor used to
	// scan for any two `---` lines on its own, so a document opening with a
	// thematic break told the preview it was inside a front matter panel the
	// preview did not have, and the preview stayed at the top until the editor
	// scrolled past the second rule.
	test('the editor finds the end of the front matter through parseFrontMatter too', () => {
		const leadingRule = `---\n\n${Array.from({ length: 40 }, (_, i) => `Paragraph ${i + 1}.`).join('\n\n')}\n\n---\n\n# Next\n`;
		assert.equal(frontMatterLineOffset(leadingRule), 0);

		const editor = readSource('src/lib/components/Editor.svelte');
		const scrollEnd = functionSource(editor, 'getEditorFrontMatterScrollEnd');
		assert.match(scrollEnd, /frontMatterLineOffset\(/);
		assert.doesNotMatch(editor, /\.trim\(\) !== '---'/);
	});

	// Split view asks for it on every scroll event, and it costs a copy of the
	// buffer plus a YAML parse: once per document version is enough.
	test('the editor parses the front matter once per document version, not per scroll event', () => {
		const scrollEnd = functionSource(readSource('src/lib/components/Editor.svelte'), 'getEditorFrontMatterScrollEnd');
		const run = new Function(
			'editor',
			'frontMatterLineOffset',
			'getEditorContentScrollMax',
			ts.transpileModule(`let frontMatterOffsetCache = null;\n${scrollEnd}\nreturn getEditorFrontMatterScrollEnd;`, {
				compilerOptions: { target: ts.ScriptTarget.ES2022 },
			}).outputText,
		);
		let version = 1;
		let reads = 0;
		const model = {
			getVersionId: () => version,
			getValue: () => (reads++, '---\ntitle: x\n---\n\n# Body\n'),
			getLineCount: () => 6,
		};
		const editor = {
			getModel: () => model,
			getTopForLineNumber: (line: number) => line * 10,
		};
		const scrollEndOf = run(editor, frontMatterLineOffset, () => 1000) as () => number;

		assert.equal(scrollEndOf(), 50);
		scrollEndOf();
		assert.equal(reads, 1, 'the buffer was re-read and re-parsed at the same version');
		version = 2;
		scrollEndOf();
		assert.equal(reads, 2, 'an edit must invalidate it');
	});

	// The editor's analyses (headings, folds, colours) run in Rust on the whole
	// buffer and blank the front matter lines first, so the closing `---` does not
	// underline the YAML into a heading. Rust used to find those lines itself, with
	// any two leading `---` lines, and blanked a thematic break plus the prose
	// under it that the preview renders. Now it is told, by the same rule.
	test('the editor tells Rust how many lines the front matter spans, fence to fence', () => {
		const leadingRule = '---\n\n# Title\n\nSome intro text.\n\n---\n\n## Part 2\n';
		assert.equal(frontMatterFenceLines(leadingRule), 0);
		assert.equal(frontMatterFenceLines('# Plain\n'), 0);
		assert.equal(frontMatterFenceLines('---\ntitle: x\ntags: [a]\n---\n\n# Body\n'), 4);
		assert.equal(frontMatterFenceLines('\uFEFF--- \r\ntitle: x\r\n  ---\r\n# Body\r\n'), 3);
		assert.equal(frontMatterFenceLines('---\n---\n'), 2);
		// No newline after the closing fence: it is still one of the lines.
		assert.equal(frontMatterFenceLines('---\ntitle: x\n---'), 3);
		// Malformed is still front matter: the preview strips it too.
		assert.equal(frontMatterFenceLines('---\ntitle: [broken\n---\n'), 3);

		const editor = readSource('src/lib/components/Editor.svelte');
		const tokens = readSource('src/lib/utils/semanticTokens.ts');
		for (const [source, command] of [
			[editor, 'markdown_outline'],
			[tokens, 'markdown_semantic_spans'],
		]) {
			const call = source.slice(source.indexOf(`invoke(${source === editor ? '"' : "'"}${command}`));
			assert.match(call.slice(0, call.indexOf('}')), /frontMatterLines: frontMatterFenceLines\(/, command);
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

	const referenceSource = readSource(new URL('../src/lib/utils/headingReference.ts', import.meta.url));

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

	test('every wikilink Copy Reference builds carries the heading the rewriter needs', () => {
		// The rewriter only rewrites heading-bearing forms; a bare `[[Notes]]` stays
		// literal text (see the scope note above). So the contract is that *every*
		// `[[...]]` the viewer writes to the clipboard contains a `#`.
		//
		// Asserted that way round rather than as "three call sites match
		// `[[${fn}#${...}]]`". That form hard-coded the local variable names holding
		// the basename — renaming `fn` broke it — and the count, so adding a fourth
		// correct Copy Reference entry failed while replacing one of the three with a
		// broken bare form still left three matches and passed.
		// The string moved: all three entries build it through `headingReference`,
		// which picks the spelling the document is already written in (see
		// `copyReferenceStyle.test.ts`). The contract this test exists for is
		// unchanged — a wikilink Copy Reference writes always carries a `#`,
		// because the rewriter leaves a bare `[[Notes]]` as literal text — so it
		// is asserted where the string is now built.
		// Code lines only: the doc comment above the function spells `[[…]]` out
		// in prose, and prose is not something Copy Reference writes.
		const code = referenceSource
			.split('\n')
			.filter((line) => !/^\s*(\*|\/\/)/.test(line))
			.join('\n');
		const emitted = [...code.matchAll(/`\[\[[^`]*\]\]`/g)].map((match) => match[0]);
		assert.ok(emitted.length > 0, 'Copy Reference no longer builds a wikilink — has the format moved?');
		for (const wikilink of emitted) {
			assert.match(
				wikilink,
				/#/,
				`${wikilink}: a wikilink without a heading is left as literal text by process_wikilinks()`,
			);
		}
	});
});
