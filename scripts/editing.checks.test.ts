import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { readSource, sliceFrom } from './sourceTree.js';

/*
 * Issue #604: Enter, Tab and Shift+Tab on list items and tables. The handlers
 * and the `when` clauses the app binds them behind run in editing.test.ts.
 * What is left here is the installed Monaco's own Shift+Tab command.
 */
describe('list keys in the editor', () => {
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
