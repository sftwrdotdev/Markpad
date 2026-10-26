import {
	CODE_FONT_SIZE_RANGE,
	EDITOR_FONT_SIZE_RANGE,
	EDITOR_MAX_WIDTH_RANGE,
	PREVIEW_FONT_SIZE_RANGE,
	TAB_POSITION_OPTIONS,
	clampToRange,
	isWithinRange,
	parseStoredNumber,
	type NumericSettingRange,
	type SettingsStore,
} from '../stores/settings.svelte.js';
import { OPEN_FILE_MODE_OPTIONS } from './openFileMode.js';
import {
	DEFAULT_PREVIEW_MAX_WIDTH,
	MAX_PREVIEW_MAX_WIDTH,
	MIN_PREVIEW_MAX_WIDTH,
} from './previewWidth.js';

/**
 * The rows of the Settings panes, in the order the panes show them.
 *
 * Settings.svelte renders each pane by walking its `rows`: one markup per row
 * kind, plus a `custom` branch for the rows whose control is one of a kind
 * (the theme picker, the highlight swatches, …). The row's `id` is its
 * control's DOM id and the `for` of its label.
 */
type BooleanKey = { [K in keyof SettingsStore]: SettingsStore[K] extends boolean ? K : never }[keyof SettingsStore];
type NumberKey = 'editorFontSize' | 'editorMaxWidth' | 'previewFontSize' | 'codeFontSize';
type FontKey = 'editorFont' | 'previewFont' | 'codeFont';
type SelectKey = 'wordWrap' | 'tabPosition' | 'folderSide' | 'sidebarStackOrder' | 'tocFollows' | 'openFileMode';

type RowBase = {
	id: string;
	labelKey: string;
	/** Second line under the label. */
	hintKey?: string;
	/** The label's tooltip. */
	titleKey?: string;
	/** The label's tooltip while the row is inactive. */
	inactiveTitleKey?: string;
	/** Dims the row and disables its control: the setting does nothing in this state. */
	inactive?: (s: SettingsStore) => boolean;
};

export type SelectOption = { value: string; labelKey: string };

export type FontRow = RowBase & { kind: 'font'; key: FontKey };
export type NumberRow = RowBase & { kind: 'number'; key: NumberKey; range: NumericSettingRange; unit: string };
export type PreviewWidthRow = RowBase & { kind: 'previewWidth'; key: 'previewMaxWidth'; range: NumericSettingRange };
export type SelectRow = RowBase & { kind: 'select'; key: SelectKey; options: readonly SelectOption[] };
/** A switch bound to `key`, or one read through `checked` and flipped through `toggle`. */
export type ToggleRow = RowBase & {
	kind: 'toggle';
	key?: BooleanKey;
	checked?: (s: SettingsStore) => boolean;
	toggle?: (s: SettingsStore) => void;
};
export type CustomRow = RowBase & { kind: 'custom' };

export type SettingsRow = FontRow | NumberRow | PreviewWidthRow | SelectRow | ToggleRow | CustomRow;

export type SettingsPane = {
	rows: readonly SettingsRow[];
	/** The pane's "Reset … settings" button. */
	reset?: (s: SettingsStore) => void;
};

// With the tabs in a side column, the folder stacks into that column and this choice does not apply.
export function folderSideFollowsTabs(s: SettingsStore): boolean {
	return s.tabPlacement === 'left' || s.tabPlacement === 'right';
}

