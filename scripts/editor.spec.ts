import assert from 'node:assert/strict';
import { afterAll, describe, test } from 'vitest';

import { countWords } from '../src/lib/utils/wordCount.js';
import { isAltGraphChord } from '../src/lib/utils/viewerKeymap.js';

/*
 * The status bar counted `text.match(/\S+/g)` and then kept only the tokens
 * matching `\w` — `[A-Za-z0-9_]`. Both halves are Latin-only assumptions, and
 * together they made a Chinese or Japanese paragraph worth nothing: one token,
 * no `\w` in it, dropped. A document with no Latin characters read "0 字".
 *
 * The reported case is milder only by accident — the sentence happened to
 * contain "18", so the whole line survived the filter as a single word.
 */
describe('word count', () => {
	test('a CJK paragraph is counted per character, not as one token', () => {
		// github.com/sftwrdotdev/Markpad/issues/691, verbatim. 18 Han characters
		// plus 12 space-separated words; the app used to say 12.
		const document =
			'尊敬的开发者您好，这里应该有18个中文字符。\n' +
			'Dear developers, there are 18 Chinese characters in the above text.';
		assert.equal(countWords(document), 30);
	});

	test('a document with no Latin characters is not zero', () => {
		// The failure the issue did not reach, and the one that matters more.
		assert.equal(countWords('中文文档没有任何拉丁字母'), 12);
		assert.equal(countWords('日本語のテキストです'), 10);
	});

	test('CJK punctuation is not a word', () => {
		// `，` and `。` are Script=Common, so they reach the whitespace pass and
		// have to be filtered there, exactly like `.` and `,`.
		assert.equal(countWords('你好，世界。'), 4);
		assert.equal(countWords('Hello, world.'), 2);
	});

	test('a number wedged between CJK characters stays its own word', () => {
		// Removing the CJK run instead of spacing it would glue `18` to `年`'s
		// neighbours across the gap.
		assert.equal(countWords('第1章和第2章'), 7);
	});

	test('a script with no ASCII in it is not zero either', () => {
		// The `\w` filter was `[A-Za-z0-9_]`, so it dropped these tokens whole.
		// Korean is spaced, so the whitespace pass is the right unit for it — three
		// words, not eight syllables.
		assert.equal(countWords('안녕하세요 반갑습니다 여러분'), 3);
		assert.equal(countWords('Привет мир'), 2);
		assert.equal(countWords('Γειά σου κόσμε'), 3);
	});

	test('Latin counting is unchanged', () => {
		assert.equal(countWords(''), 0);
		assert.equal(countWords('   \n\t  '), 0);
		assert.equal(countWords('Hello world'), 2);
		assert.equal(countWords('one\ntwo\tthree'), 3);
		// Punctuation-only tokens were already excluded and still are. `___` is a
		// horizontal rule and now goes with them: it used to count as a word only
		// because `_` is in `\w`.
		assert.equal(countWords('--- *** ### ___'), 0);
	});
});

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
describe('AltGr in Monaco', () => {
	// loadMonaco patches jsdom globals for Monaco; put them back once this block is done.
	const realGetContext = HTMLCanvasElement.prototype.getContext;
	const realMatchMedia = window.matchMedia;
	afterAll(() => {
		HTMLCanvasElement.prototype.getContext = realGetContext;
		window.matchMedia = realMatchMedia;
		delete (navigator as unknown as Record<string, unknown>).userAgent;
		delete (document as unknown as Record<string, unknown>).queryCommandSupported;
	});

	async function loadMonaco() {
		// The web branch, on Windows, as `editor.checks.spec.ts` explains.
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
});
