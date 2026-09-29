/**
 * The view mode switch's slide: panes move across the window without their
 * text re-wrapping.
 *
 * The layout jumps to its final widths in one frame and only `transform`
 * animates, so text never re-wraps mid-slide and the reading position can be
 * restored at once (`restoreAfterLeavingEditor`).
 *
 * - The pane that appears slides in from its outer edge, and the splitter rides
 *   on its inner edge, so the divider still travels across the window.
 * - The pane that leaves has no width any more. The preview stays mounted, so
 *   it is pinned at its old box for the slide. The editor's content unmounts,
 *   so a static copy slides instead: Monaco renders only the visible lines, so
 *   the copy is small. The splitter unmounts too and is copied the same way.
 * - With a pane sliding in over it, the leaving one stays put underneath.
 *   Otherwise it slides out and uncovers the pane that widened.
 */

type PaneSide = 'editor' | 'viewer';
export type PanesShown = { editor: boolean; viewer: boolean };
type PaneSlidePlan = { entering: PaneSide | null; leaving: PaneSide | null };

const PANE_SLIDE: KeyframeAnimationOptions = { duration: 300, easing: 'cubic-bezier(0.16, 1, 0.3, 1)' };

/** Which pane comes and which goes; null when the same panes stay on screen. */
export function planPaneSlide(last: PanesShown, now: PanesShown): PaneSlidePlan | null {
	const entering = !last.editor && now.editor ? 'editor' : !last.viewer && now.viewer ? 'viewer' : null;
	const leaving = last.editor && !now.editor ? 'editor' : last.viewer && !now.viewer ? 'viewer' : null;
	return entering || leaving ? { entering, leaving } : null;
}

/** +1 when the pane's outer edge is the window's right edge, -1 for the left. */
export function outwardSign(side: PaneSide, editorOnRight: boolean): 1 | -1 {
	return (side === 'editor') === editorOnRight ? 1 : -1;
}

type Box = { left: number; top: number; width: number; height: number };
type Panes = { container: HTMLElement; editor: HTMLElement; viewer: HTMLElement };

const PINNED = ['position', 'left', 'top', 'width', 'height', 'flex', 'opacity', 'z-index', 'pointer-events'];

function boxIn(el: HTMLElement, container: HTMLElement): Box {
	const r = el.getBoundingClientRect();
	const o = container.getBoundingClientRect();
	return { left: r.left - o.left, top: r.top - o.top, width: r.width, height: r.height };
}

// `!important` because the mode rules hide a pane with `width: 0 !important`.
function pin(el: HTMLElement, box: Box, z: number) {
	const values: Record<string, string> = {
		position: 'absolute', left: `${box.left}px`, top: `${box.top}px`, width: `${box.width}px`,
		height: `${box.height}px`, flex: 'none', opacity: '1', 'z-index': String(z), 'pointer-events': 'none',
	};
	for (const k of PINNED) el.style.setProperty(k, values[k], 'important');
}

function unpin(el: HTMLElement) {
	for (const k of PINNED) el.style.removeProperty(k);
}

function copyOf(el: HTMLElement, container: HTMLElement, keepClass: boolean): HTMLElement {
	const box = boxIn(el, container);
	const copy = el.cloneNode(true) as HTMLElement;
	// The editor pane's classes match the mode rules that collapse it.
	if (!keepClass) {
		copy.className = '';
		copy.style.cssText = 'display: flex; flex-direction: column; overflow: hidden; background: var(--color-canvas-default)';
	}
	copy.removeAttribute('tabindex');
	copy.setAttribute('aria-hidden', 'true');
	pin(copy, box, 5);
	return copy;
}

function splitter(container: HTMLElement): HTMLElement | null {
	return container.querySelector<HTMLElement>(':scope > .split-bar');
}

/**
 * One slide at a time. `capture` runs before the DOM update (it needs the old
 * boxes and the editor's content), `play` after it. A switch that arrives
 * mid-slide ends the running one first, so nothing is measured while pinned.
 */
export function createPaneSlider() {
	let pending: { plan: PaneSlidePlan; viewerBox: Box | null; editorCopy: HTMLElement | null; barCopy: HTMLElement | null } | null = null;
	let running: { animations: Animation[]; cleanup: () => void } | null = null;

	function settle() {
		const r = running;
		running = null;
		if (!r) return;
		for (const a of r.animations) a.cancel();
		r.cleanup();
	}

	function capture(panes: Panes, plan: PaneSlidePlan) {
		settle();
		const { container, editor, viewer } = panes;
		const bar = splitter(container);
		pending = {
			plan,
			viewerBox: plan.leaving === 'viewer' ? boxIn(viewer, container) : null,
			editorCopy: plan.leaving === 'editor' ? copyOf(editor, container, false) : null,
			barCopy: plan.leaving && bar ? copyOf(bar, container, true) : null,
		};
	}

	function play(panes: Panes) {
		const p = pending;
		pending = null;
		if (!p) return;
		const { container, editor, viewer } = panes;
		const { entering, leaving } = p.plan;
		const editorOnRight = container.classList.contains('editor-on-right');
		const animations: Animation[] = [];
		const raised: HTMLElement[] = [];
		const slide = (el: HTMLElement, from: number, to: number) =>
			animations.push(el.animate([{ transform: `translateX(${from}px)` }, { transform: `translateX(${to}px)` }], PANE_SLIDE));

		if (entering) {
			const pane = entering === 'editor' ? editor : viewer;
			const distance = outwardSign(entering, editorOnRight) * pane.getBoundingClientRect().width;
			const bar = leaving ? null : splitter(container);
			for (const el of [pane, bar]) {
				if (!el) continue;
				el.style.zIndex = '6';
				raised.push(el);
				slide(el, distance, 0);
			}
		}

		let pinnedViewer = false;
		if (leaving) {
			let el: HTMLElement | null = null;
			if (p.editorCopy) el = container.appendChild(p.editorCopy);
			else if (p.viewerBox) {
				pin(viewer, p.viewerBox, 5);
				pinnedViewer = true;
				el = viewer;
			}
			if (p.barCopy) container.appendChild(p.barCopy);
			// Under a pane sliding in, it stays put until that slide ends.
			if (!entering) {
				const distance = outwardSign(leaving, editorOnRight) * (el?.getBoundingClientRect().width ?? 0);
				for (const moving of [el, p.barCopy]) if (moving) slide(moving, 0, distance);
			}
		}

		const cleanup = () => {
			for (const el of raised) el.style.zIndex = '';
			if (pinnedViewer) unpin(viewer);
			p.editorCopy?.remove();
			p.barCopy?.remove();
		};
		const current = { animations, cleanup };
		running = current;
		Promise.all(animations.map((a) => a.finished)).then(
			() => { if (running === current) settle(); },
			() => {},
		);
	}

	return { capture, play, settle };
}
