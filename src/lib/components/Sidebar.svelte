<script lang="ts">
	import { tabManager } from '../stores/tabs.svelte.js';
	import { settings, SIDEBAR_SPLIT_RANGE, TAB_COLUMN_WIDTH_RANGE } from '../stores/settings.svelte.js';
	import { folderManager, type FolderEntry } from '../stores/folder.svelte.js';
	import { t } from '../utils/i18n.js';
	import TabList from './TabList.svelte';
	import FolderTree from './FolderTree.svelte';

	/**
	 * The side column: the open documents (#884), the open folder, or both
	 * stacked with a draggable divider between them. Which section is upper is
	 * `settings.sidebarStackOrder`; how much of the column it takes is
	 * `settings.sidebarSplit`. Either section can be collapsed to its header,
	 * and the other then fills the column.
	 */
	let {
		side,
		showOpenFiles,
		showFolder,
		showHome = false,
		ontabclick,
		oncloseTab,
		onopenEntry,
	} = $props<{
		side: 'left' | 'right';
		showOpenFiles: boolean;
		showFolder: boolean;
		showHome?: boolean;
		ontabclick?: () => void;
		oncloseTab?: (id: string) => void;
		onopenEntry: (entry: FolderEntry, openable: boolean) => void;
	}>();

	let openFilesCollapsed = $state(false);
	let folderCollapsed = $state(false);
	let isResizing = $state(false);
	let stackEl = $state<HTMLElement | null>(null);

	const sections = $derived(
		(settings.sidebarStackOrder === 'folderTop' ? ['folder', 'openFiles'] : ['openFiles', 'folder']).filter((s) =>
			s === 'folder' ? showFolder : showOpenFiles,
		) as ('folder' | 'openFiles')[],
	);
	const isCollapsed = (s: 'folder' | 'openFiles') => (s === 'folder' ? folderCollapsed : openFilesCollapsed);
	// The split applies only while two sections are open; otherwise the open one fills the column.
	const split = $derived(sections.length === 2 && !isCollapsed(sections[0]) && !isCollapsed(sections[1]));

	function sectionFlex(section: 'folder' | 'openFiles', index: number): string {
		if (isCollapsed(section)) return '0 0 auto';
		if (!split) return '1 1 0';
		return index === 0 ? `0 0 ${settings.sidebarSplit}%` : '1 1 0';
	}

	function toggleSection(section: 'folder' | 'openFiles') {
		if (section === 'folder') folderCollapsed = !folderCollapsed;
		else openFilesCollapsed = !openFilesCollapsed;
	}

	function drag(e: PointerEvent, onMove: (moveEvent: PointerEvent) => void, cursor: string) {
		e.preventDefault();
		const target = e.currentTarget as HTMLElement;
		target.setPointerCapture?.(e.pointerId);
		isResizing = true;
		document.body.style.cursor = cursor;
		document.body.style.userSelect = 'none';
		const onUp = (upEvent: PointerEvent) => {
			window.removeEventListener('pointermove', onMove);
			window.removeEventListener('pointerup', onUp);
			window.removeEventListener('pointercancel', onUp);
			try {
				target.releasePointerCapture?.(upEvent.pointerId);
			} catch {
				// Pointer capture may already be gone after a cancel path.
			}
			document.body.style.cursor = '';
			document.body.style.userSelect = '';
			isResizing = false;
		};
		window.addEventListener('pointermove', onMove);
		window.addEventListener('pointerup', onUp);
		window.addEventListener('pointercancel', onUp);
	}

	function startWidthResize(e: PointerEvent) {
		const startX = e.clientX;
		const startWidth = settings.tabColumnWidth;
		const resizeSide = side;
		drag(
			e,
			(moveEvent) => {
				const deltaX = moveEvent.clientX - startX;
				settings.setTabColumnWidth(startWidth + (resizeSide === 'left' ? deltaX : -deltaX));
			},
			'col-resize',
		);
	}

	function startSplitResize(e: PointerEvent) {
		const box = stackEl?.getBoundingClientRect();
		if (!box || box.height === 0) return;
		drag(e, (moveEvent) => settings.setSidebarSplit(((moveEvent.clientY - box.top) / box.height) * 100), 'row-resize');
	}

	// Same keys as the outline's resize handle in MarkdownViewer.svelte.
	function handleWidthKeyDown(e: KeyboardEvent) {
		const step = e.key === 'ArrowRight' ? 16 : e.key === 'ArrowLeft' ? -16 : 0;
		if (step !== 0) settings.setTabColumnWidth(settings.tabColumnWidth + (side === 'left' ? step : -step));
		else if (e.key === 'Home') settings.setTabColumnWidth(TAB_COLUMN_WIDTH_RANGE.min);
		else if (e.key === 'End') settings.setTabColumnWidth(TAB_COLUMN_WIDTH_RANGE.max);
		else return;
		e.preventDefault();
	}

	function handleSplitKeyDown(e: KeyboardEvent) {
		const step = e.key === 'ArrowDown' ? 5 : e.key === 'ArrowUp' ? -5 : 0;
		if (step === 0) return;
		e.preventDefault();
		settings.setSidebarSplit(settings.sidebarSplit + step);
	}
