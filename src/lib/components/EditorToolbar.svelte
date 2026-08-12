<script lang="ts">
	import { onMount } from 'svelte';
	import { fly } from 'svelte/transition';
	import { getVisibleEditorToolbarTools, type EditorToolbarTool } from '../utils/editorToolbar.js';

	let {
		modifier = 'Ctrl',
		toolbarOrder = [],
		toolbarHidden = [],
		onaction,
		ontoggleHide,
		onshowTooltip,
		onhideTooltip,
	} = $props<{
		modifier?: 'Ctrl' | 'Cmd';
		toolbarOrder?: string[];
		toolbarHidden?: string[];
		onaction: (actionId: string, payload?: any) => void;
		ontoggleHide?: () => void;
		onshowTooltip?: (e: MouseEvent, text: string, shortcut?: string, align?: string) => void;
		onhideTooltip?: () => void;
	}>();

	let containerEl = $state<HTMLDivElement>();
	let containerWidth = $state(800);
	let overflowMenuOpen = $state(false);
	let tablePickerOpen = $state(false);

	let hoverRows = $state(0);
	let hoverCols = $state(0);

	const MAX_ROWS = 10;
	const MAX_COLS = 10;

	const allTools = $derived.by(() => getVisibleEditorToolbarTools(toolbarOrder, toolbarHidden));

	const visibleCount = $derived.by(() => {
		const neededForTotal = allTools.length * 30 + 44;
		if (containerWidth >= neededForTotal) {
			return allTools.length;
		}
		const count = Math.floor((containerWidth - 75) / 30);
		return Math.max(1, count);
	});

	const visibleTools = $derived(allTools.slice(0, visibleCount));
	const overflowTools = $derived(allTools.slice(visibleCount));

	$effect(() => {
		if (!containerEl) return;
		const observer = new ResizeObserver((entries) => {
			for (const entry of entries) {
				containerWidth = entry.contentRect.width;
			}
		});
		observer.observe(containerEl);
		return () => observer.disconnect();
	});

	function getShortcutText(tool: EditorToolbarTool) {
		return tool.shortcut ? tool.shortcut(modifier) : '';
	}

	function handleMouseEnter(e: MouseEvent, tool: EditorToolbarTool) {
		if (tool.id === 'insert-table-simple' && tablePickerOpen) return;
		onshowTooltip?.(e, tool.name, getShortcutText(tool), 'below');
	}

	function handleHideMouseEnter(e: MouseEvent) {
		onshowTooltip?.(e, 'Hide editor toolbar', '', 'below');
	}

	function handleOverflowMouseEnter(e: MouseEvent) {
		onshowTooltip?.(e, 'More formatting options', '', 'below');
	}

	function handleWindowClick(e: MouseEvent) {
		if (overflowMenuOpen && containerEl && !containerEl.contains(e.target as Node)) {
			overflowMenuOpen = false;
		}
		if (tablePickerOpen && containerEl && !containerEl.contains(e.target as Node)) {
			tablePickerOpen = false;
		}
	}

	function handleCellClick(row: number, col: number) {
		tablePickerOpen = false;
		hoverRows = 0;
		hoverCols = 0;
		onaction('insert-table-grid', { rows: row, cols: col });
	}

	onMount(() => {
		window.addEventListener('click', handleWindowClick);
		return () => window.removeEventListener('click', handleWindowClick);
	});
</script>

