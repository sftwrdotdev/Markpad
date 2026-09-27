import assert from 'node:assert/strict';
import { test } from 'vitest';

import {
	canUsePreviewWidthShortcut,
	viewerCommandFor,
	type KeyContext,
	type KeyStroke,
	type ViewerCommand,
} from '../src/lib/utils/viewerKeymap.js';
import { PLATFORMS, viewerCommandTable } from './keymapHarness.js';

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

test('Ctrl+Q quits the way the menu’s Exit does, not by closing one window', () => {
	// The menu prints Ctrl+Q beside Exit, and Exit runs `appExit`, which closes
	// every window. The chord used to run `getCurrentWindow().close()`, so with
	// two windows open it closed one and left the app running.
	assert.match(viewerCommandTable()['app-exit'], /\bappExit\(\)/);
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

test('every command the dispatcher can name is one the component can run', () => {
	// The seam's own contract, and the reason `runViewerCommand` is a switch over
	// a union rather than a lookup in a map: the compiler rejects a case for a
	// command that does not exist, and this rejects a command with no case.
	const table = viewerCommandTable();
	const reachable = new Set<ViewerCommand>();
	for (const platform of PLATFORMS) {
		for (const key of 'abcdefghijklmnopqrstuvwxyz0123456789'.split('')) {
			for (const ctrlKey of [false, true]) {
				for (const shiftKey of [false, true]) {
					const command = viewerCommandFor(chord(key, `Key${key.toUpperCase()}`, { ctrlKey, shiftKey }), {
						...READING,
						osType: platform.osType as KeyContext['osType'],
					});
					if (command) reachable.add(command);
				}
			}
		}
	}
	assert.ok(reachable.size >= 10, `only ${reachable.size} commands were reached; the sweep is not running`);
	for (const command of reachable) assert.ok(table[command], `runViewerCommand has no case for ${command}`);
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
