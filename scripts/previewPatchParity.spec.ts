import { beforeEach, describe, expect, test } from 'vitest';

import { processMarkdownHtml } from '../src/lib/utils/markdown.js';
import { patchPreview } from '../src/lib/utils/previewPatch.js';
import { sanitizeMarkdownFragment } from '../src/lib/utils/sanitize.js';
import blocks from './fixtures/markdown-syntax.blocks.json';

/**
 * The block patch against the whole-document pipeline it replaced, over the
 * renderer's real output for samples/markdown-syntax.md (every construct the
 * preview has: callouts, folds, footnotes, math, Mermaid, task lists, raw
 * `<details>` around Markdown). `preview_block_fixture_is_current` in
 * markdown.rs keeps the fixture in step with the renderer.
 *
 * Three properties:
 *   - a first render is the document the old pipeline produced;
 *   - after an edit, the patched article is what a first render of the edited
 *     document would be — the incremental path loses nothing;
 *   - undoing the edit puts the original document back.
 */

const SPLIT = blocks.join('\0');
const PATH = '/docs/markdown-syntax.md';

/** `wrap-N` ids only have to be unique; the two paths hand them out in a different order. */
const normalized = (host: Element) => host.innerHTML.replace(/wrap-\d+/g, 'wrap-N');

function oldPipeline(split: string): string {
	const host = document.createElement('div');
	host.append(sanitizeMarkdownFragment(processMarkdownHtml(split.replaceAll('\0\n', ''), PATH, new Set())));
	// The old patch carried elements only, never the whitespace between them.
	for (const node of Array.from(host.childNodes)) if (node.nodeType !== 1) node.remove();
	return normalized(host);
}

function cold(split: string): string {
	const host = document.createElement('div');
	patchPreview(host, split, PATH, new Set());
	return normalized(host);
}

/** Every `data-sourcepos` line moved down by one: a line inserted at the top. */
const enterAtTop = (split: string) =>
	split.replace(/data-sourcepos="(\d+):(\d+)-(\d+):(\d+)"/g, (_, a, b, c, d) => `data-sourcepos="${+a + 1}:${b}-${+c + 1}:${d}"`);

const at = (split: string, index: number, edit: (block: string) => string) => {
	const parts = split.split('\0');
	parts[index] = edit(parts[index]);
	return parts.join('\0');
};
const firstIndex = (pattern: RegExp) => blocks.findIndex((block) => pattern.test(block));
const middleParagraph = blocks.findIndex((block, index) => index > blocks.length / 2 && /^\n?<p /.test(block));
const firstH2 = firstIndex(/^\n?<h2 /);
const mermaid = firstIndex(/language-mermaid/);
const details = firstIndex(/<details>/);

const edits: Record<string, (split: string) => string> = {
	'a keystroke in a paragraph': (split) => at(split, middleParagraph, (b) => b.replace('</p>', 'x</p>')),
	'a line inserted at the top': enterAtTop,
	'a renamed heading': (split) => at(split, firstH2, (b) => b.replace(/(<h2 [^>]*>)/, '$1Renamed ')),
	'a new paragraph': (split) => at(split, middleParagraph, (b) => `${b}\0\n<p data-sourcepos="900:1-900:3">new</p>\n`),
	'a new section': (split) => at(split, middleParagraph, (b) => `${b}\0\n<h2 id="added" data-sourcepos="900:1-900:8">Added</h2>\n`),
	'a deleted heading': (split) => at(split, firstH2, () => ''),
	'an edited diagram': (split) => at(split, mermaid, (b) => b.replace('</code>', 'C --&gt; D\n</code>')),
	'an edited raw HTML block': (split) => at(split, details, (b) => b.replace('</summary>', ' edited</summary>')),
};

let host: HTMLElement;
beforeEach(() => {
	document.body.innerHTML = '';
	host = document.createElement('div');
	document.body.appendChild(host);
});

test('the fixture has the constructs the edits below aim at', () => {
	expect([middleParagraph, firstH2, mermaid, details].every((index) => index > 0)).toBe(true);
});

test('a first render is what the whole-document pipeline produced', () => {
	expect(cold(SPLIT)).toBe(oldPipeline(SPLIT));
});

describe.each(Object.entries(edits))('%s', (_, edit) => {
	test('patches to what a first render of the edited document is', () => {
		const edited = edit(SPLIT);
		expect(edited).not.toBe(SPLIT);
		patchPreview(host, SPLIT, PATH, new Set());
		patchPreview(host, edited, PATH, new Set());
		expect(normalized(host)).toBe(cold(edited));
	});

	test('and back to the original when it is undone', () => {
		patchPreview(host, SPLIT, PATH, new Set());
		patchPreview(host, edit(SPLIT), PATH, new Set());
		patchPreview(host, SPLIT, PATH, new Set());
		expect(normalized(host)).toBe(cold(SPLIT));
	});
});
