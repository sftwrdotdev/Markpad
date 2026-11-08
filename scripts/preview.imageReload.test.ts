import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { processMarkdownHtml, refetchLocalImages, stampImageGeneration } from '../src/lib/utils/markdown.ts';
import { useShimDom } from './preview.domShim.ts';
import { parseHtml } from './renderProtocolDom.ts';

// #1066: Reload must fetch an image edited on disk again, not reuse the old copy.
describe('reload refetches local images', () => {
	useShimDom({ window: { __TAURI_INTERNALS__: { convertFileSrc: (path: string) => `asset://localhost/${path}` } } });

	const FILE_PATH = '/documents/notes.md';
	const RENDERED = '<p data-sourcepos="1:1-1:4">text</p>\0<p data-sourcepos="3:1-3:12"><img src="a.png" alt="" /></p>';
	const srcOf = (html: string) => parseHtml(processMarkdownHtml(html, FILE_PATH, new Set())).body.querySelector('img')?.getAttribute('src');

	test('before any reload the markup and the URL are untouched', () => {
		assert.equal(stampImageGeneration(RENDERED), RENDERED);
		assert.equal(srcOf(RENDERED), 'asset://localhost//documents/a.png');
	});

	test('each reload changes only the blocks holding an image, and their URL', () => {
		refetchLocalImages();
		const first = stampImageGeneration(RENDERED).split('\0');
		assert.equal(first[0], RENDERED.split('\0')[0], 'a block without an image would be re-inserted for nothing');
		assert.notEqual(first[1], RENDERED.split('\0')[1], 'the image block would be kept, so its <img> never reloads');
		assert.equal(srcOf(first.join('\0')), 'asset://localhost//documents/a.png?v=1');

		refetchLocalImages();
		assert.equal(srcOf(stampImageGeneration(RENDERED)), 'asset://localhost//documents/a.png?v=2');
	});

	test('the stamp does not survive into the preview, and only real img tags get it', () => {
		const html = processMarkdownHtml(stampImageGeneration(RENDERED), FILE_PATH, new Set());
		assert.doesNotMatch(html, /data-image-generation/);
		assert.match(stampImageGeneration('<IMG src="b.png">'), /data-image-generation/);
		assert.equal(stampImageGeneration('<imgx src="b.png">'), '<imgx src="b.png">');
	});

	// The stamp is text, so it also lands on `<img` written inside raw HTML's
	// attribute values. Unquoted, it cannot close the attribute it lands in.
	test('an <img> written inside an attribute value leaves the attribute whole', () => {
		const body = parseHtml(stampImageGeneration('<p><span title="a <img> b">x</span></p>')).body;
		assert.equal(body.querySelector('span')?.textContent, 'x');
		assert.match(body.querySelector('span')?.getAttribute('title') ?? '', /^a <img .*> b$/);
	});

	test('a remote image keeps the URL its author wrote', () => {
		assert.equal(srcOf(stampImageGeneration('<p><img src="https://example.com/a.png" /></p>')), 'https://example.com/a.png');
	});
});
