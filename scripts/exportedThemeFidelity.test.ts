import assert from 'node:assert/strict';
import test from 'node:test';

import { buildExportDocument, exportThemeAttribute } from '../src/lib/utils/export.js';
import { DEFAULT_PREVIEW_MAX_WIDTH } from '../src/lib/utils/previewWidth.js';
import { readSource, sliceBetween } from './sourceTree.js';

const styles = readSource('src/styles.css');
const exportSource = readSource('src/lib/utils/export.ts');

/** The opening `<html …>` tag of a built export. */
function htmlTag(document: string): string {
	const match = document.match(/<html[^>]*>/);
	assert.ok(match, 'the export must contain an <html> tag');
	return match[0];
}

/** Does `<html …>` satisfy a `[data-theme="…"]` attribute selector? */
function matchesThemeSelector(document: string, theme: string): boolean {
	return new RegExp(`<html[^>]*\\sdata-theme="${theme}"`).test(htmlTag(document));
}

function build(theme: string | null | undefined, extra: Partial<{ styles: string; title: string; articleHtml: string }> = {}) {
	return buildExportDocument({
		theme,
		title: extra.title ?? 'Notes',
		styles: extra.styles ?? '',
		articleHtml: extra.articleHtml ?? '<p>body</p>',
		contentWidth: DEFAULT_PREVIEW_MAX_WIDTH,
	});
}

test('an explicitly themed window exports a document wearing that theme', () => {
	// Every dark variable in the app hangs off `:root[data-theme="dark"]`. The
	// rule is copied into the export with the rest of the stylesheet, so
	// without the attribute the copied rule is dead weight and the file falls
	// back to the light `:root` block (or, on a dark machine, to the
	// `prefers-color-scheme` block) — never to what the exporter was looking at.
	for (const theme of ['dark', 'light']) {
		assert.ok(matchesThemeSelector(build(theme), theme), `an export from the ${theme} theme must carry data-theme="${theme}"`);
	}
});

test('an imported VS Code theme survives the export', () => {
	// `parseAndApplyVscodeTheme` writes `:root[data-theme="vscode"] { … }` into a
	// <style> tag, which `document.styleSheets` hands to the export like any
	// other sheet. The attribute is the only thing that can make it match.
	const doc = build('vscode', { styles: ':root[data-theme="vscode"] { --color-canvas-default: #1e1e1e; }' });
	assert.ok(matchesThemeSelector(doc, 'vscode'));
	assert.match(doc, /:root\[data-theme="vscode"\]/);
});

test('every theme selector the stylesheet defines can be reproduced by an export', () => {
	// Pins the two halves together: a new `:root[data-theme="…"]` block in
	// styles.css must be a value the export is willing to write out, or that
	// theme silently becomes unexportable.
	const declared = [...styles.matchAll(/:root\[data-theme="([^"]+)"\]/g)].map((m) => m[1]);
	assert.ok(declared.length >= 2, 'expected styles.css to select themes by data-theme');

	for (const theme of new Set(declared)) {
		assert.equal(exportThemeAttribute(theme), ` data-theme="${theme}"`, `${theme} must survive an export`);
		assert.ok(matchesThemeSelector(build(theme), theme));
	}
});

test('the system theme is exported as "follow the reader", not as a frozen colour', () => {
	// `system` is the one theme that is not a colour: MarkdownViewer deletes
	// `data-theme` for it and lets `@media (prefers-color-scheme: dark)` decide.
	// An export with no attribute reproduces that same cascade wherever it is
	// opened, which is the instruction the user actually gave. Baking in the
	// exporter's momentary system colour would make the file disagree with the
	// author's own screen the next time their machine switches.
	for (const absent of [undefined, null, '']) {
		const doc = build(absent);
		assert.doesNotMatch(htmlTag(doc), /data-theme/, `system theme must not pin a colour (${String(absent)})`);
		assert.match(htmlTag(doc), /^<html lang="en">$/);
	}

	// And the mechanism it delegates to has to still be in the sheet that gets copied.
	assert.match(styles, /@media \(prefers-color-scheme: dark\)/);
});

test('the theme attribute cannot break out of the tag', () => {
	// `data-theme` is a string read back off the DOM and interpolated into
	// markup. Nothing writes a hostile one today; the export must not be the
	// place that finds out when something does.
	const hostile = ['x" onload="alert(1)', '"><script>alert(1)</script>', "dark'", 'dark theme', 'a'.repeat(33), '../../etc'];
	for (const theme of hostile) {
		assert.equal(exportThemeAttribute(theme), '', `${theme} must not reach the markup`);
		assert.match(htmlTag(build(theme)), /^<html lang="en">$/);
	}
	assert.equal(exportThemeAttribute(42 as unknown as string), '');
});

test('the export reads the theme off the same element the app themes', () => {
	assert.match(exportSource, /theme: document\.documentElement\.dataset\.theme/);
});

test('theming the document did not cost it any of its other protections', () => {
	// #376 put a CSP and a title escape in this template; extracting the
	// template must carry both across unchanged.
	const doc = build('dark', { title: '<script>alert(1)</script>' });
	assert.match(doc, /<meta http-equiv="Content-Security-Policy" content="default-src 'none'; /);
	assert.doesNotMatch(doc, /script-src/);
	assert.match(doc, /<title>&lt;script&gt;alert\(1\)&lt;\/script&gt;<\/title>/);
	assert.doesNotMatch(doc, /<title><script>/);
	assert.match(build('dark', { title: '' }), /<title>Export<\/title>/);
});

test('the copied stylesheet and the article still land in the document', () => {
	const doc = build('dark', { styles: '.sentinel { color: red; }', articleHtml: '<p id="sentinel">hello</p>' });
	assert.match(doc, /<style>[\s\S]*\.sentinel \{ color: red; \}/);
	assert.match(doc, /<article class="markdown-body">\n<p id="sentinel">hello<\/p>/);
	assert.match(doc, /^<!DOCTYPE html>\n/);
});

test('a ticked task dims its content once, not once per nesting level', () => {
	// `opacity` composites rather than inherits, so a rule matching every
	// descendant multiplies itself down the tree. This rule ended in
	// `:checked *`, which words survive at one or two levels deep and KaTeX does
	// not: it nests twelve spans, so a formula in a ticked item rendered at
	// 0.65^12 = 0.006 and disappeared while the text beside it merely faded.
	// samples/katex-stress.md holds a ticked and an unticked task item next to
	// each other so the difference is visible rather than arguable.
	//
	// Asserted as "no universal descendant selector carries opacity here", not
	// as a literal selector list, because the defect is the shape and not the
	// spelling.
	const styles = readSource('src/styles.css');
	const block = sliceBetween(styles, 'input[data-task-checkbox]:checked) .task-text', '/* restore');
	assert.doesNotMatch(
		block,
		/:checked\)\s*\*[\s,]/,
		'a ticked task item applies opacity to every descendant; deep markup compounds it away',
	);
	assert.match(block, /opacity:\s*0?\.\d+/, 'the ticked-item rule stopped dimming anything at all');
});
