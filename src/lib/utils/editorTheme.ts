/**
 * What the editor paints Markdown with.
 *
 * The two built-in themes shipped `rules: []` and inherited Monaco's `vs` /
 * `vs-dark`, which were written for source code and know nothing about this
 * document: headings, list markers and table pipes all arrived as one blue
 * `keyword`, links and horizontal rules got no colour at all, and bold and
 * italic got a font style and nothing else.
 *
 * The colours are the app's own, the same six the preview and the rest of the
 * chrome resolve through `--color-*` in `styles.css`. Spelled as literals
 * because `defineTheme` takes hex strings and never sees a stylesheet;
 * `editorTheme.test.ts` holds the two copies equal.
 */
const PALETTE = {
	light: {
		text: '1f2328',
		muted: '656d76',
		accent: '0969da',
		code: '1a7f37',
		emphasis: '9a6700',
		link: '8250df',
	},
	dark: {
		text: 'e6edf3',
		muted: '848d97',
		accent: '4390fc',
		code: '3fb950',
		emphasis: 'd29922',
		link: 'a371f7',
	},
} as const;

type Role = keyof (typeof PALETTE)['light'];

/**
 * Monaco token → role.
 *
 * Every name carries the `.md` that Monaco's Markdown grammar appends to each
 * token it emits (`tokenPostfix: ".md"`, applied in `monarchLexer.js`). The
 * suffix is what keeps this palette inside Markdown: a rule on a bare
 * `keyword` or `string` sits at the root of Monaco's token trie and repaints
 * *every* language, so the first version of this file recoloured the Python,
 * Rust and JSON inside fenced blocks — those are tokenized by their own
 * grammar, under their own postfix, and Monaco's defaults for them are tuned
 * for code in a way this six-colour palette is not.
 *
 * The postfix also means a prefix rule cannot stand in for its children:
 * `keyword.table.left.md` walks `keyword` → `table` → …, so `keyword.md` never
 * sees it. The four table tokens are therefore spelled out.
 *
 * Two entries exist to *undo* an inheritance rather than to add a colour. A
 * table header cell and the body of a fenced block are content, not syntax,
 * and both would otherwise arrive painted as the markup around them.
 */
const MARKDOWN_TOKEN_ROLES: ReadonlyArray<readonly [token: string, role: Role]> = [
	// Block structure, one colour. `#`, the `=`/`-` of a setext heading, list
	// bullets and numbers, the `---|---` divider, the table frame, `>` and a
	// horizontal rule are all the same thing to a reader scanning a document:
	// the markup, as opposed to what they wrote. Distinguishing *kinds* of
	// markup matters less than distinguishing markup from prose, and the
	// tokenizer cannot tell a heading from a list marker anyway — one bare
	// `keyword` covers both.
	['keyword.md', 'accent'],
	['keyword.table.left.md', 'accent'],
	['keyword.table.middle.md', 'accent'],
	['keyword.table.right.md', 'accent'],
	['comment.md', 'accent'],
	['meta.separator.md', 'accent'],
	// Content that sits inside markup, and must not read as markup.
	['keyword.table.header.md', 'text'],
	['variable.source.md', 'text'],
	// Fences and inline code: one family, distinct from both.
	['string.md', 'code'],
	['variable.md', 'code'],
	// `[text](target)`.
	['string.link.md', 'link'],
	// `\*` and `&amp;`: punctuation standing in for a character, and the one
	// thing here quiet enough to recede.
	['escape.md', 'muted'],
	['string.escape.md', 'muted'],
	// Inline HTML is the escape hatch: someone dropped a tag in because Markdown
	// could not say it. Monaco's defaults paint it as source code — a maroon tag
	// name, a red attribute — which makes the one thing in the document that is
	// not Markdown the loudest thing on the line. It recedes instead.
	['tag.md', 'muted'],
	['attribute.name.html.md', 'muted'],
	['delimiter.html.md', 'muted'],
	['string.html.md', 'muted'],
	['comment.content.md', 'muted'],
	// Bold and italic keep the font style the base theme gives them — no
	// `fontStyle` here, which Monaco reads as "leave it alone" rather than as
	// "regular", and both get a colour for the first time.
	['strong.md', 'emphasis'],
	['emphasis.md', 'emphasis'],
];

