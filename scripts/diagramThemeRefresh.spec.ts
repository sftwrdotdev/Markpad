/**
 * Switching theme has to re-draw the diagrams, and until this file existed it
 * did not — in any mode, for any theme.
 *
 * Mermaid bakes fills, strokes and label colours into the SVG as attributes, so
 * a stylesheet cannot retarget them; `mermaidPrint.ts` says why at length, and
 * re-rendering is the answer it already reaches for on the way to a PDF. The
 * preview's own theme change was supposed to do the same thing through
 * `renderRichContent`, and could not: that function finds diagrams by
 * `pre code`, and a diagram that has been drawn once has no `<pre>` any more —
 * it was replaced by the `.mermaid-diagram` container holding the SVG.
 *
 * That was invisible while the preview was `{@html sanitizedHtml}`, because
 * every render put the whole document back as source. `blockPatch.ts` (#632)
 * keeps enriched nodes across renders instead, and from then on a theme change
 * reached no diagram at all. The `<pre>` is gone, `patch.inserted` is empty on
 * a re-render of the same document, and typing does not help either: the
 * diagram's markup is unchanged, so the patch keeps the node.
 *
 * The libraries are stood in for at the same boundary `exportRichContent` and
 * `richContentIdempotence` use. What is under test is Markpad's bookkeeping:
 * which containers it decides are stale, and what it does to them.
 */

import { describe, expect, test } from 'vitest';

import { patchPreviewBlocks } from '../src/lib/utils/blockPatch.js';
import { readDiagramSource } from '../src/lib/utils/mermaidPrint.js';
import { renderRichContent, type RichContentLibraries } from '../src/lib/utils/richContent.js';
import { resetDiagramCache } from '../src/lib/utils/diagramCache.js';

const SOURCE = 'graph TD;A-->B;';

/** Records every draw so "did it re-render" is a count, not an inference. */
function libraries(draws: string[]): RichContentLibraries {
	let theme = 'unset';
	return {
		hljs: { getLanguage: () => undefined, highlight: () => ({ value: '' }) },
		katex: { renderToString: (source: string) => source },
		renderMathInElement: () => {},
		mermaid: {
			initialize: (config: { theme: string }) => {
				theme = config.theme;
			},
			render: async (id: string, source: string) => {
				draws.push(`${theme}:${source}`);
				return { svg: `<svg id="${id}" data-drawn-for="${theme}"></svg>` };
			},
		},
	} as any;
}

function article(html: string): HTMLElement {
	const element = document.createElement('div');
	element.innerHTML = html;
	document.body.replaceChildren(element);
	return element;
}

async function render(root: HTMLElement, mermaidTheme: string, draws: string[], seed = 0) {
	await renderRichContent({
		roots: [root],
		libraries: libraries(draws),
		mermaidTheme,
		idFactory: (index) => `d${seed}-${index}`,
	});
}

function drawnFor(root: ParentNode): string | null {
	return root.querySelector('.mermaid-diagram svg')?.getAttribute('data-drawn-for') ?? null;
}

const PRE = `<pre data-sourcepos="1:1-3:3"><code class="language-mermaid">${SOURCE}</code></pre>`;

describe('a theme change', () => {
	test('re-draws a diagram that is already on screen', async () => {
		resetDiagramCache();
		const draws: string[] = [];
		const root = article(PRE);

		await render(root, 'dark', draws);
		expect(drawnFor(root)).toBe('dark');

		// The whole-article pass a theme change makes. There is no `<pre>` left.
		expect(root.querySelectorAll('pre code').length).toBe(0);
		await render(root, 'neutral', draws, 1);

		expect(drawnFor(root)).toBe('neutral');
		expect(draws).toEqual([`dark:${SOURCE}`, `neutral:${SOURCE}`]);
	});

	test('leaves the source on the container, so the PDF path still works', async () => {
		resetDiagramCache();
		const root = article(PRE);
		await render(root, 'dark', []);
		await render(root, 'neutral', [], 1);

		expect(readDiagramSource(root.querySelector('.mermaid-diagram')!)).toBe(SOURCE);
	});
});

describe('a pass that is not a theme change', () => {
	test('does not re-draw a diagram already in the theme being asked for', async () => {
		resetDiagramCache();
		const draws: string[] = [];
		const root = article(PRE);

		await render(root, 'dark', draws);
		// `syncPreviewForPrint` and a re-activated tab both re-run this over the
		// whole host without the theme having moved.
		await render(root, 'dark', draws, 1);
		await render(root, 'dark', draws, 2);

		expect(draws).toEqual([`dark:${SOURCE}`]);
	});

	test('does not reach a diagram outside the roots it was given', async () => {
		resetDiagramCache();
		const draws: string[] = [];
		const host = article(`${PRE}<p data-sourcepos="5:1-5:5">text</p>`);
		await render(host, 'dark', draws);

		// The keystroke path: the patch replaces the paragraph and hands only
		// that block to the enrichment. The diagram is not in it, and a theme it
		// no longer matches must not drag it into the pass.
		const patch = patchPreviewBlocks(document.createElement('div'), '<p>x</p>');
		await renderRichContent({
			roots: patch.inserted,
			libraries: libraries(draws),
			mermaidTheme: 'neutral',
			idFactory: (index) => `k${index}`,
		});

		expect(draws).toEqual([`dark:${SOURCE}`]);
		expect(drawnFor(host)).toBe('dark');
	});
});

/**
 * The wiring, which the tests above cannot reach: `renderRichContent` now knows
 * how to re-draw a stale diagram, but the theme effect still has to call it, in
 * every mode and once per theme change.
 *
 * A source assertion, because the caller is a Svelte effect that cannot be
 * imported. It pins today's spelling of an internal call, so a rename breaks it
 * without breaking anything real; what it is here for is the guard, which was
 * `markdownBody && !isEditing`. That made the whole effect — the `dataset`
 * writes, `monaco.editor.setTheme`, and for a `vscode:` theme an
 * `invoke('read_vscode_theme')` and a re-parse — re-run on every mode toggle
 * and on every tab switch that changed the mode, with nothing about the theme
 * having moved. And it excluded from the re-colour every tab in edit mode,
 * including a split tab entered from edit mode, whose preview is on screen.
 */
test('the theme effect re-colours in every mode, and does not re-run on a mode change', async () => {
	const { readSource } = await import('./sourceTree.js');
	const viewer: string = readSource('src/lib/MarkdownViewer.svelte');

	const effect = viewer.match(
		/\t\$effect\(\(\) => \{\n\t\t\/\/ Persistence and cross-window sync[\s\S]*?\n\t\}\);/,
	)?.[0];
	expect(effect, 'the theme effect must still be recognisable').toBeTruthy();

	// The mode is not a reason to re-apply a theme, and this is the only read
	// that ever made it one.
	expect(effect).not.toMatch(/isEditing/);
	expect(effect).toMatch(
		/const recolourDiagrams = \(\) => untrack\(\(\) => \{ if \(markdownBody\) renderRichContent\(\); \}\);/,
	);

	// Once per branch: the `vscode:` branch does not know its own appearance
	// until `parseAndApplyVscodeTheme` has published `dataset.themeType`, which
	// is what `currentMermaidTheme` reads.
	expect(effect!.match(/recolourDiagrams\(\);/g)).toHaveLength(2);
	expect(effect).toMatch(/await parseAndApplyVscodeTheme[\s\S]*?recolourDiagrams\(\);/);
});
