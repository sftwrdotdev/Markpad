import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { readRustBackend, readSource, sliceFrom } from './sourceTree.js';
import { hasMarkdownLinkExtension, MARKDOWN_LINK_EXTENSIONS } from '../src/lib/utils/markdownLinks.js';

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

	test('all three Copy Reference entries call the one helper', () => {
		// The preview's heading menu, the outline's right-click, and the outline's
		// context menu. All three built the string inline before, which is how they
		// came to disagree about the filename in the first place. What the helper
		// writes runs in editing.test.ts ("copy reference wiring"); this pins
		// that there is no second builder.
		assert.equal((viewerSource.match(/copyHeadingReference\(/g) ?? []).length, 4, 'one helper, three callers');
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
