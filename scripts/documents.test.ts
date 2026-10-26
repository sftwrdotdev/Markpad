import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { PieceTreeTextBufferBuilder } from 'monaco-editor/esm/vs/editor/common/model/pieceTreeTextBuffer/pieceTreeTextBufferBuilder.js';
import { DefaultEndOfLine } from 'monaco-editor/esm/vs/editor/common/standalone/standaloneEnums.js';

import { createBoundedWriter, parseRecovery, recoverySnapshot, restoreRecords } from '../src/lib/sessions/unsavedRecovery.js';
import type { Tab } from '../src/lib/stores/tabs.svelte.js';
import {
	DROPPABLE_IMAGE_EXTENSIONS,
	dropPaneFor,
	dropZoneLabel,
	handleDrop,
	routeDroppedFile,
	type DropAction,
	type DropPane,
} from '../src/lib/utils/fileDrop.js';
import { openDiffView } from '../src/lib/utils/diffView.js';
import { HOME_TAB_PATH } from '../src/lib/utils/homeTab.js';
import { autoSaveFailureNeedsToast, isAutoSaveEligible, type AutoSaveTabState } from '../src/lib/utils/autoSaveTimer.js';
import { asRendererLine } from '../src/lib/utils/lineCoordinates.js';
import {
	DEFAULT_OPEN_FILE_MODE,
	isOpenFileMode,
	resolveOpenFileMode,
} from '../src/lib/utils/openFileMode.js';
import { t } from '../src/lib/utils/i18n.js';
import { MARKDOWN_OPEN_FILTERS } from '../src/lib/utils/markdownLinks.js';
import { lineEndingLabel } from '../src/lib/utils/tabModels.js';
import { buildTransferredTab, snapshotTab, validateTransferPayload, type TransferableTab } from '../src/lib/utils/tabTransfer.js';
import { dispatchViewerKey, viewerCommandFor, type KeyContext } from '../src/lib/utils/viewerKeymap.js';

describe('lossy decode save guard', () => {
	test('the refusal names Save As, the only exit', () => {
		// The session raises this once per tab (documents.session.spec.ts). Saving
		// over the file is refused, so the message has to say what still works.
		assert.match(t('toast.lossySaveBlocked', 'en'), /use "Save As" to write a copy/);
	});

	// --- Behavioural: the flag survives a cross-window move ------------------
	// tabTransfer.ts is pure, so these run the real code instead of reading it.
	// A moved tab carries its unsaved buffer; if the flag did not travel with it,
	// the destination window would happily overwrite the source file.

	function makeTab(overrides: Partial<Tab> = {}): Tab {
		return {
			id: 'source-id',
			path: '/notes/legacy.md',
			title: 'legacy.md',
			content: '<p>rendered</p>',
			rawContent: '# �� mojibake',
			originalContent: '# �� mojibake',
			scrollTop: 0,
			isDirty: false,
			isEditing: true,
			history: ['/notes/legacy.md'],
			historyIndex: 0,
			editorViewState: null,
			scrollPercentage: 0,
			anchorLine: asRendererLine(0),
			isSplit: false,
			splitRatio: 0.5,
			isScrollSynced: false,
			hasReplacementChars: true,
			encoding: 'UTF-8',
			scrollHistory: [],
			scrollFuture: [],
			foldOverrides: new Set<string>(),
			...overrides,
		};
	}

	test('a moved tab arrives still refusing to overwrite its source', () => {
		const snap = snapshotTab(makeTab());
		assert.equal(snap.hasReplacementChars, true, 'the snapshot must carry it');

		const validated = validateTransferPayload(JSON.stringify(snap));
		assert.ok(validated, 'a snapshot of a real tab must validate');
		assert.equal(validated.hasReplacementChars, true);

		const arrived = buildTransferredTab(validated, [], 'Untitled');
		assert.equal(arrived.hasReplacementChars, true, 'the guard must survive the move');
	});

	test('a faithful buffer arrives savable', () => {
		const snap = snapshotTab(makeTab({ hasReplacementChars: false, rawContent: '# fine' }));
		const validated = validateTransferPayload(JSON.stringify(snap));
		assert.ok(validated);
		assert.equal(buildTransferredTab(validated, [], 'Untitled').hasReplacementChars, false);
	});

	test('a payload without the flag is rejected, not defaulted', () => {
		// The file's own doctrine: no coercion, no defaults. Defaulting a missing
		// flag to false would silently re-open the hole for any sender that
		// forgets it.
		const snap: Record<string, unknown> = { ...snapshotTab(makeTab()) };
		delete snap.hasReplacementChars;
		assert.equal(validateTransferPayload(JSON.stringify(snap)), null);
	});
});

