// Types for the Monaco internals this test suite drives directly.
//
// Monaco ships declarations for its public API surface (`monaco-editor`) only.
// The option registry and the Unicode highlighter are plain ESM modules that
// resolve at runtime — Editor.svelte already deep-imports `monaco-editor/esm/…`
// for its five workers — but they carry no `.d.ts`, so `npm run check` reads
// them as implicit `any`.
//
// They are declared here rather than left as `any` because the test asserts on
// what comes back out of them: `ambiguousCharacterCount` silently becoming
// `undefined` after a Monaco upgrade would turn `assert.equal(count, 0)` into a
// test that passes while checking nothing. Narrow declarations make that a type
// error instead. A module that moves outright fails loudly at import time.
//
// Only the members the test calls are declared. This is not an attempt to type
// Monaco's internals in general.

declare module 'monaco-editor/esm/vs/editor/common/config/editorOptions.js' {
	/** Sentinel default for the options gated on workspace trust. */
	export const inUntrustedWorkspace: 'inUntrustedWorkspace';

	export interface UnicodeHighlightOptions {
		nonBasicASCII: boolean | 'inUntrustedWorkspace';
		invisibleCharacters: boolean;
		ambiguousCharacters: boolean;
		includeComments: boolean | 'inUntrustedWorkspace';
		includeStrings: boolean | 'inUntrustedWorkspace';
		allowedCharacters: Record<string, boolean>;
		allowedLocales: Record<string, boolean>;
	}

	/**
	 * One entry of the option registry.
	 *
	 * `validate` is the function `monaco.editor.create` runs over the value it
	 * was handed: it returns `defaultValue` for `undefined`, and for anything
	 * outside the option's accepted set. Driving an assertion through it rather
	 * than comparing the literal is what makes `"Off"` or a renamed enum member
	 * fail in the test instead of silently reverting at runtime.
	 */
	export interface SimpleEditorOption<T> {
		readonly id: number;
		readonly name: string;
		readonly defaultValue: T;
		validate(input: unknown): T;
	}

	export const EditorOptions: {
		occurrencesHighlight: SimpleEditorOption<'off' | 'singleFile' | 'multiFile'>;
		selectionHighlight: SimpleEditorOption<boolean>;
		unusualLineTerminators: SimpleEditorOption<'auto' | 'off' | 'prompt'>;
		unicodeHighlight: {
			readonly defaultValue: UnicodeHighlightOptions;
			/** Merges a partial option object over `value`, as `editor.create` does. */
			applyUpdate(
				value: UnicodeHighlightOptions,
				update: unknown,
			): { newValue: UnicodeHighlightOptions };
		};
	};
}

declare module 'monaco-editor/esm/vs/base/common/strings.js' {
	/**
	 * Monaco's own predicate for U+2028 / U+2029 — the one whose result the
	 * piece-tree buffer stores as `mightContainUnusualLineTerminators`, which is
	 * the gate `UnusualLineTerminatorsDetector` checks before it opens a dialog.
	 */
	export function containsUnusualLineTerminators(str: string): boolean;
}

declare module 'monaco-editor/esm/vs/editor/common/services/unicodeTextModelHighlighter.js' {
	export interface UnicodeHighlightRange {
		startLineNumber: number;
		startColumn: number;
		endLineNumber: number;
		endColumn: number;
	}

	export interface UnicodeHighlightResult {
		ranges: UnicodeHighlightRange[];
		ambiguousCharacterCount: number;
		invisibleCharacterCount: number;
		nonBasicAsciiCharacterCount: number;
		hasMore: boolean;
	}

	/** The minimum of `ITextModel` the highlighter reads. */
	export interface HighlightableModel {
		getLineCount(): number;
		getLineContent(lineNumber: number): string;
	}

	/**
	 * Resolved form of `UnicodeHighlightOptions`: the workspace-trust sentinels
	 * are already collapsed to booleans, and the two allow-maps are flattened to
	 * lists by the caller.
	 */
	export interface ResolvedUnicodeHighlightOptions {
		nonBasicASCII: boolean;
		ambiguousCharacters: boolean;
		invisibleCharacters: boolean;
		includeComments: boolean;
		includeStrings: boolean;
		allowedCodePoints: (number | undefined)[];
		allowedLocales: string[];
	}

	export const UnicodeTextModelHighlighter: {
		computeUnicodeHighlights(
			model: HighlightableModel,
			options: ResolvedUnicodeHighlightOptions,
		): UnicodeHighlightResult;
	};
}

