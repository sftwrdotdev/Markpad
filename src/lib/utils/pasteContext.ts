import { parseFrontMatter } from './frontMatter.js';

/**
 * Decides whether the caret sits in ordinary markdown prose, where pasting a
 * URL should produce `[label](url)`, or in a code / front matter region, where
 * the user wants the bare URL they copied.
 *
 * The code half of that question is answered by Monaco's own tokenizer rather
 * than by scanning the buffer for fences: `monaco.editor.tokenize()` is the
 * only public tokenization entry point Monaco exposes (`ITextModel` keeps
 * `getLineTokens` internal), and it runs the exact Monarch grammar that colours
 * the text on screen. That means the classification can never disagree with
 * what the user sees, and nested / indented / tilde fences and embedded
 * languages are handled by the grammar instead of by hand-rolled regexes.
 */

export const MARKDOWN_LANGUAGE_ID = 'markdown';

/**
 * Monarch is a line-at-a-time state machine, so a blank line inside a fenced
 * block yields *no* tokens at all — there is nothing to ask about. Inserting
 * one throwaway character at the caret before tokenizing removes that blind
 * spot, and it asks a question that maps exactly onto what we want to know:
 * "if text appeared here, how would the editor colour it?".
 *
 * A plain letter is used on purpose: it carries no markdown meaning, so it
 * cannot open or close a construct that would change the caret's own token.
 */
const PASTE_PROBE_CHARACTER = 'x';

export type PasteContextToken = {
	readonly offset: number;
	readonly type: string;
	readonly language: string;
};

type PasteContextTokenizer = (text: string) => readonly (readonly PasteContextToken[])[];

/**
 * Token types Monaco's markdown grammar emits for code. The `.md` suffix is
 * the grammar's own `tokenPostfix`, so these are full token types, not
 * prefixes: matching on a prefix would also catch `string.link.md`
 * (`[label](url)`), which is prose, not code.
 *
 * - `variable.md`        inline `` `code` ``
 * - `variable.source.md` body of a fence with no info string
 * - `string.md`          the ``` / ~~~ fence lines, and indented code blocks
 *
 * Fences that *do* carry an info string (```` ```ts ````) are tokenized by the
 * embedded language instead, and are recognised by their token language below.
 */
const MARKDOWN_CODE_TOKEN_TYPES: ReadonlySet<string> = new Set([
	'variable.md',
	'variable.source.md',
	'string.md',
]);

export function isCodeToken(token: PasteContextToken): boolean {
	// Inside ```lang fences Monarch hands the line to that language's tokenizer
	// and stamps its tokens with the embedded language id, whatever token types
	// that grammar happens to use.
	if (token.language && token.language !== MARKDOWN_LANGUAGE_ID) return true;
	return MARKDOWN_CODE_TOKEN_TYPES.has(token.type);
}

/**
 * Tokens arrive sorted by offset and cover the line without gaps, so the token
 * containing `offset` is the last one that starts at or before it.
 */
export function findTokenAtOffset(
	tokens: readonly PasteContextToken[],
	offset: number,
): PasteContextToken | null {
	let found: PasteContextToken | null = null;
	for (const token of tokens) {
		if (token.offset > offset) break;
		found = token;
	}
	return found;
}

function isCodeAtOffset(tokens: readonly PasteContextToken[], offset: number): boolean {
	const token = findTokenAtOffset(tokens, offset);
	return token ? isCodeToken(token) : false;
}

function countLines(text: string): number {
	return text.split(/\r\n|\r|\n/).length;
}

/**
 * Number of lines the front matter block occupies, both `---` fences included.
 * Returns 0 when the document has none.
 *
 * Front matter is the one region Monaco's tokenizer cannot help with: its
 * markdown grammar has no front matter rule at all, so a leading `---` matches
 * the setext-heading rule and comes back as `keyword.md`, and the YAML lines
 * below it tokenize as ordinary prose. Rather than inventing a second front
 * matter parser, this reuses `parseFrontMatter()`, which is already the app's
 * single source of truth for where the block starts and ends.
 */
export function getFrontMatterLineCount(content: string): number {
	const { exists, raw } = parseFrontMatter(content);
	if (!exists) return 0;

	const rawLines = raw === '' ? 0 : countLines(raw.replace(/\r?\n$/, ''));
	// opening `---` + body + closing `---`
	return rawLines + 2;
}

export function isInFrontMatter(content: string, lineNumber: number): boolean {
	return lineNumber <= getFrontMatterLineCount(content);
}

export function buildPasteProbe(
	linesUpToCaret: readonly string[],
	column: number,
): { text: string; lineIndex: number; offset: number } {
	const lineIndex = Math.max(0, linesUpToCaret.length - 1);
	const line = linesUpToCaret[lineIndex] ?? '';
	const offset = Math.max(0, Math.min(line.length, column - 1));
	const probed = line.slice(0, offset) + PASTE_PROBE_CHARACTER + line.slice(offset);

	const lines = linesUpToCaret.slice(0, lineIndex);
	lines.push(probed);
	return { text: lines.join('\n'), lineIndex, offset };
}

type PasteCaretContext = {
	/** Language id of the model the caret is in. */
	languageId: string;
	/** Full document text, needed to locate front matter. */
	content: string;
	/** Document lines 1..caretLine, without line endings. */
	linesUpToCaret: readonly string[];
	/** 1-based caret column. */
	column: number;
	tokenize: PasteContextTokenizer;
};

/**
 * True when a pasted URL should become a markdown link.
 *
 * Only markdown documents are classified. Other languages the editor can open
 * keep the behaviour they have today; narrowing those is a separate change.
 */
export function shouldLinkifyPastedUrl(context: PasteCaretContext): boolean {
	if (context.languageId !== MARKDOWN_LANGUAGE_ID) return true;
	if (context.linesUpToCaret.length === 0) return true;
	if (isInFrontMatter(context.content, context.linesUpToCaret.length)) return false;

	const probe = buildPasteProbe(context.linesUpToCaret, context.column);
	// Monarch only needs the lines above the caret to reach the right state, so
	// the rest of the document is never tokenized.
	const tokens = context.tokenize(probe.text);
	return !isCodeAtOffset(tokens[probe.lineIndex] ?? [], probe.offset);
}

/**
 * Pasting a URL only turns into `[label](url)` where markdown links mean
 * something. Inside a fenced or indented code block, inside inline code, or
 * inside YAML front matter, the user wants the bare URL they copied.
 *
 * The decision is taken once per paste, from the primary selection: a paste
 * is a single user action, and re-tokenizing for every cursor of a large
 * multi-cursor selection would cost far more than the edge case is worth.
 * `monacoEditor` is `monaco.editor`, whose `tokenize` runs the grammar.
 */
export function isLinkifyPasteTarget(
	model: { getLanguageId(): string; getValue(): string; getLinesContent(): string[] },
	selection: { startLineNumber: number; startColumn: number },
	monacoEditor: { tokenize(text: string, languageId: string): readonly (readonly PasteContextToken[])[] },
): boolean {
	return shouldLinkifyPastedUrl({
		languageId: model.getLanguageId(),
		content: model.getValue(),
		linesUpToCaret: model.getLinesContent().slice(0, selection.startLineNumber),
		column: selection.startColumn,
		tokenize: (text) => monacoEditor.tokenize(text, MARKDOWN_LANGUAGE_ID),
	});
}
