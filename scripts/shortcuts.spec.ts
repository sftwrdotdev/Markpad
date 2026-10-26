import assert from 'node:assert/strict';

import { flushSync } from 'svelte';
import { beforeAll, describe, onTestFinished, test } from 'vitest';

import { handleModalBackdropContextMenu } from '../src/lib/utils/modalContextMenu.js';
import { canUsePreviewWidthShortcut, type KeyContext, type KeyStroke, type ViewerCommand, viewerCommandFor } from '../src/lib/utils/viewerKeymap.js';
import { PLATFORMS } from './keymapHarness.js';

describe('viewer keymap', () => {
	/*
	 * The document-level dispatcher, called rather than read.
	 *
	 * `shortcutRegistry.test.ts` and `formatShortcutKeymap.test.ts` already sweep
	 * the whole keymap chord by chord and hold it against the shortcuts panel; what
	 * is here is the handful of claims that a sweep cannot make — the ones about
	 * the CONTEXT rather than the chord, which the sweep fires with one fixed
	 * context, and the two that need a real DOM.
	 *
	 * A `.spec.ts` for the DOM: `canUsePreviewWidthShortcut` matches a selector
	 * against a real element, and a hand-made object with a `closest` method would
	 * be asserting against the test's own idea of the selector rather than the
	 * browser's. See AGENTS.md on which runner a test belongs to.
	 */

	const READING: KeyContext = {
		mode: 'app',
		osType: 'windows',
		isSplit: false,
		overlayOpen: false,
		dialogOpen: false,
		isEditing: false,
		editorHasFocus: false,
	};

	const chord = (key: string, code: string, mods: Partial<KeyStroke> = {}): KeyStroke => ({
		key,
		code,
		ctrlKey: false,
		metaKey: false,
		shiftKey: false,
		altKey: false,
		...mods,
	});

	test('nothing is dispatched before the app has loaded', () => {
		// `mode !== 'app'` was the handler's first line and the only branch condition
		// that could not be reached by firing a chord at it, because the harness
		// pinned `mode: 'app'` to get any answer at all.
		const modS = chord('s', 'KeyS', { ctrlKey: true });
		assert.equal(viewerCommandFor(modS, READING), 'save');
		assert.equal(viewerCommandFor(modS, { ...READING, mode: 'loading' }), null);

		// And it is the whole keymap, not just Save: a splash screen answers nothing.
		for (const platform of PLATFORMS) {
			for (const key of ['w', 'q', 'e', 'o', 't', 'n', ',', '0']) {
				assert.equal(
					viewerCommandFor(chord(key, `Key${key.toUpperCase()}`, { ctrlKey: true }), {
						...READING,
						osType: platform.osType as KeyContext['osType'],
						mode: 'loading',
					}),
					null,
					`${platform.name}: Mod+${key} while loading`,
				);
			}
		}
	});

	test('Mod+F is Monaco’s while the caret is in the editor, and the app’s otherwise', () => {
		// The one branch whose condition is where FOCUS is, which is why it is the
		// one chord the app deliberately answers with nothing some of the time: a
		// null means the caller does not preventDefault, and Monaco's own Find
		// keybinding gets the keystroke.
		const modF = chord('f', 'KeyF', { ctrlKey: true });
		assert.equal(viewerCommandFor(modF, READING), 'find');
		assert.equal(viewerCommandFor(modF, { ...READING, editorHasFocus: true }), null);
	});

	test('macOS leaves ⌘Q to the application menu, and the other two do not', () => {
		// The early return, asked per platform. It is scoped by `osType` rather than
		// by `platformOf`, which folds Linux into Windows and could not express it.
		const modQ = chord('q', 'KeyQ', { metaKey: true });
		assert.equal(viewerCommandFor(modQ, { ...READING, osType: 'macos' }), null);
		assert.equal(viewerCommandFor(modQ, { ...READING, osType: 'windows' }), 'app-exit');
		assert.equal(viewerCommandFor(modQ, { ...READING, osType: 'linux' }), 'app-exit');
		// `osType` is `'unknown'` until the Rust command answers. Quit is not the
		// destructive branch that has to fail closed — Ctrl+F4 is, and it does — but
		// an unknown platform must still behave like the majority of them rather
		// than like a fourth case nobody wrote.
		assert.equal(viewerCommandFor(modQ, { ...READING, osType: 'unknown' }), 'app-exit');
	});

	test('an open dialog owns the keyboard: no viewer chord reaches past it', () => {
		// The unsaved-changes dialog only preventDefaults its own keys, so the
		// document handler saw every chord behind it. Mod+W there asked a second
		// question over the first, whose promise then never settled — the close
		// walk hung and the window could no longer be closed. Ctrl+S saved twice.
		const behind = { ...READING, overlayOpen: true, dialogOpen: true };
		for (const stroke of [
			chord('w', 'KeyW', { ctrlKey: true }),
			chord('s', 'KeyS', { ctrlKey: true }),
			chord('q', 'KeyQ', { ctrlKey: true }),
			chord('Tab', 'Tab', { ctrlKey: true }),
			chord('t', 'KeyT', { ctrlKey: true, shiftKey: true }),
			chord('ArrowLeft', 'ArrowLeft', { altKey: true }),
		]) {
			assert.notEqual(viewerCommandFor(stroke, READING), null, `${stroke.code} is bound at all`);
			assert.equal(viewerCommandFor(stroke, behind), null, `${stroke.code} fired behind the dialog`);
		}
		// Settings and Home are overlays too, but not dialogs: the keymap stays live.
		assert.equal(viewerCommandFor(chord('w', 'KeyW', { ctrlKey: true }), { ...READING, overlayOpen: true }), 'close-file');
	});

	test('the Alt+arrow chords leave a text field its word jumps', () => {
		// Option+Left/Right is word-jump in every macOS text field, and
		// Cmd+Option+Left/Right the tab chords. Both fired from the find bar, the
		// settings fields and the tag input, moving the tab instead of the caret.
		//
		// Monaco's own input is the exception, kept as it was. On macOS Monaco binds
		// Option+Left/Right itself (cursorWordLeft / cursorWordEndRight) and stops
		// the event, so the handler never sees it there; the two tab chords, and
		// Alt+Left/Right on Windows and Linux, are bound by nothing in Monaco and
		// have always reached the document from the editor. The class names are
		// Monaco's input for both of its edit-context implementations.
		document.body.innerHTML = `
		<div id="preview"><p id="prose">text</p></div>
		<input id="field" />
		<div class="monaco-editor">
			<textarea id="inputarea" class="inputarea" role="textbox"></textarea>
			<div id="edit-context" class="native-edit-context" role="textbox"></div>
		</div>
	`;
		const at = (id: string) => document.getElementById(id)!;
		const mac = { ...READING, osType: 'macos' as const };
		const cases: Array<[KeyStroke, KeyContext, ViewerCommand]> = [
			[chord('ArrowLeft', 'ArrowLeft', { altKey: true }), READING, 'history-back'],
			[chord('ArrowRight', 'ArrowRight', { altKey: true }), READING, 'history-forward'],
			[chord('ArrowLeft', 'ArrowLeft', { altKey: true }), mac, 'history-back'],
			[chord('ArrowLeft', 'ArrowLeft', { metaKey: true, altKey: true }), mac, 'previous-tab'],
			[chord('ArrowRight', 'ArrowRight', { metaKey: true, altKey: true }), mac, 'next-tab'],
		];
		for (const [stroke, context, command] of cases) {
			const name = `${context.osType} ${stroke.metaKey ? 'Meta+' : ''}Alt+${stroke.code}`;
			assert.equal(viewerCommandFor({ ...stroke, target: at('prose') }, context), command, name);
			assert.equal(viewerCommandFor({ ...stroke, target: null }, context), command, name);
			assert.equal(viewerCommandFor({ ...stroke, target: at('field') }, context), null, `${name} in a field`);
			for (const id of ['inputarea', 'edit-context']) {
				assert.equal(viewerCommandFor({ ...stroke, target: at(id) }, context), command, `${name} in Monaco`);
			}
		}
	});

	test('the zoom-in chord answers both spellings of “Mod plus”', () => {
		// `+` IS the shifted `=` on the layouts that have both, so this branch cannot
		// demand Shift be up. The keymap sweep only ever fires unshifted characters,
		// so it sees the `=` half and never the `+` half; this is the other half.
		assert.equal(viewerCommandFor(chord('=', 'Equal', { ctrlKey: true }), READING), 'zoom-in');
		assert.equal(viewerCommandFor(chord('+', 'Equal', { ctrlKey: true, shiftKey: true }), READING), 'zoom-in');
		// And the shifted `=` spelling that is NOT `+` stays unbound: on a layout
		// where Shift+= is something else, the app has not claimed it.
		assert.equal(viewerCommandFor(chord('=', 'Equal', { ctrlKey: true, shiftKey: true }), READING), null);
		// Alt is up in every spelling — Mod+Alt+= is not zoom.
		assert.equal(viewerCommandFor(chord('+', 'Equal', { ctrlKey: true, shiftKey: true, altKey: true }), READING), null);
	});

	test('the preview-width chords keep out of a text field', () => {
		// The one condition that reads the DOM. jsdom rather than a stub with a
		// `closest` method, so the selector is matched by the browser's own engine:
		// a stub would only prove the test and the code agree about a string.
		const bracket = chord('[', 'BracketLeft', { ctrlKey: true, altKey: true });

		document.body.innerHTML = `
		<div id="preview"><p id="prose">text</p></div>
		<input id="field" />
		<div id="editable" contenteditable="true"><span id="inside">text</span></div>
		<div id="box" role="textbox"><span id="in-box">text</span></div>
	`;
		const at = (id: string) => document.getElementById(id)!;

		assert.equal(viewerCommandFor({ ...bracket, target: at('prose') }, READING), 'preview-width-narrower');
		for (const id of ['field', 'editable', 'inside', 'box', 'in-box']) {
			assert.equal(viewerCommandFor({ ...bracket, target: at(id) }, READING), null, `#${id} owns its own keys`);
		}

		// A target that is not an element at all — `document`, or null — is not a
		// text field, so the chord applies. This is the case the old
		// `target instanceof Element` spelling answered by accident and the current
		// one answers on purpose.
		assert.equal(canUsePreviewWidthShortcut(null, READING), true);
		assert.equal(canUsePreviewWidthShortcut(document, READING), true);
	});

	test('Mod+L reaches Auto-Reload from every mode, including the preview', () => {
		// #692. The chord used to exist only as an `editorAction`, so Monaco owned
		// it and it did nothing in the preview — the exact inverse of where the
		// Auto-Reload button was drawn, while the shortcut panel advertised it in
		// all three modes regardless. The button now appears in all three; this is
		// the other surface agreeing.
		const modL = chord('l', 'KeyL', { ctrlKey: true });
		assert.equal(viewerCommandFor(modL, READING), 'toggle-live-mode');
		assert.equal(
			viewerCommandFor(modL, { ...READING, isEditing: true, editorHasFocus: true }),
			'toggle-live-mode',
		);
		assert.equal(viewerCommandFor(modL, { ...READING, isSplit: true }), 'toggle-live-mode');

		// And it is Mod+L, not the cross product Mod+Shift+L / Mod+Alt+L.
		assert.equal(viewerCommandFor(chord('l', 'KeyL', { ctrlKey: true, shiftKey: true }), READING), null);
		assert.equal(viewerCommandFor(chord('l', 'KeyL', { ctrlKey: true, altKey: true }), READING), null);
		assert.equal(viewerCommandFor(chord('l', 'KeyL'), READING), null);
	});

	test('Mod+Alt+Z reaches Zen mode from the preview', () => {
		// #800. Zen was only an `editorAction`, so the chord did nothing without
		// Monaco on screen.
		const zen = chord('z', 'KeyZ', { ctrlKey: true, altKey: true });
		assert.equal(viewerCommandFor(zen, READING), 'toggle-zen-mode');
		assert.equal(viewerCommandFor(zen, { ...READING, isSplit: true }), 'toggle-zen-mode');

		// Option rewrites the key on a Mac; the physical key is what the chord names.
		const macZen = chord('Ω', 'KeyZ', { metaKey: true, altKey: true });
		assert.equal(viewerCommandFor(macZen, { ...READING, osType: 'macos' }), 'toggle-zen-mode');

		// Mod+Z is undo and Mod+Shift+Z redo; neither may land here.
		assert.equal(viewerCommandFor(chord('z', 'KeyZ', { ctrlKey: true }), READING), null);
		assert.equal(viewerCommandFor(chord('z', 'KeyZ', { ctrlKey: true, shiftKey: true }), READING), null);
		assert.equal(viewerCommandFor(chord('z', 'KeyZ', { ctrlKey: true, altKey: true, shiftKey: true }), READING), null);
	});

	test('AltGr typing a character is not a Mod+Alt chord', () => {
		// Windows sends AltGr as Ctrl+Alt, with the AltGraph modifier on. Polish
		// types ż with AltGr+Z, which was toggling Zen mode instead.
		const altGr = (key: string, code: string): KeyStroke => ({
			...chord(key, code, { ctrlKey: true, altKey: true }),
			getModifierState: (name: string) => name === 'AltGraph',
		});
		assert.equal(viewerCommandFor(altGr('ż', 'KeyZ'), READING), null);
		assert.equal(viewerCommandFor(altGr('[', 'BracketLeft'), { ...READING, isSplit: true }), null);

		// A real Ctrl+Alt still is.
		const zen = { ...chord('z', 'KeyZ', { ctrlKey: true, altKey: true }), getModifierState: () => false };
		assert.equal(viewerCommandFor(zen, READING), 'toggle-zen-mode');
	});

	test('Mod+Shift+B reaches the tab bar from the preview', () => {
		// Off macOS there is no menu accelerator behind the page, so without this
		// branch the chord the panel lists did nothing outside the editor.
		for (const osType of ['windows', 'linux'] as const) {
			assert.equal(viewerCommandFor(chord('B', 'KeyB', { ctrlKey: true, shiftKey: true }), { ...READING, osType }), 'toggle-tabs', osType);
		}
		// Mod+B is Bold.
		assert.equal(viewerCommandFor(chord('b', 'KeyB', { ctrlKey: true }), READING), null);
	});

	test('Mod+Shift+N opens a new window and Mod+N stays New File', () => {
		for (const [osType, mods] of [['macos', { metaKey: true }], ['windows', { ctrlKey: true }], ['linux', { ctrlKey: true }]] as const) {
			const context = { ...READING, osType, isEditing: true, editorHasFocus: true };
			assert.equal(viewerCommandFor(chord('N', 'KeyN', { ...mods, shiftKey: true }), context), 'new-window', osType);
			assert.equal(viewerCommandFor(chord('n', 'KeyN', mods), context), 'new-file', osType);
			assert.equal(viewerCommandFor(chord('N', 'KeyN', { ...mods, shiftKey: true, altKey: true }), context), null, osType);
		}
	});
});

