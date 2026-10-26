<script lang="ts">
	import { settings } from '../stores/settings.svelte.js';
	import { t } from '../utils/i18n.js';
	import { TocNavigator } from '../stores/tocNavigator.svelte.js';
	import { buildTocEntries, tocFingerprint, type TocItem } from '../utils/tocEntries.js';
	import type { RendererLine } from '../utils/lineCoordinates.js';

	let { markdownBody, contentRoot, previewRevision, activeLine = null, onBeforeJump, foldOverrides, ontoggleFold, oncopyref, oncontext, onjump, onshowTooltip, onhideTooltip } = $props<{
		/**
		 * The `.markdown-body` article — the scrolling box, and nothing else.
		 * Every jump and the scroll listener go through this one.
		 */
		markdownBody: HTMLElement | null;
		/**
		 * The active tab's `.markdown-blocks`, which is where the headings
		 * actually are. The article holds one host per open tab and all but one
		 * are `display: none`, so an outline scanned from the article would list
		 * every open document's headings at once. The two are separate props
		 * because this component needs both halves and they are different
		 * elements: read the outline out of the host, scroll the article.
		 */
		contentRoot: HTMLElement | null;
		/**
		 * How many documents the preview DOM has been given. Read as a signal and
		 * never for its value: it says the article now HOLDS the document, which
		 * is the thing this component has to wait for before it reads the DOM.
		 *
		 * It used to be `htmlContent`, the rendered string itself. That says a
		 * document was rendered, not that it reached the article, and on a mount
		 * the two are a step apart — a child's effects run before its parent's,
		 * so the scan below ran before the patch that fills the article and read
		 * an empty one. Nothing changed the string afterwards, so nothing asked
		 * for a second look.
		 */
		previewRevision: number;
		/**
		 * The source line at the top of the EDITOR's viewport, or `null` when the
		 * outline should follow the preview alone (the setting is off, or nothing
		 * is being edited). See `tocFollow.ts`.
		 */
		activeLine?: RendererLine | null;
		onBeforeJump?: () => void;
		foldOverrides?: Set<string>;
		ontoggleFold?: (key: string) => void;
		oncopyref?: (text: string, slug: string) => void;
		oncontext?: (e: MouseEvent, item: TocItem) => void;
		onjump?: (id: string, text: string, sourceLine: RendererLine | null) => void;
		onshowTooltip?: (e: MouseEvent, text: string, shortcut?: string, align?: 'top' | 'right' | 'left' | 'below') => void;
		onhideTooltip?: () => void;
	}>();

	let items = $state<TocItem[]>([]);
	/**
	 * What `items` currently holds, for deciding whether the scan changed
	 * anything.
	 *
	 * Kept here rather than recomputed from `items` inside the effect, because
	 * reading a `$state` there makes the effect depend on itself: assigning
	 * `items` scheduled the effect again, and every render that changed the
	 * outline scanned the whole document twice.
	 */
	let itemsFingerprint = '';
	let tocContainer: HTMLElement | null = $state(null);
	const outline = new TocNavigator(() => tocContainer);

	/**
	 * Whether the entries about to be rendered belong to a different document
	 * than the ones on screen, and so must not be animated into place.
	 *
	 * `transition:slide` on each entry is for the outline changing WITHIN a
	 * document — folding a section away takes its headings with it, and they
	 * should leave the way they arrived. A tab switch replaces the list wholly:
	 * every old entry plays its outro and every new one its intro, 240ms of the
	 * outline churning for a gesture that only asked to see another document.
	 *
	 * The signal is the host's identity, not a flag the viewer passes down.
	 * There is one `.markdown-blocks` per open tab, so `contentRoot` changing to
	 * a different element IS the switch, observed at the only moment that
	 * matters — the scan that produces the new list. A flag would have to be
	 * raised and lowered around that moment by someone else, and a window with
	 * two ends is one an interrupted switch can leave open.
	 */
	let scannedRoot: HTMLElement | null = null;
	let documentChanged = $state(false);

	$effect(() => {
		// The dependency, and the whole reason this runs. An empty document is
		// not a special case: the scan below finds nothing in it and clears the
		// outline the same way a document with no headings does.
		void previewRevision;

		documentChanged = contentRoot !== scannedRoot;
		scannedRoot = contentRoot;

		if (contentRoot) {
			const result = buildTocEntries(contentRoot);

			const newFingerprint = tocFingerprint(result);
			if (newFingerprint !== itemsFingerprint) {
				itemsFingerprint = newFingerprint;
				items = result;
			}
		} else if (itemsFingerprint !== '') {
			itemsFingerprint = '';
			items = [];
		}
	});

	function checkTruncation(node: HTMLElement) {
		const handleMouseOver = () => {
			if (node.scrollWidth > node.clientWidth) {
				node.title = node.innerText;
			} else {
				node.removeAttribute('title');
			}
		};
		node.addEventListener('mouseover', handleMouseOver);
		return {
			destroy() {
				node.removeEventListener('mouseover', handleMouseOver);
			}
		};
	}

	let visibleItems = $derived.by(() => {
		let result = [];
		let hideUntilLevel = 99;
		for (const item of items) {
			if (item.isBlock) {
				if (hideUntilLevel === 99) result.push(item);
				continue;
			}
			if (item.level > hideUntilLevel) continue;
			result.push(item);
			hideUntilLevel = foldOverrides?.has(item.foldKey) ? item.level : 99;
		}
		return result;
	});

	$effect(() => {
		const line = activeLine;
		outline.follow(line, () => visibleItems);
	});

	$effect(() => {
		const el: HTMLElement | null = markdownBody;
		if (el) return outline.listen(el);
	});

	import { slide } from 'svelte/transition';
	import { cubicOut } from 'svelte/easing';

	function jumpTo(id: string) {
		outline.jumpTo(id, { contentRoot, markdownBody, items, onBeforeJump, onjump });
	}
