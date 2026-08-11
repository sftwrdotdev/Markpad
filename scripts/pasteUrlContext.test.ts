import assert from 'node:assert/strict';
import test from 'node:test';

import { compile } from 'monaco-editor/esm/vs/editor/standalone/common/monarch/monarchCompile.js';
import { MonarchTokenizer } from 'monaco-editor/esm/vs/editor/standalone/common/monarch/monarchLexer.js';
import { language as markdownLanguage } from 'monaco-editor/esm/vs/basic-languages/markdown/markdown.js';

import { readSource } from './sourceTree.js';

import {
	buildPasteProbe,
	findTokenAtOffset,
	getFrontMatterLineCount,
	isCodeToken,
	isInFrontMatter,
	shouldLinkifyPastedUrl,
	type PasteContextToken,
} from '../src/lib/utils/pasteContext.js';

// WHAT THIS FILE COVERS, AND WHAT IT DOES NOT
//
// Covered for real: every classification below runs Monaco's *actual* markdown
// Monarch grammar — the same `language` definition monaco-editor ships and the
// same `MonarchTokenizer` that `monaco.editor.tokenize()` drives — over real
// markdown, and asserts on the decision `pasteContext.ts` reaches. So the token
// types, the fence state machine, and the caret lookup are genuinely exercised,
// not mocked.
//
// Not covered: that Editor.svelte calls this code on the Ctrl+V path with the
// right arguments. Editor.svelte is a Svelte component and cannot be imported
// here, so that wiring is pinned by a source-text assertion at the bottom of
// the file, which proves only that the code reads a certain way.
//
// Also not covered: Monaco's async tokenizer bootstrap. In the app,
// `monaco.editor.tokenize()` falls back to null tokens if the language has not
// finished loading; that degrades to "no code token found", i.e. to the old
// linkify-everything behaviour, and is not reproduced here.

// `monaco.editor.tokenize()` needs a browser-backed editor to exist, so the
// tokenizer is driven directly. Only the handful of services Monarch actually
// touches during plain (non-encoded) tokenization are stubbed.
function createMarkdownTokenizer() {
	const lexer = compile('markdown', markdownLanguage);
	const languageService = {
		languageIdCodec: { encodeLanguageId: () => 1, decodeLanguageId: () => 'markdown' },
		isRegisteredLanguageId: () => true,
		// ```lang fences: Monarch asks for the embedded language and stamps its
		// tokens with the resulting id, which is the signal pasteContext keys on.
		getLanguageIdByLanguageName: (name: string) => name,
		requestBasicLanguageFeatures: () => {},
		requestRichLanguageFeatures: () => {},
		onDidRequestBasicLanguageFeatures: () => ({ dispose() {} }),
		onDidRequestRichLanguageFeatures: () => ({ dispose() {} }),
	};
	const themeService = {
		getColorTheme: () => ({ tokenTheme: { match: () => 0 } }),
		onDidColorThemeChange: () => ({ dispose() {} }),
	};
	const configurationService = {
		getValue: () => undefined,
		onDidChangeConfiguration: () => ({ dispose() {} }),
	};

	const tokenizer = new MonarchTokenizer(
		languageService,
		themeService,
		'markdown',
		lexer,
		configurationService,
	);

	return (text: string): PasteContextToken[][] => {
		let state = tokenizer.getInitialState();
		return text.split('\n').map((line: string) => {
			const result = tokenizer.tokenize(line, true, state);
			state = result.endState;
			return result.tokens as PasteContextToken[];
		});
	};
}

const tokenize = createMarkdownTokenizer();

/**
 * Places the caret with a `|` marker inside `content` and asks whether a pasted
 * URL should become a markdown link there.
 */
function linkifiesAt(content: string, languageId = 'markdown'): boolean {
	const caret = content.indexOf('|');
	assert.notEqual(caret, -1, 'the fixture must mark the caret with |');
	const withoutCaret = content.slice(0, caret) + content.slice(caret + 1);

	const before = content.slice(0, caret).split('\n');
	const lineNumber = before.length;
	const column = before[before.length - 1].length + 1;

	return shouldLinkifyPastedUrl({
		languageId,
		content: withoutCaret,
		linesUpToCaret: withoutCaret.split('\n').slice(0, lineNumber),
		column,
		tokenize,
	});
}

test('a URL pasted into prose still becomes a markdown link', () => {
	assert.equal(linkifiesAt('some prose |here'), true);
	assert.equal(linkifiesAt('# A heading |'), true);
	assert.equal(linkifiesAt('- a list item |'), true);
	assert.equal(linkifiesAt('> a quoted line |'), true);
	assert.equal(linkifiesAt('see [other link](http://a) |'), true);
});

test('a URL pasted inside a fenced code block stays a bare URL', () => {
	assert.equal(linkifiesAt('```\nconst a = |\n```'), false);
	assert.equal(linkifiesAt('```js\nconst a = |\n```'), false);
	assert.equal(linkifiesAt('~~~\nplain |text\n~~~'), false);
});

test('a URL pasted on a blank line inside a fence stays a bare URL', () => {
	// The realistic gesture: open a fence, press Enter, paste. Monarch emits no
	// tokens at all for an empty line, which is why the caret is probed.
	assert.equal(linkifiesAt('```\n|\n```'), false);
	assert.equal(linkifiesAt('```js\n|\n```'), false);
});

test('fence state is tracked, so prose after a closed fence linkifies again', () => {
	assert.equal(linkifiesAt('```\ncode\n```\n\nback to prose |'), true);
	// An indented fence inside a list is still a fence.
	assert.equal(linkifiesAt('- item\n\n  ```\n  code |\n  ```'), false);
});