describe('platform source', async () => {
	/*
	 * "What platform is this?" had two answers.
	 *
	 * `TitleBar.svelte` sniffed `navigator.userAgent` for "Macintosh"; every other
	 * consumer — the shortcut panel, the editor toolbar, the tab tooltips, the
	 * document context menu, Monaco's keybindings — read `settings.osType`, which
	 * the Rust `get_os_type` command fills in. Nothing compared the two, so nothing
	 * could notice them disagreeing.
	 *
	 * They disagree at exactly one moment, and it is the moment the title bar is
	 * first painted. `SettingsStore` sets `osType` from an `await invoke(…)` in its
	 * constructor, so the field holds its initial `'unknown'` for as long as that
	 * round trip takes — the first test below pins that window open. During it the
	 * user agent already says "Macintosh" while `settings.osType` still says
	 * `'unknown'`, which is why the title bar could draw Mac chrome above tab
	 * tooltips printing the Ctrl chords.
	 *
	 * That window is also why the obvious fix is wrong. Repointing the title bar at
	 * `settings.osType` alone would make a Mac render the `windows` class, the
	 * Windows minimise/maximise/close buttons and no `native-mac` chrome for those
	 * frames, and then rearrange itself — a visible regression, traded for an
	 * invisible one. `platformOf` consults `settings.osType` first and falls back to
	 * the synchronous browser hint only while it is unresolved, so there is one
	 * source and no flash. The rest of this file is that claim, in both directions.
	 */

	const { platformOf } = await import('../src/lib/utils/platform.js');

	function withNavigatorPlatform(value: string, body: () => void) {
		const original = Object.getOwnPropertyDescriptor(navigator, 'platform');
		Object.defineProperty(navigator, 'platform', { value, configurable: true });
		try {
			body();
		} finally {
			if (original) Object.defineProperty(navigator, 'platform', original);
			else delete (navigator as { platform?: string }).platform;
		}
	}

	// ------------------------------------------------- the window really is open

	test('settings.osType is still unknown when a component first renders', async () => {
		// The premise of everything below, asserted rather than assumed. The store is
		// constructed and read in the SAME synchronous turn a component's first
		// render happens in, and `initOSType()` cannot have resolved by then however
		// fast the backend is — an awaited `invoke` is at minimum a microtask later.
		(window as any).__TAURI_INTERNALS__ = {
			invoke: async (command: string) => (command === 'get_os_type' ? 'macos' : null),
		};
		const { SettingsStore } = await import('../src/lib/stores/settings.svelte.js');

		const store = new SettingsStore();
		try {
			assert.equal(store.osType, 'unknown', 'the field a first render would read');

			// And it does resolve, so the window is a window and not the whole life of
			// the app: a title bar that read `settings.osType` alone would be correct
			// from here on and wrong before it. That is the flash.
			await new Promise((resolve) => setTimeout(resolve, 0));
			assert.equal(store.osType, 'macos');
		} finally {
			store.dispose();
		}
	});

	// ------------------------------------------------------ platformOf, per case

	test('a resolved os type is the answer, whatever the browser would have said', () => {
		// The direction that is red against the old title bar: a Mac whose os type is
		// known reads as macOS even where the user agent does not say "Macintosh",
		// and — the case that matters for a bug report — a Windows or Linux machine
		// reads as `windows` even if something upstream lied to the browser.
		withNavigatorPlatform('Win32', () => {
			assert.equal(platformOf('macos'), 'macos');
		});
		withNavigatorPlatform('MacIntel', () => {
			assert.equal(platformOf('windows'), 'windows');
			assert.equal(platformOf('linux'), 'windows', 'Linux takes the Ctrl chords and the Windows controls');
		});
	});

	test('during the startup window the browser hint answers, so the title bar cannot flash', () => {
		// THE REGRESSION GUARD. Delete the fallback and this is the test that goes
		// red: `platformOf('unknown')` would answer `'windows'` on a Mac, and the
		// title bar would paint the Windows window controls before rearranging.
		withNavigatorPlatform('MacIntel', () => {
			assert.equal(platformOf('unknown'), 'macos');
		});
		withNavigatorPlatform('iPhone', () => {
			assert.equal(platformOf('unknown'), 'macos');
		});
		withNavigatorPlatform('Win32', () => {
			assert.equal(platformOf('unknown'), 'windows');
		});
		withNavigatorPlatform('', () => {
			assert.equal(platformOf('unknown'), 'windows', 'no hint at all is not a Mac');
		});
	});
});

