import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
	readSource,
	sliceBetween,
} from './sourceTree.js';

describe('cross-window tab transfer wiring', () => {
	test('source removal waits for destination completion', () => {
		const broker = readSource('src-tauri/src/tab_transfer.rs');
		const session = readSource('src/lib/sessions/windowSession.svelte.ts');

		assert.match(broker, /pub fn complete_detached_tab/);
		const claim = sliceBetween(broker, 'pub fn claim_detached_tab', 'pub fn complete_detached_tab');
		assert.doesNotMatch(claim, /tab-transfer-claimed/);
		assert.match(session, /invoke\('complete_detached_tab', \{ token \}\)/);
	});
});

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
