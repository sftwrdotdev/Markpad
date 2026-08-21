<script lang="ts">
	import type * as Monaco from 'monaco-editor';

	/**
	 * Side-by-side view of what is on disk against what the buffer holds.
	 *
	 * The conflict bar asks a question with an irreversible answer — Reload
	 * replaces the buffer and `setValue` clears the undo stack with it — and
	 * used to ask it without showing what would be lost. VS Code and Sublime
	 * both put a Compare beside the same two choices; this is that third
	 * option, offering them again once the user has seen the difference.
	 *
	 * Monaco is dynamically imported, exactly as `Editor.svelte` does it, so
	 * this costs nothing until the overlay is opened. The chunk is already in
	 * the bundle by then.
	 */
	let {
		show = false,
		onDisk = '',
		mine = '',
		language = 'markdown',
		labels,
		onclose,
		onreload,
		onkeep,
	}: {
		show?: boolean;
		onDisk?: string;
		mine?: string;
		language?: string;
		labels: { onDisk: string; mine: string; reload: string; keepMine: string; close: string };
		onclose: () => void;
		onreload: () => void;
		onkeep: () => void;
	} = $props();

	let host = $state<HTMLDivElement | null>(null);
	let editor: Monaco.editor.IStandaloneDiffEditor | null = null;
	let models: Monaco.editor.ITextModel[] = [];

	function dispose() {
		editor?.dispose();
		editor = null;
		for (const model of models) model.dispose();
		models = [];
	}

	$effect(() => {
		const element = host;
		const original = onDisk;
		const modified = mine;
		const languageId = language;
		if (!show || !element) {
			dispose();
			return;
		}

		let cancelled = false;
		(async () => {
			const monaco = await import('monaco-editor');
			if (cancelled) return;
			dispose();
			// Models of its own rather than the tab's: this view must not be
			// able to touch the document, and handing it the live model would
			// put a second editor on a buffer that `Editor.svelte` owns.
			const left = monaco.editor.createModel(original, languageId);
			const right = monaco.editor.createModel(modified, languageId);
			models = [left, right];
			editor = monaco.editor.createDiffEditor(element, {
				readOnly: true,
				originalEditable: false,
				automaticLayout: true,
				renderSideBySide: true,
				scrollBeyondLastLine: false,
				minimap: { enabled: false },
			});
			editor.setModel({ original: left, modified: right });
		})();

		return () => {
			cancelled = true;
			dispose();
		};
	});

	function onKeyDown(event: KeyboardEvent) {
		if (event.key === 'Escape') {
			event.stopPropagation();
			onclose();
		}
	}
</script>

<svelte:window on:keydown={show ? onKeyDown : undefined} />

{#if show}
	<div class="diff-overlay" role="dialog" aria-modal="true">
		<div class="diff-head">
			<span class="diff-label">{labels.onDisk}</span>
			<span class="diff-label">{labels.mine}</span>
			<div class="diff-actions">
				<button class="diff-action" onclick={onreload}>{labels.reload}</button>
				<button class="diff-action primary" onclick={onkeep}>{labels.keepMine}</button>
				<button class="diff-action" onclick={onclose}>{labels.close}</button>
			</div>
		</div>
		<div class="diff-body" bind:this={host}></div>
	</div>
{/if}

<style>
	.diff-overlay {
		position: fixed;
		inset: 36px 0 0 0;
		z-index: 40001;
		display: flex;
		flex-direction: column;
		background: var(--color-canvas-default);
	}

	.diff-head {
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 8px 14px;
		border-bottom: 1px solid var(--color-border-default);
		font-size: 12px;
		color: var(--color-fg-muted);
	}

	.diff-label {
		flex: 1;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.diff-actions {
		display: flex;
		gap: 8px;
		flex: none;
	}

	.diff-action {
		padding: 4px 10px;
		border: 1px solid var(--color-border-default);
		border-radius: 6px;
		background: var(--color-canvas-subtle);
		color: var(--color-fg-default);
		font-size: 12px;
		cursor: pointer;
	}

	.diff-action.primary {
		background: var(--color-accent-fg, #0969da);
		border-color: var(--color-accent-fg, #0969da);
		color: #fff;
	}

	.diff-body {
		flex: 1;
		min-height: 0;
	}
</style>
