import assert from 'node:assert/strict';
import { describe, test } from 'vitest';

// Importing the store boots the settings singleton, which asks for the OS type,
// so a backend answering it has to be in place before the imports below.
(window as any).__TAURI_INTERNALS__ = {
	metadata: { currentWindow: { label: 'main' }, currentWebview: { windowLabel: 'main', label: 'main' } },
	invoke: (cmd: string) => Promise.resolve(cmd === 'get_os_type' ? 'macos' : null),
};

const { tabManager } = await import('../src/lib/stores/tabs.svelte.js');
const { EditorDocument } = await import('../src/lib/utils/editorDocument.svelte.js');

/**
 * The editor's `EditorDocument` over the REAL `TabManager`. Monaco is a fake
 * with the few methods these paths read: the editor's text and its attached
 * model's language, line ending and text.
 */
function editorShowing(text: string, eol = '\n') {
	let onScreen = text;
	const model = { getLanguageId: () => 'markdown', getEOL: () => eol, getValue: () => onScreen };
	const editor = { getValue: () => onScreen, getModel: () => model };
	const doc = new EditorDocument({
		monaco: () => {
			throw new Error('no model is built on these paths');
		},
		editor: () => editor as any,
		tabs: tabManager,
		// The `value` prop is `value={tabManager.activeTab.rawContent}`: read, never copied.
		value: () => tabManager.activeTab?.rawContent ?? '',
		showWordCount: () => false,
	});

	return {
		doc,
		/** A keystroke: Monaco's buffer changes, then it fires the content listener. */
		type: (next: string) => {
			onScreen = next;
			doc.contentChanged();
		},
	};
}

function activeTab() {
	const tab = tabManager.activeTab;
	assert.ok(tab, 'precondition: a tab is active');
	return tab!;
}

/*
 * The editor writes through the store. `value` is a plain prop and nothing in
 * the editor writes it back, so the content listener is the only route from a
 * keystroke to the document, and `isDirty` is a getter on the tab, exactly
 * `rawContent !== originalContent`.
 */
describe('editor writes through the store', () => {
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
		// Undo, or retyping what was deleted, leaves a buffer that IS the saved
		// text — and the only thing that has to happen for the tab to say so is
		// that the two buffers agree.
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
});

describe('editor status readings', () => {
	test('the status bar renders the measured label and no longer a translation key', () => {
		// The line ending is the model's own EOL (`lineEndingLabel`, driven
		// against real Monaco buffers in editorLineEnding.test.ts), refreshed
		// with the other document-wide readings. It used to be a hardcoded CRLF.
		tabManager.closeAll();
		tabManager.addTab('/notes/crlf.md', 'a\r\nb');
		const crlf = editorShowing('a\r\nb', '\r\n');
		crlf.doc.syncStatus();
		assert.equal(crlf.doc.lineEnding, 'CRLF');

		const lf = editorShowing('a\nb', '\n');
		lf.doc.syncStatus();
		assert.equal(lf.doc.lineEnding, 'LF');
	});

	test('the status bar names the encoding the document was decoded from', () => {
		// Off the tab, not off Monaco: the encoding belongs to the file the buffer
		// was decoded from, and the store is what carries it through a save. The
		// slot used to render a literal `UTF-8` whatever the file was.
		tabManager.closeAll();
		tabManager.addTab('/notes/gbk.md', '中文');
		const { doc } = editorShowing('中文');
		tabManager.setTabEncoding(activeTab().id, 'GBK');
		assert.equal(doc.encoding, 'GBK');

		tabManager.addTab('/notes/plain.md', 'plain');
		assert.equal(doc.encoding, 'UTF-8', 'the reading follows the active tab');
	});
});
