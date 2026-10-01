/**
 * Where the editor should offer this document's headings as a link target.
 *
 * #200: "implement some function which slugify titles and purpose those as
 * #targets for URL of link". The slugs exist — comrak renders an `id` onto
 * every heading and `[…](#that-id)` already jumps to it — but nothing offered
 * them, so writing one meant reading the heading, lowercasing it, dropping the
 * punctuation comrak drops and hyphenating the spaces, by hand.
 *
 * Two syntaxes take a heading in this app, and they take DIFFERENT text:
 *
 *   [text](#11-mermaid-diagrams)     the slug — what the renderer wrote
 *   [[#11. Mermaid Diagrams]]        the heading, which Rust anchorizes at
 *                                    render time (`process_wikilinks`)
 *
 * So the context decides what a completion inserts, not just whether to offer
 * one. Both are worth having: the wikilink spelling is what `Copy Reference`
 * produces, so a reader who pastes one and then wants another writes it in
 * that form.
 */
export type HeadingLinkContext = 'slug' | 'wikilink';

/** One of `markdown_outline`'s anchors. Mirrors `HeadingAnchor` in `markdown.rs`. */
export type HeadingAnchor = {
	line: number;
	level: number;
	text: string;
	slug: string;
};

/**
 * The text before the cursor, or `null` where headings are not the answer.
 *
 * `[[note#`, with a path before the `#`, is deliberately not a context: those
 * are another file's headings and this buffer does not have them. Offering
 * this document's would be worse than offering nothing.
 */
export function headingLinkContext(prefix: string): HeadingLinkContext | null {
	// `](#…` — an inline link's destination, still being typed. A closing
	// paren or whitespace means the destination is finished.
	if (/\]\(#[^)\s]*$/.test(prefix)) return 'slug';

	// `[[#…` — a wikilink to a heading of this document. `|` starts the alias
	// half, which is prose, not a target.
	if (/\[\[#[^\]|]*$/.test(prefix)) return 'wikilink';

	return null;
}

/**
 * What the user has typed since the `#`, which is what a suggestion replaces.
 * `-1` when there is none to replace, which cannot happen for a context above.
 */
export function headingQueryStart(prefix: string): number {
	return prefix.lastIndexOf('#') + 1;
}
