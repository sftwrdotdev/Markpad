import assert from 'node:assert/strict';

import { flushSync } from 'svelte';
import { onTestFinished, test } from 'vitest';

// The popover module imports the stores, so the Tauri bridge is stubbed first.
(window as any).__TAURI_INTERNALS__ = {
	metadata: { currentWindow: { label: 'main' }, currentWebview: { windowLabel: 'main', label: 'main' } },
	invoke: (cmd: string) => Promise.resolve(cmd === 'get_os_type' ? 'macos' : null),
	transformCallback: (fn: unknown) => fn,
};

const { TitleBarPopovers } = await import('../src/lib/stores/titleBarPopovers.svelte.js');
const { runeEffect } = await import('./runeEffect.svelte.js');

test('titlebar menus close before a document context menu opens', () => {
	// A right-click in the document, or the window losing focus, must not leave a
	// Home, theme or kebab menu drawn over the context menu that opens next.
	for (const type of ['contextmenu', 'blur']) {
		const target = new EventTarget();
		const bar = new TitleBarPopovers();
		onTestFinished(runeEffect(() => bar.listenForDismiss(target)));
		for (const menu of ['homeMenuOpen', 'themeMenuOpen', 'kebabMenuOpen'] as const) {
			bar[menu] = true;
			flushSync();

			target.dispatchEvent(new Event(type));
			flushSync();

			assert.equal(bar[menu], false, `\`${type}\` left the ${menu.replace('Open', '')} open`);
		}
	}
});

test('TitleBar decides the platform from settings.osType, not from the user agent', async () => {
	// The component used to hold `navigator.userAgent.includes('Macintosh')` and
	// derive its chrome, its `native-mac` class and its menu modifier from it.
	const { settings } = await import('../src/lib/stores/settings.svelte.js');
	const { TitleBarPlatform } = await import('../src/lib/stores/titleBarPlatform.svelte.js');
	const navigatorPlatform = Object.getOwnPropertyDescriptor(Navigator.prototype, 'platform');
	const osType = settings.osType;
	Object.defineProperty(navigator, 'platform', { value: 'MacIntel', configurable: true });
	onTestFinished(() => {
		delete (navigator as any).platform;
		if (navigatorPlatform) Object.defineProperty(Navigator.prototype, 'platform', navigatorPlatform);
		settings.osType = osType;
	});

	const chrome = new TitleBarPlatform();
	// The browser says Mac; the backend's answer wins once it is in.
	settings.osType = 'windows';
	assert.equal(chrome.isMac, false);
	assert.equal(chrome.modifier, 'Ctrl');

	// And it stays reactive: `osType` resolves once, after mount.
	settings.osType = 'macos';
	assert.equal(chrome.isMac, true);
	assert.equal(chrome.modifier, 'Cmd');

	// Before the backend answers, the browser hint covers the gap.
	settings.osType = 'unknown';
	assert.equal(chrome.isMac, true);
});
