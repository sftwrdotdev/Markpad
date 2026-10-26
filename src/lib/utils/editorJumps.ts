import type * as Monaco from 'monaco-editor';
import type { BufferLine } from './lineCoordinates.js';
import type { ScrollSyncPosition } from './scrollSync.js';

/**
 * Where a revealed range lands in the viewport. The outline asks for `top`:
 * the preview answers the same click by putting the heading just under its
 * top edge, and with scroll sync off the two panes then show the same
 * place. The context menu's Edit keeps `center`, the reading it had.
 */
export type RevealPlacement = 'center' | 'top';

export type JumpEditor = Pick<
	Monaco.editor.IStandaloneCodeEditor,
	'getModel' | 'revealLineNearTop' | 'revealLineInCenterIfOutsideViewport' | 'setSelection' | 'focus'
>;

type Deps = {
	monaco: () => { editor: { ScrollType: typeof Monaco.editor.ScrollType } };
	editor: () => JumpEditor | undefined;
	/** The component's `editorReady`. */
	ready: () => boolean;
	/** The scroll itself, run once the editor is ready. */
	scrollTo: (position: ScrollSyncPosition, options: { cursorIntoView: boolean }) => void;
};

/**
 * The editor's jumps from outside: the preview's sync (Ctrl+E, split view),
 * the outline, and the context menu's Edit. Any of them can arrive while
 * Monaco is still loading, and is then queued until `spendPending`.
 */
export class EditorJumps {
	/** A sync asked for before Monaco loaded, spent right after the view-state restore. */
	private pendingSync: ScrollSyncPosition | null = null;
	private pendingCursorIntoView = false;
	/**
	 * A reveal asked for before Monaco loaded. The preview can call in several
	 * frames before `editor` exists; `createEditor` spends it once it does.
	 */
	private pendingReveal: { startLine: number; endLine: number; placement: RevealPlacement } | null = null;

	constructor(private deps: Deps) {}

	syncScrollToPosition(position: ScrollSyncPosition, { cursorIntoView = false } = {}) {
		if (!this.deps.ready() || !this.deps.editor()) {
			this.pendingSync = position;
			this.pendingCursorIntoView = cursorIntoView;
			return;
		}
		this.deps.scrollTo(position, { cursorIntoView });
	}

	/** Called by `createEditor` after the view-state / anchor-line restore. */
	spendPending() {
		// After the view-state / anchor-line restore, deliberately: an
		// explicit "edit this fragment" beats the position the tab was left at.
		if (this.pendingSync) {
			const position = this.pendingSync;
			this.pendingSync = null;
			this.syncScrollToPosition(position, { cursorIntoView: this.pendingCursorIntoView });
		}
		if (this.pendingReveal) {
			const { startLine, endLine, placement } = this.pendingReveal;
			this.pendingReveal = null;
			this.revealSourceRange(startLine, endLine, placement);
		}
	}

	/**
	 * Put the reader on `startLine`..`endLine` of the buffer.
	 *
	 * The one line-to-editor jump in this component. The outline reaches it
	 * through `revealHeader`, and the preview's context-menu "Edit" calls it
	 * with the source range of whatever the reader had selected (#90).
	 *
	 * The selection IS the highlight #90 asks for: Monaco draws it in the
	 * theme's own selection colour, so it needs no decoration, no CSS and no
	 * timer — and it clears itself on the reader's next click or keystroke,
	 * which is precisely when it has stopped being useful. A decoration that
	 * fades on a timer would be a second highlighting mechanism doing what this
	 * one already does, and would leave the caret at the top of the file.
	 */
	revealSourceRange(startLine: number, endLine: number, placement: RevealPlacement = 'center') {
		const editor = this.deps.editor();
		if (!this.deps.ready() || !editor) {
			this.pendingReveal = { startLine, endLine, placement };
			return;
		}
		const monaco = this.deps.monaco();

		const model = editor.getModel();
		if (!model) return;

		// Clamp before `getLineMaxColumn`, which throws on a line past the end
		// of the buffer. Both callers can hand one over: the preview's HTML is
		// the render of a buffer that may since have been replaced by a shorter
		// one (an external change, a session restored around a file edited
		// elsewhere), and the outline carries the same lines.
		const lastLine = model.getLineCount();
		const start = Math.min(Math.max(1, Math.trunc(startLine)), lastLine);
		const end = Math.min(Math.max(start, Math.trunc(endLine)), lastLine);

		if (placement === 'top') editor.revealLineNearTop(start, monaco.editor.ScrollType.Smooth);
		else editor.revealLineInCenterIfOutsideViewport(start, monaco.editor.ScrollType.Smooth);
		editor.setSelection({
			startLineNumber: start,
			startColumn: 1,
			endLineNumber: end,
			endColumn: model.getLineMaxColumn(end),
		});
		editor.focus();
	}

	/**
	 * `sourceLine` is a BUFFER line, and the type is the whole point: the
	 * outline reads `data-sourcepos`, which counts from the first line of the
	 * body, and handed it over unshifted for as long as both features existed.
	 * The caller now has to go through `lineCoordinates` to produce one.
	 */
	revealHeader(sourceLine: BufferLine | null, text: string) {
		const editor = this.deps.editor();
		if (!editor) return;
		const monaco = this.deps.monaco();
		const model = editor.getModel();
		if (!model) return;
		const lineNumber = sourceLine ?? 0;
		if (Number.isInteger(lineNumber) && lineNumber > 0) {
			this.revealSourceRange(lineNumber, lineNumber, 'top');
			return;
		}

		const escapedText = text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
		const regex = new RegExp(`^#+\\s+.*${escapedText}.*$`, "m");

		const match = model.findNextMatch(regex.source, { lineNumber: 1, column: 1 }, true, false, null, true);

		if (match) {
			editor.revealLineNearTop(match.range.startLineNumber, monaco.editor.ScrollType.Smooth);
			editor.setSelection(match.range);
			editor.focus();
		} else {
			const fallbackMatch = model.findNextMatch(escapedText, { lineNumber: 1, column: 1 }, false, false, null, false);
			if (fallbackMatch) {
				editor.revealLineNearTop(fallbackMatch.range.startLineNumber, monaco.editor.ScrollType.Smooth);
				editor.setSelection(fallbackMatch.range);
				editor.focus();
			}
		}
	}
}

/** Split view's editor-to-preview sync listens to scrolling, not to the caret: typing must not initiate a sync. */
export function bindScrollSync(
	editor: Pick<Monaco.editor.IStandaloneCodeEditor, 'onDidScrollChange'>,
	emit: () => void,
): Monaco.IDisposable {
	return editor.onDidScrollChange((e) => {
		if (e.scrollTopChanged) {
			emit();
		}
	});
}
