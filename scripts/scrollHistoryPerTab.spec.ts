/**
 * The preview's in-page back/forward stacks belong to the document they were
 * measured in.
 *
 * They hold raw `markdownBody.scrollTop` pixels — where the reader was standing
 * before each anchor jump — and the viewer held ONE pair for the whole window.
 * Nothing emptied it on a tab switch, and a tab switch reloads nothing, so a
 * jump in a long document left an offset behind that the next mouse-back in
 * whatever tab the reader landed on would scroll to. A long document followed
 * by a short one is the visible case: the short one has no such offset to be
 * at, so it goes as far as it can and stops somewhere the reader has never
 * been. The only reset was `resetScrollHistory`, an option of `loadMarkdown`,
 * which fires for a document LOAD and not for a switch.
 *
 * These stacks are not `Tab.history`/`historyIndex`, which is the FILE the tab
 * points at and is what the mouse falls through to when there is no jump left
 * to undo. Both are exercised below, because the fall-through is the half a
 * per-tab stack changes: a tab with a stale offset never reached it.
 *
 * Everything here runs the REAL `TabManager` — the same `pushScrollHistory`,
 * `popScrollHistoryBack` and `popScrollHistoryForward` the viewer calls, the
 * real `navigate`/`goBack`/`goForward`, the real serialization and the real
 * cross-window snapshot. Nothing asserts on the text of an implementation file.
 *
 * WHAT IS NOT THE REAL THING, AND WHY. `handleMouseUp` lives in
 * MarkdownViewer.svelte and is not exported; `mouseButton` below is its three
 * lines, restated. What it stands in for is one `markdownBody.scrollTop` read —
 * jsdom has no layout, so the offsets here are supplied rather than measured,
 * which is also why this file asks "which offset comes back" and never "where
 * does the preview end up".
 */

import assert from 'node:assert/strict';

import { test } from 'vitest';

// The runes are the compiler's, not ours: vitest builds `.svelte.ts` through the
// Svelte plugin. Only the Tauri backend is stubbed — importing the store boots
// the settings singleton, which asks for the OS type.
(window as any).__TAURI_INTERNALS__ = {
	metadata: { currentWindow: { label: 'main' }, currentWebview: { windowLabel: 'main', label: 'main' } },
	invoke: (cmd: string) => Promise.resolve(cmd === 'get_os_type' ? 'macos' : null),
};

const { tabManager } = await import('../src/lib/stores/tabs.svelte.js');
const { snapshotTab, buildTransferredTab } = await import('../src/lib/utils/tabTransfer.js');

// ------------------------------------------------------------------ the wiring

type Direction = 'back' | 'forward';

/**
 * What the mouse's back and forward buttons do, as `handleMouseUp` wires them:
 * pop the tab's in-page stack first, and move to another DOCUMENT only when
 * that tab has no jump left to walk. `at` is where the reader is standing,
 * which the viewer reads off the preview container.
 */
function mouseButton(direction: Direction, at: number): { scrolledTo: number } | { openedFile: string | null } {
	const id = tabManager.activeTabId!;
	const pos =
		direction === 'back'
			? tabManager.popScrollHistoryBack(id, at)
			: tabManager.popScrollHistoryForward(id, at);
	if (pos !== null) return { scrolledTo: pos };
	return { openedFile: direction === 'back' ? tabManager.goBack(id) : tabManager.goForward(id) };
}

/** An anchor jump: the reader was at `at`, and is about to be somewhere else. */
function jumpFrom(at: number) {
	tabManager.pushScrollHistory(tabManager.activeTabId!, at);
}

function reset() {
	tabManager.closeAll();
	tabManager.recentlyClosed.length = 0;
}

const stackOf = (id: string) => tabManager.tabs.find((t) => t.id === id)!.scrollHistory;
const futureOf = (id: string) => tabManager.tabs.find((t) => t.id === id)!.scrollFuture;

/** A long document and a short one, a jump made in the long one, landing on the short. */
function jumpInLongThenSwitchToShort() {
	reset();
	tabManager.addTab('/notes/long.md', '# Long\n');
	const long = tabManager.activeTabId!;
	tabManager.addTab('/notes/short.md', '# Short\n');
	const short = tabManager.activeTabId!;

	tabManager.setActive(long);
	jumpFrom(8400);

	tabManager.setActive(short);
	return { long, short };
}

