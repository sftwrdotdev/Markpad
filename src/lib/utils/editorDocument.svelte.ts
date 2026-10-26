import type * as Monaco from 'monaco-editor';
import type { tabManager as TabManagerInstance } from '../stores/tabs.svelte.js';
import { editorReadingPosition } from './editorPosition.js';
import { getTabModel, lineEndingLabel, tabModelUri } from './tabModels.js';
import { countWords } from './wordCount.js';

type TextModel = Monaco.editor.ITextModel;

/** The slice of the Monaco namespace this needs: building a model and re-languaging one. */
export type DocumentMonaco = {
	editor: Pick<typeof Monaco.editor, 'createModel' | 'setModelLanguage'>;
	Uri: Pick<typeof Monaco.Uri, 'parse'>;
};

/** The editor as a view onto whichever model is attached. */
export type DocumentEditor = Pick<
	Monaco.editor.IStandaloneCodeEditor,
	| 'getModel'
	| 'setModel'
	| 'getValue'
	| 'setValue'
	| 'saveViewState'
	| 'restoreViewState'
	| 'setScrollTop'
	| 'setPosition'
	| 'getVisibleRanges'
	| 'getScrollTop'
	| 'getScrollHeight'
	| 'getLayoutInfo'
>;

type Tabs = Pick<
	typeof TabManagerInstance,
	| 'activeTabId'
	| 'activeTab'
	| 'updateTabEditorState'
	| 'updateTabRawContent'
	| 'updateTabScrollPercentage'
	| 'updateTabAnchorLine'
>;

/**
 * Which document the one Monaco editor shows, how a keystroke reaches the tab,
 * and the status-bar readings that describe the document.
 *
 * Moved out of `Editor.svelte` as it was. `monaco` and `editor` are getters
 * because the component builds both in `onMount`, after this object exists.
 */
export class EditorDocument {
	language = $state('markdown');
	lineEnding = $state<'LF' | 'CRLF'>('LF');
	wordCount = $state(0);
	/** The tab whose model the editor is holding. */
	currentTabId: string | null;
	/** The attached model's text as the content listener last read it; null after a model swap. */
	private emittedText: string | null = null;
	private wordCountTimer: ReturnType<typeof setTimeout> | undefined;

	constructor(
		private readonly deps: {
			monaco: () => DocumentMonaco;
			editor: () => DocumentEditor;
			tabs: Tabs;
			/** The `value` prop: the active tab's `rawContent`. */
			value: () => string;
			showWordCount: () => boolean;
		},
	) {
		this.currentTabId = deps.tabs.activeTabId;
	}

	/**
	 * The file's encoding, which a save writes back (#372). Read from the tab,
	 * not the Monaco model: it belongs to the file, not the buffer.
	 */
	get encoding() {
		return this.deps.tabs.activeTab?.encoding ?? 'UTF-8';
	}

	/**
	 * The `ITextModel` belonging to a tab — Monaco's document object, and the
	 * thing that owns the undo stack.
	 *
	 * One per tab, created here because the component holds the dynamically
	 * imported Monaco namespace, and reaped by `TabManager` because that is
	 * what knows a tab is gone; see `utils/tabModels.ts` for both halves.
	 *
	 * The language is re-applied on every call rather than only at creation.
	 * `language` is derived from the ACTIVE TAB'S PATH, and a tab can be
	 * repointed at a file of another type without being recreated — following a
	 * link, back/forward, Save As. The model outlives all of those, so a
	 * language fixed at creation would be the extension of whatever file the tab
	 * held the first time it was edited. `setModelLanguage` is a no-op when the
	 * id already matches.
	 */
	acquireTabModel(tabId: string, seed: string, languageId: string): TextModel {
		const monaco = this.deps.monaco();
		const model = getTabModel(tabId, () =>
			monaco.editor.createModel(seed, languageId, monaco.Uri.parse(tabModelUri(tabId))),
		);
		if (model.getLanguageId() !== languageId) monaco.editor.setModelLanguage(model, languageId);
		return model;
	}

	/**
	 * The status-bar readings that are properties of the DOCUMENT rather than of
	 * an edit: the language, the word count and the line ending.
	 *
	 * They used to be refreshed only by `onDidChangeModelContent`, which was
	 * enough while a tab switch went through `setValue` — that fires a content
	 * change (a flush) as a side effect. `setModel` does not, because no content
	 * changed: a different document arrived. So switching tabs has to ask for
	 * these explicitly, or the status bar keeps the previous document's numbers.
	 */
	syncStatus(deferWordCount = false) {
		const model = this.deps.editor().getModel();
		if (!model) return;
		this.language = model.getLanguageId();
		this.lineEnding = lineEndingLabel(model);
		// `countWords` is several full-text regex passes, ~400 ms on a 1 MB
		// document: skipped while the status bar hides it, and on a keystroke
		// left for a pause in typing.
		clearTimeout(this.wordCountTimer);
		if (!this.deps.showWordCount()) return;
		const count = () => (this.wordCount = countWords(model.getValue()));
		if (deferWordCount) this.wordCountTimer = setTimeout(count, 300);
		else count();
	}

