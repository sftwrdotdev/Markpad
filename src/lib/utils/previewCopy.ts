import { resolveExportImagePath } from './exportHtml.js';

/**
 * A local path as a URL the *receiving* application can open.
 *
 * `encodeURI` rather than encoding each segment: it leaves `/` and the `:` of a
 * Windows drive letter alone, which per-segment `encodeURIComponent` would turn
 * into `%3A` and break. It also leaves `?` and `#`, and both end a URL — a file
 * called `notes #2.png` would otherwise resolve to `notes ` — so those two are
 * spelled out afterwards.
 */
function fileUrl(path: string): string {
	const normalized = path.replace(/\\/g, '/');
	const rooted = normalized.startsWith('/') ? normalized : `/${normalized}`;
	return 'file://' + encodeURI(rooted).replace(/[?#]/g, (char) => (char === '?' ? '%3F' : '%23'));
}

/** The `.katex` element `node` sits in, if any. */
function enclosingFormula(node: Node | null): Element | null {
	const element = node instanceof Element ? node : node?.parentElement;
	return element?.closest('.katex') ?? null;
}

/**
 * A copy of `range` whose ends never sit inside a formula.
 *
 * Half a formula is not a formula: KaTeX lays one out as dozens of spans, and a
 * selection that starts in the middle of it produces fragments of markup with
 * no meaning in either flavour. Selecting any part of a formula therefore
 * copies all of it — the behaviour `katex/contrib/copy-tex` established and
 * this module took over (see `texSubstituted`).
 */
function expandToWholeFormulas(range: Range): Range {
	const expanded = range.cloneRange();
	const start = enclosingFormula(expanded.startContainer);
	if (start) expanded.setStartBefore(start);
	const end = enclosingFormula(expanded.endContainer);
	if (end) expanded.setEndAfter(end);
	return expanded;
}

/**
 * Every formula in `holder` replaced by its own source, `$…$` or `$$…$$`.
 *
 * KaTeX keeps the TeX it rendered in the MathML half's `<annotation>`, so the
 * source is recoverable without going back to the document. What the eye reads
 * as a formula is a pile of positioned spans, and its text content is glyph
 * soup — `E=mc2` for `E=mc^2` — so the source is what a plain-text paste should
 * carry, and it can be pasted back into any Markdown document as a formula.
 */
function texSubstituted(holder: HTMLElement): HTMLElement {
	for (const formula of holder.querySelectorAll('.katex')) {
		const tex = formula.querySelector('annotation[encoding="application/x-tex"]')?.textContent;
		if (tex === null || tex === undefined) continue;
		const display = formula.closest('.katex-display') ?? (formula.parentElement?.classList.contains('katex-display') ? formula.parentElement : null);
		const delimiter = display ? '$$' : '$';
		(display ?? formula).replaceWith(holder.ownerDocument.createTextNode(`${delimiter}${tex}${delimiter}`));
	}
	return holder;
}

/** A fragment as an element that can be queried and serialized. */
function holderFor(fragment: DocumentFragment): HTMLElement {
	const holder = (fragment.ownerDocument ?? document).createElement('div');
	holder.appendChild(fragment);
	return holder;
}

/**
 * The preview selection as HTML another application can paste (#674).
 *
 * The clipboard carries no stylesheet, so what survives a paste is structure —
 * headings, bold, lists, tables, links — resolved by the receiving app's own
 * styles. Three things in the preview's DOM are not structure and have to be
 * dealt with before the fragment leaves the app:
 *
 *   - KaTeX writes every formula twice, MathML for screen readers and spans for
 *     the eye, and hides one of them in CSS. Without that CSS both are visible,
 *     so a pasted formula arrives doubled. The visual half stays, because it is
 *     what the user saw.
 *   - The fold chevrons are controls. On paper they control nothing, which is
 *     the same reason `@media print` removes them.
 *   - An image's `src` is an `asset://` (or `http://asset.localhost`) URL, a
 *     scheme that exists only inside this app; anything else pasting it gets a
 *     broken image. `file:` is what a desktop application can open. A remote
 *     image or a data URI resolves to null here and keeps the src it has.
 */
export function copyableHtml(fragment: DocumentFragment, tabPath: string): string {
	const holder = holderFor(fragment);

	for (const duplicate of holder.querySelectorAll('.katex-mathml')) duplicate.remove();
	for (const control of holder.querySelectorAll('.header-fold-icon, .callout-fold-icon')) control.remove();

	for (const img of holder.querySelectorAll('img')) {
		const src = img.getAttribute('src');
		if (!src) continue;
		const localPath = resolveExportImagePath(src, tabPath);
		if (localPath) img.setAttribute('src', fileUrl(localPath));
	}

	return holder.innerHTML;
}

/**
 * Both clipboard flavours for the current preview selection.
 *
 * One function because there is one copy: `katex/contrib/copy-tex` used to
 * install a second `copy` listener that fired only for selections containing
 * math and rewrote *both* flavours from its own fragment — so whichever handler
 * ran last won, and the pruning above was silently undone for any selection
 * with a formula in it. Its two behaviours worth keeping, whole-formula
 * expansion and the TeX plain text, live here now, and the extension is no
 * longer loaded.
 *
 * The plain text still comes from the selection itself when there is no math to
 * substitute. `Selection.toString()` is the only source that knows what is
 * rendered: it skips the hidden MathML and keeps the line breaks between
 * blocks, both of which a `textContent` of the fragment gets wrong.
 */
export function copyableFlavours(selection: Selection, tabPath: string): { text: string; html: string } {
	const range = expandToWholeFormulas(selection.getRangeAt(0));
	const fragment = range.cloneContents();
	const hasMath = !!fragment.querySelector('.katex-mathml');

	return {
		// A second clone: the HTML pass consumes the first one.
		text: hasMath ? (texSubstituted(holderFor(range.cloneContents())).textContent ?? '') : selection.toString(),
		html: copyableHtml(fragment, tabPath),
	};
}
