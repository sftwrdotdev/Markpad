import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
	readSource,
	sliceBetween,
} from './sourceTree.js';

describe('cross-window tab transfer wiring', () => {
	test('source removal waits for destination completion', () => {
		const broker = readSource('src-tauri/src/tab_transfer.rs');
		const session = readSource('src/lib/sessions/windowSession.svelte.ts');

		assert.match(broker, /pub fn complete_detached_tab/);
		const claim = sliceBetween(broker, 'pub fn claim_detached_tab', 'pub fn complete_detached_tab');
		assert.doesNotMatch(claim, /tab-transfer-claimed/);
		assert.match(session, /invoke\('complete_detached_tab', \{ token \}\)/);
	});
});

describe('tab switch is not a render', () => {
	/**
	 * The switch-time transition suppression is a contract between two files, and
	 * both halves fail silently on their own.
	 *
	 * The viewer calls `commitWithoutTransitions` (utils/motion.ts), which adds a
	 * class to `.layout-container`, forces a style recalculation and removes it;
	 * `tabs.test.ts` runs that half. The rule that makes the class mean anything
	 * lives in `styles.css`, and jsdom has no style recalculation to observe it in.
	 *
	 * The interesting failure is the last assertion. Svelte deletes scoped
	 * selectors it cannot see applied in the markup, and this class is applied
	 * through `classList` — so moving these rules into the component's `<style>`
	 * block, which is where they look like they belong, compiles them away and
	 * restores every animation with nothing going red.
	 */
	test('styles.css switches transitions off under .tab-switching', () => {
		const viewer = readSource('src/lib/MarkdownViewer.svelte');
		const styles = readSource('src/styles.css');

		// The stylesheet's half, and that it reaches the outline wrapper, whose
		// shadow follows the tab's mode.
		const rule = styles.match(/([^}]*\.layout-container\.tab-switching[^{]*)\{([^}]*)\}/);
		assert.ok(rule, 'styles.css must carry a .tab-switching rule');
		assert.match(rule[1], /\.layout-container\.tab-switching \.toc-overlay-wrapper\b/, 'and it must reach .toc-overlay-wrapper');
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
	 * `tabs.spec.ts` runs the mechanism that makes the switch
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
});

describe('editor reading position flush', () => {
	const editor = readSource('src/lib/components/Editor.svelte');

	test('the editor derives the anchor in exactly one place', () => {
		// The teardown used to build it inline. A flush that built its own would be
		// a second crossing of the same two numberings, which is the defect shape
		// `lineCoordinates.ts` exists to prevent.
		// The editor's position code is Editor.svelte plus editorDocument.svelte.ts.
		const editorCode = editor + readSource('src/lib/utils/editorDocument.svelte.ts');
		assert.doesNotMatch(editorCode, /tabAnchorForEditorTopLine/);
		assert.equal((editorCode.match(/editorReadingPosition\(/g) ?? []).length, 1);
	});
});