	/** Drops a word count still waiting for a pause in typing. */
	cancelPendingWordCount() {
		clearTimeout(this.wordCountTimer);
	}

	/**
	 * The one route from a keystroke to the document. `value` is a plain
	 * prop — it reads the active tab's `rawContent` and nothing here writes
	 * it back — so this call is not a second opinion about the buffer, it is
	 * the only opinion. It used to be a `bind:value` writing the field
	 * directly PLUS this call, and the tab only stayed dirty-tracked because
	 * Svelte's assignment happened to run first: deleting this line left the
	 * text on screen correct and the dirty flag, the auto-save trigger and
	 * the close prompt silently dead. Delete it now and the editor stops
	 * editing the document at all, which is a bug you can see.
	 *
	 * The guard is what stops the loop: `activate` pushes an external
	 * buffer replacement in with `setValue`, which fires this listener with
	 * text `value` already holds, and writing that back to the store would
	 * be a write the user did not make.
	 */
	contentChanged() {
		const newValue = this.deps.editor().getValue();
		this.emittedText = newValue;
		const activeTabId = this.deps.tabs.activeTabId;
		if (this.deps.value() !== newValue && activeTabId) {
			this.deps.tabs.updateTabRawContent(activeTabId, newValue);
		}

		this.syncStatus(true);
	}

	/**
	 * Tab activation, run by the component's effect on every change of the
	 * active tab, its buffer or its language. A switch swaps the editor's MODEL;
	 * see the comment on that effect in `Editor.svelte` for why `setValue` is
	 * still here.
	 */
	activate(activeTabId: string | null, content: string, languageId: string) {
		const editor = this.deps.editor();
		const tabs = this.deps.tabs;
		const switched = activeTabId !== this.currentTabId;

		if (switched && this.currentTabId) {
			const state = editor.saveViewState();
			tabs.updateTabEditorState(this.currentTabId, state);
		}

		this.currentTabId = activeTabId;

		if (activeTabId) {
			const model = this.acquireTabModel(activeTabId, content, languageId);
			if (editor.getModel() !== model) {
				editor.setModel(model);
				this.emittedText = null;
			}
		}

		// The keystroke that changed `value` came from this editor, and the
		// model already holds it: no need to copy the buffer out to compare.
		if (content !== this.emittedText && editor.getValue() !== content) {
			editor.setValue(content);
		}

		if (switched) {
			// The view state is the editor's, not the model's — cursor, scroll,
			// selections and the folding contribution — so it still has to be
			// restored by hand, and only after the model it describes is
			// attached.
			if (tabs.activeTab?.editorViewState) {
				editor.restoreViewState(tabs.activeTab.editorViewState);
			} else {
				editor.setScrollTop(0);
				editor.setPosition({ lineNumber: 1, column: 1 });
			}
		}

		// Cheap on the hot path: this re-runs on every keystroke (it is handed
		// `value`), and on a keystroke neither test holds.
		if (switched || this.language !== languageId) this.syncStatus();
	}

	/**
	 * Record on `tabId` where the editor is: the Monaco view state, and the two
	 * position fields `editorReadingPosition` derives from one reading.
	 *
	 * Three layout reads (`getScrollHeight`, `getLayoutInfo`,
	 * `getVisibleRanges`), so this belongs at moments and never on the hot path
	 * — the component's teardown is one such moment, `flushPositionTo` below is
	 * the other, and there are no others.
	 *
	 * The caller has already established that `editor` is up and that `tabId` is
	 * the tab it is holding.
	 */
	writePosition(tabId: string) {
		const editor = this.deps.editor();
		const tabs = this.deps.tabs;
		tabs.updateTabEditorState(tabId, editor.saveViewState());

		const ranges = editor.getVisibleRanges();
		const model = editor.getModel();
		const { scrollPercentage, anchorLine } = editorReadingPosition({
			scrollTop: editor.getScrollTop(),
			contentHeight: editor.getScrollHeight(),
			viewportHeight: editor.getLayoutInfo().height,
			topLine: ranges.length > 0 && model ? ranges[0].startLineNumber : null,
			text: model?.getValue() ?? '',
		});

		if (scrollPercentage !== null) tabs.updateTabScrollPercentage(tabId, scrollPercentage);
		if (anchorLine !== null) tabs.updateTabAnchorLine(tabId, anchorLine);
	}

	/**
	 * `writePosition`, for an editor that is up, and only when it is holding
	 * `tabId`. There is one Editor per window and it swaps models between tabs
	 * (`utils/tabModels.ts`), so an unguarded flush would copy the ACTIVE tab's
	 * position onto whichever record the caller named — a wrong position on two
	 * tabs instead of one.
	 */
	flushPositionTo(tabId: string) {
		if (this.currentTabId !== tabId) return;
		this.writePosition(tabId);
	}
}
