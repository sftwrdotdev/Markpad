import assert from 'node:assert/strict';
import test from 'node:test';

import { normalizeAssetPath } from '../src/lib/utils/exportHtml.js';
import { offsetOf, readSource, sliceBetween } from './sourceTree.js';

/*
 * "Save image as" could never save a remote image, and on Windows it could not
 * save a LOCAL one either.
 *
 * The branch it took was `src.startsWith('http')` -> `fetch(src)`. Two things
 * are wrong with that:
 *
 * - The app's CSP is `connect-src 'self'`, so a cross-origin `fetch` from the
 *   webview is refused before a request is made. (`img-src ... https:` is a
 *   different directive: it governs what an `<img>` may DISPLAY.) The remote
 *   case was therefore unreachable on every platform.
 * - `convertFileSrc` spells a local file's asset URL
 *   `http://asset.localhost/<encoded path>` on Windows and
 *   `asset://localhost/<encoded path>` everywhere else. The `asset:` test
 *   above it only recognised the second, so on Windows every local image fell
 *   into that unreachable remote branch.
 *
 * The shape-recognition half is `normalizeAssetPath` (#363), which already had
 * tests for both spellings and for lookalike hosts. This file asserts that the
 * viewer now uses it — reuse is the fix, so the assertions are about the call
 * site — plus the two properties the reuse buys, run against the real function.
 */

const viewer = readSource('src/lib/MarkdownViewer.svelte');
const body = sliceBetween(viewer, 'async function saveImageAs', 'async function saveDiagramAs');

test('a Windows asset URL names the same file as the asset: form', () => {
	// The property the old `startsWith('asset:')` test lacked. Running it here
	// rather than trusting the import means a future change to
	// `normalizeAssetPath` that dropped the Windows spelling would fail this
	// suite as well as the export's.
	assert.equal(
		normalizeAssetPath('http://asset.localhost/C%3A%2FDocs%2Fimg%2Fa.png'),
		'C:/Docs/img/a.png',
	);
	assert.equal(
		normalizeAssetPath('asset://localhost/C:/Docs/img/a.png'),
		'C:/Docs/img/a.png',
	);
});

test('a host that merely starts with asset.localhost is not a local file', () => {
	// The reason to reuse the helper instead of writing
	// `src.startsWith('http://asset.localhost')` here: that test would accept
	// this, and hand `copy_file` a path taken from a page the document links to.
	assert.equal(normalizeAssetPath('http://asset.localhost.evil.test/C:/secret.png'), null);
	assert.equal(normalizeAssetPath('https://example.com/a.png'), null);
	assert.equal(normalizeAssetPath('data:image/png;base64,AAA'), null);
});

test('the viewer recognises an asset URL with the shared helper', () => {
	assert.match(body, /normalizeAssetPath\(src\)/);
	// The two hand-rolled tests this replaces. Either one coming back means the
	// Windows spelling is unhandled again.
	assert.doesNotMatch(body, /startsWith\('asset:'\)/);
	assert.doesNotMatch(body, /startsWith\('http'\)/);
});

test('nothing tries to fetch image bytes from the webview any more', () => {
	// Dead code that reads like a working feature: it opened no dialog, wrote
	// no file, and reported a network failure that never happened.
	assert.doesNotMatch(body, /fetch\(/);
	assert.doesNotMatch(body, /arrayBuffer\(/);
	assert.doesNotMatch(body, /save_file_binary/);
});

test('a local image is copied on the Rust side', () => {
	assert.match(body, /invoke\('copy_file', \{ src: realPath, dest \}\)/);
	// And the save dialog is only offered for a file that can actually be
	// written; the remote case bails out before it.
	const bail = offsetOf(body, "t('toast.remoteImageNotSupported'");
	const dialog = offsetOf(body, 'await save(');
	assert.ok(bail < dialog, 'do not ask for a destination that cannot be written');
});

test('the CSP that makes the remote case impossible is still the one described', () => {
	// If `connect-src` is ever widened, the comment above stops being true and
	// a JS download becomes possible again. Fail here rather than leave a
	// stale explanation in the source.
	const conf = readSource('src-tauri/tauri.conf.json');
	assert.match(conf, /"connect-src":\s*"'self'"/);
});
