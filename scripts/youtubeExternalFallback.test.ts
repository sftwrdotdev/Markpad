import assert from 'node:assert/strict';
import test from 'node:test';

import { installShimDom, parseHtml, type ShimElement } from './renderProtocolDom.ts';
import { offsetOf, readSource, sliceBetween } from './sourceTree.js';

installShimDom();

const { processMarkdownHtml } = await import('../src/lib/utils/markdown.ts');

const markdownViewer = readSource('src/lib/MarkdownViewer.svelte');
const tauriConfig = readSource('src-tauri/tauri.conf.json');

// A YouTube link used to become an <iframe>, which meant the app had to allow
// framing youtube.com and the video played inside Markpad. It is now a
// thumbnail wrapped in an ordinary anchor, opened in the user's browser. The
// two halves have to stay in step: rendering an iframe again with the CSP
// closed produces a blank rectangle, and reopening the CSP for a renderer that
// no longer frames anything just widens the attack surface for nothing.
//
// This was asserted by matching markdown.ts for the shape of
// `replaceWithYoutubeLink` — its signature, each assignment inside it, and
// `doesNotMatch(/createElement\(["']iframe["']\)/)`. All of that describes how
// the function is written. `processMarkdownHtml` is exported and the suite has
// a DOM shim, so what it produces can be looked at instead.

const VIDEO = 'dQw4w9WgXcQ'; // 11 chars, which is what getYoutubeId requires

function render(html: string) {
	return parseHtml(processMarkdownHtml(html, '/doc.md', new Set()));
}

test('a YouTube link on its own becomes a thumbnail anchor, not a frame', () => {
	const root = render(`<p><a href="https://www.youtube.com/watch?v=${VIDEO}">watch this</a></p>`);

	const link = root.querySelector('a.youtube-link') as unknown as ShimElement | null;
	assert.ok(link, 'the anchor is rewritten rather than left alone');
	assert.equal(link.getAttribute('href'), `https://www.youtube.com/watch?v=${VIDEO}`, 'it still points at YouTube');
	assert.ok(link.getAttribute('aria-label'), 'and it says where it goes, since the text is now an image');

	const thumbnail = link.querySelector('img') as unknown as ShimElement | null;
	assert.ok(thumbnail, 'the visible content is the poster frame');
	assert.equal(thumbnail.getAttribute('src'), `https://i.ytimg.com/vi/${VIDEO}/hqdefault.jpg`);

	assert.equal(root.querySelectorAll('iframe').length, 0, 'nothing is framed');
});

test('every recognised YouTube spelling gets the same treatment', () => {
	// `youtube.com/embed/` in particular: it is the URL people paste FROM an
	// embed snippet, and the one most likely to be handled by the old frame
	// path if the detection list ever splits in two.
	for (const href of [
		`https://www.youtube.com/watch?v=${VIDEO}`,
		`https://www.youtube.com/embed/${VIDEO}`,
		`https://www.youtube.com/v/${VIDEO}`,
		`https://youtu.be/${VIDEO}`,
	]) {
		const root = render(`<p><a href="${href}">link</a></p>`);
		const link = root.querySelector('a.youtube-link') as unknown as ShimElement | null;
		assert.ok(link, `${href} is recognised`);
		assert.equal(
			(link.querySelector('img') as unknown as ShimElement).getAttribute('src'),
			`https://i.ytimg.com/vi/${VIDEO}/hqdefault.jpg`,
		);
	}
});

test('a YouTube image embed becomes the same anchor', () => {
	// `![](https://youtu.be/…)` renders as an <img> whose src is a video page.
	// Left alone it is a broken image.
	const root = render(`<p><img src="https://youtu.be/${VIDEO}" alt="video"></p>`);

	const link = root.querySelector('a.youtube-link') as unknown as ShimElement | null;
	assert.ok(link, 'the image is replaced by the anchor');
	assert.equal(link.getAttribute('href'), `https://youtu.be/${VIDEO}`);
});

test('a YouTube link with words around it is left as a link', () => {
	// Only a paragraph that is nothing but the link becomes a poster. Swapping
	// a link inside a sentence for a 480px thumbnail would rewrite the prose.
	const root = render(`<p>see <a href="https://youtu.be/${VIDEO}">this</a> for context</p>`);

	assert.equal(root.querySelectorAll('a.youtube-link').length, 0);
	const link = root.querySelector('a') as unknown as ShimElement | null;
	assert.ok(link);
	assert.equal(link.textContent, 'this', 'the link keeps its own text');
});

test('a URL that only looks like YouTube is not rewritten', () => {
	// getYoutubeId requires an 11-character id; anything else stays a link
	// rather than becoming an anchor around a thumbnail that 404s.
	const root = render('<p><a href="https://youtu.be/short">link</a></p>');

	assert.equal(root.querySelectorAll('a.youtube-link').length, 0);
	assert.equal(root.querySelectorAll('img').length, 0);
});

// --- the halves that are not this module's output ---

test('the app no longer permits YouTube frames', () => {
	// A contract with the packaged app rather than with a function: the CSP
	// lives in tauri.conf.json, nothing type-checks it, and a `frame-src` that
	// outlived the iframe is permission granted for no feature.
	assert.doesNotMatch(tauriConfig, /frame-src/);
});

test('linked YouTube thumbnails are not intercepted by image zoom', () => {
	// Source-shape on purpose: the handler is in a Svelte component this
	// runner cannot import. The claim is an ordering between two branches —
	// the anchor must claim the click first, or clicking the poster opens the
	// zoom overlay instead of the browser — so it is asserted as an ordering
	// rather than by matching the body's shape.
	const linkHandler = sliceBetween(
		markdownViewer,
		'async function handleLinkClick(e: MouseEvent)',
		'\n\tasync function toggleTaskCheckbox',
	);
	const anchorGuard = offsetOf(linkHandler, "const a = target.closest('a');");
	const imageZoom = offsetOf(linkHandler, "const img = target.closest('img');");

	assert.ok(anchorGuard < imageZoom, 'the anchor branch claims the click before image zoom sees it');
	assert.match(linkHandler, /if \(a\) \{[\s\S]*?\n\t\t\treturn;\n\t\t\}/, 'and the anchor branch returns rather than falling through');
});
