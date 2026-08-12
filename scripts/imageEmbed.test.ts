import assert from 'node:assert/strict';
import test from 'node:test';

import { resolveExportImagePath } from '../src/lib/utils/exportHtml.js';
import {
	DEFAULT_IMAGE_DIRECTORY,
	documentParentDir,
	encodeImageDestination,
	imageEmbed,
} from '../src/lib/utils/imageEmbed.js';
import { resolveDocumentRelativePath } from '../src/lib/utils/markdown.js';
import { readSource } from './sourceTree.js';

/*
	The link the app writes for a pasted or dropped image has to name the file
	Rust just created — after a CommonMark parse, and after each of Markpad's
	two readers has had its way with the result.

	So every case below is checked end to end, through the real readers:

	  parse    the destination CommonMark hands the renderer, per its grammar
	  preview  `processMarkdownHtml`: decodeURIComponent, then resolve
	  export   `resolveExportImagePath`, imported here, not modelled

	The one thing modelled rather than run is comrak, which is Rust. Its
	`escape_href` (comrak 0.54, src/html.rs) is the identity on everything
	`encodeImageDestination` emits: its safe set covers the unreserved ASCII we
	pass through, it copies a `%` verbatim when two hex digits follow, and the
	two characters it does rewrite — `&` to `&amp;`, `'` to `&#x27;` — are
	undone by the HTML parser before either reader sees them. Passing the
	destination straight to the readers is therefore faithful, and
	`the escapes comrak passes through unchanged` below pins the assumption
	that matters.
*/

/**
 * The destination CommonMark reads out of `![alt](…)`: it ends at the first
 * ASCII space or control character, and parentheses count only while balanced.
 * This is where `photo).png` loses its tail, so the fix has to be visible here
 * before anything downstream is worth checking.
 */
function parseDestination(embed: string): string {
	const open = embed.indexOf('](');
	assert.notEqual(open, -1, `not an inline image: ${embed}`);

	let depth = 1;
	let i = open + 2;
	for (; i < embed.length; i++) {
		const char = embed[i];
		if (char.charCodeAt(0) <= 0x20) break;
		if (char === '\\') {
			i++;
			continue;
		}
		if (char === '(') depth++;
		if (char === ')' && --depth === 0) break;
	}
	return embed.slice(open + 2, i);
}

/** What the preview does with a `src` in `processMarkdownHtml`. */
function previewResolves(destination: string, tabPath: string): string {
	return resolveDocumentRelativePath(tabPath, decodeURIComponent(destination));
}

const TAB_PATH = '/home/u/notes/note.md';

/**
 * `relPath` is what `save_image` / `copy_file_to_img` return: the image
 * directory and the file name joined with `/`, relative to the document.
 */
function roundTrips(relPath: string, expectedFile: string) {
	const destination = parseDestination(imageEmbed(relPath));

	assert.equal(
		destination,
		encodeImageDestination(relPath),
		'CommonMark truncated the destination',
	);
	assert.equal(previewResolves(destination, TAB_PATH), expectedFile, 'preview');
	assert.equal(resolveExportImagePath(destination, TAB_PATH), expectedFile, 'export');
}

test('a file name whose # would otherwise become an anchor', () => {
	// The report: `![alt](img/note#1.png)` exports as `img/note`.
	roundTrips('img/note#1.png', '/home/u/notes/img/note#1.png');
	assert.equal(imageEmbed('img/note#1.png'), '![alt](img/note%231.png)');
});

test('spaces, which were the only thing the old code escaped', () => {
	roundTrips('img/my photo.png', '/home/u/notes/img/my photo.png');
	assert.equal(imageEmbed('img/my photo.png'), '![alt](img/my%20photo.png)');
});

test('an unbalanced parenthesis, which ends the link early', () => {
	roundTrips('img/photo).png', '/home/u/notes/img/photo).png');
	roundTrips('img/photo(1.png', '/home/u/notes/img/photo(1.png');
});

test('balanced parentheses, which CommonMark allows and we encode anyway', () => {
	// Legal unescaped, so this is a deliberate cost: one rule beats a paren
	// counter, and both spellings name the same file at every reader.
	roundTrips('img/photo (1).png', '/home/u/notes/img/photo (1).png');
});

test('a ? , which the export resolver reads as a query string', () => {
	roundTrips('img/really?.png', '/home/u/notes/img/really?.png');
});

test('a literal % , which decodes back into a different name unencoded', () => {
	// comrak copies `%20` through untouched, so an unencoded `50%20off.png`
	// reaches decodeURIComponent and comes out as `50 off.png`.
	roundTrips('img/50%20off.png', '/home/u/notes/img/50%20off.png');
	assert.equal(imageEmbed('img/50%20off.png'), '![alt](img/50%2520off.png)');
});

