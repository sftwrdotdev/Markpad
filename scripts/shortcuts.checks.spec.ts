import assert from 'node:assert/strict';

import { describe, test } from 'vitest';

import { type KeyContext, type KeyStroke, type ViewerCommand, viewerCommandFor } from '../src/lib/utils/viewerKeymap.js';
import { PLATFORMS, viewerCommandTable } from './keymapHarness.js';
import { readSource } from './sourceTree.js';

describe('viewer keymap', () => {
	/*
	 * The document-level dispatcher, called rather than read.
	 *
	 * `shortcuts.test.ts` and `shortcuts.checks.test.ts` already sweep
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

	test('Ctrl+Q quits the way the menu’s Exit does, not by closing one window', () => {
		// The menu prints Ctrl+Q beside Exit, and Exit runs `appExit`, which closes
		// every window. The chord used to run `getCurrentWindow().close()`, so with
		// two windows open it closed one and left the app running.
		assert.match(viewerCommandTable()['app-exit'], /\bappExit\(\)/);
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

	// ------------------------------------------- the title bar reads that source

	test('TitleBar decides the platform from settings.osType, not from the user agent', () => {
		// Structural, and red against master: the component held
		// `navigator.userAgent.includes('Macintosh')` and derived its chrome, its
		// `native-mac` class and its menu modifier from it. What has to hold is that
		// the platform enters this component through `platformOf(settings.osType)` and
		// that every consumer inside it comes off that one value — spell the locals
		// however you like.
		const titleBar = readSource('src/lib/components/TitleBar.svelte');

		const source = titleBar.match(/let (\w+) = \$derived\([^\n]*platformOf\(settings\.osType\)\)/);
		assert.ok(source, 'the platform is derived from platformOf(settings.osType)');

		assert.match(
			titleBar,
			new RegExp(`let (\\w+) = \\\$derived\\(${source![1]} === 'macos'\\)`),
			'the mac test reads that value rather than asking the browser again',
		);
		assert.match(
			titleBar,
			new RegExp(`let (\\w+) = \\\$derived\\(modifierFor\\(${source![1]}\\)\\)`),
			'the menu modifier comes from the same value, through modifierFor',
		);

		// `$derived` and not a plain const: `settings.osType` changes once, after
		// mount. At a const the title bar would keep the fallback's verdict forever.
		assert.doesNotMatch(titleBar, /const \w+ = platformOf\(/, 'the platform must stay reactive');
	});
});
