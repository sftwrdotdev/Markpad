/**
 * The link "Copy Reference" puts on the clipboard, in the spelling the
 * document is already written in.
 *
 * Markpad understands two:
 *
 *     [[note#Setup]]              Obsidian's, rewritten before the parse
 *     [Setup](note.md#setup)      CommonMark's, which every reader resolves
 *
 * It used to always write the first. Which is right depends on the reader, not
 * on the app: someone whose vault is full of `[[…]]` wants another one, and
 * someone writing documents for GitHub wants a link that survives leaving this
 * app. Neither answer is right for both, and the document itself is the one
 * piece of evidence available — a person's habit is already written down in
 * the file they are working in.
 *
 * So the style is inferred, and the inference has a floor: where the document
 * says nothing, or says both, the answer is what this menu has always
 * produced. It can be better than the old behaviour and never worse.
 *
 * The caveat worth knowing: a reference is usually pasted into a DIFFERENT
 * document, so following this one is a guess about that one. In practice a
 * person writes one way throughout, which is what makes the guess worth
 * making — but it is a guess.
 */

export type ReferenceStyle = 'wikilink' | 'inline';

/** What the menu produced before it looked at anything, and the fallback. */
export const DEFAULT_REFERENCE_STYLE: ReferenceStyle = 'wikilink';

/**
 * Fenced code is where a document ABOUT Markdown keeps its examples, and this
 * app's own samples contain both spellings inside fences. Counting those would
 * make the syntax documentation the loudest voice in every vault.
 */
function withoutFencedCode(document: string): string {
	return document.replace(/^ {0,3}(```+|~~~+)[\s\S]*?^ {0,3}\1[^\n]*$/gm, '');
}

export function preferredReferenceStyle(document: string): ReferenceStyle {
	const prose = withoutFencedCode(document);

	const hasWikilink = /\[\[[^\]\n]*\]\]/.test(prose);
	// A link whose destination carries a `#` — `](#setup)` in this document,
	// or `](notes.md#setup)` into another.
	const hasInlineAnchor = /\]\([^)\n]*#[^)\n]*\)/.test(prose);

	if (hasWikilink === hasInlineAnchor) return DEFAULT_REFERENCE_STYLE;
	return hasWikilink ? 'wikilink' : 'inline';
}

/**
 * A link destination may not contain spaces or parentheses unless it is
 * wrapped in angle brackets — `[x](my note.md#a)` stops at the space and the
 * rest becomes text. Filenames with spaces are ordinary.
 */
function linkDestination(target: string): string {
	return /[\s()<>]/.test(target) ? `<${target}>` : target;
}

/** Link text is delimited by brackets, so a heading containing one escapes it. */
function linkLabel(text: string): string {
	return text.replace(/([[\]])/g, '\\$1');
}

/**
 * The file half of a wikilink to `fileName`. The renderer adds `.md` to a
 * target with no extension of its own (`wikilink_file_destination`), so only
 * `.md` may be dropped, and only when what is left does not itself read as
 * one: `note.markdown` and `v1.2.md` stay whole.
 */
function wikilinkNote(fileName: string): string {
	const stem = fileName.replace(/\.md$/, '');
	return stem !== fileName && !/[^/\\]\.[A-Za-z0-9]{1,8}$/.test(stem) ? stem : fileName;
}

/**
 * What a rendered heading reads as. The outline and the preview's context menu
 * both name a heading by this, so "Copy Reference" writes the same text from
 * either. A block id is already an empty anchor by now, so nothing is stripped.
 */
export function headingText(heading: Element): string {
	return heading.textContent?.trim() ?? '';
}

export type HeadingReference = {
	/** The heading as it reads. Both spellings show this to the reader. */
	text: string;
	/** The rendered `id`, which only the CommonMark spelling names. */
	slug: string;
	/**
	 * The document's file name **with** its extension, or `null` for one that
	 * has never been saved. The wikilink spelling drops the extension, the
	 * CommonMark one needs it — that is how each is resolved.
	 */
	fileName: string | null;
	style: ReferenceStyle;
};

export function headingReference({ text, slug, fileName, style }: HeadingReference): string {
	if (style === 'wikilink') {
		const note = fileName ? wikilinkNote(fileName) : '';
		return note ? `[[${note}#${text}]]` : `#${text}`;
	}

	const destination = fileName ? `${fileName}#${slug}` : `#${slug}`;
	return `[${linkLabel(text)}](${linkDestination(destination)})`;
}
