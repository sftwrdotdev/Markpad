import assert from 'node:assert/strict';

import { test } from 'vitest';

import { readSource } from './sourceTree.js';

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
