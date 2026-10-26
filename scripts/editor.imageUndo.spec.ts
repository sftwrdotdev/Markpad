import assert from 'node:assert/strict';

import { test } from 'vitest';

/*
 * Undoing an image insert used to delete the copied file from disk (#368).
 * `delete_file` is `fs::remove_file` — no Trash, no Recycle Bin — and the file
 * lives in the user's own notes folder next to the document, so a wrong guess
 * was unrecoverable. It was also the only one of six ways to remove an embed
 * that touched the filesystem at all: selecting it and pressing Delete, typing
 * over it, deleting the line, closing the tab unsaved and deleting the line
 * after a save all left the file where it was.
 *
 * The maintainer chose "stop deleting on undo", so the whole guess is gone
 * rather than corrected. These tests hold that: an undo may move text and
 * nothing else.
 *
 * They run the editor's real paste, drop and cut handlers
 * (`utils/editorClipboard.ts`) and the real content listener
 * (`EditorDocument.contentChanged`, the one listener Editor.svelte registers)
 * over one fake Monaco document with a real undo stack and the real
 * `TabManager`. The Tauri bridge is a recording double: "dispatch an undo and
 * see what reaches the backend" catches a deletion re-added under any command
 * name.
 *
 * Each undo test also asserts that the undo *arrived* — the buffer reverted
 * and the tab's raw content followed it. Without that, "no backend call" would
 * also be satisfied by a harness that dispatched into thin air.
 *
 * What this does not establish: that Monaco groups an image insert into one
 * undo step, or anything about the real clipboard. It establishes what the
 * editor's own handlers do when an undo reaches them.
 */

// ---------------------------------------------------------------- environment
// The runes are the compiler's, not ours: vitest builds `.svelte.ts` through the
// Svelte plugin, so the store and the session run under real reactivity, and jsdom
// supplies `window` and `localStorage`. Only the Tauri backend is stubbed, and
// a module that imports `invoke` itself reaches the same recording backend the
// handlers are handed, so a deletion re-added anywhere on the undo path is seen.
let backendInUse: Backend | null = null;
(window as any).__TAURI_INTERNALS__ = {
	metadata: { currentWindow: { label: 'main' }, currentWebview: { windowLabel: 'main', label: 'main' } },
	invoke: (cmd: string, args?: Record<string, any>) =>
		cmd === 'get_os_type' ? Promise.resolve('macos') : backendInUse ? backendInUse.invoke(cmd, args) : Promise.resolve(null),
};

const { tabManager } = await import('../src/lib/stores/tabs.svelte.js');
const { EditorDocument } = await import('../src/lib/utils/editorDocument.svelte.js');
const clipboard = await import('../src/lib/utils/editorClipboard.js');

// ------------------------------------------------------------------ the fakes

class FakeRange {
	constructor(
		public startLineNumber: number,
		public startColumn: number,
		public endLineNumber: number,
		public endColumn: number,
	) {}
	isEmpty() {
		return this.startLineNumber === this.endLineNumber && this.startColumn === this.endColumn;
	}
}

const monacoStub = { Range: FakeRange, Selection: FakeRange };

type Edit = { range: FakeRange; text: string };
type ChangeEvent = { isUndoing: boolean; isRedoing: boolean };

/**
 * A one-line document with a real undo stack.
 *
 * One line is enough: every insert under test happens at the cursor, and the
 * question is what the listeners do when the text goes back, not how Monaco
 * computes ranges.
 */