/*
 * #168, reported by @dayeggpi: with a document that was never saved, Ctrl+S in
 * reading mode did nothing at all. `toggleEdit` only runs its save/confirm flow
 * for tabs that already have a path, so an untitled buffer switches to reading
 * mode still dirty — and then the one shortcut that could rescue it was
 * suppressed.
 *
 * Every assertion here used to read the component's source through
 * `sliceBetween(viewer, "if (mod && key === 's') {", "if (modShift && key ===
 * 't')")` — a slice whose start anchor was the branch condition itself and
 * whose end anchor was the NEXT branch, so it moved when either was rewritten
 * and said nothing about what Ctrl+S does. Lifting the dispatcher out split the
 * two halves apart, and each is now checked where it lives: which chord means
 * `'save'` is a function call, and what `'save'` does is the component's, read
 * from its command table.
 */
describe('save from reading mode', () => {
	/** Reading a saved document, the state the report was made in. */
	const READING: KeyContext = {
		mode: 'app',
		osType: 'windows',
		isSplit: false,
		overlayOpen: false,
		dialogOpen: false,
		isEditing: false,
		editorHasFocus: false,
	};

	/** Mod+S, with no other modifier. */
	const MOD_S = { key: 's', code: 'KeyS', ctrlKey: true, metaKey: false, shiftKey: false, altKey: false };

	test('Ctrl+S is not gated on the editor being visible', () => {
		// The defect was a `if (isEditing || isSplit)` around the branch. Asked as a
		// question rather than matched as text: all four combinations of the two
		// flags must answer `'save'`, so no guard over either of them can come back
		// without failing here.
		for (const isEditing of [false, true]) {
			for (const isSplit of [false, true]) {
				assert.equal(
					viewerCommandFor(MOD_S, { ...READING, isEditing, isSplit }),
					'save',
					`isEditing=${isEditing} isSplit=${isSplit}`,
				);
			}
		}
	});

	test('the browser save dialog is always suppressed', () => {
		// Reading mode would otherwise surface the webview's own Save Page dialog.
		// The keystroke is prevented before the command runs, in every mode.
		for (const isEditing of [false, true]) {
			const events: string[] = [];
			const stroke = { ...MOD_S, preventDefault: () => void events.push('prevented') };
			dispatchViewerKey(stroke, { ...READING, isEditing }, (command) => void events.push(`run:${command}`));
			assert.deepEqual(events, ['prevented', 'run:save'], `isEditing=${isEditing}`);
		}

		// A chord that means nothing keeps its default.
		const events: string[] = [];
		const stroke = { ...MOD_S, key: 'j', code: 'KeyJ', ctrlKey: false, preventDefault: () => void events.push('prevented') };
		dispatchViewerKey(stroke, READING, (command) => void events.push(`run:${command}`));
		assert.deepEqual(events, []);
	});
});

