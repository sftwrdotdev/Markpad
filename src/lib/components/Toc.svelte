<script lang="ts">
	import { untrack } from 'svelte';

	import { settings } from '../stores/settings.svelte.js';
	import { t } from '../utils/i18n.js';
	import { activeTocIdForLine, sourceLineOf } from '../utils/tocFollow.js';
	import { foldKeyOf } from '../utils/foldState.js';
	import { anchorScrollTop } from '../utils/previewAnchor.js';
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

	interface TocItem {
		id: string;
		text: string;
		level: number;
		isBlock: boolean;
		hasChildren?: boolean;
		/**
		 * How the fold state names this heading — read off the rendered heading,
		 * never recomputed. The outline used to build its own `id || text`, which
		 * is not the renderer's answer for a heading whose text carries a block
		 * id: the outline strips the `^id` suffix and the renderer does not, so
		 * the two disagreed for exactly the headings nobody tests. `''` for a
		 * block anchor, which is not a fold.
		 */
		foldKey: string;
		/** Where this entry starts in the source, for following the editor. */
		line: RendererLine | null;
	}

	/**
	 * Everything the outline can show, in the order the document holds it.
	 *
	 * One query rather than three. `querySelectorAll` returns document order,
	 * so asking for the headings and the block anchors together IS the
	 * interleaving — this used to ask for each separately and then sort the two
	 * lists back together against a third walk (`[id]`, which matches every
	 * element in the document carrying one) built into a position map.
	 *
	 * That cost is per render, and a render is a keystroke. #632 stopped the
	 * preview rebuilding its article for one character; an outline that walks
	 * the whole of it three times regardless spends a good part of that back,
	 * and on the documents where the patch matters most — 7819 elements in
	 * `samples/stress-test.md` — it is the largest remaining full-document pass
	 * in the render.
	 */
	const ENTRY_SELECTOR = 'h1, h2, h3, h4, h5, h6, a[id].block-id-anchor, span[id].block-id-anchor';

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
	let activeId = $state<string | null>(null);
	let tocContainer: HTMLElement | null = $state(null);
	let activeTargetEl: HTMLElement | null = null;
	
	// when user clicks a toc entry, lock active id until scroll catches up
	let clickLock: string | null = null;
	let clickLockTimer: ReturnType<typeof setTimeout> | null = null;
	/** How long a jump's own smooth scroll is given to settle. */
	const CLICK_LOCK_MS = 600;

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
			const result: TocItem[] = [];

			const entries = contentRoot.querySelectorAll(ENTRY_SELECTOR) as NodeListOf<HTMLElement>;
			for (const el of Array.from(entries)) {
				if (el.classList.contains('block-id-anchor')) {
					result.push({ id: el.id, text: el.getAttribute('data-label') || el.id, foldKey: '', level: 0, isBlock: true, line: sourceLineOf(el.dataset.sourcepos) });
					continue;
				}

				// Everything the selector matches that is not a block anchor is a
				// heading, which is the only other thing it asks for.
				const h = el;
				let text = h.textContent || '';
				text = text.replace(/\s*\^[a-zA-Z0-9_-]+$/, '');
				const anchor = h.querySelector('a.anchor') as HTMLElement | null;
				const id = h.id || (anchor ? anchor.id : '');
				if (id) {
					result.push({ id, text: text.trim(), foldKey: foldKeyOf(h), level: parseInt(h.tagName[1], 10), isBlock: false, line: sourceLineOf(h.dataset.sourcepos) });
				}
			}

			for (let i = 0; i < result.length; i++) {
				const item = result[i];
				if (item.isBlock) continue;
				item.hasChildren = false;
				
				if (i + 1 < result.length) {
					const next = result[i+1];
					if (next.isBlock || next.level > item.level) {
						item.hasChildren = true;
					}
				}
			}

			const newFingerprint = result.map(i => `${i.id}-${i.text}-${i.level}-${i.line}`).join('|');
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
			if (item.level <= hideUntilLevel) {
				hideUntilLevel = 99;
				result.push(item);
				if (foldOverrides?.has(item.foldKey)) {
					hideUntilLevel = item.level;
				}
			} else {
				if (hideUntilLevel === 99) {
					result.push(item);
					if (foldOverrides?.has(item.foldKey)) {
						hideUntilLevel = item.level;
					}
				}
			}
		}
		return result;
	});

	/**
	 * The preview's scroll clears the highlight a click left on its target.
	 *
	 * Which entry is CURRENT is no longer decided here. This used to walk the
	 * visible entries, `querySelector` each one out of the preview and measure
	 * its box against the container — a lookup and a layout read per heading,
	 * per scroll event, and an answer only the preview could give. Both panes
	 * now send a source line instead (`activeLine`), and one rule picks the
	 * entry from it.
	 */
	/**
	 * Drop the "you jumped here" highlight.
	 *
	 * It is a temporary emphasis, so it has to end on anything that means the
	 * reader has moved on. Hanging it off scrolling alone made it permanent
	 * whenever that one event did not arrive — the jump's own smooth scroll is
	 * swallowed by `clickLock`, and if nothing scrolls the preview afterwards
	 * there is no second chance.
	 */
	function clearTargetHighlight() {
		if (!activeTargetEl) return;

		activeTargetEl.classList.remove('toc-target-active');
		activeTargetEl = null;
	}

	/**
	 * The highlight is worn by an element in the PREVIEW, which outlives this
	 * component. Going away while one is showing — the outline collapsing itself
	 * after a jump, or the reader hiding it by hand — used to leave that mark on
	 * the heading with nothing able to clear it: the listeners left with the
	 * component, and a later instance starts with its own `activeTargetEl` and
	 * cannot see what an earlier one marked. So hand the clearing over to
	 * listeners that belong to nobody, and take them all off the first time the
	 * reader moves.
	 */
	function releaseStrandedHighlight(el: HTMLElement) {
		const stranded = activeTargetEl;
		if (!stranded) return;
		activeTargetEl = null;

		const clear = () => {
			stranded.classList.remove('toc-target-active');
			el.removeEventListener('scroll', clear);
			el.removeEventListener('pointerdown', clear);
			window.removeEventListener('keydown', clear);
		};
		const listen = () => {
			el.addEventListener('scroll', clear, { passive: true });
			el.addEventListener('pointerdown', clear, { passive: true });
			window.addEventListener('keydown', clear, { passive: true });
		};

		// Exactly what `clickLock` is for, and the reason it cannot simply be
		// read here: the jump's own smooth scroll is still running, and it must
		// not be mistaken for the reader scrolling away from what they just
		// asked to see. The timer outlives the component, the lock does not.
		if (clickLock) setTimeout(listen, CLICK_LOCK_MS);
		else listen();
	}

	function handleScroll() {
		// The lock is here for the jump's OWN smooth scroll, which would
		// otherwise clear the highlight before the reader has seen it.
		if (clickLock) return;
		clearTargetHighlight();
	}

	/**
	 * A deliberate action by the reader, which the lock must not swallow: the
	 * lock exists to ignore scrolling the app itself caused, and a click or a
	 * keystroke is never that.
	 */
	function handleReaderAction() {
		clearTargetHighlight();
	}

	/**
	 * Keep the current entry in the MIDDLE of the outline, not merely on screen.
	 *
	 * `block: 'nearest'` scrolls the least it can get away with, so the outline
	 * sat still until the current entry crossed an edge and then jumped by one
	 * row — the reader saw the highlight walk down to the last visible line and
	 * stay pinned there, with no idea what came next. Centring costs the same
	 * one call and keeps the entries either side of where you are visible,
	 * which is the reason to look at an outline while scrolling at all.
	 */
	function scrollTocIntoView() {
		if (tocContainer && activeId) {
			const activeEl = tocContainer.querySelector(`[data-id="${CSS.escape(activeId)}"]`);
			if (activeEl) activeEl.scrollIntoView({ block: 'center', behavior: 'smooth' });
		}
	}

	/**
	 * Which entry the reader is on, from whichever pane they are scrolling.
	 *
	 * This is the whole of #169. The outline used to decide by rendered box,
	 * which only the preview has: in editor-only mode the preview never
	 * scrolls, and in split view it moves only while scroll sync is on, so the
	 * outline sat still. A source line is something both panes can produce, and
	 * resolving it is a comparison rather than a layout read.
	 *
	 * A click still wins until its own scroll settles — the same `clickLock`
	 * the preview's handler respected.
	 */
	$effect(() => {
		const line = activeLine;
		if (line === null || clickLock) return;

		const next = activeTocIdForLine(visibleItems, line);
		if (next === null || next === untrack(() => activeId)) return;

		activeId = next;
		untrack(scrollTocIntoView);
	});

	$effect(() => {
		// Capture the element the listener was attached to: the cleanup must
		// detach from that same node, not from whatever `markdownBody` points at
		// when the effect re-runs (a changed prop would leak the old listener, a
		// null prop would throw).
		const el: HTMLElement | null = markdownBody;
		if (el) {
			el.addEventListener('scroll', handleScroll, { passive: true });
			// `pointerdown`, not `click`: clicking a link inside the preview
			// navigates, and the click never completes on the element that
			// carried the highlight.
			el.addEventListener('pointerdown', handleReaderAction, { passive: true });
			// On the window, because after a jump the focus can be in either
			// pane or in neither — the reader typing anywhere has moved on.
			window.addEventListener('keydown', handleReaderAction, { passive: true });
			return () => {
				el.removeEventListener('scroll', handleScroll);
				el.removeEventListener('pointerdown', handleReaderAction);
				window.removeEventListener('keydown', handleReaderAction);
				releaseStrandedHighlight(el);
			};
		}
	});

	import { slide } from 'svelte/transition';
	import { cubicOut } from 'svelte/easing';

	function jumpTo(id: string) {
		const el = contentRoot?.querySelector(`[id="${CSS.escape(id)}"]`) as HTMLElement | null;
		if (el && markdownBody) {
			onBeforeJump?.();
			// lock active id immediately so scroll handler doesn't override
			clickLock = id;
			activeId = id;
			scrollTocIntoView();
			
			const item = items.find(i => i.id === id);
			if (item) onjump?.(id, item.text, sourceLineOf(el.dataset.sourcepos));

			// highlight element persistently until scroll
			clearTargetHighlight();
			el.classList.add('toc-target-active');
			activeTargetEl = el;

			markdownBody.scrollTo({ top: anchorScrollTop(markdownBody, el), behavior: 'smooth' });

			// release lock after scroll settles
			if (clickLockTimer) clearTimeout(clickLockTimer);
			clickLockTimer = setTimeout(() => { clickLock = null; }, CLICK_LOCK_MS);
		}
	}
</script>

<div class="toc-container" bind:this={tocContainer}>
	<div class="toc-header" class:on-right={settings.tocSide === 'right'}>
		<button 
			class="toc-header-btn {settings.pinnedToc ? 'active' : ''}" 
			onclick={() => { settings.togglePinnedToc(); onhideTooltip?.(); }}
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
						class="toc-link toc-block {activeId === item.id ? 'active' : ''}"
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
								class="toc-link {activeId === item.id ? 'active' : ''}"
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