function createDocument(initial: string) {
	let buffer = initial;
	let undoStack: string[] = [];
	const listeners: ((e: ChangeEvent) => void)[] = [];

	const dispatch = (e: ChangeEvent) => {
		for (const listener of listeners) listener(e);
	};

	// One object per model, as Monaco's `getModel()` is: the editor compares
	// identities to tell a tab switch happened.
	const modelFor = () => ({
		getValue: () => buffer,
		getValueInRange: (range: FakeRange) => buffer.slice(range.startColumn - 1, range.endColumn - 1),
		getLineContent: () => buffer,
		getLanguageId: () => 'markdown',
		// Read by the status-bar refresh below; line endings are not this
		// file's subject and are tested against real Monaco buffers in
		// documents.test.ts.
		getEOL: () => '\n',
	});
	let model = modelFor();
	let selection: FakeRange | null = null;

	const editor = {
		// Every clipboard entry point focuses the editor first, because two of
		// the three now run from a context menu that would otherwise keep the
		// focus on itself (see editor.checks.test.ts).
		focus: () => {},
		getValue: () => buffer,
		setValue: (text: string) => void (buffer = text),
		getModel: () => model,
		getPosition: () => ({ lineNumber: 1, column: buffer.length + 1 }),
		getSelection: () => selection,
		getSelections: () => [new FakeRange(1, buffer.length + 1, 1, buffer.length + 1)],
		setSelections: () => {},
		getTargetAtClientPoint: () => null,
		// Every paste and drop is its own undo step; `undoStack` below models one
		// entry per edit already.
		pushUndoStop: () => true,
		executeEdits: (_source: string, edits: Edit[]) => {
			undoStack.push(buffer);
			for (const edit of edits) {
				const at = Math.max(0, Math.min(buffer.length, edit.range.startColumn - 1));
				const end = Math.max(at, Math.min(buffer.length, edit.range.endColumn - 1));
				buffer = buffer.slice(0, at) + edit.text + buffer.slice(end);
			}
			dispatch({ isUndoing: false, isRedoing: false });
			return true;
		},
	};

	return {
		editor,
		listeners,
		text: () => buffer,
		/** A plain keystroke, so an undo has something of its own to undo. */
		type: (text: string) => {
			undoStack.push(buffer);
			buffer += text;
			dispatch({ isUndoing: false, isRedoing: false });
		},
		undo: () => {
			assert.ok(undoStack.length > 0, 'precondition: nothing to undo');
			buffer = undoStack.pop()!;
			dispatch({ isUndoing: true, isRedoing: false });
		},
		/** Switching tabs swaps Monaco's model: new text, that model's own history. */
		/** Columns on the one line, end exclusive, as Monaco counts them. */
		select: (startColumn: number, endColumn: number) => {
			selection = new FakeRange(1, startColumn, 1, endColumn);
		},
		loadModel: (text: string) => {
			model = modelFor();
			selection = null;
			buffer = text;
			undoStack = [];
		},
	};
}

type Backend = {
	calls: { cmd: string; args: Record<string, any> }[];
	/** Runs inside a command, before it answers: what the reader does meanwhile. */
	during?: (cmd: string) => void;
	invoke: (cmd: string, args?: Record<string, any>) => Promise<unknown>;
	commandsSince: (mark: number) => string[];
};

function createBackend(clipboardImage: string | null, clipboardFiles: string[] | null): Backend {
	const calls: { cmd: string; args: Record<string, any> }[] = [];
	const backend: Backend = {
		calls,
		invoke: async (cmd: string, args: Record<string, any> = {}) => {
			calls.push({ cmd, args });
			await Promise.resolve();
			backend.during?.(cmd);
			switch (cmd) {
				case 'clipboard_read_file_list':
					return clipboardFiles;
				case 'clipboard_read_image':
					return clipboardImage;
				case 'clipboard_read_text':
					return '';
				case 'save_image':
				case 'copy_file_to_img': {
					const name = args.filename ?? String(args.srcPath).split(/[/\\]/).pop();
					return args.imageDirectory ? `${args.imageDirectory}/${name}` : `/${name}`;
				}
				default:
					return null;
			}
		},
		commandsSince: (mark: number) => calls.slice(mark).map((call) => call.cmd),
	};
	return backend;
}

// ----------------------------------------------------------------- the harness

type Component = {
	paste: () => Promise<void>;
	drop: (path: string, x: number, y: number) => Promise<void>;
	cut: () => Promise<void>;
	contentChange: ((e: ChangeEvent) => void)[];
};

function createComponent(backend: Backend, editor: unknown): Component {
	const deps = {
		editor: () => editor as any,
		monaco: () => monacoStub as any,
		tabs: tabManager,
		settings: { imageDirectory: 'img', macosImageScaling: false },
	};
	const doc = new EditorDocument({
		monaco: () => monacoStub as any,
		editor: () => editor as any,
		tabs: tabManager,
		value: () => tabManager.activeTab?.rawContent ?? '',
		showWordCount: () => true,
	});
	return {
		paste: () => clipboard.pasteFromClipboard(deps),
		drop: (path, x, y) => clipboard.handleDroppedFile(deps, path, x, y),
		cut: () => clipboard.cutToClipboard(deps),
		contentChange: [() => doc.contentChanged()],
	};
}

const PASTED_IMAGE = 'iVBORw0KGgo=';

function setup(
	options: { clipboardImage?: string | null; clipboardFiles?: string[] | null; initial?: string } = {},
) {
	tabManager.closeAll();
	const backend = createBackend(options.clipboardImage ?? null, options.clipboardFiles ?? null);
	backendInUse = backend;
	const doc = createDocument(options.initial ?? '');
	const component = createComponent(backend, doc.editor);
	doc.listeners.push(...component.contentChange);
	return { backend, doc, component };
}

