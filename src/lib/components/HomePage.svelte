<script lang="ts">
	import { getVersion } from '@tauri-apps/api/app';
	import { onMount } from 'svelte';
	import { t } from '../utils/i18n.js';
	import { settings } from '../stores/settings.svelte.js';
	import { duplicateNameSuffixes } from '../utils/duplicateTabNames.js';
	import ContextMenu, { type ContextMenuItem } from './ContextMenu.svelte';

	let { recentFiles, pinnedTags = [], onselectFile, onloadFile, onremoveRecentFile, onnewFile, onopenPinnedTag, onunpinTag } = $props<{
		recentFiles: string[];
		pinnedTags?: Array<{ name: string; color: string; files: string[] }>;
		onopenPinnedTag?: (tag: { name: string; color: string; files: string[] }) => void;
		onunpinTag?: (name: string) => void;
		onselectFile: () => void;
		onloadFile: (file: string) => void;
		onremoveRecentFile: (file: string, e: MouseEvent) => void;
		onnewFile: () => void;
	}>();

	let version = $state('');

	onMount(async () => {
		try {
			version = await getVersion();
		} catch (e) {
			console.error('Failed to get version:', e);
		}
	});

	function getFileName(path: string) {
		return path.split(/[/\\]/).pop() || path;
	}

	let fileMenu = $state<{ x: number; y: number; items: ContextMenuItem[] } | null>(null);

	function showTagFiles(event: MouseEvent, files: string[]) {
		// The document-level handler in MarkdownViewer would open the preview menu on top.
		event.preventDefault();
		event.stopPropagation();
		const suffixes = duplicateNameSuffixes(files.map((path) => ({ id: path, path })));
		fileMenu = {
			x: event.clientX,
			y: event.clientY,
			items: files.map((path) => ({ label: getFileName(path), shortcut: suffixes.get(path), onClick: () => onloadFile(path) })),
		};
	}
</script>