// The four modules formatShortcutKeymap.test.ts drives to turn Markpad's
// keybinding numbers back into chords.
//
// `KeyMod` and `KeyCode` are re-exported by the `monaco-editor` entry point with
// full declarations, but that entry point evaluates Monaco's whole browser-side
// graph on import and cannot run under Node. These are the same two objects,
// reached at the modules that define them, plus the decoder that reads what they
// produce.

declare module 'monaco-editor/esm/vs/editor/common/services/editorBaseApi.js' {
	/** Modifier bits, and the chord-sequence packer. Identical to `monaco.KeyMod`. */
	export const KeyMod: {
		readonly CtrlCmd: number;
		readonly Shift: number;
		readonly Alt: number;
		readonly WinCtrl: number;
		chord(firstPart: number, secondPart: number): number;
	};
}

declare module 'monaco-editor/esm/vs/editor/common/standalone/standaloneEnums.js' {
	/**
	 * Typed as an index rather than member by member: the test reads
	 * `KeyCode.KeyA + n` and `KeyCode.Digit0 + n` to build its key table, and
	 * enumerating 100 members here would add a second place for them to be wrong.
	 * A member that disappears in a Monaco upgrade surfaces as a NaN keybinding,
	 * which every assertion in that file fails on.
	 */
	export const KeyCode: Record<string, number>;

	/** `create()`'s fallback ending, used only for text with no line break at all. */
	export const DefaultEndOfLine: { readonly LF: 1; readonly CRLF: 2 };
}

// The text buffer itself, for `editorLineEnding.test.ts`. A `TextModel` needs a
// browser to build; the buffer under it does not, and it is where the EOL of a
// document is decided — `createTextBufferFactory` is these three calls.
declare module 'monaco-editor/esm/vs/editor/common/model/pieceTreeTextBuffer/pieceTreeTextBufferBuilder.js' {
	/** Only the two members the test reads; this is not the whole buffer API. */
	export interface TextBuffer {
		getEOL(): '\n' | '\r\n';
		/** Chunks of the buffer's own text, `null` at the end. */
		createSnapshot(preserveBOM: boolean): { read(): string | null };
	}

	export class PieceTreeTextBufferBuilder {
		acceptChunk(chunk: string): void;
		/**
		 * `normalizeEOL` defaults to true here and is left at its default by
		 * `createTextBufferFactory`, i.e. by every model Markpad creates.
		 */
		finish(normalizeEOL?: boolean): {
			create(defaultEOL: 1 | 2): { textBuffer: TextBuffer };
		};
	}
}

declare module 'monaco-editor/esm/vs/base/common/keyCodes.js' {
	export const KeyCodeUtils: {
		/** The printable name Monaco gives a KeyCode — `KeyE` -> "E", `Period` -> ".". */
		toString(keyCode: number): string;
	};
}

declare module 'monaco-editor/esm/vs/base/common/keybindings.js' {
	/** One keystroke of a resolved keybinding. */
	export interface KeyCodeChord {
		readonly ctrlKey: boolean;
		readonly shiftKey: boolean;
		readonly altKey: boolean;
		readonly metaKey: boolean;
		readonly keyCode: number;
	}

	/**
	 * Splits a `KeyMod`/`KeyCode` number into the chords it means on `os`, which
	 * is where `CtrlCmd` becomes Meta or Ctrl. Null for a number that decodes to
	 * nothing, so callers must check.
	 */
	export function decodeKeybinding(
		keybinding: number,
		os: 1 | 2 | 3,
	): { readonly chords: readonly KeyCodeChord[] } | null;
}

declare module 'monaco-editor/esm/vs/editor/common/core/wordHelper.js' {
	/**
	 * The `wordSeparators` default. The editor does not set that option, so this
	 * is the string its word classifier is actually built with.
	 */
	export const USUAL_WORD_SEPARATORS: string;
}

declare module 'monaco-editor/esm/vs/editor/common/core/wordCharacterClassifier.js' {
	/**
	 * Decides where words begin and end for ⌥←/→, double-click-to-select and
	 * ⌥⌫. `intlSegmenterLocales` is `wordSegmenterLocales`: a non-empty list
	 * builds an `Intl.Segmenter`, which is the only thing that finds word
	 * boundaries in a script that writes no spaces.
	 */
	export interface WordCharacterClassifier {
		/**
		 * The next segmenter-found word at or after `offset`, or null once the
		 * line is exhausted. Always null when no locales were given — there is
		 * no segmenter to ask.
		 */
		findNextIntlWordAtOrAfterOffset(
			lineContent: string,
			offset: number,
		): { index: number; segment: string } | null;
	}

	export function getMapForWordSeparators(
		wordSeparators: string,
		intlSegmenterLocales: readonly string[],
	): WordCharacterClassifier;
}
