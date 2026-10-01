<script lang="ts">
	import { fade, scale } from 'svelte/transition';
	import { t } from '../utils/i18n.js';
	import { settings } from '../stores/settings.svelte.js';

	let {
		show,
		title,
		message,
		kind = 'info',
		showSave = false,
		showInput = false,
		inputValue = $bindable(''),
		onconfirm,
		onsave,
		oncancel,
	} = $props<{
		show: boolean;
		title: string;
		message: string;
		kind?: 'info' | 'warning' | 'error';
		showSave?: boolean;
		showInput?: boolean;
		inputValue?: string;
		onconfirm: () => void;
		onsave?: () => void;
		oncancel: () => void;
	}>();

	let modalContent = $state<HTMLDivElement>();
	let inputElement = $state<HTMLInputElement>();
	let previousActiveElement: HTMLElement | null = null;

	$effect(() => {
		if (show) {
			previousActiveElement = document.activeElement as HTMLElement;
			setTimeout(() => {
				if (showInput && inputElement) {
					inputElement.focus();
					inputElement.select();
					return;
				}
				const focusable = modalContent?.querySelector('button.primary') as HTMLElement;
				if (focusable) {
					focusable.focus();
				} else {
					modalContent?.focus();
				}
			}, 50);
		} else if (previousActiveElement) {
			previousActiveElement.focus();
		}
	});

	function handleKeydown(e: KeyboardEvent) {
		// While the user is typing in the input, plain letters are text —
		// the y/n confirm/cancel shortcuts must not fire.
		const typingInInput = showInput && e.target === inputElement;
		if (e.key === 'Escape') {
			e.preventDefault();
			oncancel();
		}
		if (e.key === 'Enter') {
			e.preventDefault();
			if (showSave && onsave) {
				onsave();
			} else {
				onconfirm();
			}
		}
		if (!typingInInput && e.key.toLowerCase() === 'y' && !e.ctrlKey && !e.altKey && !e.metaKey) {
			e.preventDefault();
			onconfirm();
		}
		if (!typingInInput && e.key.toLowerCase() === 'n' && !e.ctrlKey && !e.altKey && !e.metaKey) {
			e.preventDefault();
			oncancel();
		}
		if (e.ctrlKey && e.key === 's' && showSave && onsave) {
			e.preventDefault();
			onsave();
		}

		// Focus trap
		if (e.key === 'Tab') {
			const focusableElements = modalContent?.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])') || [];
			if (focusableElements.length === 0) return;
			const first = focusableElements[0] as HTMLElement;
			const last = focusableElements[focusableElements.length - 1] as HTMLElement;

			if (e.shiftKey) {
				if (document.activeElement === first) {
					e.preventDefault();
					last.focus();
				}
			} else {
				if (document.activeElement === last) {
					e.preventDefault();
					first.focus();
				}
			}
		}
	}

	function handleBackdropClick() {
		oncancel();
	}
</script>

{#if show}
	<div
		class="modal-backdrop"
		transition:fade={{ duration: 150 }}
		onclick={handleBackdropClick}
		oncontextmenu={(e) => {
			// The prompt input needs the webview's Cut/Copy/Paste menu.
			if ((e.target as HTMLElement).closest('input, textarea')) return;
			e.preventDefault();
			e.stopPropagation();
		}}
		role="presentation">
		<div
			class="modal-content {kind}"
			bind:this={modalContent}
			transition:scale={{ duration: 200, start: 0.95 }}
			onclick={(e) => e.stopPropagation()}
			role="dialog"
			aria-modal="true"
			tabindex="-1"
			onkeydown={handleKeydown}>
			<div class="modal-header">
				<h3>{title}</h3>
			</div>
			<div class="modal-body">
				<p>{message}</p>
				{#if showInput}
					<input class="modal-input" type="text" bind:this={inputElement} bind:value={inputValue} spellcheck="false" />
				{/if}
			</div>
			<div class="modal-footer">
					<button class="modal-btn secondary" onclick={oncancel}>{t('settings.cancel', settings.language)}</button>
					<div class="footer-spacer"></div>
					<button class="modal-btn secondary" onclick={onconfirm}>
						{kind === 'warning' ? t('settings.discard', settings.language) : t('settings.save', settings.language)}
					</button>
					{#if showSave}
						<button class="modal-btn primary" onclick={onsave}>{t('settings.save', settings.language)}</button>
					{/if}
				</div>
		</div>
	</div>
{/if}

<style>
	.modal-backdrop {
		position: fixed;
		top: 0;
		left: 0;
		right: 0;
		bottom: 0;
		background: rgba(0, 0, 0, 0.4);
		display: flex;
		align-items: center;
		justify-content: center;
		z-index: 30000;
	}

	.modal-content {
		background: var(--color-canvas-default);
		border: 1px solid var(--color-border-default);
		border-radius: 6px;
		width: 400px;
		max-width: 90vw;
		box-shadow: 0 20px 50px rgba(0, 0, 0, 0.3);
		overflow: hidden;
		font-family: var(--win-font);
	}

	.modal-header {
		padding: 20px 24px 12px 24px;
	}

	.modal-header h3 {
		margin: 0;
		font-size: 16px;
		font-weight: 600;
		color: var(--color-fg-default);
	}

	.modal-body {
		padding: 0 24px 24px 24px;
	}

	.modal-body p {
		margin: 0;
		font-size: 14px;
		line-height: 1.5;
		color: var(--color-fg-muted);
	}

	.modal-input {
		margin-top: 12px;
		width: 100%;
		box-sizing: border-box;
		padding: 6px 10px;
		font-size: 14px;
		font-family: inherit;
		color: var(--color-fg-default);
		background: var(--color-canvas-default);
		border: 1px solid var(--color-border-default);
		border-radius: 6px;
		outline: none;
	}

	.modal-input:focus {
		border-color: var(--color-accent-fg);
	}

	.modal-footer {
		padding: 16px 24px;
		background: var(--color-canvas-subtle);
		display: flex;
		align-items: center;
		justify-content: flex-end;
		gap: 8px;
		border-top: 1px solid var(--color-border-muted);
	}

	.footer-spacer {
		flex: 1;
	}

	.modal-btn {
		padding: 6px 16px;
		border-radius: 6px;
		font-size: 14px;
		font-weight: 500;
		cursor: pointer;
		transition: all 0.1s;
		border: 1px solid transparent;
		font-family: inherit;
	}

	.modal-btn.secondary {
		background: transparent;
		color: var(--color-fg-default);
		border-color: var(--color-border-default);
	}

	.modal-btn.secondary:hover {
		background: var(--color-neutral-muted);
	}

	.modal-btn.primary {
		background: var(--color-accent-fg);
		color: var(--color-btn-fg);
	}

	.modal-btn.primary.warning {
		background: #d73a49;
	}

	.modal-btn.primary:hover {
		filter: brightness(1.1);
	}
</style>