/** `addTab` activates what it opens, which is exactly the tab switch modelled here. */
function openTab(path: string, content = '') {
	tabManager.addTab(path, content);
	const id = tabManager.activeTabId;
	assert.ok(id, `opening ${path} did not activate a tab`);
	return id;
}

const rawContentOf = (id: string) => tabManager.tabs.find((tab) => tab.id === id)?.rawContent;

// ---------------------------------------------------------------- the regression

test('undo after pasting an image touches nothing on disk', async () => {
	const { backend, doc, component } = setup({ clipboardImage: PASTED_IMAGE });
	const tab = openTab('/Users/me/notes/report.md');

	await component.paste();
	const embed = doc.text();
	assert.match(embed, /^!\[alt\]\(img\/paste_\d+\.png\)$/, 'the paste did not insert an embed');

	const mark = backend.calls.length;
	doc.undo();

	assert.deepEqual(
		backend.commandsSince(mark),
		[],
		`an undo after a pasted image reached the backend: ${backend.commandsSince(mark).join(', ')} — undo must move text and nothing else, and the file it used to unlink was unrecoverable`,
	);
	// The undo really arrived, so the assertion above is about behaviour and not
	// about a listener list that happened to be empty.
	assert.equal(doc.text(), '', 'the undo did not revert the buffer');
	assert.equal(rawContentOf(tab), '', 'the undo never reached the component');
});

test('undo after dropping an image touches nothing on disk', async () => {
	const { backend, doc, component } = setup();
	const tab = openTab('/Users/me/notes/report.md', 'before ');
	doc.loadModel('before ');

	await component.drop('/Users/me/pictures/logo.png', 10, 10);
	assert.equal(doc.text(), 'before ![alt](img/logo.png)', 'the drop did not insert an embed');
	assert.ok(
		backend.calls.some((call) => call.cmd === 'copy_file_to_img'),
		'the drop did not copy the file next to the document',
	);

	const mark = backend.calls.length;
	doc.undo();

	assert.deepEqual(
		backend.commandsSince(mark),
		[],
		`an undo after a dropped image reached the backend: ${backend.commandsSince(mark).join(', ')} — the copy stays where the user can see it, in <document>/img/`,
	);
	assert.equal(doc.text(), 'before ', 'the undo did not revert the buffer');
	assert.equal(rawContentOf(tab), 'before ', 'the undo never reached the component');
});

test('an undo in one tab does not reach into another tab that dropped an image', async () => {
	/*
	 * The reported data loss. One Editor instance survives a tab switch, so the
	 * bookkeeping mixed every tab's images while the handler only ever looked at
	 * the newest entry — an undo in B found B's buffer innocent of A's embed, of
	 * course, and deleted A's file while A was still displaying it.
	 *
	 * There is no longer anything to mis-attribute, which is the argument for
	 * removing the deletion over correcting it.
	 */
	const { backend, doc, component } = setup();
	const tabA = openTab('/Users/me/notes/a.md');
	await component.drop('/Users/me/pictures/shared.png', 10, 10);
	const embedInA = doc.text();
	assert.equal(embedInA, '![alt](img/shared.png)', 'precondition: tab A holds the embed');

	// Switch to B, as the user does: same component, a different model.
	const tabB = openTab('/Users/me/notes/b.md', 'notes in B');
	doc.loadModel('notes in B');
	doc.type(' and more');

	const mark = backend.calls.length;
	doc.undo();

	assert.deepEqual(
		backend.commandsSince(mark),
		[],
		`an undo in tab B reached the backend after a drop in tab A: ${backend.commandsSince(mark).join(', ')} — this is the path that deleted a file tab A was still showing`,
	);
	assert.equal(doc.text(), 'notes in B', 'the undo did not revert tab B');
	assert.equal(rawContentOf(tabB), 'notes in B', 'the undo never reached the component');
	assert.equal(rawContentOf(tabA), embedInA, "tab A's document changed");
});

// ------------------------------------------------------------------ the fences
//
// These pass today and would also pass for an editor that had stopped
// inserting images altogether, which is what they are here to stop.

test('pasting an image still copies it and inserts the embed', async () => {
	const { backend, doc, component } = setup({ clipboardImage: PASTED_IMAGE });
	openTab('/Users/me/notes/report.md');

	await component.paste();

	const save = backend.calls.find((call) => call.cmd === 'save_image');
	assert.ok(save, 'the pasted image was never written');
	assert.equal(save!.args.parentDir, '/Users/me/notes', 'the image was written outside the document folder');
	assert.equal(save!.args.imageDirectory, 'img');
	assert.equal(save!.args.base64Data, PASTED_IMAGE);
	assert.match(doc.text(), /^!\[alt\]\(img\/paste_\d+\.png\)$/);
});

