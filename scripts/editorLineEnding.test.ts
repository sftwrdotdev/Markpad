import assert from 'node:assert/strict';
import test from 'node:test';

import { PieceTreeTextBufferBuilder } from 'monaco-editor/esm/vs/editor/common/model/pieceTreeTextBuffer/pieceTreeTextBufferBuilder.js';
import { DefaultEndOfLine } from 'monaco-editor/esm/vs/editor/common/standalone/standaloneEnums.js';

import { lineEndingLabel } from '../src/lib/utils/tabModels.js';
import { readSource, sliceBetween } from './sourceTree.js';

// The status bar used to render `t('editor.status.crlf')` — the literal string
// "CRLF", for every document, on every platform. `samples/stress-test.md` has
// not got one CR byte in it and the app said CRLF about it.
//
// The label is now the model's own EOL, so this file drives real Monaco with
// real CRLF and LF fixtures and asks what the label would say. The fixtures are
// literals rather than files on disk for the reason `sourceTree.ts` explains at
// length: on a Windows checkout Git decides what `\n` in a repo file means, and
// a test about line endings cannot let it.

/**
 * A Monaco text buffer built exactly the way `monaco.editor.createModel` builds
 * one: `createTextBufferFactory` is `new PieceTreeTextBufferBuilder()`,
 * `acceptChunk`, `finish()` with `normalizeEOL` left at its default.
 *
 * The buffer rather than a `TextModel` because a model pulls in the editor's
 * browser-side graph, and the EOL is decided down here anyway — everything
 * `model.getEOL()` returns comes from this object.
 */
function textBuffer(source: string, defaultEOL: 1 | 2 = DefaultEndOfLine.LF) {
	const builder = new PieceTreeTextBufferBuilder();
	builder.acceptChunk(source);
	return builder.finish().create(defaultEOL).textBuffer;
}

/** The buffer's own text, to show what normalization did to a fixture. */
function contents(buffer: ReturnType<typeof textBuffer>): string {
	const snapshot = buffer.createSnapshot(false);
	let text = '';
	for (let chunk = snapshot.read(); chunk !== null; chunk = snapshot.read()) text += chunk;
	return text;
}

const CRLF_DOCUMENT = '# Title\r\n\r\nA paragraph.\r\n\r\n- one\r\n- two\r\n';
const LF_DOCUMENT = '# Title\n\nA paragraph.\n\n- one\n- two\n';

test('the label is the document’s ending, not a constant', () => {
	assert.equal(lineEndingLabel(textBuffer(CRLF_DOCUMENT)), 'CRLF');
	assert.equal(lineEndingLabel(textBuffer(LF_DOCUMENT)), 'LF');
});

test('a mixed document is not mixed once it is open, and the label says which one won', () => {
	// Monaco counts the endings and rewrites the WHOLE buffer to the majority
	// before the model exists, so there is no third answer to give: after this
	// the document really is uniform, and a save writes it out that way. The
	// two assertions per fixture are one claim — the label matches the bytes.
	const mostlyCrlf = textBuffer('a\r\nb\r\nc\n');
	assert.equal(contents(mostlyCrlf), 'a\r\nb\r\nc\r\n');
	assert.equal(lineEndingLabel(mostlyCrlf), 'CRLF');

	const mostlyLf = textBuffer('a\nb\nc\r\n');
	assert.equal(contents(mostlyLf), 'a\nb\nc\n');
	assert.equal(lineEndingLabel(mostlyLf), 'LF');

	// Half and half: Monaco requires a CR majority, so a tie goes to LF.
	const tied = textBuffer('a\r\nb\n');
	assert.equal(contents(tied), 'a\nb\n');
	assert.equal(lineEndingLabel(tied), 'LF');
});

test('a document with no line break at all reports the ending Monaco would insert', () => {
	// An empty untitled tab, or a one-line file. There is nothing to detect, so
	// the model falls back to its `defaultEOL`, which the standalone services
	// resolve per platform: CRLF on Windows, LF elsewhere. That is still the
	// truth — it is what Enter inserts and what the save writes.
	assert.equal(lineEndingLabel(textBuffer('one line, no break', DefaultEndOfLine.CRLF)), 'CRLF');
	assert.equal(lineEndingLabel(textBuffer('', DefaultEndOfLine.LF)), 'LF');
});

test('the status bar renders the measured label and no longer a translation key', () => {
	const editor = readSource('src/lib/components/Editor.svelte');
	const statusBar = sliceBetween(editor, '<div class="status-bar">', '</div>\n{/if}');

	assert.match(statusBar, /<div class="status-item">\{lineEnding\}<\/div>/, 'the line-ending item shows the state');
	assert.doesNotMatch(editor, /editor\.status\.crlf/, 'the hardcoded CRLF string is gone');
	assert.match(
		editor,
		/lineEnding = lineEndingLabel\(model\)/,
		'and it is filled from the model, in the function that refreshes document-wide readings',
	);

	// One line-ending decision reaches this component. A second one — a `\r\n`
	// test of its own over `getValue()` — is the defect this fix replaces, in a
	// new place.
	assert.doesNotMatch(editor, /includes\('\\r\\n'\)/, 'no hand-rolled line-ending detection in the editor');
});