export const SETTINGS_PANES: Record<'editor' | 'preview' | 'appearance' | 'files', SettingsPane> = {
	editor: {
		reset: (s) => {
			s.resetEditorFont();
			s.resetEditorMaxWidth();
		},
		rows: [
			{ kind: 'font', id: 'editor-font', labelKey: 'settings.font', key: 'editorFont' },
			{ kind: 'number', id: 'editor-font-size', labelKey: 'settings.fontSize', key: 'editorFontSize', range: EDITOR_FONT_SIZE_RANGE, unit: 'px' },
			{
				kind: 'select',
				id: 'editor-word-wrap',
				labelKey: 'settings.wordWrap',
				key: 'wordWrap',
				options: [
					{ value: 'off', labelKey: 'menu.wordWrapOff' },
					{ value: 'on', labelKey: 'menu.wordWrapOn' },
					{ value: 'wordWrapColumn', labelKey: 'menu.wordWrapColumn' },
				],
			},
			// Monaco reads `wordWrapColumn` only in that wrap mode, so the row sits
			// under it and is inert in the other two.
			{
				kind: 'number',
				id: 'editor-max-width',
				labelKey: 'settings.wrapColumn',
				key: 'editorMaxWidth',
				range: EDITOR_MAX_WIDTH_RANGE,
				unit: 'chars',
				inactive: (s) => s.wordWrap !== 'wordWrapColumn',
			},
			{
				kind: 'toggle',
				id: 'editor-line-numbers',
				labelKey: 'settings.lineNumbers',
				checked: (s) => s.lineNumbers === 'on',
				toggle: (s) => s.toggleLineNumbers(),
			},
			{ kind: 'toggle', id: 'editor-minimap', labelKey: 'settings.minimap', key: 'minimap' },
			{ kind: 'toggle', id: 'editor-vim-mode', labelKey: 'settings.vimMode', key: 'vimMode' },
			{ kind: 'toggle', id: 'editor-status-bar', labelKey: 'settings.statusBar', key: 'statusBar' },
			// The word count is drawn in the status bar: without one it shows nothing.
			{ kind: 'toggle', id: 'editor-word-count', labelKey: 'settings.wordCount', key: 'wordCount', inactive: (s) => !s.statusBar },
			{ kind: 'toggle', id: 'editor-show-whitespace', labelKey: 'settings.showWhitespace', key: 'showWhitespace' },
			{ kind: 'toggle', id: 'editor-sticky-scroll', labelKey: 'settings.stickyScroll', key: 'stickyScroll' },
			{
				kind: 'toggle',
				id: 'editor-line-highlight',
				labelKey: 'settings.lineHighlight',
				checked: (s) => s.renderLineHighlight === 'line',
				toggle: (s) => s.toggleLineHighlight(),
			},
		],
	},
	preview: {
		reset: (s) => {
			s.resetPreviewFont();
			s.resetPreviewMaxWidth();
		},
		rows: [
			{
				kind: 'previewWidth',
				id: 'preview-max-width',
				labelKey: 'settings.previewMaxWidth',
				key: 'previewMaxWidth',
				range: { min: MIN_PREVIEW_MAX_WIDTH, max: MAX_PREVIEW_MAX_WIDTH, step: 40, default: DEFAULT_PREVIEW_MAX_WIDTH },
			},
			{ kind: 'font', id: 'preview-font', labelKey: 'settings.previewBodyFont', key: 'previewFont' },
			{ kind: 'number', id: 'preview-font-size', labelKey: 'settings.previewBodyFontSize', key: 'previewFontSize', range: PREVIEW_FONT_SIZE_RANGE, unit: 'px' },
			{ kind: 'font', id: 'code-font', labelKey: 'settings.previewCodeFont', key: 'codeFont' },
			{ kind: 'number', id: 'code-font-size', labelKey: 'settings.previewCodeFontSize', key: 'codeFontSize', range: CODE_FONT_SIZE_RANGE, unit: 'px' },
			{ kind: 'toggle', id: 'preview-cursor', labelKey: 'settings.previewCursor', key: 'previewCursor' },
			{ kind: 'toggle', id: 'preview-occurrences', labelKey: 'settings.previewOccurrences', key: 'previewOccurrences' },
			{ kind: 'toggle', id: 'preview-annotations', labelKey: 'settings.previewAnnotations', key: 'previewAnnotations' },
			{ kind: 'toggle', id: 'preview-table-breakout', labelKey: 'settings.previewTableBreakout', hintKey: 'settings.previewTableBreakoutHint', key: 'previewTableBreakout' },
			{ kind: 'toggle', id: 'preview-table-scroll', labelKey: 'settings.previewTableScroll', hintKey: 'settings.previewTableScrollHint', key: 'previewTableScroll' },
			{ kind: 'toggle', id: 'preview-newline-breaks', labelKey: 'settings.previewNewlineBreaks', hintKey: 'settings.previewNewlineBreaksHint', key: 'previewNewlineBreaks' },
		],
	},
	appearance: {
		rows: [
			{ kind: 'custom', id: 'appearance-language', labelKey: 'settings.language' },
			{ kind: 'custom', id: 'appearance-theme', labelKey: 'settings.theme' },
			{ kind: 'custom', id: 'theme-import', labelKey: 'settings.importVSCodeTheme' },
			{ kind: 'toggle', id: 'appearance-tabs', labelKey: 'settings.showTabs', key: 'showTabs' },
			{
				kind: 'select',
				id: 'appearance-tab-position',
				labelKey: 'settings.tabPosition',
				key: 'tabPosition',
				options: TAB_POSITION_OPTIONS,
				inactive: (s) => !s.showTabs,
			},
			{
				kind: 'select',
				id: 'appearance-folder-side',
				labelKey: 'settings.folderSide',
				inactiveTitleKey: 'settings.folderSideFollowsTabs',
				key: 'folderSide',
				options: [
					{ value: 'left', labelKey: 'settings.folderSideLeft' },
					{ value: 'right', labelKey: 'settings.folderSideRight' },
				],
				inactive: folderSideFollowsTabs,
			},
			{
				kind: 'select',
				id: 'appearance-sidebar-stack',
				labelKey: 'settings.sidebarStackOrder',
				key: 'sidebarStackOrder',
				options: [
					{ value: 'openFilesTop', labelKey: 'settings.sidebarStackOpenFilesTop' },
					{ value: 'folderTop', labelKey: 'settings.sidebarStackFolderTop' },
				],
			},
			{ kind: 'toggle', id: 'appearance-folder-all-files', labelKey: 'settings.folderShowAllFiles', titleKey: 'settings.folderShowAllFilesHint', key: 'folderShowAllFiles' },
			{
				kind: 'toggle',
				id: 'appearance-duplicate-name-folder',
				labelKey: 'settings.showFolderForDuplicateNames',
				key: 'showFolderForDuplicateNames',
				inactive: (s) => !s.showTabs,
			},
			{ kind: 'toggle', id: 'appearance-toc', labelKey: 'settings.showTableOfContents', key: 'showToc' },
			{
				kind: 'select',
				id: 'appearance-toc-follows',
				labelKey: 'settings.tocFollows',
				key: 'tocFollows',
				options: [
					{ value: 'scroll', labelKey: 'settings.tocFollowsScroll' },
					{ value: 'cursor', labelKey: 'settings.tocFollowsCursor' },
				],
			},
			{ kind: 'toggle', id: 'appearance-animate-jump', labelKey: 'settings.animateJumpScroll', key: 'animateJumpScroll' },
			{ kind: 'toggle', id: 'appearance-animate-cursor', labelKey: 'settings.animateCursor', key: 'animateCursor' },
			{ kind: 'custom', id: 'appearance-highlight-color', labelKey: 'settings.highlightColor' },
			{
				kind: 'toggle',
				id: 'appearance-zen-mode',
				labelKey: 'settings.zenMode',
				hintKey: 'settings.zenModeHint',
				checked: (s) => s.zenMode,
				toggle: (s) => s.toggleZenMode(),
			},
			{ kind: 'toggle', id: 'appearance-focus-mode', labelKey: 'settings.focusMode', hintKey: 'settings.focusModeHint', key: 'focusMode' },
			{ kind: 'toggle', id: 'appearance-typewriter-mode', labelKey: 'settings.typewriterMode', hintKey: 'settings.typewriterModeHint', key: 'typewriterMode' },
		],
	},
	files: {
		rows: [
			{ kind: 'select', id: 'files-open-file-mode', labelKey: 'settings.openFileMode', key: 'openFileMode', options: OPEN_FILE_MODE_OPTIONS },
			{ kind: 'toggle', id: 'files-new-file-mode', labelKey: 'settings.newFileDefaultMode', key: 'newFileDefaultMode' },
			{ kind: 'toggle', id: 'files-links-new-tab', labelKey: 'settings.linksOpenInNewTab', key: 'linksOpenInNewTab' },
			{ kind: 'toggle', id: 'files-recent-files', labelKey: 'settings.showRecentFiles', key: 'showRecentFiles' },
			{ kind: 'toggle', id: 'files-auto-save', labelKey: 'settings.autoSave', key: 'autoSave' },
			{ kind: 'toggle', id: 'files-restore-state', labelKey: 'settings.restoreStateOnReopen', titleKey: 'settings.restoreStateOnReopenHint', key: 'restoreStateOnReopen' },
			{ kind: 'toggle', id: 'files-recovery', labelKey: 'settings.persistOpenEditors', titleKey: 'settings.persistOpenEditorsHint', key: 'persistOpenEditors' },
			{ kind: 'custom', id: 'image-directory', labelKey: 'settings.imageDirectory' },
			{ kind: 'custom', id: 'macos-image-scaling', labelKey: 'settings.scaleMacOSScreenshots' },
			{ kind: 'toggle', id: 'files-close-window-last-tab', labelKey: 'settings.closeWindowWithLastTab', key: 'closeWindowWithLastTab' },
			{ kind: 'custom', id: 'settings-file-import', labelKey: 'settings.settingsFile' },
		],
	},
};

