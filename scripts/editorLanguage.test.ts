import assert from 'node:assert/strict';
import test from 'node:test';

import { editorLanguageFor } from '../src/lib/utils/editorLanguage.js';
import { MARKDOWN_LINK_EXTENSIONS } from '../src/lib/utils/markdownLinks.js';

test('every extension the preview renders as Markdown is edited as Markdown', () => {
	// The editor kept its own copy of the list, without `txt`: a `.txt` note
	// rendered as Markdown in the preview and showed as plain text in the editor.
	for (const ext of MARKDOWN_LINK_EXTENSIONS) {
		assert.equal(editorLanguageFor(`/notes/a.${ext}`), 'markdown', ext);
		assert.equal(editorLanguageFor(`/notes/a.${ext.toUpperCase()}`), 'markdown', ext);
	}
});

test('other files keep their own grammar, and an untitled buffer is Markdown', () => {
	assert.equal(editorLanguageFor(''), 'markdown');
	assert.equal(editorLanguageFor('/src/a.ts'), 'typescript');
	assert.equal(editorLanguageFor('/var/app.log'), 'plaintext');
	assert.equal(editorLanguageFor('/notes/constructor'), 'plaintext');
});
