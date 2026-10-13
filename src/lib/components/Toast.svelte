<script lang="ts">
	import { onMount } from 'svelte';
	import { fly, fade } from 'svelte/transition';
	import { settings } from '../stores/settings.svelte.js';
	import { t } from '../utils/i18n.js';

	let { message, type = 'info', sticky = false, onremove } = $props<{
		message: string;
		type?: 'info' | 'error' | 'warning';
		/** Stays until its owner removes it, for work that outlasts the timer. */
		sticky?: boolean;
		onremove: () => void;
	}>();

	onMount(() => {
		if (sticky) return;
		const timer = setTimeout(onremove, 3000);
		return () => clearTimeout(timer);
	});
</script>

<div 
	class="toast {type}" 
	in:fly={{ y: 20, duration: 300 }} 
	out:fade={{ duration: 200 }}
>
	<div class="toast-content">
		{#if type === 'error'}
			<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
		{:else if type === 'warning'}
			<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
		{:else}
			<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>
		{/if}
		<span class="message">{message}</span>
	</div>
	<button class="close-btn" onclick={onremove} aria-label={t('common.close', settings.language)}>
		<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
	</button>
</div>

<style>
	.toast {
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding: 10px 14px;
		background: rgba(32, 32, 32, 0.85);
		backdrop-filter: blur(12px);
		border: 1px solid rgba(255, 255, 255, 0.1);
		border-radius: 8px;
		color: #ffffff;
		min-width: 280px;
		max-width: 400px;
		box-shadow: 0 8px 32px rgba(0, 0, 0, 0.3);
		user-select: none;
		pointer-events: auto;
		margin-bottom: 8px;
	}

	.toast.error {
		border-left: 4px solid #f85149;
	}
	.toast.warning {
		border-left: 4px solid #d29922;
	}
	.toast.info {
		border-left: 4px solid #58a6ff;
	}

	.toast-content {
		display: flex;
		align-items: center;
		gap: 12px;
	}

	.message {
		font-family: var(--win-font, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif);
		font-size: 13.5px;
		font-weight: 400;
	}

	.close-btn {
		background: none;
		border: none;
		color: rgba(255, 255, 255, 0.5);
		cursor: pointer;
		padding: 4px;
		display: flex;
		align-items: center;
		justify-content: center;
		border-radius: 4px;
		transition: background 0.2s, color 0.2s;
	}

	.close-btn:hover {
		background: rgba(255, 255, 255, 0.1);
		color: #ffffff;
	}
</style>
