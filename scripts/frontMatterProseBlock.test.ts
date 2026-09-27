import assert from 'node:assert/strict';
import { test } from 'node:test';

import { frontMatterLineOffset, getMarkdownBodyWithoutFrontMatter, parseFrontMatter } from '../src/lib/utils/frontMatter.js';
import { functionSource, readSource } from './sourceTree.js';

// A document may open with a thematic break and then use a setext underline for
// its first heading. That looks exactly like a front matter block, but the text
// between the rules is prose, not metadata, so it has to survive into the body.
const proseBetweenRules = `---
Lead paragraph
---

Body starts here.
`;

test('a leading --- block that is not a YAML mapping stays in the rendered body', () => {
	const parsed = parseFrontMatter(proseBetweenRules);

	assert.equal(parsed.exists, false);
	assert.equal(parsed.valid, true);
	assert.equal(parsed.raw, '');
	assert.deepEqual(parsed.fields, []);
	assert.deepEqual(parsed.data, {});
	assert.equal(parsed.body, proseBetweenRules);
	assert.equal(getMarkdownBodyWithoutFrontMatter(proseBetweenRules), proseBetweenRules);
});

test('prose that spans several lines between the rules is not swallowed either', () => {
	const markdown = '---\nline one\nline two\n---\n\nBody\n';
	const parsed = parseFrontMatter(markdown);

	assert.equal(parsed.exists, false);
	assert.equal(parsed.body, markdown);
});

test('a leading --- block holding a bare YAML sequence is not metadata', () => {
	const markdown = '---\n- one\n- two\n---\n\nBody\n';
	const parsed = parseFrontMatter(markdown);

	assert.equal(parsed.exists, false);
	assert.equal(parsed.body, markdown);
});

test('front matter that is a mapping keeps working, including empty and string-valued ones', () => {
	const empty = parseFrontMatter('---\n---\n\nBody\n');
	assert.equal(empty.exists, true);
	assert.equal(empty.valid, true);
	assert.deepEqual(empty.fields, []);
	assert.equal(empty.body, 'Body\n');

	const blank = parseFrontMatter('---\n\n---\n\nBody\n');
	assert.equal(blank.exists, true);
	assert.equal(blank.body, 'Body\n');

	const stringValued = parseFrontMatter('---\ntitle: hello\n---\n\nBody\n');
	assert.equal(stringValued.exists, true);
	assert.equal(stringValued.valid, true);
	assert.deepEqual(
		stringValued.fields.map((field) => [field.key, field.kind, field.displayValue]),
		[['title', 'string', 'hello']],
	);
	assert.equal(stringValued.body, 'Body\n');

	const crlf = parseFrontMatter('---\r\ntitle: hello\r\n---\r\n\r\nBody\r\n');
	assert.equal(crlf.exists, true);
	assert.equal(crlf.body, 'Body\r\n');
});

test('a malformed mapping is still reported as broken front matter rather than body', () => {
	const parsed = parseFrontMatter('---\ntitle: [broken\n---\n\n# Body\n');

	assert.equal(parsed.exists, true);
	assert.equal(parsed.valid, false);
	assert.equal(parsed.body, '# Body\n');
});

// Split view hands scroll positions across as "inside the front matter" or
// "this line of the body", so both panes have to agree on where the front
// matter ends. The preview's answer is parseFrontMatter's. The editor used to
// scan for any two `---` lines on its own, so a document opening with a
// thematic break told the preview it was inside a front matter panel the
// preview did not have, and the preview stayed at the top until the editor
// scrolled past the second rule.
test('the editor finds the end of the front matter through parseFrontMatter too', () => {
	const leadingRule = `---\n\n${Array.from({ length: 40 }, (_, i) => `Paragraph ${i + 1}.`).join('\n\n')}\n\n---\n\n# Next\n`;
	assert.equal(frontMatterLineOffset(leadingRule), 0);

	const editor = readSource('src/lib/components/Editor.svelte');
	const scrollEnd = functionSource(editor, 'getEditorFrontMatterScrollEnd');
	assert.match(scrollEnd, /frontMatterLineOffset\(/);
	assert.doesNotMatch(editor, /\.trim\(\) !== '---'/);
});

test('an unresolved alias in the block is broken front matter, not an exception', () => {
	const parsed = parseFrontMatter('---\n**bold**\n---\n\n# Body\n');

	assert.equal(parsed.exists, true);
	assert.equal(parsed.valid, false);
	assert.match(parsed.error ?? '', /alias/i);
	assert.equal(parsed.body, '# Body\n');
});
