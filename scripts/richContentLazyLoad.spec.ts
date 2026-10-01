import { expect, test, vi } from 'vitest';

/**
 * `renderRichContent` imports a library only when the document holds something
 * it renders: a plain document loads none, code loads highlight.js's `common`
 * build plus the grammars it names, and only math or a diagram reaches for
 * KaTeX or Mermaid. KaTeX and Mermaid are stood in for so the test can see
 * whether they were imported at all; highlight.js is the real one, because the
 * on-demand grammars are what is under test.
 */
const imported = vi.hoisted(() => new Set<string>());

vi.mock('katex', () => {
	imported.add('katex');
	return { default: { renderToString: (source: string) => `<span class="katex">${source}</span>` } };
});
vi.mock('katex/contrib/auto-render', () => ({ default: () => {} }));
vi.mock('katex/contrib/mhchem', () => ({}));
vi.mock('mermaid', () => {
	imported.add('mermaid');
	return { default: { initialize: () => {}, render: async () => ({ svg: '<svg></svg>' }) } };
});

const { renderRichContent } = await import('../src/lib/utils/richContent.js');

function article(html: string): HTMLElement {
	const element = document.createElement('div');
	element.innerHTML = html;
	return element;
}

test('code loads highlight.js, any grammar it names, and neither KaTeX nor Mermaid', async () => {
	const plain = article('<p>Just words.</p>');
	await renderRichContent({ roots: [plain], mermaidTheme: 'default' });
	expect(plain.innerHTML).toBe('<p>Just words.</p>');

	const code = article(
		'<pre><code class="language-js">let a = 1;</code></pre>' +
			// Not in `common`: fetched by file name, and by an alias only the
			// grammar knows (`docker` is dockerfile's).
			'<pre><code class="language-dockerfile">FROM alpine</code></pre>' +
			'<pre><code class="language-docker">RUN true</code></pre>' +
			'<pre><code class="language-no-such-language">x</code></pre>',
	);
	await renderRichContent({ roots: [code], mermaidTheme: 'default' });
	const blocks = [...code.querySelectorAll('code')];
	expect(blocks.map((block) => block.classList.contains('hljs'))).toEqual([true, true, true, false]);
	expect(blocks[1].querySelector('.hljs-keyword')?.textContent).toBe('FROM');
	expect(blocks[2].querySelector('.hljs-keyword')?.textContent).toBe('RUN');
	expect([...imported]).toEqual([]);

	await renderRichContent({ roots: [article('<p data-math="display" data-math-source="x">x</p>')], mermaidTheme: 'default' });
	expect([...imported]).toEqual(['katex']);

	const diagram = article('<pre><code class="language-mermaid">graph TD; A--&gt;B;</code></pre>');
	await renderRichContent({ roots: [diagram], mermaidTheme: 'default' });
	expect([...imported]).toEqual(['katex', 'mermaid']);
	expect(diagram.querySelector('.mermaid-diagram')).not.toBeNull();
});
