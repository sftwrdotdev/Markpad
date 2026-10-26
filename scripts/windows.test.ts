import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { reviewDirtyTabs, type ReviewTab } from '../src/lib/sessions/closeReview.js';
import { pinnedTagFromWindowLabel, pinnedWindowToken } from '../src/lib/utils/pinnedTagWindow.js';
import { readSource } from './sourceTree.js';

// Window close (issue #189): instead of one aggregate "you have N unsaved
// files" modal, the red close button walks the dirty tabs one at a time —
// activating each and showing the SAME localized unsaved-changes dialog a
// single tab close shows (canCloseTab). Cancel stops the walk; the window
// stays open with the remaining tabs.
describe('closing a window walks its dirty tabs', () => {
	/**
	 * A window of tabs the walk can be run against, with every collaborator
	 * recorded. `answers` is what the dialog returns for each tab it is shown, in
	 * order; anything not listed is a save.
	 */
	function window_(paths: string[], answers: Record<string, boolean> = {}) {
		const tabs = paths.map((path, i) => ({ id: `t${i}`, path, isDirty: true }));
		const log: string[] = [];
		const review = {
			nextDirtyTab: () => tabs.find((t) => t.isDirty) as ReviewTab | undefined,
			setActive: (id: string) => void log.push(`active:${id}`),
			settle: async () => {},
			canCloseTab: async (id: string) => {
				log.push(`ask:${id}`);
				const answer = answers[id] ?? true;
				// Saving resolves the tab; cancelling leaves it as it was.
				if (answer) tabs.find((t) => t.id === id)!.isDirty = false;
				return answer;
			},
			closeTab: (id: string) => {
				log.push(`close:${id}`);
				const at = tabs.findIndex((t) => t.id === id);
				if (at !== -1) tabs.splice(at, 1);
			},
			shouldCloseAfterResolving: (_tab: ReviewTab) => true,
		};
		return { tabs, log, review };
	}

	test('every dirty tab is activated, asked about, and then closed, one at a time', async () => {
		const { log, review } = window_(['/a.md', '/b.md']);

		assert.equal(await reviewDirtyTabs(review), true, 'the walk completes');
		assert.deepEqual(log, ['active:t0', 'ask:t0', 'close:t0', 'active:t1', 'ask:t1', 'close:t1']);
	});

	test('the tab is activated before it is asked about', async () => {
		// The dialog names one document. A reader looking at a different one
		// cannot tell which file they are being asked to save.
		const { log, review } = window_(['/a.md']);
		await reviewDirtyTabs(review);

		assert.ok(log.indexOf('active:t0') < log.indexOf('ask:t0'));
	});

	test('cancelling stops the walk, and the tabs after it are never touched', async () => {
		const { tabs, log, review } = window_(['/a.md', '/b.md', '/c.md'], { t1: false });

		assert.equal(await reviewDirtyTabs(review), false, 'the caller is told to keep the window open');
		assert.deepEqual(log, ['active:t0', 'ask:t0', 'close:t0', 'active:t1', 'ask:t1']);
		assert.deepEqual(tabs.map((t) => t.path), ['/b.md', '/c.md'], 'the unreviewed tabs are still open');
	});

	test('a tab that becomes dirty again during the walk is reviewed again', async () => {
		// The list is re-consulted every round rather than captured up front: a
		// save can leave a tab dirty again, and tabs can be opened or closed while
		// a dialog is up. A stale list walks past unsaved work.
		const { tabs, review } = window_(['/a.md']);
		let redirtied = false;
		const once = review.canCloseTab;
		review.canCloseTab = async (id: string) => {
			const answer = await once(id);
			if (!redirtied) {
				redirtied = true;
				tabs.push({ id: 'late', path: '/late.md', isDirty: true });
			}
			return answer;
		};
		review.shouldCloseAfterResolving = () => false;

		await reviewDirtyTabs(review);

		assert.deepEqual(tabs.filter((t) => t.isDirty), [], 'the tab that appeared mid-walk was reviewed too');
	});

	test('a resolved tab is kept open when the window state is about to be snapshotted', async () => {
		const { tabs, log, review } = window_(['/a.md']);
		review.shouldCloseAfterResolving = (tab: ReviewTab) => tab.path === '';

		assert.equal(await reviewDirtyTabs(review), true);
		assert.deepEqual(log, ['active:t0', 'ask:t0'], 'resolved, not closed');
		assert.equal(tabs.length, 1);
	});
});

describe('a pinned group travels in its window label', () => {
	test('a pinned group name survives the trip through a window label', () => {
		for (const name of ['work', '文献管理', 'a b/c:d-1', '🎬 movie']) {
			const label = `window-${pinnedWindowToken(name, 42)}`;
			assert.match(label, /^[A-Za-z0-9\-/:_]+$/, `Tauri label charset for ${name}`);
			assert.equal(pinnedTagFromWindowLabel(label), name);
		}
	});

	test('other windows are not read as pinned groups', () => {
		for (const label of ['main', 'window-3f2a9c', 'window-pinned--1', 'window-pinned-abc-1', 'window-pinned-6869']) {
			assert.equal(pinnedTagFromWindowLabel(label), null, label);
		}
	});
});

describe('window title capability', () => {
	test('all Markpad windows may update their native title', () => {
		const capability = JSON.parse(readSource('src-tauri/capabilities/default.json')) as { permissions: unknown[] };
		assert.ok(
			capability.permissions.includes('core:window:allow-set-title'),
			'window tags and active document names call appWindow.setTitle(), which requires this permission',
		);
	});
});
