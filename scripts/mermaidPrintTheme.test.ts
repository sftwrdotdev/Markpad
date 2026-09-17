import assert from 'node:assert/strict';
import test from 'node:test';

import { readSource, sliceBetween } from './sourceTree.js';

import {
	readDiagramSource,
	rememberDiagramSource,
	resolveMermaidTheme,
} from '../src/lib/utils/mermaidPrint.js';

/** Minimal stand-in for the container the source is remembered on. */
class FakeElement {
	attributes = new Map<string, string>();
	innerHTML = '';
	constructor(public className = '') {}
	setAttribute(name: string, value: string) {
		this.attributes.set(name, value);
	}
	getAttribute(name: string) {
		return this.attributes.has(name) ? this.attributes.get(name)! : null;
	}
}

/** The fake seen as the `Element` the helpers' signatures ask for. */
const asElement = (element: FakeElement) => element as unknown as Element;

function diagram(source: string | null, html: string) {
	const element = new FakeElement('mermaid-diagram');
	if (source !== null) rememberDiagramSource(asElement(element), source, 'dark');
	element.innerHTML = html;
	return element;
}

test('the diagram theme follows the app appearance', () => {
	assert.equal(resolveMermaidTheme({ theme: 'dark', systemPrefersDark: false }), 'dark');
	assert.equal(resolveMermaidTheme({ theme: 'light', systemPrefersDark: true }), 'neutral');
	assert.equal(resolveMermaidTheme({ theme: 'system', systemPrefersDark: true }), 'dark');
	assert.equal(resolveMermaidTheme({ theme: 'system', systemPrefersDark: false }), 'neutral');
	// A VS Code theme reports its polarity through the dataset instead.
	assert.equal(
		resolveMermaidTheme({ theme: 'vscode:whatever', datasetThemeType: 'dark', systemPrefersDark: false }),
		'dark',
	);
});

test('the source is kept on the container so the diagram can be rebuilt', () => {
	const element = diagram('flowchart TD\n A --> B', '<svg>screen</svg>');
	assert.equal(readDiagramSource(asElement(element)), 'flowchart TD\n A --> B');
	// A diagram rendered before the source was remembered reads as null rather
	// than as an empty source.
	assert.equal(readDiagramSource(asElement(diagram(null, '<svg/>'))), null);
});

test('the PDF export draws the document with the print theme', () => {
	// Paper is white whatever the screen is wearing, and Mermaid bakes the
	// theme into the SVG it emits, so the article the print route builds is
	// rendered with the print theme rather than the app's current one.
	const exporter = readSource('src/lib/utils/export.ts');
	const pdf = sliceBetween(exporter, 'export async function exportAsPdf', '\nasync function waitForImages');
	assert.match(pdf, /mermaidTheme: MERMAID_PRINT_THEME/);
	assert.match(exporter, /import \{ MERMAID_PRINT_THEME \} from '\.\/mermaidPrint\.js';/);
	// And the HTML export keeps carrying the author's appearance instead.
	const html = sliceBetween(exporter, 'export async function exportAsHtml', 'export async function exportAsPdf');
	assert.doesNotMatch(html, /MERMAID_PRINT_THEME/);
});
