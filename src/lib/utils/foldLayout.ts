import { previewZoomFactor } from './previewAnchor.js';

const FOLD_WRAPPER_SELECTOR = '.foldable-content-wrapper';
const FOLD_CONTENT_SELECTOR = ':scope > .content-inner';

function updateFoldHeights(root: HTMLElement) {
	const wrappers = Array.from(root.querySelectorAll<HTMLElement>(FOLD_WRAPPER_SELECTOR));

	// Every `--fold-content-height` write invalidates layout, because
	// `styles.css` resolves that custom property into the wrapper's `height`.
	// So a `scrollHeight` read taken between two writes forces a synchronous
	// full-document reflow, and interleaving them costs one reflow per wrapper:
	// a long document with hundreds of foldable headings then drops frames on
	// every keystroke, since ResizeObserver reruns this on each render. Reads
	// and writes are therefore kept in separate passes, which caps the cost at
	// two reflows no matter how many wrappers there are.
	//
	// Reflow-driven height writes must also land instantly. The `height`
	// transition exists only to animate fold/unfold; letting it also animate
	// every resize leaves the expanded wrapper shorter than its content for
	// ~0.25s, so the following section overlaps the still-visible overflow.
	// The transition stays suppressed across the whole measure/write cycle and
	// is restored once the final heights are committed.
	const pending: { wrapper: HTMLElement; content: HTMLElement }[] = [];
	for (const wrapper of wrappers) {
		const content = wrapper.querySelector<HTMLElement>(FOLD_CONTENT_SELECTOR);
		if (!content) continue;

		// Write pass 1: drop the previous height so each wrapper is measured at
		// its natural size. A nested wrapper still pinned to a stale height
		// would otherwise distort its parent's measurement — the reason the
		// interleaved version had to walk innermost-first, which a batched read
		// pass cannot rely on. Collapsed wrappers keep `height: 0` from the more
		// specific `.is-collapsed` rule and stay collapsed throughout.
		wrapper.style.transition = 'none';
		wrapper.style.removeProperty('--fold-content-height');
		pending.push({ wrapper, content });
	}

	if (pending.length === 0) return;

	// Read pass: the first measurement commits the cleared heights with a single
	// reflow, and the remaining reads hit that same clean layout. No paint
	// happens mid-task, so the cleared state is never visible.
	//
	// Measure the layout height, not `scrollHeight`: KaTeX glyphs overhang
	// their box, so `scrollHeight` is up to ~7px taller and the wrapper would
	// grow past its content (see the fold-height rule in
	// singleImplementationConvention.test.ts). Nothing is clipped by the smaller
	// number: expanded wrappers are `overflow: visible`.
	//
	// Divide by the preview's CSS `zoom`: a rect is in viewport pixels, and
	// `height` has the zoom applied again (#807).
	const zoom = previewZoomFactor(root);
	const heights = pending.map(({ content }) => content.getBoundingClientRect().height / zoom);

	// Write pass 2: publish the measured heights without reading anything back.
	pending.forEach(({ wrapper }, index) => {
		wrapper.style.setProperty('--fold-content-height', `${heights[index]}px`);
	});

	// Single forced reflow commits every suppressed height write at once.
	void root.offsetHeight;

	for (const { wrapper } of pending) {
		wrapper.style.transition = '';
	}
}

export interface FoldLayoutObservation {
	/**
	 * Start watching the fold contents inside newly rendered markup.
	 *
	 * Called with the blocks `blockPatch.ts` just inserted, rather than with the
	 * whole article. The observation used to be torn down and rebuilt on every
	 * keystroke, which meant a document's every fold got a fresh
	 * ResizeObserver registration per character — and a fresh registration
	 * delivers an initial observation, so every fold re-measured whether or not
	 * anything about it had changed. A block nobody replaced now keeps the
	 * observer it already had. `observe` is idempotent, so re-registering a
	 * survivor costs nothing either.
	 */
	observe(scope: Element): void;
	stop(): void;
}

export function observeFoldLayout(root: HTMLElement): FoldLayoutObservation {
	let frame: number | null = null;

	const scheduleUpdate = () => {
		if (frame !== null) return;
		frame = requestAnimationFrame(() => {
			frame = null;
			updateFoldHeights(root);
		});
	};

	const observer = new ResizeObserver(scheduleUpdate);
	const observe = (scope: Element) => {
		// A block that just replaced another is not obliged to be the same height,
		// and every fold wrapper above it is still pinned to the height the old one
		// measured. For the frame it takes ResizeObserver to fire, `.content-inner`
		// — `overflow: visible` while expanded — spills past the box meant to hold
		// it, and the next section is overlapped. Rebuilding the article never
		// showed this: a fresh wrapper carries no inline property and lays out at
		// `auto`. Releasing puts the patch on that same footing, and the measured
		// height is republished below either way. A collapsed wrapper is unaffected
		// — its `height: 0` comes from the more specific `.is-collapsed` rule.
		for (let element = scope.parentElement; element; element = element.parentElement) {
			if (element.matches(FOLD_WRAPPER_SELECTOR)) {
				element.style.removeProperty('--fold-content-height');
			}
		}

		// `querySelectorAll` never returns the node it was called on, and a block
		// the patch inserted can itself be the wrapper.
		if (scope.matches(FOLD_WRAPPER_SELECTOR)) {
			const own = scope.querySelector<HTMLElement>(FOLD_CONTENT_SELECTOR);
			if (own) observer.observe(own);
		}
		for (const content of scope.querySelectorAll<HTMLElement>(
			`${FOLD_WRAPPER_SELECTOR} > .content-inner`,
		)) {
			observer.observe(content);
		}

		scheduleUpdate();
	};

	observe(root);
	window.addEventListener('resize', scheduleUpdate);

	return {
		observe,
		stop: () => {
			observer.disconnect();
			window.removeEventListener('resize', scheduleUpdate);
			if (frame !== null) cancelAnimationFrame(frame);
		},
	};
}