test('a URL pasted inside inline code stays a bare URL', () => {
	assert.equal(linkifiesAt('run `npm | install` now'), false);
	// Immediately after the closing backtick is prose again.
	assert.equal(linkifiesAt('run `npm`| now'), true);
	// And immediately before the opening backtick.
	assert.equal(linkifiesAt('run |`npm` now'), true);
});

test('a URL pasted inside an indented code block stays a bare URL', () => {
	assert.equal(linkifiesAt('paragraph\n\n    indented | code'), false);
});

test('a URL pasted inside front matter stays a bare URL', () => {
	const doc = '---\ntitle: Post\nsource: |\n---\n\nbody text\n';
	assert.equal(linkifiesAt(doc), false);
	assert.equal(linkifiesAt('-|--\ntitle: Post\n---\n\nbody\n'), false, 'opening fence');
	assert.equal(linkifiesAt('---\ntitle: Post\n-|--\n\nbody\n'), false, 'closing fence');
	assert.equal(linkifiesAt('---\ntitle: Post\n---\n\nbody |\n'), true, 'body below is prose');
});

test('a document that only looks like front matter is treated as prose', () => {
	// `---` over prose is a thematic break plus a setext heading, not metadata;
	// parseFrontMatter already draws that line and pasteContext reuses it.
	assert.equal(linkifiesAt('---\njust prose |\n---\n'), true);
});

test('non-markdown documents keep their existing paste behaviour', () => {
	assert.equal(linkifiesAt('const a = |', 'javascript'), true);
	assert.equal(linkifiesAt('plain |text', 'plaintext'), true);
});

test('front matter line count covers both fences', () => {
	assert.equal(getFrontMatterLineCount('---\ntitle: a\n---\nbody\n'), 3);
	assert.equal(getFrontMatterLineCount('---\ntitle: a\nb: c\n---\n'), 4);
	// No trailing newline after the closing fence.
	assert.equal(getFrontMatterLineCount('---\ntitle: a\n---'), 3);
	assert.equal(getFrontMatterLineCount('---\r\ntitle: a\r\n---\r\nbody\r\n'), 3);
	assert.equal(getFrontMatterLineCount('no front matter here\n'), 0);

	assert.equal(isInFrontMatter('---\ntitle: a\n---\nbody\n', 3), true);
	assert.equal(isInFrontMatter('---\ntitle: a\n---\nbody\n', 4), false);
});

test('the caret probe inserts one character without disturbing earlier lines', () => {
	const probe = buildPasteProbe(['first', 'second'], 4);
	assert.equal(probe.text, 'first\nsecxond');
	assert.equal(probe.lineIndex, 1);
	assert.equal(probe.offset, 3);

	// A blank caret line still gets a probe, which is the whole point.
	assert.deepEqual(buildPasteProbe(['```', ''], 1), { text: '```\nx', lineIndex: 1, offset: 0 });

	// Columns outside the line are clamped rather than producing gaps.
	assert.equal(buildPasteProbe(['ab'], 99).offset, 2);
	assert.equal(buildPasteProbe(['ab'], -5).offset, 0);
});

test('link syntax is not mistaken for code', () => {
	// `string.link.md` shares a prefix with the `string.md` code token, so the
	// classifier has to match whole token types.
	assert.equal(isCodeToken({ offset: 0, type: 'string.link.md', language: 'markdown' }), false);
	assert.equal(isCodeToken({ offset: 0, type: 'string.md', language: 'markdown' }), true);
	assert.equal(isCodeToken({ offset: 0, type: 'variable.md', language: 'markdown' }), true);
	assert.equal(isCodeToken({ offset: 0, type: 'variable.source.md', language: 'markdown' }), true);
	assert.equal(isCodeToken({ offset: 0, type: '', language: 'markdown' }), false);
	// Anything an embedded grammar emits counts as code.
	assert.equal(isCodeToken({ offset: 0, type: 'identifier.js', language: 'javascript' }), true);
});

test('the caret lands in the token that starts at or before it', () => {
	const tokens: PasteContextToken[] = [
		{ offset: 0, type: '', language: 'markdown' },
		{ offset: 4, type: 'variable.md', language: 'markdown' },
		{ offset: 9, type: '', language: 'markdown' },
	];
	assert.equal(findTokenAtOffset(tokens, 0)?.type, '');
	assert.equal(findTokenAtOffset(tokens, 4)?.type, 'variable.md');
	assert.equal(findTokenAtOffset(tokens, 8)?.type, 'variable.md');
	assert.equal(findTokenAtOffset(tokens, 9)?.type, '');
	assert.equal(findTokenAtOffset([], 0), null);
});

test('the paste path consults the context guard before building a link', () => {
	// Source-text only: this proves Editor.svelte reads this way, not that it
	// behaves this way at runtime.
	const editor = readSource('src/lib/components/Editor.svelte');

	assert.match(
		editor,
		/if \(!isUrl \|\| isMultiLine \|\| !isLinkifyPasteTarget\(model, selections\[0\]\)\) \{/,
		'the raw-text paste branch is taken when the caret is not in prose',
	);
	assert.match(
		editor,
		/tokenize: \(text\) => monaco\.editor\.tokenize\(text, MARKDOWN_LANGUAGE_ID\)/,
		'classification runs Monaco\'s own tokenizer, not a hand-rolled scan',
	);
	assert.match(
		editor,
		/linesUpToCaret: model\.getLinesContent\(\)\.slice\(0, selection\.startLineNumber\)/,
		'only the lines above the caret are tokenized',
	);
});