/** Writes a numeric row's setting, clamped to the row's range. */
export function setNumberSetting(s: SettingsStore, row: NumberRow, value: number) {
	s[row.key] = clampToRange(value, row.range);
}

/**
 * The event handlers of a numeric setting input.
 *
 * `min`/`max` on `<input type="number">` only drive validation styling and
 * the spin buttons; they do not stop typing, and Svelte's `bind:value`
 * assigns `null` for an empty field — which used to reach the store and
 * render as `font-size: nullpx` before being persisted as the string
 * "null". So the binding is one-way and every commit goes through the
 * shared range.
 *
 * While typing we accept only values that already fall inside the range and
 * ignore everything else, rather than clamping eagerly: clamping on each
 * keystroke would turn the intermediate "1" of "18" into "10" and leave the
 * caret stranded. Out-of-range or empty input is settled on commit instead.
 */
export function numberInputHandlers(range: NumericSettingRange, assign: (value: number) => void) {
	/**
	 * Commit (change / blur / Enter). Clamps, falls back to the range default for
	 * an empty or unparseable field, and writes the result back to the DOM —
	 * the element needs that explicitly, because when the clamped value equals
	 * the value already in the store there is no state change for Svelte to
	 * re-render from and the input would keep showing the rejected text.
	 */
	function commit(event: Event) {
		const input = event.currentTarget as HTMLInputElement;
		const next = parseStoredNumber(input.value, range);
		assign(next);
		input.value = String(next);
	}

	return {
		oninput(event: Event) {
			const input = event.currentTarget as HTMLInputElement;
			if (input.value.trim() === '') return;
			const parsed = Number(input.value);
			if (!isWithinRange(parsed, range)) return;
			assign(Math.round(parsed));
		},
		onchange: commit,
		onblur: commit,
		onkeydown(event: KeyboardEvent) {
			if (event.key !== 'Enter') return;
			commit(event);
		},
	};
}
