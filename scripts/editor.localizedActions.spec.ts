import assert from 'node:assert/strict';
import { flushSync } from 'svelte';
import { afterEach, describe, test } from 'vitest';

import type { LanguageCode } from '../src/lib/utils/i18n.js';
import { localizedEditorActions } from '../src/lib/utils/editorLocalizedActions.svelte.js';
import { runeEffect } from './runeEffect.svelte.js';
import { runeProps } from './runeProps.svelte.js';

/*
 * The editor's labelled actions (context menu, command palette) used to be
 * built once at mount, so switching the UI language left the context menu in
 * the previous one until the app restarted. The registration now follows the
 * language, and a re-registration releases the old actions first: Monaco keeps
 * a duplicate context-menu entry for an id registered twice.
 */

/** A Monaco editor reduced to `addAction`: which actions are live, by label. */
function fakeEditor() {
	const live = new Set<string>();
	return {
		live,
		addAction: (descriptor: { id: string; label: string }) => {
			const entry = `${descriptor.id}:${descriptor.label}`;
			live.add(entry);
			return { dispose: () => void live.delete(entry) };
		},
	};
}

let dispose: (() => void) | undefined;
afterEach(() => {
	dispose?.();
	dispose = undefined;
});

function harness() {
	const state = runeProps({ language: 'en' as LanguageCode, ready: false });
	const editor = fakeEditor();
	let release!: () => void;
	dispose = runeEffect(() => {
		release = localizedEditorActions({
			language: () => state.language,
			ready: () => state.ready,
			editor: () => editor as never,
			descriptors: (lang) =>
				['bold', 'italic'].map((id) => ({ id, label: `${id} in ${lang}`, run: () => {} })),
		});
	});
	flushSync();
	return { state, editor, release: () => release() };
}

describe('context menu actions', () => {
	test('actions are re-registered when the UI language changes', () => {
		const run = harness();
		assert.deepEqual([...run.editor.live], [], 'nothing is registered before the editor exists');

		run.state.ready = true;
		flushSync();
		assert.deepEqual([...run.editor.live].sort(), ['bold:bold in en', 'italic:italic in en']);

		run.state.language = 'ja';
		flushSync();
		assert.deepEqual(
			[...run.editor.live].sort(),
			['bold:bold in ja', 'italic:italic in ja'],
			'the menu follows the language, and no id is left registered twice',
		);

		run.release();
		assert.deepEqual([...run.editor.live], [], 'teardown releases them too');
	});
});
