import assert from 'node:assert/strict';
import test from 'node:test';
import { createUnsavedRecovery, parseRecovery, recoverySnapshot, restoreRecords } from '../src/lib/sessions/unsavedRecovery.js';
import { buildTransferredTab, type TransferableTab } from '../src/lib/utils/tabTransfer.js';
import { asRendererLine } from '../src/lib/utils/lineCoordinates.js';
import { HOME_TAB_PATH } from '../src/lib/utils/homeTab.js';

const document: TransferableTab = {
	path: '', title: 'Untitled', rawContent: 'unsaved text', originalContent: '',
	isDirty: true, isEditing: true, isSplit: false, isScrollSynced: true,
	hasReplacementChars: false, encoding: 'utf-8', splitRatio: 0.5,
	scrollTop: 0, scrollPercentage: 0, anchorLine: asRendererLine(1),
	historyIndex: 0, history: [],
};

test('recovery round-trips untitled and file buffers with baseline and encoding', () => {
	const untitled = buildTransferredTab(document, [], 'Untitled');
	const file = buildTransferredTab({ ...document, path: '/notes.md', originalContent: 'saved', encoding: 'gbk' }, [], 'Untitled');
	assert.deepEqual(parseRecovery(recoverySnapshot([untitled, file])), [document, { ...document, path: '/notes.md', originalContent: 'saved', encoding: 'gbk' }]);
	assert.equal(file.originalContent, 'saved');
});

test('only dirty buffers and non-empty untitled text are kept', () => {
	const tab = (fields: Partial<TransferableTab>) => buildTransferredTab({ ...document, ...fields }, [], 'Untitled');
	const partial = tab({ path: '/partial.md', originalContent: 'saved' });
	partial.isTruncated = true;
	const kept = parseRecovery(recoverySnapshot([
		tab({ path: '/clean.md', rawContent: 'saved', originalContent: 'saved' }),
		tab({ rawContent: '' }),
		tab({ path: HOME_TAB_PATH }),
		tab({}),
		tab({ path: '/dirty.md', originalContent: 'saved' }),
		partial,
	]));
	assert.deepEqual(kept.map((entry) => entry.path), ['', '/dirty.md', '/partial.md']);
	assert.equal(kept[2].isTruncated, true);
});

test('invalid recovery records are rejected before restoring any tab', () => {
	for (const json of ['', 'null', '{}', 'broken', '[{}]', JSON.stringify([{ ...document, isTruncated: 'yes' }]), JSON.stringify([document, {}])]) {
		assert.throws(() => parseRecovery(json));
	}
});

function manager(tabs: TransferableTab[] = []) {
	return {
		tabs: tabs.map((tab) => buildTransferredTab(tab, [], 'Untitled')),
		closeTab(id: string) { this.tabs = this.tabs.filter((tab) => tab.id !== id); },
		insertTransferredTab(snapshot: TransferableTab) {
			const tab = buildTransferredTab(snapshot, this.tabs.map((tab) => tab.title), 'Untitled');
			this.tabs.push(tab);
			return tab.id;
		},
	};
}

test('restore replaces clean session copies, keeps baselines, and skips live windows', () => {
	const target = manager([
		{ ...document, path: '/notes.md', rawContent: 'disk', originalContent: 'disk', isDirty: false },
		{ ...document, path: '/other.md' },
	]);
	const dirtyId = target.tabs[1].id;
	const consumed = restoreRecords(target, [
		['main', JSON.stringify([{ ...document, path: '/notes.md', originalContent: 'saved', isEditing: false, isSplit: true }])],
		['window-2', JSON.stringify([{ ...document, path: '/other.md', rawContent: 'another unsaved copy' }, document])],
		['window-3', JSON.stringify([{ ...document, rawContent: 'still open elsewhere' }])],
	], new Set(['window-3']), 'main', (error) => { throw error; });
	assert.deepEqual(consumed, ['window-2']);
	assert.deepEqual(target.tabs.map((tab) => tab.path), ['/other.md', '/notes.md', '/other.md', '']);
	assert.equal(target.tabs[0].id, dirtyId);
	assert.equal(target.tabs[1].rawContent, 'unsaved text');
	assert.equal(target.tabs[1].originalContent, 'saved');
	assert.equal(target.tabs[1].isDirty, true);
	assert.equal(target.tabs[1].isEditing, true);
	assert.equal(target.tabs[1].isSplit, false);
});

test('a corrupt record of another window is reported, skipped, and left unconsumed', () => {
	const target = manager();
	const errors: unknown[] = [];
	const consumed = restoreRecords(target, [
		['window-2', ''],
		['window-3', JSON.stringify([document, {}])],
		['window-4', JSON.stringify([document])],
	], new Set(), 'main', (error) => errors.push(error));
	assert.equal(errors.length, 2);
	assert.deepEqual(consumed, ['window-4']);
	assert.equal(target.tabs.length, 1);
});

test('a corrupt record of this window throws, so the caller never overwrites it', () => {
	const target = manager();
	assert.throws(() => restoreRecords(target, [['main', '{']], new Set(), 'main', () => {}));
	assert.equal(target.tabs.length, 0);
});

test('continuous changes reach disk within the bounded background delay', async (context) => {
	context.mock.timers.enable({ apis: ['setTimeout'] });
	const writes: string[] = [];
	const recovery = createUnsavedRecovery({ write: async (json) => { writes.push(json); }, onError: (error) => { throw error; } });
	recovery.update('first');
	context.mock.timers.tick(400);
	recovery.update('latest');
	context.mock.timers.tick(100);
	await Promise.resolve();
	assert.deepEqual(writes, ['latest']);
	recovery.update('[]');
	context.mock.timers.tick(500);
	await recovery.flush();
	assert.equal(writes.at(-1), '[]');
	recovery.dispose();
});

test('flush cancels delayed writes and serializes cleanup behind in-flight writes', async () => {
	const writes: string[] = [];
	let release!: () => void;
	const gate = new Promise<void>((resolve) => { release = resolve; });
	const recovery = createUnsavedRecovery({
		write: async (json) => { writes.push(json); if (writes.length === 1) await gate; },
		onError: (error) => { throw error; },
	});
	recovery.update('old');
	const first = recovery.flush('new');
	await Promise.resolve();
	const cleanup = recovery.flush('[]');
	assert.deepEqual(writes, ['new']);
	release();
	await Promise.all([first, cleanup]);
	assert.deepEqual(writes, ['new', '[]']);
	recovery.dispose();
});

test('failed writes retry without another edit and flush reports failure', async (context) => {
	context.mock.timers.enable({ apis: ['setTimeout'] });
	let attempts = 0;
	const recovery = createUnsavedRecovery({
		write: async () => { if (++attempts === 1) throw new Error('temporarily unavailable'); },
		onError: () => {},
	});
	assert.equal(await recovery.flush('unsaved'), false);
	assert.equal(attempts, 1);
	context.mock.timers.tick(2000);
	await Promise.resolve();
	await Promise.resolve();
	assert.equal(attempts, 2);
	assert.equal(await recovery.flush(), true);
	recovery.dispose();
});

test('write failures are reported without blocking later snapshots', async () => {
	const errors: unknown[] = [];
	const writes: string[] = [];
	const recovery = createUnsavedRecovery({
		write: async (json) => { writes.push(json); if (json === 'bad') throw new Error('disk full'); },
		onError: (error) => { errors.push(error); },
	});
	await recovery.flush('bad');
	await recovery.flush('[]');
	assert.equal(errors.length, 1);
	assert.deepEqual(writes, ['bad', '[]']);
	recovery.dispose();
});
