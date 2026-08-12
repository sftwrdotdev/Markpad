/**
 * What the shared sanitizer actually does to an author stylesheet — run, not
 * described.
 *
 * `previewSanitize.test.ts` pins the WIRING: that the preview reaches the
 * shared policy, that the policy forbids `<style>`, that no second DOMPurify
 * call site assembles a config of its own. None of that runs DOMPurify, because
 * DOMPurify needs a real DOM and `node --test` has none. The behavioural half
 * therefore used to be a table of numbers measured by hand in a browser and
 * pasted into a comment — true when it was written and unfalsifiable ever
 * after.
 *
 * jsdom has a real DOM and a real cascade, so it is a test now. The payload is
 * the one that comment recorded, verbatim:
 *
 *     <style>.titlebar{display:none} body{background-image:url("…/beacon")}</style>
 *
 * and the observable is the same one: the preview injects `tab.content` into
 * the APPLICATION'S OWN document, so a stylesheet that survives the filter is
 * not scoped to the article — it restyles Markpad. `.titlebar` is a real
 * element of the app's chrome, and `getComputedStyle` is what answers whether
 * the document author moved it.
 *
 * The `background-image` half is the beacon: in a browser the computed value
 * being a URL is followed by a request for it (the comment recorded the entry
 * in `performance.getEntriesByType('resource')`, and the shipped CSP allows it
 * — `img-src … https:`). jsdom does not fetch it. The computed value is the
 * part that is a property of the sanitizer rather than of the network stack,
 * and it is the part asserted here.
 *
 * WHY THE "BEFORE" ROW IS ASSERTED TOO: without it "the `<style>` is gone"
 * proves nothing about the policy — an unrelated change that dropped every
 * `<style>` on any config would keep it green. The old config is DOMPurify's
 * default plus the URI pattern the viewer had hand-copied, which is exactly the
 * shape the regression had, and under it the payload still works. That is the
 * difference the policy makes.
 */

import assert from 'node:assert/strict';

import DOMPurify from 'dompurify';
import { afterEach, test } from 'vitest';

import { sanitizeMarkdownHtml, ALLOWED_MARKDOWN_URI_REGEXP } from '../src/lib/utils/sanitize.js';

/** The document author's payload, as it arrives from comrak (`render.unsafe_ = true`). */
const POC_STYLE = '<style>.titlebar{display:none} body{background-image:url("https://attacker.example/beacon")}</style>';

/**
 * A rendered document carrying it.
 *
 * The leading paragraph is not decoration. DOMPurify serializes its parse
 * tree's `<body>`, and the HTML parser puts a `<style>` that opens a fragment
 * into `<head>` instead — so a payload-only string comes back empty on ANY
 * config, and the two rows below would agree for a reason that has nothing to
 * do with the policy. Every real rendered document has prose before the raw
 * HTML in it.
 */
const RENDERED = `<p>An ordinary paragraph of prose.</p>\n${POC_STYLE}`;

/** The config the viewer used to build at its own call site: the URI pattern, and nothing else. */
const VIEWER_LOCAL_CONFIG = { ALLOWED_URI_REGEXP: ALLOWED_MARKDOWN_URI_REGEXP };

/**
 * The app's own document, with the chrome the payload aims at.
 *
 * No inline `style` on the titlebar: an inline declaration outranks a class
 * selector, which would make the "before" row look safe for the wrong reason.
 * The app's own rule is a stylesheet rule, so the test's is too.
 */
function mountApp(): { titlebar: Element; preview: HTMLElement } {
	document.head.innerHTML = '<style>.titlebar{display:flex} body{background-image:none}</style>';
	document.body.innerHTML = '<div class="titlebar"></div><div class="markdown-body"></div>';
	return {
		titlebar: document.querySelector('.titlebar')!,
		preview: document.querySelector<HTMLElement>('.markdown-body')!,
	};
}

afterEach(() => {
	document.head.innerHTML = '';
	document.body.innerHTML = '';
});

test('the config the preview used to build lets a document restyle the application', () => {
	const { titlebar, preview } = mountApp();
	assert.equal(getComputedStyle(titlebar).display, 'flex', 'precondition: the app decides where its chrome is');

	const sanitized = DOMPurify.sanitize(RENDERED, VIEWER_LOCAL_CONFIG);
	assert.match(sanitized, /<style>/, 'the old config keeps the author stylesheet — that is the regression');

	preview.innerHTML = sanitized;

	assert.equal(getComputedStyle(titlebar).display, 'none', "the document hid the app's title bar");
	assert.equal(
		getComputedStyle(document.body).backgroundImage,
		'url("https://attacker.example/beacon")',
		'and pointed the app at an outbound URL',
	);
});

test('the shared policy drops the stylesheet and leaves the application alone', () => {
	const { titlebar, preview } = mountApp();

	const sanitized = sanitizeMarkdownHtml(RENDERED);
	assert.doesNotMatch(sanitized, /<style/i, 'the shared policy forbids the tag');
	assert.match(sanitized, /<p>An ordinary paragraph of prose\.<\/p>/, 'and keeps the document itself');

	preview.innerHTML = sanitized;

	assert.equal(getComputedStyle(titlebar).display, 'flex');
	assert.equal(getComputedStyle(document.body).backgroundImage, 'none');
});

test('the inline style attribute is still allowed, because documents use it', () => {
	// The other half of the policy decision, and the reason it is `FORBID_TAGS`
	// rather than "strip everything that styles": an inline declaration is scoped
	// to the one element the author wrote it on, so `<img style="width:50%">`
	// keeps working. Run rather than read: `FORBID_ATTR: ['style']` would pass
	// every assertion in the test above and silently break existing files.
	const { preview } = mountApp();

	preview.innerHTML = sanitizeMarkdownHtml('<p style="text-align:center">centred</p>');

	const paragraph = preview.querySelector('p')!;
	assert.equal(getComputedStyle(paragraph).textAlign, 'center');
});
