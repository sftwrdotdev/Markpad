/**
 * The Markdown an image lands in when the *app* writes the link — a pasted
 * screenshot (`save_image`) or a dropped file (`copy_file_to_img`). Both used
 * to build the same four expressions inline, 300 lines apart, and both
 * escaped spaces and nothing else.
 *
 * A file the app just copied is a file the app must be able to read back on
 * the next render. So the escaping question here is narrower than "escape a
 * URL": which characters, left raw, make Markpad's own two readers resolve
 * this link to a *different* path than the one Rust just wrote?
 *
 * Three of them, and the shape of the answer follows from where each reader
 * looks:
 *
 *   1. CommonMark's own destination grammar, which comrak parses with. A
 *      destination that is not wrapped in `<…>` ends at the first ASCII space
 *      or control character, may contain parentheses only balanced, and
 *      treats `\` as an escape. `note (1).png` survives by luck; `photo).png`
 *      ends the link at the `)` and the rest becomes literal text.
 *   2. `processMarkdownHtml` in ./markdown.ts, which the preview runs: it
 *      takes the `src` comrak emitted and calls `decodeURIComponent` on it
 *      before handing it to `convertFileSrc`.
 *   3. `resolveExportImagePath` in ./exportHtml.ts, which HTML/PDF export
 *      runs: it splits the `src` at the first `#` or `?` — those are a
 *      fragment and a query in every URL — and `decodeURIComponent`s the rest.
 *
 * Both readers decode, so the wire format between this function and them is
 * percent-encoding; that is not a choice, it is what is already there. What is
 * a choice is *how much* to encode, and the answer is: exactly the characters
 * the three readers misread, and nothing else.
 *
 *   - `encodeURI` was never a candidate: it leaves `#`, `?`, `(` and `)`
 *     alone, which is the whole bug.
 *   - `encodeURIComponent` encodes `/` to `%2F`, so it cannot see a path at
 *     all; per-segment it would work, but it also percent-encodes every
 *     non-ASCII byte, and `图片/截图.png` — a perfectly good name that the
 *     preview and the export both already resolve — would be written into the
 *     user's document as forty characters of `%E5%9B%BE…`. The document is
 *     text a person reads and edits; over-encoding it is a regression that no
 *     test would have caught.
 *   - Angle brackets (`![alt](<path>)`), the form ./headingReference.ts uses
 *     for the same class of problem, answer reader 1 and only reader 1. They
 *     put a raw `#` into the destination, comrak's `escape_href` keeps `#`
 *     verbatim (it is in its safe set), and `resolveExportImagePath` then
 *     splits `img/note#1.png` into `img/note` + `#1.png` and exports a dead
 *     link. Making them work would mean changing what a `#` means to the
 *     export resolver — for every hand-written link too, not just ours. See
 *     the `<…>` cases in scripts/imageEmbed.test.ts, which pin that.
 *
 * `%` is on the list for a reason that is easy to miss: comrak passes a `%`
 * through untouched when two hex digits follow it, so a file genuinely named
 * `50%20off.png` reaches `decodeURIComponent` as `50%20off.png` and comes back
 * out as `50 off.png` — a file that does not exist. Encoding it to `%2550…`
 * first is what makes the round trip total.
 */

/** Where images go when the setting is empty. */
export const DEFAULT_IMAGE_DIRECTORY = 'img';

/**
 * ASCII control characters and space end a destination; `(`, `)` and `\` are
 * the grammar's own metacharacters; `<` and `>` are its other destination
 * form; `#` and `?` are read as fragment and query by the export resolver; `%`
 * is the encoding's own escape and has to be encoded to survive it. Everything
 * else — letters in any script, `&`, `'`, `+`, `,`, `=`, `@`, `~` — is left as
 * the user named it, and comrak escapes for HTML whatever HTML needs.
 */
const NEEDS_PERCENT_ENCODING = /[\x00-\x20\x7f%()<>?#\\]/g;

/** The document's directory, or `null` for a path with no separator in it. */
export function documentParentDir(tabPath: string): string | null {
	const match = tabPath.match(/^(.*)[/\\][^/\\]+$/);
	return match ? match[1] : null;
}

/**
 * The relative path Rust returned, spelled so that it names the same file
 * after a Markdown parse and a `decodeURIComponent`.
 *
 * The leading slash goes first: `save_image` and `copy_file_to_img` both join
 * with `/`, so an empty `imageDirectory` returns `/photo.png`, and a
 * destination starting with `/` is an absolute path to every reader.
 */
export function encodeImageDestination(relPath: string): string {
	return relPath
		.replace(/^\//, '')
		.replace(NEEDS_PERCENT_ENCODING, (char) =>
			'%' + char.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0'),
		);
}

/** The whole embed, as it is inserted into the editor. */
export function imageEmbed(relPath: string): string {
	return `![alt](${encodeImageDestination(relPath)})`;
}

/** The one token `imageDirectory` expands. Spelled as Typora and SoloMD spell it. */
const FILENAME_TOKEN = '${filename}';

/**
 * The folder this document's images go in: the `imageDirectory` setting, with
 * `${filename}` standing for the document's own name.
 *
 * Without the token every document in a directory shares one `img/`, which is
 * what #714 asked to be rid of: `${filename}.assets` next to `notes/trip.md`
 * is `notes/trip.assets`, one image folder per document. The token is spelled
 * the way Typora and SoloMD spell it, because a user arriving from either
 * types what worked there.
 *
 * What comes back is a path *component*, not a path. `trip.assets` still has
 * to pass Rust's `safe_path_component`, which refuses separators, `.`, `..`
 * and absolute paths so the folder cannot leave the document's directory —
 * and that guard is why this function special-cases no stem of its own. A file
 * named `..md` expands to `.`, and Rust is the one that says no.
 *
 * The substitution is `split`/`join` rather than `String.replace` because the
 * replacement is a filename the user chose: `replace` reads `$&` and `$'` in a
 * replacement string as backreferences, so a document named `$&.md` would put
 * `${filename}.assets` on disk verbatim.
 */
export function resolveImageDirectory(setting: string, documentPath: string): string {
	const template = setting || DEFAULT_IMAGE_DIRECTORY;
	if (!template.includes(FILENAME_TOKEN)) return template;
	const base = documentPath.split(/[/\\]/).pop() ?? documentPath;
	const dot = base.lastIndexOf('.');
	// `.gitignore` is all name and no extension: only a dot with something in
	// front of it separates the two.
	const stem = dot > 0 ? base.slice(0, dot) : base;
	return template.split(FILENAME_TOKEN).join(stem);
}
