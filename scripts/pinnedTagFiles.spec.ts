import assert from 'node:assert/strict';

import { flushSync, mount, unmount } from 'svelte';
import { test } from 'vitest';

(window as any).__TAURI_INTERNALS__ = {
	metadata: { currentWindow: { label: 'main' }, currentWebview: { windowLabel: 'main', label: 'main' } },
	invoke: () => Promise.resolve(null),
};

const { default: HomePage } = await import('../src/lib/components/HomePage.svelte');

test('right-clicking a pinned group lists its files, with folders for duplicate names', () => {
	const loaded: string[] = [];
	const files = ['/skills/alpha/SKILL.md', '/skills/beta/SKILL.md', '/notes/todo.md'];
	const target = document.createElement('div');
	document.body.append(target);
	const home = mount(HomePage, {
		target,
		props: {
			recentFiles: [],
			pinnedTags: [{ name: 'work', color: '#f00', files }],
			onselectFile: () => {},
			onloadFile: (file: string) => loaded.push(file),
			onremoveRecentFile: () => {},
			onnewFile: () => {},
		},
	});
	flushSync();

	let documentMenuOpened = false;
	document.addEventListener('contextmenu', () => (documentMenuOpened = true), { once: true });
	const card = [...target.querySelectorAll('.recent-card')].find((el) => el.textContent?.includes('work'))!;
	card.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 10, clientY: 10 }));
	flushSync();

	const rows = [...target.querySelectorAll('.menu-item')].map((el) => el.textContent?.replace(/\s+/g, ' ').trim());
	assert.deepEqual(rows, ['SKILL.md alpha', 'SKILL.md beta', 'todo.md'], 'one row per file, same names told apart by folder');
	assert.equal(documentMenuOpened, false, 'the preview context menu must not open on top');

	(target.querySelectorAll('.menu-item')[1] as HTMLButtonElement).click();
	flushSync();
	assert.deepEqual(loaded, ['/skills/beta/SKILL.md'], 'clicking a row opens that file');
	assert.equal(target.querySelector('.menu-item'), null, 'and closes the menu');

	unmount(home);
	target.remove();
});
