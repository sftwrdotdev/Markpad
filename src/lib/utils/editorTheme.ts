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
 * Only names this Monaco build's Markdown tokenizer actually emits are here.
 * A rule keyed on anything else is silently inert — the defect #676 was, one
 * layer over — so `editorTheme.test.ts` checks every token below against the
 * grammar itself.
 *
 * Two entries exist to *undo* an inheritance rather than to add a colour.
 * Monaco resolves a token against a trie, so `keyword.table.header` inherits
 * whatever `keyword` says: without a rule of its own, every header cell in
 * every table would be painted like a heading. `variable.source` is the same
 * story one token over — it is the body of a fenced code block, which inherits
 * inline code's colour and would turn whole blocks green.
 */
const MARKDOWN_TOKEN_ROLES: ReadonlyArray<readonly [token: string, role: Role]> = [
	// `#`, the `=`/`-` of a setext heading, list bullets and numbers, and the
	// `---|---` divider row. One token for all of them, so one colour: the
	// tokenizer does not tell headings and lists apart, and a theme cannot
	// invent a distinction the grammar never made.
	['keyword', 'accent'],
	// Table pipes are structure, not content — quiet, so the cells read.
	['keyword.table', 'muted'],
	// `text` rather than "leave it alone", which a Monaco rule cannot say: every
	// rule must name a colour. The app's own foreground is the closest honest
	// answer, so a header cell reads a hair off the body cells below it
	// (#1f2328 against the base theme's #000000) and in step with the preview.
	['keyword.table.header', 'text'],
	// Blockquote markers.
	['comment', 'muted'],
	// Fences and indented code, then inline code: one family.
	['string', 'code'],
	['variable', 'code'],
	['variable.source', 'text'],
	// `[text](target)`.
	['string.link', 'link'],
	// `***` / `---` on a line of its own.
	['meta.separator', 'muted'],
	// `\*` and `&amp;`: punctuation that is standing in for a character.
	['escape', 'muted'],
	['string.escape', 'muted'],
	// Bold and italic keep the font style the base theme gives them — no
	// `fontStyle` here, which Monaco reads as "leave it alone" rather than as
	// "regular", and both get a colour for the first time.
	['strong', 'emphasis'],
	['emphasis', 'emphasis'],
];

export type EditorTokenRule = { token: string; foreground: string };

/** The `rules` for one of the two built-in themes. */
export function markdownTokenRules(appearance: 'light' | 'dark'): EditorTokenRule[] {
	const palette = PALETTE[appearance];
	return MARKDOWN_TOKEN_ROLES.map(([token, role]) => ({ token, foreground: palette[role] }));
}