</script>

<div class="toc-container" bind:this={tocContainer}>
	<div class="toc-header" class:on-right={settings.tocSide === 'right'}>
		<button 
			class="toc-header-btn {settings.pinnedToc ? 'active' : ''}" 
			onclick={() => { settings.pinnedToc = !settings.pinnedToc; onhideTooltip?.(); }}
			onmouseenter={(e) => onshowTooltip?.(e, settings.pinnedToc ? t('tooltip.undock', settings.language) : t('tooltip.dock', settings.language), undefined, 'below')}
			onmouseleave={() => onhideTooltip?.()}
			aria-label={settings.pinnedToc ? t('tooltip.undockToc', settings.language) : t('tooltip.dockToc', settings.language)}>
			{#if settings.tocSide === 'left'}
				<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
					<rect width="18" height="18" x="3" y="3" rx="2" />
					<path d="M9 3v18" />
					{#if !settings.pinnedToc}
						<path d="m14 9-3 3 3 3" />
					{/if}
				</svg>
			{:else}
				<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
					<rect width="18" height="18" x="3" y="3" rx="2" />
					<path d="M15 3v18" />
					{#if !settings.pinnedToc}
						<path d="m10 9 3 3-3 3" />
					{/if}
				</svg>
			{/if}
		</button>
		<button 
			class="toc-header-btn" 
			onclick={() => { settings.toggleTocSide(); onhideTooltip?.(); }}
			onmouseenter={(e) => onshowTooltip?.(e, t('tooltip.switchSide', settings.language), undefined, 'below')}
			onmouseleave={() => onhideTooltip?.()}
			aria-label={t('tooltip.switchSide', settings.language)}>
			<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
				<path d="m18 8 4 4-4 4"></path>
				<path d="M2 12h20"></path>
				<path d="m6 8-4 4 4 4"></path>
			</svg>
		</button>
	</div>
	{#if visibleItems.length > 0}
		<ul class="toc-list">
			{#each visibleItems as item (item.id)}
				<li 
					transition:slide={{ duration: documentChanged ? 0 : 240, easing: cubicOut }}
					class="toc-item {item.isBlock ? 'block-item' : `level-${item.level}`}" 
					style="padding-left: {(Math.max(1, item.level || 2) - 1) * 10 + 8}px !important">
					{#if item.isBlock}
					<button
						class="toc-link toc-block {outline.activeId === item.id ? 'active' : ''}"
						data-id={item.id}
						onclick={() => jumpTo(item.id)}
						use:checkTruncation>
						<svg class="block-icon" viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
							<path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/>
						</svg>
						{item.text}
					</button>
					{:else}
						<div class="toc-link-wrapper level-{item.level}">
							<button aria-label={t('tooltip.toggleFold', settings.language)} class="toc-fold-btn {foldOverrides?.has(item.foldKey) ? 'collapsed' : ''}" style={item.hasChildren ? '' : 'visibility: hidden'} onclick={(e) => { e.stopPropagation(); ontoggleFold?.(item.foldKey); }}>
								<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"></polyline></svg>
							</button>
							<button
								class="toc-link {outline.activeId === item.id ? 'active' : ''}"
								data-id={item.id}
								onclick={() => jumpTo(item.id)}
								oncontextmenu={(e) => { e.preventDefault(); e.stopPropagation(); oncontext ? oncontext(e, item) : oncopyref?.(item.text, item.id); }}
								use:checkTruncation>
								{item.text}
							</button>
						</div>
					{/if}
				</li>
			{/each}
		</ul>
	{:else}
		<div class="toc-empty">{t('toc.noHeadingsFound', settings.language)}</div>
	{/if}
</div>

<style>
	.toc-container {
		width: 100%;
		flex-shrink: 0;
		height: 100%;
		background-color: transparent;
		display: flex;
		flex-direction: column;
		overflow: hidden;
		font-family: var(--win-font);
		position: relative;
	}

	.toc-container::before {
		display: none;
	}

	.toc-header {
		display: flex;
		justify-content: flex-end;
		gap: 4px;
		padding: 10px 14px;
		z-index: 60;
		flex-shrink: 0;
	}

	.toc-header.on-right {
		justify-content: flex-start;
	}

	.toc-header-btn {
		background: none;
		border: none;
		padding: 6px;
		cursor: pointer;
		color: var(--color-fg-muted);
		opacity: 0.7;
		border-radius: 4px;
		transition: opacity 0.2s, background-color 0.2s, color 0.2s;
		display: flex;
		align-items: center;
		justify-content: center;
		pointer-events: auto;
	}

	.toc-container:hover .toc-header-btn {
		opacity: 0.8;
	}

	.toc-header-btn:hover {
		opacity: 1 !important;
		background-color: var(--color-canvas-subtle);
		color: var(--color-fg-default);
	}

	.toc-header-btn.active {
		opacity: 0.8;
		background-color: var(--color-canvas-subtle);
	}

	.toc-list {
		margin: 0;
		padding: 0 0 16px;
		list-style: none;
		overflow-y: auto;
		overflow-x: hidden;
		scrollbar-gutter: stable;
		flex: 1;
		direction: rtl; /* move scrollbar to left */
		display: flex;
		flex-direction: column;
		-webkit-mask-image: linear-gradient(to bottom, transparent, black 8px, black calc(100% - 20px), transparent);
		mask-image: linear-gradient(to bottom, transparent, black 8px, black calc(100% - 20px), transparent);
	}

	.toc-empty {
		padding: 16px;
		color: var(--color-fg-muted);
		font-size: 13px;
		text-align: center;
	}

	.toc-item {
		padding: 1px 0;
		direction: ltr; /* keep text content ltr */
		width: 100%;
		box-sizing: border-box;
		overflow-x: hidden;
		flex-shrink: 0;
	}

	.toc-link-wrapper {
		display: flex;
		align-items: center;
		width: 100%;
	}

	.toc-fold-btn {
		background: none;
		border: none;
		padding: 4px;
		cursor: pointer;
		opacity: 0.5;
		color: var(--color-fg-muted);
		display: flex;
		align-items: center;
		justify-content: center;
		transition: transform 0.2s ease, opacity 0.2s ease;
		border-radius: 4px;
		flex-shrink: 0;
		flex-grow: 0;
		width: 24px;
		height: 24px;
		box-sizing: border-box;
		margin: 0;
	}

	.toc-item:hover .toc-fold-btn, .toc-fold-btn.collapsed {
		opacity: 0.8;
	}

	.toc-fold-btn:hover {
		opacity: 1 !important;
	}

	.toc-fold-btn.collapsed {
		transform: rotate(-90deg);
	}

	.toc-link {
		display: block;
		width: 100%;
		text-align: left;
		background: none;
		border: none;
		padding: 3px 16px 3px 4px;
		color: var(--color-fg-muted);
		font-size: 13px;
		cursor: pointer;
		transition: color 0.1s ease;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
		font-family: inherit;
		line-height: 20px;
		outline: none;
		user-select: none;
	}

	.toc-link:active {
		transform: none !important;
	}

	.toc-link:hover {
		color: var(--color-fg-default);
	}

	.toc-link.active {
		color: var(--color-fg-default);
		text-shadow: 0.5px 0 0 currentColor;
	}

	.toc-block {
		display: flex;
		align-items: center;
		gap: 5px;
		padding-left: 16px;
		font-size: 12.5px;
	}

	.block-icon {
		flex-shrink: 0;
		opacity: 0.4;
	}

	.level-1 .toc-link { font-weight: 500; font-size: 13px; }
	.level-3 .toc-link { font-size: 12.5px; }
	.level-4 .toc-link { font-size: 12px; opacity: 0.9; }
	.level-5 .toc-link { font-size: 12px; opacity: 0.8; }
	.level-6 .toc-link { font-size: 12px; opacity: 0.7; }
</style>
