import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { parse } from 'svelte/compiler';

import { readSource } from './sourceTree.js';

type Node = Record<string, any>;

/** Every declaration of the one rule whose selector list is exactly `selector`. */
function styleRule(file: string, selector: string): Map<string, string> {
	const text = readSource(file);
	const css = parse(text, { modern: true, filename: file }).css as Node | null;
	const rules = (css?.children ?? []).filter(
		(child: Node) => child.type === 'Rule' && text.slice(child.prelude.start, child.prelude.end).trim() === selector,
	);
	assert.ok(rules.length <= 1, `expected at most one \`${selector}\` rule in ${file}, found ${rules.length}`);
	const declarations = new Map<string, string>();
	for (const child of rules[0]?.block?.children ?? []) {
		if (child.type === 'Declaration') declarations.set(child.property, child.value);
	}
	return declarations;
}

// The scope line's behaviour runs in windows.tagEditor.spec.ts. Where it is
// drawn is CSS, and there is no layout engine here.
describe('a window tag is scoped to the whole window', () => {
	test('the scope line is drawn on the strip, in a channel the active tab does not use', () => {
		/*
		 * Not executed: there is no layout engine in this runner, so this reads the
		 * parsed stylesheet rather than a rendered box. It is here because the
		 * decision it records is the one that makes the line safe — the active tab
		 * is marked with `background-color`, so a line along the bottom edge of the
		 * strip cannot be misread as "this tab", and nothing has to arbitrate
		 * between the two markings.
		 */
		const line = styleRule('src/lib/components/TitleBar.svelte', '.tab-area.tagged::after');
		assert.ok(line.size > 0, 'no rule draws the scope line');
		assert.equal(line.get('position'), 'absolute');
		assert.equal(line.get('bottom'), '0');
		assert.equal(line.get('left'), '0');
		assert.equal(line.get('right'), '0', 'the line stops short of the end of the strip');
		assert.equal(line.get('background'), 'var(--tag-color)', 'the line is not painted in the tag’s colour');
		assert.equal(line.get('pointer-events'), 'none', 'the line would swallow clicks and drags on the title bar');
		assert.equal(styleRule('src/lib/components/TitleBar.svelte', '.tab-area').get('position'), 'relative', 'the line has nothing to position against');

		const activeTab = styleRule('src/lib/components/Tab.svelte', '.tab.active');
		assert.ok(activeTab.size > 0, 'the active tab has no styling at all — this test is looking at the wrong rule');
		for (const property of ['border-bottom', 'border-bottom-color', 'border', 'box-shadow', 'outline']) {
			assert.equal(
				activeTab.get(property),
				undefined,
				`the active tab now marks itself with \`${property}\`, which competes with the scope line along the same edge`,
			);
		}
		assert.ok(activeTab.has('background-color'), 'the active tab no longer marks itself with a background');
	});
});
