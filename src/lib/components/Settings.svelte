<script lang="ts">
	import { commands } from '../bindings.js';
	import { openUrl } from '@tauri-apps/plugin-opener';
	import { open, save } from '@tauri-apps/plugin-dialog';
	import {
		settings,
		applySettings,
		exportSettings,
		parseSettingsFile,
		resolveTheme,
		stepWithinRange,
		CODE_FONT_SIZE_RANGE,
		DEFAULT_FONTS,
		EDITOR_FONT_SIZE_RANGE,
		EDITOR_MAX_WIDTH_RANGE,
		PREVIEW_FONT_SIZE_RANGE,
		type NumericSettingRange,
		type ThemeSetting,
	} from '../stores/settings.svelte.js';
	import { updateStore } from '../stores/update.svelte.js';
	import { fade, scale, fly } from 'svelte/transition';
	import { t, getSupportedLanguages } from '../utils/i18n.js';
	import { shortcutSections } from '../utils/shortcuts.js';
	import { platformOf } from '../utils/platform.js';
	import {
		SETTINGS_PANES,
		folderSideFollowsTabs,
		numberInputHandlers,
		setNumberSetting,
		type SettingsRow,
	} from '../utils/settingsPanes.js';
	import { createSettingsOpen } from '../utils/settingsOpen.svelte.js';
	import type { LanguageCode, TranslationKey } from '../utils/i18n.js';
	import { getEditorToolbarTools } from '../utils/editorToolbar.js';
	import { getTitlebarToolbarActions, type TitlebarToolbarPlacement } from '../utils/titlebarToolbar.js';
	import { DEFAULT_PREVIEW_MAX_WIDTH, normalizePreviewMaxWidth } from '../utils/previewWidth.js';

	let {
		show = false,
		theme = 'system',
		onSetTheme,
		onclose,
	} = $props<{ show?: boolean; theme?: ThemeSetting; onSetTheme?: (t: ThemeSetting) => void; onclose: () => void }>();

	let activeCategory = $state<'editor' | 'preview' | 'appearance' | 'toolbars' | 'files' | 'shortcuts'>('editor');
	let highlightMenuOpen = $state(false);

	function updatePreviewMaxWidth(value: unknown) {
		settings.previewMaxWidth = normalizePreviewMaxWidth(value);
	}

	/** Spin buttons share the clamping rules with typing and with persistence. */
	function stepSetting(current: number, delta: number, range: NumericSettingRange, assign: (value: number) => void) {
		assign(stepWithinRange(current, delta, range));
	}

	const highlightColors = [
		{ value: 'default', color: 'var(--color-accent-fg)' },
		{ value: 'yellow', color: '#ffd000' },
		{ value: 'orange', color: '#ff8c00' },
		{ value: 'red', color: '#ff3c3c' },
		{ value: 'pink', color: '#ff69b4' },
		{ value: 'purple', color: '#a46cf4' },
		{ value: 'blue', color: '#438af3' },
		{ value: 'cyan', color: '#2bb9b2' },
		{ value: 'green', color: '#4db158' }
	] as const;

	type SettingsModalFrame = {
		width: number;
		height: number;
		left: number | null;
		top: number | null;
	};

	type ConcreteSettingsModalFrame = {
		width: number;
		height: number;
		left: number;
		top: number;
	};

	type SettingsModalDragState = {
		pointerId: number;
		clientX: number;
		clientY: number;
		left: number;
		top: number;
		width: number;
		height: number;
	};

	type SettingsResizeEdge = 'top' | 'right' | 'bottom' | 'left';

	type SettingsResizeHandle = {
		className: string;
		edges: SettingsResizeEdge[];
	};

	const settingsResizeHandles: SettingsResizeHandle[] = [
		{ className: 'resize-n', edges: ['top'] },
		{ className: 'resize-ne', edges: ['top', 'right'] },
		{ className: 'resize-e', edges: ['right'] },
		{ className: 'resize-se', edges: ['bottom', 'right'] },
		{ className: 'resize-s', edges: ['bottom'] },
		{ className: 'resize-sw', edges: ['bottom', 'left'] },
		{ className: 'resize-w', edges: ['left'] },
		{ className: 'resize-nw', edges: ['top', 'left'] },
	];

	let settingsModal = $state<HTMLDivElement>();
	let defaultFonts = $derived(DEFAULT_FONTS[settings.osType] || DEFAULT_FONTS.unknown);

	/**
	 * Which rows still hold their shipped default, decided once.
	 *
	 * The rows used to print `· 12–48 · Default 16` after every stepper. That
	 * text was the only place a default was discoverable, and it was also what
	 * pushed the controls out of alignment — the trailing string is as wide as
	 * the numbers in it, so no two rows ended at the same place. Dropping it
	 * without replacement would hide the defaults entirely, so the marker below
	 * takes over the job: a row that differs from its default gets a gutter bar,
	 * the way VS Code marks a modified setting.
	 *
	 * The two "Reset … settings" buttons ask the same question for a whole pane,
	 * and they used to answer it with their own inline comparison chain. That is
	 * one behaviour with two implementations, so the buttons now read this
	 * record instead: a row can never disagree with the button that resets it.
	 */
	let modified = $derived({
		editorFont: settings.editorFont !== defaultFonts.editorFont,
		editorFontSize: settings.editorFontSize !== EDITOR_FONT_SIZE_RANGE.default,
		editorMaxWidth: settings.editorMaxWidth !== EDITOR_MAX_WIDTH_RANGE.default,
		previewMaxWidth: settings.previewMaxWidth !== DEFAULT_PREVIEW_MAX_WIDTH,
		previewFont: settings.previewFont !== defaultFonts.previewFont,
		previewFontSize: settings.previewFontSize !== PREVIEW_FONT_SIZE_RANGE.default,
		codeFont: settings.codeFont !== defaultFonts.codeFont,
		codeFontSize: settings.codeFontSize !== CODE_FONT_SIZE_RANGE.default,
	});
	let editorSettingsModified = $derived(
		modified.editorFont || modified.editorFontSize || modified.editorMaxWidth,
	);
	let previewSettingsModified = $derived(
		modified.previewMaxWidth ||
			modified.previewFont ||
			modified.previewFontSize ||
			modified.codeFont ||
			modified.codeFontSize,
	);

	let savedVscodeThemes = $state<string[]>([]);
	let themeImportUrl = $state('');
	let importingTheme = $state(false);
	const editorToolbarDrag = createToolbarRowDrag('data-editor-toolbar-tool-id', (id, targetId) =>
		settings.reorderEditorToolbarTool(id, targetId),
	);
	const titlebarToolbarDrag = createToolbarRowDrag('data-titlebar-toolbar-action-id', (id, targetId) =>
		settings.reorderTitlebarToolbarAction(id, targetId),
	);
	let settingsModalFrame = $state<SettingsModalFrame>({
		// Placeholder until the modal is measured; matches `.settings-modal`.
		width: 600,
		height: 420,
		left: null,
		top: null,
	});
	let settingsModalDragStart = $state<SettingsModalDragState | null>(null);
	let settingsResizeStart = $state<{
		pointerId: number;
		clientX: number;
		clientY: number;
		width: number;
		height: number;
		left: number;
		top: number;
		edges: SettingsResizeEdge[];
	} | null>(null);
	let settingsModalIsDragging = $state(false);
	let settingsModalIsResizing = $state(false);
	let editorToolbarSettingsTools = $derived(getEditorToolbarTools(settings.editorToolbarOrder));
	let titlebarToolbarSettingsActions = $derived(getTitlebarToolbarActions(settings.titlebarToolbarOrder));
	let settingsModalFrameStyle = $derived.by(() => {
		if (settingsModalFrame.left === null || settingsModalFrame.top === null) return '';
		return [
			'position: absolute',
			`left: ${settingsModalFrame.left}px`,
			`top: ${settingsModalFrame.top}px`,
			`width: ${settingsModalFrame.width}px`,
			`height: ${settingsModalFrame.height}px`,
		].join('; ');
	});

	type ToolbarSettingsDragState = {
		id: string;
		startY: number;
		pointerId: number;
		isDragging: boolean;
		lastTargetId: string | null;
	};

	function isEditorToolbarToolVisible(id: string) {
		return !settings.editorToolbarHidden.includes(id);
	}

	function isTitlebarToolbarActionVisible(id: string) {
		return !settings.titlebarToolbarHidden.includes(id);
	}

	function getTitlebarToolbarActionPlacement(id: string): TitlebarToolbarPlacement {
		return settings.titlebarToolbarPlacement[id] ?? 'menu';
	}

	function getToolbarDragTargetId(e: PointerEvent, selector: string, attributeName: string) {
		const target = document.elementFromPoint(e.clientX, e.clientY);
		const row = target instanceof HTMLElement ? target.closest<HTMLElement>(selector) : null;
		return row?.getAttribute(attributeName) ?? null;
	}

	function createToolbarDragState(e: PointerEvent, id: string): ToolbarSettingsDragState | null {
		if (e.button !== 0) return null;
		e.preventDefault();
		e.stopPropagation();
		return {
			id,
			startY: e.clientY,
			pointerId: e.pointerId,
			isDragging: false,
			lastTargetId: null,
		};
	}

	/**
	 * Follows one press at window level until that pointer lifts or is
	 * cancelled. `onEnd` gets the final event; its `type` tells up from cancel.
	 */
	function trackPointer(start: PointerEvent, onMove: (e: PointerEvent) => void, onEnd: (e: PointerEvent) => void) {
		const move = (e: PointerEvent) => {
			if (e.pointerId === start.pointerId) onMove(e);
		};
		const end = (e: PointerEvent) => {
			if (e.pointerId !== start.pointerId) return;
			window.removeEventListener('pointermove', move);
			window.removeEventListener('pointerup', end);
			window.removeEventListener('pointercancel', end);
			onEnd(e);
		};
		window.addEventListener('pointermove', move);
		window.addEventListener('pointerup', end);
		window.addEventListener('pointercancel', end);
	}

	/** Drag-to-reorder for one toolbar list. Each row carries its id in `attributeName`. */
	function createToolbarRowDrag(attributeName: string, reorder: (id: string, targetId: string) => void) {
		const view = $state<{ draggingId: string | null; dragOverId: string | null }>({ draggingId: null, dragOverId: null });
		let dragState: ToolbarSettingsDragState | null = null;

		function onMove(e: PointerEvent) {
			if (!dragState || e.pointerId !== dragState.pointerId) return;
			e.preventDefault();

			if (!dragState.isDragging) {
				if (Math.abs(e.clientY - dragState.startY) <= 4) return;
				dragState.isDragging = true;
				view.draggingId = dragState.id;
			}

			const targetId = getToolbarDragTargetId(e, `[${attributeName}]`, attributeName);
			if (!targetId || targetId === dragState.id) {
				view.dragOverId = null;
				dragState.lastTargetId = null;
				return;
			}

			view.dragOverId = targetId;
			if (targetId === dragState.lastTargetId) return;
			dragState.lastTargetId = targetId;
			reorder(dragState.id, targetId);
		}

		function onEnd(e: PointerEvent) {
			if (!dragState || e.pointerId !== dragState.pointerId) return;
			if (e.type === 'pointerup' && dragState.isDragging) e.preventDefault();
			view.draggingId = null;
			view.dragOverId = null;
			dragState = null;
		}

		return {
			get draggingId() {
				return view.draggingId;
			},
			get dragOverId() {
				return view.dragOverId;
			},
			pointerDown(e: PointerEvent, id: string) {
				const next = createToolbarDragState(e, id);
				if (!next) return;
				dragState = next;
				trackPointer(e, onMove, onEnd);
			},
		};
	}

	function clampNumber(value: number, min: number, max: number) {
		return Math.min(max, Math.max(min, value));
	}

	function getSettingsModalLimits() {
		const viewportWidth = typeof window === 'undefined' ? 1024 : window.innerWidth;
		const viewportHeight = typeof window === 'undefined' ? 768 : window.innerHeight;
		return {
			viewportWidth,
			viewportHeight,
			minWidth: Math.min(520, viewportWidth * 0.9),
			maxWidth: viewportWidth * 0.9,
			minHeight: Math.min(360, viewportHeight * 0.9),
			maxHeight: viewportHeight * 0.9,
		};
	}

	function getCurrentSettingsModalFrame(): ConcreteSettingsModalFrame | null {
		if (!settingsModal) return null;
		const { width, height, left, top } = settingsModal.getBoundingClientRect();
		return clampSettingsModalFrame({ width, height, left, top });
	}

	function clampSettingsModalFrame(frame: ConcreteSettingsModalFrame): ConcreteSettingsModalFrame {
		const limits = getSettingsModalLimits();
		const width = clampNumber(frame.width, limits.minWidth, limits.maxWidth);
		const height = clampNumber(frame.height, limits.minHeight, limits.maxHeight);
		return {
			width,
			height,
			left: clampNumber(frame.left, 0, Math.max(0, limits.viewportWidth - width)),
			top: clampNumber(frame.top, 0, Math.max(0, limits.viewportHeight - height)),
		};
	}

	function isSettingsHeaderInteractiveTarget(target: EventTarget | null) {
		if (!(target instanceof HTMLElement)) return false;
		return Boolean(target.closest('button, a, input, select, textarea, [role="button"]'));
	}

	function handleSettingsModalDragPointerDown(e: PointerEvent) {
		const header = e.target instanceof HTMLElement ? e.target.closest('.settings-header') : null;
		if (e.button !== 0 || !header || !settingsModal?.contains(header) || isSettingsHeaderInteractiveTarget(e.target)) return;
		const frame = getCurrentSettingsModalFrame();
		if (!frame) return;

		e.preventDefault();
		e.stopPropagation();
		settingsModalFrame = frame;
		settingsModalDragStart = {
			pointerId: e.pointerId,
			clientX: e.clientX,
			clientY: e.clientY,
			left: frame.left,
			top: frame.top,
			width: frame.width,
			height: frame.height,
		};
		settingsModalIsDragging = true;
		trackPointer(e, handleSettingsModalDragWindowPointerMove, completeSettingsModalDrag);
	}

	function handleSettingsModalDragWindowPointerMove(e: PointerEvent) {
		if (!settingsModalDragStart || e.pointerId !== settingsModalDragStart.pointerId) return;
		e.preventDefault();
		const left = settingsModalDragStart.left + e.clientX - settingsModalDragStart.clientX;
		const top = settingsModalDragStart.top + e.clientY - settingsModalDragStart.clientY;
		settingsModalFrame = clampSettingsModalFrame({
			width: settingsModalDragStart.width,
			height: settingsModalDragStart.height,
			left,
			top,
		});
	}

	function completeSettingsModalDrag(e: PointerEvent) {
		if (!settingsModalDragStart || e.pointerId !== settingsModalDragStart.pointerId) return;
		e.preventDefault();
		e.stopPropagation();
		settingsModalDragStart = null;
		settingsModalIsDragging = false;
	}

	function completeSettingsResize(e: PointerEvent) {
		if (!settingsResizeStart || e.pointerId !== settingsResizeStart.pointerId) return;
		e.preventDefault();
		e.stopPropagation();
		settingsResizeStart = null;
		settingsModalIsResizing = false;
	}

	function handleSettingsResizePointerDown(e: PointerEvent, edges: SettingsResizeEdge[]) {
		const frame = getCurrentSettingsModalFrame();
		if (!frame) return;

		e.preventDefault();
		e.stopPropagation();
		settingsResizeStart = {
			pointerId: e.pointerId,
			clientX: e.clientX,
			clientY: e.clientY,
			width: frame.width,
			height: frame.height,
			left: frame.left,
			top: frame.top,
			edges,
		};
		settingsModalFrame = frame;
		settingsModalIsResizing = true;
		trackPointer(e, handleSettingsResizeWindowPointerMove, completeSettingsResize);
	}

	function handleSettingsResizeWindowPointerMove(e: PointerEvent) {
		if (!settingsResizeStart || e.pointerId !== settingsResizeStart.pointerId) return;
		e.preventDefault();
		e.stopPropagation();

		const deltaX = e.clientX - settingsResizeStart.clientX;
		const deltaY = e.clientY - settingsResizeStart.clientY;
		let width = settingsResizeStart.width;
		let height = settingsResizeStart.height;
		let left = settingsResizeStart.left;
		let top = settingsResizeStart.top;

		if (settingsResizeStart.edges.includes('right')) {
			width = settingsResizeStart.width + deltaX;
		}
		if (settingsResizeStart.edges.includes('bottom')) {
			height = settingsResizeStart.height + deltaY;
		}
		if (settingsResizeStart.edges.includes('left')) {
			width = settingsResizeStart.width - deltaX;
			left = settingsResizeStart.left + deltaX;
		}
		if (settingsResizeStart.edges.includes('top')) {
			height = settingsResizeStart.height - deltaY;
			top = settingsResizeStart.top + deltaY;
		}

		const limits = getSettingsModalLimits();
		if (width < limits.minWidth && settingsResizeStart.edges.includes('left')) {
			left = settingsResizeStart.left + settingsResizeStart.width - limits.minWidth;
		}
		if (width > limits.maxWidth && settingsResizeStart.edges.includes('left')) {
			left = settingsResizeStart.left + settingsResizeStart.width - limits.maxWidth;
		}
		if (height < limits.minHeight && settingsResizeStart.edges.includes('top')) {
			top = settingsResizeStart.top + settingsResizeStart.height - limits.minHeight;
		}
		if (height > limits.maxHeight && settingsResizeStart.edges.includes('top')) {
			top = settingsResizeStart.top + settingsResizeStart.height - limits.maxHeight;
		}

		settingsModalFrame = clampSettingsModalFrame({ width, height, left, top });
	}

	async function loadVscodeThemes() {
		try {
			savedVscodeThemes = await commands.getSavedVscodeThemes();
		} catch (e) {
			console.error('Failed to load vscode themes:', e);
		}
	}

	const dialog = createSettingsOpen({ isOpen: () => show, modal: () => settingsModal, onOpen: loadVscodeThemes });

	function handleModalKeydown(e: KeyboardEvent) {
		if (e.key === 'Escape') {
			e.preventDefault();
			onclose();
			return;
		}

		if (e.key !== 'Tab') return;
		const focusableElements = settingsModal?.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])') || [];
		if (focusableElements.length === 0) return;

		const first = focusableElements[0] as HTMLElement;
		const last = focusableElements[focusableElements.length - 1] as HTMLElement;

		if (e.shiftKey) {
			if (document.activeElement === first) {
				e.preventDefault();
				last.focus();
			}
		} else if (document.activeElement === last) {
			e.preventDefault();
			first.focus();
		}
	}

	async function importVscodeTheme() {
		if (!themeImportUrl) return;
		importingTheme = true;
		try {
			const name = await commands.fetchVscodeTheme(themeImportUrl);
			themeImportUrl = '';
			await loadVscodeThemes();
			onSetTheme?.(`vscode:${name}`);
		} catch (e) {
			console.error('Failed to import theme:', e);
			alert(`Failed to import theme: ${e}`);
		} finally {
			importingTheme = false;
		}
	}

	async function exportSettingsFile() {
		try {
			const path = await save({ defaultPath: 'markpad-settings.json', filters: [{ name: 'JSON', extensions: ['json'] }] });
			if (!path) return;
			const names = await commands.getSavedVscodeThemes();
			const themes: Record<string, string> = {};
			for (const name of names) themes[name] = await commands.readVscodeTheme(name);
			await commands.saveFileContent(path, exportSettings(settings, themes), 'UTF-8');
		} catch (e) {
			console.error('Failed to export settings:', e);
			alert(`${t('settings.exportSettingsFailed', settings.language)}\n${e}`);
		}
	}

	async function importSettingsFile() {
		try {
			const path = await open({ multiple: false, directory: false, filters: [{ name: 'JSON', extensions: ['json'] }] });
			if (typeof path !== 'string') return;
			const [content] = await commands.readFileContentChecked(path);
			const file = parseSettingsFile(content);
			for (const [name, json] of Object.entries(file.themes)) {
				await commands.installVscodeTheme(name, json);
			}
			await loadVscodeThemes();
			applySettings(settings, file.settings);
		} catch (e) {
			console.error('Failed to import settings:', e);
			alert(`${t('settings.importSettingsFailed', settings.language)}\n${e}`);
		}
	}

	async function deleteTheme(name: string) {
		try {
			await commands.deleteVscodeTheme(name);
			if (theme === `vscode:${name}`) onSetTheme?.('system');
			await loadVscodeThemes();
		} catch (e) {
			console.error('Failed to delete theme:', e);
		}
	}


	function rowModified(row: SettingsRow): boolean {
		return 'key' in row && row.key !== undefined ? ((modified as Record<string, boolean>)[row.key] ?? false) : false;
	}

	function rowTitle(row: SettingsRow): string | undefined {
		if (row.titleKey) return t(row.titleKey, settings.language);
		if (row.inactiveTitleKey) return row.inactive?.(settings) ? t(row.inactiveTitleKey, settings.language) : '';
		return undefined;
	}
