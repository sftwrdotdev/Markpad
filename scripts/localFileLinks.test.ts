import assert from 'node:assert/strict';
import test from 'node:test';

import { resolveLocalFileLinkPath } from '../src/lib/utils/localFileLinks.js';
import { offsetOf, readSource, sliceBetween } from './sourceTree.js';

/*
 * `[data](./data.csv)` did nothing on macOS and Linux, and opened a dead page
 * in the browser on Windows.
 *
 * The link is a path, but the click handler passed `anchor.href` — which the
 * DOM had already resolved against the webview's own origin. That origin is
 * `tauri://localhost` on macOS and Linux and `http://tauri.localhost` on
 * Windows, and the opener plugin's scope allows `mailto:`, `tel:`, `http://*`
 * and `https://*` (tauri-plugin-opener `allow-default-urls`). So the first
 * form was rejected as ForbiddenUrl — and, because the call was not awaited
 * inside a try/catch, the rejection went unhandled and the click was silent —
 * while the second matched `http://*` and was genuinely handed to the browser.
 *
 * The resolver below is pure, so these run the real code. The wiring in the
 * component is asserted against its source; those tests establish the order of
 * the branches and that both OS calls are guarded, not what the OS then does.
 */

const CURRENT = '/notes/doc.md';

test('a relative link resolves against the open file', () => {
	assert.equal(resolveLocalFileLinkPath('./data.csv', CURRENT), '/notes/data.csv');
	assert.equal(resolveLocalFileLinkPath('data.csv', CURRENT), '/notes/data.csv');
	assert.equal(resolveLocalFileLinkPath('../assets/report.pdf', CURRENT), '/assets/report.pdf');
	assert.equal(resolveLocalFileLinkPath('sub/dir/data.csv', CURRENT), '/notes/sub/dir/data.csv');
});

test('the path is decoded and stripped of URL decoration', () => {
	// The href in the document is percent-encoded markdown, not a filename.
	assert.equal(resolveLocalFileLinkPath('./my%20file.csv', CURRENT), '/notes/my file.csv');
	// A query string or fragment belongs to URLs; on disk they are part of no
	// filename, and leaving them on would look up a file that does not exist.
	assert.equal(resolveLocalFileLinkPath('./data.csv?v=2', CURRENT), '/notes/data.csv');
	assert.equal(resolveLocalFileLinkPath('./data.csv#row3', CURRENT), '/notes/data.csv');
});

test('absolute and Windows paths are taken as written', () => {
	assert.equal(resolveLocalFileLinkPath('/srv/shared/data.csv', CURRENT), '/srv/shared/data.csv');
	// A drive letter looks like a scheme and must not be treated as one.
	assert.equal(resolveLocalFileLinkPath('C:\\docs\\data.csv', CURRENT), 'C:/docs/data.csv');
	assert.equal(resolveLocalFileLinkPath('file:///tmp/data.csv', CURRENT), '/tmp/data.csv');
});

test('web addresses are left to the browser', () => {
	for (const href of [
		'https://example.com/data.csv',
		'http://example.com/data.csv',
		'mailto:someone@example.com',
		'tel:+15551234',
		'obsidian://open?vault=x',
		'data:text/csv;base64,YQ==',
		// Protocol-relative. The app already reads this as a web address for
		// markdown links, and reading it as a UNC path here would disagree.
		'//example.com/data.csv',
	]) {
		assert.equal(resolveLocalFileLinkPath(href, CURRENT), null, href);
	}
});

test('an in-page anchor is not a file', () => {
	assert.equal(resolveLocalFileLinkPath('#section', CURRENT), null);
	assert.equal(resolveLocalFileLinkPath('', CURRENT), null);
	assert.equal(resolveLocalFileLinkPath('   ', CURRENT), null);
});

test('an unsaved buffer has nothing to resolve a relative link against', () => {
	// `resolveDocumentRelativePath('', './data.csv')` yields `data.csv`, which the OS would
	// open relative to the process's working directory — some arbitrary file,
	// or none. Refusing is the only honest answer.
	assert.equal(resolveLocalFileLinkPath('./data.csv', ''), null);
	assert.equal(resolveLocalFileLinkPath('data.csv', ''), null);
	// An absolute link still names exactly one file.
	assert.equal(resolveLocalFileLinkPath('/srv/data.csv', ''), '/srv/data.csv');
	assert.equal(resolveLocalFileLinkPath('C:\\data.csv', ''), 'C:/data.csv');
});

