import { expect, test, vi } from 'vitest';

// The Svelte grammar is one optional language: when it cannot load, every other
// language still has to be coloured (#1057). Its own file because `vi.mock`
// applies to the whole file and the other specs need the real grammar.
vi.mock('highlightjs-svelte/dist/index.mjs', () => {
	throw new ReferenceError('hljs is not defined');
});

const { renderRichContent } = await import('../src/lib/utils/richContent.js');

test('a Svelte grammar that fails to load leaves other languages highlighted', async () => {
	vi.spyOn(console, 'error').mockImplementation(() => {});
	const article = document.createElement('div');
	article.innerHTML = '<pre><code class="language-python">def greet(): pass</code></pre>';

	await renderRichContent({ roots: [article], mermaidTheme: 'default' });

	expect(article.querySelector('.hljs-keyword')?.textContent).toBe('def');
});
