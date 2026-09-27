import assert from 'node:assert/strict';

import { test } from 'vitest';

import { isAltGraphChord } from '../src/lib/utils/viewerKeymap.js';
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

const EDITOR = readSource('src/lib/components/Editor.svelte');

async function loadMonaco() {
	// The web branch, on Windows, as `monacoChordOwnership.spec.ts` explains.
	(document as unknown as { queryCommandSupported: () => boolean }).queryCommandSupported = () => true;
	Object.defineProperty(navigator, 'userAgent', {
		value: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
		configurable: true,
	});
	// Monaco measures the pixel ratio and fonts through a 2D context jsdom does
	// not have. Nothing here renders, so any answer will do.
	const ctx: unknown = new Proxy(
		{},
		{
			get: (_target, name) =>
				name === 'measureText' ? () => ({ width: 7 }) : String(name).endsWith('PixelRatio') ? 1 : () => ctx,
		},
	);
	(HTMLCanvasElement.prototype as unknown as { getContext: () => unknown }).getContext = () => ctx;
	window.matchMedia ??= () =>
		({ matches: false, addEventListener() {}, removeEventListener() {} }) as unknown as MediaQueryList;

	const realPlatform = process.platform;
	const realVersions = process.versions;
	Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
	Object.defineProperty(process, 'versions', { value: { ...realVersions, node: undefined }, configurable: true });
	try {
		return await import('monaco-editor');
	} finally {
		Object.defineProperty(process, 'platform', { value: realPlatform, configurable: true });
		Object.defineProperty(process, 'versions', { value: realVersions, configurable: true });
	}
}

function keydown(target: Element, key: string, code: string, keyCode: number, altGraph: boolean): KeyboardEvent {
	const event = new KeyboardEvent('keydown', {
		key,
		code,
		keyCode,
		ctrlKey: true,
		altKey: true,
		modifierAltGraph: altGraph,
		bubbles: true,
		cancelable: true,
	} as KeyboardEventInit);
	target.dispatchEvent(event);
	return event;
}

test('Monaco runs a Ctrl+Alt action for AltGr unless a context key stops it', { timeout: 120_000 }, async () => {
	const monaco = await loadMonaco();
	const host = document.createElement('div');
	document.body.appendChild(host);
	// Word highlighting leaves a cancelled promise unhandled on dispose.
	const editor = monaco.editor.create(host, { value: '', occurrencesHighlight: 'off' });
	editor.focus();
	const input = document.activeElement;
	assert.ok(input && host.contains(input), 'the editor input must have focus for its keybindings to fire');

	const altGraphChord = editor.createContextKey<boolean>('altGraphChord', false);
	editor.onKeyDown((e) => altGraphChord.set(isAltGraphChord(e.browserEvent)));

	let unguarded = 0;
	let guarded = 0;
	editor.addAction({
		id: 'unguarded',
		label: 'unguarded',
		keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyMod.Alt | monaco.KeyCode.KeyZ],
		run: () => void unguarded++,
	});
	editor.addAction({
		id: 'guarded',
		label: 'guarded',
		keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyMod.Alt | monaco.KeyCode.KeyT],
		keybindingContext: '!altGraphChord',
		run: () => void guarded++,
	});

	// Without a guard, AltGr+Z is the chord and the character is swallowed.
	const altGrZ = keydown(input, 'ż', 'KeyZ', 90, true);
	assert.equal(unguarded, 1);
	assert.equal(altGrZ.defaultPrevented, true);

	// With it, the key is left to the browser to type.
	const altGrT = keydown(input, 'ţ', 'KeyT', 84, true);
	assert.equal(guarded, 0);
	assert.equal(altGrT.defaultPrevented, false);

	// A real Ctrl+Alt still runs the action.
	keydown(input, 't', 'KeyT', 84, false);
	assert.equal(guarded, 1);

	editor.dispose();
	host.remove();
});

test('Editor.svelte tracks AltGr and every Ctrl+Alt action checks it', () => {
	assert.match(EDITOR, /editor\.createContextKey<boolean>\("altGraphChord", false\)/);
	assert.match(EDITOR, /editor\.onKeyDown\(\(e\) => altGraphChord\.set\(isAltGraphChord\(e\.browserEvent\)\)\)/);

	const ctrlAltActions = EDITOR.split('editor.addAction({')
		.slice(1)
		.map((chunk) => chunk.slice(0, chunk.indexOf('run:')))
		.filter((head) => /KeyMod\.CtrlCmd \| monaco\.KeyMod\.Alt \|/.test(head));
	// Zen mode and Insert Table today. Empty would make the loop below vacuous.
	assert.ok(ctrlAltActions.length >= 2, `found ${ctrlAltActions.length} Ctrl+Alt actions`);
	for (const head of ctrlAltActions) {
		assert.match(head, /keybindingContext: "!altGraphChord"/, head.slice(0, 80));
	}
});
