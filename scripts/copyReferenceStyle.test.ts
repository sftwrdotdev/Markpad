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

import assert from 'node:assert/strict';
import test from 'node:test';

import { readSource } from './sourceTree.js';

import {
	DEFAULT_REFERENCE_STYLE,
	headingReference,
	preferredReferenceStyle,
} from '../src/lib/utils/headingReference.js';

const viewerSource = readSource(new URL('../src/lib/MarkdownViewer.svelte', import.meta.url));

/* ------------------------------------------------------ reading the document */

test('a document that links one way gets another of the same', () => {
	assert.equal(
		preferredReferenceStyle('See [[Setup#Install]] for details.\n'),
		'wikilink',
	);
	assert.equal(
		preferredReferenceStyle('See [Install](setup.md#install) for details.\n'),
		'inline',
	);
	// A same-document anchor counts as well — it is the same spelling.
	assert.equal(preferredReferenceStyle('Back to [the top](#introduction).\n'), 'inline');
	// And a bare note link, which the renderer leaves literal, still says what
	// the writer's habit is.
	assert.equal(preferredReferenceStyle('See [[Setup]].\n'), 'wikilink');
});

test('silence and disagreement both fall back to what the menu always did', () => {
	assert.equal(DEFAULT_REFERENCE_STYLE, 'wikilink');
	assert.equal(preferredReferenceStyle(''), DEFAULT_REFERENCE_STYLE);
	assert.equal(preferredReferenceStyle('# A document\n\nWith no links at all.\n'), DEFAULT_REFERENCE_STYLE);
	assert.equal(
		preferredReferenceStyle('Both [[Setup#Install]] and [Install](setup.md#install).\n'),
		DEFAULT_REFERENCE_STYLE,
		'a document using both is not evidence of either',
	);
	// An ordinary link with no anchor is not evidence: every document has those.
	assert.equal(preferredReferenceStyle('See [the site](https://example.com).\n'), DEFAULT_REFERENCE_STYLE);
});

test('a document ABOUT markdown does not vote with its examples', () => {
	// `samples/stress-test.md` and this project's own notes are full of
	// both spellings inside fences. Counting those would make the syntax
	// documentation the loudest voice in every vault.
	const teaching = [
		'# Linking',
		'',
		'```markdown',
		'[[Setup#Install]]',
		'```',
		'',
		'Prose with [an anchor](setup.md#install) in it.',
		'',
	].join('\n');

	assert.equal(preferredReferenceStyle(teaching), 'inline', 'the fenced example must not count');

	const tildeFenced = '~~~md\n[[Setup#Install]]\n~~~\n\nSee [x](a.md#b).\n';
	assert.equal(preferredReferenceStyle(tildeFenced), 'inline', 'tilde fences too');
});

/* ------------------------------------------------------------ writing it out */

test('each style is written the way its own resolver reads it', () => {
	const heading = { text: 'Setup', slug: 'setup', fileName: 'notes.md' as string | null };

	// The wikilink drops the extension — `process_wikilinks` appends `.md`
	// itself — and names the heading by its TEXT.
	assert.equal(headingReference({ ...heading, style: 'wikilink' }), '[[notes#Setup]]');
	// The CommonMark form keeps it, because that is how the frontend claims a
	// link for local navigation, and names the heading by its rendered id.
	assert.equal(headingReference({ ...heading, style: 'inline' }), '[Setup](notes.md#setup)');
});

test('the wikilink drops only an extension the renderer would add back', () => {
	// `process_wikilinks` appends `.md` to a target with no extension, so
	// `[[note#Setup]]` reaches `note.md` and never `note.markdown`.
	const reference = (fileName: string) =>
		headingReference({ text: 'Setup', slug: 'setup', fileName, style: 'wikilink' });
	assert.equal(reference('note.markdown'), '[[note.markdown#Setup]]');
	assert.equal(reference('notes.txt'), '[[notes.txt#Setup]]');
	// Left as `v1.2`, the target would read as having a `.2` extension.
	assert.equal(reference('v1.2.md'), '[[v1.2.md#Setup]]');
	assert.equal(reference('v1.2 spec.md'), '[[v1.2 spec#Setup]]');
});

test('an unsaved document has no file to name', () => {
	const heading = { text: 'Setup', slug: 'setup', fileName: null };
	assert.equal(headingReference({ ...heading, style: 'wikilink' }), '#Setup');
	assert.equal(headingReference({ ...heading, style: 'inline' }), '[Setup](#setup)');
});

test('the CommonMark form survives a filename with a space and a bracketed heading', () => {
	// `[Setup](my notes.md#setup)` stops at the space; `[Notes [draft](…)` ends
	// its label early. Neither can happen in the wikilink form, which is part
	// of why this only applies to one of them.
	assert.equal(
		headingReference({ text: 'Setup', slug: 'setup', fileName: 'my notes.md', style: 'inline' }),
		'[Setup](<my notes.md#setup>)',
	);
	assert.equal(
		headingReference({ text: 'Notes [draft', slug: 'notes-draft', fileName: null, style: 'inline' }),
		'[Notes \\[draft](#notes-draft)',
	);
});

test('a repeated heading is addressable, because the slug comes from the render', () => {
	// comrak numbers them; recomputing the id here would drift from that.
	assert.equal(
		headingReference({ text: 'Objectives', slug: 'objectives-1', fileName: 'n.md', style: 'inline' }),
		'[Objectives](n.md#objectives-1)',
	);
});

/* ---------------------------------------------------------------- the wiring */

test('all three entries go through one helper, which reads the buffer', () => {
	// The preview's heading menu, the outline's right-click, and the outline's
	// context menu. All three built the string inline before, which is how they
	// came to disagree about the filename in the first place.
	assert.equal((viewerSource.match(/copyHeadingReference\(/g) ?? []).length, 4, 'one helper, three callers');
	assert.match(viewerSource, /style: preferredReferenceStyle\(tab\?\.rawContent \?\? ''\)/);
	// The id is taken off the rendered element rather than recomputed.
	assert.match(viewerSource, /heading\.id \|\| heading\.querySelector\('a\.anchor'\)\?\.id/);
});
