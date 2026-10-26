import assert from 'node:assert/strict';

import { flushSync } from 'svelte';
import { afterEach, describe, onTestFinished, test, vi } from 'vitest';

import { createSettingsOpen } from '../src/lib/utils/settingsOpen.svelte.js';
import { runeEffect } from './runeEffect.svelte.js';
import { runeProps } from './runeProps.svelte.js';

/*
 * Task 5: the settings dialog restores focus to whatever opened it.
 *
 * Two versions of the open effect re-entered themselves. One read `appVersion`
 * (`if (!appVersion)`) and the version promise wrote it; the other kept the
 * fonts' `loaded` flag as `$state`, read before the await and written after it.
 * Either way the effect re-ran once the promise settled and re-captured
 * `previousActiveElement`, which by then was a control inside the dialog, so
 * closing Settings left focus in the dialog instead of on its opener.
 *
 * Own file: it replaces the Tauri bridge with one whose answers the test settles.
 */
describe('settings dialog open', () => {
	afterEach(() => {
		vi.useRealTimers();
		document.body.replaceChildren();
	});

	function bridge() {
		const calls: string[] = [];
		const pending = new Map<string, (value: unknown) => void>();
		(window as any).__TAURI_INTERNALS__ = {
			invoke: (cmd: string) => {
				calls.push(cmd);
				return new Promise((resolve) => pending.set(cmd, resolve));
			},
			transformCallback: () => 0,
		};
		return {
			calls,
			async settle(cmd: string, value: unknown) {
				pending.get(cmd)?.(value);
				for (let i = 0; i < 5; i++) await Promise.resolve();
				flushSync();
			},
		};
	}

	test('the open effect neither reads the app version nor re-enters itself', async () => {
		vi.useFakeTimers();
		const tauri = bridge();
		const opener = document.body.appendChild(document.createElement('button'));
		const modal = document.body.appendChild(document.createElement('div'));
		const inside = modal.appendChild(document.createElement('button'));
		const props = runeProps({ open: false });
		let opened = 0;
		let dialog!: ReturnType<typeof createSettingsOpen>;
		onTestFinished(
			runeEffect(() => {
				dialog = createSettingsOpen({ isOpen: () => props.open, modal: () => modal, onOpen: () => opened++ });
			}),
		);

		opener.focus();
		props.open = true;
		flushSync();
		vi.advanceTimersByTime(50);
		assert.equal(document.activeElement, inside, 'opening moves focus into the dialog');

		await tauri.settle('get_system_fonts', ['Menlo']);
		await tauri.settle('plugin:app|version', '9.9.9');
		assert.deepEqual(dialog.systemFonts, ['Menlo']);
		assert.equal(dialog.appVersion, '9.9.9');
		assert.equal(opened, 1, 'the effect ran again once the fonts or the version arrived');

		props.open = false;
		flushSync();
		assert.equal(document.activeElement, opener, 'closing returns focus to the control that opened Settings');

		props.open = true;
		flushSync();
		assert.equal(opened, 2);
		assert.deepEqual(
			tauri.calls.filter((cmd) => cmd !== 'get_saved_vscode_themes'),
			['get_system_fonts', 'plugin:app|version'],
			'a second open fetches neither the fonts nor the version again',
		);
	});
});
