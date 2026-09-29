<script lang="ts">
	export type ContextMenuItem = {
		label?: string;
		shortcut?: string;
		disabled?: boolean;
		onClick?: () => void;
		onHover?: () => void;
		separator?: boolean;
	};

	let { show, x, y, items, onhide } = $props<{
		show: boolean;
		x: number;
		y: number;
		items: ContextMenuItem[];
		onhide: () => void;
	}>();

	let menuEl = $state<HTMLDivElement>();
	let innerWidth = $state(1000);
	let innerHeight = $state(1000);

	/**
	 * Escape closes the menu, and it listens on the window rather than on the
	 * menu itself.
	 *
	 * The menu used to focus itself so its own `keydown` would fire. But this
	 * menu is opened by right-clicking the preview, and right-clicking a
	 * selection is how you copy or edit it — moving focus off the document
	 * stops the selection being painted, so the highlight vanished under the
	 * menu that was opened to act on it. Nothing else here wanted focus: there
	 * is no arrow-key navigation, and the overlay handles click-to-dismiss.
	 */
	$effect(() => {
		if (!show) return;

		const onKeydown = (e: KeyboardEvent) => {
			if (e.key === 'Escape') onhide();
		};

		window.addEventListener('keydown', onKeydown);
		return () => window.removeEventListener('keydown', onKeydown);
	});

	let adjustedX = $derived(menuEl && x + menuEl.offsetWidth > innerWidth ? innerWidth - menuEl.offsetWidth - 8 : x);
	let adjustedY = $derived(menuEl && y + menuEl.offsetHeight > innerHeight ? innerHeight - menuEl.offsetHeight - 8 : y);
</script>

<svelte:window bind:innerWidth bind:innerHeight />

{#if show}
	<!-- svelte-ignore a11y_click_events_have_key_events -->
	<!-- svelte-ignore a11y_no_static_element_interactions -->
	<div class="context-menu-overlay" onclick={onhide} oncontextmenu={(e) => { e.preventDefault(); e.stopPropagation(); onhide(); }}>
		<div
			class="context-menu show-dropdown"
			bind:this={menuEl}
			style="left: {adjustedX || x}px; top: {adjustedY || y}px;"
			onclick={(e) => e.stopPropagation()}
			oncontextmenu={(e) => { e.preventDefault(); e.stopPropagation(); }}
			role="menu"
			tabindex="-1">
			{#each items as item}
				{#if item.separator}
					<div class="menu-separator"></div>
				{:else}
					<button
						class="menu-item"
						disabled={item.disabled}
						onmouseenter={() => {
							if (!item.disabled) item.onHover?.();
						}}
						onclick={() => {
							if (!item.disabled && item.onClick) {
								item.onClick();
								onhide();
							}
						}}>
						<span class="action-label">{item.label}</span>
						{#if item.shortcut}
							<span class="menu-shortcut">{item.shortcut}</span>
						{/if}
					</button>
				{/if}
			{/each}
		</div>
	</div>
{/if}

<style>
	.context-menu-overlay {
		position: fixed;
		top: 0;
		left: 0;
		right: 0;
		bottom: 0;
		z-index: 10005;
	}

	.context-menu.show-dropdown {
		display: flex;
		flex-direction: column;
		align-items: stretch;
		gap: 1px;
		position: absolute;
		background-color: var(--color-canvas-default);
		border: 1px solid var(--color-border-default);
		border-radius: 6px;
		padding: 4px;
		box-shadow: 0 8px 24px rgba(0, 0, 0, 0.2);
		z-index: 10006;
		min-width: 180px;
		font-family: var(--win-font);
		animation: menuFade 0.1s ease-out;
		outline: none;
	}

	@keyframes menuFade {
		from {
			opacity: 0;
			transform: scale(0.95);
		}
		to {
			opacity: 1;
			transform: scale(1);
		}
	}

	.menu-item {
		width: 100%;
		justify-content: space-between;
		align-items: center;
		padding: 6px 12px;
		height: auto;
		font-size: 13px;
		color: var(--color-fg-default);
		font-family: inherit;
		background: transparent;
		border: none;
		border-radius: 4px;
		cursor: default;
		display: flex;
		gap: 16px;
	}

	.menu-item:hover:not(:disabled) {
		background: var(--color-neutral-muted);
	}

	.menu-item:disabled {
		opacity: 0.4;
	}

	.action-label {
		display: block;
		text-align: left;
		white-space: nowrap;
	}

	.menu-shortcut {
		color: var(--color-fg-muted);
		font-size: 12px;
		white-space: nowrap;
	}

	.menu-separator {
		height: 1px;
		background: var(--color-border-muted);
		margin: 4px 0;
	}
</style>
