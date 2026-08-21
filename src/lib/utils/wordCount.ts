/**
 * The number the status bar shows.
 *
 * The old expression was `\S+` tokens filtered by `/\w/`, and both halves are
 * Latin-only. `\w` is `[A-Za-z0-9_]`, so it dropped every token written in a
 * script that has no ASCII in it — Korean, Cyrillic, Greek, Arabic, Thai — and
 * a document in one of those counted zero. That is what `\p{L}`/`\p{N}` fixes,
 * and it is the whole fix for every script that puts spaces between words.
 *
 * Chinese and Japanese do not, so whitespace tokens are the wrong unit there:
 * a whole paragraph arrives as one token. Han, Hiragana and Katakana are
 * counted per character instead, which is what Word, Typora and Obsidian
 * report and what a Chinese or Japanese reader means by 字数. Hangul is
 * deliberately not in that set — Korean is spaced, so counting it per syllable
 * would inflate every Korean document.
 *
 * CJK punctuation (`，`, `。`, `、`) is Script=Common, not Script=Han, so it
 * falls to the whitespace pass and is rejected there like `.` and `,`.
 */
const CJK_CHARACTER = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/gu;
const HAS_LETTER_OR_DIGIT = /[\p{L}\p{N}]/u;

export function countWords(text: string): number {
	const cjk = text.match(CJK_CHARACTER)?.length ?? 0;
	// Replaced with a space rather than removed: in `第1章和第2章` the digits
	// are separate words, and deleting the run around them would glue them
	// into one.
	const spaced = text.replace(CJK_CHARACTER, ' ');
	const words = (spaced.match(/\S+/g) || []).filter((w) =>
		HAS_LETTER_OR_DIGIT.test(w),
	).length;
	return cjk + words;
}
