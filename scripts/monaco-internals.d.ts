// monaco-editor publishes types for its public surface only
// (`monaco-editor/esm/vs/editor/editor.api.d.ts`). The ESM internals ship as
// plain `.js` with no declarations beside them.
//
// pasteUrlContext.test.ts drives Monarch directly — `monaco.editor.tokenize()`
// needs a browser-backed editor, which the Node test runner has no way to
// create — so it reaches for three of those internals. Declared here with the
// shapes that test actually uses, rather than left implicitly `any`.

declare module 'monaco-editor/esm/vs/editor/standalone/common/monarch/monarchCompile.js' {
	import type { languages } from 'monaco-editor';

	/** Compiles a Monarch language definition into the lexer the tokenizer runs. */
	export function compile(languageId: string, json: languages.IMonarchLanguage): unknown;
}

declare module 'monaco-editor/esm/vs/editor/standalone/common/monarch/monarchLexer.js' {
	/**
	 * Constructed with (languageService, themeService, languageId, lexer,
	 * configurationService). The services are stubs here, so the parameters stay
	 * `unknown` — only the tokenization surface below is relied on.
	 */
	export const MonarchTokenizer: new (...args: unknown[]) => {
		getInitialState(): unknown;
		tokenize(line: string, hasEOL: boolean, state: unknown): { tokens: unknown[]; endState: unknown };
	};
}

declare module 'monaco-editor/esm/vs/basic-languages/markdown/markdown.js' {
	import type { languages } from 'monaco-editor';

	export const conf: languages.LanguageConfiguration;
	export const language: languages.IMonarchLanguage;
}