describe('auto-save debounce', () => {
	/** A dirty file in the editor, the state the timer exists for. */
	const EDITING: AutoSaveTabState = {
		id: 'a', path: '/notes/a.md', isDirty: true, editable: true, hasPendingConflict: false, decodedLossily: false,
	};
	const never = () => false;
	const always = () => true;

	test('the debounced auto-save is held back while a conflict is unanswered', () => {
		// Otherwise the 1.5s timer fires while the bar is still asking "reload or
		// keep mine": the user's edits survive, but the external change is gone
		// from disk before either answer can be given.
		assert.equal(isAutoSaveEligible(EDITING, never), true);
		assert.equal(isAutoSaveEligible({ ...EDITING, hasPendingConflict: true }, never), false);
	});

	test('a tab that can only be refused stops re-arming the timer', () => {
		// Auto-save re-arms on every keystroke. Without this the guard was reached
		// again every 1.5s for as long as the user kept typing.
		const lossy = { ...EDITING, decodedLossily: true };
		// The FIRST attempt still happens: it is what produces the explanation.
		assert.equal(isAutoSaveEligible(lossy, never), true);
		assert.equal(isAutoSaveEligible(lossy, always), false);
		// "Save As" to a new file clears the lossy flag, which restores it.
		assert.equal(isAutoSaveEligible(EDITING, always), true);
	});

	test('a refused save does not add a generic toast to its own explanation', () => {
		assert.equal(autoSaveFailureNeedsToast('a', { isLossySaveRefused: always, hasExternalChangeConflict: never }), false);
		assert.equal(autoSaveFailureNeedsToast('a', { isLossySaveRefused: never, hasExternalChangeConflict: always }), false);
		// A genuine write failure still says so.
		assert.equal(autoSaveFailureNeedsToast('a', { isLossySaveRefused: never, hasExternalChangeConflict: never }), true);
	});
});

