import assert from 'node:assert/strict';
import test from 'node:test';

import ts from 'typescript';

import { callbackBodies, functionSource, readSource } from './sourceTree.js';

/*
 * Undo history has to survive a tab switch (#391), and every model that is
 * created has to be disposed.
 *
 * The defect: one Monaco editor, one implicit model, and a tab switch that
 * overwrote it with `editor.setValue(content)`. `TextModel.setValue` is
 * *defined* to throw the undo stack away — `_setValueFromTextBuffer` runs
 * `this._commandManager.clear()` under the comment "Destroy my edit history and
 * settings" — so leaving a document and coming back cost the user everything
 * they could have undone.
 *
 * The fix is one `ITextModel` per tab, which is Monaco's intended usage and how
 * VS Code works: the editor is a view, `setModel` swaps which document it shows,
 * and undo belongs to the document. The price is lifetime: Monaco models are
 * registered with the model service and are NOT garbage collected while
 * registered, so a model whose tab is gone leaks its buffer, its tokenization
 * state and its worker-side copy for the life of the window.
 *
 * WHAT RUNS HERE. The component's own tab-activation `$effect`, its
 * `acquireTabModel`, its `onDidChangeModelContent` listener and its exported
 * `undo` are lifted out of Editor.svelte and evaluated over one scope, against
 * the REAL `TabManager` and the REAL model registry (`utils/tabModels.ts`).
 * Only Monaco itself is a fake — a `.svelte` file cannot be imported by the Node
 * test runner and Monaco needs a DOM — and the fake reproduces the two
 * semantics the whole question turns on, both read out of the bundled 0.55.1
 * source and cited at `FakeModel` below: `setValue` clears the undo stack,
 * `setModel` does not.
 *
 * WHAT IT DOES NOT ESTABLISH: rendering, focus, Svelte's scheduling, or that
 * Monaco's real undo stack behaves as its source says. It establishes what the
 * component does when its handlers run.
 */

// ---------------------------------------------------------------- environment
// Svelte runes and the Tauri bridge, faked as windowTagEditor.ts does, so
// `tabs.svelte.ts` imports under plain node.

const g = globalThis as any;
const runeEffect = (fn: () => void) => {
	void fn;
};
runeEffect.root = (fn: () => unknown) => fn();
g.$state = (value: unknown) => value;
g.$state.raw = (value: unknown) => value;
g.$state.snapshot = (value: unknown) => value;
g.$derived = (value: unknown) => value;
g.$derived.by = (fn: () => unknown) => fn();
g.$effect = runeEffect;
g.window = g.window ?? {};

const localStore = new Map<string, string>();
g.localStorage = {
	getItem: (key: string) => (localStore.has(key) ? localStore.get(key)! : null),
	setItem: (key: string, value: string) => void localStore.set(key, String(value)),
	removeItem: (key: string) => void localStore.delete(key),
	clear: () => localStore.clear(),
};
g.window.__TAURI_INTERNALS__ = {
	metadata: { currentWindow: { label: 'main' }, currentWebview: { windowLabel: 'main', label: 'main' } },
	invoke: (cmd: string) => Promise.resolve(cmd === 'get_os_type' ? 'macos' : null),
};

const { tabManager } = await import('../src/lib/stores/tabs.svelte.js');
const { getTabModel, lineEndingLabel, tabModelUri, trackedTabModelIds } = await import(
	'../src/lib/utils/tabModels.js'
);
const { buildTransferredTab } = await import('../src/lib/utils/tabTransfer.js');

// ------------------------------------------------- the component, as written

const EDITOR = 'src/lib/components/Editor.svelte';
const source = readSource(EDITOR);

/**
 * The tab-activation effect — the one that files a view state under the tab it
 * is leaving. Identified by what it does rather than by its position in the
 * file, and pinned to exactly one so a split or a merge fails here loudly
 * instead of quietly running half the code.
 */
const activationEffectBody = (() => {
	const bodies = callbackBodies(source, '$effect').filter((body) => body.includes('updateTabEditorState'));
	assert.equal(bodies.length, 1, `expected exactly one tab-activation $effect in ${EDITOR}, found ${bodies.length}`);
	return bodies[0];
})();