test('a markdown link still resolves to a path, so branch order is what keeps it in-app', () => {
	// Opening `./other.md` in a tab is a different, older feature. This
	// resolver cannot tell the two apart and must not try to; the click handler
	// asks about markdown targets first. The next test pins that order.
	assert.equal(resolveLocalFileLinkPath('./other.md', CURRENT), '/notes/other.md');
});

// --- wiring ------------------------------------------------------------------

const viewer = readSource('src/lib/MarkdownViewer.svelte');
const handler = sliceBetween(viewer, 'async function handleDocumentClick', 'let zoomLevel');

test('markdown targets are still claimed before the local-file branch', () => {
	const markdown = offsetOf(handler, 'getRelativeMarkdownTarget(rawHref)');
	const local = offsetOf(handler, 'resolveLocalFileLinkPath(rawHref, currentFile)');
	assert.ok(markdown < local, '`./other.md` must open in a tab, not in an external editor');
});

test('a local file is handed to the OS as a path, not as a URL', () => {
	assert.match(handler, /await openPath\(localFilePath\)/);
	// The raw attribute, not `anchor.href`: the latter is the origin-resolved
	// URL that caused the bug.
	assert.match(handler, /resolveLocalFileLinkPath\(rawHref, currentFile\)/);
	const local = offsetOf(handler, 'resolveLocalFileLinkPath');
	const url = offsetOf(handler, 'await openUrl(anchor.href)');
	assert.ok(local < url, 'a local file must be caught before the URL fallback');
});

test('the capability still grants the command this depends on', () => {
	// `open_path` needs both the command grant and a path scope. Granting the
	// command alone leaves the plugin resolving
	// `fs_scope.is_allowed(path) && allowed.any(matches_path_program)` against
	// URL-only scope entries, which answer false to the second — that is how
	// `openPath` came to be refused with ForbiddenPath everywhere, including in
	// `askToOpenExportedFile` (#399, fixed in #403). Asserted here so the grant
	// cannot quietly disappear; the scope's shape is deliberately not asserted,
	// so narrowing it later is not a test failure.
	const capability = readSource('src-tauri/capabilities/default.json');
	assert.match(capability, /opener:allow-open-path/);
});

test('neither OS call can leave an unhandled rejection behind', () => {
	// `openUrl` rejects for anything outside the opener scope. Unawaited-in-
	// try/catch, that rejection was the whole visible symptom on macOS: nothing
	// happened, and nothing said why.
	for (const call of ['await openPath(localFilePath)', 'await openUrl(anchor.href)']) {
		const at = offsetOf(handler, call);
		const before = handler.slice(0, at);
		const tryAt = before.lastIndexOf('try {');
		assert.notEqual(tryAt, -1, `${call} must be inside a try block`);
		offsetOf(handler, '} catch (error) {', at); // must have a catch after it
		assert.ok(before.slice(tryAt).split('} catch').length === 1, `${call} must be inside the nearest try`);
	}
	assert.equal(handler.match(/t\('toast\.openFailed'/g)?.length, 2, 'both failures are reported');
});

test('an asset URL is never treated as a link to a local file', () => {
	// `resolveExportImagePath` accepts `asset://localhost/…` and
	// `http://asset.localhost/…` on purpose: that is the shape a local image's
	// `src` takes inside the webview, and the exporter has to turn it back into
	// a disk path to inline the bytes. A *link* is the opposite situation — the
	// href is the author's own text — so inheriting that clause let a document
	// write a link that reads as a remote address in the link text and the
	// status bar while resolving to a local path and going to the OS default
	// handler.
	for (const href of [
		'http://asset.localhost/etc/passwd',
		'https://asset.localhost/Users/me/.ssh/id_rsa',
		'http://asset.localhost/C:/Windows/System32/drivers/etc/hosts',
		'asset://localhost/etc/hosts',
		'ASSET://LOCALHOST/etc/hosts',
		'HTTP://ASSET.LOCALHOST/etc/passwd',
	]) {
		assert.equal(resolveLocalFileLinkPath(href, CURRENT), null, href);
	}

	// The host is matched as a whole label, so a lookalike is a plain remote
	// address and was never in scope — asserted so a future loosening of the
	// pattern cannot pass this file.
	assert.equal(resolveLocalFileLinkPath('http://asset.localhost.evil.test/etc/passwd', CURRENT), null);

	// Ordinary links keep working: this guard must not swallow them.
	assert.equal(resolveLocalFileLinkPath('./data.csv', CURRENT), '/notes/data.csv');
	assert.equal(resolveLocalFileLinkPath('https://example.com/page', CURRENT), null);
});
