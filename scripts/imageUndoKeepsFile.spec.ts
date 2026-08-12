import assert from 'node:assert/strict';

import { test } from 'vitest';

import ts from 'typescript';

import { callbackBodies, functionSource, readSource } from './sourceTree.js';

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
 * They RUN the code rather than reading it. A `.svelte` file cannot be
 * imported by the Node test runner, so — following windowTagDismiss.test.ts
 * and homeTabRender.test.ts — the Ctrl+V command callback, the exported
 * `handleDroppedFile`, and EVERY `onDidChangeModelContent` listener the
 * component registers are lifted out of the parsed component and evaluated
 * over one shared scope, one fake Monaco document with a real undo stack, and
 * the real `TabManager`. Nothing below asserts how any of it is spelled.
 *
 * "Every listener" is the load-bearing part. The check is not "the file no
 * longer contains `delete_file`" — that is the assertion shape this suite has
 * been burned by twice — it is "dispatch an undo at whatever the component
 * listens with, and see what reaches the backend". A deletion re-added in any
 * listener, under any command name, is caught.
 *
 * Each undo test also asserts that the undo *arrived* — the buffer reverted
 * and the tab's raw content followed it. Without that, "no backend call" would
 * also be satisfied by a harness that dispatched into thin air.
 *
 * Falsified before landing, both ways round: with the original handler put
 * back, and with a bare `invoke("delete_file")` on `e.isUndoing`. All three
 * regression tests go red ("an undo after a pasted image reached the backend:
 * delete_file") and all three fences stay green.
 *
 * What this does not establish: that Monaco groups an image insert into one
 * undo step, or anything about the real clipboard. It establishes what the
 * component's own handlers do when an undo reaches them.
 */

// ---------------------------------------------------------------- environment
// Svelte runes and the Tauri bridge, faked as homeSentinelSnapshot.ts does, so
// `tabs.svelte.ts` imports under plain node.

// The runes are the compiler's, not ours: vitest builds `.svelte.ts` through the
// Svelte plugin, so the store and the session run under real reactivity, and jsdom
// supplies `window` and `localStorage`. Only the Tauri backend is stubbed.
(window as any).__TAURI_INTERNALS__ = {
	metadata: { currentWindow: { label: 'main' }, currentWebview: { windowLabel: 'main', label: 'main' } },
	invoke: (cmd: string) => Promise.resolve(cmd === 'get_os_type' ? 'macos' : null),
};

const { tabManager } = await import('../src/lib/stores/tabs.svelte.js');
const { lineEndingLabel } = await import('../src/lib/utils/tabModels.js');
// The real module, not a stub: the embed these tests match against is the one
// it writes, and its escaping is pinned separately in imageEmbed.test.ts.
const { DEFAULT_IMAGE_DIRECTORY, documentParentDir, imageEmbed } = await import(
	'../src/lib/utils/imageEmbed.js'
);

// ------------------------------------------------- the component, as written

const EDITOR = 'src/lib/components/Editor.svelte';
const source = readSource(EDITOR);

/**
 * Everything a paste does — including the branch that reads a clipboard image.
 *
 * It was the body of the one `editor.addCommand` for ⌘V until the editor's
 * context menu started running it too (#207), at which point it was named. The
 * lookup is by name now, and the second assertion is what keeps that from
 * being a downgrade: no inline paste may appear beside it, because two paste
 * implementations would drift and only one of them would be tested here.
 */
const pasteCommandBody = (() => {
	const body = functionSource(source, 'pasteFromClipboard');
	assert.ok(body.includes('clipboard_read_image'), 'pasteFromClipboard no longer reads the clipboard image');
	assert.equal(
		callbackBodies(source, 'editor.addCommand').filter((b) => b.includes('clipboard_read_image')).length,
		0,
		'a second, inline paste implementation has appeared beside the named one',
	);
	return body;
})();

/**
 * Every model-content listener the component installs.
 *
 * Deliberately not "the one that handles undo": the component is free to have
 * none, one, or five, and the claim under test is about all of them together.
 */
const contentChangeBodies = callbackBodies(source, 'editor.onDidChangeModelContent');

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

	const editor = {
		// Every clipboard entry point focuses the editor first, because two of
		// the three now run from a context menu that would otherwise keep the
		// focus on itself (see issue261EditorPdf.test.ts).
		focus: () => {},
		getValue: () => buffer,
		setValue: (text: string) => void (buffer = text),
		getModel: () => ({
			getValue: () => buffer,
			getValueInRange: (range: FakeRange) => buffer.slice(range.startColumn - 1, range.endColumn - 1),
			getLineContent: () => buffer,
			getLanguageId: () => 'markdown',
			// Read by the status-bar refresh below; line endings are not this
			// file's subject and are tested against real Monaco buffers in
			// editorLineEnding.test.ts.
			getEOL: () => '\n',
		}),
		getPosition: () => ({ lineNumber: 1, column: buffer.length + 1 }),
		getSelection: () => null,
		getSelections: () => [new FakeRange(1, buffer.length + 1, 1, buffer.length + 1)],
		setSelections: () => {},
		getTargetAtClientPoint: () => null,
		executeEdits: (_source: string, edits: Edit[]) => {
			undoStack.push(buffer);
			for (const edit of edits) {
				const at = Math.max(0, Math.min(buffer.length, edit.range.startColumn - 1));
				buffer = buffer.slice(0, at) + edit.text + buffer.slice(at);
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
		loadModel: (text: string) => {
			buffer = text;
			undoStack = [];
		},
	};
}

type Backend = {
	calls: { cmd: string; args: Record<string, any> }[];
	invoke: (cmd: string, args?: Record<string, any>) => Promise<unknown>;
	commandsSince: (mark: number) => string[];
};

function createBackend(clipboardImage: string | null): Backend {
	const calls: { cmd: string; args: Record<string, any> }[] = [];
	return {
		calls,
		invoke: async (cmd: string, args: Record<string, any> = {}) => {
			calls.push({ cmd, args });
			switch (cmd) {
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
}

// ----------------------------------------------------------------- the harness

type Component = {
	paste: () => Promise<void>;
	drop: (path: string, x: number, y: number) => Promise<void>;
	contentChange: ((e: ChangeEvent) => void)[];
};

/**
 * The lifted code is TypeScript — `handleDroppedFile(path: string, …)`, `as
 * string | null`, `(editor as any)` — and `new Function` only takes JavaScript,
 * so it goes through `tsc` first, as foldStatePerDocument.test.ts and
 * viewModeWithoutSaving.test.ts already do. Types are erased, nothing else:
 * the statements that run are the component's own.
 */
const factorySource = ts.transpileModule(
	`const __component = (invoke, settings, tabManager, monaco, editor, lineEndingLabel, DEFAULT_IMAGE_DIRECTORY, documentParentDir, imageEmbed) => {
		let wordCount = 0;
		let currentLanguage = 'markdown';
		let lineEnding = 'LF';

		// The status-bar refresh the content-change listener calls. Lifted from
		// the component rather than stubbed, so the listener under test runs
		// exactly the statements it runs in the app; nothing here asserts on
		// what it writes.
		${functionSource(source, 'syncStatusFromModel')}

		// Reached only by the text-paste path, which no test here exercises.
		const insertTextAtCursor = () => { throw new Error('text paste path not modelled'); };
		const isLinkifyPasteTarget = () => false;

		${functionSource(source, 'handleDroppedFile')}
		${pasteCommandBody}

		return {
			paste: pasteFromClipboard,
			drop: handleDroppedFile,
			contentChange: [${contentChangeBodies.map((body) => `(e) => ${body}`).join(', ')}],
		};
	};`,
	{ compilerOptions: { target: ts.ScriptTarget.ES2022 } },
).outputText;

/**
 * Anything the lifted code reads that is neither declared above nor a global
 * lands here — component-level state this harness does not model.
 *
 * Without it, re-adding the undo deletion would fail these tests with
 * `managedImages is not defined` and blame the harness. The whole reason such
 * state existed was to decide which file to delete, so the error says so.
 *
 * It sits in a `with` scope wrapped around the factory, which is *outside* the
 * lifted functions — so their own parameters and `let`s still shadow it, and
 * only genuinely unresolved names reach the proxy.
 */
const unmodelledScope = new Proxy(Object.create(null), {
	has: (_target, key) => typeof key === 'string' && !(key in globalThis),
	get: (_target, key) => {
		// The `value` prop, modelled as what Svelte compiles a dynamic prop to:
		// a getter over the parent's expression, which is
		// `value={tabManager.activeTab.rawContent}`. A local copy would be a
		// second buffer with its own staleness — the very thing the component
		// stopped keeping when `bind:value` went — and the listener's
		// `value !== newValue` guard would then mean "changed since this copy
		// was last assigned" instead of "the editor changed the document".
		if (key === 'value') return tabManager.activeTab?.rawContent ?? '';
		if (typeof key !== 'string') return undefined;
		throw new Error(
			`the editor reads component state \`${String(key)}\` that this harness does not model. ` +
				'If it is per-image bookkeeping: undo must not track which file to delete (#368) — ' +
				'the copy stays on disk, where the user can see and remove it.',
		);
	},
});

function createComponent(backend: Backend, editor: unknown): Component {
	const factory = new Function(
		'__scope',
		`with (__scope) { ${factorySource}\nreturn __component; }`,
	)(unmodelledScope) as (
		invoke: unknown,
		settings: unknown,
		tabManager: unknown,
		monaco: unknown,
		editor: unknown,
		lineEndingLabel: unknown,
		defaultImageDirectory: unknown,
		parentDir: unknown,
		embed: unknown,
	) => Component;

	return factory(
		backend.invoke,
		{ imageDirectory: 'img', macosImageScaling: false },
		tabManager,
		monacoStub,
		editor,
		lineEndingLabel,
		DEFAULT_IMAGE_DIRECTORY,
		documentParentDir,
		imageEmbed,
	);
}

const PASTED_IMAGE = 'iVBORw0KGgo=';

function setup(options: { clipboardImage?: string | null; initial?: string } = {}) {
	tabManager.closeAll();
	const backend = createBackend(options.clipboardImage ?? null);
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

test('an ordinary edit still propagates to the active tab', () => {
	// The harness's own wiring: if this went quiet, "no backend call on undo"
	// would be measuring an editor nobody is listening to.
	const { doc } = setup();
	const tab = openTab('/Users/me/notes/report.md');

	doc.type('hello');

	assert.equal(rawContentOf(tab), 'hello', 'a content change never reached the component');
});
