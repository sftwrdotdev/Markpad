import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { processMarkdownHtml } from '../src/lib/utils/markdown.ts';
import { useShimDom } from './preview.domShim.ts';
import { parseHtml } from './renderProtocolDom.ts';

// Raw HTML players load local files the way images do: relative to the document.
describe('raw HTML video and audio sources', () => {
	useShimDom({ window: { __TAURI_INTERNALS__: { convertFileSrc: (path: string) => `asset://localhost/${path}` } } });

	const srcs = (html: string) =>
		parseHtml(processMarkdownHtml(html, '/documents/notes.md', new Set()))
			.body.querySelectorAll('video, audio, source')
			.map((el) => el.getAttribute('src'));

	test('a player src and a nested source resolve against the document', () => {
		assert.deepEqual(srcs('<video controls src="clips/demo.mp4"></video>'), ['asset://localhost//documents/clips/demo.mp4']);
		assert.deepEqual(srcs('<audio controls><source src="../a%20b.mp3" type="audio/mpeg"></audio>'), [null, 'asset://localhost//a b.mp3']);
	});

	test('a media link written as an image is converted once', () => {
		assert.deepEqual(srcs('<p><img src="clip.mp4" alt="" /></p>'), ['asset://localhost//documents/clip.mp4']);
	});

	test('web sources stay as written', () => {
		assert.deepEqual(srcs('<video src="https://example.com/a.mp4"></video>'), ['https://example.com/a.mp4']);
	});
});
