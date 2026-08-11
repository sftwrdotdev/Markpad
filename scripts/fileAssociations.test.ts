import assert from 'node:assert/strict';
import test from 'node:test';

import { readSource } from './sourceTree.js';

const config = JSON.parse(readSource('src-tauri/tauri.conf.json')) as {
	bundle: { fileAssociations: Array<{ ext: string[] }> };
};

test('installer advertises only Markdown file associations', () => {
	const extensions = config.bundle.fileAssociations.flatMap((association) => association.ext);
	assert.deepEqual(extensions, ['md', 'markdown']);
	assert.equal(extensions.includes('txt'), false);
});

// The other half of the same policy, kept in this file so neither side moves
// without the reader seeing both. Claiming `.txt` in the installer takes the
// Text Document association away from Notepad (#179), which is why the test
// above exists — but Markpad does open, render and save `.txt` like any other
// note, so the Open dialog has to offer them. Before #535 it listed four
// extensions by hand and `.txt` was reachable only via "All Files".
test('the Open dialog offers every extension Markpad treats as a document', () => {
	const viewer = readSource('src/lib/MarkdownViewer.svelte');
	const links = readSource('src/lib/utils/markdownLinks.ts');

	assert.match(links, /MARKDOWN_LINK_EXTENSIONS = \[[^\]]*'txt'/);
	assert.match(viewer, /\{ name: 'Markdown', extensions: MARKDOWN_LINK_EXTENSIONS \}/);
	// A literal list is how the two drifted apart in the first place.
	assert.doesNotMatch(viewer, /extensions: \['md/);
});
