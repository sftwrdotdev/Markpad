import { isAssetUrl, resolveExportImagePath } from './exportHtml.js';

const absoluteFilePathPattern = /^(?:[a-zA-Z]:[\\/]|\/|\\\\)/;

/**
 * The disk path a document link points at, or `null` when the link is not a
 * reference to a local file.
 *
 * A markdown link such as `[data](./data.csv)` is a *path*, but by the time it
 * reaches a click handler the DOM has already turned `anchor.href` into a URL
 * resolved against the webview's own origin — `tauri://localhost/data.csv` on
 * macOS and Linux, `http://tauri.localhost/data.csv` on Windows. Neither names
 * anything on disk, and the two platforms fail differently: the opener
 * plugin's scope allows `mailto:`, `tel:`, `http://*` and `https://*`, so the
 * first form is rejected outright while the second matches `http://*` and is
 * genuinely handed to the browser, which then shows a dead page. Resolving the
 * *raw* href against the open file is what both platforms actually need.
 *
 * The decision table — which schemes are remote, how a Windows drive letter or
 * a UNC path differs from a scheme, where a query string ends and a path
 * begins — is `resolveExportImagePath`'s (#363), which the HTML export already
 * relies on and which has its own tests, including the `asset.localhost` host
 * spoofing cases. Duplicating it here would be a second place to get
 * `C:\` versus `mailto:` wrong.
 *
 * Two rules are this caller's own:
 *
 * - `//host/path` is a protocol-relative web address, and the app already
 *   reads it that way for markdown links (`getMarkdownLinkTarget`). The image
 *   resolver would take it for a UNC path.
 * - A relative link in a buffer that has never been saved has no base to
 *   resolve against. Handing the fragment to the OS as if it were a path would
 *   open something arbitrary relative to the process's working directory.
 */
export function resolveLocalFileLinkPath(rawHref: string, currentFile: string): string | null {
	const trimmed = rawHref.trim();
	if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('//')) return null;

	// An asset URL is never a link the author wrote. `resolveExportImagePath`
	// accepts `asset://localhost/…` and `http://asset.localhost/…` because that
	// is the shape a local image's `src` takes inside the webview, and the
	// exporter has to turn those back into disk paths to inline them. A link is
	// the opposite situation: the href is the author's text, and accepting the
	// asset form there means `[report](http://asset.localhost/Users/me/.ssh/id_rsa)`
	// reads as a remote address everywhere the user can see it — the link text,
	// the status bar — while resolving to a local path that goes straight to the
	// OS default handler. Reusing the image resolver is right; inheriting that
	// one clause of it is not.
	if (isAssetUrl(trimmed)) return null;

	const resolved = resolveExportImagePath(trimmed, currentFile);
	if (!resolved) return null;
	if (!currentFile && !absoluteFilePathPattern.test(resolved)) return null;

	// Opening a UNC path makes Windows connect to its host over SMB and offer
	// the user's NTLM credentials, so a link to `\\host\share\x` leaks a
	// password hash to whoever wrote the document. The backslash and
	// percent-encoded spellings all arrive here as `//host/…`. A document that
	// already lives on a share may still link within that host.
	const host = uncHost(resolved);
	if (host !== null && host !== uncHost(currentFile)) return null;

	return resolved;
}

function uncHost(path: string): string | null {
	const match = /^[\\/]{2}([^\\/]+)/.exec(path);
	return match ? match[1].toLowerCase() : null;
}