const contentChangeBody = (() => {
	const bodies = callbackBodies(source, 'editor.onDidChangeModelContent');
	assert.equal(bodies.length, 1, `expected exactly one model-content listener in ${EDITOR}, found ${bodies.length}`);
	return bodies[0];
})();

/**
 * The one function bound to `name`, or `fallback` when the component has no
 * such function.
 *
 * The fallback exists for the falsification run, and it is what makes that run
 * worth anything. Reverting the fix deletes `acquireTabModel`; asserting on its
 * presence here would turn every test in this file red with the same structural
 * message, and none of them would then be evidence about undo. A component that
 * never acquires a per-tab model behaves exactly like one whose acquire does
 * nothing — so that is what it is given, and each test fails on its own claim.
 * Same reasoning as `runnable` in windowTagEditor.ts.
 */
function lifted(name: string, fallback: string): string {
	try {
		return functionSource(source, name);
	} catch {
		return fallback;
	}
}

// ------------------------------------------------------------------ the fakes

/**
 * A Monaco text model, with the two behaviours this file is about.
 *
 * `setValue` clearing the undo stack is not an approximation — it is what the
 * bundled Monaco does, and the reason #391 exists:
 *
 *     _setValueFromTextBuffer(textBuffer, …) {
 *         …
 *         // Destroy my edit history and settings
 *         this._commandManager.clear();
 *
 * (monaco-editor@0.55.1, esm/vs/editor/common/model/textModel.js). `setModel`
 * has no such line: it detaches one document and attaches another, and each
 * keeps its own `_commandManager`.
 *
 * A model is registered under its URI and `createModel` throws on a duplicate,
 * as Monaco's model service does — which is what makes the "two tabs never
 * collide" claim below a real test rather than a restatement of the code.
 */
class FakeModel {
	private buffer: string;
	private undoStack: string[] = [];
	private redoStack: string[] = [];
	private disposed = false;

	constructor(
		readonly uri: string,
		value: string,
		private language: string,
		private readonly onDispose: (model: FakeModel) => void,
	) {
		this.buffer = value;
	}

	getValue() {
		this.assertLive();
		return this.buffer;
	}

	setValue(value: string) {
		this.assertLive();
		this.buffer = value;
		// "Destroy my edit history and settings" — TextModel._setValueFromTextBuffer.
		this.undoStack = [];
		this.redoStack = [];
	}

	getLanguageId() {
		return this.language;
	}

	/**
	 * Fixed, because nothing here is about line endings: the status-bar label
	 * that reads this is driven against real Monaco buffers in
	 * `editorLineEnding.test.ts`, and a fake that guessed an EOL from its
	 * buffer would be a second implementation of exactly what that fix removed.
	 */
	getEOL() {
		return '\n';
	}

	setLanguage(language: string) {
		this.language = language;
	}

	isDisposed() {
		return this.disposed;
	}

	dispose() {
		this.disposed = true;
		this.onDispose(this);
	}

	// --- test-side document mutation, not part of the ITextModel surface ---

	/** A user edit: the kind of change that goes on the undo stack. */
	edit(value: string) {
		this.assertLive();
		this.undoStack.push(this.buffer);
		this.redoStack = [];
		this.buffer = value;
	}

	undo() {
		this.assertLive();
		const previous = this.undoStack.pop();
		if (previous === undefined) return false;
		this.redoStack.push(this.buffer);
		this.buffer = previous;
		return true;
	}

	undoDepth() {
		return this.undoStack.length;
	}

	private assertLive() {
		// Monaco's `_assertNotDisposed`. A disposed model handed back to the
		// editor is a crash in the app, so it must be one here too.
		assert.ok(!this.disposed, `model ${this.uri} was used after dispose()`);
	}
}

/** Every model this run has built, disposed or not — the leak ledger. */
let createdModels: FakeModel[] = [];
/** URI → model, standing in for Monaco's model service registry. */
let registeredModels = new Map<string, FakeModel>();