test('a backslash, which CommonMark reads as an escape', () => {
	// Encoded for the parse — unencoded, `\(` is an escape and the destination
	// comes out as `img/a(b.png`, a different file.
	assert.equal(imageEmbed('img/a\\(b.png'), '![alt](img/a%5C%28b.png)');
	assert.equal(parseDestination(imageEmbed('img/a\\(b.png')), 'img/a%5C%28b.png');

	// Not round-tripped, and this is the one case that cannot be: both readers
	// resolve through a path splitter that counts `\` as a directory separator
	// on purpose, because a Windows author writes `![](img\a.png)` and means
	// one. See resolveDocumentRelativePath in src/lib/utils/markdown.ts. A
	// POSIX file whose *name* contains a backslash is unreachable through a
	// Markpad link however it is spelled, so nothing here can fix it.
	assert.equal(
		previewResolves('img/a%5C%28b.png', TAB_PATH),
		'/home/u/notes/img/a/(b.png',
	);
});

test('an imageDirectory carrying the same characters', () => {
	roundTrips('my imgs #1/photo.png', '/home/u/notes/my imgs #1/photo.png');
	roundTrips('assets (old)/a?.png', '/home/u/notes/assets (old)/a?.png');
});

test('an empty imageDirectory, whose leading slash is not an absolute path', () => {
	// Rust joins with `/`, so an empty setting yields `/photo.png`; left alone
	// it resolves to the filesystem root at both readers.
	roundTrips('/photo #1.png', '/home/u/notes/photo #1.png');
	assert.equal(imageEmbed('/photo #1.png'), '![alt](photo%20%231.png)');
});

test('non-ASCII names stay readable in the document', () => {
	// The reason encodeURI/encodeURIComponent were not used: both would write
	// `%E5%9B%BE%E7%89%87/…` into a file a person reads.
	assert.equal(imageEmbed('图片/截图.png'), '![alt](图片/截图.png)');
	roundTrips('图片/截图 1.png', '/home/u/notes/图片/截图 1.png');
});

test('the escapes comrak passes through unchanged', () => {
	// Every byte we emit is either in comrak's HREF_SAFE set or a `%` followed
	// by two hex digits, which its escape_href copies verbatim. If this ever
	// fails, the destination is being double-escaped on the way to the HTML.
	const safe = /^(?:[-_.+!*(),#@?=;:/$~a-zA-Z0-9]|%[0-9A-F]{2}|[^\x00-\x7f])*$/;
	for (const relPath of ['img/note#1.png', 'img/my photo.png', 'img/50%20off.png']) {
		assert.match(encodeImageDestination(relPath), safe);
	}
});

test('angle brackets would need the export resolver changed to work', () => {
	// The other candidate, and the form headingReference.ts uses for spaces and
	// parentheses. It answers the CommonMark grammar and nothing else: the `#`
	// reaches the readers raw, and the export resolver — correctly, for a URL —
	// treats it as a fragment. Recorded so the choice is not re-litigated from
	// memory; if this ever starts returning the whole path, angle brackets are
	// back on the table.
	assert.equal(parseDestination('![alt](<img/note#1.png>)'), '<img/note#1.png>');
	assert.equal(resolveExportImagePath('img/note#1.png', TAB_PATH), '/home/u/notes/img/note');
	assert.equal(resolveExportImagePath('img/a?.png', TAB_PATH), '/home/u/notes/img/a');
});

test('documentParentDir refuses a path with no directory in it', () => {
	assert.equal(documentParentDir('/home/u/notes/note.md'), '/home/u/notes');
	assert.equal(documentParentDir('C:\\notes\\note.md'), 'C:\\notes');
	assert.equal(documentParentDir('note.md'), null);
});

test('Editor.svelte writes an image link through this module only', () => {
	// The two call sites — paste (`save_image`) and drop (`copy_file_to_img`) —
	// carried verbatim copies of this logic 300 lines apart, and the space-only
	// escape had to be fixed in both. singleImplementationConvention.test.ts
	// keeps the embed string itself single; this keeps the pre-fix escape from
	// coming back next to it.
	const source = readSource('src/lib/components/Editor.svelte');
	assert.equal(source.includes('%20'), false, 'a hand-rolled space escape is back');
	assert.match(source, /imageEmbed\(relPath\)/);
	assert.equal(source.includes(`|| "${DEFAULT_IMAGE_DIRECTORY}"`), false);
});
