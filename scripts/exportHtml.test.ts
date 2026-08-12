import assert from 'node:assert/strict';
import { test } from 'node:test';

import { parseFrontMatter } from '../src/lib/utils/frontMatter.js';
import {
	isAssetUrl,
	normalizeAssetPath,
	renderStaticFrontMatterPanel,
	resolveExportImagePath,
	rewriteMarkdownHrefForExport,
} from '../src/lib/utils/exportHtml.js';
import { resolveMarkdownTargetPath } from '../src/lib/utils/markdownLinks.js';

test('normalizeAssetPath decodes Tauri asset URLs for Windows drive paths and UNC paths', () => {
	assert.equal(
		normalizeAssetPath('asset://localhost/C:/Users/Daniel/My%20Pictures/diagram.png'),
		'C:/Users/Daniel/My Pictures/diagram.png',
	);
	assert.equal(
		normalizeAssetPath('asset://localhost/%5C%5Cserver%5Cshare%5Cimage.png'),
		'\\\\server\\share\\image.png',
	);
});

test('normalizeAssetPath accepts the shape convertFileSrc actually emits on Windows', () => {
	// convertFileSrc returns `http://asset.localhost/...` on Windows and Android,
	// and `asset://localhost/...` elsewhere. Only the second form was handled, so
	// no local image was ever inlined into a Windows export.
	assert.equal(
		normalizeAssetPath('http://asset.localhost/C%3A%2FUsers%2FDaniel%2Fimg%2Fdiagram.png'),
		'C:/Users/Daniel/img/diagram.png',
	);
	assert.equal(
		normalizeAssetPath('https://asset.localhost/C%3A%2FDocs%2Fa%20b.png'),
		'C:/Docs/a b.png',
	);
	// Look-alike hosts must stay remote.
	assert.equal(normalizeAssetPath('http://asset.localhost.evil.test/C:/secret.png'), null);
	assert.equal(normalizeAssetPath('http://asset.localhostx/C:/secret.png'), null);
	assert.equal(normalizeAssetPath('https://example.test/a.png'), null);
});

test('isAssetUrl distinguishes asset URLs from ordinary remote ones', () => {
	assert.equal(isAssetUrl('asset://localhost/a.png'), true);
	assert.equal(isAssetUrl('http://asset.localhost/a.png'), true);
	assert.equal(isAssetUrl('https://asset.localhost/a.png'), true);
	assert.equal(isAssetUrl('http://asset.localhost.evil.test/a.png'), false);
	assert.equal(isAssetUrl('https://example.test/a.png'), false);
});

test('a Windows asset URL is inlined rather than treated as a remote image', () => {
	// The remote-scheme bail-out used to run first, so the Windows asset URL was
	// dropped before it could be recognised: not inlined, and not counted as a
	// missing image either, so the export silently shipped a dead link.
	assert.equal(
		resolveExportImagePath('http://asset.localhost/C%3A%2FDocs%2Fimg%2Fa.png', 'C:\\Docs\\note.md'),
		'C:/Docs/img/a.png',
	);
	assert.equal(resolveExportImagePath('http://asset.localhost.evil.test/a.png', 'C:\\Docs\\note.md'), null);
});

test('resolveExportImagePath preserves remote/data images and resolves local paths cross-platform', () => {
	assert.equal(resolveExportImagePath('https://example.test/a.png', 'C:\\Docs\\note.md'), null);
	assert.equal(resolveExportImagePath('data:image/png;base64,abc', '/home/daniel/note.md'), null);
	assert.equal(resolveExportImagePath('img/a%20b.png', 'C:\\Docs\\note.md'), 'C:/Docs/img/a b.png');
	assert.equal(resolveExportImagePath('./img/a.png', '/home/daniel/docs/note.md'), '/home/daniel/docs/img/a.png');
	assert.equal(resolveExportImagePath('/home/daniel/assets/a.png', '/home/daniel/docs/note.md'), '/home/daniel/assets/a.png');
});

test('the path resolver for documents and the one for hrefs differ on purpose', () => {
	// Two functions called `resolvePath` used to sit in markdown.ts and
	// markdownLinks.ts. They are NOT copies that drifted, and collapsing them
	// would have silently changed one caller or the other, so they are named
	// apart now and their three differences are pinned here — through the public
	// entry points, since the href one is private to its module.
	//
	// The image side is `resolveDocumentRelativePath` (via resolveExportImagePath),
	// the link side `resolveHrefRelativePath` (via resolveMarkdownTargetPath).
	const target = (path: string) => ({ path, hash: '' });

	// 1. `\` in the relative half. An image path is a filesystem path: a Windows
	//    author's `img\a.png` names a directory. An href is a URL: `\` is an
	//    ordinary character and the name must survive intact.
	assert.equal(resolveExportImagePath('img\\a.png', '/notes/index.md'), '/notes/img/a.png');
	assert.equal(
		resolveMarkdownTargetPath('/notes/index.md', target('sub\\other.md')),
		'/notes/sub\\other.md',
	);

	// 2. Empty segments. A path is bytes for the OS; an href gets tidied.
	assert.equal(resolveExportImagePath('a//b.png', '/notes/index.md'), '/notes/a//b.png');
	assert.equal(resolveMarkdownTargetPath('/notes/index.md', target('a//b.md')), '/notes/a/b.md');

	// 3. A base with no separator. The href side would answer `/other.md` — the
	//    filesystem root, a real and wrong directory — so its caller refuses the
	//    empty base outright. The document side answers relatively and lets
	//    resolveLocalFileLinkPath do the refusing (see localFileLinks.test.ts).
	assert.equal(resolveExportImagePath('a.png', ''), 'a.png');
	assert.equal(resolveMarkdownTargetPath('', target('other.md')), null);
});

test('rewriteMarkdownHrefForExport rewrites local Markdown links and preserves query/hash', () => {
	assert.equal(rewriteMarkdownHrefForExport('notes/Plan%20A.md#todo'), 'notes/Plan%20A.html#todo');
	assert.equal(rewriteMarkdownHrefForExport('../x/readme.markdown?raw=1#top'), '../x/readme.html?raw=1#top');
	assert.equal(rewriteMarkdownHrefForExport('C:/Docs/spec.mdown#sec'), 'C:/Docs/spec.html#sec');
	assert.equal(rewriteMarkdownHrefForExport('https://example.test/a.md'), 'https://example.test/a.md');
	assert.equal(rewriteMarkdownHrefForExport('mailto:test@example.test'), 'mailto:test@example.test');
});

test('renderStaticFrontMatterPanel exports a collapsed, non-interactive properties block', () => {
	const parsed = parseFrontMatter(`---
type: plan
keywords: [logger, synlog]
draft: false
---

# Body
`);

	const html = renderStaticFrontMatterPanel(parsed);

	assert.match(html, /<details class="frontmatter-panel export-frontmatter-panel">/);
	assert.match(html, /<summary class="frontmatter-summary">/);
	assert.match(html, /<span class="frontmatter-title">Properties<\/span>/);
	assert.match(html, /<span class="frontmatter-tag">logger<\/span>/);
	assert.match(html, /<span class="frontmatter-tag">synlog<\/span>/);
	assert.doesNotMatch(html, /\sopen(?:\s|>)/);
	assert.doesNotMatch(html, /<(?:input|button|textarea|select)\b/i);
});
