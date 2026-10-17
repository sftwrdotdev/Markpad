<script lang="ts">
	import { tabManager } from '../stores/tabs.svelte.js';
	import { settings, TAB_COLUMN_WIDTH_RANGE } from '../stores/settings.svelte.js';
	import { t } from '../utils/i18n.js';
	import TabList from './TabList.svelte';

	/**
	 * The open documents as a column down one side of the window (#884).
	 *
	 * The same `TabList` the title bar draws, turned on its side, so every tab
	 * action (context menu, middle-click close, drag to reorder, move to another
	 * window) is the strip's own code rather than a second copy of it. The
	 * column sits under the title bar; `MarkdownViewer` moves the document over
	 * by `settings.tabColumnWidth` while it is shown.
	 */
	let {
		side,
		showHome = false,
		ontabclick,
		oncloseTab,
	} = $props<{
		side: 'left' | 'right';
		showHome?: boolean;
		ontabclick?: () => void;
		oncloseTab?: (id: string) => void;
	}>();

	let isResizing = $state(false);

	function startResize(e: PointerEvent) {
		e.preventDefault();
		const target = e.currentTarget as HTMLElement;
		target.setPointerCapture?.(e.pointerId);

		const startX = e.clientX;
		const startWidth = settings.tabColumnWidth;
		const resizeSide = side;
		isResizing = true;
		document.body.style.cursor = 'col-resize';
		document.body.style.userSelect = 'none';

		const onMove = (moveEvent: PointerEvent) => {
			const deltaX = moveEvent.clientX - startX;
			settings.setTabColumnWidth(startWidth + (resizeSide === 'left' ? deltaX : -deltaX));
		};

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

	// Same keys as the outline's resize handle in MarkdownViewer.svelte.
	function handleResizeKeyDown(e: KeyboardEvent) {
		const step = e.key === 'ArrowRight' ? 16 : e.key === 'ArrowLeft' ? -16 : 0;
		if (step !== 0) settings.setTabColumnWidth(settings.tabColumnWidth + (side === 'left' ? step : -step));
		else if (e.key === 'Home') settings.setTabColumnWidth(TAB_COLUMN_WIDTH_RANGE.min);
		else if (e.key === 'End') settings.setTabColumnWidth(TAB_COLUMN_WIDTH_RANGE.max);
		else return;
		e.preventDefault();
	}
</script>

<aside
	class="tab-column on-{side}"
	class:tagged={tabManager.windowTag !== null}
	class:resizing={isResizing}
	style:width="{settings.tabColumnWidth}px"
	style:--tag-color={tabManager.windowTag?.color}>
	<TabList orientation="vertical" onnewTab={() => tabManager.addNewTab()} {showHome} {ontabclick} {oncloseTab} />
	<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
	<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
	<div
		class="tab-column-resizer"
		role="separator"
		aria-label={t('tabs.resizeColumn', settings.language)}
		aria-orientation="vertical"
		aria-valuemin={TAB_COLUMN_WIDTH_RANGE.min}
		aria-valuemax={TAB_COLUMN_WIDTH_RANGE.max}
		aria-valuenow={settings.tabColumnWidth}
		tabindex="0"
		onpointerdown={startResize}
		onkeydown={handleResizeKeyDown}></div>
</aside>

<style>
	.tab-column {
		position: fixed;
		top: 36px;
		bottom: 0;
		z-index: 900;
		display: flex;
		flex-direction: column;
		box-sizing: border-box;
		background: var(--color-canvas-default);
		font-family: var(--win-font, 'Segoe UI', sans-serif);
	}

	.tab-column.on-left {
		left: 0;
		border-right: 1px solid var(--color-border-muted);
	}

	.tab-column.on-right {
		right: 0;
		border-left: 1px solid var(--color-border-muted);
	}

	/* The window tag, drawn once along the column's inner edge: the vertical
	   counterpart of the line under the strip in TitleBar.svelte. */
	.tab-column.tagged::after {
		content: '';
		position: absolute;
		top: 0;
		bottom: 0;
		width: 2px;
		background: var(--tag-color);
		pointer-events: none;
	}

	.tab-column.tagged.on-left::after {
		right: -1px;
	}

	.tab-column.tagged.on-right::after {
		left: -1px;
	}

	.tab-column-resizer {
		position: absolute;
		top: 0;
		bottom: 0;
		width: 6px;
		cursor: col-resize;
		z-index: 1;
	}

	.on-left .tab-column-resizer {
		right: -3px;
	}

	.on-right .tab-column-resizer {
		left: -3px;
	}

	.tab-column-resizer:hover,
	.tab-column-resizer:focus-visible,
	.tab-column.resizing .tab-column-resizer {
		background: color-mix(in srgb, var(--color-accent-fg) 35%, transparent);
	}
</style>
