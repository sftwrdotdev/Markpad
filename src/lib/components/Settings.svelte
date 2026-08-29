<script lang="ts">
	import { invoke } from '@tauri-apps/api/core';
	import { getVersion } from '@tauri-apps/api/app';
	import { openUrl } from '@tauri-apps/plugin-opener';
	import {
		settings,
		clampToRange,
		isWithinRange,
		parseStoredNumber,
		resolveTheme,
		stepWithinRange,
		CODE_FONT_SIZE_RANGE,
		DEFAULT_FONTS,
		EDITOR_FONT_SIZE_RANGE,
		EDITOR_MAX_WIDTH_RANGE,
		PREVIEW_FONT_SIZE_RANGE,
		type NumericSettingRange,
		type OSType,
		type ThemeSetting,
	} from '../stores/settings.svelte.js';
	import { updateStore } from '../stores/update.svelte.js';
	import { fade, scale, fly } from 'svelte/transition';
	import { t, getSupportedLanguages } from '../utils/i18n.js';
	import { shortcutSections } from '../utils/shortcuts.js';
	import { platformOf } from '../utils/platform.js';
	import type { LanguageCode } from '../utils/i18n.js';
	import { getEditorToolbarTools } from '../utils/editorToolbar.js';
	import { getTitlebarToolbarActions, type TitlebarToolbarPlacement } from '../utils/titlebarToolbar.js';
	import {
		DEFAULT_PREVIEW_MAX_WIDTH,
		MAX_PREVIEW_MAX_WIDTH,
		MIN_PREVIEW_MAX_WIDTH,
		normalizePreviewMaxWidth,
	} from '../utils/previewWidth.js';

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

	/**
	 * Keystroke handler for a numeric setting input.
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
	function handleNumberInput(event: Event, range: NumericSettingRange, assign: (value: number) => void) {
		const input = event.currentTarget as HTMLInputElement;
		if (input.value.trim() === '') return;
		const parsed = Number(input.value);
		if (!isWithinRange(parsed, range)) return;
		assign(Math.round(parsed));
	}

	/**
	 * Commit handler (blur / Enter). Clamps, falls back to the range default for
	 * an empty or unparseable field, and writes the result back to the DOM —
	 * the element needs that explicitly, because when the clamped value equals
	 * the value already in the store there is no state change for Svelte to
	 * re-render from and the input would keep showing the rejected text.
	 */
	function commitNumberInput(event: Event, range: NumericSettingRange, assign: (value: number) => void) {
		const input = event.currentTarget as HTMLInputElement;
		const next = parseStoredNumber(input.value, range);
		assign(next);
		input.value = String(next);
	}

	function handleNumberKeydown(event: KeyboardEvent, range: NumericSettingRange, assign: (value: number) => void) {
		if (event.key !== 'Enter') return;
		commitNumberInput(event, range, assign);
	}

	/** Spin buttons share the clamping rules with typing and with persistence. */
	function stepSetting(current: number, delta: number, range: NumericSettingRange, assign: (value: number) => void) {
		assign(stepWithinRange(current, delta, range));
	}

	const setEditorFontSize = (value: number) => { settings.editorFontSize = clampToRange(value, EDITOR_FONT_SIZE_RANGE); };
	const setEditorMaxWidth = (value: number) => { settings.editorMaxWidth = clampToRange(value, EDITOR_MAX_WIDTH_RANGE); };
	const setPreviewFontSize = (value: number) => { settings.previewFontSize = clampToRange(value, PREVIEW_FONT_SIZE_RANGE); };
	const setCodeFontSize = (value: number) => { settings.codeFontSize = clampToRange(value, CODE_FONT_SIZE_RANGE); };
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
	];

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

	let systemFonts = $state<string[]>([]);
	// Plain variables on purpose: neither is rendered, and both are read *and*
	// written by the open-effect below. As `$state` they made that effect
	// re-enter itself — `loadFonts()` reads `loaded` synchronously and sets it
	// after its await, which re-ran the effect and clobbered the saved
	// `previousActiveElement` with a control inside the dialog.
	let loaded = false;
	let previousActiveElement: HTMLElement | null = null;
	let settingsModal = $state<HTMLDivElement>();
	let appVersion = $state<string>('');
	let osType = $state<OSType>('unknown');
	let defaultFonts = $derived(DEFAULT_FONTS[osType] || DEFAULT_FONTS.unknown);

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
	let editorToolbarDraggingId = $state<string | null>(null);
	let editorToolbarDragOverId = $state<string | null>(null);
	let editorToolbarDragState = $state<ToolbarSettingsDragState | null>(null);
	let titlebarToolbarDraggingId = $state<string | null>(null);
	let titlebarToolbarDragOverId = $state<string | null>(null);
	let titlebarToolbarDragState = $state<ToolbarSettingsDragState | null>(null);
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

	function handleEditorToolbarDragPointerDown(e: PointerEvent, id: string) {
		const dragState = createToolbarDragState(e, id);
		if (!dragState) return;
		editorToolbarDragState = dragState;
		window.addEventListener('pointermove', handleEditorToolbarWindowPointerMove);
		window.addEventListener('pointerup', handleEditorToolbarWindowPointerUp);
		window.addEventListener('pointercancel', handleEditorToolbarWindowPointerCancel);
	}

	function handleEditorToolbarWindowPointerMove(e: PointerEvent) {
		if (!editorToolbarDragState || e.pointerId !== editorToolbarDragState.pointerId) return;
		e.preventDefault();

		if (!editorToolbarDragState.isDragging) {
			if (Math.abs(e.clientY - editorToolbarDragState.startY) <= 4) return;
			editorToolbarDragState.isDragging = true;
			editorToolbarDraggingId = editorToolbarDragState.id;
		}

		const targetId = getToolbarDragTargetId(e, '[data-editor-toolbar-tool-id]', 'data-editor-toolbar-tool-id');
		if (!targetId || targetId === editorToolbarDragState.id) {
			editorToolbarDragOverId = null;
			editorToolbarDragState.lastTargetId = null;
			return;
		}

		editorToolbarDragOverId = targetId;
		if (targetId === editorToolbarDragState.lastTargetId) return;
		editorToolbarDragState.lastTargetId = targetId;
		settings.reorderEditorToolbarTool(editorToolbarDragState.id, targetId);
	}

	function clearEditorToolbarDragState() {
		editorToolbarDraggingId = null;
		editorToolbarDragOverId = null;
		editorToolbarDragState = null;
		window.removeEventListener('pointermove', handleEditorToolbarWindowPointerMove);
		window.removeEventListener('pointerup', handleEditorToolbarWindowPointerUp);
		window.removeEventListener('pointercancel', handleEditorToolbarWindowPointerCancel);
	}

	function handleEditorToolbarWindowPointerUp(e: PointerEvent) {
		if (!editorToolbarDragState || e.pointerId !== editorToolbarDragState.pointerId) return;
		if (editorToolbarDragState.isDragging) e.preventDefault();
		clearEditorToolbarDragState();
	}

	function handleEditorToolbarWindowPointerCancel(e: PointerEvent) {
		if (!editorToolbarDragState || e.pointerId !== editorToolbarDragState.pointerId) return;
		clearEditorToolbarDragState();
	}

	function handleTitlebarToolbarDragPointerDown(e: PointerEvent, id: string) {
		const dragState = createToolbarDragState(e, id);
		if (!dragState) return;
		titlebarToolbarDragState = dragState;
		window.addEventListener('pointermove', handleTitlebarToolbarWindowPointerMove);
		window.addEventListener('pointerup', handleTitlebarToolbarWindowPointerUp);
		window.addEventListener('pointercancel', handleTitlebarToolbarWindowPointerCancel);
	}

	function handleTitlebarToolbarWindowPointerMove(e: PointerEvent) {
		if (!titlebarToolbarDragState || e.pointerId !== titlebarToolbarDragState.pointerId) return;
		e.preventDefault();

		if (!titlebarToolbarDragState.isDragging) {
			if (Math.abs(e.clientY - titlebarToolbarDragState.startY) <= 4) return;
			titlebarToolbarDragState.isDragging = true;
			titlebarToolbarDraggingId = titlebarToolbarDragState.id;
		}

		const targetId = getToolbarDragTargetId(e, '[data-titlebar-toolbar-action-id]', 'data-titlebar-toolbar-action-id');
		if (!targetId || targetId === titlebarToolbarDragState.id) {
			titlebarToolbarDragOverId = null;
			titlebarToolbarDragState.lastTargetId = null;
			return;
		}

		titlebarToolbarDragOverId = targetId;
		if (targetId === titlebarToolbarDragState.lastTargetId) return;
		titlebarToolbarDragState.lastTargetId = targetId;
		settings.reorderTitlebarToolbarAction(titlebarToolbarDragState.id, targetId);
	}

	function clearTitlebarToolbarDragState() {
		titlebarToolbarDraggingId = null;
		titlebarToolbarDragOverId = null;
		titlebarToolbarDragState = null;
		window.removeEventListener('pointermove', handleTitlebarToolbarWindowPointerMove);
		window.removeEventListener('pointerup', handleTitlebarToolbarWindowPointerUp);
		window.removeEventListener('pointercancel', handleTitlebarToolbarWindowPointerCancel);
	}

	function handleTitlebarToolbarWindowPointerUp(e: PointerEvent) {
		if (!titlebarToolbarDragState || e.pointerId !== titlebarToolbarDragState.pointerId) return;
		if (titlebarToolbarDragState.isDragging) e.preventDefault();
		clearTitlebarToolbarDragState();
	}

	function handleTitlebarToolbarWindowPointerCancel(e: PointerEvent) {
		if (!titlebarToolbarDragState || e.pointerId !== titlebarToolbarDragState.pointerId) return;
		clearTitlebarToolbarDragState();
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
		const rect = settingsModal.getBoundingClientRect();
		const limits = getSettingsModalLimits();
		const width = clampNumber(rect.width, limits.minWidth, limits.maxWidth);
		const height = clampNumber(rect.height, limits.minHeight, limits.maxHeight);
		return {
			width,
			height,
			left: clampNumber(rect.left, 0, Math.max(0, limits.viewportWidth - width)),
			top: clampNumber(rect.top, 0, Math.max(0, limits.viewportHeight - height)),
		};
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
		window.addEventListener('pointermove', handleSettingsModalDragWindowPointerMove);
		window.addEventListener('pointerup', handleSettingsModalDragWindowPointerUp);
		window.addEventListener('pointercancel', handleSettingsModalDragWindowPointerCancel);
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

	function completeSettingsModalDrag(e?: PointerEvent) {
		if (!settingsModalDragStart) return;
		e?.preventDefault();
		e?.stopPropagation();
		settingsModalDragStart = null;
		settingsModalIsDragging = false;
		window.removeEventListener('pointermove', handleSettingsModalDragWindowPointerMove);
		window.removeEventListener('pointerup', handleSettingsModalDragWindowPointerUp);
		window.removeEventListener('pointercancel', handleSettingsModalDragWindowPointerCancel);
	}

	function handleSettingsModalDragWindowPointerUp(e: PointerEvent) {
		if (!settingsModalDragStart || e.pointerId !== settingsModalDragStart.pointerId) return;
		completeSettingsModalDrag(e);
	}

	function handleSettingsModalDragWindowPointerCancel(e: PointerEvent) {
		if (!settingsModalDragStart || e.pointerId !== settingsModalDragStart.pointerId) return;
		completeSettingsModalDrag(e);
	}

	function completeSettingsResize(e?: PointerEvent) {
		if (!settingsResizeStart) return;
		e?.preventDefault();
		e?.stopPropagation();
		settingsResizeStart = null;
		settingsModalIsResizing = false;
		window.removeEventListener('pointermove', handleSettingsResizeWindowPointerMove);
		window.removeEventListener('pointerup', handleSettingsResizeWindowPointerUp);
		window.removeEventListener('pointercancel', handleSettingsResizeWindowPointerCancel);
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
		window.addEventListener('pointermove', handleSettingsResizeWindowPointerMove);
		window.addEventListener('pointerup', handleSettingsResizeWindowPointerUp);
		window.addEventListener('pointercancel', handleSettingsResizeWindowPointerCancel);
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

	function handleSettingsResizeWindowPointerUp(e: PointerEvent) {
		if (!settingsResizeStart || e.pointerId !== settingsResizeStart.pointerId) return;
		completeSettingsResize(e);
	}

	function handleSettingsResizeWindowPointerCancel(e: PointerEvent) {
		if (!settingsResizeStart || e.pointerId !== settingsResizeStart.pointerId) return;
		completeSettingsResize(e);
	}

	async function loadVscodeThemes() {
		try {
			savedVscodeThemes = await invoke('get_saved_vscode_themes');
		} catch (e) {
			console.error('Failed to load vscode themes:', e);
		}
	}

	async function loadFonts() {
		if (loaded) return;
		try {
			const [fonts, os] = await Promise.all([
				invoke('get_system_fonts') as Promise<string[]>,
				invoke('get_os_type') as Promise<string>
			]);
			systemFonts = fonts;
			osType = os as OSType;
			loaded = true;
		} catch (e) {
			console.error('Failed to load system fonts:', e);
			systemFonts = ['Consolas', 'Courier New', 'Monaco', 'Menlo', 'Segoe UI'];
			try {
				osType = await invoke('get_os_type') as OSType;
			} catch (e2) {
				console.error('Failed to get OS type:', e2);
				osType = 'unknown';
			}
		}
	}

	// Guarded by a plain (non-reactive) flag rather than by `if (!appVersion)`.
	// The old form made the open-effect below *read* `appVersion` and the
	// resolved promise *write* it, so the whole effect re-ran once the version
	// arrived — and the re-run re-captured `previousActiveElement`, which by then
	// was a button inside the dialog. Closing settings then returned focus into
	// the dialog instead of to the control that opened it.
	let versionRequested = false;
	function ensureAppVersion() {
		if (versionRequested) return;
		versionRequested = true;
		getVersion()
			.then((v) => (appVersion = v))
			.catch(console.error);
	}

	$effect(() => {
		if (show) {
			loadFonts();
			ensureAppVersion();
			loadVscodeThemes();
			previousActiveElement = document.activeElement as HTMLElement;
			setTimeout(() => {
				const firstFocusable = settingsModal?.querySelector('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])') as HTMLElement | null;
				if (firstFocusable) {
					firstFocusable.focus();
				} else {
					settingsModal?.focus();
				}
			}, 50);
		} else if (previousActiveElement) {
			previousActiveElement.focus();
		}
	});

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
			const name = await invoke<string>('fetch_vscode_theme', { url: themeImportUrl });
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

	async function deleteTheme(name: string) {
		try {
			await invoke('delete_vscode_theme', { name });
			if (theme === `vscode:${name}`) onSetTheme?.('system');
			await loadVscodeThemes();
		} catch (e) {
			console.error('Failed to delete theme:', e);
		}
	}
</script>

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
							{#if appVersion}
								<span class="version-code">v{appVersion}</span>
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
									onclick={() => { settings.resetEditorFont(); settings.resetEditorMaxWidth(); }}>
									{t('settings.resetEditorSettings', settings.language)}
								</button>
							</div>

							<div class="setting-item" class:modified={modified.editorFont}>
								<label for="editor-font">{t('settings.font', settings.language)}</label>
								<div class="select-wrapper">
									<select id="editor-font" bind:value={settings.editorFont}>
										{#each systemFonts as font}
											<option value={font}>{font === defaultFonts.editorFont ? font + ' (' + t('settings.default', settings.language) + ')' : font}</option>
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

							<div class="setting-item" class:modified={modified.editorFontSize}>
								<label for="editor-font-size">{t('settings.fontSize', settings.language)}</label>
								<div class="slider-container">
									<div class="number-input-wrapper horizontal">
										<button class="spin-btn minus" onclick={() => stepSetting(settings.editorFontSize, -EDITOR_FONT_SIZE_RANGE.step, EDITOR_FONT_SIZE_RANGE, setEditorFontSize)} aria-label={t('common.decrease', settings.language)}>
											<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"
												><line x1="5" y1="12" x2="19" y2="12"></line></svg>
										</button>
										<input
											type="number"
											id="editor-font-size"
											min={EDITOR_FONT_SIZE_RANGE.min}
											max={EDITOR_FONT_SIZE_RANGE.max}
											step={EDITOR_FONT_SIZE_RANGE.step}
											value={settings.editorFontSize}
											oninput={(e) => handleNumberInput(e, EDITOR_FONT_SIZE_RANGE, setEditorFontSize)}
											onchange={(e) => commitNumberInput(e, EDITOR_FONT_SIZE_RANGE, setEditorFontSize)}
											onblur={(e) => commitNumberInput(e, EDITOR_FONT_SIZE_RANGE, setEditorFontSize)}
											onkeydown={(e) => handleNumberKeydown(e, EDITOR_FONT_SIZE_RANGE, setEditorFontSize)}
											class="number-input"
										/>
										<button class="spin-btn plus" onclick={() => stepSetting(settings.editorFontSize, EDITOR_FONT_SIZE_RANGE.step, EDITOR_FONT_SIZE_RANGE, setEditorFontSize)} aria-label={t('common.increase', settings.language)}>
											<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"
												><line x1="12" y1="5" x2="12" y2="19"></line><line x1="5" y1="12" x2="19" y2="12"></line></svg>
										</button>
									</div>
									<span class="unit-label">px</span>
								</div>
							</div>

<div class="setting-item">
								<label for="editor-word-wrap">{t('settings.wordWrap', settings.language)}</label>
								<div class="select-wrapper">
									<select id="editor-word-wrap" bind:value={settings.wordWrap}>
										<option value="off">{t('menu.wordWrapOff', settings.language)}</option>
										<option value="on">{t('menu.wordWrapOn', settings.language)}</option>
										<option value="wordWrapColumn">{t('menu.wordWrapColumn', settings.language)}</option>
									</select>
									<svg class="select-arrow" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"></polyline></svg>
								</div>
							</div>

							<div class="setting-item" class:modified={modified.editorMaxWidth} class:inactive={settings.wordWrap !== 'wordWrapColumn'}>
								<label for="editor-max-width">{t('settings.wrapColumn', settings.language)}</label>
								<div class="slider-container">
									<div class="number-input-wrapper horizontal">
										<button class="spin-btn minus" disabled={settings.wordWrap !== 'wordWrapColumn'} onclick={() => stepSetting(settings.editorMaxWidth, -EDITOR_MAX_WIDTH_RANGE.step, EDITOR_MAX_WIDTH_RANGE, setEditorMaxWidth)} aria-label={t('common.decrease', settings.language)}>
											<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"
												><line x1="5" y1="12" x2="19" y2="12"></line></svg>
										</button>
										<input
											type="number"
											id="editor-max-width"
											min={EDITOR_MAX_WIDTH_RANGE.min}
											max={EDITOR_MAX_WIDTH_RANGE.max}
											step={EDITOR_MAX_WIDTH_RANGE.step}
											value={settings.editorMaxWidth}
											oninput={(e) => handleNumberInput(e, EDITOR_MAX_WIDTH_RANGE, setEditorMaxWidth)}
											onchange={(e) => commitNumberInput(e, EDITOR_MAX_WIDTH_RANGE, setEditorMaxWidth)}
											onblur={(e) => commitNumberInput(e, EDITOR_MAX_WIDTH_RANGE, setEditorMaxWidth)}
											onkeydown={(e) => handleNumberKeydown(e, EDITOR_MAX_WIDTH_RANGE, setEditorMaxWidth)}
											class="number-input"
											disabled={settings.wordWrap !== 'wordWrapColumn'}
										/>
										<button class="spin-btn plus" disabled={settings.wordWrap !== 'wordWrapColumn'} onclick={() => stepSetting(settings.editorMaxWidth, EDITOR_MAX_WIDTH_RANGE.step, EDITOR_MAX_WIDTH_RANGE, setEditorMaxWidth)} aria-label={t('common.increase', settings.language)}>
											<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"
												><line x1="12" y1="5" x2="12" y2="19"></line><line x1="5" y1="12" x2="19" y2="12"></line></svg>
										</button>
									</div>
									<span class="unit-label">chars</span>
								</div>
							</div>

							
							<div class="setting-item">
								<label for="editor-line-numbers">{t('settings.lineNumbers', settings.language)}</label>
								<label class="toggle">
									<input id="editor-line-numbers" type="checkbox" checked={settings.lineNumbers === 'on'} onchange={() => settings.toggleLineNumbers()} />
									<span class="toggle-slider"></span>
								</label>
							</div>

							<div class="setting-item">
								<label for="editor-minimap">{t('settings.minimap', settings.language)}</label>
								<label class="toggle">
									<input id="editor-minimap" type="checkbox" checked={settings.minimap} onchange={() => settings.toggleMinimap()} />
									<span class="toggle-slider"></span>
								</label>
							</div>

							<div class="setting-item">
								<label for="editor-vim-mode">{t('settings.vimMode', settings.language)}</label>
								<label class="toggle">
									<input id="editor-vim-mode" type="checkbox" checked={settings.vimMode} onchange={() => settings.toggleVimMode()} />
									<span class="toggle-slider"></span>
								</label>
							</div>

							<div class="setting-item">
								<label for="editor-status-bar">{t('settings.statusBar', settings.language)}</label>
								<label class="toggle">
									<input id="editor-status-bar" type="checkbox" checked={settings.statusBar} onchange={() => settings.toggleStatusBar()} />
									<span class="toggle-slider"></span>
								</label>
							</div>

							<div class="setting-item">
								<label for="editor-show-toolbar">{t('settings.showEditorToolbar', settings.language)}</label>
								<label class="toggle">
									<input id="editor-show-toolbar" type="checkbox" checked={settings.showEditorToolbar} onchange={() => settings.toggleEditorToolbar()} />
									<span class="toggle-slider"></span>
								</label>
							</div>

							<div class="setting-item" class:inactive={!settings.statusBar}>
								<label for="editor-word-count">{t('settings.wordCount', settings.language)}</label>
								<label class="toggle">
									<input id="editor-word-count" type="checkbox" checked={settings.wordCount} disabled={!settings.statusBar} onchange={() => settings.toggleWordCount()} />
									<span class="toggle-slider"></span>
								</label>
							</div>

							<div class="setting-item">
								<label for="editor-show-whitespace">{t('settings.showWhitespace', settings.language)}</label>
								<label class="toggle">
									<input id="editor-show-whitespace" type="checkbox" checked={settings.showWhitespace} onchange={() => settings.toggleShowWhitespace()} />
									<span class="toggle-slider"></span>
								</label>
							</div>

						<div class="setting-item">
							<label for="editor-sticky-scroll">{t('settings.stickyScroll', settings.language)}</label>
							<label class="toggle">
								<input id="editor-sticky-scroll" type="checkbox" checked={settings.stickyScroll} onchange={() => settings.toggleStickyScroll()} />
								<span class="toggle-slider"></span>
							</label>
						</div>

						<div class="setting-item">
							<label for="editor-line-highlight">{t('settings.lineHighlight', settings.language)}</label>
							<label class="toggle">
								<input id="editor-line-highlight" type="checkbox" checked={settings.renderLineHighlight === 'line'} onchange={() => settings.toggleLineHighlight()} />
								<span class="toggle-slider"></span>
							</label>
						</div>

						<div class="setting-item">
							<label for="image-directory">{t('settings.imageDirectory', settings.language)}</label>
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

						{#if settings.osType === 'macos'}
							<div class="setting-item">
								<label for="macos-image-scaling">{t('settings.scaleMacOSScreenshots', settings.language)}</label>
								<label class="toggle">
									<input id="macos-image-scaling" type="checkbox" checked={settings.macosImageScaling} onchange={() => settings.toggleMacosImageScaling()} />
									<span class="toggle-slider"></span>
								</label>
								<span class="slider-value">{t('settings.reduceSizeBy50', settings.language)}</span>
							</div>
						{/if}
					</div>
					{:else if activeCategory === 'preview'}
						<div class="settings-group">
							<div class="settings-group-header">
								<h2>{t('settings.previewSettings', settings.language)}</h2>
								<button
									class="reset-text-btn"
									class:disabled={!previewSettingsModified}
									onclick={() => {
										settings.resetPreviewFont();
										settings.resetPreviewMaxWidth();
									}}>
									{t('settings.resetPreviewSettings', settings.language)}
								</button>
							</div>

							<div class="setting-item" class:modified={modified.previewMaxWidth}>
								<label for="preview-max-width">{t('settings.previewMaxWidth', settings.language)}</label>
								<div class="slider-container">
									<div class="number-input-wrapper horizontal">
										<button class="spin-btn minus" onclick={() => updatePreviewMaxWidth(settings.previewMaxWidth - 40)} aria-label={t('common.decrease', settings.language)}>
											<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"
												><line x1="5" y1="12" x2="19" y2="12"></line></svg>
										</button>
										<input
											type="number"
											id="preview-max-width"
											min={MIN_PREVIEW_MAX_WIDTH}
											max={MAX_PREVIEW_MAX_WIDTH}
											step="40"
											bind:value={settings.previewMaxWidth}
											onchange={() => updatePreviewMaxWidth(settings.previewMaxWidth)}
											class="number-input"
										/>
										<button class="spin-btn plus" onclick={() => updatePreviewMaxWidth(settings.previewMaxWidth + 40)} aria-label={t('common.increase', settings.language)}>
											<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"
												><line x1="12" y1="5" x2="12" y2="19"></line><line x1="5" y1="12" x2="19" y2="12"></line></svg>
										</button>
									</div>
									<span class="unit-label">px</span>
								</div>
							</div>

							<div class="setting-item" class:modified={modified.previewFont}>
								<label for="preview-font">{t('settings.previewBodyFont', settings.language)}</label>
								<div class="select-wrapper">
									<select id="preview-font" bind:value={settings.previewFont}>
										{#each systemFonts as font}
											<option value={font}>{font === defaultFonts.previewFont ? font + ' (' + t('settings.default', settings.language) + ')' : font}</option>
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

							<div class="setting-item" class:modified={modified.previewFontSize}>
								<label for="preview-font-size">{t('settings.previewBodyFontSize', settings.language)}</label>
								<div class="slider-container">
									<div class="number-input-wrapper horizontal">
										<button class="spin-btn minus" onclick={() => stepSetting(settings.previewFontSize, -PREVIEW_FONT_SIZE_RANGE.step, PREVIEW_FONT_SIZE_RANGE, setPreviewFontSize)} aria-label={t('common.decrease', settings.language)}>
											<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"
												><line x1="5" y1="12" x2="19" y2="12"></line></svg>
										</button>
										<input
											type="number"
											id="preview-font-size"
											min={PREVIEW_FONT_SIZE_RANGE.min}
											max={PREVIEW_FONT_SIZE_RANGE.max}
											step={PREVIEW_FONT_SIZE_RANGE.step}
											value={settings.previewFontSize}
											oninput={(e) => handleNumberInput(e, PREVIEW_FONT_SIZE_RANGE, setPreviewFontSize)}
											onchange={(e) => commitNumberInput(e, PREVIEW_FONT_SIZE_RANGE, setPreviewFontSize)}
											onblur={(e) => commitNumberInput(e, PREVIEW_FONT_SIZE_RANGE, setPreviewFontSize)}
											onkeydown={(e) => handleNumberKeydown(e, PREVIEW_FONT_SIZE_RANGE, setPreviewFontSize)}
											class="number-input"
										/>
										<button class="spin-btn plus" onclick={() => stepSetting(settings.previewFontSize, PREVIEW_FONT_SIZE_RANGE.step, PREVIEW_FONT_SIZE_RANGE, setPreviewFontSize)} aria-label={t('common.increase', settings.language)}>
											<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"
												><line x1="12" y1="5" x2="12" y2="19"></line><line x1="5" y1="12" x2="19" y2="12"></line></svg>
										</button>
									</div>
									<span class="unit-label">px</span>
								</div>
							</div>

							<div class="setting-item" class:modified={modified.codeFont}>
								<label for="code-font">{t('settings.previewCodeFont', settings.language)}</label>
								<div class="select-wrapper">
									<select id="code-font" bind:value={settings.codeFont}>
										{#each systemFonts as font}
											<option value={font}>{font === defaultFonts.codeFont ? font + ' (' + t('settings.default', settings.language) + ')' : font}</option>
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

							<div class="setting-item" class:modified={modified.codeFontSize}>
								<label for="code-font-size">{t('settings.previewCodeFontSize', settings.language)}</label>
								<div class="slider-container">
									<div class="number-input-wrapper horizontal">
										<button class="spin-btn minus" onclick={() => stepSetting(settings.codeFontSize, -CODE_FONT_SIZE_RANGE.step, CODE_FONT_SIZE_RANGE, setCodeFontSize)} aria-label={t('common.decrease', settings.language)}>
											<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"
												><line x1="5" y1="12" x2="19" y2="12"></line></svg>
										</button>
										<input
											type="number"
											id="code-font-size"
											min={CODE_FONT_SIZE_RANGE.min}
											max={CODE_FONT_SIZE_RANGE.max}
											step={CODE_FONT_SIZE_RANGE.step}
											value={settings.codeFontSize}
											oninput={(e) => handleNumberInput(e, CODE_FONT_SIZE_RANGE, setCodeFontSize)}
											onchange={(e) => commitNumberInput(e, CODE_FONT_SIZE_RANGE, setCodeFontSize)}
											onblur={(e) => commitNumberInput(e, CODE_FONT_SIZE_RANGE, setCodeFontSize)}
											onkeydown={(e) => handleNumberKeydown(e, CODE_FONT_SIZE_RANGE, setCodeFontSize)}
											class="number-input"
										/>
										<button class="spin-btn plus" onclick={() => stepSetting(settings.codeFontSize, CODE_FONT_SIZE_RANGE.step, CODE_FONT_SIZE_RANGE, setCodeFontSize)} aria-label={t('common.increase', settings.language)}>
											<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"
												><line x1="12" y1="5" x2="12" y2="19"></line><line x1="5" y1="12" x2="19" y2="12"></line></svg>
										</button>
									</div>
									<span class="unit-label">px</span>
								</div>
							</div>
						</div>
					{:else if activeCategory === 'appearance'}
						<div class="settings-group">
						<h2>{t('settings.appearanceSettings', settings.language)}</h2>

						<div class="setting-item">
							<label for="appearance-language">{t('settings.language', settings.language)}</label>
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

						<div class="setting-item">
							<label for="appearance-theme">{t('settings.theme', settings.language)}</label>
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

						<div class="setting-block">
							<div class="setting-block-row">
								<label for="theme-import">{t('settings.importVSCodeTheme', settings.language)}</label>
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

							<div class="setting-item">
								<label for="appearance-tabs">{t('settings.showTabs', settings.language)}</label>
								<label class="toggle">
									<input id="appearance-tabs" type="checkbox" checked={settings.showTabs} onchange={() => settings.toggleTabs()} />
									<span class="toggle-slider"></span>
								</label>
							</div>

							<div class="setting-item" class:inactive={!settings.showTabs}>
								<label for="appearance-duplicate-name-folder">{t('settings.showFolderForDuplicateNames', settings.language)}</label>
								<label class="toggle">
									<input id="appearance-duplicate-name-folder" type="checkbox" disabled={!settings.showTabs} checked={settings.showFolderForDuplicateNames} onchange={() => settings.toggleShowFolderForDuplicateNames()} />
									<span class="toggle-slider"></span>
								</label>
							</div>

							<div class="setting-item">
								<label for="appearance-restore-state">{t('settings.restoreStateOnReopen', settings.language)}</label>
								<label class="toggle">
									<input id="appearance-restore-state" type="checkbox" checked={settings.restoreStateOnReopen} onchange={() => settings.toggleRestoreStateOnReopen()} />
									<span class="toggle-slider"></span>
								</label>
							</div>

							<div class="setting-item">
								<label for="appearance-open-file-mode">{t('settings.openFileMode', settings.language)}</label>
								<div class="select-wrapper">
									<select id="appearance-open-file-mode" bind:value={settings.openFileMode}>
										<option value="preview">{t('settings.preview', settings.language)}</option>
										<option value="editor">{t('settings.editor', settings.language)}</option>
										<option value="split">{t('menu.splitView', settings.language)}</option>
									</select>
									<svg class="select-arrow" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"></polyline></svg>
								</div>
							</div>
							<div class="setting-item">
								<label for="appearance-new-file-mode">{t('settings.newFileDefaultMode', settings.language)}</label>
								<label class="toggle">
									<input id="appearance-new-file-mode" type="checkbox" checked={settings.newFileDefaultMode} onchange={() => settings.toggleNewFileDefaultMode()} />
									<span class="toggle-slider"></span>
								</label>
							</div>
							<div class="setting-item">
								<label for="appearance-recent-files">{t('settings.showRecentFiles', settings.language)}</label>
								<label class="toggle">
									<input id="appearance-recent-files" type="checkbox" checked={settings.showRecentFiles} onchange={() => settings.toggleShowRecentFiles()} />
									<span class="toggle-slider"></span>
								</label>
							</div>
							<div class="setting-item">
							<label for="appearance-toc">{t('settings.showTableOfContents', settings.language)}</label>
							<label class="toggle">
								<input id="appearance-toc" type="checkbox" checked={settings.showToc} onchange={() => settings.toggleToc()} />
								<span class="toggle-slider"></span>
							</label>
						</div>

						<div class="setting-item">
							<label for="appearance-animate-jump">{t('settings.animateJumpScroll', settings.language)}</label>
							<label class="toggle">
								<input id="appearance-animate-jump" type="checkbox" checked={settings.animateJumpScroll} onchange={() => settings.toggleAnimateJumpScroll()} />
								<span class="toggle-slider"></span>
							</label>
						</div>

						<div class="setting-item">
							<label for="appearance-animate-cursor">{t('settings.animateCursor', settings.language)}</label>
							<label class="toggle">
								<input id="appearance-animate-cursor" type="checkbox" checked={settings.animateCursor} onchange={() => settings.toggleAnimateCursor()} />
								<span class="toggle-slider"></span>
							</label>
						</div>

						<div class="setting-item">
							<label for="appearance-links-new-tab">{t('settings.linksOpenInNewTab', settings.language)}</label>
							<label class="toggle">
								<input id="appearance-links-new-tab" type="checkbox" checked={settings.linksOpenInNewTab} onchange={() => settings.toggleLinksOpenInNewTab()} />
								<span class="toggle-slider"></span>
							</label>
						</div>

						<div class="setting-item">
							<label for="appearance-highlight-color">{t('settings.highlightColor', settings.language)}</label>
							<div class="custom-dropdown-wrapper">
								<button 
									class="custom-dropdown-btn" 
									onclick={(e) => { e.stopPropagation(); highlightMenuOpen = !highlightMenuOpen; }}>
										<div style="display: flex; align-items: center; gap: 8px;">
										<div class="color-circle" style="background-color: {highlightColors.find(c => c.value === settings.highlightColor)?.color || 'var(--color-accent-fg)'}"></div>
										<span>{t(`colors.${settings.highlightColor || 'default'}`, settings.language)}</span>
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

					<div class="setting-item">
						<label for="appearance-zen-mode">{t('settings.zenMode', settings.language)}</label>
						<label class="toggle">
							<input id="appearance-zen-mode" type="checkbox" checked={settings.zenMode} onchange={() => settings.toggleZenMode()} />
							<span class="toggle-slider"></span>
						</label>
					</div>
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
										class:drag-source={titlebarToolbarDraggingId === action.id}
										class:drag-over={titlebarToolbarDragOverId === action.id}
										role="listitem"
										data-titlebar-toolbar-action-id={action.id}>
										<button
											type="button"
											class="toolbar-drag-handle"
											aria-label={`${t('settings.move', settings.language)}: ${actionName}`}
											onpointerdown={(e) => handleTitlebarToolbarDragPointerDown(e, action.id)}>
											<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
												<circle cx="9" cy="5" r="1" fill="currentColor"/>
												<circle cx="9" cy="12" r="1" fill="currentColor"/>
												<circle cx="9" cy="19" r="1" fill="currentColor"/>
												<circle cx="15" cy="5" r="1" fill="currentColor"/>
												<circle cx="15" cy="12" r="1" fill="currentColor"/>
												<circle cx="15" cy="19" r="1" fill="currentColor"/>
											</svg>
										</button>
										<label class="toggle">
											<input
												id={`titlebar-toolbar-action-${action.id}`}
												type="checkbox"
												checked={isTitlebarToolbarActionVisible(action.id)}
												disabled={action.required}
												onchange={(e) => settings.setTitlebarToolbarActionVisible(action.id, e.currentTarget.checked)}
											/>
											<span class="toggle-slider"></span>
										</label>
										<span class="toolbar-tool-name">{actionName}</span>
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
									<div
										class="toolbar-tool-row"
										class:drag-source={editorToolbarDraggingId === tool.id}
										class:drag-over={editorToolbarDragOverId === tool.id}
										role="listitem"
										data-editor-toolbar-tool-id={tool.id}>
										<button
											type="button"
											class="toolbar-drag-handle"
											aria-label={`${t('settings.move', settings.language)}: ${tool.name}`}
											onpointerdown={(e) => handleEditorToolbarDragPointerDown(e, tool.id)}>
											<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
												<circle cx="9" cy="5" r="1" fill="currentColor"/>
												<circle cx="9" cy="12" r="1" fill="currentColor"/>
												<circle cx="9" cy="19" r="1" fill="currentColor"/>
												<circle cx="15" cy="5" r="1" fill="currentColor"/>
												<circle cx="15" cy="12" r="1" fill="currentColor"/>
												<circle cx="15" cy="19" r="1" fill="currentColor"/>
											</svg>
										</button>
										<label class="toggle">
											<input
												id={`editor-toolbar-tool-${tool.id}`}
												type="checkbox"
												checked={isEditorToolbarToolVisible(tool.id)}
												onchange={(e) => settings.setEditorToolbarToolVisible(tool.id, e.currentTarget.checked)}
											/>
											<span class="toggle-slider"></span>
										</label>
										<span class="toolbar-tool-name">{tool.name}</span>
										<div class="toolbar-order-controls">
											<button
												type="button"
												disabled={index === 0}
												aria-label={`${t('settings.moveUp', settings.language)}: ${tool.name}`}
												onclick={() => settings.moveEditorToolbarTool(tool.id, 'up')}>
												<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="18 15 12 9 6 15"></polyline></svg>
											</button>
											<button
												type="button"
												disabled={index === editorToolbarSettingsTools.length - 1}
												aria-label={`${t('settings.moveDown', settings.language)}: ${tool.name}`}
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

						<div class="setting-item">
							<label for="files-auto-save">{t('settings.autoSave', settings.language)}</label>
							<label class="toggle">
								<input id="files-auto-save" type="checkbox" checked={settings.autoSave} onchange={() => settings.toggleAutoSave()} />
								<span class="toggle-slider"></span>
							</label>
						</div>
					</div>
					{:else if activeCategory === 'shortcuts'}
					<!--
						Read-only, on purpose. Remapping needs conflict detection,
						persistence, reset-to-default and chord capture inside a webview, and
						it is a product-direction call; this pane is the part of the value
						that needs none of them.

						Every chord below comes from `shortcuts.ts`, and
						`scripts/shortcutRegistry.test.ts` fires each one at the real
						handlers — so this list cannot drift away from what the keys do.
					-->
					{#each shortcutSections(platformOf(settings.osType)) as section (section.group)}
						<div class="settings-group shortcut-group">
							<div class="settings-group-header">
								<h2>{t(section.labelKey, settings.language)}</h2>
							</div>

							{#each section.entries as entry (entry.id)}
								<div class="shortcut-row">
									<span class="shortcut-name">{t(entry.labelKey, settings.language)}</span>
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
	 * Not every row in this modal is a label-and-control row.
	 *
	 * The VS Code theme block is two stacked lines (a caption with a "Browse
	 * themes" link, then a URL field with an Import button); the delete-theme
	 * action is a single right-aligned link. Both used to be spelled as
	 * `.setting-item` with inline `flex-direction: column` — they wanted the
	 * row's border and rhythm, not its columns. That worked only because
	 * `.setting-item` was `justify-content: space-between` and sized nothing;
	 * once it grew a label column, the inline override left the theme <select>
	 * as the only child of an unclassed div nobody styled, and `.select-wrapper`
	 * — sized with `flex: 0 1 220px` — read that basis down the COLUMN axis and
	 * rendered 220px tall and 79px too narrow, with the dropdown stranded below
	 * a 191px hole.
	 *
	 * So a composite block says so, and keeps only the rhythm. `.setting-item`
	 * is now exactly one thing: a leading label plus controls that are its own
	 * direct children. The row-structure guards at the end of
	 * settingsPersistence.test.ts hold it to that.
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
		grid-template-columns: 20px 40px minmax(0, 1fr) auto;
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
		grid-template-columns: 20px 40px minmax(0, 1fr) auto auto;
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
