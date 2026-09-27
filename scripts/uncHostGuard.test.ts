import assert from 'node:assert/strict';
import test from 'node:test';

import { getMarkdownLinkTarget, resolveMarkdownTargetPath } from '../src/lib/utils/markdownLinks.js';
import { installShimDom, parseHtml, type ShimElement } from './renderProtocolDom.ts';

/*
 * Touching a UNC path (`\\host\share\x`, also `//host/share/x`) makes Windows
 * connect to `host` over SMB and offer the user's NTLM credentials. #869 closed
 * that for clicked local-file links; the same path reached the OS from two
 * other places. The rule is the one `resolveLocalFileLinkPath` already applies:
 * a UNC path is refused unless the open document lives on the same host.
 */

installShimDom();
// `convertFileSrc` forwards to the Tauri runtime; stand in for it with the
// shape it produces so the test can see which paths were handed over.
(globalThis as unknown as Record<string, unknown>).window = {
	__TAURI_INTERNALS__: {
		convertFileSrc: (path: string, protocol: string) => `${protocol}://localhost/${encodeURIComponent(path)}`,
	},
};

const { processMarkdownHtml } = await import('../src/lib/utils/markdown.ts');

function mediaSrcs(html: string, filePath: string): (string | null)[] {
	const root = parseHtml(processMarkdownHtml(html, filePath, new Set()));
	return (root.querySelectorAll('img, video, audio') as unknown as ShimElement[]).map((el) =>
		el.getAttribute('src'),
	);
}

test('an image on another host is not loaded', () => {
	// No click needed: rendering the document is enough to fetch it.
	for (const src of [
		'//evil.example/share/a.png',
		'%2F%2Fevil.example%2Fshare%2Fa.png',
		'/%5Cevil.example%5Cshare%5Ca.png',
	]) {
		for (const doc of ['C:\\notes\\doc.md', '/notes/doc.md', '//server/share/doc.md']) {
			const [out] = mediaSrcs(`<p><img src="${src}"></p>`, doc);
			assert.ok(!out, `${src} in ${doc} became ${out}`);
		}
	}
	// An unsaved buffer has no directory: `\\evil\…` split on `\` and joined
	// onto nothing comes out as `//evil/…`.
	const [unsaved] = mediaSrcs('<p><img src="%5C%5Cevil.example%5Cshare%5Ca.png"></p>', '');
	assert.ok(!unsaved, `unsaved buffer loaded ${unsaved}`);
});

test('audio and video on another host are not loaded either', () => {
	for (const src of ['//evil.example/share/a.mp4', '//evil.example/share/a.mp3']) {
		const [out] = mediaSrcs(`<p><img src="${src}"></p>`, 'C:\\notes\\doc.md');
		assert.ok(!out, `${src} became ${out}`);
	}
});

test('a document on a share still loads its own images', () => {
	const [relative] = mediaSrcs('<p><img src="img/a.png"></p>', '\\\\server\\share\\notes\\doc.md');
	assert.equal(relative, `asset://localhost/${encodeURIComponent('//server/share/notes/img/a.png')}`);
	const [absolute] = mediaSrcs('<p><img src="//SERVER/other/a.png"></p>', '//server/share/doc.md');
	assert.equal(absolute, `asset://localhost/${encodeURIComponent('//SERVER/other/a.png')}`);
	// And a document on a local disk still loads local images.
	const [local] = mediaSrcs('<p><img src="img/a.png"></p>', 'C:\\notes\\doc.md');
	assert.equal(local, `asset://localhost/${encodeURIComponent('C:/notes/img/a.png')}`);
	const [video] = mediaSrcs('<p><img src="clip.mp4"></p>', '//server/share/doc.md');
	assert.equal(video, `asset://localhost/${encodeURIComponent('//server/share/clip.mp4')}`);
});

function markdownTarget(href: string, currentFile: string): string | null {
	const target = getMarkdownLinkTarget(href);
	return target && resolveMarkdownTargetPath(currentFile, target);
}

test('a markdown link to a document on another host is not opened', () => {
	// comrak writes `\` in a destination as `%5C`, and `getMarkdownLinkTarget`
	// decodes it, so `//host` being refused did not cover `\\host`.
	for (const href of [
		'%5C%5Cevil.example%5Cshare%5Cx.md',
		'%2F%2Fevil.example%2Fshare%2Fx.md',
		'/%5Cevil.example%5Cshare%5Cx.md',
	]) {
		for (const doc of ['C:\\notes\\doc.md', '/notes/doc.md', '//server/share/doc.md', '']) {
			assert.equal(markdownTarget(href, doc), null, `${href} from ${doc}`);
		}
	}
});

test('a document on a share still opens the documents beside it', () => {
	assert.equal(markdownTarget('other.md', '\\\\server\\share\\doc.md'), '//server/share/other.md');
	assert.equal(markdownTarget('%5C%5Cserver%5Cshare%5Cx.md', '//server/share/doc.md'), '\\\\server\\share\\x.md');
	assert.equal(markdownTarget('other.md', 'C:\\notes\\doc.md'), 'C:/notes/other.md');
	assert.equal(markdownTarget('/notes/other.md', '/notes/doc.md'), '/notes/other.md');
});
