export type MarkdownLinkTarget = {
	path: string;
	hash: string;
};

// The one list of extensions Markpad treats as a document, and the lowest-level
// module that can hold it: everything that needs it — the link resolver below,
// the sanitizer's URI pattern (./sanitize.ts), the export's `.md` -> `.html`
// rewrite (./exportHtml.ts) and the Open dialog filter — imports it from here.
// Three hand-written copies of these five names used to exist, one of them
// documented as a copy and pinned by a test; a list is cheaper to share than to
// police.
//
// The Rust renderer keeps the only other copy, in `MARKDOWN_LINK_EXTENSIONS`
// in src-tauri/src/markdown.rs, because no import crosses that boundary. It is
// pinned against this one by `the extension list the rewriter mirrors still
// matches markdownLinks.ts` in scripts/wikilinkFileTargets.test.ts.
export const MARKDOWN_LINK_EXTENSIONS = ['md', 'markdown', 'mdown', 'mkd', 'txt'];

/** `.md`, `.markdown`, … anchored at the end of a path. Also used to replace it. */
export const MARKDOWN_LINK_EXTENSION_PATTERN = new RegExp(
	`\\.(?:${MARKDOWN_LINK_EXTENSIONS.map((ext) => ext.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})$`,
	'i',
);

export function decodeLinkPath(path: string): string {
	try {
		return decodeURIComponent(path);
	} catch {
		return path;
	}
}

export function hasMarkdownLinkExtension(path: string): boolean {
	return MARKDOWN_LINK_EXTENSION_PATTERN.test(path);
}

function isAbsoluteMarkdownPath(path: string): boolean {
	return path.startsWith('/') || path.startsWith('\\') || /^[a-z]:/i.test(path);
}

export function getMarkdownLinkTarget(href: string): MarkdownLinkTarget | null {
	const pathWithoutHash = href.split('#')[0].split('?')[0];
	const isMarkdownTarget = hasMarkdownLinkExtension(pathWithoutHash);
	const isWindowsDrivePath = /^[a-z]:/i.test(href);
	const isProtocolRelativeExternal = href.startsWith('//');
	const hasScheme = /^[a-z][a-z0-9+.-]*:/i.test(href);
	if (!isMarkdownTarget || isProtocolRelativeExternal || (hasScheme && !isWindowsDrivePath)) return null;

	const hashIndex = href.indexOf('#');
	return {
		path: decodeLinkPath(pathWithoutHash),
		hash: hashIndex === -1 ? '' : href.slice(hashIndex + 1),
	};
}

/**
 * Resolves the **href** of a markdown link against the document holding it.
 *
 * An href is URL-shaped even when it names a local file, which is what makes
 * this a different function from `resolveDocumentRelativePath` in ./markdown.ts
 * rather than a copy of it — see that function's comment for the three
 * differences and scripts/exportHtml.test.ts for the test that pins them. Here:
 * only `/` separates in the relative half (a `\` in a URL is a character, and
 * `sub\note.md` names one file), empty segments collapse (`a//b.md` is
 * `a/b.md`), and the base is normalized to `/` before its directory is taken.
 *
 * Not exported: `resolveMarkdownTargetPath` is the only caller, and it is what
 * refuses the degenerate bases — a base with no `/` at all would come back
 * rooted at `/`, which is a real directory and the wrong one.
 */
function resolveHrefRelativePath(base: string, relative: string): string {
	if (relative.startsWith('/') || /^[a-z]:/i.test(relative)) return relative;

	const normalizedBase = base.replace(/\\/g, '/');
	const baseDir = normalizedBase.substring(0, normalizedBase.lastIndexOf('/'));
	const stack = baseDir.split('/');
	const parts = relative.split('/');

	for (const part of parts) {
		if (part === '..') stack.pop();
		else if (part !== '.' && part !== '') stack.push(part);
	}

	return stack.join('/');
}

export function resolveMarkdownTargetPath(currentFile: string, target: MarkdownLinkTarget): string | null {
	if (isAbsoluteMarkdownPath(target.path)) return target.path;
	if (!currentFile) return null;
	return resolveHrefRelativePath(currentFile, target.path);
}

export function isOpenInNewTabMarkdownTarget(href: string, currentFile: string): boolean {
	const target = getMarkdownLinkTarget(href);
	if (!target) return false;
	return resolveMarkdownTargetPath(currentFile, target) !== null;
}

export function normalizeComparableMarkdownPath(path: string, osType: string): string {
	const normalized = path.replace(/\\/g, '/');
	const comparable = normalized.startsWith('//')
		? `//${normalized.slice(2).replace(/\/+/g, '/')}`
		: normalized.replace(/\/+/g, '/');
	if (osType === 'windows' || /^[a-z]:/i.test(comparable) || comparable.startsWith('//')) {
		return comparable.toLowerCase();
	}
	return comparable;
}
