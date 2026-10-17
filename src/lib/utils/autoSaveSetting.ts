/**
 * Whether edits are written without being asked for.
 *
 * This used to be two checkboxes — "Auto-save edits" and "Ask for confirmation
 * before saving" — and every decision in the app read them as one expression:
 *
 *     settings.autoSave && !settings.confirmBeforeSave
 *
 * (`MarkdownViewer`'s debounce, its flush when leaving an editable pane, its
 * close-the-window walk, and `documentSession.canCloseTab`. There was no fifth
 * reading, and no site read `confirmBeforeSave` on its own.)
 *
 * So the four combinations were two behaviours, and one of them contradicted
 * its own label: with both switches on, "Auto-save edits" was on and nothing
 * was auto-saved. The second switch also never touched Cmd+S, which is the one
 * thing "before saving" would lead a reader to expect — what it really governed
 * was whether the unsaved-changes dialog still appears on close.
 *
 * One switch now, with the two states the code always had: on, edits are saved
 * silently; off, they are not written to the file until you save. Closing the
 * window then keeps them as a backup that comes back on the next launch while
 * "Keep unsaved changes on close" is on (the default), and asks when it is off.
 */
export const DEFAULT_AUTO_SAVE = true;

/**
 * The stored preference, and what to do about the pair it replaced.
 *
 * `editor.autoSaveEdits` is the new key. An install that predates it is asked
 * the old question instead, through the same expression the app used to
 * evaluate — which is what makes the upgrade invisible: every one of the four
 * old combinations maps to the behaviour it already produced.
 *
 * Both old keys are left where they are rather than migrated away. They cost
 * nothing, they are never written again, and a user who rolls back finds the
 * settings they had. Reading them is conditional on the new key being absent,
 * so a reader who upgrades and then turns auto-save back on does not have the
 * stale `confirmBeforeSave` veto it again on the next launch.
 */
export function resolveAutoSave(
	stored: string | null,
	legacyAutoSave: string | null,
	legacyConfirmBeforeSave: string | null,
): boolean {
	if (stored !== null) return stored === 'true';

	const autoSave = legacyAutoSave === null ? DEFAULT_AUTO_SAVE : legacyAutoSave === 'true';
	return autoSave && legacyConfirmBeforeSave !== 'true';
}