const monacoStub = {
	Uri: { parse: (uri: string) => uri },
	editor: {
		createModel(value: string, language: string, uri: string) {
			assert.ok(
				!registeredModels.has(uri),
				`Monaco refuses a second model on the URI ${uri} — two tabs must never share one`,
			);
			const model = new FakeModel(uri, value, language, (m) => registeredModels.delete(m.uri));
			registeredModels.set(uri, model);
			createdModels.push(model);
			return model;
		},
		setModelLanguage(model: FakeModel, language: string) {
			model.setLanguage(language);
		},
	},
};

type ViewState = { marker: string } | null;

/**
 * The editor as a VIEW onto whichever model is attached, which is the shape the
 * fix depends on. `getValue`/`setValue` delegate to the attached model exactly
 * as `CodeEditorWidget` does (`this._modelData.model.setValue(newValue)`), and
 * both answer for a detached editor the way it does: `''`, and nothing.
 */
function createEditorStub() {
	// The editor starts attached to a model it built for itself — what
	// `monaco.editor.create(container, { value, language })` does, and what "one
	// implicit model shared by every tab" IS. Whether a tab's own model ever
	// replaces it is the question under test, so the harness must not assume one
	// is there. Built directly rather than through `monaco.editor.createModel`
	// so it stays out of the leak ledger: this one belongs to the editor and
	// goes with it, which is the one case Monaco disposes for you.
	let model: FakeModel | null = new FakeModel('inmemory://markpad/editor-owned', '', 'markdown', () => {});
	let viewState: ViewState = null;
	const restored: ViewState[] = [];
	const contentListeners: (() => void)[] = [];

	// Monaco raises a content change for every mutation of the attached model,
	// `setValue` included (it is emitted as a flush). Modelling that matters:
	// it is how an undo reaches `tab.rawContent` at all, and leaving it out
	// would let the editor and the document disagree with nothing to notice.
	const dispatch = () => {
		for (const listener of contentListeners) listener();
	};

	return {
		restored,
		getModel: () => model,
		setModel: (next: FakeModel | null) => void (model = next),
		getValue: () => (model ? model.getValue() : ''),
		setValue: (value: string) => {
			if (!model) return;
			model.setValue(value);
			dispatch();
		},
		saveViewState: () => viewState,
		restoreViewState: (state: ViewState) => void restored.push(state),
		setScrollTop: () => {},
		setPosition: () => {},
		focus: () => {},
		trigger: (_source: string, command: string) => {
			if (command === 'undo' && model?.undo()) dispatch();
		},
		/** Test-side: the component's `onDidChangeModelContent` registration. */
		onContentChange: (listener: () => void) => void contentListeners.push(listener),
		/** Test-side: a user edit in the attached document. */
		edit: (text: string) => {
			assert.ok(model, 'precondition: a document is attached');
			model!.edit(text);
			dispatch();
		},
		/** Test-side: mark the view state so a restore can be identified. */
		markViewState: (marker: string) => void (viewState = { marker }),
	};
}

// ----------------------------------------------------------------- the harness

type Editor = ReturnType<typeof createEditorStub>;

type Component = {
	/** The tab-activation effect, run the way Svelte would run it. */
	activate: () => void;
	/** The `onDidChangeModelContent` listener. */
	contentChanged: () => void;
	/** The component's exported undo. */
	undo: () => void;
	acquireTabModel: (tabId: string, seed: string, language: string) => FakeModel | null;
	setLanguage: (language: string) => void;
	currentTabId: () => string | null;
	currentLanguage: () => string;
	wordCount: () => number;
};

/**
 * The lifted code is TypeScript (`function acquireTabModel(tabId: string, …)`)
 * and `new Function` only parses JavaScript, so it goes through `tsc` first —
 * as imageUndoKeepsFile.test.ts and foldStatePerDocument.test.ts already do.
 * Types are erased, nothing else: the statements that run are the component's.
 */
