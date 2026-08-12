import { describe, expect, test } from 'vitest';

import { renderRichContent, type RichContentLibraries } from '../src/lib/utils/richContent.js';

/**
 * `renderRichContent` is run twice over the same nodes, and has to survive it.
 *
 * The reuse branches in the code-block pass — the `.code-block-shell` it adopts
 * instead of nesting, the `.lang-label`s it removes before adding one — look
 * like export-only defensiveness, on the theory that the preview always hands
 * this function freshly parsed markup. It does not. Three preview paths call it
 * with no `roots` at all, which means the whole live article, every node of it
 * already enriched by the render before:
 *
 *   - a theme change (`MarkdownViewer.svelte`), because Mermaid bakes its
 *     colours into the SVG and the diagrams have to be drawn again;
 *   - `syncPreviewForPrint`, before a PDF export;
 *   - re-activating a tab (`documentSession.svelte.ts`).
 *
 * #632 made this sharper rather than moot. The preview used to throw its
 * article away on every keystroke, so an enriched node's life was one render
 * long; now the patch keeps nodes across renders and the passes above meet
 * markup that has been through here an unbounded number of times. Without the
 * reuse, each pass wraps the last pass's shell in another shell and adds
 * another copy button — a `.code-block-shell` per theme toggle, for the life of
 * the document.
 *
 * The libraries are stood in for at the same boundary `exportRichContent`
 * uses: what is under test is Markpad's own bookkeeping around them.
 */
function libraries(): RichContentLibraries {
	return {
		hljs: {
			getLanguage: (name: string) => (name === 'js' ? {} : undefined),
			highlight: (code: string) => ({ value: `<span class="hl">${code}</span>` }),
		},
		katex: { renderToString: (source: string) => `<span class="katex">${source}</span>` },
		renderMathInElement: () => {},
		mermaid: { initialize: () => {}, render: async () => ({ svg: '<svg></svg>' }) },
	};
}

function root(html: string): HTMLElement {
	const element = document.createElement('div');
	element.innerHTML = html;
	document.body.replaceChildren(element);
	return element;
}

async function render(target: HTMLElement) {
	await renderRichContent({ roots: [target], libraries: libraries(), mermaidTheme: 'default' });
}

describe('a second pass over already enriched nodes', () => {
	test('adopts the shell it built last time instead of nesting another one', async () => {
		const article = root('<pre><code class="language-js">const answer = 42;</code></pre>');

		await render(article);
		const shell = article.querySelector('.code-block-shell');
		const pre = article.querySelector('pre');
		expect(shell).not.toBeNull();

		await render(article);
		await render(article);

		expect(article.querySelectorAll('.code-block-shell').length).toBe(1);
		expect(article.querySelector('.code-block-shell')).toBe(shell);
		expect(shell!.parentElement).toBe(article);
		expect(pre!.parentElement).toBe(shell);
	});

	test('leaves one copy button, not one per pass', async () => {
		const article = root('<pre><code class="language-js">const answer = 42;</code></pre>');

		await render(article);
		await render(article);
		await render(article);

		expect(article.querySelectorAll('.lang-label').length).toBe(1);
		expect(article.querySelector('.lang-label')!.textContent).toBe('js');
	});

	test('holds for a fenced block with no language, which gets the icon instead', async () => {
		const article = root('<pre><code>plain text</code></pre>');

		await render(article);
		await render(article);

		expect(article.querySelectorAll('.code-block-shell').length).toBe(1);
		expect(article.querySelectorAll('.lang-label').length).toBe(1);
	});
});