</script>

<aside
	class="sidebar on-{side}"
	class:tagged={tabManager.windowTag !== null}
	class:resizing={isResizing}
	style:width="{settings.tabColumnWidth}px"
	style:--tag-color={tabManager.windowTag?.color}>
	<div class="sidebar-stack" bind:this={stackEl}>
		{#each sections as section, index (section)}
			{#if index === 1 && split}
				<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
				<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
				<div
					class="split-handle"
					role="separator"
					aria-label={t('folder.resizeSplit', settings.language)}
					aria-orientation="horizontal"
					aria-valuemin={SIDEBAR_SPLIT_RANGE.min}
					aria-valuemax={SIDEBAR_SPLIT_RANGE.max}
					aria-valuenow={settings.sidebarSplit}
					tabindex="0"
					onpointerdown={startSplitResize}
					onkeydown={handleSplitKeyDown}></div>
			{/if}
			<section class="sidebar-section" style:flex={sectionFlex(section, index)}>
				<header class="section-header">
					<button class="section-toggle" aria-expanded={!isCollapsed(section)} onclick={() => toggleSection(section)}>
						<svg class="chevron" class:open={!isCollapsed(section)} width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 6 15 12 9 18"></polyline></svg>
						<span class="section-title" title={section === 'folder' ? (folderManager.root ?? '') : ''}>
							{section === 'folder' ? folderManager.rootName : t('folder.openFiles', settings.language)}
						</span>
					</button>
					{#if section === 'folder'}
						<button class="section-action" title={t('folder.refresh', settings.language)} aria-label={t('folder.refresh', settings.language)} onclick={() => folderManager.refresh()}>
							<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-3-6.7L21 8"></path><path d="M21 3v5h-5"></path></svg>
						</button>
						<button class="section-action" title={t('folder.closeFolder', settings.language)} aria-label={t('folder.closeFolder', settings.language)} onclick={() => folderManager.close()}>
							<svg width="12" height="12" viewBox="0 0 12 12"><path fill="currentColor" d="M11 1.7L10.3 1 6 5.3 1.7 1 1 1.7 5.3 6 1 10.3 1.7 11 6 6.7 10.3 11 11 10.3 6.7 6z" /></svg>
						</button>
					{/if}
				</header>
				{#if !isCollapsed(section)}
					<div class="section-body">
						{#if section === 'folder'}
							<FolderTree onopen={onopenEntry} />
						{:else}
							<TabList orientation="vertical" onnewTab={() => tabManager.addNewTab()} {showHome} {ontabclick} {oncloseTab} />
						{/if}
					</div>
				{/if}
			</section>
		{/each}
	</div>
	<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
	<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
	<div
		class="width-handle"
		role="separator"
		aria-label={t('tabs.resizeColumn', settings.language)}
		aria-orientation="vertical"
		aria-valuemin={TAB_COLUMN_WIDTH_RANGE.min}
		aria-valuemax={TAB_COLUMN_WIDTH_RANGE.max}
		aria-valuenow={settings.tabColumnWidth}
		tabindex="0"
		onpointerdown={startWidthResize}
		onkeydown={handleWidthKeyDown}></div>
</aside>

<style>
	.sidebar {
		position: fixed;
		top: 36px;
		bottom: 0;
		z-index: 900;
		display: flex;
		box-sizing: border-box;
		background: var(--color-canvas-default);
		font-family: var(--win-font, 'Segoe UI', sans-serif);
	}

	.sidebar.on-left {
		left: 0;
		border-right: 1px solid var(--color-border-muted);
	}

	.sidebar.on-right {
		right: 0;
		border-left: 1px solid var(--color-border-muted);
	}

	/* The window tag, drawn once along the column's inner edge: the vertical
	   counterpart of the line under the strip in TitleBar.svelte. */
	.sidebar.tagged::after {
		content: '';
		position: absolute;
		top: 0;
		bottom: 0;
		width: 2px;
		background: var(--tag-color);
		pointer-events: none;
	}

	.sidebar.tagged.on-left::after {
		right: -1px;
	}

	.sidebar.tagged.on-right::after {
		left: -1px;
	}

	.sidebar-stack {
		display: flex;
		flex-direction: column;
		flex: 1;
		min-width: 0;
		min-height: 0;
	}

	.sidebar-section {
		display: flex;
		flex-direction: column;
		min-height: 0;
		overflow: hidden;
	}

	.section-header {
		display: flex;
		align-items: center;
		gap: 2px;
		height: 26px;
		flex-shrink: 0;
		padding: 0 4px;
		font-size: 11px;
		font-weight: 600;
		letter-spacing: 0.04em;
		text-transform: uppercase;
		color: var(--color-fg-muted);
	}

	.section-toggle {
		appearance: none;
		display: flex;
		align-items: center;
		gap: 4px;
		flex: 1;
		min-width: 0;
		height: 22px;
		padding: 0 4px;
		border: none;
		border-radius: 6px;
		background: transparent;
		color: inherit;
		font: inherit;
		letter-spacing: inherit;
		text-transform: inherit;
		cursor: pointer;
	}

	.section-title {
		overflow: hidden;
		white-space: nowrap;
		text-overflow: ellipsis;
	}

	.chevron {
		flex-shrink: 0;
		transition: transform 0.1s;
	}

	.chevron.open {
		transform: rotate(90deg);
	}

	.section-action {
		appearance: none;
		display: flex;
		align-items: center;
		justify-content: center;
		width: 22px;
		height: 22px;
		flex-shrink: 0;
		border: none;
		border-radius: 6px;
		background: transparent;
		color: inherit;
		cursor: pointer;
	}

	.section-toggle:hover,
	.section-action:hover {
		background: var(--color-neutral-muted);
		color: var(--color-fg-default);
	}

	.section-body {
		flex: 1;
		min-height: 0;
		overflow-y: auto;
		overflow-x: hidden;
	}

	.split-handle {
		flex: 0 0 5px;
		margin: -2px 0;
		position: relative;
		z-index: 1;
		cursor: row-resize;
		border-top: 1px solid var(--color-border-muted);
	}

	.width-handle {
		position: absolute;
		top: 0;
		bottom: 0;
		width: 6px;
		cursor: col-resize;
		z-index: 1;
	}

	.on-left .width-handle {
		right: -3px;
	}

	.on-right .width-handle {
		left: -3px;
	}

	.split-handle:hover,
	.width-handle:hover,
	.split-handle:focus-visible,
	.width-handle:focus-visible,
	.sidebar.resizing .split-handle,
	.sidebar.resizing .width-handle {
		background: color-mix(in srgb, var(--color-accent-fg) 35%, transparent);
	}
</style>
