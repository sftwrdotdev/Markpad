import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { readSource } from './sourceTree.js';

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
