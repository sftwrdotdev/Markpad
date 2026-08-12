import { beforeEach, describe, expect, test } from 'vitest';

import { patchPreviewBlocks } from '../src/lib/utils/blockPatch.js';

/**
 * The shape `processMarkdownHtml` actually produces: a heading, then a
 * `.foldable-content-wrapper > .content-inner` holding everything under it. It
 * matters that the fixtures look like this rather than like a flat list of
 * paragraphs — a flat document has no second level, and the second level is
 * where every real edit lands.
 */
function section(paragraphs: { line: number; text: string }[]): string {
	const blocks = paragraphs
		.map(({ line, text }) => `<p data-sourcepos="${line}:1-${line}:${text.length}">${text}</p>`)
		.join('');
	return `<h1 data-sourcepos="1:1-1:5" id="t">Title</h1><div class="foldable-content-wrapper" id="wrap-0"><div class="content-inner">${blocks}</div></div>`;
}

let host: HTMLElement;

beforeEach(() => {
	document.body.innerHTML = '';
	host = document.createElement('div');
	document.body.appendChild(host);
});

function paragraphs(): HTMLElement[] {
	return Array.from(host.querySelectorAll('.content-inner > p'));
}

describe('the first render', () => {
	test('inserts every block and reports it as the work to enrich', () => {
		const html = section([
			{ line: 3, text: 'alpha' },
			{ line: 5, text: 'beta' },
		]);
		const patch = patchPreviewBlocks(host, html);

		expect(host.children.length).toBe(2);
		expect(patch.inserted).toEqual([...host.children]);
		expect(patch.kept).toBe(0);
	});

	test('drops the whitespace between blocks, so children and childNodes stay one list', () => {
		patchPreviewBlocks(host, '<p>a</p>\n<p>b</p>\n');
		expect(host.childNodes.length).toBe(host.children.length);
	});
});

describe('typing one character in the middle of a document', () => {
	const before = section([
		{ line: 3, text: 'alpha' },
		{ line: 5, text: 'beta' },
		{ line: 7, text: 'gamma' },
	]);
	const after = section([
		{ line: 3, text: 'alpha' },
		{ line: 5, text: 'betaX' },
		{ line: 7, text: 'gamma' },
	]);

	test('replaces exactly the block that changed and keeps the rest of the nodes', () => {
		patchPreviewBlocks(host, before);
		const [alpha, beta, gamma] = paragraphs();

		const patch = patchPreviewBlocks(host, after);
		const [alphaAfter, betaAfter, gammaAfter] = paragraphs();

		expect(alphaAfter).toBe(alpha);
		expect(gammaAfter).toBe(gamma);
		expect(betaAfter).not.toBe(beta);
		expect(betaAfter.textContent).toBe('betaX');
	});

	test('hands renderRichContent only the changed block', () => {
		patchPreviewBlocks(host, before);
		const patch = patchPreviewBlocks(host, after);

		expect(patch.inserted.map((element) => element.textContent)).toEqual(['betaX']);
		expect(patch.replaced).toBe(1);
	});

	test('descends through the fold wrapper instead of replacing the whole section', () => {
		patchPreviewBlocks(host, before);
		const wrapper = host.querySelector('.foldable-content-wrapper');
		const inner = host.querySelector('.content-inner');

		patchPreviewBlocks(host, after);

		expect(host.querySelector('.foldable-content-wrapper')).toBe(wrapper);
		expect(host.querySelector('.content-inner')).toBe(inner);
	});
});

describe('inserting a line above everything', () => {
	test('keeps the blocks that only moved, and refreshes their source ranges', () => {
		patchPreviewBlocks(
			host,
			section([
				{ line: 3, text: 'alpha' },
				{ line: 5, text: 'beta' },
			]),
		);
		const [alpha, beta] = paragraphs();

		// Every line below the insertion is renumbered. This is the case a
		// `data-sourcepos` key gets wrong: nothing about the rendering changed.
		const patch = patchPreviewBlocks(
			host,
			section([
				{ line: 4, text: 'alpha' },
				{ line: 6, text: 'beta' },
			]),
		);

		expect(paragraphs()).toEqual([alpha, beta]);
		expect(patch.replaced).toBe(0);
		expect(alpha.getAttribute('data-sourcepos')).toBe('4:1-4:5');
		expect(beta.getAttribute('data-sourcepos')).toBe('6:1-6:4');
	});
});

describe('typing in a heading', () => {
	test('replaces the heading and looks inside the wrapper holding the rest of the file', () => {
		patchPreviewBlocks(host, section([{ line: 3, text: 'alpha' }]));
		const [alpha] = paragraphs();

		const patch = patchPreviewBlocks(
			host,
			section([{ line: 3, text: 'alpha' }]).replace('>Title<', '>Titles<'),
		);

		expect(paragraphs()).toEqual([alpha]);
		expect(patch.inserted.map((element) => element.tagName)).toEqual(['H1']);
	});
});

describe('blocks that renderRichContent rewrote', () => {
	test('survive a patch, because the diff keys off what was inserted, not what is there now', () => {
		const before = section([
			{ line: 3, text: 'alpha' },
			{ line: 5, text: 'beta' },
		]);
		patchPreviewBlocks(host, before);

		// What the code-block pass does to a `<pre>`: a new parent, a new sibling,
		// and markup that no longer resembles what the renderer emitted.
		const alpha = paragraphs()[0];
		const shell = document.createElement('div');
		shell.className = 'code-block-shell';
		alpha.replaceWith(shell);
		shell.appendChild(alpha);
		shell.appendChild(document.createElement('button'));

		const patch = patchPreviewBlocks(
			host,
			section([
				{ line: 3, text: 'alpha' },
				{ line: 5, text: 'betaX' },
			]),
		);

		expect(host.querySelector('.code-block-shell')).toBe(shell);
		expect(shell.contains(alpha)).toBe(true);
		expect(patch.inserted.map((element) => element.textContent)).toEqual(['betaX']);
	});

	test('still get their source range refreshed, through the node that replaced them', () => {
		patchPreviewBlocks(host, section([{ line: 3, text: 'alpha' }]));

		const alpha = paragraphs()[0];
		const diagram = document.createElement('div');
		diagram.className = 'mermaid-diagram';
		diagram.setAttribute('data-sourcepos', alpha.getAttribute('data-sourcepos')!);
		alpha.replaceWith(diagram);

		patchPreviewBlocks(host, section([{ line: 4, text: 'alpha' }]));

		expect(host.querySelector('.mermaid-diagram')).toBe(diagram);
		expect(diagram.getAttribute('data-sourcepos')).toBe('4:1-4:5');
	});
});

describe('a container somebody else rewrote', () => {
	test('is replaced wholesale rather than diffed against a stale record', () => {
		patchPreviewBlocks(host, '<p>a</p><p>b</p>');
		host.appendChild(document.createElement('p'));

		const patch = patchPreviewBlocks(host, '<p>a</p><p>b</p>');

		expect(patch.replaced).toBe(2);
		expect(host.children.length).toBe(2);
	});
});
