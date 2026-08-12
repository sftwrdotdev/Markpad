import assert from 'node:assert/strict';
import test from 'node:test';

import { readSource } from './sourceTree.js';

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
