<script lang="ts">
	import { type Tab, tabManager } from '../stores/tabs.svelte.js';
	import ContextMenu, { type ContextMenuItem } from './ContextMenu.svelte';
	import { invoke } from '@tauri-apps/api/core';
	import { emitTo } from '@tauri-apps/api/event';
	import { getCurrentWindow } from '@tauri-apps/api/window';
	import { t } from '../utils/i18n.js';
	import { settings } from '../stores/settings.svelte.js';
	import { getTabFileActions, hasRealFilePath } from '../utils/tabFileActions.js';
	import { isHomePath } from '../utils/homeTab.js';
	import { modifierFor, shortcutLabel } from '../utils/shortcuts.js';

	let { tab, folderSuffix, isActive, isLast, onclick, onclose } = $props<{
		tab: Tab;
		/**
		 * The containing folder, when another tab in this window holds a
		 * different file by the same name (#727). Computed over the whole tab
		 * strip by `TabList`, because whether a name is ambiguous is not
		 * something a tab can know about itself.
		 */
		folderSuffix?: string;
		isActive: boolean;
		isLast?: boolean;
		onclick: () => void;
		onclose: (e: MouseEvent) => void;
	}>();

	let tabContextMenu = $state<{
		show: boolean;
		x: number;
		y: number;
		items: ContextMenuItem[];
	}>({
		show: false,
		x: 0,
		y: 0,
		items: [],
	});

	// A truncated title scrolls into view while the pointer rests on the
	// tab (marquee), instead of compressing tabs below readability. The
	// overflow is measured on hover because tab widths are flex-driven.
	let labelEl = $state<HTMLSpanElement>();
	let marqueeOffset = $state(0);

	function startTitleMarquee() {
		if (!labelEl) return;
		const overflow = labelEl.scrollWidth - labelEl.clientWidth;
		if (overflow > 0) marqueeOffset = overflow;
	}

	function stopTitleMarquee() {
		marqueeOffset = 0;
	}

	function handleClose(e: MouseEvent) {
		e.stopPropagation();
		onclose(e);
	}

	function handleMiddleClick(e: MouseEvent) {
		if (e.button === 1) {
			e.preventDefault();
			e.stopPropagation();
			onclose(e);
		}
	}

	function copyTabPath() {
		if (!hasRealFilePath(tab.path)) return;
		invoke('clipboard_write_text', { text: tab.path }).catch(console.error);
	}

	function openTabFileLocation() {
		if (!hasRealFilePath(tab.path)) return;
		invoke('open_file_folder', { path: tab.path }).catch(console.error);
	}

	type ViewerWindowEntry = {
		label: string;
		number: number;
		tag_name: string | null;
		active_tab_title: string;
		tab_count: number;
	};

	function windowDisplay(window: ViewerWindowEntry, lang: typeof settings.language): string {
		const identity = window.tag_name ?? `${t('menu.window', lang)} ${window.number}`;
		return window.active_tab_title ? `${identity} · ${window.active_tab_title}` : identity;
	}

	async function handleContextMenu(e: MouseEvent) {
		e.preventDefault();
		e.stopPropagation();

		const currentLang = settings.language;
		// ContextMenu prints `shortcut` into the same `<span class="menu-shortcut">`
		// the app menu uses, so a literal here sits a keystroke away from the app
		// menu's registry-derived chord and disagrees with it on macOS.
		const modifier = modifierFor(settings.osType);
		const fileActionItems: ContextMenuItem[] = getTabFileActions(tab.path).map((action) => ({
			label: t(action.labelKey, currentLang),
			disabled: action.disabled,
			onClick: action.id === 'copy-path' ? copyTabPath : openTabFileLocation,
		}));
		const selfLabel = getCurrentWindow().label;
		let moveToWindowItems: ContextMenuItem[] = [];
		try {
			const windows = (await invoke('list_viewer_windows')) as ViewerWindowEntry[];
			moveToWindowItems = windows
				.filter((window) => window.label !== selfLabel)
				.map((window) => ({
					label: `${t('menu.moveToWindow', currentLang)} ${windowDisplay(window, currentLang)}`,
					disabled: isHomePath(tab.path),
					onHover: () => emitTo(window.label, 'window-identify', windowDisplay(window, currentLang)),
					onClick: () => emitTo(selfLabel, 'menu-tab-move', { tabId: tab.id, targetLabel: window.label }),
				}));
		} catch (error) {
			console.error('Failed to list viewer windows', error);
		}

		tabContextMenu = {
			show: true,
			x: e.clientX,
			y: e.clientY,
			items: [
				{ label: t('menu.newFile', currentLang), shortcut: shortcutLabel('file-new', modifier), onClick: () => emitTo(getCurrentWindow().label, 'menu-tab-new') },
				{ label: t('menu.undoCloseTab', currentLang), shortcut: shortcutLabel('tab-undo-close', modifier), onClick: () => emitTo(getCurrentWindow().label, 'menu-tab-undo') },
				{
					label: t('menu.rename', currentLang),
					// Rename renames the file on disk; untitled and home tabs have
					// no file, and the handler previously no-oped silently.
					disabled: !hasRealFilePath(tab.path),
					onClick: () => emitTo(getCurrentWindow().label, 'menu-tab-rename', tab.id),
				},
				{ separator: true },
				...fileActionItems,
				{ separator: true },
				{
					label: t('menu.moveToNewWindow', currentLang),
					// Moving the only tab would just churn windows, and the home
					// tab is recreatable anywhere; both stay in place.
					disabled: isHomePath(tab.path) || tabManager.tabs.length < 2,
					onClick: () => emitTo(getCurrentWindow().label, 'menu-tab-detach', tab.id),
				},
				...moveToWindowItems,
				{ separator: true },
				{ label: t('menu.closeFile', currentLang), shortcut: shortcutLabel('file-close', modifier), onClick: () => emitTo(getCurrentWindow().label, 'menu-tab-close', tab.id) },
				{ label: t('menu.closeOtherTabs', currentLang), onClick: () => emitTo(getCurrentWindow().label, 'menu-tab-close-others', tab.id) },
				{ label: t('menu.closeTabsToRight', currentLang), onClick: () => emitTo(getCurrentWindow().label, 'menu-tab-close-right', tab.id) },
			],
		};
	}

	/**
	 * The path, plus the encoding when it is not the one everybody assumes.
	 *
	 * A save writes the document back as the encoding it was opened in, so a
	 * GBK or Shift-JIS file stays GBK or Shift-JIS — which is right, and is
	 * invisible unless something says so. This is the smallest place that can:
	 * no chrome, no translation (encoding labels are not translated), and it
	 * says nothing at all for the UTF-8 files that are almost every file.
	 *
	 * A status-bar control that lets the reader CHANGE the encoding — reopen
	 * as, convert to — is the other half and is deliberately not here; see the
	 * discussion on #372.
	 */
	function tabTooltip(tab: Tab): string {
		const name = hasRealFilePath(tab.path) ? tab.path : tab.title;
		return tab.encoding === 'UTF-8' ? name : `${name} (${tab.encoding})`;
	}
