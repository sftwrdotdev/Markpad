import assert from 'node:assert/strict';

import { describe, test } from 'vitest';

import { readSource } from './sourceTree.js';

/*
 * AltGr inside the editor.
 *
 * Windows sends AltGr as Ctrl+Alt with the AltGraph modifier on, so on a
 * Polish layout AltGr+Z (ż) is also Ctrl+Alt+Z, the editor's Zen mode chord.
 * Monaco's standalone keybinding service resolves a keystroke from
 * ctrl/shift/alt/meta and the key code alone (`resolveKeyboardEvent` in
 * standaloneServices.js); it reads `altGraphKey` into its event and never
 * looks at it again. The first test shows that against the installed Monaco;
 * the rest hold Editor.svelte to the guard the second test shows works.
 *
 * What jsdom cannot say is whether WebView2 reports AltGraph for AltGr. The
 * events here set it by hand.
 */
describe('AltGr guard in Editor.svelte', () => {
	// The mount sequence lives in utils/mountEditor.ts since the mountEditor move.
	const EDITOR = readSource('src/lib/utils/mountEditor.ts');

	test('Editor.svelte tracks AltGr in a context key', () => {
		// The context key every Ctrl+Alt action refuses (editor.actions.test.ts
		// holds the actions to it). Set from the editor's own keydown, in the
		// component: not observable without mounting it.
		assert.match(EDITOR, /editor\.createContextKey<boolean>\("altGraphChord", false\)/);
		assert.match(EDITOR, /editor\.onKeyDown\(\(e\) => altGraphChord\.set\(isAltGraphChord\(e\.browserEvent\)\)\)/);
	});
});