describe('unsaved recovery', () => {
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

	test('restore replaces clean session copies and keeps baselines', () => {
		const target = manager([
			{ ...document, path: '/notes.md', rawContent: 'disk', originalContent: 'disk', isDirty: false },
			{ ...document, path: '/other.md' },
		]);
		const dirtyId = target.tabs[1].id;
		const consumed = restoreRecords(target, [
			['main', JSON.stringify([{ ...document, path: '/notes.md', originalContent: 'saved', isEditing: false, isSplit: true }])],
			['window-2', JSON.stringify([{ ...document, path: '/other.md', rawContent: 'another unsaved copy' }, document])],
		], 'main', (error) => { throw error; });
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
		], 'main', (error) => errors.push(error));
		assert.equal(errors.length, 2);
		assert.deepEqual(consumed, ['window-4']);
		assert.equal(target.tabs.length, 1);
	});

	test('a corrupt record of this window throws, so the caller never overwrites it', () => {
		const target = manager();
		assert.throws(() => restoreRecords(target, [['main', '{']], 'main', () => {}));
		assert.equal(target.tabs.length, 0);
	});

	test('continuous changes reach disk within the bounded background delay', async (context) => {
		context.mock.timers.enable({ apis: ['setTimeout'] });
		const writes: string[] = [];
		const recovery = createBoundedWriter({ initial: '[]', write: async (json) => { writes.push(json); }, onError: (error) => { throw error; } });
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

	test('a stale mark serializes once per write, and flush serializes the latest content', async (context) => {
		context.mock.timers.enable({ apis: ['setTimeout'] });
		const writes: string[] = [];
		let content = '';
		let serialized = 0;
		const snapshot = () => { serialized++; return content; };
		const recovery = createBoundedWriter({ initial: '[]', write: async (json) => { writes.push(json); }, onError: (error) => { throw error; } });
		for (let i = 0; i < 100; i++) {
			content += 'a';
			recovery.update(snapshot);
			context.mock.timers.tick(4);
		}
		await Promise.resolve();
		// 400 ms of typing: no keystroke serialized, nothing written yet.
		assert.equal(serialized, 0);
		context.mock.timers.tick(100);
		await Promise.resolve();
		assert.equal(serialized, 1);
		assert.deepEqual(writes, ['a'.repeat(100)]);
		content += 'b';
		recovery.update(snapshot);
		await recovery.flush();
		assert.equal(serialized, 2);
		assert.equal(writes.at(-1), 'a'.repeat(100) + 'b');
		// Flushed: the cancelled timer does not write again.
		context.mock.timers.tick(500);
		await Promise.resolve();
		assert.equal(writes.length, 2);
		recovery.update(snapshot);
		recovery.update('[]');
		context.mock.timers.tick(500);
		await Promise.resolve();
		assert.equal(serialized, 2, 'turning the setting off drops the pending snapshot');
		assert.equal(writes.at(-1), '[]');
		recovery.dispose();
	});

	test('flush cancels delayed writes and serializes cleanup behind in-flight writes', async () => {
		const writes: string[] = [];
		let release!: () => void;
		const gate = new Promise<void>((resolve) => { release = resolve; });
		const recovery = createBoundedWriter({
			initial: '[]',
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
		const recovery = createBoundedWriter({
			initial: '[]',
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

	test('a failed write still retries when the next stale snapshot is the same', async (context) => {
		context.mock.timers.enable({ apis: ['setTimeout'] });
		let attempts = 0;
		const recovery = createBoundedWriter({
			initial: '[]',
			write: async () => { if (++attempts === 1) throw new Error('temporarily unavailable'); },
			onError: () => {},
		});
		assert.equal(await recovery.flush('unsaved'), false);
		recovery.update(() => 'unsaved');
		context.mock.timers.tick(2000);
		await Promise.resolve();
		await Promise.resolve();
		assert.equal(attempts, 2);
		recovery.dispose();
	});

	test('write failures are reported without blocking later snapshots', async () => {
		const errors: unknown[] = [];
		const writes: string[] = [];
		const recovery = createBoundedWriter({
			initial: '[]',
			write: async (json) => { writes.push(json); if (json === 'bad') throw new Error('disk full'); },
			onError: (error) => { errors.push(error); },
		});
		await recovery.flush('bad');
		await recovery.flush('[]');
		assert.equal(errors.length, 1);
		assert.deepEqual(writes, ['bad', '[]']);
		recovery.dispose();
	});

	test('dispose drops a pending write and waits for the one in flight, so a forgotten file stays gone', async (context) => {
		context.mock.timers.enable({ apis: ['setTimeout'] });
		const writes: string[] = [];
		let release!: () => void;
		const gate = new Promise<void>((resolve) => { release = resolve; });
		const writer = createBoundedWriter({
			write: async (json) => { writes.push(json); await gate; },
			onError: (error) => { throw error; },
		});
		writer.update('in flight');
		context.mock.timers.tick(500);
		writer.update('pending');
		let settled = false;
		const disposed = writer.dispose().then(() => { settled = true; });
		await Promise.resolve();
		assert.equal(settled, false, 'dispose resolved while a write was still in flight');
		release();
		await disposed;
		context.mock.timers.tick(5000);
		writer.update('after dispose');
		assert.deepEqual(writes, ['in flight']);
	});
});

// The status bar used to render `t('editor.status.crlf')` — the literal string
// "CRLF", for every document, on every platform. `samples/stress-test.md` has
// not got one CR byte in it and the app said CRLF about it.
//
// The label is now the model's own EOL, so this file drives real Monaco with
// real CRLF and LF fixtures and asks what the label would say. The fixtures are
// literals rather than files on disk for the reason `sourceTree.ts` explains at
// length: on a Windows checkout Git decides what `\n` in a repo file means, and
// a test about line endings cannot let it.
describe('editor line ending', () => {
	/**
	 * A Monaco text buffer built exactly the way `monaco.editor.createModel` builds
	 * one: `createTextBufferFactory` is `new PieceTreeTextBufferBuilder()`,
	 * `acceptChunk`, `finish()` with `normalizeEOL` left at its default.
	 *
	 * The buffer rather than a `TextModel` because a model pulls in the editor's
	 * browser-side graph, and the EOL is decided down here anyway — everything
	 * `model.getEOL()` returns comes from this object.
	 */
	function textBuffer(source: string, defaultEOL: 1 | 2 = DefaultEndOfLine.LF) {
		const builder = new PieceTreeTextBufferBuilder();
		builder.acceptChunk(source);
		return builder.finish().create(defaultEOL).textBuffer;
	}

	/** The buffer's own text, to show what normalization did to a fixture. */
	function contents(buffer: ReturnType<typeof textBuffer>): string {
		const snapshot = buffer.createSnapshot(false);
		let text = '';
		for (let chunk = snapshot.read(); chunk !== null; chunk = snapshot.read()) text += chunk;
		return text;
	}

	const CRLF_DOCUMENT = '# Title\r\n\r\nA paragraph.\r\n\r\n- one\r\n- two\r\n';
	const LF_DOCUMENT = '# Title\n\nA paragraph.\n\n- one\n- two\n';

	test('the label is the document’s ending, not a constant', () => {
		assert.equal(lineEndingLabel(textBuffer(CRLF_DOCUMENT)), 'CRLF');
		assert.equal(lineEndingLabel(textBuffer(LF_DOCUMENT)), 'LF');
	});

	test('a mixed document is not mixed once it is open, and the label says which one won', () => {
		// Monaco counts the endings and rewrites the WHOLE buffer to the majority
		// before the model exists, so there is no third answer to give: after this
		// the document really is uniform, and a save writes it out that way. The
		// two assertions per fixture are one claim — the label matches the bytes.
		const mostlyCrlf = textBuffer('a\r\nb\r\nc\n');
		assert.equal(contents(mostlyCrlf), 'a\r\nb\r\nc\r\n');
		assert.equal(lineEndingLabel(mostlyCrlf), 'CRLF');

		const mostlyLf = textBuffer('a\nb\nc\r\n');
		assert.equal(contents(mostlyLf), 'a\nb\nc\n');
		assert.equal(lineEndingLabel(mostlyLf), 'LF');

		// Half and half: Monaco requires a CR majority, so a tie goes to LF.
		const tied = textBuffer('a\r\nb\n');
		assert.equal(contents(tied), 'a\nb\n');
		assert.equal(lineEndingLabel(tied), 'LF');
	});

	test('a document with no line break at all reports the ending Monaco would insert', () => {
		// An empty untitled tab, or a one-line file. There is nothing to detect, so
		// the model falls back to its `defaultEOL`, which the standalone services
		// resolve per platform: CRLF on Windows, LF elsewhere. That is still the
		// truth — it is what Enter inserts and what the save writes.
		assert.equal(lineEndingLabel(textBuffer('one line, no break', DefaultEndOfLine.CRLF)), 'CRLF');
		assert.equal(lineEndingLabel(textBuffer('', DefaultEndOfLine.LF)), 'LF');
	});
});

describe('external change comparison', () => {
	test('the diff view owns its models and never edits the document', () => {
		// Handing it the tab's live model would put a second editor on a buffer
		// Editor.svelte owns, and a read-only view of a document is not a place to
		// change it from.
		const disposed: string[] = [];
		const created: { text: string; language: string }[] = [];
		let options: Record<string, unknown> = {};
		let shown: { original: unknown; modified: unknown } | null = null;
		const fakeMonaco = {
			editor: {
				createModel: (text: string, language: string) => {
					created.push({ text, language });
					return { dispose: () => disposed.push(`model:${text}`) };
				},
				createDiffEditor: (_element: unknown, given: Record<string, unknown>) => {
					options = given;
					return {
						setModel: (pair: { original: unknown; modified: unknown }) => { shown = pair; },
						dispose: () => disposed.push('editor'),
					};
				},
			},
		} as unknown as Parameters<typeof openDiffView>[0];

		const close = openDiffView(fakeMonaco, {} as HTMLElement, 'on disk', 'mine', 'markdown');
		assert.deepEqual(created, [
			{ text: 'on disk', language: 'markdown' },
			{ text: 'mine', language: 'markdown' },
		]);
		assert.ok(shown, 'the diff editor was given its own two models');
		assert.equal(options.readOnly, true);
		assert.equal(options.originalEditable, false);
		assert.deepEqual(disposed, []);

		// Every model it creates is disposed, or opening the view repeatedly leaks
		// one document's worth of text each time.
		close();
		assert.deepEqual(disposed.sort(), ['editor', 'model:mine', 'model:on disk']);
	});
});

describe('open file mode', () => {
	/* ------------------------------------------------- the stored preference */

	test('a stored choice is honoured, and anything else is not', () => {
		assert.equal(resolveOpenFileMode('preview', null), 'preview');
		assert.equal(resolveOpenFileMode('editor', null), 'editor');
		assert.equal(resolveOpenFileMode('split', null), 'split');

		// A value from a newer version, or a hand-edited one.
		assert.equal(resolveOpenFileMode('wysiwyg', null), DEFAULT_OPEN_FILE_MODE);
		assert.equal(resolveOpenFileMode('', null), DEFAULT_OPEN_FILE_MODE);
		assert.ok(!isOpenFileMode('Editor'));
	});

	test('an install upgrading from the checkbox opens files exactly as it did', () => {
		// The whole point of the migration: nobody who upgrades sees their app
		// behave differently on the first launch.
		assert.equal(resolveOpenFileMode(null, 'true'), 'editor');
		assert.equal(resolveOpenFileMode(null, 'false'), 'preview');
		// Never set it at all — the default, which is what that install did.
		assert.equal(resolveOpenFileMode(null, null), 'preview');
	});

	test('the old boolean stops being consulted once a choice exists', () => {
		// Otherwise a reader who upgrades, picks "preview", and relaunches gets
		// "editor" back — the old key is still sitting in localStorage saying true.
		assert.equal(resolveOpenFileMode('preview', 'true'), 'preview');
		assert.equal(resolveOpenFileMode('split', 'true'), 'split');
	});
});

/**
 * Where a dropped file goes, per pane.
 *
 * The app answers a drop in three ways, and the branch for the editor pane
 * knew only one of them: it looked for an image extension and **silently
 * discarded everything else**. So dragging a `.md` onto the editor did
 * nothing at all — no tab, no toast, no clue — while the identical drop two
 * inches to the right opened it. #175 asked for "drag multiple files, for each
 * file open a new tab" and got it, as long as the pointer stayed off the
 * editor.
 *
 * The decision now lives in `routeDroppedFile`, away from the window event
 * this suite cannot emit, which is what makes the table below a test rather
 * than a reading of the source. It was written the other way first: source
 * assertions that still passed with the markdown branch disabled by a
 * `false &&`. A check that cannot fail is worse than none, because it is
 * counted.
 */
describe('file drop routing', () => {
	/** file, pane, what must happen. */
	const ROUTES: ReadonlyArray<[path: string, pane: DropPane, action: DropAction]> = [
		// The report: a document opens, whichever pane is under the pointer.
		['/notes/spec.md', 'editor', 'open'],
		['/notes/spec.md', 'preview', 'open'],
		['/notes/spec.markdown', 'editor', 'open'],
		['/notes/spec.txt', 'editor', 'open'],
		['C:\\notes\\spec.MD', 'editor', 'open'],

		// An image goes into the text, and only where there is text.
		['/notes/img/figure.png', 'editor', 'insert'],
		['/notes/img/figure.SVG', 'editor', 'insert'],
		['/notes/img/figure.png', 'preview', 'unsupported'],

		// Everything else is reported rather than dropped on the floor.
		['/notes/archive.zip', 'editor', 'unsupported'],
		['/notes/archive.zip', 'preview', 'unsupported'],
		['/notes/report.pdf', 'editor', 'unsupported'],
		['/notes/no-extension', 'editor', 'unsupported'],
	];

	test('every file has an answer on both panes', () => {
		for (const [path, pane, action] of ROUTES) {
			assert.equal(routeDroppedFile(path, pane), action, `${path} on the ${pane}`);
		}
	});

	test('nothing routes to silence', () => {
		// The defect in one sentence: a path that matched no branch produced no
		// action at all. There is no fourth answer to return now, and this is the
		// assertion that says so.
		const answers: DropAction[] = ['insert', 'open', 'unsupported'];
		for (const pane of ['editor', 'preview'] as DropPane[]) {
			for (const path of ['/a.md', '/a.png', '/a.zip', '/a', '/a.md.zip', '']) {
				assert.ok(answers.includes(routeDroppedFile(path, pane)), `${path} on the ${pane}`);
			}
		}
	});

	test('the image list and the document list cannot overlap', () => {
		// They are asked in order, so an extension in both would take whichever
		// branch runs first rather than the one that suits it.
		for (const extension of DROPPABLE_IMAGE_EXTENSIONS) {
			assert.equal(routeDroppedFile(`/notes/figure.${extension}`, 'editor'), 'insert', extension);
		}
	});

	test('a drop zone names what the drop will do there (#928)', () => {
		// The editor zone said "Drop to Embed" for every file, and a document
		// dropped on it opened.
		assert.equal(dropZoneLabel(['/notes/spec.md'], 'editor'), 'open');
		assert.equal(dropZoneLabel(['/notes/img/figure.png'], 'editor'), 'embed');
		assert.equal(dropZoneLabel(['/notes/spec.md', '/notes/img/figure.png'], 'editor'), 'embed');
		assert.equal(dropZoneLabel(['/notes/img/figure.png'], 'preview'), 'open');
	});

	test('a drop outside both panes opens a document in every mode', () => {
		// In edit or split mode, a `.md` dropped on the tab strip was tracked over
		// neither pane and the batch was dropped without a word, while the same
		// drop in reading mode opened it.
		assert.equal(dropPaneFor(null, true), 'preview');
		assert.equal(dropPaneFor(null, false), 'preview');
		assert.equal(routeDroppedFile('/notes/spec.md', dropPaneFor(null, true)), 'open');
		assert.equal(dropPaneFor('editor', true), 'editor');
		// The editor pane is only the editor while an editor is mounted there.
		assert.equal(dropPaneFor('editor', false), 'preview');
		assert.equal(dropPaneFor('preview', true), 'preview');
	});

	test('the viewer routes both panes through it, and acts on all three answers', () => {
		const drop = (target: DropPane | null, hasEditor: boolean, paths: string[]) => {
			const calls: string[] = [];
			handleDrop(paths, target, hasEditor, {
				insert: (path) => calls.push(`insert ${path}`),
				open: (path) => calls.push(`open ${path}`),
				unsupported: (path) => calls.push(`unsupported ${path}`),
			});
			return calls;
		};
		const batch = ['/n/spec.md', '/n/figure.png', '/n/archive.zip'];

		assert.deepEqual(drop('editor', true, batch), [
			'open /n/spec.md',
			'insert /n/figure.png',
			'unsupported /n/archive.zip',
		]);
		assert.deepEqual(drop('preview', true, batch), [
			'open /n/spec.md',
			'unsupported /n/figure.png',
			'unsupported /n/archive.zip',
		]);
		// Off both panes, a document still opens.
		assert.deepEqual(drop(null, true, ['/n/spec.md']), ['open /n/spec.md']);
		// No editor mounted: the editor pane answers as the preview.
		assert.deepEqual(drop('editor', false, ['/n/figure.png']), ['unsupported /n/figure.png']);
	});
});

describe('the Open dialog', () => {
	test('the Open dialog offers every extension Markpad treats as a document', () => {
		// Markpad opens, renders and saves `.txt` like any other note (#535); a
		// shorter list hid those files behind "All Files".
		const [markdown, all] = MARKDOWN_OPEN_FILTERS;
		assert.deepEqual([...markdown.extensions].sort(), ['markdown', 'md', 'mdown', 'mkd', 'txt']);
		assert.deepEqual(all.extensions, ['*']);
	});
});