// ------------------------------------------------- the switch the bug was about

test('a back click in one document does not scroll to an offset measured in another', () => {
	const { short } = jumpInLongThenSwitchToShort();

	const result = mouseButton('back', 0);

	assert.deepEqual(stackOf(short), []);
	assert.ok(!('scrolledTo' in result), 'the short document has no jump of its own to go back to');
});

test('with no jump of its own, back moves the tab to the previous FILE instead', () => {
	reset();
	tabManager.addTab('/notes/long.md', '# Long\n');
	const long = tabManager.activeTabId!;
	jumpFrom(8400);

	tabManager.addTab('/notes/short.md', '# Short\n');
	const short = tabManager.activeTabId!;
	tabManager.navigate(short, '/notes/other.md');

	assert.deepEqual(mouseButton('back', 0), { openedFile: '/notes/short.md' });
	// ...and the tab that DID jump still has its own offset waiting.
	assert.deepEqual(stackOf(long), [8400]);
});

test('the offset is still there when the reader comes back to the document they jumped in', () => {
	const { long } = jumpInLongThenSwitchToShort();

	tabManager.setActive(long);

	assert.deepEqual(mouseButton('back', 200), { scrolledTo: 8400 });
});

test('forward is per tab too', () => {
	const { long, short } = jumpInLongThenSwitchToShort();

	tabManager.setActive(long);
	mouseButton('back', 200);
	assert.deepEqual(futureOf(long), [200]);

	tabManager.setActive(short);
	assert.deepEqual(futureOf(short), []);
	assert.ok(!('scrolledTo' in mouseButton('forward', 0)));
});

test('two tabs jumped in keep their own offsets, in their own order', () => {
	reset();
	tabManager.addTab('/notes/a.md', '# A\n');
	const a = tabManager.activeTabId!;
	jumpFrom(100);
	jumpFrom(200);

	tabManager.addTab('/notes/b.md', '# B\n');
	const b = tabManager.activeTabId!;
	jumpFrom(900);

	tabManager.setActive(a);
	assert.deepEqual(mouseButton('back', 250), { scrolledTo: 200 });
	assert.deepEqual(mouseButton('back', 200), { scrolledTo: 100 });

	tabManager.setActive(b);
	assert.deepEqual(mouseButton('back', 950), { scrolledTo: 900 });
});

test('an untitled buffer has a stack of its own', () => {
	reset();
	tabManager.addNewTab();
	const untitled = tabManager.activeTabId!;
	jumpFrom(300);

	tabManager.addTab('/notes/a.md', '# A\n');
	assert.deepEqual(stackOf(tabManager.activeTabId!), []);

	tabManager.setActive(untitled);
	assert.deepEqual(mouseButton('back', 400), { scrolledTo: 300 });
});

test('closing a tab takes its offsets with it', () => {
	reset();
	tabManager.addTab('/notes/a.md', '# A\n');
	const a = tabManager.activeTabId!;
	jumpFrom(500);
	tabManager.addTab('/notes/b.md', '# B\n');

	tabManager.closeTab(a);
	tabManager.addTab('/notes/a.md', '# A\n');

	assert.deepEqual(stackOf(tabManager.activeTabId!), []);
});

// ------------------------------------- repointing the tab at another document

test('following a link drops the offsets of the document left behind', () => {
	reset();
	tabManager.addTab('/notes/a.md', '# A\n');
	const a = tabManager.activeTabId!;
	jumpFrom(4000);

	tabManager.navigate(a, '/notes/b.md');

	assert.deepEqual(stackOf(a), []);
	assert.ok(!('scrolledTo' in mouseButton('back', 0)));
});

test('going back to the previous file drops them', () => {
	reset();
	tabManager.addTab('/notes/a.md', '# A\n');
	const a = tabManager.activeTabId!;
	tabManager.navigate(a, '/notes/b.md');
	jumpFrom(4000);

	assert.equal(tabManager.goBack(a), '/notes/a.md');
	assert.deepEqual(stackOf(a), []);
});

