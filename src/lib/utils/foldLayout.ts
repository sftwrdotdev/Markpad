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
	// The measurement is the *layout* height, not `scrollHeight`. They are not
	// the same number for maths. KaTeX stacks a display formula with negative
	// margins and vertical-align, so its glyphs reach past the box that lays
	// them out: `scrollHeight` reports the scrollable extent it needs, which is
	// several pixels taller than the height `auto` resolves to. Writing that
	// number back made the wrapper taller than the content it wraps.
	//
	// That is a visible defect, not a rounding artefact, and it fired on every
	// keystroke: `{@html}` rebuilds the wrapper with no inline property, so it
	// paints at `auto`, and the next frame writes the larger number and pushes
	// everything below it down. Measured against `katex-stress.md`'s own
	// formulas, at devicePixelRatio 2:
	//
	//     prose (control)               51.188 auto → 51  scrollHeight  -0.188px
	//     `\mathrm`/`\mathit` row       25.227 auto → 25                -0.227px
	//     grown delimiters              46.461 auto → 52                +5.539px
	//     nested \frac + \sqrt + x^y^z  74.867 auto → 82                +7.133px
	//
	// which is exactly the shape of the report: the prose and short-formula
	// sections sat still and the one with stacked fractions moved. Reading
	// `getBoundingClientRect().height` instead takes every row to +0.000px,
	// and keeps the sub-pixel precision `scrollHeight` rounds away.
	//
	// Nothing is clipped by the smaller number: both the wrapper and
	// `.content-inner` are `overflow: visible` while expanded, and a collapsed
	// wrapper takes `height: 0` from the more specific rule either way.
	const heights = pending.map(({ content }) => content.getBoundingClientRect().height);

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

export function observeFoldLayout(root: HTMLElement): () => void {
	let frame: number | null = null;

	const scheduleUpdate = () => {
		if (frame !== null) return;
		frame = requestAnimationFrame(() => {
			frame = null;
			updateFoldHeights(root);
		});
	};

	const observer = new ResizeObserver(scheduleUpdate);
	for (const content of root.querySelectorAll<HTMLElement>(
		`${FOLD_WRAPPER_SELECTOR} > .content-inner`,
	)) {
		observer.observe(content);
	}

	window.addEventListener('resize', scheduleUpdate);
	scheduleUpdate();

	return () => {
		observer.disconnect();
		window.removeEventListener('resize', scheduleUpdate);
		if (frame !== null) cancelAnimationFrame(frame);
	};
}
