import assert from 'node:assert/strict';

import { flushSync, mount, unmount } from 'svelte';
import { describe, test, vi } from 'vitest';

// Its own file: the `vi.mock` calls below replace the Tauri modules for every
// test in the file.

// #761. An install ends the process without closing the window — the Windows
// updater exits inside `downloadAndInstall`, `relaunch()` requests an exit
// elsewhere — so CloseRequested never fires and nothing reviews unsaved tabs or
// writes the restore snapshot unless the store asks for it first.
const { log, windows, updater } = vi.hoisted(() => ({
	log: [] as string[],
	windows: [{ label: 'main' }],
	updater: { selfUpdateSupported: true, checks: 0 },
}));

vi.mock('@tauri-apps/api/core', () => ({
	invoke: async (cmd: string) =>
		cmd === 'list_viewer_windows' ? windows : cmd === 'self_update_supported' ? updater.selfUpdateSupported : true,
}));
vi.mock('@tauri-apps/api/window', () => ({ getCurrentWindow: () => ({ label: 'main' }) }));
vi.mock('@tauri-apps/api/app', () => ({ getVersion: async () => '2.7.6' }));
vi.mock('@tauri-apps/plugin-updater', () => ({
	check: async () => {
		updater.checks += 1;
		return { version: '2.7.7', body: '', downloadAndInstall: async () => void log.push('install') };
	},
}));
vi.mock('@tauri-apps/plugin-process', () => ({
	relaunch: async () => {
		log.push('relaunch');
		// A real relaunch never returns. Failing here puts the store in a phase
		// `close()` can leave, so the next test starts from a clean offer.
		throw new Error('no process to restart');
	},
}));

const { updateStore } = await import('../src/lib/stores/update.svelte.js');
const { default: UpdateDialog } = await import('../src/lib/components/UpdateDialog.svelte');
const { settings } = await import('../src/lib/stores/settings.svelte.js');
const { t } = await import('../src/lib/utils/i18n.js');

describe('an update settles the window before it installs', () => {
	async function offered() {
		updateStore.close();
		log.length = 0;
		await updateStore.runCheck();
		assert.equal(updateStore.phase, 'available');
	}

	function settleAnswering(answer: boolean) {
		return async () => {
			// Resolves a macrotask later, so a store that starts the install without
			// waiting would log it first.
			await new Promise((resolve) => setTimeout(resolve, 0));
			log.push('settled');
			return answer;
		};
	}

	test('the install starts only once the window has settled', async () => {
		await offered();
		await updateStore.startDownload(settleAnswering(true));
		assert.deepEqual(log, ['settled', 'install', 'relaunch']);
	});

	test('backing out of the review installs nothing, and leaves the update on offer', async () => {
		await offered();
		await updateStore.startDownload(settleAnswering(false));
		assert.deepEqual(log, ['settled']);
		assert.equal(updateStore.phase, 'available');

		await updateStore.startDownload(settleAnswering(true));
		assert.deepEqual(log, ['settled', 'settled', 'install', 'relaunch'], 'and it can still be installed');
	});

	// #767. The install ends every window, and only the one it starts from reviews
	// its tabs, so another open window has to close first.
	test('with another window open, nothing is reviewed or installed until it has closed', async () => {
		await offered();
		windows.push({ label: 'window-abc' });
		try {
			await updateStore.startDownload(settleAnswering(true));
			assert.deepEqual(log, []);
			assert.equal(updateStore.phase, 'available', 'the update stays on offer');
			assert.deepEqual(
				updateStore.otherWindows.map((window) => window.label),
				['window-abc'],
				'and the dialog can name the window in the way',
			);
		} finally {
			windows.pop();
		}

		await updateStore.startDownload(settleAnswering(true));
		assert.deepEqual(log, ['settled', 'install', 'relaunch'], 'once it has closed, the install goes ahead');
		assert.equal(updateStore.otherWindows.length, 0);
	});
});

describe('package-managed installs', () => {
	test('the updater asks whether it can install before it checks', async () => {
		// #570. A `.deb`, `.rpm` or snap install passes the check and then fails at
		// install time. The question is asked first, so such an install is never
		// offered an update, and the check is not even made.
		updateStore.close();
		updater.checks = 0;
		updater.selfUpdateSupported = false;
		try {
			await updateStore.runCheck();
			assert.equal(updateStore.phase, 'package-managed');
			assert.equal(updater.checks, 0);
		} finally {
			updater.selfUpdateSupported = true;
			updateStore.close();
		}

		await updateStore.runCheck();
		assert.equal(updateStore.phase, 'available', 'a self-updating install still checks');
		assert.equal(updater.checks, 1);
	});
});

describe('the update dialog', () => {
	// jsdom has no Web Animations, and the dialog's out transition calls
	// `element.animate`. An animation that never finishes is enough here: the
	// assertions read the store and the DOM, not the fade.
	Element.prototype.animate ??= function () {
		return { cancel() {}, playState: 'finished', effect: null, onfinish: null } as unknown as Animation;
	};
	const tk = (key: string) => t(`update.${key}`, settings.language);

	function mountDialog() {
		const target = document.createElement('div');
		document.body.append(target);
		const dialog = mount(UpdateDialog, { target, props: { settleForExit: async () => true }, intro: false });
		flushSync();
		return {
			target,
			[Symbol.dispose]() {
				unmount(dialog);
				target.remove();
				updateStore.close();
			},
		};
	}

	test('the dialog can render the phase, and can be dismissed from it', () => {
		// A phase the store can enter but the dialog cannot draw is a blank modal
		// with no way out — the footer branch matters as much as the body one.
		updateStore.close();
		updateStore.show = true;
		updateStore.phase = 'package-managed';
		using view = mountDialog();
		const { target } = view;

		assert.equal(target.querySelector('#update-title')?.textContent?.trim(), tk('packageManagedHeader'));
		assert.equal(target.querySelector('#update-body')?.textContent?.trim(), tk('packageManagedBody'));
		const buttons = [...target.querySelectorAll<HTMLButtonElement>('.update-footer button')];
		assert.deepEqual(buttons.map((b) => b.textContent?.trim()), [tk('ok')]);

		buttons[0].click();
		flushSync();
		assert.equal(updateStore.show, false, 'OK dismisses the dialog');
	});

	test('the dialog promises reopened tabs only when restore is on', () => {
		// With "Restore windows on launch" off nothing writes the snapshot, so the
		// relaunched app opens empty and must not have been told otherwise.
		const restore = settings.restoreStateOnReopen;
		try {
			for (const on of [true, false]) {
				settings.restoreStateOnReopen = on;
				updateStore.close();
				updateStore.show = true;
				updateStore.phase = 'available';
				updateStore.otherWindows = [{ label: 'window-abc' } as any];
				using view = mountDialog();
				const alert = view.target.querySelector('.other-windows')?.textContent ?? '';
				assert.ok(alert.includes(tk('closeOtherWindows')), 'the other windows are named either way');
				assert.equal(alert.includes(tk('reopensTabs')), on, `restore ${on ? 'on' : 'off'}`);
			}
		} finally {
			settings.restoreStateOnReopen = restore;
		}
	});
});