describe('os type fallback', async () => {
	/*
	 * `initOSType` caught a *rejection* and answered `'unknown'`, but a successful
	 * `null` went through `as OSType` into the field. `DEFAULT_FONTS[null]` is
	 * `undefined`, and the constructor reads `.editorFont` off it on the next line
	 * — so the store threw while starting, before any setting had been applied.
	 *
	 * The shipped app cannot reach it: the Rust command always answers a string.
	 * It surfaced in #635, where the vitest move began booting the real singleton
	 * against a bridge stub that answered `null` to everything, and the fix there
	 * was to correct the two stubs. This closes the store's half.
	 */

	let osTypeAnswer: unknown = 'macos';
	const osTypeBridge = {
		invoke: async (command: string) => (command === 'get_os_type' ? osTypeAnswer : null),
	};
	(window as any).__TAURI_INTERNALS__ = osTypeBridge;
	// Installed again before the tests run: other tests in this file replace the bridge.
	beforeAll(() => {
		(window as any).__TAURI_INTERNALS__ = osTypeBridge;
	});

	const { DEFAULT_FONTS, SettingsStore, isOSType } = await import('../src/lib/stores/settings.svelte.js');

	function bootWith(answer: unknown) {
		osTypeAnswer = answer;
		localStorage.clear();
		const store = new SettingsStore();
		onTestFinished(() => store.dispose());
		return store;
	}

	test('the guard admits the four the backend can answer with, and nothing else', () => {
		for (const ok of ['macos', 'windows', 'linux', 'unknown']) assert.equal(isOSType(ok), true);
		for (const bad of [null, undefined, '', 'Darwin', 'macOS', 0, {}]) assert.equal(isOSType(bad), false);
	});

	test('a backend that answers null leaves the store on a usable OS type', async () => {
		// THE BUG: `as OSType` put `null` in the field, and the font defaults are
		// indexed by it. Awaiting a macrotask lets the constructor's own
		// `initOSType().then(…)` settle — that continuation is where it threw.
		const store = bootWith(null);
		await new Promise((resolve) => setTimeout(resolve, 0));
		flushSync();

		assert.equal(store.osType, 'unknown');
		assert.equal(store.editorFont, DEFAULT_FONTS.unknown.editorFont);
		assert.equal(store.previewFont, DEFAULT_FONTS.unknown.previewFont);
		assert.equal(store.codeFont, DEFAULT_FONTS.unknown.codeFont);
	});

	test('a string the union does not contain is treated the same way', async () => {
		// A future backend answering `'Darwin'` is the same defect wearing a string:
		// it typechecks through a cast and indexes to `undefined` just as well.
		const store = bootWith('Darwin');
		await new Promise((resolve) => setTimeout(resolve, 0));
		flushSync();

		assert.equal(store.osType, 'unknown');
		assert.equal(store.editorFont, DEFAULT_FONTS.unknown.editorFont);
	});

	test('a real answer is still honoured', async () => {
		const store = bootWith('macos');
		await new Promise((resolve) => setTimeout(resolve, 0));
		flushSync();

		assert.equal(store.osType, 'macos');
		assert.equal(store.editorFont, DEFAULT_FONTS.macos.editorFont);
	});
});

describe('modal backdrop', () => {
	test('modal backdrop consumes context-menu events outside text fields', () => {
		const backdrop = document.createElement('div');
		backdrop.innerHTML = '<div class="modal-content"><p>Rename</p><input /><textarea></textarea></div>';
		document.body.append(backdrop);
		onTestFinished(() => backdrop.remove());
		backdrop.addEventListener('contextmenu', handleModalBackdropContextMenu);
		let reachedDocument = 0;
		const count = () => reachedDocument++;
		document.addEventListener('contextmenu', count);
		onTestFinished(() => document.removeEventListener('contextmenu', count));

		const rightClick = (target: Element) => {
			const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
			target.dispatchEvent(event);
			return event.defaultPrevented;
		};

		// No native menu over the dialog, and the app's own menus never hear it.
		assert.equal(rightClick(backdrop.querySelector('p')!), true);
		assert.equal(rightClick(backdrop), true);
		assert.equal(reachedDocument, 0);

		// The prompt input keeps the webview's Cut/Copy/Paste.
		assert.equal(rightClick(backdrop.querySelector('input')!), false);
		assert.equal(rightClick(backdrop.querySelector('textarea')!), false);
		assert.equal(reachedDocument, 2);
	});
});
