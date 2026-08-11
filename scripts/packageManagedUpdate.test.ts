import assert from 'node:assert/strict';
import test from 'node:test';

import { readRustBackend, readSource, sliceBetween } from './sourceTree.js';

const store = readSource('src/lib/stores/update.svelte.ts');
const dialog = readSource('src/lib/components/UpdateDialog.svelte');
const rust = readRustBackend();
const i18n = readSource('src/lib/utils/i18n.ts');

// A `.deb`, `.rpm` or snap install cannot replace its own binary, but it used
// to be offered an update anyway: the check succeeds, because latest.json
// publishes `linux-x86_64` and every Linux build asks for exactly that key, and
// the install then fails against `/usr/bin/Markpad` or a read-only squashfs.
// See #570. These assertions hold the shape of the fix, which is an ordering
// property more than a code property.

test('the updater asks whether it can install before it checks', () => {
	// The whole defect is a sequence: check first, discover the impossibility
	// second. Asserting that both calls exist would pass on the broken order,
	// so the assertion is where they sit relative to each other.
	const runCheck = sliceBetween(store, 'async runCheck()', 'async startDownload()');
	const gate = runCheck.indexOf("invoke<boolean>('self_update_supported')");
	const checkCall = runCheck.indexOf('await check()');
	assert.ok(gate !== -1, 'runCheck must ask self_update_supported');
	assert.ok(checkCall !== -1, 'runCheck must still call check() when self-update is possible');
	assert.ok(
		gate < checkCall,
		'self_update_supported must be consulted before check(), or the user is offered an update that cannot be installed',
	);
});

test('the command exists on the Rust side and is reachable', () => {
	// A Tauri command is addressed by a string, so nothing in the type system
	// connects the two halves: an unregistered command fails at runtime, and
	// this flow's runtime is a Linux package nobody on this project runs daily.
	assert.match(rust, /fn self_update_supported\(app: AppHandle\) -> bool/);
	const handler = sliceBetween(rust, 'tauri::generate_handler![', '])');
	assert.match(handler, /self_update_supported/);
});

test('only Linux is gated', () => {
	// Windows runs the downloaded NSIS installer rather than overwriting
	// anything in place, and macOS is the one platform where bundle_type()
	// answers without the build-time patch. Gating either would break a working
	// updater for 95% of downloads.
	const command = sliceBetween(rust, 'fn self_update_supported', '\nfn get_os_type');
	assert.match(command, /#\[cfg\(target_os = "linux"\)\]/);
	assert.match(command, /appimage\.is_some\(\)/);
	assert.match(command, /#\[cfg\(not\(target_os = "linux"\)\)\]/);
	// Read through tauri's Env, which also verifies the executable is under
	// $TMPDIR/.mount_. `std::env::var("APPIMAGE")` alone is settable by hand.
	assert.doesNotMatch(command, /env::var/);
});

test('the dialog can render the phase, and can be dismissed from it', () => {
	// A phase the store can enter but the dialog cannot draw is a blank modal
	// with no way out — the footer branch matters as much as the body one.
	assert.match(dialog, /packageManagedHeader/);
	assert.match(dialog, /packageManagedBody/);
	const footer = sliceBetween(dialog, '<div class="update-footer">', '</div>\n\t\t</div>');
	assert.match(footer, /phase === 'package-managed'/);
});

test('the new strings are translated wherever the rest of this dialog is', () => {
	// The update dialog is only translated into four of the app's 26 languages;
	// the other 22 fall back to English for all of it. Matching that set exactly
	// is the point: fewer would leave a hole, and more would put two localised
	// lines in a dialog that is otherwise English.
	const dialogKey = 'upToDateHeader';
	const languages = i18n.split('\n').filter((l) => l.includes(`${dialogKey}:`)).length;
	for (const key of ['packageManagedHeader', 'packageManagedBody']) {
		assert.equal(
			i18n.split('\n').filter((l) => l.includes(`${key}:`)).length,
			languages,
			`${key} must be defined in the same languages as ${dialogKey}`,
		);
	}
});