/**
 * The semantic layer's rules (`utils/semanticTokens.ts`).
 *
 * Two things differ from the grammar rules above, both forced by how Monaco
 * styles a semantic token. `standaloneThemeService.getTokenStyleMetadata`
 * reports bold and italic as booleans rather than "not set", so a semantic
 * token always *claims* those bits — a rule without `fontStyle` would switch
 * off the bold the base theme gives `strong`. Every rule covering something
 * bold, italic or struck through therefore says so.
 *
 * And the names are the construct's, not the grammar's: `heading.marker` is the
 * token type `heading` plus its `marker` modifier, joined with a dot the way
 * Monaco joins them before matching.
 */
const SEMANTIC_TOKEN_ROLES: ReadonlyArray<readonly [token: string, role: Role, style?: string]> = [
	// Markup characters. The same colour the grammar gives block markup, so the
	// two layers agree while a parse is in flight and nothing shifts under the
	// reader when the answer arrives.
	['heading.marker', 'accent'],
	['list.marker', 'accent'],
	['task.marker', 'accent'],
	['quote.marker', 'accent'],
	['table.marker', 'accent'],
	['rule', 'accent'],
	['fence', 'code'],
	['frontmatter', 'muted'],
	['code.marker', 'code'],
	['strong.marker', 'emphasis', 'bold'],
	['emph.marker', 'emphasis', 'italic'],
	['strike.marker', 'muted'],
	['highlight.marker', 'emphasis'],
	['insert.marker', 'emphasis'],
	['link.marker', 'link'],
	['image.marker', 'link'],
	// `$`, `$$` and every control sequence between them. `\frac` is the markup
	// inside a formula the way `##` is the markup on a heading, so `math_spans`
	// gives it the same modifier and it lands here.
	['math.marker', 'accent'],
	['wikilink.marker', 'link'],
	// The content the markup is about.
	['heading', 'accent', 'bold'],
	['code', 'code'],
	['strike', 'muted', 'strikethrough'],
	['highlight', 'emphasis'],
	['insert', 'emphasis', 'underline'],
	['link', 'link'],
	['image', 'link'],
	// A formula body is set in italics, which is the one thing about it a colour
	// cannot say: TeX typesets variables italic, so the source and the rendered
	// output agree at a glance. Obsidian does the same, and adds a monospace
	// family — `ITokenThemeRule` has no `fontFamily`, so that half is out of
	// reach here.
	['math', 'code', 'italic'],
	['wikilink', 'link'],
	['footnote', 'link'],
	['html', 'muted'],
];

export type EditorTokenRule = { token: string; foreground: string; fontStyle?: string };

/** The `rules` for one of the two built-in themes. */
export function markdownTokenRules(appearance: 'light' | 'dark'): EditorTokenRule[] {
	const palette = PALETTE[appearance];
	return MARKDOWN_TOKEN_ROLES.map(([token, role]) => ({ token, foreground: palette[role] }));
}

/**
 * The `rules` for the semantic layer, kept apart from the grammar's because the
 * two answer to different contracts — `.md`-scoped names and inherited font
 * styles there, construct names and explicit font styles here — and a test that
 * holds one to the other's rules would have to be weakened to pass both.
 */
export function semanticTokenRules(appearance: 'light' | 'dark'): EditorTokenRule[] {
	const palette = PALETTE[appearance];
	return SEMANTIC_TOKEN_ROLES.map(([token, role, fontStyle]) =>
		fontStyle ? { token, foreground: palette[role], fontStyle } : { token, foreground: palette[role] },
	);
}