<div class="message">
	<p>{t('home.welcomeToMarkpad', settings.language)}</p>
	<div class="actions-row">
		<button class="fluent-btn primary" onclick={onselectFile}>
			<svg
				xmlns="http://www.w3.org/2000/svg"
				width="16"
				height="16"
				viewBox="0 0 24 24"
				fill="none"
				stroke="currentColor"
				stroke-width="2"
				stroke-linecap="round"
				stroke-linejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" /></svg>
			{t('home.openFile', settings.language)}
		</button>
		<button class="fluent-btn secondary" onclick={onnewFile}>
			<svg
				xmlns="http://www.w3.org/2000/svg"
				width="16"
				height="16"
				viewBox="0 0 24 24"
				fill="none"
				stroke="currentColor"
				stroke-width="2"
				stroke-linecap="round"
				stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"></line><line x1="5" y1="12" x2="19" y2="12"></line></svg>
			{t('home.newFile', settings.language)}
		</button>
	</div>
	{#if pinnedTags.length > 0}
		<div class="recent-section">
			<h3>{t('home.pinnedTags', settings.language)}</h3>
			<div class="recent-grid">
				{#each pinnedTags as tag (tag.name)}
					<div class="recent-card" onclick={() => onopenPinnedTag?.(tag)} oncontextmenu={(event) => showTagFiles(event, tag.files)} onkeydown={(event) => (event.key === 'Enter' || event.key === ' ') && onopenPinnedTag?.(tag)} role="button" tabindex="0">
						<div class="file-icon"><span class="tag-dot" style:--tag-color={tag.color}></span></div>
						<div class="file-info"><span class="file-name">{tag.name}</span><span class="file-path file-count">{t('home.pinnedFileCount', settings.language).replace('{{count}}', String(tag.files.length))}</span></div>
						<button class="clear-btn" onclick={(event) => { event.stopPropagation(); onunpinTag?.(tag.name); }}>×</button>
					</div>
				{/each}
			</div>
		</div>
	{/if}

	{#if settings.showRecentFiles}
	<div class="recent-section">
		<h3>{t('home.recentFiles', settings.language)}</h3>
		{#if recentFiles.length > 0}
			<div class="recent-grid">
				{#each recentFiles as file}
					<div
						class="recent-card"
						onclick={() => onloadFile(file)}
						role="button"
						tabindex="0"
						onkeydown={(e) => {
							if (e.key === 'Enter' || e.key === ' ') {
								onloadFile(file);
							}
						}}>
						<div class="file-icon">
							<svg
								xmlns="http://www.w3.org/2000/svg"
								width="24"
								height="24"
								viewBox="0 0 24 24"
								fill="none"
								stroke="currentColor"
								stroke-width="2"
								stroke-linecap="round"
								stroke-linejoin="round"><path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z" /><polyline points="14 2 14 8 20 8" /></svg>
						</div>
						<div class="file-info">
							<span class="file-name">{getFileName(file)}</span>
							<span class="file-path" title={file}>{file}</span>
						</div>
						<button class="clear-btn" onclick={(e) => onremoveRecentFile(file, e as MouseEvent)} title={t('home.removeFromHistory', settings.language)}>
							<svg
								xmlns="http://www.w3.org/2000/svg"
								width="14"
								height="14"
								viewBox="0 0 24 24"
								fill="none"
								stroke="currentColor"
								stroke-width="2"
								stroke-linecap="round"
								stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
						</button>
					</div>
				{/each}
			</div>
		{:else}
			<p class="empty-recent">{t('home.noRecentFiles', settings.language)}</p>
		{/if}
	</div>
	{/if}
</div>
<ContextMenu show={fileMenu !== null} x={fileMenu?.x ?? 0} y={fileMenu?.y ?? 0} items={fileMenu?.items ?? []} onhide={() => (fileMenu = null)} />

<div class="version-tag">v{version}</div>

<style>
	.message {
		display: flex;
		flex-direction: column;
		justify-content: center;
		align-items: center;
		user-select: none;
		font-family: var(--win-font);
		height: 100vh;
		width: 100%;
		box-sizing: border-box;
		color: var(--color-fg-default);
		opacity: 0.8;
	}

	.fluent-btn {
		background: var(--color-canvas-subtle);
		color: var(--color-fg-default);
		border: 1px solid var(--color-border-default);
		padding: 8px 20px;
		border-radius: 6px;
		cursor: pointer;
		font-weight: 500;
		font-family: var(--win-font);
		font-size: 14px;
		transition: all 0.2s cubic-bezier(0.1, 0.9, 0.2, 1);
		box-shadow: 0 2px 4px rgba(0, 0, 0, 0.05);
		display: inline-flex;
		align-items: center;
		justify-content: center;
		gap: 8px;
	}

	.fluent-btn.primary {
		background: var(--color-accent-fg);
		color: var(--color-btn-fg);
		border: 1px solid rgba(0, 0, 0, 0.1);
	}

	.fluent-btn.secondary {
		background: var(--color-canvas-subtle);
		color: var(--color-fg-default);
		border: 1px solid var(--color-border-default);
	}

	.actions-row {
		display: flex;
		gap: 12px;
		margin-top: 20px;
	}

	.recent-section {
		margin-top: 60px;
		width: 100%;
		max-width: 800px;
		padding: 0;
		display: flex;
		flex-direction: column;
		align-items: center;
		animation: slideUp 0.2s ease-out;
		box-sizing: border-box;
		overflow-x: hidden;
	}

	.tag-dot { display: block; width: 16px; height: 16px; border-radius: 50%; background: var(--tag-color); }

	@keyframes slideUp {
		from {
			opacity: 0;
			transform: translateY(8px);
		}
		to {
			opacity: 1;
			transform: translateY(0);
		}
	}

	.empty-recent {
		font-size: 14px;
		margin-bottom: 20px;
		opacity: 0.5;
		text-align: center;
	}

	.recent-section h3 {
		font-size: 14px;
		font-weight: 600;
		margin-bottom: 20px;
		opacity: 0.8;
		text-align: center;
	}

	.recent-grid {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(220px, 220px));
		justify-content: center;
		gap: 12px;
		width: 100%;
		box-sizing: border-box;
	}

	.recent-card {
		position: relative;
		background: var(--color-canvas-subtle);
		border: 1px solid var(--color-border-default);
		border-radius: 8px;
		padding: 12px 16px;
		display: flex;
		align-items: center;
		gap: 12px;
		cursor: pointer;
		transition: all 0.2s cubic-bezier(0.1, 0.9, 0.2, 1);
		text-align: left;
		color: var(--color-fg-default);
		outline: none;
		width: 220px;
		box-sizing: border-box;
	}

	.recent-card:hover {
		background: var(--color-neutral-muted);
		border-color: var(--color-accent-fg);
		box-shadow: 0 4px 12px rgba(0, 0, 0, 0.08);
	}

	.recent-card:active {
		transform: scale(0.98);
	}

	.file-icon {
		opacity: 0.6;
		display: flex;
		align-items: center;
		justify-content: center;
	}

	.file-info {
		display: flex;
		flex-direction: column;
		overflow: hidden;
	}

	.file-name {
		font-size: 13px;
		font-weight: 500;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.file-path {
		font-size: 11px;
		opacity: 0.5;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		margin-top: 2px;
		direction: rtl;
		text-align: left;
	}

	/* `rtl` above keeps the end of a long path visible; a count is not a path, and rtl turns "3 个文件" into "个文件 3". */
	.file-count {
		direction: ltr;
	}

	.clear-btn {
		position: absolute;
		top: 4px;
		right: 4px;
		background: none;
		border: none;
		padding: 4px;
		cursor: pointer;
		opacity: 0;
		transition: opacity 0.2s;
		color: inherit;
		border-radius: 4px;
		display: flex;
		align-items: center;
		justify-content: center;
	}

	.recent-card:hover .clear-btn {
		opacity: 0.4;
	}

	.clear-btn:hover {
		opacity: 1 !important;
		background: rgba(255, 0, 0, 0.1);
	}

	.version-tag {
		position: absolute;
		bottom: 20px;
		left: 50%;
		transform: translateX(-50%);
		width: 100%;
		text-align: center;
		font-family: var(--win-font);
		font-size: 10px;
		opacity: 0.25;
		font-weight: 500;
		pointer-events: none;
	}
</style>
