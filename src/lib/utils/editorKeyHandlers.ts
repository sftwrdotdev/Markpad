import type * as Monaco from 'monaco-editor';

import { isInFencedCode } from './codeFence.js';
import { blockEnter, parseListItem, shiftListItem, type ListEdit } from './listEditing.js';
import { tableOperation, tableStep, type TableEdit, type TableOperation } from './tableEditing.js';

/** The part of a Monaco editor the editing keys touch. */
export type KeyHandlerEditor = Pick<
	Monaco.editor.ICodeEditor,
	'getModel' | 'getSelections' | 'pushUndoStop' | 'executeEdits' | 'setSelection' | 'trigger'
>;

/**
 * Enter, Tab, Shift+Tab, Mod+Enter and Mod+Shift+Enter inside a list item, a
 * block quote or a table (#604), over `editor`. `monaco` supplies the `Range`
 * and `Selection` constructors, which live on the lazily imported module.
 */
export function editorKeyHandlers(editor: KeyHandlerEditor, monaco: Pick<typeof Monaco, 'Range' | 'Selection'>) {
	/**
	 * Enter on a list item writes the next item's marker; Enter on a block quote
	 * writes the quote (#700); Enter on either with a marker and no text takes
	 * the marker away instead, which is how the block ends — except on a nested
	 * list item, where it takes one level away (#856). What the next line
	 * should say is decided by `blockEnter` in utils/listEditing.ts, where it can
	 * be tested without a browser.
	 *
	 * Only a single collapsed caret is claimed. A selection, or several carets,
	 * gets the ordinary Enter: replacing a multi-cursor edit with one edit at
	 * the primary selection would silently drop the others' work.
	 */
	const continueListOnEnter = () => {
		// The key's ordinary meaning, re-sent. `type` with a newline is what the
		// keyboard itself delivers, so auto-indent and the model's own EOL still
		// apply — this handler is a detour, never a replacement.
		const plainEnter = () => editor.trigger("keyboard", "type", { text: "\n" });
		const caret = soleCaret();
		if (!caret) return plainEnter();

		const { model, line, column } = caret;
		const next = blockEnter(model.getLineContent(line), column);
		if (!next) return plainEnter();

		// An empty item below the margin gives up one level, as Shift+Tab would
		// (#856); only an item with no level left ends the list.
		if (next.kind === "clear") {
			const level = shiftListItem(model, line, column, true);
			if (level) return applyLineEdit(level, "list-outdent");
		}

		// Its own undo step, so one Ctrl+Z gives back the marker this took away
		// rather than unwinding the sentence typed before it.
		editor.pushUndoStop();

		if (next.kind === "clear") {
			editor.executeEdits(
				"list-continuation",
				[{ range: new monaco.Range(line, 1, line, model.getLineMaxColumn(line)), text: next.line }],
				[new monaco.Selection(line, next.line.length + 1, line, next.line.length + 1)],
			);
			return;
		}

		const after = next.text.length + 1;
		editor.executeEdits(
			"list-continuation",
			[{ range: new monaco.Range(line, column, line, column), text: `${model.getEOL()}${next.text}` }],
			[new monaco.Selection(line + 1, after, line + 1, after)],
		);
	};

	/**
	 * The single collapsed caret these keys claim, or null.
	 *
	 * A selection, or several carets, is handed back to the key's ordinary
	 * meaning everywhere below: one edit at the primary selection would silently
	 * drop what the other carets were about to do, and Monaco's own Tab already
	 * indents every line of a multi-line selection.
	 *
	 * So is a caret inside a fenced code block. `1. a` or `|a|b|` there is code,
	 * and renumbering or re-aligning it rewrites the code; Enter, Tab and the
	 * table keys all ask here, so none of them can forget.
	 */
	const soleCaret = () => {
		const model = editor.getModel();
		const selections = editor.getSelections();
		if (!model || selections?.length !== 1 || !selections[0].isEmpty()) return null;
		const line = selections[0].startLineNumber;
		if (isInFencedCode(model, line)) return null;
		return { model, line, column: selections[0].startColumn };
	};

	/**
	 * Replace a run of lines with what a Markdown edit says they should be, and
	 * put the caret where it says. Every table operation ends here, because every
	 * one of them changes a column's width and therefore has to redraw the pipes;
	 * so does every list level change (#711), which renumbers the items the moved
	 * one left behind and is therefore a run of lines rather than one line.
	 *
	 * An edit that changes nothing but the caret — Shift+Tab in the first cell of
	 * an already-aligned table — moves the caret WITHOUT an edit, so it does not
	 * push an undo step that undoes nothing.
	 */
	const applyLineEdit = (edit: TableEdit | ListEdit, source: string) => {
		const model = editor.getModel();
		if (!model) return;

		const range = new monaco.Range(
			edit.startLine,
			1,
			edit.endLine,
			model.getLineMaxColumn(edit.endLine),
		);
		const text = edit.lines.join(model.getEOL());
		const caret = new monaco.Selection(
			edit.caretLine,
			edit.caretColumn,
			edit.caretLine,
			edit.caretColumn,
		);

		if (model.getValueInRange(range) === text) {
			editor.setSelection(caret);
			return;
		}
		editor.pushUndoStop();
		editor.executeEdits(source, [{ range, text }], [caret]);
	};

	/** Tab / Shift+Tab inside a table. False when the caret is not in one. */
	const stepTableCell = (back: boolean) => {
		const caret = soleCaret();
		if (!caret) return false;
		const step = tableStep(caret.model, caret.line, caret.column, back);
		if (!step) return false;
		applyLineEdit(step, "table-step");
		return true;
	};

	/**
	 * The row and column commands, which are the same edit one level up. False
	 * when the caret is not in a table, or when the table refuses the edit — which
	 * is what lets the two Enter keys hand themselves back to Monaco.
	 */
	const editTable = (operation: TableOperation) => {
		const caret = soleCaret();
		if (!caret) return false;
		const edit = tableOperation(caret.model, caret.line, caret.column, operation);
		if (!edit) return false;
		applyLineEdit(edit, `table-${operation}`);
		return true;
	};

	/**
	 * Tab / Shift+Tab on a list item: the level, decided by `shiftListItem` in
	 * utils/listEditing.ts, where it can be tested without a browser.
	 *
	 * A LIST ITEM'S TAB NEVER FALLS THROUGH, not even when the edit is refused.
	 * On a list item this key means the level and only the level, and the two
	 * refusals are both "there is no other level": Tab on the first item of a
	 * list, which has nothing to nest under, and Shift+Tab on an item already at
	 * the margin. Handing those to `indentLines` or `outdent` would move the line
	 * by `tabSize` into a column that nests under nothing — which is half of
	 * #711 — so the key does nothing instead, as it does in every outliner.
	 */
	const shiftListLevel = (back: boolean) => {
		const caret = soleCaret();
		if (!caret || !parseListItem(caret.model.getLineContent(caret.line))) return false;
		const edit = shiftListItem(caret.model, caret.line, caret.column, back);
		if (edit) applyLineEdit(edit, back ? "list-outdent" : "list-indent");
		return true;
	};

	/** Tab: the next cell of a table, else a list item's nesting level, else a Tab. */
	const handleTabKey = () => {
		if (stepTableCell(false)) return;
		if (shiftListLevel(false)) return;
		editor.trigger("keyboard", "tab", null);
	};

	/**
	 * Shift+Tab: the previous cell of a table, else a list item's level, else
	 * Monaco's own `outdent`.
	 *
	 * IT USED TO BE A PURE FALL-THROUGH, and the reason it no longer is, is #711.
	 * `outdent` takes `tabSize` columns off the line wherever the caret sits on
	 * it, which was close enough to right while nothing renumbered — but a level
	 * is not a `tabSize`, and an item that leaves a sub-list has to take the
	 * number of the list it rejoins. Both are `shiftListItem`'s, in the same
	 * function as Tab's, because they are the same edit with the sign flipped.
	 *
	 * `outdent` remains what the chord means on every line that is not a list
	 * item, which is what the third line preserves.
	 */
	const handleShiftTabKey = () => {
		if (stepTableCell(true)) return;
		if (shiftListLevel(true)) return;
		editor.trigger("keyboard", "outdent", null);
	};

	/**
	 * Mod+Enter: a row below in a table, else Monaco's own "Insert Line Below".
	 *
	 * THE KEY IS NOT BEING TAKEN, IT IS BEING SPECIALISED. Monaco already binds
	 * `Mod+Enter` to `editor.action.insertLineAfter` and `Mod+Shift+Enter` to
	 * `insertLineBefore`, and inside a table "the line below" IS "the row below" —
	 * so these two handlers are the same shape as Shift+Tab's above: take the key,
	 * and hand it straight back everywhere the table branch declines.
	 *
	 * The rows used to be on `Mod+K R`, and a two-key chord for the commonest edit
	 * a table gets is a chord nobody presses. Columns keep theirs: they are rarer,
	 * and no unmodified key means "insert a column" in any editor.
	 */
	const handleModEnterKey = () => {
		if (editTable("insert-row")) return;
		editor.trigger("keyboard", "editor.action.insertLineAfter", null);
	};

	/** Mod+Shift+Enter: a row above in a table, else "Insert Line Above". */
	const handleModShiftEnterKey = () => {
		if (editTable("insert-row-above")) return;
		editor.trigger("keyboard", "editor.action.insertLineBefore", null);
	};

	return {
		continueListOnEnter,
		editTable,
		handleTabKey,
		handleShiftTabKey,
		handleModEnterKey,
		handleModShiftEnterKey,
	};
}
