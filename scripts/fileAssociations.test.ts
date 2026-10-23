import assert from 'node:assert/strict';
import test from 'node:test';

import { MARKDOWN_LINK_EXTENSIONS } from '../src/lib/utils/markdownLinks.js';
import { readSource } from './sourceTree.js';

const config = JSON.parse(readSource('src-tauri/tauri.conf.json')) as {
	bundle: { fileAssociations: Array<{ ext: string[] }> };
};

// Every extension Markpad treats as a Markdown document is associated, except
// `.txt`. An extension added to either list fails here until the other follows.
test('installer associates every Markdown extension except txt', () => {
	const extensions = config.bundle.fileAssociations.flatMap((association) => association.ext);
	assert.deepEqual(
		extensions,
		MARKDOWN_LINK_EXTENSIONS.filter((ext) => ext !== 'txt'),
	);
});

// The other half of the same policy, kept in this file so neither side moves
// without the reader seeing both. Claiming `.txt` in the installer takes the
// Text Document association away from Notepad (#179), which is why the test
// above exists — but Markpad does open, render and save `.txt` like any other
// note, so the Open dialog has to offer them.
test('the Open dialog offers every extension Markpad treats as a document', () => {
	const viewer = readSource('src/lib/MarkdownViewer.svelte');
	const links = readSource('src/lib/utils/markdownLinks.ts');

	assert.match(links, /MARKDOWN_LINK_EXTENSIONS = \[[^\]]*'txt'/);
	assert.match(viewer, /\{ name: 'Markdown', extensions: MARKDOWN_LINK_EXTENSIONS \}/);
	// A literal list is how the two drifted apart in the first place.
	assert.doesNotMatch(viewer, /extensions: \['md/);
});

test('the Save dialogs offer the same document extensions', () => {
	// Both hard-coded `['md']`, so a `.txt` note saved under a new name had to
	// go through "All Files".
	const session = readSource('src/lib/sessions/documentSession.svelte.ts');

	assert.equal(session.match(/\{ name: 'Markdown', extensions: MARKDOWN_LINK_EXTENSIONS \}/g)?.length, 2);
	assert.doesNotMatch(session, /extensions: \['md/);
});
