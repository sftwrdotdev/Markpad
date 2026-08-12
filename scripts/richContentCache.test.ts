/**
 * The preview re-renders the whole article on every keystroke and `{@html}`
 * puts every formula and every code block back as source, so KaTeX and
 * highlight.js ran over the entire document for one typed character. Measured
 * in Chromium on `samples/katex-stress.md` (21 display formulas), the
 * `[data-math]` pass alone was ~17ms per keystroke; with the memo it is ~6ms
 * and calls KaTeX zero times.
 *
 * These tests pin what such a memo can get quietly wrong. It is the same list
 * `diagramCache.test.ts` works from — a memo that never misses is a
 * correctness bug and a memo that never evicts is a leak, and neither shows up
 * as anything on screen — minus the re-identification half, because neither
 * `katex.renderToString` nor `hljs.highlight` bakes an id into its output.
 *
 * What is *not* stood in for is the shape of the call: the fakes here answer to
 * `renderToString` / `highlight` + `getLanguage`, which is exactly the boundary
 * the renderer now uses, so a return to the element-mutating entry points
 * (`katex.render`, `hljs.highlightElement`) fails here rather than silently
 * costing a render per keystroke again.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { installShimDom } from './renderProtocolDom.ts';

installShimDom();
(globalThis as any).window = globalThis;

const DOMPurify = (await import('dompurify')).default as any;
DOMPurify.sanitize = (html: string) => html;

const { renderRichContent } = await import('../src/lib/utils/richContent.ts');
const { resetRichContentCache } = await import('../src/lib/utils/richContentCache.ts');

interface Recorder {
	math: string[];
	code: string[];
}

function newRecorder(): Recorder {
	return { math: [], code: [] };
}

const KNOWN_LANGUAGES = new Set(['js', 'rust', 'python']);

function libraries(record: Recorder, mathOutput = (source: string) => `<span>${source}</span>`) {
	return {
		hljs: {
			getLanguage: (name: string) => (KNOWN_LANGUAGES.has(name) ? { name } : null),
			highlight(code: string, options: { language: string }) {
				record.code.push(`${options.language}:${code}`);
				return { value: `<b>${options.language}</b>${code}`, language: options.language };
			},
		},
		katex: {
			renderToString(source: string, options: { displayMode: boolean }) {
				record.math.push(`${options.displayMode ? 'display' : 'inline'}:${source}`);
				return mathOutput(source);
			},
		},
		renderMathInElement() {},
		mermaid: { initialize() {}, async render() { return { svg: '' }; } },
	};
}

function mathBlock(source: string, mode: 'display' | 'inline' = 'display'): string {
	return `<p data-math="${mode}" data-math-source="${source}">${source}</p>`;
}

function codeBlock(language: string, code: string): string {
	return `<pre><code class="language-${language}">${code}</code></pre>`;
}

async function render(html: string, record: Recorder, mathOutput?: (source: string) => string) {
	const root = (globalThis as any).document.createElement('div');
	root.innerHTML = html;
	await renderRichContent({
		roots: [root],
		libraries: libraries(record, mathOutput) as any,
		mermaidTheme: 'neutral',
	});
	return root;
}

// ------------------------------------------------------------------- tests

test('a second pass over the same document renders nothing again', async () => {
	resetRichContentCache();
	const article = `${mathBlock('E = mc^2')}\n${codeBlock('js', 'const a = 1;')}`;

	const first = newRecorder();
	const before = await render(article, first);
	assert.deepEqual(first.math, ['display:E = mc^2']);
	assert.deepEqual(first.code, ['js:const a = 1;']);

	const second = newRecorder();
	const after = await render(article, second);
	assert.deepEqual(second.math, [], 'a repeat pass must not call KaTeX at all');
	assert.deepEqual(second.code, [], 'a repeat pass must not call highlight.js at all');
	// The same document, not merely the same call count.
	assert.equal(after.innerHTML, before.innerHTML);
});

test('typing in one formula re-renders that formula and nothing else', async () => {
	resetRichContentCache();
	const warm = newRecorder();
	await render(`${mathBlock('a + b')}\n${mathBlock('c + d')}`, warm);
	assert.equal(warm.math.length, 2);

	const typed = newRecorder();
	await render(`${mathBlock('a + bc')}\n${mathBlock('c + d')}`, typed);
	assert.deepEqual(typed.math, ['display:a + bc']);
});

test('the same source typeset both ways is two entries', async () => {
	resetRichContentCache();
	const record = newRecorder();
	await render(`${mathBlock('x^2', 'display')}\n${mathBlock('x^2', 'inline')}`, record);
	assert.deepEqual(record.math, ['display:x^2', 'inline:x^2']);
});

test('the same code under a different language is two entries', async () => {
	resetRichContentCache();
	const record = newRecorder();
	await render(`${codeBlock('js', 'let x = 1')}\n${codeBlock('rust', 'let x = 1')}`, record);
	assert.deepEqual(record.code, ['js:let x = 1', 'rust:let x = 1']);
});

test('a highlighted block carries the class the stylesheet hangs off', async () => {
	resetRichContentCache();
	const root = await render(codeBlock('js', 'const a = 1;'), newRecorder());
	const code = root.querySelector('code');
	assert.ok(code.classList.contains('hljs'), 'every hljs- rule in styles.css is scoped to .hljs');
	assert.equal(code.innerHTML, '<b>js</b>const a = 1;');
	// The shell and its label are what the copy button and the language caption
	// are built from, and they are unchanged by the memo.
	assert.ok(root.querySelector('.code-block-shell'), 'the code block still gets its shell');
	assert.equal(root.querySelector('.lang-label').textContent, 'js');
});

test('a language highlight.js does not know is left exactly as it was', async () => {
	resetRichContentCache();
	const record = newRecorder();
	// `hljs.highlightElement` used to answer this itself by falling back to
	// no-highlight; `hljs.highlight` throws instead, and a throw is the one
	// result the memo cannot store — so an unknown language must never reach it.
	const root = await render(codeBlock('admonition', 'note: hello'), record);
	assert.deepEqual(record.code, []);
	const code = root.querySelector('code');
	assert.ok(!code.classList.contains('hljs'));
	assert.equal(code.textContent, 'note: hello');
	// The caption still names what the author wrote.
	assert.equal(root.querySelector('.lang-label').textContent, 'admonition');
});

test('the memo is bounded by entry count', async () => {
	resetRichContentCache();
	// 512 entries is the cap. Fill past it and the first one must be gone.
	const first = mathBlock('n0');
	await render(first, newRecorder());
	for (let i = 1; i <= 512; i++) await render(mathBlock(`n${i}`), newRecorder());

	const evicted = newRecorder();
	await render(first, evicted);
	assert.deepEqual(evicted.math, ['display:n0'], 'the oldest entry must have been evicted');

	const kept = newRecorder();
	await render(mathBlock('n512'), kept);
	assert.deepEqual(kept.math, []);
});

test('the memo is bounded by size, not only by count', async () => {
	resetRichContentCache();
	// Six 400k-character outputs are six entries but 2.4M characters, which is
	// over the budget: a handful of enormous formulas must not sit in memory
	// forever just because they are few.
	const huge = () => 'x'.repeat(400_000);
	await render(mathBlock('big0'), newRecorder(), huge);
	for (let i = 1; i < 6; i++) await render(mathBlock(`big${i}`), newRecorder(), huge);

	const evicted = newRecorder();
	await render(mathBlock('big0'), evicted, huge);
	assert.deepEqual(evicted.math, ['display:big0']);
});