{#snippet renderToolIcon(toolId: string)}
	{#if toolId === 'fmt-bold'}
		<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M6 12h9a4 4 0 0 0 0-8H6v8Zm0 0h10a4 4 0 0 1 0 8H6v-8Z"/></svg>
	{:else if toolId === 'fmt-italic'}
		<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="19" x2="10" y1="4" y2="4"/><line x1="14" x2="5" y1="20" y2="20"/><line x1="15" x2="9" y1="4" y2="20"/></svg>
	{:else if toolId === 'fmt-underline'}
		<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 3v7a6 6 0 0 0 12 0V3"/><line x1="4" x2="20" y1="21" y2="21"/></svg>
	{:else if toolId === 'fmt-strikethrough'}
		<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M16 4H9a3 3 0 0 0-2.83 4"/><path d="M14 12a4 4 0 0 1 0 8H6"/><line x1="4" x2="20" y1="12" y2="12"/></svg>
	{:else if toolId === 'fmt-inline-code'}
		<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></svg>
	{:else if toolId === 'fmt-code-block'}
		<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="18" height="18" x="3" y="3" rx="2"/><path d="m10 10-2 2 2 2"/><path d="m14 10 2 2-2 2"/></svg>
	{:else if toolId === 'fmt-quote'}
		<svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor"><path d="M4.5 6H10v6.5C10 16 7.5 18 4 18v-2.5c2 0 3.5-1 3.5-3H4.5V6zM14.5 6H20v6.5C20 16 17.5 18 14 18v-2.5c2 0 3.5-1 3.5-3h-3V6z"/></svg>
	{:else if toolId === 'fmt-heading-1'}
		<svg width="15" height="15" viewBox="0 0 24 24"><text x="2" y="15" font-family="system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif" font-weight="700" font-size="12" fill="currentColor">H</text><text x="12" y="17" font-family="system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif" font-weight="700" font-size="9" fill="currentColor">1</text></svg>
	{:else if toolId === 'fmt-heading-2'}
		<svg width="15" height="15" viewBox="0 0 24 24"><text x="2" y="15" font-family="system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif" font-weight="700" font-size="12" fill="currentColor">H</text><text x="12" y="17" font-family="system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif" font-weight="700" font-size="9" fill="currentColor">2</text></svg>
	{:else if toolId === 'fmt-heading-3'}
		<svg width="15" height="15" viewBox="0 0 24 24"><text x="2" y="15" font-family="system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif" font-weight="700" font-size="12" fill="currentColor">H</text><text x="12" y="17" font-family="system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif" font-weight="700" font-size="9" fill="currentColor">3</text></svg>
	{:else if toolId === 'fmt-bullet-list'}
		<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="8" x2="21" y1="6" y2="6"/><line x1="8" x2="21" y1="12" y2="12"/><line x1="8" x2="21" y1="18" y2="18"/><circle cx="3.5" cy="6" r="1.5" fill="currentColor"/><circle cx="3.5" cy="12" r="1.5" fill="currentColor"/><circle cx="3.5" cy="18" r="1.5" fill="currentColor"/></svg>
	{:else if toolId === 'fmt-numbered-list'}
		<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="10" x2="21" y1="6" y2="6"/><line x1="10" x2="21" y1="12" y2="12"/><line x1="10" x2="21" y1="18" y2="18"/><path d="M4 6h1v4"/><path d="M4 10h2"/><path d="M6 18H4c0-1 2-2 2-3s-1-1.5-2-1"/></svg>
	{:else if toolId === 'fmt-checklist'}
		<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="5" width="4" height="4" rx="1"/><path d="m3 17 2 2 4-4"/><line x1="13" x2="21" y1="7" y2="7"/><line x1="13" x2="21" y1="17" y2="17"/></svg>
	{:else if toolId === 'fmt-link'}
		<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>
	{:else if toolId === 'insert-table-simple'}
		<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="18" height="18" x="3" y="3" rx="2"/><path d="M3 9h18"/><path d="M3 15h18"/><path d="M9 3v18"/><path d="M15 3v18"/></svg>
	{/if}
{/snippet}

{#snippet renderTableGridPopover()}
	<div
		class="table-grid-popover"
		role="dialog"
		tabindex="-1"
		aria-label="Table Dimensions Picker"
		transition:fly={{ y: 5, duration: 150 }}
		onkeydown={(e) => { if (e.key === 'Escape') tablePickerOpen = false; }}
		onclick={(e) => e.stopPropagation()}>
		<div class="table-grid-header">
			<span class="table-grid-title">Insert Table</span>
			<span class="table-grid-dims">
				{hoverRows > 0 && hoverCols > 0 ? `${hoverCols} × ${hoverRows}` : 'Select size'}
			</span>
		</div>

		<div
			class="table-grid-cells"
			role="grid"
			aria-label="Table grid"
			tabindex="0"
			onmouseleave={() => {
				hoverRows = 0;
				hoverCols = 0;
			}}>
			{#each Array(MAX_ROWS) as _, rIndex}
				<div class="table-grid-row" role="row">
					{#each Array(MAX_COLS) as _, cIndex}
						{@const r = rIndex + 1}
						{@const c = cIndex + 1}
						{@const isSelected = r <= hoverRows && c <= hoverCols}
						<button
							type="button"
							class="table-grid-cell"
							class:highlighted={isSelected}
							role="gridcell"
							aria-label={`${c} columns by ${r} rows`}
							onmouseenter={() => {
								hoverRows = r;
								hoverCols = c;
							}}
							onclick={() => handleCellClick(r, c)}>
						</button>
					{/each}
				</div>
			{/each}
		</div>
	</div>
{/snippet}

<div bind:this={containerEl} class="editor-toolbar" role="toolbar" aria-label="Markdown formatting">
	<div class="toolbar-tools-group">
		{#each visibleTools as tool, index (tool.id)}
			{#if index > 0 && visibleTools[index - 1].group !== tool.group}
				<span class="toolbar-separator" aria-hidden="true"></span>
			{/if}

			{#if tool.id === 'insert-table-simple'}
				<div class="table-picker-wrapper">
					<button
						type="button"
						class="toolbar-btn"
						class:active={tablePickerOpen}
						aria-label="Insert Table"
						onmouseenter={(e) => handleMouseEnter(e, tool)}
						onmouseleave={() => onhideTooltip?.()}
						onfocus={(e) => handleMouseEnter(e as unknown as MouseEvent, tool)}
						onblur={() => onhideTooltip?.()}
						onclick={(e) => {
							e.stopPropagation();
							onhideTooltip?.();
							tablePickerOpen = !tablePickerOpen;
							overflowMenuOpen = false;
						}}>
						{@render renderToolIcon(tool.id)}
					</button>

					{#if tablePickerOpen}
						{@render renderTableGridPopover()}
					{/if}
				</div>
			{:else}
				<button
					type="button"
					class="toolbar-btn"
					aria-label={getShortcutText(tool) ? `${tool.name} (${getShortcutText(tool)})` : tool.name}
					onmouseenter={(e) => handleMouseEnter(e, tool)}
					onmouseleave={() => onhideTooltip?.()}
					onfocus={(e) => handleMouseEnter(e as unknown as MouseEvent, tool)}
					onblur={() => onhideTooltip?.()}
					onclick={() => {
						onhideTooltip?.();
						onaction(tool.id);
					}}>
					{@render renderToolIcon(tool.id)}
				</button>
			{/if}
		{/each}

		{#if overflowTools.length > 0}
			<div class="overflow-menu-wrapper">
				<button
					type="button"
					class="toolbar-btn overflow-btn"
					class:active={overflowMenuOpen || (tablePickerOpen && overflowTools.some(t => t.id === 'insert-table-simple'))}
					aria-label="More formatting options"
					onmouseenter={handleOverflowMouseEnter}
					onmouseleave={() => onhideTooltip?.()}
					onclick={(e) => {
						e.stopPropagation();
						onhideTooltip?.();
						overflowMenuOpen = !overflowMenuOpen;
						tablePickerOpen = false;
					}}>
					<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
						<circle cx="12" cy="12" r="1" fill="currentColor"/>
						<circle cx="19" cy="12" r="1" fill="currentColor"/>
						<circle cx="5" cy="12" r="1" fill="currentColor"/>
					</svg>
				</button>

				{#if overflowMenuOpen}
					<div
						class="overflow-dropdown-menu"
						role="menu"
						tabindex="-1"
						transition:fly={{ y: 5, duration: 150 }}
						onkeydown={(e) => { if (e.key === 'Escape') overflowMenuOpen = false; }}
						onclick={(e) => e.stopPropagation()}>
						{#each overflowTools as tool (tool.id)}
							{#if tool.id === 'insert-table-simple'}
								<button
									type="button"
									class="overflow-menu-item"
									onclick={(e) => {
										e.stopPropagation();
										overflowMenuOpen = false;
										tablePickerOpen = true;
									}}>
									<span class="overflow-item-icon">{@render renderToolIcon(tool.id)}</span>
									<span class="overflow-item-name">{tool.name}</span>
									{#if getShortcutText(tool)}
										<span class="overflow-item-shortcut">{getShortcutText(tool)}</span>
									{/if}
								</button>
							{:else}
								<button
									type="button"
									class="overflow-menu-item"
									onclick={() => {
										overflowMenuOpen = false;
										onaction(tool.id);
									}}>
									<span class="overflow-item-icon">{@render renderToolIcon(tool.id)}</span>
									<span class="overflow-item-name">{tool.name}</span>
									{#if getShortcutText(tool)}
										<span class="overflow-item-shortcut">{getShortcutText(tool)}</span>
									{/if}
								</button>
							{/if}
						{/each}
					</div>
				{/if}

				{#if tablePickerOpen && overflowTools.some(t => t.id === 'insert-table-simple')}
					{@render renderTableGridPopover()}
				{/if}
			</div>
		{/if}
	</div>

	{#if ontoggleHide}
		<button
			type="button"
			class="toolbar-btn hide-toggle-btn"
			aria-label="Hide editor toolbar"
			onmouseenter={handleHideMouseEnter}
			onmouseleave={() => onhideTooltip?.()}
			onfocus={(e) => handleHideMouseEnter(e as unknown as MouseEvent)}
			onblur={() => onhideTooltip?.()}
			onclick={() => {
				onhideTooltip?.();
				ontoggleHide();
			}}>
			<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
				<polyline points="18 15 12 9 6 15"></polyline>
			</svg>
		</button>
	{/if}
</div>

<style>
	.editor-toolbar {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 4px;
		min-height: 34px;
		padding: 3px 8px;
		border-bottom: 1px solid var(--color-border-muted);
		background: var(--color-canvas-default);
		box-sizing: border-box;
		user-select: none;
		position: relative;
		font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
	}

	.toolbar-tools-group {
		display: flex;
		align-items: center;
		gap: 2px;
		overflow: visible;
		min-width: 0;
		flex: 1;
	}

	.toolbar-btn {
		width: 28px;
		height: 28px;
		flex: 0 0 28px;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		border: 1px solid transparent;
		border-radius: 6px;
		background: transparent;
		color: var(--color-fg-muted);
		cursor: pointer;
		padding: 0;
		transition: background-color 0.15s, color 0.15s, border-color 0.15s;
		font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
	}

	.toolbar-btn:hover,
	.toolbar-btn.active {
		background: var(--color-neutral-muted, rgba(175, 184, 193, 0.2));
		color: var(--color-fg-default);
		border-color: var(--color-border-muted);
	}

	.toolbar-btn:focus-visible {
		outline: 2px solid var(--color-accent-fg);
		outline-offset: 1px;
	}

	.table-picker-wrapper,
	.overflow-menu-wrapper {
		position: relative;
		display: flex;
		align-items: center;
	}

	/* Table Grid Popover */
	.table-grid-popover {
		position: absolute;
		top: 100%;
		left: 0;
		margin-top: 4px;
		background: var(--color-canvas-default);
		border: 1px solid var(--color-border-default);
		border-radius: 8px;
		box-shadow: 0 8px 24px rgba(0, 0, 0, 0.28);
		padding: 8px 10px 8px 10px;
		z-index: 10005;
		display: flex;
		flex-direction: column;
		gap: 6px;
		user-select: none;
		font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
	}

	.table-grid-header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 12px;
		padding-bottom: 4px;
		border-bottom: 1px solid var(--color-border-muted);
	}

	.table-grid-title {
		font-size: 11px;
		font-weight: 600;
		color: var(--color-fg-muted);
		text-transform: uppercase;
		letter-spacing: 0.5px;
		font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
	}

	.table-grid-dims {
		font-size: 11px;
		font-weight: 600;
		color: var(--color-accent-fg);
		font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
		min-width: 44px;
		text-align: right;
	}

	.table-grid-cells {
		display: flex;
		flex-direction: column;
		gap: 3px;
		padding: 2px 0;
		outline: none;
	}

	.table-grid-row {
		display: flex;
		gap: 3px;
	}

	.table-grid-cell {
		width: 15px;
		height: 15px;
		padding: 0;
		border: 1px solid var(--color-border-muted);
		border-radius: 2px;
		background: var(--color-canvas-subtle);
		cursor: pointer;
		transition: background-color 0.08s, border-color 0.08s;
	}

	.table-grid-cell.highlighted {
		background: var(--color-accent-subtle, rgba(56, 139, 253, 0.2));
		border-color: var(--color-accent-fg);
	}

	.table-grid-cell:focus-visible {
		outline: 1px solid var(--color-accent-fg);
	}

	/* Overflow Dropdown Menu */
	.overflow-dropdown-menu {
		position: absolute;
		top: 100%;
		right: 0;
		margin-top: 4px;
		background: var(--color-canvas-default);
		border: 1px solid var(--color-border-default);
		border-radius: 6px;
		box-shadow: 0 8px 24px rgba(0, 0, 0, 0.25);
		padding: 4px;
		display: flex;
		flex-direction: column;
		min-width: 170px;
		z-index: 10005;
		gap: 2px;
		font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
	}

	.overflow-menu-wrapper .table-grid-popover {
		right: 0;
		left: auto;
	}

	.overflow-menu-item {
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 5px 8px;
		border: none;
		background: transparent;
		color: var(--color-fg-default);
		font-size: 12px;
		font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
		cursor: pointer;
		border-radius: 4px;
		width: 100%;
		text-align: left;
		transition: background-color 0.12s;
	}

	.overflow-menu-item:hover {
		background: var(--color-canvas-subtle);
	}

	.overflow-item-icon {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 16px;
		color: var(--color-fg-muted);
	}

	.overflow-item-name {
		flex: 1;
	}

	.overflow-item-shortcut {
		font-size: 10px;
		color: var(--color-fg-muted);
	}

	.hide-toggle-btn {
		margin-left: auto;
		flex-shrink: 0;
	}

	.toolbar-separator {
		width: 1px;
		height: 16px;
		margin: 0 4px;
		flex: 0 0 1px;
		background: var(--color-border-muted);
	}
</style>
