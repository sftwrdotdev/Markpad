import assert from 'node:assert/strict';
import test from 'node:test';

import { readSource, sliceFrom } from './sourceTree.js';

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
