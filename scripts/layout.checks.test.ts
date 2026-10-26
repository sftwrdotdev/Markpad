import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { asBufferLine, tabAnchorForEditorTopLine } from '../src/lib/utils/lineCoordinates.js';
import { splitRatioAfterMove } from '../src/lib/utils/splitPanes.ts';
import { sourceLineOf } from '../src/lib/utils/tocFollow.js';
import { callbackBodies, functionSource, readSource, sliceBetween } from './sourceTree.js';

describe('scroll sync input', () => {
	// The effect is identified by what it does — it is the one that reads
	// `onscrollsync` — not by where its text starts and stops.
	//
	// It used to be sliced between `'&& onscrollsync)'` and `'\n\t$effect(() => {'`,
	// and both halves of that were the same kind of fragile. The start anchor had
	// already drifted once, silently: the original marker spelled the whole guard
	// condition, the effect gained an `editorReady &&` term when Monaco moved behind
	// a dynamic import, and the slice became empty rather than failing — which is
	// what the shortened anchor and its `notEqual(-1)` were added for. The end
	// anchor never got that guard, and it depends on the *next* effect being
	// tab-indented and spelled `$effect(() => {`; write it any other way and this
	// file silently starts asserting about the rest of the component.
	const editor = readSource('src/lib/components/Editor.svelte');
	const syncEffects = callbackBodies(editor, '$effect').filter((body) => body.includes('onscrollsync'));
	assert.equal(syncEffects.length, 1, `expected exactly one $effect reading onscrollsync (got ${syncEffects.length})`);
	const syncEffect = syncEffects[0];

	test('typing does not initiate split scroll synchronization', () => {
		assert.match(syncEffect, /editor\.onDidScrollChange/);
		assert.doesNotMatch(syncEffect, /onDidChangeCursorPosition/);
	});
});

