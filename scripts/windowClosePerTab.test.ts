import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import test from 'node:test';

import { reviewDirtyTabs, type ReviewTab } from '../src/lib/sessions/closeReview.js';
import { offsetOf, readSource, sliceBetween, sliceFrom } from './sourceTree.js';

const viewer = readSource('src/lib/MarkdownViewer.svelte');
const documentSessionPath = 'src/lib/sessions/documentSession.svelte.ts';
const documentSession = existsSync(documentSessionPath) ? readSource(documentSessionPath) : '';

// Window close (issue #189): instead of one aggregate "you have N unsaved
// files" modal, the red close button walks the dirty tabs one at a time —
// activating each and showing the SAME localized unsaved-changes dialog a
// single tab close shows (canCloseTab). Cancel stops the walk; the window
// stays open with the remaining tabs.

function closeHandler(): string {
	return sliceBetween(viewer, 'appWindow.onCloseRequested', 'onDragDropEvent');
}

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

test('the aggregate unsaved-files modal is gone from the close handler', () => {
	const handler = closeHandler();
	assert.doesNotMatch(handler, /youHaveUnsavedFiles/);
	// and the old "clear all dirty flags then close" discard path with it.
	// Pinned as the assignment rather than as the `forEach` one-liner it was
	// written in: the same silent discard spelled `for (const t of
	// tabManager.tabs) t.isDirty = false;` passed the old regex, and the walk
	// below then found nothing to review.
	assert.doesNotMatch(handler, /\.isDirty\s*=\s*false/);
});

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

test('the close is prevented synchronously before the walk starts', () => {
	const handler = closeHandler();
	const branchStart = offsetOf(handler, 'if (dirtyTabs.length > 0) {');
	const prevent = offsetOf(handler, 'event.preventDefault()', branchStart);
	const walk = offsetOf(handler, 'reviewDirtyTabs({', branchStart);
	assert.ok(prevent < walk, 'the close is prevented before the walk starts');
});

test('the window closes only after every dirty tab is resolved', () => {
	const handler = closeHandler();
	const walk = offsetOf(handler, 'reviewDirtyTabs({');
	const close = offsetOf(handler, 'appWindow.close()', walk);
	assert.ok(walk < close, 'the window closes after the walk, not during it');
});

test('a cancelled walk stops the handler before it persists or closes', () => {
	const handler = closeHandler();
	const walk = offsetOf(handler, 'reviewDirtyTabs({');
	const bail = offsetOf(handler, 'if (!resolved) return;', walk);
	assert.ok(bail < offsetOf(handler, 'persistWindowState()', walk), 'cancel returns before the snapshot');
	assert.ok(bail < offsetOf(handler, 'appWindow.close()', walk), 'and before the close is re-triggered');
});

test('a second close request cannot start a competing walk', () => {
	const handler = closeHandler();
	// The native red button bypasses the dialog overlay; re-entry must be
	// swallowed while a walk is active, or two walks fight over setActive
	// and the highlighted tab stops matching the dialog.
	assert.match(handler, /if \(isCloseWalkActive\) \{\s*event\.preventDefault\(\);\s*return;\s*\}/);
	// and the flag is always released, even when the user cancels mid-walk
	assert.match(handler, /finally \{\s*isCloseWalkActive = false;\s*\}/);
});

test('the walk proceeds in strict tab-strip order', () => {
	// Which tab is next is the component's half of the walk: the order comes
	// from the tab array, and an active-first shortcut made the sequence look
	// random to the reader. The walking itself is covered above.
	const handler = closeHandler();
	assert.match(handler, /nextDirtyTab: \(\) => tabManager\.tabs\.find\(\(t\) => t\.isDirty\)/);
	assert.doesNotMatch(handler, /active\?\.isDirty/);
});

test('the untitled save dialog prefills the numbered tab title', () => {
	const scope = sliceBetween(documentSession, 'async function saveContent', 'async function saveContentAs');
	assert.match(scope, /defaultPath: tab\.title/);
});

test('save-as keeps snapshot-based dirty tracking in documentSession', () => {
	const fn = sliceFrom(documentSession, 'async function saveContentAs');
	assert.match(fn, /const snapshot = tab\.rawContent;/);
	assert.match(fn, /tab\.isDirty = tab\.rawContent !== snapshot;/);
});

test('the restore-on-reopen branch persists window state via the shared helper', () => {
	const handler = closeHandler();
	assert.match(handler, /persistWindowState\(\);/);
	// no durable-write experiment left behind
	assert.doesNotMatch(viewer, /saveSessionState|sessionState\.js/);
});
