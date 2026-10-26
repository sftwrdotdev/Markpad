import assert from 'node:assert/strict';
import { describe, test } from 'vitest';

import { buildExportDocument } from '../src/lib/utils/export.ts';
import { plainAppearance } from './exportFixtures.ts';
import { readSource } from './sourceTree.js';

const appStyles = readSource('src/styles.css');

/**
 * The computed style of the page's article as `html` would come out on `media`.
 *
 * jsdom applies only screen rules, so each `@media` block that names `media`
 * (or `all`) is replaced in place by its own rules and every other `@media`
 * block is dropped. jsdom also leaves `var()` unresolved (a padding of
 * `var(--x)` computes to 0), so each one is replaced by the root's value for it.
 * Every call gets its own frame: one reused document keeps computed styles from
 * the previous page.
 */
function article(html: string, media: 'print' | 'screen'): { display: string; paddingTop: string; paddingLeft: string } {
	const frame = globalThis.document.createElement('iframe');
	globalThis.document.body.append(frame);
	// A frame's window carries the same constructors the global one does.
	const window = frame.contentWindow as Window & typeof globalThis;
	const { document } = window;
	document.open();
	document.write(html);
	document.close();
	for (const sheet of Array.from(document.styleSheets)) {
		for (let index = sheet.cssRules.length - 1; index >= 0; index -= 1) {
			const rule = sheet.cssRules[index];
			if (!(rule instanceof window.CSSMediaRule)) continue;
			const applies = /\ball\b/.test(rule.media.mediaText) || rule.media.mediaText.includes(media);
			const inner = applies ? Array.from(rule.cssRules, (r) => r.cssText) : [];
			sheet.deleteRule(index);
			inner.forEach((text, offset) => sheet.insertRule(text, index + offset));
		}
	}
	const root = window.getComputedStyle(document.documentElement);
	for (const sheet of Array.from(document.styleSheets)) {
		for (const rule of Array.from(sheet.cssRules)) {
			if (!(rule instanceof window.CSSStyleRule)) continue;
			for (const name of Array.from(rule.style)) {
				const value = rule.style.getPropertyValue(name);
				if (!value.includes('var(')) continue;
				const replaced = value.replace(/var\(\s*(--[\w-]+)\s*(?:,\s*([^)]*))?\)/g, (_: string, variable: string, fallback?: string) =>
					root.getPropertyValue(variable).trim() || (fallback ?? '').trim(),
				);
				rule.style.setProperty(name, replaced, rule.style.getPropertyPriority(name));
			}
		}
	}
	const element = document.querySelector('article.markdown-body');
	assert.ok(element, 'the page has no article');
	const { display, paddingTop, paddingLeft } = window.getComputedStyle(element);
	frame.remove();
	return { display, paddingTop, paddingLeft };
}

const exported = buildExportDocument({
	theme: 'light',
	title: 'Notes',
	styles: appStyles,
	articleHtml: '<p>body</p>',
	contentWidth: null,
	appearance: plainAppearance,
});

// What the app's own PDF route prints: #print-root inside #app.
const pdfPage = `<!DOCTYPE html><html><head><style>${appStyles}</style></head><body><div id="app"><div id="print-root"><article class="markdown-body"></article></div></div></body></html>`;

describe('printing an exported HTML file', () => {
	test('prints the article instead of a blank page', () => {
		// The copied print sheet hides everything outside #app, which an exported
		// file does not have, so the article itself was hidden on paper.
		assert.notEqual(article(exported, 'print').display, 'none');
	});

	test('gets the same paper margins as the app’s own PDF', () => {
		// The export used to keep its 40px screen padding on paper.
		const pdf = article(pdfPage, 'print');
		assert.ok(parseFloat(pdf.paddingTop) > 0, `the PDF has no page margin: ${pdf.paddingTop}`);
		const printed = article(exported, 'print');
		assert.equal(printed.paddingTop, pdf.paddingTop);
		assert.equal(printed.paddingLeft, pdf.paddingLeft);
	});

	test('looks the same on screen as on paper', () => {
		// One page margin for both, so the file does not change shape when printed.
		const screen = article(exported, 'screen');
		const paper = article(exported, 'print');
		assert.ok(parseFloat(screen.paddingTop) > 0, `no margin on screen: ${screen.paddingTop}`);
		assert.equal(screen.paddingTop, paper.paddingTop);
		assert.equal(screen.paddingLeft, paper.paddingLeft);
	});
});