describe('split pane ratio', () => {
	test('the bounds are not re-stated here', () => {
		// `TabManager.setSplitRatio` clamps. A second copy of 0.1/0.9 in this
		// module would be the shape where the two answers drift apart.
		assert.equal(splitRatioAfterMove(0.9, 0.5, 'left'), 1.4);
		assert.equal(splitRatioAfterMove(0.1, -0.5, 'left'), -0.4);

		const source = readSource(new URL('../src/lib/utils/splitPanes.ts', import.meta.url));
		assert.equal(/Math\.(min|max)/.test(source), false);
	});

	test('both splitter routes take the direction from the same place', () => {
		// The failure this guards is a splitter that follows the pointer one way
		// and the arrow keys the other — invisible until someone swaps the panes.
		const viewer = readSource(new URL('../src/lib/MarkdownViewer.svelte', import.meta.url));

		const calls = viewer.match(/splitRatioAfterMove\(/g) ?? [];
		assert.equal(calls.length, 2, 'expected the drag and the arrow keys, and nothing else');

		// No route may reintroduce the sign itself.
		assert.equal(/splitEditorSide === 'left' \? /.test(viewer), false);
	});
});

describe('fold layout', () => {
	test('fold layout observes rendered content and publishes its measured height', () => {
		const source = readSource('src/lib/utils/foldLayout.ts');

		assert.match(source, /new ResizeObserver/);
		assert.match(source, /--fold-content-height/);
		assert.match(source, /requestAnimationFrame/);
	});

	test('fold wrapper animates an explicit measured height instead of a fractional grid track', () => {
		const styles = readSource('src/styles.css');
		const expandedRule = styles.match(/\.foldable-content-wrapper\s*\{([^}]*)\}/)?.[1] || '';

		assert.match(expandedRule, /height:\s*var\(--fold-content-height/);
		assert.doesNotMatch(expandedRule, /grid-template-rows:\s*1fr/);
		assert.match(styles, /foldable-content-wrapper\.is-collapsed[\s\S]*height:\s*0/);
	});

	// This assertion couples a TypeScript constant to a CSS duration in another file. Nothing else compares the two, and when
	// FindBar's re-aim timer fires before the height transition settles the scroll
	// lands on a target that is still moving — a defect that only shows up as "find
	// sometimes scrolls to the wrong place".
	test('the find-bar fold re-aim delay outlasts the CSS fold transition', () => {
		const findBar = readSource('src/lib/components/FindBar.svelte');
		const styles = readSource('src/styles.css');

		const declared = findBar.match(/const FOLD_TRANSITION_MS = (\d+);/);
		assert.ok(declared, 'FindBar.svelte must declare the delay it waits for the fold to settle');

		const expandedRule = styles.match(/\.foldable-content-wrapper\s*\{([^}]*)\}/)?.[1] || '';
		const transition = expandedRule.match(/transition:[^;]*?height\s+([\d.]+)s/);
		assert.ok(transition, 'styles.css must animate the fold wrapper height');

		assert.ok(
			Number(declared[1]) >= Number(transition[1]) * 1000,
			`FOLD_TRANSITION_MS (${declared[1]}ms) must outlast the ${transition[1]}s height transition`,
		);
	});

	// The direction the previous spelling could not state. `observeFoldLayout` used
	// to be handed `markdownBody`, and that was right while the article held one
	// document; it now holds one `.markdown-blocks` host per open tab, all but one
	// of them `display: none`. `updateFoldHeights` walks its root, measures each
	// wrapper with `getBoundingClientRect().height` — 0 for everything in a hidden
	// subtree — and writes what it measured into `--fold-content-height`, which
	// styles.css resolves to the wrapper's `height`. A walk rooted at the article
	// therefore collapses every fold of every background tab, and the reader sees
	// it a frame after switching back, because `scheduleUpdate` defers through
	// `requestAnimationFrame` and that runs in the step AFTER the ResizeObserver
	// delivery that would correct it.
	//
	// This cannot be a behaviour test: jsdom has no layout, so every rect is 0
	// whether or not the element is displayed, and the visible and the hidden case
	// are indistinguishable to it. The proposition is an absence — "nothing ever
	// measures from the article" — so it is pinned as one.
	test('fold measurement is rooted at the visible host, never at the article holding every tab', () => {
		const viewer = readSource('src/lib/MarkdownViewer.svelte');

		assert.doesNotMatch(
			viewer,
			/(?:observeFoldLayout\(|followFoldLayout\(\s*\w+\s*,\s*\(\)\s*=>)\s*markdownBody/,
			'observing the article would measure every hidden tab and write zero heights into it',
		);
	});
});

/**
 * #169: the outline highlights the heading you are reading, but only ever
 * answered to the PREVIEW.
 *
 * `Toc.svelte` decided by rendered box — `querySelector` each visible entry
 * out of the preview and measure it against the container, per entry, per
 * scroll event. That question has no answer while the editor is the pane being
 * scrolled: in editor-only mode the preview never scrolls, and in split view
 * it moves only while scroll sync is on. So the outline sat still exactly
 * where the reporter said it did.
 *
 * A SOURCE LINE is something both panes can produce — the editor sends one on
 * every scroll, and the preview already computes one for the tab's reading
 * position — so the rule is now one comparison over a list, fed by either.
 * That the two panes share it is the property worth having: in split view with
 * sync on both are live at once, and two rules could disagree as the panes
 * settle and flicker the highlight between two entries.
 */
describe('outline follows the editor', () => {
	const tocSource = readSource(new URL('../src/lib/components/Toc.svelte', import.meta.url));
	const viewerSource = readSource(new URL('../src/lib/MarkdownViewer.svelte', import.meta.url));
	const settingsSource = readSource(new URL('../src/lib/stores/settings.svelte.ts', import.meta.url));
	const settingsComponentSource = readSource(new URL('../src/lib/components/Settings.svelte', import.meta.url));

	/* --------------------------------------------------------------- wiring */

	test('the outline carries a source line for every entry it builds', () => {
		// Both kinds — headings and block anchors — or the mapping above is asked
		// about entries it cannot place.
		assert.match(tocSource, /isBlock: false, line: sourceLineOf\(h\.dataset\.sourcepos\)/);
		assert.match(tocSource, /isBlock: true, line: sourceLineOf\(el\.dataset\.sourcepos\)/);
		// The fingerprint decides whether a re-render replaces the items. An edit
		// that only moves a heading changes nothing else about it, so without the
		// line in there the outline would keep answering with the old positions.
		assert.match(tocSource, /newFingerprint = result\.map\(i => `\$\{i\.id\}-\$\{i\.text\}-\$\{i\.level\}-\$\{i\.line\}`\)/);
	});

	test('a click still wins over the editor, as it does over the preview', () => {
		// `clickLock` holds the entry the user picked until the jump's smooth scroll
		// settles. The preview's handler returns early on it; so must this one, or
		// clicking an entry would highlight it and then lose it to the scroll the
		// click itself caused.
		assert.match(tocSource, /const line = activeLine;\s*\n\s*if \(line === null \|\| clickLock\) return;/);
	});

	test('the editor position reaches the outline whether or not scroll sync is on', () => {
		// The line is recorded before the sync check, not inside it: following the
		// editor is not the same feature as moving the preview, and #169 asks for it
		// in editor-only mode, where there is no preview to move.
		//
		// The line is converted on the way in: `position` is in the editor's
		// numbering and the outline is built from `data-sourcepos`, which counts
		// from the body. See jumpToSelectedFragment.test.ts for that boundary.
		// It goes through `tabAnchorForEditorTopLine`, the crossing the tab's own
		// reading position takes, so the outline follows the line the reader is
		// on rather than the one the viewport cuts in half (#744).
		const handler = functionSource(viewerSource, 'handleEditorScrollSync');
		const record = handler.indexOf("followToc('editor'");
		const syncCheck = handler.indexOf('splitScrollSyncOn()');

		assert.ok(record !== -1 && syncCheck !== -1, 'both statements must still be here');
		assert.ok(record < syncCheck, 'the outline is fed before the sync check, not inside it');
		assert.match(handler, /followToc\('editor', tabAnchorForEditorTopLine\(lineCoords, asBufferLine\(position\.line\)\)\)/);
	});

	test('the preview feeds the same state, off the line it already measures', () => {
		// `getPreviewScrollAnchor` is computed on every preview scroll for the
		// tab's reading position. Taking the outline's answer from it is what makes
		// this one rule rather than two — and it costs nothing, because the descent
		// it does was already happening on that event.
		const handler = sliceBetween(viewerSource, 'function handleScroll(e: Event)', '\n\tfunction ');
		assert.match(handler, /const anchorLine = getPreviewScrollAnchor\(target\);/);
		assert.match(handler, /followToc\('preview', anchorLine\);/);
		// One input. Which pane feeds it is `followToc`'s call.
		assert.match(viewerSource, /activeLine=\{tocActiveLine\}/);
	});

	test('the outline no longer measures the preview to decide', () => {
		// The loop this replaces did a `querySelector` and a `getBoundingClientRect`
		// per visible entry on every scroll event, and could only ever answer for
		// one of the two panes.
		const handler = sliceBetween(tocSource, 'function handleScroll()', '\n\tfunction ');
		assert.doesNotMatch(handler, /getBoundingClientRect/);
		assert.doesNotMatch(handler, /querySelector/);
		// What it still does: a click leaves a highlight on its target, and the
		// next scroll takes it off.
		assert.match(handler, /clearTargetHighlight\(\)/);
	});

	test('the jump highlight ends on anything that means the reader moved on', () => {
		// It is a temporary emphasis. Hanging it off scrolling alone made it
		// permanent whenever that one event did not arrive: the jump's own smooth
		// scroll is swallowed by `clickLock`, and nothing else scrolls the preview
		// unless the reader does. A click or a keystroke has to end it too.
		const clear = sliceBetween(tocSource, 'function clearTargetHighlight()', '\n\tfunction ');
		assert.match(clear, /classList\.remove\('toc-target-active'\)/, 'one place removes the class');
		assert.match(clear, /activeTargetEl = null/);

		// And the reader's own actions must not go through the lock, which exists
		// only to ignore scrolling the app itself caused.
		const reader = sliceBetween(tocSource, 'function handleReaderAction()', '\n\t}');
		assert.doesNotMatch(reader, /clickLock/, 'a deliberate action is never locked out');
		assert.match(reader, /clearTargetHighlight\(\)/);

		for (const [target, event] of [
			['el', 'pointerdown'],
			['window', 'keydown'],
		] as const) {
			assert.match(
				tocSource,
				new RegExp(`${target}\\.addEventListener\\('${event}', handleReaderAction`),
				`${event} clears it`,
			);
			assert.match(
				tocSource,
				new RegExp(`${target}\\.removeEventListener\\('${event}', handleReaderAction\\)`),
				`${event} is detached again`,
			);
		}
	});

	test('there is no preference for it, because the preview never had one', () => {
		// The outline has always followed the preview unconditionally. This is the
		// same feature answering for the other pane, so a switch would have made
		// half of one behaviour optional and left the reader to work out which half.
		assert.doesNotMatch(settingsSource, /tocFollowsEditor/);
		assert.doesNotMatch(settingsComponentSource, /tocFollowsEditor/);
	});

	test('the current entry is centred in the outline, not merely kept on screen', () => {
		// `block: 'nearest'` scrolls the least it can: the highlight walked down to
		// the last visible row and stayed pinned there, and what came next was
		// never shown. Both callers share this one function, so the preview gets it
		// too.
		assert.match(tocSource, /scrollIntoView\(\{ block: 'center', behavior: 'smooth' \}\)/);
		assert.doesNotMatch(tocSource, /scrollIntoView\(\{ block: 'nearest'/);
	});
});

describe('outline jump motion', () => {
	test('an outline click is a jump, so it asks the same preference', () => {
		// #199 was reported against the table of contents, and `Toc.svelte` was the
		// one jump the preference never reached: its `scrollTo` kept a literal
		// `'smooth'`. `.svelte` files cannot run under `node --test`, so the anchor
		// is the jump function's text: no second copy of the answer in it.
		const jumpTo = functionSource(readSource('src/lib/components/Toc.svelte'), 'jumpTo');
		assert.doesNotMatch(jumpTo, /'smooth'/);
		assert.match(jumpTo, /jumpScrollBehavior\(/);
	});
});

describe('outline overlay placement', () => {

	test('the outline\'s toggle drops the editor toolbar\'s offset once it is over the outline', () => {
		// Collapsed, the button floats over the editor pane and `--pane-top-chrome`
		// is what keeps it clear of the toolbar. Expanded it floats over the OUTLINE,
		// which has no toolbar — and the offset pushed it onto the outline's first
		// entry instead. This is an absence, and an absence in CSS is not reachable
		// from a runtime test in this suite: jsdom applies no stylesheet.
		const viewer = readSource('src/lib/MarkdownViewer.svelte');

		const base = viewer.match(/\.toc-toggle-floating \{([^}]*)\}/);
		assert.ok(base, 'the floating toggle rule moved or was renamed');
		assert.match(base[1], /top:\s*calc\([^)]*--pane-top-chrome/);

		const expanded = viewer.match(/\.toc-toggle-floating\.expanded \{([^}]*)\}/);
		assert.ok(expanded, 'the expanded rule moved or was renamed');
		assert.match(expanded[1], /top:\s*\d+px/);
		assert.equal(
			/--pane-top-chrome/.test(expanded[1]),
			false,
			'the expanded toggle is over the outline, which has no editor toolbar to clear',
		);
	});
});
