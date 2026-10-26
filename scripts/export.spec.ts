import assert from 'node:assert/strict';
import { describe, test } from 'vitest';

import { buildExportDocument } from '../src/lib/utils/export.ts';
import { plainAppearance } from './exportFixtures.ts';
import { readSource } from './sourceTree.js';

const appStyles = readSource('src/styles.css');

/**
 * Loads `html` into the jsdom document as it would come out on `media`. jsdom
 * applies no media type itself, so each `@media` block that names `media` (or
 * `all`) is replaced in place by its own rules, and every other `@media` block
 * is dropped.
 */
function render(html: string, media: 'print' | 'screen'): Document {
	document.documentElement.innerHTML = html.replace(/^<!DOCTYPE html>\s*<html[^>]*>/, '').replace(/<\/html>\s*$/, '');
	for (const sheet of Array.from(document.styleSheets)) {
		for (let index = sheet.cssRules.length - 1; index >= 0; index -= 1) {
			const rule = sheet.cssRules[index];
			if (!(rule instanceof CSSMediaRule)) continue;
			const applies = /\ball\b/.test(rule.media.mediaText) || rule.media.mediaText.includes(media);
			const inner = applies ? Array.from(rule.cssRules, (r) => r.cssText) : [];
			sheet.deleteRule(index);
			inner.forEach((text, offset) => sheet.insertRule(text, index + offset));
		}
	}
	return document;
}

function article(doc: Document): CSSStyleDeclaration {
	const element = doc.querySelector('article.markdown-body');
	assert.ok(element, 'the page has no article');
	return getComputedStyle(element);
}

const exported = buildExportDocument({
	theme: 'light',
	title: 'Notes',
	styles: appStyles,
	articleHtml: '<p>body</p>',
	contentWidth: null,
	appearance: plainAppearance,
});

describe('printing an exported HTML file', () => {
	test('prints the article instead of a blank page', () => {
		// The copied print sheet hides everything outside #app, which an exported
		// file does not have, so the article itself was hidden on paper.
		assert.notEqual(article(render(exported, 'print')).display, 'none');
	});

	test('gets the same paper margins as the app’s own PDF', () => {
		// The PDF route prints #print-root inside #app; the export used to keep its
		// screen padding on paper instead.
		const pdf = render(
			`<head><style>${appStyles}</style></head><body><div id="app"><div id="print-root"><article class="markdown-body"></article></div></div></body>`,
			'print',
		);
		const paper = article(pdf).paddingTop;
		assert.equal(article(render(exported, 'print')).paddingTop, paper);
		assert.equal(article(render(exported, 'print')).paddingLeft, paper);
	});

	test('keeps its 40px padding on screen', () => {
		assert.equal(article(render(exported, 'screen')).paddingTop, '40px');
	});
});
