import assert from 'node:assert/strict';
import test from 'node:test';

import { duplicateNameSuffixes } from '../src/lib/utils/duplicateTabNames.js';
import { HOME_TAB_PATH } from '../src/lib/utils/homeTab.js';

function suffixes(...paths: string[]): (string | undefined)[] {
	const tabs = paths.map((path, i) => ({ id: String(i), path }));
	const map = duplicateNameSuffixes(tabs);
	return tabs.map((tab) => map.get(tab.id));
}

test('a name nothing else shares gets no suffix', () => {
	assert.deepEqual(suffixes('/a/README.md', '/b/NOTES.md'), [undefined, undefined]);
});

test('same name in different folders gets the containing folder (#727)', () => {
	assert.deepEqual(suffixes('/x/.claude/skills/alpha/SKILL.md', '/x/.claude/skills/beta/SKILL.md'), [
		'alpha',
		'beta',
	]);
});

test('a suffix that is itself shared grows by one more folder', () => {
	assert.deepEqual(suffixes('/w/docs/api/README.md', '/w/packages/api/README.md'), [
		'docs/api',
		'packages/api',
	]);
});

test('only the tabs that still collide grow; a sibling keeps one folder', () => {
	assert.deepEqual(suffixes('/w/docs/api/README.md', '/w/packages/api/README.md', '/w/guide/README.md'), [
		'docs/api',
		'packages/api',
		'guide',
	]);
});

test('a windows path is shown with the separator it is spelled in', () => {
	assert.deepEqual(suffixes('C:\\w\\docs\\api\\README.md', 'C:\\w\\pkg\\api\\README.md'), [
		'docs\\api',
		'pkg\\api',
	]);
});

test('a file with no folder left to name is left alone rather than looping', () => {
	assert.deepEqual(suffixes('/README.md', '/w/README.md'), [undefined, 'w']);
});

test('untitled buffers and the home tab are not files and take no suffix', () => {
	assert.deepEqual(suffixes('', '', HOME_TAB_PATH), [undefined, undefined, undefined]);
});