const factorySource = ts.transpileModule(
	`const __component = (tabManager, monaco, editor, getTabModel, tabModelUri, lineEndingLabel) => {
		let currentTabId = null;
		let language = 'markdown';
		let currentLanguage = 'markdown';
		let wordCount = 0;
		let lineEnding = 'LF';
		const editorReady = true;

		${lifted('syncStatusFromModel', 'function syncStatusFromModel() {}')}
		${lifted('acquireTabModel', 'function acquireTabModel() { return null; }')}
		// The component binds undo to an arrow function, so what comes back is
		// the expression rather than a declaration: it needs its own binding.
		const undo = ${lifted('undo', '() => {}')};

		return {
			activate: () => ${activationEffectBody},
			contentChanged: () => ${contentChangeBody},
			undo,
			acquireTabModel,
			setLanguage: (next) => { language = next; },
			currentTabId: () => currentTabId,
			currentLanguage: () => currentLanguage,
			wordCount: () => wordCount,
		};
	};`,
	{ compilerOptions: { target: ts.ScriptTarget.ES2022 } },
).outputText;

/**
 * The `value` prop, modelled as what Svelte compiles a dynamic prop to: a
 * getter over the parent's expression, which is
 * `value={tabManager.activeTab.rawContent}`. It used to be `bind:value`, and
 * this harness used to mirror it with a local the tests re-synced by hand —
 * which is the same second copy of the buffer, and the same chance for the two
 * to disagree, that the component itself no longer keeps.
 *
 * A null-prototype object so `with` captures this one name and not
 * `toString`, `constructor` and the rest of Object.prototype.
 */
const propsScope = Object.defineProperty(Object.create(null), 'value', {
	get: () => tabManager.activeTab?.rawContent ?? '',
});

function createComponent(editor: Editor): Component {
	const factory = new Function(
		'__props',
		`with (__props) { ${factorySource}\nreturn __component; }`,
	)(propsScope) as (
		tabManager: unknown,
		monaco: unknown,
		editor: unknown,
		getTabModel: unknown,
		tabModelUri: unknown,
		lineEndingLabel: unknown,
	) => Component;

	return factory(tabManager, monacoStub, editor, getTabModel, tabModelUri, lineEndingLabel);
}

type Harness = {
	editor: Editor;
	component: Component;
	/** Open a tab and return its id. */
	open: (path: string, content: string) => string;
	/** Activate a tab the way the app does: set active, re-bind, run the effect. */
	show: (tabId: string) => void;
	/** A keystroke in the attached document, propagated as Monaco would. */
	type: (text: string) => void;
	/** The text the user sees. */
	text: () => string;
	modelOf: (tabId: string) => FakeModel | undefined;
};

function setup(): Harness {
	tabManager.closeAll();
	createdModels = [];
	registeredModels = new Map();

	const editor = createEditorStub();
	const component = createComponent(editor);
	editor.onContentChange(component.contentChanged);

	const show = (tabId: string) => {
		tabManager.setActive(tabId);
		component.activate();
	};

	return {
		editor,
		component,
		open: (path, content) => {
			tabManager.addTab(path, content);
			return tabManager.activeTabId!;
		},
		show,
		type: (text: string) => editor.edit(editor.getValue() + text),
		text: () => editor.getValue(),
		modelOf: (tabId: string) => registeredModels.get(tabModelUri(tabId)),
	};
}

/**
 * The lifetime invariant, stated once: no model outlives its tab, and no model
 * is alive outside the registry that is supposed to be reaping it.
 *
 * Two claims, because either alone is satisfiable by a broken implementation. A
 * registry that only holds live tabs proves nothing if models are also created
 * behind its back; a ledger of disposed models proves nothing if the registry
 * still points at them.
 *
 * `expectModels` is the vacuity guard. Every assertion below is trivially true
 * for a run that never built a model, which is precisely the state a broken
 * `acquireTabModel` produces — so each caller says how many it expects to have
 * seen.
 */
function assertNoModelOutlivesItsTab(expectModels: number, context: string) {
	assert.equal(createdModels.length, expectModels, `${context}: models built during this test`);

	const tabIds = tabManager.tabs.map((tab) => tab.id);
	const tracked = trackedTabModelIds();

	assert.deepEqual(
		tracked.filter((id) => !tabIds.includes(id)),
		[],
		`${context}: the registry still holds a model for a tab that is gone`,
	);

	const aliveUris = createdModels.filter((model) => !model.isDisposed()).map((model) => model.uri).sort();
	const trackedUris = tracked.map((id) => tabModelUri(id)).sort();
	assert.deepEqual(
		aliveUris,
		trackedUris,
		`${context}: a model is still alive that nothing is tracking — it can never be disposed`,
	);
}