test('going forward again drops them', () => {
	reset();
	tabManager.addTab('/notes/a.md', '# A\n');
	const a = tabManager.activeTabId!;
	tabManager.navigate(a, '/notes/b.md');
	tabManager.goBack(a);
	jumpFrom(4000);

	assert.equal(tabManager.goForward(a), '/notes/b.md');
	assert.deepEqual(stackOf(a), []);
});

test('the forward stack goes with them', () => {
	reset();
	tabManager.addTab('/notes/a.md', '# A\n');
	const a = tabManager.activeTabId!;
	jumpFrom(4000);
	mouseButton('back', 4200);
	assert.deepEqual(futureOf(a), [4200]);

	tabManager.navigate(a, '/notes/b.md');

	assert.deepEqual(futureOf(a), []);
});

test('Save As keeps them, because the document on screen has not changed', () => {
	reset();
	tabManager.addTab('/notes/a.md', '# A\n');
	const a = tabManager.activeTabId!;
	jumpFrom(4000);

	tabManager.updateTabPath(a, '/notes/copy.md');

	assert.deepEqual(mouseButton('back', 4200), { scrolledTo: 4000 });
});

test('renaming the file on disk keeps them', () => {
	reset();
	tabManager.addTab('/notes/a.md', '# A\n');
	const a = tabManager.activeTabId!;
	jumpFrom(4000);

	tabManager.renameTab(a, '/notes/renamed.md');

	assert.deepEqual(mouseButton('back', 4200), { scrolledTo: 4000 });
});

test('a reload in place drops them, because the text they were measured in is gone', () => {
	reset();
	tabManager.addTab('/notes/a.md', '# A\n');
	const a = tabManager.activeTabId!;
	jumpFrom(4000);

	tabManager.clearScrollHistory(a);

	assert.deepEqual(stackOf(a), []);
	assert.deepEqual(futureOf(a), []);
});

// -------------------------------------------------------------- the stack itself

test('a new jump abandons the forward stack, as every history does', () => {
	reset();
	tabManager.addTab('/notes/a.md', '# A\n');
	const a = tabManager.activeTabId!;
	jumpFrom(100);
	mouseButton('back', 500);
	assert.deepEqual(futureOf(a), [500]);

	jumpFrom(700);

	assert.deepEqual(futureOf(a), []);
});

test('back and forward walk the same offsets in both directions', () => {
	reset();
	tabManager.addTab('/notes/a.md', '# A\n');
	jumpFrom(100);
	jumpFrom(400);

	assert.deepEqual(mouseButton('back', 900), { scrolledTo: 400 });
	assert.deepEqual(mouseButton('back', 400), { scrolledTo: 100 });
	assert.deepEqual(mouseButton('forward', 100), { scrolledTo: 400 });
	assert.deepEqual(mouseButton('forward', 400), { scrolledTo: 900 });
});

test('a tab remembers the last fifty jumps and drops the oldest', () => {
	reset();
	tabManager.addTab('/notes/a.md', '# A\n');
	const a = tabManager.activeTabId!;
	for (let i = 1; i <= 55; i += 1) jumpFrom(i);

	assert.equal(stackOf(a).length, 50);
	assert.equal(stackOf(a)[0], 6);
	assert.equal(stackOf(a)[49], 55);
});

// ------------------------------------------------ what deliberately does not travel

test('a restored window opens with no offsets to walk', () => {
	reset();
	tabManager.addTab('/notes/a.md', '# A\n');
	jumpFrom(4000);
	const saved = tabManager.serializeState();

	reset();
	tabManager.restoreState(saved);

	const restored = tabManager.tabs.find((t) => t.path === '/notes/a.md')!;
	assert.deepEqual(restored.scrollHistory, []);
	assert.deepEqual(restored.scrollFuture, []);
});

test('a tab moved to another window arrives with none either', () => {
	reset();
	tabManager.addTab('/notes/a.md', '# A\n');
	const a = tabManager.activeTabId!;
	jumpFrom(4000);

	const arrived = buildTransferredTab(
		snapshotTab(tabManager.tabs.find((t) => t.id === a)!),
		[],
		'Untitled',
	);

	assert.deepEqual(arrived.scrollHistory, []);
	assert.deepEqual(arrived.scrollFuture, []);
});
