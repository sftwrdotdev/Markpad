import { LIST_MARKER, TASK_BOX } from './listSyntax.js';

/**
 * Whether `line` (1-based) is inside a fenced code block that a line above it
 * opened — the question the editing keys ask before they treat `1. a` or
 * `|a|b|` as Markdown. Inside a fence those characters are code, and the
 * key keeps its ordinary meaning.
 *
 * It is a line scan from the top, O(caret line): about 1 ms at line 20 000,
 * once per Enter or Tab. Re-tokenizing the same lines costs 275 ms, and
 * Monaco's grammar would call a four-space-indented nested list item code
 * anyway.
 *
 * CommonMark's rules, near enough: a run of three or more backticks or tildes
 * opens; only the same character, at least as long, with nothing but spaces
 * after it, closes; a backtick fence's info string cannot contain a backtick;
 * an unclosed fence runs to the end of the document. Indentation, `>` and
 * list markers (`-`, `*`, `+`, `1.`, `1)`, a task box) are all skipped, as
 * often as containers nest, so a fence nested in a list item or a quote counts,
 * including one opened on the marker line itself (`- ```js`, `> 1. ````).
 * Missing the marker made that fence's indented closing line look like an
 * opening one, and the rest of the document read as code.
 * ponytail: any indentation opens, so `    ```` in an indented code block is
 * miscounted as a fence; tracking container columns is the upgrade if it bites.
 */
const FENCE = new RegExp(String.raw`^(?:[ \t]*(?:>|(?:${LIST_MARKER}|${TASK_BOX})(?=[ \t])))*[ \t]*(\`{3,}|~{3,})(.*)$`);

export function isInFencedCode(doc: { getLineContent(line: number): string }, line: number): boolean {
	let open: string | null = null;
	for (let n = 1; n < line; n++) {
		const fence = FENCE.exec(doc.getLineContent(n));
		if (!fence) continue;
		const [, run, rest] = fence;
		if (open === null) {
			if (run[0] !== '`' || !rest.includes('`')) open = run;
		} else if (run[0] === open[0] && run.length >= open.length && rest.trim() === '') {
			open = null;
		}
	}
	return open !== null;
}