test('pasting image files copied in a file manager copies them as a drop does (#768)', async () => {
	// Finder can put a preview image on the clipboard beside the files; the
	// files are what the user copied, so they win and the preview is not read.
	const { backend, doc, component } = setup({
		clipboardFiles: ['/Users/me/pictures/a.png', '/Users/me/notes/other.md', '/Users/me/pictures/b.JPG'],
		clipboardImage: PASTED_IMAGE,
	});
	openTab('/Users/me/notes/report.md');

	await component.paste();

	assert.deepEqual(
		backend.calls.filter((call) => call.cmd === 'copy_file_to_img').map((call) => call.args.srcPath),
		['/Users/me/pictures/a.png', '/Users/me/pictures/b.JPG'],
	);
	assert.equal(backend.calls.filter((call) => call.cmd === 'save_image').length, 0);
	assert.equal(doc.text(), '![alt](img/a.png)\n![alt](img/b.JPG)');
});

test('dropping a file still copies it and inserts the embed', async () => {
	const { backend, doc, component } = setup();
	openTab('/Users/me/notes/report.md');

	await component.drop('/Users/me/pictures/logo.png', 10, 10);

	const copy = backend.calls.find((call) => call.cmd === 'copy_file_to_img');
	assert.ok(copy, 'the dropped file was never copied');
	assert.deepEqual(
		{ srcPath: copy!.args.srcPath, parentDir: copy!.args.parentDir, imageDirectory: copy!.args.imageDirectory },
		{ srcPath: '/Users/me/pictures/logo.png', parentDir: '/Users/me/notes', imageDirectory: 'img' },
	);
	assert.equal(doc.text(), '![alt](img/logo.png)');
});

// ------------------------------------------------- a tab switch during the write

test('an image pasted in one tab is not linked into the tab switched to meanwhile', async () => {
	const { backend, doc, component } = setup({ clipboardImage: PASTED_IMAGE });
	const tabA = openTab('/Users/me/notes/a.md');
	let tabB = '';
	backend.during = (cmd) => {
		if (cmd !== 'save_image') return;
		tabB = openTab('/Users/me/other/b.md', 'notes in B');
		doc.loadModel('notes in B');
	};

	await component.paste();

	assert.ok(backend.calls.some((call) => call.cmd === 'save_image'), 'precondition: the image was written');
	assert.equal(doc.text(), 'notes in B', "the link to a.md's image landed in b.md, where it resolves to nothing");
	assert.equal(rawContentOf(tabB), 'notes in B');
	assert.equal(rawContentOf(tabA), '');
});

test('an image dropped in one tab is not linked into the tab switched to meanwhile', async () => {
	const { backend, doc, component } = setup();
	openTab('/Users/me/notes/a.md');
	backend.during = (cmd) => {
		if (cmd !== 'copy_file_to_img') return;
		openTab('/Users/me/other/b.md', 'notes in B');
		doc.loadModel('notes in B');
	};

	await component.drop('/Users/me/pictures/logo.png', 10, 10);

	assert.equal(doc.text(), 'notes in B', "the link to a.md's image landed in b.md, where it resolves to nothing");
});

test('a cut does not delete its range from the tab switched to during the clipboard write', async () => {
	const { backend, doc, component } = setup();
	openTab('/Users/me/notes/a.md', 'keep this');
	doc.loadModel('keep this');
	doc.select(1, 5);
	backend.during = (cmd) => {
		if (cmd !== 'clipboard_write_text') return;
		openTab('/Users/me/other/b.md', 'notes in B');
		doc.loadModel('notes in B');
	};

	await component.cut();

	assert.equal(doc.text(), 'notes in B', "a's selection range was cut out of b.md");
});

test('a cut with no tab switch still removes the selection', async () => {
	const { doc, component } = setup();
	openTab('/Users/me/notes/a.md', 'keep this');
	doc.loadModel('keep this');
	doc.select(1, 6);

	await component.cut();

	assert.equal(doc.text(), 'this');
});

test('an ordinary edit still propagates to the active tab', () => {
	// The harness's own wiring: if this went quiet, "no backend call on undo"
	// would be measuring an editor nobody is listening to.
	const { doc } = setup();
	const tab = openTab('/Users/me/notes/report.md');

	doc.type('hello');

	assert.equal(rawContentOf(tab), 'hello', 'a content change never reached the component');
});