// ------------------------------------------------------- the reported defect

test('an edit can still be undone after switching to another tab and back', () => {
	// #391, verbatim: "Switch to another tab and back, then press Ctrl/⌘+Z —
	// the document's undo history is gone."
	const h = setup();
	const notes = h.open('/docs/notes.md', 'hello');
	const other = h.open('/docs/other.md', 'elsewhere');

	h.show(notes);
	h.type(' world');
	assert.equal(h.text(), 'hello world', 'precondition: the edit landed');

	h.show(other);
	h.show(notes);

	h.component.undo();

	assert.equal(
		h.text(),
		'hello',
		'undo did nothing after a round trip through another tab — the switch destroyed the undo stack, which is what setValue is defined to do',
	);
	assert.equal(
		tabManager.tabs.find((tab) => tab.id === notes)!.rawContent,
		'hello',
		'the undone text never reached the tab buffer, so the document and the editor disagree',
	);
});

test('the undo history of a background tab is not touched by editing another one', () => {
	const h = setup();
	const a = h.open('/docs/a.md', 'A');
	const b = h.open('/docs/b.md', 'B');

	h.show(a);
	h.type('1');
	h.show(b);
	h.type('2');
	h.show(a);

	h.component.undo();
	assert.equal(h.text(), 'A', 'the edit in A did not come back');

	h.show(b);
	h.component.undo();
	assert.equal(h.text(), 'B', "editing A consumed B's undo history");
});

test('undo does not reach past the point where the document was opened', () => {
	// The other half of "undo follows the document": a per-tab stack must not
	// let one document's undo walk into text it never contained.
	const h = setup();
	const a = h.open('/docs/a.md', 'A');
	h.show(a);
	h.type('1');

	h.component.undo();
	assert.equal(h.text(), 'A');
	h.component.undo();
	assert.equal(h.text(), 'A', 'undo went past the opened state');
});

// ------------------------------------------- what setValue is still there for

test('a buffer replaced behind the editor still clears undo', () => {
	// External writes — a reload from disk, an accepted external change, a
	// truncated buffer completed, a task checkbox toggled from the preview —
	// hand the tab a DIFFERENT document. Undo across that boundary would splice
	// two texts together, so `setValue` (and its stack clearing) is the right
	// call and is deliberately kept. Stated as a test because it is a decision,
	// not an oversight.
	const h = setup();
	const a = h.open('/docs/a.md', 'A');
	h.show(a);
	h.type('1');

	tabManager.setTabRawContent(a, 'from disk');
	h.component.activate();

	assert.equal(h.text(), 'from disk', 'the external write did not reach the editor');
	h.component.undo();
	assert.equal(h.text(), 'from disk', 'undo resurrected a buffer the reload replaced');
});

test('a tab pointed at another document does not carry its undo history across', () => {
	// `navigate` — following a link inside the same tab. Same tab id, so the
	// same model, but a different document: the text is replaced and the stack
	// has to go with it.
	const h = setup();
	const a = h.open('/docs/a.md', 'A');
	h.show(a);
	h.type('1');

	tabManager.navigate(a, '/docs/linked.md');
	tabManager.setTabRawContent(a, 'linked');
	h.component.activate();

	h.component.undo();
	assert.equal(h.text(), 'linked', 'undo reached back into the document this tab used to hold');
});

test('renaming a tab keeps the undo history, because the document did not change', () => {
	// Save As and rename change the path while the text on screen stays put —
	// the mirror image of the test above, and the reason the model is keyed by
	// tab id rather than by path.
	const h = setup();
	const a = h.open('/docs/a.md', 'A');
	h.show(a);
	h.type('1');

	tabManager.renameTab(a, '/docs/renamed.md');
	h.component.activate();

	h.component.undo();
	assert.equal(h.text(), 'A', 'renaming the file threw away the undo history of its buffer');
});

// -------------------------------------------------------------- the language

