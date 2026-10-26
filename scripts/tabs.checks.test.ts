import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { readSource } from './sourceTree.js';

describe('editor reading position flush', () => {
	const editor = readSource('src/lib/components/Editor.svelte');

	test('the editor derives the anchor in exactly one place', () => {
		// The teardown used to build it inline. A flush that built its own would be
		// a second crossing of the same two numberings, which is the defect shape
		// `lineCoordinates.ts` exists to prevent.
		// The editor's position code is Editor.svelte plus editorDocument.svelte.ts.
		const editorCode = editor + readSource('src/lib/utils/editorDocument.svelte.ts');
		assert.doesNotMatch(editorCode, /tabAnchorForEditorTopLine/);
		assert.equal((editorCode.match(/editorReadingPosition\(/g) ?? []).length, 1);
	});
});
