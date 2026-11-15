/**
 * A rendered Mermaid diagram as a PNG, for "Copy as image" (#1085).
 *
 * The SVG is what the preview shows, so the picture matches the screen: the
 * theme's colours, on the preview's own background. That fill matters because
 * Mermaid leaves the background transparent, and a dark-theme diagram pasted
 * onto a white page would be light text on white.
 */

/** Pixels per diagram pixel, so the paste stays sharp on a high-DPI screen. */
const SCALE = 2;
/** Longest side of the PNG. Larger canvases fail in some WebViews. */
const MAX_SIDE = 8192;

export function diagramPngSize(width: number, height: number): { width: number; height: number } {
	const scale = Math.min(SCALE, MAX_SIDE / Math.max(width, height, 1));
	return {
		width: Math.max(1, Math.round(width * scale)),
		height: Math.max(1, Math.round(height * scale)),
	};
}

/** The first non-transparent background at or above `element`, else white. */
function backgroundOf(element: Element | null): string {
	for (let el = element; el; el = el.parentElement) {
		const colour = getComputedStyle(el).backgroundColor;
		if (colour && colour !== 'transparent' && !/^rgba\(.*,\s*0\)$/.test(colour)) return colour;
	}
	return '#ffffff';
}

/** The diagram in `container` as base64 PNG data, without the `data:` prefix. */
export async function diagramToPngBase64(container: HTMLElement): Promise<string> {
	const svg = container.querySelector<SVGSVGElement>(':scope > svg');
	if (!svg) throw new Error('No diagram to copy');

	// The viewBox is the diagram's own size. The on-screen box is not: the
	// preview caps it at the column width.
	const box = svg.viewBox?.baseVal;
	const rect = svg.getBoundingClientRect();
	const width = box && box.width > 0 ? box.width : rect.width;
	const height = box && box.height > 0 ? box.height : rect.height;
	const out = diagramPngSize(width, height);

	const clone = svg.cloneNode(true) as SVGSVGElement;
	clone.setAttribute('width', String(out.width));
	clone.setAttribute('height', String(out.height));
	clone.style.maxWidth = '';
	const markup = new XMLSerializer().serializeToString(clone);
	const url = URL.createObjectURL(new Blob([markup], { type: 'image/svg+xml' }));

	try {
		const image = new Image();
		image.src = url;
		await image.decode();

		const canvas = document.createElement('canvas');
		canvas.width = out.width;
		canvas.height = out.height;
		const context = canvas.getContext('2d');
		if (!context) throw new Error('Canvas is unavailable');
		context.fillStyle = backgroundOf(container);
		context.fillRect(0, 0, out.width, out.height);
		context.drawImage(image, 0, 0, out.width, out.height);
		return canvas.toDataURL('image/png').slice('data:image/png;base64,'.length);
	} finally {
		URL.revokeObjectURL(url);
	}
}
