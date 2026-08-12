import assert from 'node:assert/strict';

import { test } from 'vitest';

import ts from 'typescript';

import { callbackBodies, readSource } from './sourceTree.js';

/*
 * A keystroke reaches the document by ONE route, and the dirty flag is not a
 * flag.
 *
 * THE DEFECT. Typing used to write the buffer twice. `MarkdownViewer` passed
 * the editor `bind:value={tabManager.activeTab.rawContent}`, so Svelte's
 * assignment put the new text on the tab; the same listener then called
 * `tabManager.updateTabRawContent`, which put it there again and recomputed
 * `isDirty` from it. Both writes carried the same text, so the app worked — and
 * it worked *because* Svelte's assignment happened to run first. Delete the
 * store call and the editor still edited, the preview still re-rendered, and
 * nothing maintained `isDirty`: no dirty dot, no auto-save, no unsaved-changes
 * prompt on close, and no type error anywhere to say so.
 *
 * WHAT IT IS NOW. `value` is a plain prop — a getter over the parent's
 * `tabManager.activeTab.rawContent` — and the listener's call to the store is
 * the only write. Remove it and the editor stops editing the document, which is
 * a failure you can see; these tests are the ones that see it first.
 *
 * `isDirty` went the same way: a getter on the tab, exactly
 * `rawContent !== originalContent`, so nothing can hold an opinion about
 * "changed?" that its two buffers do not support.
 *
 * WHAT RUNS HERE. The component's own `onDidChangeModelContent` listener,
 * lifted out of Editor.svelte and evaluated against the REAL `TabManager`. Only
 * Monaco is a fake, and only the two methods the listener touches.
 */

// ---------------------------------------------------------------- environment
// Svelte runes and the Tauri bridge, faked as the other lifting tests do, so
// `tabs.svelte.ts` imports under plain node.

// The runes are the compiler's, not ours: vitest builds `.svelte.ts` through the
// Svelte plugin, so the store and the session run under real reactivity, and jsdom
// supplies `window` and `localStorage`. Only the Tauri backend is stubbed.
(window as any).__TAURI_INTERNALS__ = {
	metadata: { currentWindow: { label: 'main' }, currentWebview: { windowLabel: 'main', label: 'main' } },
	invoke: (cmd: string) => Promise.resolve(cmd === 'get_os_type' ? 'macos' : null),
};

const { tabManager } = await import('../src/lib/stores/tabs.svelte.js');

// ------------------------------------------------- the component, as written

const EDITOR = 'src/lib/components/Editor.svelte';
const source = readSource(EDITOR);

const contentChangeBody = (() => {
	const bodies = callbackBodies(source, 'editor.onDidChangeModelContent');
	assert.equal(bodies.length, 1, `expected exactly one model-content listener in ${EDITOR}, found ${bodies.length}`);
	return bodies[0];
})();

/**
 * The lifted body is TypeScript and `new Function` only parses JavaScript, so
 * it goes through `tsc` first, as undoHistoryPerTab.test.ts and
 * imageUndoKeepsFile.test.ts already do. Types are erased, nothing else: the
 * statements that run are the component's.
 */
const factorySource = ts.transpileModule(
	`const __component = (tabManager, editor) => {
		// The status bar readings. Stubbed rather than lifted because they are
		// the listener's other errand and have their own tests; what is under
		// test here is where the text goes.
		const syncStatusFromModel = () => {};
		return { contentChanged: () => ${contentChangeBody} };
	};`,
	{ compilerOptions: { target: ts.ScriptTarget.ES2022 } },
).outputText;

/**
 * The `value` prop, modelled as what Svelte compiles a dynamic prop to: a
 * getter over the parent's expression, `value={tabManager.activeTab.rawContent}`.
 * Modelling it as a local copy would be re-introducing the second buffer this
 * whole change removed.
 *
 * A null-prototype object so `with` captures this one name and not
 * `toString`, `constructor` and the rest of Object.prototype.
 */
const propsScope = Object.defineProperty(Object.create(null), 'value', {
	get: () => tabManager.activeTab?.rawContent ?? '',
});

function editorShowing(text: string) {
	let onScreen = text;
	const editor = { getValue: () => onScreen };
	const factory = new Function(
		'__props',
		`with (__props) { ${factorySource}\nreturn __component; }`,
	)(propsScope) as (tabManager: unknown, editor: unknown) => { contentChanged: () => void };
	const component = factory(tabManager, editor);

	return {
		/** A keystroke: Monaco's buffer changes, then it fires the listener. */
		type: (next: string) => {
			onScreen = next;
			component.contentChanged();
		},
	};
}

function activeTab() {
	const tab = tabManager.activeTab;
	assert.ok(tab, 'precondition: a tab is active');
	return tab!;
}

// ------------------------------------------------------------------ the tests

test('a keystroke reaches the document, and the document knows it is unsaved', () => {
	tabManager.closeAll();
	tabManager.addTab('/notes/a.md', 'saved text');
	const editor = editorShowing('saved text');

	assert.equal(activeTab().isDirty, false, 'precondition: a freshly opened tab is clean');

	editor.type('saved text and more');

	assert.equal(
		activeTab().rawContent,
		'saved text and more',
		'the keystroke never reached the document: the editor is writing to something else, or to nothing',
	);
	assert.equal(
		activeTab().isDirty,
		true,
		'the document has unsaved edits and does not say so — no dirty dot, no auto-save, no prompt on close',
	);
});

test('typing the saved text back makes the tab clean again, with nobody clearing a flag', () => {
	// The point of deriving it. Undo, or retyping what was deleted, leaves a
	// buffer that IS the saved text — and the only thing that has to happen for
	// the tab to say so is that the two buffers agree.
	tabManager.closeAll();
	tabManager.addTab('/notes/b.md', 'saved text');
	const editor = editorShowing('saved text');

	editor.type('saved text!');
	assert.equal(activeTab().isDirty, true);

	editor.type('saved text');
	assert.equal(activeTab().isDirty, false, 'the buffer is the saved text and the tab still reads dirty');
});

test('following a link does not leave the tab dirty against the file it just left', () => {
	// `navigate` repoints the tab at another file before the load lands, so for
	// that window `path` is the new file and `rawContent` is the old document.
	// A tab left dirty there arms the auto-save effect, which writes the
	// document the reader left into the file they opened.
	tabManager.closeAll();
	tabManager.addTab('/notes/c.md', 'saved text');
	const editor = editorShowing('saved text');
	editor.type('unsaved edits');

	tabManager.navigate(activeTab().id, '/notes/linked.md');

	assert.equal(activeTab().path, '/notes/linked.md');
	assert.equal(activeTab().isDirty, false, 'the tab claims unsaved edits to a document it no longer holds');
});