test('a tab that follows a link into another file type re-languages its model', () => {
	// `language` is derived from the ACTIVE TAB'S PATH, and the model outlives
	// every route that repoints a tab. A language fixed at creation would be the
	// extension of whatever file the tab held the first time it was edited.
	const h = setup();
	const a = h.open('/docs/a.md', 'A');
	h.show(a);
	assert.equal(h.modelOf(a)?.getLanguageId(), 'markdown');

	tabManager.navigate(a, '/docs/script.ts');
	h.component.setLanguage('typescript');
	h.component.activate();

	assert.equal(h.modelOf(a)?.getLanguageId(), 'typescript', 'the model kept the language of the previous document');
	assert.equal(h.component.currentLanguage(), 'typescript', 'the status bar kept the previous language');
});

test('switching tabs refreshes the readings that used to arrive with setValue', () => {
	// `setValue` fired a content change as a side effect, which is what kept the
	// word count current. `setModel` does not — no content changed, a different
	// document arrived — so the switch has to ask.
	const h = setup();
	const a = h.open('/docs/a.md', 'one');
	const b = h.open('/docs/b.md', 'one two three four');

	h.show(a);
	assert.equal(h.component.wordCount(), 1);
	h.show(b);
	assert.equal(h.component.wordCount(), 4, 'the word count still describes the tab that was left');
});

// -------------------------------------------------------- view state on switch

test('a switch files the outgoing view state and restores the incoming one', () => {
	// The view state is the EDITOR's — cursor, scroll, folding — not the
	// model's, so it still has to be saved and restored by hand, and only after
	// the model it describes is attached.
	const h = setup();
	const a = h.open('/docs/a.md', 'A');
	const b = h.open('/docs/b.md', 'B');

	h.show(a);
	h.editor.markViewState('in-a');
	h.show(b);

	assert.deepEqual(
		tabManager.tabs.find((tab) => tab.id === a)!.editorViewState,
		{ marker: 'in-a' },
		'leaving a tab did not file its view state',
	);

	h.show(a);
	assert.deepEqual(
		h.editor.restored.at(-1),
		{ marker: 'in-a' },
		'coming back to a tab did not restore its view state',
	);
});

// ------------------------------------------------------------------- lifetime
//
// A leak is invisible until it is not, so these run the real `TabManager` over
// every route that can remove a tab and assert the invariant itself.

test('closing a tab disposes its model and nothing else', () => {
	const h = setup();
	const a = h.open('/docs/a.md', 'A');
	const b = h.open('/docs/b.md', 'B');
	h.show(a);
	h.show(b);

	tabManager.closeTab(a);

	assertNoModelOutlivesItsTab(2, 'closeTab');
	assert.ok(h.modelOf(b), "closing one tab disposed another tab's model");
});

test('closing every tab disposes every model', () => {
	const h = setup();
	const a = h.open('/docs/a.md', 'A');
	const b = h.open('/docs/b.md', 'B');
	h.show(a);
	h.show(b);

	tabManager.closeTab(b);
	tabManager.closeTab(a);

	assertNoModelOutlivesItsTab(2, 'closing every tab one at a time');
	assert.deepEqual(trackedTabModelIds(), []);
});

test('closeAll disposes every model', () => {
	// Reached by the window-close path, which never calls closeTab.
	const h = setup();
	const a = h.open('/docs/a.md', 'A');
	const b = h.open('/docs/b.md', 'B');
	h.show(a);
	h.show(b);

	tabManager.closeAll();

	assertNoModelOutlivesItsTab(2, 'closeAll');
});

test('a session restore that replaces the open tabs disposes their models', () => {
	// `restoreState` assigns `this.tabs` wholesale — the one tab removal in the
	// store that never goes through `closeTab`, and the one a per-call-site
	// dispose would have missed.
	const h = setup();
	const a = h.open('/docs/a.md', 'A');
	const b = h.open('/docs/b.md', 'B');
	h.show(a);
	h.show(b);

	tabManager.restoreState(
		JSON.stringify({ version: 2, activeTabId: 'restored-1', tabs: [{ id: 'restored-1', path: '/docs/c.md', title: 'c.md' }] }),
	);

	assert.deepEqual(tabManager.tabs.map((tab) => tab.path), ['/docs/c.md'], 'precondition: the restore replaced the tabs');
	assertNoModelOutlivesItsTab(2, 'restoreState');
});

