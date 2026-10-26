import type { TranslationKey } from './i18n.js';
/**
 * What an already-open document opens AS — the preference behind #183.
 *
 * One choice rather than two switches. `isEditing` and `isSplit` are
 * independent flags on the tab, so a preference expressed as two booleans can
 * say "editor AND split", which is not a state the reader can be in: split view
 * wins the layout (`MarkdownViewer`'s pane flex reads `isSplit` first) and the
 * editor flag would only decide where closing the split lands. The question the
 * reader is actually answering has three answers, so it is stored as three.
 *
 * This does NOT cover a new empty document — `Ctrl+N` has its own preference
 * (`newFileDefaultMode`), because "what should an empty buffer open as" and
 * "what should a file I picked open as" are not the same question.
 */
export type OpenFileMode = 'preview' | 'editor' | 'split';

export const DEFAULT_OPEN_FILE_MODE: OpenFileMode = 'preview';

/** The Settings select, in order: the one control, with its three answers. */
export const OPEN_FILE_MODE_OPTIONS: readonly { value: OpenFileMode; labelKey: TranslationKey }[] = [
	{ value: 'preview', labelKey: 'settings.preview' },
	{ value: 'editor', labelKey: 'settings.editor' },
	{ value: 'split', labelKey: 'menu.splitView' },
];

export function isOpenFileMode(value: unknown): value is OpenFileMode {
	return value === 'preview' || value === 'editor' || value === 'split';
}

/**
 * The stored preference, and what to do about the boolean it replaced.
 *
 * Until split view became a third answer this was `editor.startInEditor`, a
 * checkbox. An upgrade must not change what anybody's app does, so a machine
 * with no `editor.openFileMode` yet is asked the old question instead — `true`
 * meant "editor", and its `false`/absent meant "preview", which is the default
 * here. The old key is left where it is rather than migrated away: it costs
 * nothing, and a user who rolls back to the previous version finds their
 * setting still there.
 *
 * Read once. The first write of the new key ends the fallback, so a reader who
 * later picks "preview" does not get "editor" back on the next launch.
 */
export function resolveOpenFileMode(stored: string | null, legacyStartInEditor: string | null): OpenFileMode {
	if (stored !== null) return isOpenFileMode(stored) ? stored : DEFAULT_OPEN_FILE_MODE;

	return legacyStartInEditor === 'true' ? 'editor' : DEFAULT_OPEN_FILE_MODE;
}
