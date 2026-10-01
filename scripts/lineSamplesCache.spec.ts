import { expect, test, vi } from 'vitest';

import { toggleFold } from '../src/lib/utils/foldState.js';
import { getSourceLineAtPreviewOffset, type AnchorNode } from '../src/lib/utils/previewAnchor.js';
import { renderRichContent, type RichContentLibraries } from '../src/lib/utils/richContent.js';
import { readSource } from './sourceTree.js';

/**
 * Scroll sync's sample table is built once per root and reused by every
 * scroll event until something changes which elements it should hold: a
 * patch, a fold, a host switch, a diagram replacing its `<pre>`. Boxes are
 * still measured on every call, so only the walk is saved.
 */
function preview() {
	const root = document.createElement('div');
	root.innerHTML =
		'<h2 class="foldable-header" data-fold-key="a" data-sourcepos="1:1-1:4">A</h2>' +
		'<div class="foldable-content-wrapper"><p data-sourcepos="3:1-3:1">x</p><p data-sourcepos="10:1-10:1">y</p></div>' +
		'<pre data-sourcepos="20:1-22:3"><code class="language-mermaid">graph TD; A--&gt;B;</code></pre>';
	document.body.replaceChildren(root);
	const tops = new Map<Element, number>();
	const at = (selector: string, top: number) => tops.set(root.querySelector(selector)!, top);
	at('h2', 0);
	at('.foldable-content-wrapper', 20);
	at('[data-sourcepos="3:1-3:1"]', 20);
	at('[data-sourcepos="10:1-10:1"]', 100);
	at('pre', 200);
	const measure = (node: AnchorNode) => {
		const element = node as unknown as Element;
		// A detached node has no box; the diagram stands where its `<pre>` was.
		const top = element.isConnected ? (tops.get(element) ?? 200) : NaN;
		return { top, height: 0 };
	};
	return { root, measure, lineAt: (offset: number) => getSourceLineAtPreviewOffset(root, offset, measure) };
}

test('the table is walked once, and rebuilt after a fold and after a diagram replaces its <pre>', async () => {
	const { root, lineAt } = preview();
	expect(lineAt(100)).toBe(10);

	const walk = vi.spyOn(Node.prototype, 'childNodes', 'get');
	expect(lineAt(150)).toBe(15);
	expect(walk).not.toHaveBeenCalled();
	walk.mockRestore();

	// Shut, the fold owns lines 3-10 at its own top, so offset 100 now falls
	// between the fold's last line and the diagram.
	toggleFold({ root, folds: new Set(), setFolds() {} }, 'a');
	expect(lineAt(100)).toBe(10 + ((100 - 20) / (200 - 20)) * 10);

	const libraries: RichContentLibraries = {
		hljs: null,
		katex: null,
		renderMathInElement: null,
		mermaid: { initialize() {}, render: async () => ({ svg: '<svg></svg>' }) },
	};
	await renderRichContent({ roots: [root], libraries, mermaidTheme: 'default' });
	expect(root.querySelector('pre')).toBeNull();
	expect(lineAt(250)).toBe(20);
});

test('a tab switch that skips the patch still drops the table', () => {
	// The hosts' `display` is what changed, and `isAnchorable` reads it.
	const viewer = readSource('src/lib/MarkdownViewer.svelte');
	expect(viewer).toMatch(/if \(unchanged\) invalidateAnchorMemos\(\);/);
});
