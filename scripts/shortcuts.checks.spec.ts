import assert from 'node:assert/strict';

import { describe, test } from 'vitest';

import { type KeyContext, type KeyStroke, type ViewerCommand, viewerCommandFor } from '../src/lib/utils/viewerKeymap.js';
import { PLATFORMS, viewerCommandTable } from './keymapHarness.js';

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
