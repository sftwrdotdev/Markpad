import { invoke } from '@tauri-apps/api/core';

/**
 * The editor's second colouring layer: what the renderer says is really there.
 *
 * Monaco paints Markdown with a Monarch grammar — line-oriented regexes, a dozen
 * token names, one `keyword` covering a heading's `#` and its words alike, a
 * task checkbox mistaken for a link, and no idea that `==highlight==`,
 * `++insert++`, `$math$`, wikilinks or footnotes exist. It also guesses wrong in
 * the other direction: `snake_case_word` matches its emphasis rule.
 *
 * This layer answers from `src-tauri/src/semantic.rs`, which walks the same
 * comrak parse the preview is rendered from. The grammar stays underneath and
 * keeps painting instantly on every keystroke; these spans arrive a tick later
 * and refine it. Monaco merges the two per *attribute*
 * (`sparseTokensStore.js`): a semantic token replaces only the attributes its
 * theme rule names, and any range it says nothing about keeps the grammar's
 * colour entirely. That is what makes the layer additive rather than a second
 * source of truth to keep in sync.
 */

/** Construct names, in the order the encoder refers to them by index. */
export const TOKEN_TYPES = [
	'heading',
	'list',
	'task',
	'quote',
	'rule',
	'fence',
	'frontmatter',
	'table',
	'code',
	'strong',
	'emph',
	'strike',
	'highlight',
	'insert',
	'link',
	'image',
	'math',
	'wikilink',
	'footnote',
	'html',
] as const;

/**
 * `marker` is the only modifier: it separates the characters that *are* the
 * markup from the words the markup is about — `##` from the title, `**` from
 * the bold run. Monaco resolves the pair by joining them with a dot, so a rule
 * on `heading.marker` styles the hashes and one on `heading` styles the title
 * (`standaloneThemeService.getTokenStyleMetadata`).
 */
export const TOKEN_MODIFIERS = ['marker'] as const;

export type SemanticSpan = { kind: string; line: number; start: number; len: number };

const typeIndex = new Map<string, number>(TOKEN_TYPES.map((name, index) => [name, index]));

/**
 * Spans as Monaco's delta encoding: five integers per token, each line and
 * column relative to the token before it.
 *
 * Anything the legend does not know is dropped rather than guessed at: an
 * unknown index would paint some *other* construct's colour, which is worse
 * than leaving the grammar's.
 */
export function encodeSemanticTokens(spans: readonly SemanticSpan[]): Uint32Array {
	const data: number[] = [];
	let lastLine = 0;
	let lastStart = 0;

	for (const span of spans) {
		const [name, modifier] = span.kind.split('.');
		const type = typeIndex.get(name);
		if (type === undefined || span.len <= 0) continue;

		const deltaLine = span.line - lastLine;
		const deltaStart = deltaLine === 0 ? span.start - lastStart : span.start;
		// The encoding cannot express a token that starts before the one in
		// front of it; Rust sorts and de-overlaps, and this is the guard that
		// says so out loud if that ever stops being true.
		if (deltaLine < 0 || deltaStart < 0) continue;

		data.push(deltaLine, deltaStart, span.len, type, modifier === 'marker' ? 1 : 0);
		lastLine = span.line;
		lastStart = span.start;
	}

	return new Uint32Array(data);
}

/**
 * The provider Monaco asks, with one parse cached per document version.
 *
 * Monaco calls a range provider on scroll as well as on edit, so without the
 * cache a long document would be re-parsed several times for the same text. The
 * cache is one entry deep because the only version that matters is the current
 * one — an edit invalidates it by definition.
 */
export function createMarkdownSemanticTokensProvider(monaco: typeof import('monaco-editor')) {
	const legend = { tokenTypes: [...TOKEN_TYPES], tokenModifiers: [...TOKEN_MODIFIERS] };
	let cache: { uri: string; version: number; tokens: Uint32Array } | null = null;

	const tokensFor = async (model: import('monaco-editor').editor.ITextModel) => {
		const uri = model.uri.toString();
		const version = model.getVersionId();
		if (cache && cache.uri === uri && cache.version === version) return cache.tokens;

		const spans = (await invoke('markdown_semantic_spans', { content: model.getValue() })) as SemanticSpan[];
		// The model can have moved on while Rust was parsing. Returning tokens
		// for text that is no longer there would paint the wrong ranges, so the
		// stale answer is cached against its own version and Monaco asks again.
		const tokens = encodeSemanticTokens(spans);
		cache = { uri, version, tokens };
		return tokens;
	};

	return {
		legend,
		provider: {
			getLegend: () => legend,
			provideDocumentSemanticTokens: async (model: import('monaco-editor').editor.ITextModel) => {
				try {
					return { data: await tokensFor(model) };
				} catch (error) {
					// A failed parse must cost the colours from this layer, not
					// the editor: the grammar underneath keeps painting.
					console.error('Failed to read semantic spans', error);
					return null;
				}
			},
			releaseDocumentSemanticTokens: () => {},
		} satisfies import('monaco-editor').languages.DocumentSemanticTokensProvider,
	};
}
