import assert from 'node:assert/strict';
import { test } from 'node:test';

import { readSource } from './sourceTree.js';

/**
 * The switch-time transition suppression is a contract between two files, and
 * both halves fail silently on their own.
 *
 * The viewer adds a class to `.layout-container`, forces a style recalculation
 * so the new pane geometry commits while transitions are off, and removes it —
 * in one statement, before the first paint of the switch. The rule that makes
 * the class mean anything lives in `styles.css`.
 *
 * Neither half can be a behaviour test: the ordering being asserted is
 * "the class is on the element during the browser's style recalculation", and
 * jsdom has no style recalculation to be inside of.
 *
 * The interesting failure is the third assertion. Svelte deletes scoped
 * selectors it cannot see applied in the markup, and this class is applied
 * through `classList` — so moving these rules into the component's `<style>`
 * block, which is where they look like they belong, compiles them away and
 * restores every animation with nothing going red.
 */
test('a tab switch commits the new pane geometry with transitions off', () => {
	const viewer = readSource('src/lib/MarkdownViewer.svelte');
	const styles = readSource('src/styles.css');

	// The viewer's half: add, force the recalculation, remove. The forced read
	// between the two is the mechanism, not a formality — without it the class
	// is added and removed within one style computation and suppresses nothing.
	assert.match(
		viewer,
		/classList\.add\('tab-switching'\);\s*void [\w.]+\.offsetHeight;\s*[\w.]+\.classList\.remove\('tab-switching'\);/,
		'the viewer must add the class, force a style recalculation, and remove it in one statement',
	);

	// The stylesheet's half, and that it reaches the pane — the element whose
	// 0.3s flex slide is the motion being suppressed.
	const rule = styles.match(/([^}]*\.layout-container\.tab-switching[^{]*)\{([^}]*)\}/);
	assert.ok(rule, 'styles.css must carry a .tab-switching rule');
	assert.match(rule[1], /\.layout-container\.tab-switching \.pane\b/, 'and it must reach .pane');
	assert.match(rule[2], /transition:\s*none\s*!important/, 'and it must switch transitions off');

	// And that it did not migrate into the component, where Svelte would prune
	// it. `classList.add('tab-switching')` is a string, not a selector, so the
	// check is for the leading dot.
	assert.doesNotMatch(
		viewer,
		/\.tab-switching/,
		'the rule must stay in styles.css: a scoped selector for an imperatively added class is compiled away',
	);
});

/**
 * The preview DOM belongs to the tab, not to the viewer.
 *
 * A single `.markdown-blocks` for every tab is what made a switch the worst
 * case `blockPatch.ts` has: two documents share no block keys, so the diff
 * replaced essentially every node, `renderRichContent` ran over the whole
 * document again, every fold re-measured, and the reading position was then
 * restored against a layout that was still settling.
 *
 * `tabSwitchKeepsPreviewDom.spec.ts` runs the mechanism that makes the switch
 * free — re-patching a host that already holds that document changes nothing —
 * but it supplies its own two hosts, so it stays green against a viewer that
 * has gone back to sharing one. This is the half that does not: the host must
 * be minted inside a keyed `{#each}` over the tabs, which is also what makes
 * Svelte destroy it with its tab and keeps the set of hosts from drifting from
 * the set of tabs the way a hand-kept registry can.
 */
test('the preview holds one document host per tab, not one for all of them', () => {
	const viewer = readSource('src/lib/MarkdownViewer.svelte');

	const each = viewer.match(
		/\{#each tabManager\.tabs as tab \(tab\.id\)\}([\s\S]*?)\{\/each\}/g,
	);
	assert.ok(each, 'the viewer must render per-tab preview hosts from a keyed each over the tabs');

	const hostBlock = each.find((block) => block.includes('markdown-blocks'));
	assert.ok(
		hostBlock,
		'.markdown-blocks must be minted per tab — one shared host makes every switch a full rebuild',
	);
	assert.match(
		hostBlock,
		/style:display=\{tab\.id === tabManager\.activeTabId \? null : 'none'\}/,
		'only the active tab\'s host may be displayed, and the hidden ones must cost no layout',
	);

	// And that nothing kept a single binding beside it. The whole property is
	// that there is no element the viewer can write two documents into.
	assert.doesNotMatch(
		viewer,
		/bind:this=\{previewBlocks\}/,
		'previewBlocks is the derived pointer at the active tab\'s host, never a binding of its own',
	);
});
