import { untrack } from 'svelte';

import { settings } from './settings.svelte.js';
import { jumpScrollBehavior } from '../utils/motion.js';
import { anchorScrollTop } from '../utils/previewAnchor.js';
import type { RendererLine } from '../utils/lineCoordinates.js';
import type { TocItem } from '../utils/tocEntries.js';
import { activeTocIdForLine, sourceLineOf } from '../utils/tocFollow.js';

/** How long a jump's own smooth scroll is given to settle. */
export const CLICK_LOCK_MS = 600;

export interface TocJump {
	contentRoot: HTMLElement | null;
	markdownBody: HTMLElement | null;
	items: readonly TocItem[];
	onBeforeJump?: () => void;
	onjump?: (id: string, text: string, sourceLine: RendererLine | null) => void;
}

/**
 * The outline's current entry, its jumps, and the highlight a jump leaves on
 * its target in the preview. `Toc.svelte` renders it and wires its effects
 * through it.
 */
export class TocNavigator {
	activeId = $state<string | null>(null);

	// when user clicks a toc entry, lock active id until scroll catches up
	private clickLock: string | null = null;
	private clickLockTimer: ReturnType<typeof setTimeout> | null = null;
	private activeTargetEl: HTMLElement | null = null;

	constructor(private readonly tocContainer: () => HTMLElement | null) {}

	/**
	 * Drop the "you jumped here" highlight.
	 *
	 * It is a temporary emphasis, so it has to end on anything that means the
	 * reader has moved on. Hanging it off scrolling alone made it permanent
	 * whenever that one event did not arrive — the jump's own smooth scroll is
	 * swallowed by `clickLock`, and if nothing scrolls the preview afterwards
	 * there is no second chance.
	 */
	private clearTargetHighlight() {
		if (!this.activeTargetEl) return;

		this.activeTargetEl.classList.remove('toc-target-active');
		this.activeTargetEl = null;
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
	private releaseStrandedHighlight(el: HTMLElement) {
		const stranded = this.activeTargetEl;
		if (!stranded) return;
		this.activeTargetEl = null;

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
		if (this.clickLock) setTimeout(listen, CLICK_LOCK_MS);
		else listen();
	}

	private handleScroll = () => {
		// The lock is here for the jump's OWN smooth scroll, which would
		// otherwise clear the highlight before the reader has seen it.
		if (this.clickLock) return;
		this.clearTargetHighlight();
	};

	/**
	 * A deliberate action by the reader, which the lock must not swallow: the
	 * lock exists to ignore scrolling the app itself caused, and a click or a
	 * keystroke is never that.
	 */
	private handleReaderAction = () => {
		this.clearTargetHighlight();
	};

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
	private scrollTocIntoView() {
		const tocContainer = this.tocContainer();
		if (tocContainer && this.activeId) {
			const activeEl = tocContainer.querySelector(`[data-id="${CSS.escape(this.activeId)}"]`);
			if (activeEl) activeEl.scrollIntoView({ block: 'center', behavior: 'smooth' });
		}
	}

	/**
	 * Which entry the reader is on, from whichever pane they are scrolling.
	 * Run inside an `$effect`: `line` is its input, and `visibleItems` is read
	 * only once the lock lets it through.
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
	follow(line: RendererLine | null, visibleItems: () => readonly TocItem[]) {
		if (line === null || this.clickLock) return;

		const next = activeTocIdForLine(visibleItems(), line);
		if (next === null || next === untrack(() => this.activeId)) return;

		this.activeId = next;
		untrack(() => this.scrollTocIntoView());
	}

	/** Attach to the preview's scrolling box; the return value detaches. */
	listen(el: HTMLElement): () => void {
		// Capture the element the listener was attached to: the cleanup must
		// detach from that same node, not from whatever `markdownBody` points at
		// when the effect re-runs (a changed prop would leak the old listener, a
		// null prop would throw).
		el.addEventListener('scroll', this.handleScroll, { passive: true });
		// `pointerdown`, not `click`: clicking a link inside the preview
		// navigates, and the click never completes on the element that
		// carried the highlight.
		el.addEventListener('pointerdown', this.handleReaderAction, { passive: true });
		// On the window, because after a jump the focus can be in either
		// pane or in neither — the reader typing anywhere has moved on.
		window.addEventListener('keydown', this.handleReaderAction, { passive: true });
		return () => {
			el.removeEventListener('scroll', this.handleScroll);
			el.removeEventListener('pointerdown', this.handleReaderAction);
			window.removeEventListener('keydown', this.handleReaderAction);
			this.releaseStrandedHighlight(el);
		};
	}

	jumpTo(id: string, { contentRoot, markdownBody, items, onBeforeJump, onjump }: TocJump) {
		const el = contentRoot?.querySelector(`[id="${CSS.escape(id)}"]`) as HTMLElement | null;
		if (el && markdownBody) {
			onBeforeJump?.();
			// lock active id immediately so scroll handler doesn't override
			this.clickLock = id;
			this.activeId = id;
			this.scrollTocIntoView();

			const item = items.find(i => i.id === id);
			if (item) onjump?.(id, item.text, sourceLineOf(el.dataset.sourcepos));

			// highlight element persistently until scroll
			this.clearTargetHighlight();
			el.classList.add('toc-target-active');
			this.activeTargetEl = el;

			markdownBody.scrollTo({
				top: anchorScrollTop(markdownBody, el),
				behavior: jumpScrollBehavior(settings.animateJumpScroll),
			});

			// release lock after scroll settles
			if (this.clickLockTimer) clearTimeout(this.clickLockTimer);
			this.clickLockTimer = setTimeout(() => { this.clickLock = null; }, CLICK_LOCK_MS);
		}
	}
}