test('a tab that loses its path to another tab has its model disposed with it', () => {
	// `claimPath`: Save As onto a file that is already open closes the clean
	// loser. It calls `closeTab`, but through the store rather than through any
	// UI, so nothing in the viewer would have known to dispose anything.
	const h = setup();
	const open = h.open('/docs/target.md', 'target');
	const untitled = (tabManager.addNewTab(), tabManager.activeTabId!);
	h.show(open);
	h.show(untitled);

	tabManager.updateTabPath(untitled, '/docs/target.md');

	assert.equal(tabManager.tabs.length, 1, 'precondition: the clean loser was closed');
	assertNoModelOutlivesItsTab(2, 'claimPath via Save As');
});

test('a tab moved to another window has its model disposed on the way out', () => {
	// Cross-window transfer, both halves in one window: the source closes its
	// tab, the destination inserts a new one. A model is a JavaScript object in
	// one webview, so it cannot travel — the arriving tab starts a fresh one,
	// with an empty undo history.
	const h = setup();
	const a = h.open('/docs/a.md', 'A');
	h.show(a);
	h.type('1');
	const sourceModel = h.modelOf(a);
	assert.ok(sourceModel, 'the tab about to move never had a model of its own');

	const snapshot = buildTransferredTab(
		{
			path: '/docs/a.md',
			title: 'a.md',
			rawContent: 'A1',
			originalContent: 'A',
			isDirty: true,
			isEditing: true,
			isSplit: false,
			splitRatio: 0.5,
			isScrollSynced: false,
			scrollTop: 0,
			scrollPercentage: 0,
			anchorLine: 0,
			hasReplacementChars: false,
			encoding: 'UTF-8',
			history: ['/docs/a.md'],
			historyIndex: 0,
		},
		[],
		'Untitled',
	);
	tabManager.closeTab(a);
	const arrived = tabManager.insertTransferredTab(snapshot);
	h.show(arrived);

	assert.ok(sourceModel!.isDisposed(), 'the source window kept the model of a tab it no longer has');
	assert.equal(h.modelOf(arrived)?.undoDepth(), 0, 'undo history cannot cross a window boundary and must not appear to');
	assertNoModelOutlivesItsTab(2, 'cross-window transfer');
});

test('reopening a closed document starts a new model with no undo history', () => {
	// The honest answer to "what happens to undo when a tab is closed and the
	// document reopened": nothing survives. Monaco cannot preserve an undo stack
	// across `dispose()`, and every editor that keys undo to a document behaves
	// the same way — VS Code included. Pretending otherwise would be a worse
	// bug than the one this change fixes, so it is written down as a test.
	const h = setup();
	const a = h.open('/docs/a.md', 'A');
	h.show(a);
	h.type('1');
	assert.equal(h.modelOf(a)?.undoDepth(), 1, 'precondition: the document has undo history of its own to lose');

	tabManager.closeTab(a);
	assert.equal(tabManager.popRecentlyClosed(), '/docs/a.md', 'precondition: the path is on the reopen stack');

	const reopened = h.open('/docs/a.md', 'A');
	h.show(reopened);

	assert.notEqual(reopened, a, 'a reopened document is a new tab');
	assert.equal(h.modelOf(reopened)?.undoDepth(), 0, 'a reopened document must not appear to carry undo history');
	assertNoModelOutlivesItsTab(2, 'close and reopen');
});

// -------------------------------------------------------------------- the URI

test('every tab gets its own model, and two tabs can never share one', () => {
	// Monaco keys models by URI and refuses a duplicate. Keying by tab id — a
	// UUID — is what makes that unreachable: untitled tabs have no path to key
	// by, and a path is not stable for the life of a tab anyway.
	const h = setup();
	const a = h.open('/docs/a.md', 'A');
	tabManager.addNewTab();
	const untitledOne = tabManager.activeTabId!;
	tabManager.addNewTab();
	const untitledTwo = tabManager.activeTabId!;

	h.show(a);
	h.show(untitledOne);
	h.show(untitledTwo);

	const uris = [a, untitledOne, untitledTwo].map((id) => h.modelOf(id)?.uri);
	assert.equal(new Set(uris).size, 3, 'two tabs resolved to the same model URI');
	assert.ok(uris.every((uri) => typeof uri === 'string'), 'a tab was shown without acquiring a model');
});
