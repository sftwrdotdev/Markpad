<script lang="ts">
	import { invoke } from '@tauri-apps/api/core';
	import { folderManager, type FolderEntry } from '../stores/folder.svelte.js';
	import { settings } from '../stores/settings.svelte.js';
	import { tabManager } from '../stores/tabs.svelte.js';
	import { hasMarkdownLinkExtension } from '../utils/markdownLinks.js';
	import { t } from '../utils/i18n.js';
	import ContextMenu, { type ContextMenuItem } from './ContextMenu.svelte';

	/**
	 * The open folder as a tree. Rows are buttons in document order, so arrow
	 * keys move between whatever is on screen without a second model of it.
	 */
	let { onopen } = $props<{
		/** A file was chosen. `openable` is false for a file Markpad does not edit. */
		onopen: (entry: FolderEntry, openable: boolean) => void;
	}>();

	let treeEl = $state<HTMLElement | null>(null);
	let contextMenu = $state<{ show: boolean; x: number; y: number; items: ContextMenuItem[] }>({
		show: false,
		x: 0,
		y: 0,
		items: [],
	});

	const activePath = $derived(tabManager.activeTab?.path ?? null);

	function visible(list: FolderEntry[] | undefined): FolderEntry[] {
		if (!list) return [];
		return settings.folderShowAllFiles ? list : list.filter((e) => e.isDir || hasMarkdownLinkExtension(e.name));
	}

	function choose(entry: FolderEntry) {
		if (entry.isDir) void folderManager.toggle(entry.path);
		else onopen(entry, hasMarkdownLinkExtension(entry.name));
	}

	function rows(): HTMLButtonElement[] {
		return treeEl ? Array.from(treeEl.querySelectorAll<HTMLButtonElement>('button.folder-row')) : [];
	}

	function handleKeydown(e: KeyboardEvent, entry: FolderEntry) {
		const all = rows();
		const index = all.indexOf(e.currentTarget as HTMLButtonElement);
		const move = (to: number) => {
			e.preventDefault();
			all[Math.max(0, Math.min(all.length - 1, to))]?.focus();
		};
		switch (e.key) {
			case 'ArrowDown':
				return move(index + 1);
			case 'ArrowUp':
				return move(index - 1);
			case 'Home':
				return move(0);
			case 'End':
				return move(all.length - 1);
			case 'ArrowRight':
				if (entry.isDir && !folderManager.isExpanded(entry.path)) {
					e.preventDefault();
					void folderManager.toggle(entry.path);
				} else if (entry.isDir) move(index + 1);
				return;
			case 'ArrowLeft':
				if (entry.isDir && folderManager.isExpanded(entry.path)) {
					e.preventDefault();
					void folderManager.toggle(entry.path);
				}
				return;
		}
	}

	function handleContextMenu(e: MouseEvent, entry: FolderEntry) {
		e.preventDefault();
		e.stopPropagation();
		const lang = settings.language;
		contextMenu = {
			show: true,
			x: e.clientX,
			y: e.clientY,
			items: [
				{
					label: t('menu.copyFullPath', lang),
					onClick: () => invoke('clipboard_write_text', { text: entry.path }).catch(console.error),
				},
				{
					label: t('menu.openFileLocation', lang),
					onClick: () => invoke('open_file_folder', { path: entry.path }).catch(console.error),
				},
			],
		};
	}
</script>

{#snippet branch(dir: string, depth: number)}
	{#each visible(folderManager.entries[dir]) as entry (entry.path)}
		{@const expanded = entry.isDir && folderManager.isExpanded(entry.path)}
		{@const openable = entry.isDir || hasMarkdownLinkExtension(entry.name)}
		<button
			class="folder-row"
			class:dir={entry.isDir}
			class:dim={!openable}
			class:active={!entry.isDir && entry.path === activePath}
			role="treeitem"
			aria-expanded={entry.isDir ? expanded : undefined}
			aria-selected={!entry.isDir && entry.path === activePath}
			style:padding-left="{8 + depth * 12}px"
			title={entry.path}
			onclick={() => choose(entry)}
			onkeydown={(e) => handleKeydown(e, entry)}
			oncontextmenu={(e) => handleContextMenu(e, entry)}>
			<span class="chevron" class:open={expanded} aria-hidden="true">
				{#if entry.isDir}
					<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 6 15 12 9 18"></polyline></svg>
				{/if}
			</span>
			<span class="name">{entry.name}</span>
		</button>
		{#if expanded}
			{@render branch(entry.path, depth + 1)}
		{/if}
	{/each}
{/snippet}

<div class="folder-tree" role="tree" bind:this={treeEl}>
	{#if folderManager.error}
		<p class="folder-note">{t('folder.unavailable', settings.language)}</p>
	{:else if folderManager.root && folderManager.isLoaded(folderManager.root) && visible(folderManager.entries[folderManager.root]).length === 0}
		<p class="folder-note">{t('folder.empty', settings.language)}</p>
	{:else if folderManager.root}
		{@render branch(folderManager.root, 0)}
	{/if}
</div>

<ContextMenu {...contextMenu} onhide={() => (contextMenu.show = false)} />

<style>
	.folder-tree {
		display: flex;
		flex-direction: column;
		padding: 2px 6px 6px;
		font-size: 12px;
	}

	.folder-row {
		appearance: none;
		display: flex;
		align-items: center;
		gap: 4px;
		width: 100%;
		height: 24px;
		flex-shrink: 0;
		padding-right: 6px;
		border: none;
		border-radius: 6px;
		background: transparent;
		color: var(--color-fg-muted);
		font: inherit;
		text-align: left;
		cursor: pointer;
		user-select: none;
	}

	.folder-row:hover {
		background: var(--color-neutral-muted);
	}

	.folder-row:focus-visible {
		outline: 1px solid var(--color-accent-fg);
		outline-offset: -1px;
	}

	.folder-row.active {
		background: var(--tab-active-bg);
		color: var(--color-fg-default);
	}

	.folder-row.dim {
		opacity: 0.55;
	}

	.chevron {
		display: inline-flex;
		width: 12px;
		flex-shrink: 0;
		justify-content: center;
		transition: transform 0.1s;
	}

	.chevron.open {
		transform: rotate(90deg);
	}

	.name {
		overflow: hidden;
		white-space: nowrap;
		text-overflow: ellipsis;
	}

	.folder-row.dir .name {
		color: var(--color-fg-default);
	}

	.folder-note {
		margin: 8px;
		color: var(--color-fg-muted);
		font-size: 12px;
	}
</style>