</script>

{#snippet customRow(row: SettingsRow)}
	{#if row.id === 'appearance-language'}
		<div class="setting-item">
			<label for="appearance-language">{t(row.labelKey, settings.language)}</label>
			<div class="select-wrapper">
				<select id="appearance-language" value={settings.language} onchange={(e) => settings.setLanguage(e.currentTarget.value as LanguageCode)}>
					{#each getSupportedLanguages() as lang}
						<option value={lang.code}>{lang.nativeName}</option>
					{/each}
				</select>
				<svg
					class="select-arrow"
					width="12"
					height="12"
					viewBox="0 0 24 24"
					fill="none"
					stroke="currentColor"
					stroke-width="2"
					stroke-linecap="round"
					stroke-linejoin="round"><polyline points="6 9 12 15 18 9"></polyline></svg>
			</div>
		</div>
	{:else if row.id === 'appearance-theme'}
		<div class="setting-item">
			<label for="appearance-theme">{t(row.labelKey, settings.language)}</label>
			<div class="select-wrapper">
				<select id="appearance-theme" value={theme} onchange={(e) => onSetTheme?.(resolveTheme(e.currentTarget.value))}>
					<option value="system">{t('settings.themeFollowSystem', settings.language)}</option>
					<option value="light">{t('settings.themeDefaultLight', settings.language)}</option>
					<option value="dark">{t('settings.themeDefaultDark', settings.language)}</option>
					{#if savedVscodeThemes.length > 0}
						<optgroup label={t('settings.vsCodeThemes', settings.language)}>
							{#each savedVscodeThemes as themeOption}
								<option value={`vscode:${themeOption}`}>{themeOption}</option>
							{/each}
						</optgroup>
					{/if}
				</select>
				<svg
					class="select-arrow"
					width="12"
					height="12"
					viewBox="0 0 24 24"
					fill="none"
					stroke="currentColor"
					stroke-width="2"
					stroke-linecap="round"
					stroke-linejoin="round"><polyline points="6 9 12 15 18 9"></polyline></svg>
			</div>
		</div>

		{#if theme.startsWith('vscode:')}
			<div class="setting-block">
				<button class="reset-text-btn delete-theme" onclick={() => deleteTheme(theme.replace('vscode:', ''))}>
					{t('settings.deleteSelectedTheme', settings.language)}
				</button>
			</div>
		{/if}
	{:else if row.id === 'theme-import'}
		<div class="setting-block">
			<div class="setting-block-row">
				<label for="theme-import">{t(row.labelKey, settings.language)}</label>
				<button
					class="reset-text-btn"
					onclick={() =>
						openUrl('https://vscodethemes.com/')
							.catch(() => window.open('https://vscodethemes.com/', '_blank'))}
				>
					{t('settings.browseThemes', settings.language)}
				</button>
			</div>
			<div class="setting-block-row">
				<input
					type="text"
					id="theme-import"
					class="text-input theme-import-url"
					placeholder="https://vscodethemes.com/e/..."
					bind:value={themeImportUrl}
					onkeydown={e => e.key === 'Enter' && importVscodeTheme()}
				/>
				<button class="import-btn" onclick={importVscodeTheme} disabled={importingTheme || !themeImportUrl}>
					{importingTheme ? t('settings.importing', settings.language) : t('settings.import', settings.language)}
				</button>
			</div>
		</div>
	{:else if row.id === 'appearance-highlight-color'}
			<div class="setting-item">
				<label for="appearance-highlight-color">{t(row.labelKey, settings.language)}</label>
				<div class="custom-dropdown-wrapper">
					<button 
						class="custom-dropdown-btn" 
						onclick={(e) => { e.stopPropagation(); highlightMenuOpen = !highlightMenuOpen; }}>
							<div style="display: flex; align-items: center; gap: 8px;">
							<div class="color-circle" style="background-color: {highlightColors.find(c => c.value === settings.highlightColor)?.color || 'var(--color-accent-fg)'}"></div>
							<span>{t(`colors.${settings.highlightColor || 'default'}` as TranslationKey, settings.language)}</span>
						</div>
							<svg class="select-arrow" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"></polyline></svg>
					</button>
					{#if highlightMenuOpen}
						<div
							class="custom-dropdown-menu"
							role="menu"
							tabindex="-1"
							transition:fly={{ y: 5, duration: 150 }}
							onclick={(e) => e.stopPropagation()}
							onkeydown={(e) => {
								if (e.key === 'Escape') highlightMenuOpen = false;
							}}>
							{#each highlightColors as color, index}
								{#if index === 1}
									<div class="theme-menu-divider" style="height: 1px; background-color: var(--color-border-muted); margin: 4px 0; transform: scaleY(0.5);"></div>
								{/if}
								<button 
										class="custom-dropdown-option {settings.highlightColor === color.value ? 'selected' : ''}" 
										onclick={() => {
											settings.highlightColor = color.value;
											highlightMenuOpen = false;
										}}
									>
										<div class="color-circle" style="background-color: {color.color}"></div>
										<span>{t(`colors.${color.value}`, settings.language)}</span>
									</button>
							{/each}
						</div>
					{/if}
				</div>
		</div>
	{:else if row.id === 'image-directory'}
		<div class="setting-item">
			<label for="image-directory">{t(row.labelKey, settings.language)}</label>
			<input
				type="text"
				id="image-directory"
				class="text-input"
				style="width: 120px;"
				bind:value={settings.imageDirectory}
				placeholder="img"
				title={t('settings.imageDirectoryHint', settings.language)}
			/>
		</div>
	{:else if row.id === 'macos-image-scaling'}
		{#if settings.osType === 'macos'}
			<div class="setting-item">
				<label for="macos-image-scaling">{t(row.labelKey, settings.language)}</label>
				<label class="toggle">
					<input id="macos-image-scaling" type="checkbox" bind:checked={settings.macosImageScaling} />
					<span class="toggle-slider"></span>
				</label>
				<span class="slider-value">{t('settings.reduceSizeBy50', settings.language)}</span>
			</div>
		{/if}
	{:else if row.id === 'settings-file-import'}
		<div class="setting-item">
			<label for="settings-file-import">{t(row.labelKey, settings.language)}</label>
			<div class="settings-file-actions">
				<button id="settings-file-import" class="import-btn" onclick={importSettingsFile}>{t('settings.importSettings', settings.language)}</button>
				<button class="import-btn" onclick={exportSettingsFile}>{t('settings.exportSettings', settings.language)}</button>
			</div>
		</div>
	{/if}
{/snippet}

{#snippet settingRow(row: SettingsRow)}
	{#if row.kind === 'custom'}
		{@render customRow(row)}
	{:else}
		<div class="setting-item" class:modified={rowModified(row)} class:inactive={row.inactive?.(settings) ?? false}>
			<label for={row.id} class:has-hint={!!row.hintKey} title={rowTitle(row)}>{t(row.labelKey, settings.language)}{#if row.hintKey}<span class="setting-hint">{t(row.hintKey, settings.language)}</span>{/if}</label>
			{#if row.kind === 'font'}
				<div class="select-wrapper">
					<select id={row.id} bind:value={settings[row.key]}>
						{#each dialog.systemFonts as font}
							<option value={font}>{font === defaultFonts[row.key] ? font + ' (' + t('settings.default', settings.language) + ')' : font}</option>
						{/each}
					</select>
					<svg class="select-arrow" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"></polyline></svg>
				</div>
			{:else if row.kind === 'number'}
				{@const disabled = row.inactive?.(settings) ?? false}
				{@const assign = (value: number) => setNumberSetting(settings, row, value)}
				<div class="slider-container">
					<div class="number-input-wrapper horizontal">
						<button class="spin-btn minus" {disabled} onclick={() => stepSetting(settings[row.key], -row.range.step, row.range, assign)} aria-label={t('common.decrease', settings.language)}>
							<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"
						><line x1="5" y1="12" x2="19" y2="12"></line></svg>
						</button>
						<input
							type="number"
							id={row.id}
							min={row.range.min}
							max={row.range.max}
							step={row.range.step}
							value={settings[row.key]}
							{...numberInputHandlers(row.range, assign)}
							class="number-input"
							{disabled}
						/>
						<button class="spin-btn plus" {disabled} onclick={() => stepSetting(settings[row.key], row.range.step, row.range, assign)} aria-label={t('common.increase', settings.language)}>
							<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"
						><line x1="12" y1="5" x2="12" y2="19"></line><line x1="5" y1="12" x2="19" y2="12"></line></svg>
						</button>
					</div>
					<span class="unit-label">{row.unit}</span>
				</div>
			{:else if row.kind === 'previewWidth'}
				<div class="slider-container">
					<div class="number-input-wrapper horizontal">
						<button class="spin-btn minus" onclick={() => updatePreviewMaxWidth(settings.previewMaxWidth - row.range.step)} aria-label={t('common.decrease', settings.language)}>
							<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"
						><line x1="5" y1="12" x2="19" y2="12"></line></svg>
						</button>
						<input
							type="number"
							id={row.id}
							min={row.range.min}
							max={row.range.max}
							step={row.range.step}
							bind:value={settings.previewMaxWidth}
							onchange={() => updatePreviewMaxWidth(settings.previewMaxWidth)}
							class="number-input"
						/>
						<button class="spin-btn plus" onclick={() => updatePreviewMaxWidth(settings.previewMaxWidth + row.range.step)} aria-label={t('common.increase', settings.language)}>
							<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"
						><line x1="12" y1="5" x2="12" y2="19"></line><line x1="5" y1="12" x2="19" y2="12"></line></svg>
						</button>
					</div>
					<span class="unit-label">px</span>
				</div>
			{:else if row.kind === 'select'}
				<div class="select-wrapper">
					<select id={row.id} disabled={row.inactive?.(settings) ?? false} bind:value={settings[row.key]}>
						{#each row.options as option}
							<option value={option.value}>{t(option.labelKey, settings.language)}</option>
						{/each}
					</select>
					<svg class="select-arrow" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"></polyline></svg>
				</div>
			{:else if row.kind === 'toggle'}
				<label class="toggle">
					{#if row.key}
						<input id={row.id} type="checkbox" bind:checked={settings[row.key]} disabled={row.inactive?.(settings) ?? false} />
					{:else}
						<input id={row.id} type="checkbox" checked={row.checked?.(settings)} onchange={() => row.toggle?.(settings)} />
					{/if}
					<span class="toggle-slider"></span>
				</label>
			{/if}
		</div>
	{/if}
{/snippet}

{#if show}
	<div class="settings-backdrop" transition:fade={{ duration: 150 }} role="presentation">
		<div
			class="settings-modal"
			class:dragging={settingsModalIsDragging}
			class:resizing={settingsModalIsResizing}
			bind:this={settingsModal}
			style={settingsModalFrameStyle}
			transition:scale={{ duration: 200, start: 0.95 }}
			role="dialog"
			aria-modal="true"
			aria-labelledby="settings-title"
			tabindex="-1"
			onpointerdown={handleSettingsModalDragPointerDown}
			onkeydown={handleModalKeydown}>
			<div class="settings-header">
				<h1 id="settings-title">{t('settings.title', settings.language)}</h1>
				<button class="close-btn" onclick={onclose} aria-label={t('common.close', settings.language)}>
					<svg
						xmlns="http://www.w3.org/2000/svg"
						width="16"
						height="16"
						viewBox="0 0 24 24"
						fill="none"
						stroke="currentColor"
						stroke-width="2"
						stroke-linecap="round"
						stroke-linejoin="round">
						<line x1="18" y1="6" x2="6" y2="18"></line>
						<line x1="6" y1="6" x2="18" y2="18"></line>
					</svg>
				</button>
			</div>

			<div class="settings-content">
				<nav class="settings-nav">
					<button class="nav-item" class:active={activeCategory === 'editor'} onclick={() => (activeCategory = 'editor')}>
						<svg
								xmlns="http://www.w3.org/2000/svg"
								width="16"
								height="16"
								viewBox="0 0 24 24"
								fill="none"
								stroke="currentColor"
								stroke-width="2"
								stroke-linecap="round"
								stroke-linejoin="round">
								<path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path>
								<path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path>
							</svg>
							{t('settings.editor', settings.language)}
					</button>
					<button class="nav-item" class:active={activeCategory === 'preview'} onclick={() => (activeCategory = 'preview')}>
						<svg
								xmlns="http://www.w3.org/2000/svg"
								width="16"
								height="16"
								viewBox="0 0 24 24"
								fill="none"
								stroke="currentColor"
								stroke-width="2"
								stroke-linecap="round"
								stroke-linejoin="round">
								<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path>
								<circle cx="12" cy="12" r="3"></circle>
							</svg>
							{t('settings.preview', settings.language)}
					</button>
					<button class="nav-item" class:active={activeCategory === 'appearance'} onclick={() => (activeCategory = 'appearance')}>
						<svg
								xmlns="http://www.w3.org/2000/svg"
								width="16"
								height="16"
								viewBox="0 0 24 24"
								fill="none"
								stroke="currentColor"
								stroke-width="2"
								stroke-linecap="round"
								stroke-linejoin="round">
								<circle cx="12" cy="12" r="3"></circle>
								<path
									d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"
								></path>
							</svg>
							{t('settings.appearance', settings.language)}
					</button>
					<button class="nav-item" class:active={activeCategory === 'toolbars'} onclick={() => (activeCategory = 'toolbars')}>
						<svg
								xmlns="http://www.w3.org/2000/svg"
								width="16"
								height="16"
								viewBox="0 0 24 24"
								fill="none"
								stroke="currentColor"
								stroke-width="2"
								stroke-linecap="round"
								stroke-linejoin="round">
								<rect x="3" y="4" width="18" height="5" rx="1"></rect>
								<rect x="3" y="15" width="18" height="5" rx="1"></rect>
								<path d="M7 9v6"></path>
								<path d="M17 9v6"></path>
							</svg>
							{t('settings.toolbars', settings.language)}
					</button>
					<button class="nav-item" class:active={activeCategory === 'files'} onclick={() => (activeCategory = 'files')}>
						<svg
								xmlns="http://www.w3.org/2000/svg"
								width="16"
								height="16"
								viewBox="0 0 24 24"
								fill="none"
								stroke="currentColor"
								stroke-width="2"
								stroke-linecap="round"
								stroke-linejoin="round">
								<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path>
								<polyline points="14 2 14 8 20 8"></polyline>
								<line x1="9" y1="13" x2="15" y2="13"></line>
								<line x1="9" y1="17" x2="13" y2="17"></line>
							</svg>
							{t('settings.files', settings.language)}
					</button>
					<button class="nav-item" class:active={activeCategory === 'shortcuts'} onclick={() => (activeCategory = 'shortcuts')}>
						<svg
								xmlns="http://www.w3.org/2000/svg"
								width="16"
								height="16"
								viewBox="0 0 24 24"
								fill="none"
								stroke="currentColor"
								stroke-width="2"
								stroke-linecap="round"
								stroke-linejoin="round">
								<rect x="2" y="6" width="20" height="12" rx="2" ry="2"></rect>
								<line x1="6" y1="10" x2="6" y2="10"></line>
								<line x1="10" y1="10" x2="10" y2="10"></line>
								<line x1="14" y1="10" x2="14" y2="10"></line>
								<line x1="18" y1="10" x2="18" y2="10"></line>
								<line x1="8" y1="14" x2="16" y2="14"></line>
							</svg>
							{t('settings.shortcuts', settings.language)}
					</button>

					<div class="nav-footer">
						<button
							class="check-updates-btn"
							onclick={() => updateStore.openDialog()}
							aria-label={t('menu.checkForUpdates', settings.language)}>
							<svg
								xmlns="http://www.w3.org/2000/svg"
								width="16"
								height="16"
								viewBox="0 0 24 24"
								fill="none"
								stroke="currentColor"
								stroke-width="2"
								stroke-linecap="round"
								stroke-linejoin="round">
								<polyline points="23 4 23 10 17 10"></polyline>
								<path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"></path>
							</svg>
							<span>{t('menu.checkForUpdates', settings.language)}</span>
						</button>
						<button
							class="github-btn"
							onclick={() =>
								openUrl('https://github.com/alecdotdev/Markpad')
									.catch(() => window.open('https://github.com/alecdotdev/Markpad', '_blank'))}
							aria-label="GitHub">
							<svg viewBox="0 0 24 24" class="github-icon" fill="currentColor">
									<path
										d="M12 2C6.477 2 2 6.477 2 12c0 4.42 2.865 8.166 6.839 9.489.5.092.682-.217.682-.482 0-.237-.008-.866-.013-1.7-2.782.603-3.369-1.34-3.369-1.34-.454-1.156-1.11-1.462-1.11-1.462-.908-.62.069-.608.069-.608 1.003.07 1.531 1.03 1.531 1.03.892 1.529 2.341 1.087 2.91.831.092-.646.35-1.086.636-1.336-2.22-.253-4.555-1.11-4.555-4.943 0-1.091.39-1.984 1.029-2.683-.103-.253-.446-1.27.098-2.647 0 0 .84-.269 2.75 1.025A9.578 9.578 0 0112 6.836c.85.004 1.705.114 2.504.336 1.909-1.294 2.747-1.025 2.747-1.025.546 1.377.203 2.394.1 2.647.64.699 1.028 1.592 1.028 2.683 0 3.842-2.339 4.687-4.566 4.935.359.309.678.919.678 1.852 0 1.336-.012 2.415-.012 2.743 0 .267.18.578.688.48C19.138 20.161 22 16.418 22 12c0-5.523-4.477-10-10-10z"
										></path>
								</svg>
								<span>{t('menu.github', settings.language)}</span>
							{#if dialog.appVersion}
								<span class="version-code">v{dialog.appVersion}</span>
							{/if}
						</button>
					</div>
				</nav>

					<div class="settings-panel" role="presentation" onclick={() => { highlightMenuOpen = false; }}>
						{#if activeCategory === 'editor'}
						<div class="settings-group">
							<div class="settings-group-header">
								<h2>{t('settings.editorSettings', settings.language)}</h2>
								<button
									class="reset-text-btn"
									class:disabled={!editorSettingsModified}
									onclick={() => SETTINGS_PANES.editor.reset?.(settings)}>
									{t('settings.resetEditorSettings', settings.language)}
								</button>
							</div>

						{#each SETTINGS_PANES.editor.rows as row (row.id)}
							{@render settingRow(row)}
						{/each}
					</div>
					{:else if activeCategory === 'preview'}
						<div class="settings-group">
							<div class="settings-group-header">
								<h2>{t('settings.previewSettings', settings.language)}</h2>
								<button
									class="reset-text-btn"
									class:disabled={!previewSettingsModified}
									onclick={() => SETTINGS_PANES.preview.reset?.(settings)}>
									{t('settings.resetPreviewSettings', settings.language)}
								</button>
							</div>

							{#each SETTINGS_PANES.preview.rows as row (row.id)}
								{@render settingRow(row)}
							{/each}
						</div>
					{:else if activeCategory === 'appearance'}
						<div class="settings-group">
						<h2>{t('settings.appearanceSettings', settings.language)}</h2>

						{#each SETTINGS_PANES.appearance.rows as row (row.id)}
							{@render settingRow(row)}
						{/each}
					</div>
					{:else if activeCategory === 'toolbars'}
					<div class="settings-group">
						<div class="settings-group-header">
							<h2>{t('settings.toolbarsSettings', settings.language)}</h2>
						</div>

						<details class="toolbar-settings toolbar-settings-accordion">
							<summary class="toolbar-settings-summary">
								<span class="toolbar-settings-chevron" aria-hidden="true"></span>
								<span>{t('settings.applicationToolbar', settings.language)}</span>
							</summary>
							<div class="toolbar-settings-body">
								<div class="toolbar-section-header">
								<button
									type="button"
									class="reset-text-btn"
									onclick={() => settings.resetTitlebarToolbar()}>
									{t('settings.resetToolbar', settings.language)}
								</button>
							</div>
							<div class="toolbar-settings-list" role="list">
								{#each titlebarToolbarSettingsActions as action, index (action.id)}
									{@const actionName = t(action.labelKey, settings.language) === action.labelKey ? action.fallbackName : t(action.labelKey, settings.language)}
									<div
										class="toolbar-tool-row titlebar-toolbar-row"
										class:drag-source={titlebarToolbarDrag.draggingId === action.id}
										class:drag-over={titlebarToolbarDrag.dragOverId === action.id}
										role="listitem"
										data-titlebar-toolbar-action-id={action.id}>
										<button
											type="button"
											class="toolbar-drag-handle"
											aria-label={`${t('settings.move', settings.language)}: ${actionName}`}
											onpointerdown={(e) => titlebarToolbarDrag.pointerDown(e, action.id)}>
											<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
												<circle cx="9" cy="5" r="1" fill="currentColor"/>
												<circle cx="9" cy="12" r="1" fill="currentColor"/>
												<circle cx="9" cy="19" r="1" fill="currentColor"/>
												<circle cx="15" cy="5" r="1" fill="currentColor"/>
												<circle cx="15" cy="12" r="1" fill="currentColor"/>
												<circle cx="15" cy="19" r="1" fill="currentColor"/>
											</svg>
										</button>
										<input
											class="toolbar-tool-check"
											id={`titlebar-toolbar-action-${action.id}`}
											type="checkbox"
											checked={isTitlebarToolbarActionVisible(action.id)}
											disabled={action.required}
											onchange={(e) => settings.setTitlebarToolbarActionVisible(action.id, e.currentTarget.checked)}
										/>
										<label class="toolbar-tool-name" for={`titlebar-toolbar-action-${action.id}`}>{actionName}{#if action.hintKey}<span class="toolbar-tool-hint">{t(action.hintKey, settings.language)}</span>{/if}</label>
										<div class="toolbar-placement-controls" role="group" aria-label={`${t('settings.toolbarPlacement', settings.language)}: ${actionName}`}>
											<button
												type="button"
												class:active={getTitlebarToolbarActionPlacement(action.id) === 'bar'}
												onclick={() => settings.setTitlebarToolbarActionPlacement(action.id, 'bar')}>
												{t('settings.toolbarOnBar', settings.language)}
											</button>
											<button
												type="button"
												class:active={getTitlebarToolbarActionPlacement(action.id) === 'menu'}
												onclick={() => settings.setTitlebarToolbarActionPlacement(action.id, 'menu')}>
												{t('settings.toolbarInMenu', settings.language)}
											</button>
										</div>
										<div class="toolbar-order-controls">
											<button
												type="button"
												disabled={index === 0}
												aria-label={`${t('settings.moveUp', settings.language)}: ${actionName}`}
												onclick={() => settings.moveTitlebarToolbarAction(action.id, 'up')}>
												<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="18 15 12 9 6 15"></polyline></svg>
											</button>
											<button
												type="button"
												disabled={index === titlebarToolbarSettingsActions.length - 1}
												aria-label={`${t('settings.moveDown', settings.language)}: ${actionName}`}
												onclick={() => settings.moveTitlebarToolbarAction(action.id, 'down')}>
												<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"></polyline></svg>
											</button>
										</div>
									</div>
								{/each}
								</div>
							</div>
						</details>

						<details class="toolbar-settings toolbar-settings-accordion">
							<summary class="toolbar-settings-summary">
								<span class="toolbar-settings-chevron" aria-hidden="true"></span>
								<span>{t('settings.editorToolbar', settings.language)}</span>
								<label class="toggle toolbar-summary-toggle">
									<input id="editor-show-toolbar" type="checkbox" aria-label={t('settings.showEditorToolbar', settings.language)} bind:checked={settings.showEditorToolbar} />
									<span class="toggle-slider"></span>
								</label>
							</summary>
							<div class="toolbar-settings-body">
								<div class="toolbar-section-header">
								<button
									type="button"
									class="reset-text-btn"
									onclick={() => settings.resetEditorToolbar()}>
									{t('settings.resetToolbar', settings.language)}
								</button>
							</div>
							<div class="toolbar-settings-list" role="list">
								{#each editorToolbarSettingsTools as tool, index (tool.id)}
									{@const toolName = t(tool.labelKey, settings.language)}
									<div
										class="toolbar-tool-row"
										class:drag-source={editorToolbarDrag.draggingId === tool.id}
										class:drag-over={editorToolbarDrag.dragOverId === tool.id}
										role="listitem"
										data-editor-toolbar-tool-id={tool.id}>
										<button
											type="button"
											class="toolbar-drag-handle"
											aria-label={`${t('settings.move', settings.language)}: ${toolName}`}
											onpointerdown={(e) => editorToolbarDrag.pointerDown(e, tool.id)}>
											<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
												<circle cx="9" cy="5" r="1" fill="currentColor"/>
												<circle cx="9" cy="12" r="1" fill="currentColor"/>
												<circle cx="9" cy="19" r="1" fill="currentColor"/>
												<circle cx="15" cy="5" r="1" fill="currentColor"/>
												<circle cx="15" cy="12" r="1" fill="currentColor"/>
												<circle cx="15" cy="19" r="1" fill="currentColor"/>
											</svg>
										</button>
										<input
											class="toolbar-tool-check"
											id={`editor-toolbar-tool-${tool.id}`}
											type="checkbox"
											checked={isEditorToolbarToolVisible(tool.id)}
											onchange={(e) => settings.setEditorToolbarToolVisible(tool.id, e.currentTarget.checked)}
										/>
										<label class="toolbar-tool-name" for={`editor-toolbar-tool-${tool.id}`}>{toolName}</label>
										<div class="toolbar-order-controls">
											<button
												type="button"
												disabled={index === 0}
												aria-label={`${t('settings.moveUp', settings.language)}: ${toolName}`}
												onclick={() => settings.moveEditorToolbarTool(tool.id, 'up')}>
												<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="18 15 12 9 6 15"></polyline></svg>
											</button>
											<button
												type="button"
												disabled={index === editorToolbarSettingsTools.length - 1}
												aria-label={`${t('settings.moveDown', settings.language)}: ${toolName}`}
												onclick={() => settings.moveEditorToolbarTool(tool.id, 'down')}>
												<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"></polyline></svg>
											</button>
										</div>
									</div>
								{/each}
								</div>
							</div>
						</details>
					</div>
					{:else if activeCategory === 'files'}
					<div class="settings-group">
						<div class="settings-group-header">
							<h2>{t('settings.fileSettings', settings.language)}</h2>
						</div>

						{#each SETTINGS_PANES.files.rows as row (row.id)}
							{@render settingRow(row)}
						{/each}
					</div>
					{:else if activeCategory === 'shortcuts'}
					<!--
						Read-only, on purpose. Remapping needs conflict detection,
						persistence, reset-to-default and chord capture inside a webview, and
						it is a product-direction call; this pane is the part of the value
						that needs none of them.

						Every chord below comes from `shortcuts.ts`, and
						`scripts/shortcuts.test.ts` fires each one at the real
						handlers — so this list cannot drift away from what the keys do.
					-->
					{#each shortcutSections(platformOf(settings.osType)) as section (section.group)}
						<div class="settings-group shortcut-group">
							<div class="settings-group-header">
								<h2>{t(section.labelKey, settings.language)}</h2>
							</div>

							{#each section.entries as entry (entry.id)}
								<div class="shortcut-row">
									<span class="shortcut-name">{t(entry.labelKey, settings.language)}{#if entry.hintKey}<span class="toolbar-tool-hint">{t(entry.hintKey, settings.language)}</span>{/if}</span>
									<span class="shortcut-keys">
										{#each entry.chords as chord (chord)}
											<kbd>{chord}</kbd>
										{/each}
									</span>
								</div>
							{/each}
						</div>
					{/each}
					{/if}
				</div>
			</div>
			{#each settingsResizeHandles as handle}
				<button
					type="button"
					tabindex="-1"
					class="settings-resize-handle {handle.className}"
					aria-label={t('settings.resizeWindow', settings.language)}
					onclick={(e) => e.stopPropagation()}
					onpointerdown={(e) => handleSettingsResizePointerDown(e, handle.edges)}></button>
			{/each}
		</div>
	</div>
{/if}

<style>
	.settings-backdrop {
		position: fixed;
		top: 0;
		left: 0;
		right: 0;
		bottom: 0;
		background: rgba(0, 0, 0, 0.4);
		display: flex;
		align-items: center;
		justify-content: center;
		z-index: 10000;
	}

	.settings-modal {
		background: var(--color-canvas-default);
		border: 1px solid var(--color-border-default);
		border-radius: 6px;
		box-shadow: 0 20px 50px rgba(0, 0, 0, 0.3);
		/*
		 * Drag and resize measure this dialog's border box and write it back as
		 * inline `width`/`height`, so the border has to sit inside the width —
		 * otherwise every drag adds the 2px border to the size it just read.
		 */
		box-sizing: border-box;
		/*
		 * 600px, not the 560px this shipped at: the label column plus the
		 * widest font <select> ("Helvetica Neue (Default)", 188px) need 372px
		 * of panel, and 560px only left 363px — the dropdown lost the end of
		 * the font name to an ellipsis. Keep in step with the placeholder
		 * `settingsModalFrame` starts from.
		 */
		width: min(600px, 90vw);
		max-width: 90vw;
		min-width: min(520px, 90vw);
		height: 420px;
		max-height: 90vh;
		min-height: min(360px, 90vh);
		display: flex;
		flex-direction: column;
		overflow: hidden;
		position: relative;
		font-family: var(--win-font);
	}

	.settings-modal.dragging,
	.settings-modal.resizing {
		user-select: none;
	}

	.settings-resize-handle {
		position: absolute;
		padding: 0;
		border: none;
		background: transparent;
		color: var(--color-fg-muted);
		z-index: 2;
	}

	.settings-resize-handle.resize-n,
	.settings-resize-handle.resize-s {
		left: 12px;
		right: 12px;
		height: 6px;
		cursor: ns-resize;
	}

	.settings-resize-handle.resize-n {
		top: -2px;
	}

	.settings-resize-handle.resize-s {
		bottom: -2px;
	}

	.settings-resize-handle.resize-e,
	.settings-resize-handle.resize-w {
		top: 12px;
		bottom: 12px;
		width: 6px;
		cursor: ew-resize;
	}

	.settings-resize-handle.resize-e {
		right: -2px;
	}

	.settings-resize-handle.resize-w {
		left: -2px;
	}

	.settings-resize-handle.resize-ne,
	.settings-resize-handle.resize-se,
	.settings-resize-handle.resize-sw,
	.settings-resize-handle.resize-nw {
		width: 18px;
		height: 18px;
	}

	.settings-resize-handle.resize-ne {
		top: -2px;
		right: -2px;
		cursor: nesw-resize;
	}

	.settings-resize-handle.resize-se {
		right: -2px;
		bottom: -2px;
		cursor: nwse-resize;
	}

	.settings-resize-handle.resize-sw {
		left: -2px;
		bottom: -2px;
		cursor: nesw-resize;
	}

	.settings-resize-handle.resize-nw {
		top: -2px;
		left: -2px;
		cursor: nwse-resize;
	}

	.settings-resize-handle.resize-se::before {
		content: '';
		position: absolute;
		right: 4px;
		bottom: 4px;
		width: 9px;
		height: 9px;
		border-right: 1px solid currentColor;
		border-bottom: 1px solid currentColor;
		opacity: 0.7;
	}

	.settings-resize-handle.resize-se::after {
		content: '';
		position: absolute;
		right: 8px;
		bottom: 8px;
		width: 5px;
		height: 5px;
		border-right: 1px solid currentColor;
		border-bottom: 1px solid currentColor;
		opacity: 0.55;
	}

	.settings-resize-handle:hover {
		color: var(--color-fg-default);
	}

	.settings-header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding: 16px 20px;
		border-bottom: 1px solid var(--color-border-default);
		cursor: grab;
		user-select: none;
	}

	.settings-modal.dragging .settings-header {
		cursor: grabbing;
	}

	.settings-header h1 {
		font-size: 16px;
		font-weight: 600;
		margin: 0;
	}

	.close-btn {
		display: flex;
		align-items: center;
		justify-content: center;
		width: 28px;
		height: 28px;
		border: none;
		background: transparent;
		cursor: pointer;
		border-radius: 4px;
		color: var(--color-fg-default);
	}

	.close-btn:hover {
		background: var(--color-neutral-muted);
	}

	.settings-content {
		display: flex;
		flex: 1;
		overflow: hidden;
	}

	.settings-nav {
		width: 140px;
		padding: 12px 8px;
		border-right: 1px solid var(--color-border-default);
		display: flex;
		flex-direction: column;
		gap: 2px;
	}

	.nav-item {
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 8px 12px;
		line-height: 1;
		border: none;
		background: transparent;
		cursor: pointer;
		border-radius: 6px;
		font-size: 13px;
		color: var(--color-fg-default);
		text-align: left;
	}

	.nav-item svg {
		width: 16px;
		height: 16px;
	}

	.nav-item:hover {
		background: var(--color-neutral-muted);
	}

	.nav-item.active {
		background: var(--color-accent-fg);
		color: var(--color-btn-fg);
	}

	.nav-footer {
		margin-top: auto;
		display: flex;
		flex-direction: column;
	}

	.github-btn,
	.check-updates-btn {
		display: flex;
		align-items: center;
		padding: 8px 12px;
		border: none;
		background: transparent;
		cursor: pointer;
		border-radius: 6px;
		opacity: 0.5;
		font-size: 13px;
		color: var(--color-fg-default);
		text-align: left;
		transition: all 0.1s;
		gap: 8px;
		font-family: inherit;
	}

	.github-btn:hover,
	.check-updates-btn:hover {
		opacity: 1;
	}

	.check-updates-btn svg {
		width: 16px;
		height: 16px;
		flex-shrink: 0;
	}

	.check-updates-btn span {
		margin-top: 1px;
	}

	.github-btn .github-icon {
		width: 16px;
		height: 16px;
	}

	.github-btn span {
		margin-top: 1px;
	}

	.github-btn .version-code {
		margin-left: auto;
		font-size: 11px;
		color: var(--color-fg-muted);
		margin-top: 2px;
	}

	.settings-panel {
		flex: 1;
		padding: 20px;
		overflow-y: auto;
		min-height: 0;

		/*
		 * The shared label column.
		 *
		 * Every row used to be `justify-content: space-between`, so a control's
		 * left edge was wherever its own label happened to stop: the editor
		 * pane's five rows started their controls at five different offsets,
		 * and the longest label pushed its control so far left that the two
		 * all but touched — the preview pane's width row ran out of room
		 * entirely and wrapped onto a second line.
		 *
		 * 172px clears the widest label any stepper or <select> row can produce
		 * in the 26 shipped locales — measured, not guessed: French "Colonne de
		 * retour à la ligne" is the longest at 167px and Greek "Μέγεθος
		 * γραμματοσειράς" second at 158px — so those controls line up in every
		 * language rather than only in English. Longer labels do exist, but only
		 * on toggle rows in Appearance and Files (German "Zustand beim erneuten
		 * Öffnen wiederherstellen", 285px); `min-width` rather than a fixed
		 * `width` lets those keep growing instead of wrapping, which is why the
		 * column is a floor and not a track.
		 */
		--settings-label-column: 172px;
	}

	.settings-group h2 {
		font-size: 16px;
		font-weight: 600;
		margin: 0 0 16px 0;
		color: var(--color-fg-default);
	}

	/*
	 * One group after another, with something between them.
	 *
	 * Every other pane shows a single `.settings-group`; the shortcuts pane stacks
	 * five, and stacked with nothing between them each heading sat flush against
	 * the last row of the group above and read as belonging to it. A rule and the
	 * space either side of it is what says "this heading starts what follows".
	 * Only between groups, so the first heading keeps the pane's own top padding.
	 */
	.shortcut-group + .shortcut-group {
		margin-top: 24px;
		padding-top: 24px;
		border-top: 1px solid var(--color-border-muted);
	}

	/* Read-only shortcut rows: a command on the left, its chord(s) on the right. */
	.shortcut-row {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 16px;
		padding: 6px 0;
	}

	.shortcut-name {
		color: var(--color-fg-default);
		font-size: 13px;
	}

	.shortcut-keys {
		display: flex;
		flex-wrap: wrap;
		justify-content: flex-end;
		gap: 6px;
	}

	.shortcut-keys kbd {
		font-family: var(--code-font, monospace);
		font-size: 11px;
		line-height: 1.4;
		white-space: nowrap;
		color: var(--color-fg-muted);
		background: var(--color-canvas-subtle);
		border: 1px solid var(--color-border-default);
		border-radius: 4px;
		padding: 2px 6px;
	}

	.settings-group-header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		/* "Paramètres de l'éditeur" ran straight into "Réinitialiser les
		   paramètres de l'éditeur" with nothing between them. */
		gap: 12px;
		margin-bottom: 16px;
	}

	.settings-group-header h2 {
		font-size: 16px;
		font-weight: 600;
		margin: 0;
		color: var(--color-fg-default);
	}

	.reset-text-btn {
		background: transparent;
		border: none;
		color: var(--color-fg-muted);
		font-size: 13px;
		cursor: pointer;
		padding: 0;
		transition: all 0.1s;
		text-decoration: none;
	}

	.reset-text-btn:hover:not(.disabled) {
		color: var(--color-accent-fg);
	}

	/*
	 * A control whose prerequisite is off. It stays visible and readable — the
	 * reader needs to see that the setting exists, and where it went — but says
	 * plainly that nothing it does can take effect yet. The prerequisite is
	 * always the row directly above it.
	 */
	.setting-item.inactive label:first-child,
	.setting-item.inactive .slider-container,
	.setting-item.inactive .toggle {
		opacity: 0.45;
	}

	.setting-item.inactive .toggle,
	.setting-item.inactive .number-input,
	.setting-item.inactive .spin-btn {
		cursor: default;
	}

	.reset-text-btn.disabled {
		opacity: 0.5;
		cursor: default;
	}

	.setting-item {
		display: flex;
		align-items: center;
		column-gap: 12px;
		padding: 10px 0;
		border-bottom: 1px solid var(--color-border-muted);
		position: relative;
	}

	.setting-item label:first-child {
		font-size: 13px;
		color: var(--color-fg-default);
		display: flex;
		align-items: center;
		height: 100%;
		/* The floor described on .settings-panel; see --settings-label-column. */
		flex: 0 1 auto;
		min-width: var(--settings-label-column);
	}

	/*
	 * A row whose value is no longer the shipped default.
	 *
	 * This replaces the `· 12–48 · Default 16` text that used to trail every
	 * stepper: the default is not printed any more (the pane's "Reset …
	 * settings" button restores it), so the bar is what tells you a row has
	 * been touched — the same signal VS Code puts in its settings gutter. It
	 * sits in the panel's 20px padding so it cannot shift the row's contents.
	 */
	.setting-item.modified::before {
		content: '';
		position: absolute;
		left: -10px;
		top: 10px;
		bottom: 10px;
		width: 2px;
		border-radius: 1px;
		background: var(--color-accent-fg);
	}

	/*
	 * A composite row (the VS Code theme import, the delete-theme link): it
	 * keeps `.setting-item`'s border and rhythm, not its label column.
	 * `.setting-item` is only ever a label plus controls as direct children;
	 * the row-structure guards in settings.spec.ts enforce that.
	 */
	.setting-block {
		display: flex;
		flex-direction: column;
		gap: 8px;
		padding: 10px 0;
		border-bottom: 1px solid var(--color-border-muted);
	}

	.setting-block-row {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 8px;
	}

	.setting-block-row label {
		font-size: 13px;
		color: var(--color-fg-default);
	}

	.theme-import-url {
		flex: 1;
		min-width: 0;
	}

	.delete-theme {
		align-self: flex-end;
		color: var(--color-danger-fg);
		font-size: 12px;
		padding: 0;
	}

	.toolbar-settings {
		padding: 0;
		border-bottom: 1px solid var(--color-border-muted);
	}

	.toolbar-settings-summary {
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 12px 0;
		list-style: none;
		color: var(--color-fg-default);
		font-size: 13px;
		font-weight: 600;
		cursor: pointer;
		user-select: none;
	}

	.toolbar-summary-toggle {
		margin-left: auto;
	}

	.toolbar-settings-summary::-webkit-details-marker {
		display: none;
	}

	.toolbar-settings-chevron {
		width: 7px;
		height: 7px;
		border-right: 1.5px solid var(--color-fg-muted);
		border-bottom: 1.5px solid var(--color-fg-muted);
		transform: rotate(-45deg);
		transition: transform 0.12s ease;
	}

	.toolbar-settings[open] .toolbar-settings-chevron {
		transform: rotate(45deg);
	}

	.toolbar-settings-body {
		padding-bottom: 12px;
	}

	.toolbar-section-header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding-bottom: 2px;
	}

	.toolbar-settings-list {
		display: flex;
		flex-direction: column;
		gap: 6px;
	}

	.toolbar-tool-row {
		display: grid;
		grid-template-columns: 20px 15px minmax(0, 1fr) auto;
		align-items: center;
		gap: 10px;
		min-height: 38px;
		padding: 4px 10px;
		border: 1px solid var(--color-border-muted);
		border-radius: 6px;
		background: var(--color-canvas-subtle);
		transition: background-color 0.15s, border-color 0.15s;
	}

	.toolbar-tool-row:hover {
		border-color: var(--color-border-default);
	}

	.titlebar-toolbar-row {
		grid-template-columns: 20px 15px minmax(0, 1fr) auto auto;
	}

	.toolbar-tool-row.drag-source {
		opacity: 0.55;
	}

	.toolbar-tool-row.drag-over {
		border-color: var(--color-accent-fg);
		background: var(--color-neutral-muted);
	}

	.toolbar-drag-handle {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 20px;
		height: 24px;
		padding: 0;
		border: none;
		background: transparent;
		color: var(--color-fg-muted);
		cursor: grab;
		line-height: 1;
		user-select: none;
		transition: color 0.15s;
	}

	.toolbar-drag-handle:hover {
		color: var(--color-fg-default);
	}

	.toolbar-drag-handle:active,
	.toolbar-tool-row.drag-source .toolbar-drag-handle {
		cursor: grabbing;
	}

	.toolbar-tool-name {
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font-size: 13px;
		font-weight: 500;
		color: var(--color-fg-default);
	}

	/* Drawn like the preview's task checkbox (styles.css), so it looks the same
	 * in WebKit, WebView2 and WebKitGTK. */
	.toolbar-tool-check {
		-webkit-appearance: none;
		appearance: none;
		position: relative;
		width: 15px;
		height: 15px;
		margin: 0;
		border: 1.5px solid var(--color-border-default);
		border-radius: 3px;
		background: transparent;
		cursor: pointer;
		transition: background-color 0.1s ease, border-color 0.1s ease;
	}

	.toolbar-tool-check:hover:not(:disabled) {
		border-color: var(--color-accent-fg);
	}

	.toolbar-tool-check:checked {
		background-color: var(--color-accent-fg);
		border-color: var(--color-accent-fg);
	}

	.toolbar-tool-check:checked::after {
		content: '';
		position: absolute;
		top: 0.5px;
		left: 3px;
		width: 4px;
		height: 7px;
		border: 2px solid white;
		border-top: none;
		border-left: none;
		transform: rotate(45deg);
	}

	.toolbar-tool-check:disabled {
		opacity: 0.5;
		cursor: default;
	}

	/* A one-line explanation under a label whose name alone does not say what it does. */
	.setting-item label.has-hint {
		flex-direction: column;
		align-items: flex-start;
		justify-content: center;
		gap: 2px;
		/* The label takes the row, so these toggles line up at its right end. */
		flex: 1 1 auto;
		min-width: 0;
	}

	.setting-hint {
		font-size: 11px;
		color: var(--color-fg-muted);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
		max-width: 100%;
	}

	.toolbar-tool-hint {
		display: block;
		overflow: hidden;
		text-overflow: ellipsis;
		font-size: 11px;
		font-weight: 400;
		color: var(--color-fg-muted);
	}

	.toolbar-order-controls {
		display: flex;
		align-items: center;
		gap: 2px;
	}

	.toolbar-order-controls button {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 24px;
		height: 24px;
		padding: 0;
		border: none;
		background: transparent;
		color: var(--color-fg-muted);
		cursor: pointer;
		transition: color 0.15s, transform 0.1s;
	}

	.toolbar-order-controls button:hover:not(:disabled) {
		color: var(--color-fg-default);
	}

	.toolbar-order-controls button:active:not(:disabled) {
		transform: scale(0.9);
	}

	.toolbar-order-controls button:disabled {
		opacity: 0.25;
		cursor: not-allowed;
	}

	.toolbar-placement-controls {
		display: inline-flex;
		align-items: center;
		padding: 2px;
		border: 1px solid var(--color-border-default);
		border-radius: 5px;
		background: var(--color-canvas-default);
	}

	.toolbar-placement-controls button {
		height: 22px;
		padding: 0 7px;
		border: none;
		border-radius: 3px;
		background: transparent;
		color: var(--color-fg-muted);
		font-size: 11px;
		cursor: pointer;
	}

	.toolbar-placement-controls button.active {
		background: var(--color-accent-fg);
		color: var(--color-btn-fg);
	}

	.toolbar-placement-controls button:not(.active):hover {
		background: var(--color-neutral-muted);
		color: var(--color-fg-default);
	}

	.select-wrapper {
		position: relative;
		display: inline-flex;
		align-items: center;
		/*
		 * One width for every dropdown in the modal. Left to itself a <select>
		 * is as wide as its widest option, so "Helvetica Neue (Default)" and
		 * "Window" produced two different boxes two rows apart.
		 *
		 * `width`, deliberately, not `flex: 0 1 220px`: a flex basis means the
		 * MAIN axis, so the same declaration is a width inside a row and a
		 * height inside a column. It was written as a basis and the theme row
		 * — whose select then sat in a column-direction parent — came out
		 * 220px tall. `width` plus `flex-basis: auto` says the same thing in
		 * the row case and cannot be misread in any other.
		 */
		width: 220px;
		flex: 0 1 auto;
		min-width: 0;
	}

	.select-arrow {
		position: absolute;
		right: 10px;
		pointer-events: none;
		color: var(--color-fg-muted);
	}

	.setting-item select {
		padding: 6px 32px 6px 12px;
		border: 1px solid var(--color-border-default);
		border-radius: 6px;
		background-color: var(--color-canvas-default);
		color: var(--color-fg-default);
		font-size: 13px;
		width: 100%;
		min-width: 140px;
		cursor: pointer;
		appearance: none;
		-webkit-appearance: none;
		-moz-appearance: none;
	}

	.setting-item select option {
		background-color: var(--color-canvas-default);
		color: var(--color-fg-default);
	}

	.setting-item select:focus {
		outline: none;
		border-color: var(--color-accent-fg);
	}

	.slider-container {
		display: flex;
		align-items: center;
		gap: 8px;
		flex: 0 0 auto;
	}

	.number-input-wrapper {
		display: flex;
		align-items: stretch;
		background: var(--color-canvas-default);
		border: 1px solid var(--color-border-default);
		border-radius: 4px;
		overflow: hidden;
		transition: border-color 0.1s;
	}

	.number-input-wrapper:focus-within {
		border-color: var(--color-accent-fg);
	}

	.number-input {
		width: 40px;
		padding: 4px 8px;
		background: transparent;
		border: none;
		color: var(--color-fg-default);
		font-family: inherit;
		font-size: 13px;
		text-align: right;
		appearance: textfield;
		-moz-appearance: textfield;
		outline: none;
	}

	.number-input::-webkit-outer-spin-button,
	.number-input::-webkit-inner-spin-button {
		-webkit-appearance: none;
		margin: 0;
	}

	.number-input-wrapper.horizontal {
		align-items: center;
		height: 28px;
	}

	/*
	 * One width for every stepper, wide enough for the four digits of
	 * MAX_PREVIEW_MAX_WIDTH. The preview-width and wrap-column inputs used to
	 * override this inline (62px and 50px), which gave the three steppers three
	 * different widths and therefore three different right edges.
	 */
	.number-input-wrapper.horizontal .number-input {
		text-align: center;
		width: 44px;
		padding: 4px 0;
		height: 100%;
		border-radius: 0;
	}

	.spin-btn {
		display: flex;
		align-items: center;
		justify-content: center;
		height: 100%;
		width: 28px;
		background: transparent;
		border: none;
		color: var(--color-fg-subtle);
		cursor: pointer;
		padding: 0;
		transition: all 0.1s;
	}

	.spin-btn:hover {
		background: var(--color-canvas-subtle);
		color: var(--color-fg-default);
	}

	.spin-btn:active {
		background: var(--color-border-muted);
	}

	.text-input {
		background: var(--color-canvas-default);
		border: 1px solid var(--color-border-default);
		border-radius: 6px;
		color: var(--color-fg-default);
		padding: 6px 10px;
		font-size: 13px;
		outline: none;
	}

	.text-input:focus {
		border-color: var(--color-accent-fg);
	}

	.import-btn {
		background: var(--color-canvas-subtle);
		border: 1px solid var(--color-border-default);
		border-radius: 6px;
		color: var(--color-fg-default);
		padding: 6px 12px;
		font-size: 13px;
		cursor: pointer;
		outline: none;
		transition: all 0.1s;
	}

	.import-btn:hover:not(:disabled) {
		background: var(--color-border-default);
	}

	.settings-file-actions {
		display: flex;
		gap: 8px;
	}

	.import-btn:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}

	.spin-btn.minus {
		border-right: 1px solid var(--color-border-default);
	}

	.spin-btn.plus {
		border-left: 1px solid var(--color-border-default);
	}

	.slider-value {
		font-size: 12px;
		color: var(--color-fg-muted);
	}

	/*
	 * The unit a stepper counts in, in a slot of its own.
	 *
	 * It used to be the first word of a sentence that ran on past the control
	 * — `chars · 20–500 · Default 80` — and because that sentence sat in the
	 * flow after the stepper, a five-letter unit pushed its stepper further
	 * left than a two-letter one. Reserving the widest unit's width here means
	 * the word can change (or be translated) without any stepper moving.
	 */
	.unit-label {
		flex: 0 0 auto;
		min-width: 36px;
		font-size: 12px;
		color: var(--color-fg-muted);
		white-space: nowrap;
	}

	.toggle {
		position: relative;
		display: inline-block;
		width: 40px;
		height: 20px;
		cursor: pointer;
	}

	.toggle input {
		opacity: 0;
		width: 0;
		height: 0;
	}

	.toggle-slider {
		position: absolute;
		cursor: pointer;
		top: 0;
		left: 0;
		right: 0;
		bottom: 0;
		background-color: transparent;
		border: 1px solid var(--color-fg-muted);
		transition:
			background-color 0.2s,
			border-color 0.2s;
		border-radius: 20px;
	}

	.toggle-slider:before {
		position: absolute;
		content: '';
		height: 12px;
		width: 12px;
		left: 3px;
		bottom: 3px;
		background-color: #abb2bf; 
		transition:
			transform 0.2s cubic-bezier(0.16, 1, 0.3, 1),
			height 0.2s,
			width 0.2s,
			left 0.2s,
			bottom 0.2s,
			background-color 0.2s;
		border-radius: 50%;
	}

	.toggle input:checked + .toggle-slider {
		background-color: var(--color-accent-fg);
		border-color: var(--color-accent-fg);
	}

	.toggle input:checked + .toggle-slider:before {
		transform: translateX(20px);
		background-color: #fff;
	}
	.custom-dropdown-wrapper {
		position: relative;
		min-width: 140px;
	}

	.custom-dropdown-btn {
		width: 100%;
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding: 4px 8px;
		background-color: var(--color-canvas-default);
		border: 1px solid var(--color-border-default);
		border-radius: 4px;
		color: var(--color-fg-default);
		font-size: 13px;
		font-family: inherit;
		cursor: pointer;
		outline: none;
	}
	.custom-dropdown-btn:hover {
		background-color: var(--color-canvas-subtle);
	}

	.custom-dropdown-menu {
		position: absolute;
		top: 100%;
		right: 0;
		margin-top: 4px;
		background-color: var(--color-canvas-default);
		border: 1px solid var(--color-border-default);
		border-radius: 6px;
		box-shadow: 0 8px 24px rgba(0, 0, 0, 0.2);
		padding: 4px;
		display: flex;
		flex-direction: column;
		min-width: 140px;
		z-index: 10005;
		gap: 1px;
	}

	.custom-dropdown-option {
		display: flex;
		align-items: center;
		gap: 8px;
		background: transparent;
		border: none;
		text-align: left;
		padding: 6px 12px;
		font-size: 13px;
		color: var(--color-fg-default);
		cursor: pointer;
		border-radius: 4px;
		font-family: inherit;
		width: 100%;
	}

	.custom-dropdown-option:hover {
		background-color: var(--color-canvas-subtle);
	}

	.custom-dropdown-option.selected {
		background-color: var(--color-canvas-subtle);
		font-weight: 500;
	}

	.color-circle {
		width: 12px;
		height: 12px;
		border-radius: 50%;
		flex-shrink: 0;
		border: 1px solid rgba(128, 128, 128, 0.4);
	}
</style>
