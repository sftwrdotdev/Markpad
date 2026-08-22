/**
 * "What a Markdown list item's marker looks like", written once.
 *
 * Three places have to agree on this and had drifted into three spellings: the
 * Rust renderer's `TASK_SOURCE_RE`, the preview's checkbox rewrite in
 * `sessions/documentSession.svelte.ts`, and the editor toolbar's line-marker
 * toggles in `./editorToolbar.ts`. The first two matched each other by luck; the
 * toolbar's copy accepted neither an indented item nor the `1)` delimiter, so a
 * click on a nested bullet answered `-     - sub` and a click on `1) item`
 * answered `- 1) item` — which is issue #451 verbatim, one delimiter over.
 *
 * WHAT IS SHARED AND WHAT IS DELIBERATELY NOT
 *
 * These are pattern *fragments*, not patterns. What each consumer wraps around
 * them — the anchors, the separator between marker and text, and above all what
 * it does with the prefix — stays where it is, because that part is genuinely
 * different:
 *
 *   - the renderer only asks "is this a task line?", so it consumes the prefix
 *     and throws it away;
 *   - the preview's rewrite captures the prefix and writes it back out, because
 *     it is replacing the box in the middle of the line;
 *   - the toolbar splits the prefix off, transforms the rest, and re-attaches
 *     it, because the prefix is what makes a nested item nested. A toolbar that
 *     consumed it like the renderer does would flatten every nested list item to
 *     the top level on the first click — a worse defect than the one this module
 *     exists to fix.
 *
 * So: same grammar, opposite disposal. Anything about whitespace *handling*
 * belongs to the call site, and only the marker vocabulary lives here.
 */

/** `-`, `+`, `*` — the three bullet characters, which are interchangeable. */
export const BULLET_MARKER = String.raw`[-+*]`;

/**
 * `1.` and `1)`. CommonMark defines both delimiters and the renderer reads both;
 * a document written with `1)` is an ordered list everywhere except in a toolbar
 * that forgot the second half.
 */
export const ORDERED_MARKER = String.raw`\d+[.)]`;

/** Either kind of list marker, without its trailing space. */
export const LIST_MARKER = String.raw`(?:${BULLET_MARKER}|${ORDERED_MARKER})`;

/**
 * The checkbox of a task list item, unchecked or checked in either case.
 *
 * Part of the marker rather than part of the text: a toggle that took `- ` off
 * `- [ ] foo` would leave the orphan `[ ] foo`, which nothing recognises.
 */
export const TASK_BOX = String.raw`\[[ xX]\]`;

/**
 * One level of block quote: the `>` and whatever separates it from what follows.
 *
 * A fragment of its own because a quote is TWO things to this app — the prefix a
 * list item may be nested inside, and, since #700, a block Enter continues on
 * its own. Both spellings were `>[ \t]*` and a second copy is how they drift.
 */
export const QUOTE_MARKER = String.raw`>[ \t]*`;

/**
 * What may stand between the start of a line and the marker: indentation, then
 * any depth of block-quote nesting.
 *
 * Horizontal whitespace only, and it has to stay that way — `\s` also matches
 * `\r` and `\n`, which is how the preview's checkbox rewrite used to resolve
 * every task in a CRLF document to the previous line (#148). See the call site
 * in documentSession.svelte.ts for the full account.
 */
export const LIST_MARKER_PREFIX = String.raw`[ \t]*(?:${QUOTE_MARKER})*`;