</script>

<!-- svelte-ignore a11y_click_events_have_key_events -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
	class="tab {isActive ? 'active' : ''}"
	class:last={isLast}
	role="group"
	title={tabTooltip(tab)}
	oncontextmenu={handleContextMenu}
	onmouseenter={startTitleMarquee}
	onmouseleave={stopTitleMarquee}>
	<button class="tab-content-btn" onclick={onclick} onmousedown={(e) => {
		if (e.button === 0) e.preventDefault();
		handleMiddleClick(e);
	}}>
		<span class="tab-label" class:marquee={marqueeOffset > 0} bind:this={labelEl}>
			<span
				class="tab-label-text"
				style:transform={marqueeOffset > 0 ? `translateX(-${marqueeOffset}px)` : ''}
				style:transition-duration={marqueeOffset > 0 ? `${Math.max(300, marqueeOffset * 20)}ms` : '150ms'}>
				{tab.title}{#if folderSuffix}<span class="tab-folder">{folderSuffix}</span>{/if}
			</span>
		</span>
	</button>
	<div class="tab-actions">
		<button class="tab-close" class:dirty={tab.isDirty} onclick={handleClose} onmousedown={(e) => {
			e.stopPropagation();
			e.preventDefault();
		}} title={`${t('tooltip.close', settings.language)} (${shortcutLabel('file-close', modifierFor(settings.osType))})`}>
			{#if tab.isDirty}
				<span class="dirty-dot"></span>
			{/if}
			<svg class="close-icon" width="12" height="12" viewBox="0 0 12 12"
				><path fill="currentColor" d="M11 1.7L10.3 1 6 5.3 1.7 1 1 1.7 5.3 6 1 10.3 1.7 11 6 6.7 10.3 11 11 10.3 6.7 6z" /></svg>
		</button>
	</div>
</div>

<ContextMenu {...tabContextMenu} onhide={() => (tabContextMenu.show = false)} />

<style>
	.tab {
		display: flex;
		align-items: center;
		height: 28px;
		min-width: 100px;
		max-width: 200px;
		padding: 0;
		margin: 0;
		background: transparent;
		color: var(--color-fg-muted);
		user-select: none;
		position: relative;
		font-size: 12px;
		font-family: var(--win-font, 'Segoe UI', sans-serif);
		border-radius: 8px;
		transition:
			background-color 0.25s cubic-bezier(0.05, 0.95, 0.05, 0.95),
			color 0.25s cubic-bezier(0.05, 0.95, 0.05, 0.95);
	}

	.tab.last {
		border-right: none;
	}


	.tab:hover {
		background-color: var(--color-neutral-muted);
	}

	.tab.active {
		background-color: var(--tab-active-bg);
		color: var(--color-fg-default);
	}

	.tab-content-btn {
		appearance: none;
		background: transparent;
		border: none;
		color: inherit;
		display: flex;
		align-items: center;
		gap: 6px;
		flex: 1;
		width: 100%;
		height: 100%;
		padding: 0 4px 0 12px;
		overflow: hidden;
		cursor: pointer;
		font-family: inherit;
		font-size: inherit;
		text-align: left;
	}

	.tab-label {
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	/* While the marquee runs, the ellipsis gives way to the sliding text. */
	.tab-label.marquee {
		text-overflow: clip;
	}

	.tab-label-text {
		display: inline;
	}

	/* Dimmed and set off, so the file name still reads as the label. */
	.tab-folder {
		margin-left: 6px;
		opacity: 0.6;
	}

	.tab-label.marquee .tab-label-text {
		display: inline-block;
		transition-property: transform;
		transition-timing-function: linear;
	}

	.tab-actions {
		display: flex;
		align-items: center;
		padding-right: 4px;
		opacity: 0;
	}

	.tab:hover .tab-actions,
	.tab.active .tab-actions,
	.tab-actions:has(.dirty) {
		opacity: 1;
	}

	.tab-close {
		width: 18px;
		height: 18px;
		border-radius: 4px;
		display: flex;
		scale: 0.8;
		justify-content: center;
		align-items: center;
		background: transparent;
		border: none;
		color: inherit;
		cursor: pointer;
		padding: 0;
		transition: background 0.1s;
		position: relative;
	}

	.close-icon {
		display: none;
	}

	.tab:hover .close-icon {
		display: block;
	}

	.tab:hover .dirty-dot {
		display: none;
	}

	.dirty-dot {
		width: 8px;
		height: 8px;
		background-color: var(--color-fg-default);
		border-radius: 50%;
		display: block;
	}

	.tab-close:hover {
		background-color: var(--color-neutral-muted);
	}
</style>
