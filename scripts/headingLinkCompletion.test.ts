/**
 * #200: "implement some function which slugify titles and purpose those as
 * #targets for URL of link".
 *
 * Half of it already worked — comrak renders an `id` onto every heading and
 * `[…](#that-id)` jumps to it — but nothing offered the ids, so writing one
 * meant doing comrak's anchorizer by hand: lowercase, drop the punctuation it
 * drops, hyphenate the spaces, and remember that a repeated heading is
 * numbered. Getting it wrong produces a link that looks right and lands
 * nowhere.
 *
 * The list comes from Rust, from the renderer's own parse and anchorizer
 * (`heading_anchors`, pinned against the rendered `id=` attributes in
 * `lib.rs`). What is asserted here is the other half: WHERE a heading is the
 * answer, and what gets written when it is — the two link syntaxes take
 * different text, which is the part that is easy to get backwards.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { readRustBackend, readSource } from './sourceTree.js';

import { headingLinkContext, headingQueryStart } from '../src/lib/utils/headingCompletion.js';

const editorSource = readSource(new URL('../src/lib/components/Editor.svelte', import.meta.url));
const rustSource = readRustBackend();

test('an inline link destination after # wants the slug', () => {
	assert.equal(headingLinkContext('See [the diagrams](#'), 'slug');
	assert.equal(headingLinkContext('See [the diagrams](#mer'), 'slug');
	assert.equal(headingLinkContext('![alt](#'), 'slug');
});

test('a wikilink to this document wants the heading as it reads', () => {
	assert.equal(headingLinkContext('[[#'), 'wikilink');
	assert.equal(headingLinkContext('[[#11. Mer'), 'wikilink');
});

test('a wikilink into another file is not this document\'s question', () => {
	// Those are that file's headings, and this buffer does not have them.
	// Offering these would be worse than offering nothing.
	assert.equal(headingLinkContext('[[notes#'), null);
	assert.equal(headingLinkContext('[[notes.md#Setup'), null);
	// Past the pipe is the alias, which is prose.
	assert.equal(headingLinkContext('[[#Setup|jump to '), null);
});

test('a finished destination, and prose that merely contains #, are not contexts', () => {
	assert.equal(headingLinkContext('[the diagrams](#mermaid) and then'), null);
	assert.equal(headingLinkContext('[the diagrams](#mermaid diagrams'), null, 'a space ends it');
	assert.equal(headingLinkContext('issue #200 is about'), null);
	assert.equal(headingLinkContext('# A heading being typed'), null);
	assert.equal(headingLinkContext('[a file link](./notes'), null, 'that is the path completion');
});

test('the suggestion replaces what was typed after the #, not the # itself', () => {
	const prefix = 'See [the diagrams](#mer';
	assert.equal(headingQueryStart(prefix), prefix.indexOf('#') + 1);
	assert.equal(prefix.slice(headingQueryStart(prefix)), 'mer');
});

/* ---------------------------------------------------------------- wiring */

test('the heading context is asked before the path context, which shares its prefix', () => {
	// `](#` also satisfies the embed test — `/!?\[.*\]\($/` matches everything
	// up to the paren. Asking for files first would answer a `#` with a list of
	// filenames.
	const heading = editorSource.indexOf('const headingContext = headingLinkContext(prefix)');
	const embed = editorSource.indexOf('const isEmbedContext =');
	assert.ok(heading > 0 && embed > 0);
	assert.ok(heading < embed);
	// And `#` has to open the dropdown, or the reader types it and nothing
	// happens until the next character.
	assert.match(editorSource, /triggerCharacters: \["\(", "\/", "\\\\", '"', "#"\]/);
});

test('each context writes the text its own syntax resolves', () => {
	assert.match(
		editorSource,
		/insertText:\s*\n?\s*headingContext === "slug" \? anchor\.slug : anchor\.text/,
	);
	// Labelled by the heading, so typing a word of it finds the entry whatever
	// the slug turned that word into.
	assert.match(editorSource, /label: anchor\.text/);
	assert.match(editorSource, /detail: `#\$\{anchor\.slug\}`/);
});

test('the list is read from Rust, and re-read only when the buffer changes', () => {
	// A second anchorizer written in TypeScript would drift from comrak's
	// without anything failing — the links would simply stop landing.
	assert.match(editorSource, /invoke\("list_heading_anchors", \{\s*\n?\s*markdown: model\.getValue\(\),/);
	assert.match(rustSource, /async fn list_heading_anchors\(markdown: String\)/);
	// Completion fires per keystroke while the dropdown is open; the headings
	// cannot have moved between two keystrokes of one edit.
	assert.match(editorSource, /if \(anchorCache\?\.version === version\) return anchorCache\.anchors;/);
});

test('the Rust side numbers repeated headings the way the renderer does', () => {
	// One anchorizer for the document, not one per heading: a second
	// "Objectives" is `objectives-1`, and offering the bare slug for it would
	// link to the first section. `heading_anchor_id` stays fresh per lookup on
	// purpose — that one answers a wikilink, which names a heading by text.
	assert.match(rustSource, /let mut anchorizer = Anchorizer::new\(\);[\s\S]{0,900}?anchorizer\.anchorize\(text\.trim\(\)\)/);
	assert.match(rustSource, /fn heading_anchor_id\(target: &str\) -> String \{\s*\n\s*Anchorizer::new\(\)/);
});
