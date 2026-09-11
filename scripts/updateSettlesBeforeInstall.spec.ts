import assert from 'node:assert/strict';

import { test, vi } from 'vitest';

// #761. An install ends the process without closing the window — the Windows
// updater exits inside `downloadAndInstall`, `relaunch()` requests an exit
// elsewhere — so CloseRequested never fires and nothing reviews unsaved tabs or
// writes the restore snapshot unless the store asks for it first.
const { log, windows } = vi.hoisted(() => ({ log: [] as string[], windows: [{ label: 'main' }] }));

vi.mock('@tauri-apps/api/core', () => ({
	invoke: async (cmd: string) => (cmd === 'list_viewer_windows' ? windows : true),
}));
vi.mock('@tauri-apps/api/window', () => ({ getCurrentWindow: () => ({ label: 'main' }) }));
vi.mock('@tauri-apps/api/app', () => ({ getVersion: async () => '2.7.6' }));
vi.mock('@tauri-apps/plugin-updater', () => ({
	check: async () => ({ version: '2.7.7', body: '', downloadAndInstall: async () => void log.push('install') }),
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
