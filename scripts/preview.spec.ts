import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import assert from 'node:assert/strict';
import { flashCopiedLabel, renderRichContent, replacedBy, type RichContentLibraries } from '../src/lib/utils/richContent.js';
import { patchHost, patchPreview } from '../src/lib/utils/previewPatch.js';
import { readDiagramSource } from '../src/lib/utils/mermaidPrint.js';
import { resetDiagramCache } from '../src/lib/utils/diagramCache.js';
import { toggleFold } from '../src/lib/utils/foldState.js';
import { type AnchorBox, type AnchorNode, findAnchorElement, getPreviewOffsetForSourceLine, getSourceLineAtPreviewOffset } from '../src/lib/utils/previewAnchor.js';
import { processMarkdownHtml } from '../src/lib/utils/markdown.js';
import { type Annotation, annotationOf, hitAt, occurrenceRanges, overlapping, rangeOf } from '../src/lib/utils/previewAnnotations.js';
import { asRendererLine } from '../src/lib/utils/lineCoordinates.js';
import { copyableFlavours, copyableHtml, handleCopy } from '../src/lib/utils/previewCopy.js';
import { linkTooltipFor } from '../src/lib/utils/previewLinks.js';
import { imageMenuItems, saveImageAs, type SaveImageDeps } from '../src/lib/utils/viewerContextMenu.js';
import { loadLocale } from '../src/lib/utils/i18n.js';
import { type DomPoint, pointAtSource, sourceAtPoint, type SourcePoint } from '../src/lib/utils/previewCursor.js';
import { ALLOWED_MARKDOWN_URI_REGEXP, sanitizeMarkdownFragment, sanitizeMarkdownHtml } from '../src/lib/utils/sanitize.js';
import blocks from './fixtures/markdown-syntax.blocks.json';
import DOMPurify from 'dompurify';
import { readSource } from './sourceTree.js';

/**
 * Clicking a code block's Copy label twice within 1.5 s left it reading
 * "Copied!" for good: the second click saved "Copied!" as the label to restore.
 */
describe('copy button label flash', () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	test('a second copy inside the 1.5 s still restores the language name', () => {
		vi.useFakeTimers();
		const label = document.createElement('button');
		label.textContent = 'typescript';

		flashCopiedLabel(label);
		vi.advanceTimersByTime(500);
		flashCopiedLabel(label);
		expect(label.innerHTML).toBe('Copied!');

		vi.advanceTimersByTime(1500);
		expect(label.innerHTML).toBe('typescript');
		expect(label.classList.contains('copied')).toBe(false);

		// And the label still works after that.
		flashCopiedLabel(label);
		expect(label.innerHTML).toBe('Copied!');
		vi.advanceTimersByTime(1500);
		expect(label.innerHTML).toBe('typescript');
	});
});

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
 * every render put the whole document back as source. the block patch (#632)
 * keeps enriched nodes across renders instead, and from then on a theme change
 * reached no diagram at all. The `<pre>` is gone, `patch.inserted` is empty on
 * a re-render of the same document, and typing does not help either: the
 * diagram's markup is unchanged, so the patch keeps the node.
 *
 * The libraries are stood in for at the same boundary `exportRichContent` and
 * `richContentIdempotence` use. What is under test is Markpad's bookkeeping:
 * which containers it decides are stale, and what it does to them.
 */
describe('diagram theme refresh', () => {
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
			const patch = patchPreview(document.createElement('div'), '<p>x</p>', '', new Set());
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
	 * Mermaid's config is one global: `initialize` writes it at once, and `render`
	 * reads it only when its turn in Mermaid's own queue comes. The stand-in keeps
	 * that shape: one global theme, read after the draw has yielded.
	 */
	function queuedLibraries(): RichContentLibraries {
		let theme = 'unset';
		return {
			hljs: { getLanguage: () => undefined, highlight: () => ({ value: '' }) },
			katex: { renderToString: (source: string) => source },
			renderMathInElement: () => {},
			mermaid: {
				initialize: (config: { theme: string }) => {
					theme = config.theme;
				},
				render: async (id: string) => {
					await new Promise((resolve) => setTimeout(resolve, 0));
					return { svg: `<svg id="${id}" data-drawn-for="${theme}"></svg>` };
				},
			},
		} as any;
	}

	test('two passes in different themes each draw in their own', async () => {
		resetDiagramCache();
		const mermaid = queuedLibraries();
		// A preview pass and a PDF export's pass over another copy, overlapping.
		const preview = article(`${PRE}<pre><code class="language-mermaid">graph LR;C-->D;</code></pre>`);
		const print = document.createElement('div');
		print.innerHTML = PRE;

		await Promise.all([
			renderRichContent({ roots: [preview], libraries: mermaid, mermaidTheme: 'dark', idFactory: (i) => `p${i}` }),
			renderRichContent({ roots: [print], libraries: mermaid, mermaidTheme: 'neutral', idFactory: (i) => `x${i}` }),
		]);

		const themes = (root: ParentNode) =>
			[...root.querySelectorAll('.mermaid-diagram svg')].map((svg) => svg.getAttribute('data-drawn-for'));
		expect(themes(preview)).toEqual(['dark', 'dark']);
		expect(themes(print)).toEqual(['neutral']);
	});
});

describe('line samples cache', () => {
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
		// Re-activating a tab hands its host the document it already holds, so the
		// patch is skipped — but the hosts' `display` is what changed, and
		// `isAnchorable` reads it.
		const host = document.createElement('div');
		document.body.replaceChildren(host);
		const html = '<p data-sourcepos="1:1-1:1">x</p>\0\n<p data-sourcepos="10:1-10:1">y</p>';
		const tab = () => ({ filePath: '/docs/a.md', foldOverrides: new Set<string>() });
		patchHost(host, html, tab, () => {});
		const measure = (node: AnchorNode) => ({ top: (node as unknown as Element).textContent === 'y' ? 100 : 0, height: 0 });
		getSourceLineAtPreviewOffset(host, 50, measure);

		const walk = vi.spyOn(Node.prototype, 'childNodes', 'get');
		const patch = patchHost(host, html, tab, () => {});
		expect(patch.inserted).toHaveLength(0);
		getSourceLineAtPreviewOffset(host, 50, measure);
		expect(walk).toHaveBeenCalled();
		walk.mockRestore();
	});
});

describe('NBSP blank lines', () => {
	/**
	 * An NBSP is typed on purpose, to keep an empty line Markdown would collapse
	 * or to indent text (#843). The inputs are `convert_markdown` output,
	 * captured from comrak.
	 */

	function render(html: string): HTMLElement {
		const root = document.createElement('div');
		root.innerHTML = processMarkdownHtml(html, '/doc.md', new Set());
		return root;
	}

	test('an NBSP paragraph after a code block is kept', () => {
		// "```\ncode block\n```\n\u00a0\n\nAfter.\n"
		const root = render(
			'<pre data-sourcepos="1:1-3:3"><code>code block\n</code></pre>\n' +
				'<p data-sourcepos="4:1-4:2">\u00a0</p>\n' +
				'<p data-sourcepos="6:1-6:6">After.</p>\n',
		);

		assert.deepEqual(
			Array.from(root.querySelectorAll('p'), (p) => p.textContent),
			['\u00a0', 'After.'],
		);
	});

	test('an NBSP first line in a callout body is kept', () => {
		// "> [!NOTE]\n> \u00a0\n> Body.\n"
		const root = render(
			'<blockquote data-sourcepos="1:1-3:7">\n' +
				'<p data-sourcepos="1:3-3:7">[!NOTE]<br data-sourcepos="1:10-1:10" />\n' +
				'\u00a0<br data-sourcepos="2:5-2:5" />\nBody.</p>\n</blockquote>\n',
		);

		const body = root.querySelector('.markdown-alert-content');
		assert.ok(body, 'the blockquote became a callout');
		assert.match(body.textContent ?? '', /^\s*\u00a0/);
		assert.ok(body.querySelector('br'), 'the NBSP line keeps its break');
	});

	test('the empty paragraph the callout marker leaves is still removed', () => {
		// "> [!NOTE]\n>\n> Body.\n" puts an ordinary blank line under the marker.
		const root = render(
			'<blockquote data-sourcepos="1:1-3:7">\n' +
				'<p data-sourcepos="1:3-1:9">[!NOTE]</p>\n' +
				'<p data-sourcepos="3:3-3:7">Body.</p>\n</blockquote>\n',
		);

		const body = root.querySelector('.markdown-alert-content');
		assert.ok(body, 'the blockquote became a callout');
		assert.deepEqual(
			Array.from(body.querySelectorAll('p'), (p) => p.textContent),
			['Body.'],
		);
	});

	test('NBSP indentation at the start of a task item is kept', () => {
		// "- [ ] \u00a0\u00a0indented\n"
		const root = render(
			'<ul class="contains-task-list" data-sourcepos="1:1-1:18">\n' +
				'<li data-sourcepos="1:1-1:18"><input type="checkbox" data-task-checkbox="" ' +
				'class="task-list-item-checkbox" disabled="" /> \u00a0\u00a0indented</li>\n</ul>\n',
		);

		assert.equal(root.querySelector('.task-text')?.textContent, '\u00a0\u00a0indented');
	});
});

describe('preview annotations', () => {
	// A reader's session-only highlight: the selection goes to source points,
	// and comes back as the same text however the preview was re-rendered since.

	const SOURCE = ['A paragraph with **bold text** here.', '', '中文段落里有**粗体**和测试。'];

	const HTML = '<p data-sourcepos="1:1-1:36">A paragraph with <strong data-sourcepos="1:18-1:30">bold text</strong> here.</p>\n<p data-sourcepos="3:1-3:40">中文段落里有<strong data-sourcepos="3:19-3:28">粗体</strong>和测试。</p>';

	const readLine = (line: number) => SOURCE[line - 1];

	function render() {
		const root = document.createElement('div');
		root.innerHTML = HTML;
		return root;
	}

	function select(root: Element, from: string, to: string) {
		const text = root.textContent!;
		const start = text.indexOf(from);
		const end = text.indexOf(to) + to.length;
		const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
		const range = document.createRange();
		let seen = 0;
		for (let node = walker.nextNode() as Text | null; node; node = walker.nextNode() as Text | null) {
			if (start >= seen && start < seen + node.data.length) range.setStart(node, start - seen);
			if (end > seen && end <= seen + node.data.length) range.setEnd(node, end - seen);
			seen += node.data.length;
		}
		return range;
	}

	test('a selection comes back as the same text in a fresh render', () => {
		const cases: Array<[string, string, string]> = [
			['bold', 'text', 'bold text'],
			['with', 'here', 'with bold text here'],
			['text', '粗体', 'text here.\n中文段落里有粗体'],
			['粗', '测', '粗体和测'],
		];
		for (const [from, to, expected] of cases) {
			const shown = render();
			const mark = annotationOf(shown, select(shown, from, to), readLine);
			assert.ok(mark, `${from}…${to} mapped`);
			assert.equal(rangeOf(render(), mark, readLine)?.toString(), expected);
		}
	});

	const at = (line: number, column: number) => ({ line: asRendererLine(line), column });

	const span = (a: number, b: number): Annotation => ({ start: at(1, a), end: at(1, b) });

	test('overlap is half-open, and a point hits the mark around it', () => {
		const marks = [span(3, 8), span(12, 20)];
		assert.deepEqual(overlapping(marks, span(7, 13)), marks);
		assert.deepEqual(overlapping(marks, span(8, 12)), [], 'touching ends do not overlap');
		assert.deepEqual(hitAt(marks, at(1, 3)), [marks[0]]);
		assert.deepEqual(hitAt(marks, at(1, 8)), [], 'the end is outside');
		assert.deepEqual(hitAt(marks, at(2, 1)), []);
	});

	test('occurrences are the exact copies of the selected text, up to the limit', () => {
		const root = document.createElement('div');
		root.innerHTML = '<p>cat, Cat, cat</p><p>concatenate <strong>cat</strong></p>';
		const found = occurrenceRanges(root, 'cat', 100);
		assert.deepEqual(found.map((range) => range.toString()), ['cat', 'cat', 'cat', 'cat'], 'case-sensitive, inside words too');
		assert.equal(occurrenceRanges(root, 'cat', 2).length, 2);
	});
});

describe('preview copy flavours', () => {
	// #674: what a preview selection looks like once it leaves the app. The
	// clipboard carries no stylesheet, so anything the preview only renders
	// correctly *because* of one has to be resolved here or it arrives wrong.

	const DOC = '/Users/me/notes/report.md';

	/** The fragment a `Range.cloneContents()` would hand over, spelled as HTML. */
	function fragmentOf(html: string): DocumentFragment {
		const template = document.createElement('template');
		template.innerHTML = html;
		return template.content;
	}

	test('structure survives untouched', () => {
		const html = copyableHtml(
			fragmentOf('<h2>Heading</h2><p><strong>bold</strong> and <em>italic</em> and <a href="https://example.com">a link</a></p><ul><li>one</li></ul>'),
			DOC,
		);
		assert.match(html, /<h2>Heading<\/h2>/);
		assert.match(html, /<strong>bold<\/strong>/);
		assert.match(html, /<em>italic<\/em>/);
		assert.match(html, /<a href="https:\/\/example\.com">a link<\/a>/);
		assert.match(html, /<li>one<\/li>/);
	});

	test('a formula is carried once, not twice', () => {
		// KaTeX renders both halves and hides the MathML in CSS. Pasted into a
		// document with no KaTeX stylesheet, both are visible — the formula reads
		// twice, once as MathML text and once as the glyphs.
		const katex =
			'<span class="katex">' +
			'<span class="katex-mathml"><math><semantics><mrow><mi>E</mi></mrow><annotation encoding="application/x-tex">E=mc^2</annotation></semantics></math></span>' +
			'<span class="katex-html" aria-hidden="true"><span class="base">E=mc2</span></span>' +
			'</span>';
		const html = copyableHtml(fragmentOf(katex), DOC);
		assert.doesNotMatch(html, /katex-mathml/);
		assert.doesNotMatch(html, /annotation/);
		// The half that stays is the one the user was looking at, and the one
		// `selection.toString()` already puts in the plain-text flavour.
		assert.match(html, /katex-html/);
		assert.match(html, /E=mc2/);
	});

	test('the fold chevrons do not travel', () => {
		const html = copyableHtml(
			fragmentOf('<h2>Section<span class="header-fold-icon">▾</span></h2><div class="markdown-alert"><span class="callout-fold-icon">▾</span>Note</div>'),
			DOC,
		);
		assert.doesNotMatch(html, /fold-icon/);
		assert.match(html, /Section/);
		assert.match(html, /Note/);
	});

	test('a local image becomes a URL the receiving app can open', () => {
		// `asset://` (and `http://asset.localhost` on Windows) is this app's own
		// scheme; anything else pasting it shows a broken image.
		const posix = copyableHtml(fragmentOf('<img src="asset://localhost/Users/me/notes/img/shot.png">'), DOC);
		assert.match(posix, /src="file:\/\/\/Users\/me\/notes\/img\/shot\.png"/);

		const windows = copyableHtml(fragmentOf('<img src="http://asset.localhost/C:/notes/img/shot.png">'), DOC);
		assert.match(windows, /src="file:\/\/\/C:\/notes\/img\/shot\.png"/);
	});

	test('a document-relative image is resolved against the document', () => {
		const html = copyableHtml(fragmentOf('<img src="img/diagram.png">'), DOC);
		assert.match(html, /src="file:\/\/\/Users\/me\/notes\/img\/diagram\.png"/);
	});

	test('a path with a space or a hash survives as a URL', () => {
		// Both end a URL where they sit, so `notes #2.png` would otherwise resolve
		// to `notes ` and the image would be missing rather than broken.
		const html = copyableHtml(fragmentOf('<img src="asset://localhost/Users/me/my%20notes/shot%20%232.png">'), DOC);
		assert.match(html, /src="file:\/\/\/Users\/me\/my%20notes\/shot%20%232\.png"/);
	});

	test('a remote image and a data URI are left alone', () => {
		const remote = copyableHtml(fragmentOf('<img src="https://example.com/a.png">'), DOC);
		assert.match(remote, /src="https:\/\/example\.com\/a\.png"/);

		const inline = copyableHtml(fragmentOf('<img src="data:image/png;base64,AAAA">'), DOC);
		assert.match(inline, /src="data:image\/png;base64,AAAA"/);
	});

	// ---------------------------------------------------------------- both flavours

	/** A selection over `html`, as the preview would hand one to the handler. */
	function selectionOver(html: string): Selection {
		document.body.innerHTML = `<div id="preview">${html}</div>`;
		const range = document.createRange();
		range.selectNodeContents(document.getElementById('preview') as HTMLElement);
		const selection = window.getSelection() as Selection;
		selection.removeAllRanges();
		selection.addRange(range);
		return selection;
	}

	const KATEX_INLINE =
		'<span class="katex">' +
		'<span class="katex-mathml"><math><semantics><mrow><mi>E</mi></mrow><annotation encoding="application/x-tex">E=mc^2</annotation></semantics></math></span>' +
		'<span class="katex-html" aria-hidden="true"><span class="base">E=mc2</span></span>' +
		'</span>';

	test('a formula copies as its source, not as the glyphs', () => {
		// What `katex/contrib/copy-tex` did before this module took the copy over.
		// The rendered spans read `E=mc2`, which is not the formula and cannot be
		// pasted back into a Markdown document.
		const { text } = copyableFlavours(selectionOver(`<p>Einstein: ${KATEX_INLINE}</p>`), '');
		assert.match(text, /\$E=mc\^2\$/);
		assert.doesNotMatch(text, /E=mc2/);
	});

	test('a display formula keeps its display delimiters', () => {
		const { text } = copyableFlavours(selectionOver(`<p class="katex-display">${KATEX_INLINE}</p>`), '');
		assert.match(text, /\$\$E=mc\^2\$\$/);
	});

	test('a selection with no math takes its plain text from the selection itself', () => {
		// `Selection.toString()` is the only source that knows what is rendered —
		// `textContent` of the fragment would pick up hidden nodes and lose the line
		// breaks between blocks.
		const { text } = copyableFlavours(selectionOver('<p>one</p><p>two</p>'), '');
		assert.match(text, /one/);
		assert.match(text, /two/);
	});

	test('a soft break the preview hides is not pasted as a line break (#967)', () => {
		const copy = (article: string) => {
			document.body.innerHTML = `<article class="${article}"><p>one<br class="softbreak">\ntwo<br>\nthree</p></article>`;
			const paragraph = document.querySelector('p') as HTMLElement;
			const range = document.createRange();
			range.setStart(paragraph.firstChild as Text, 0);
			range.setEnd(paragraph.lastChild as Text, 6);
			const selection = window.getSelection() as Selection;
			selection.removeAllRanges();
			selection.addRange(range);
			return copyableFlavours(selection, '').html;
		};
		assert.match(copy('markdown-body'), /one<br class="softbreak">\ntwo<br>/);
		assert.match(copy('markdown-body soft-breaks'), /one\ntwo<br>\nthree/);
	});

	test('both flavours come back from one call', () => {
		const { text, html } = copyableFlavours(selectionOver('<p><strong>bold</strong></p>'), '');
		assert.match(html, /<strong>bold<\/strong>/);
		assert.match(text, /bold/);
	});
});

describe('preview cursor mapping', () => {
	// #799's shared cursor: a click in the preview lands on a source character,
	// and the editor's cursor is drawn back onto the rendered character. The HTML
	// is `convert_markdown`'s real output for SOURCE, so the columns are comrak's
	// UTF-8 byte offsets, which the Chinese lines exercise.

	const SOURCE = "# Title here\n\nA paragraph with **bold text** and a [link](https://example.com) here.\nSecond line with `code` and an escaped \\* star & more.\n\n中文段落里有**粗体**和测试。\n\n- item one\n- item **two**\n\n> quoted text\n\n```js\nlet x = 1;\n```\n\n| name | 值 |\n| --- | --- |\n| 甲 | beta |\n";

	const HTML = "<h1 id=\"title-here\" data-sourcepos=\"1:1-1:12\">Title here<a href=\"#title-here\" aria-label=\"Link to heading 'Title here'\" data-heading-content=\"Title here\" class=\"anchor\"></a></h1>\n<p data-sourcepos=\"3:1-4:54\">A paragraph with <strong data-sourcepos=\"3:18-3:30\">bold text</strong> and a <a data-sourcepos=\"3:38-3:64\" href=\"https://example.com\">link</a> here.<br data-sourcepos=\"3:71-3:71\" />\nSecond line with <code data-sourcepos=\"4:18-4:23\">code</code> and an escaped * star &amp; more.</p>\n<p data-sourcepos=\"6:1-6:40\">中文段落里有<strong data-sourcepos=\"6:19-6:28\">粗体</strong>和测试。</p>\n<ul data-sourcepos=\"8:1-9:14\">\n<li data-sourcepos=\"8:1-8:10\">item one</li>\n<li data-sourcepos=\"9:1-10:0\">item <strong data-sourcepos=\"9:8-9:14\">two</strong></li>\n</ul>\n<blockquote data-sourcepos=\"11:1-11:13\">\n<p data-sourcepos=\"11:3-11:13\">quoted text</p>\n</blockquote>\n<pre data-sourcepos=\"13:1-15:3\"><code class=\"language-js\">let x = 1;\n</code></pre>\n<table data-sourcepos=\"17:1-19:14\">\n<thead>\n<tr data-sourcepos=\"17:1-17:14\">\n<th data-sourcepos=\"17:2-17:7\">name</th>\n<th data-sourcepos=\"17:9-17:13\">值</th>\n</tr>\n</thead>\n<tbody>\n<tr data-sourcepos=\"19:1-19:14\">\n<td data-sourcepos=\"19:2-19:6\">甲</td>\n<td data-sourcepos=\"19:8-19:13\">beta</td>\n</tr>\n</tbody>\n</table>\n";

	const sourceLines = SOURCE.split('\n');

	const readLine = (line: number) => sourceLines[line - 1];

	function render() {
		const root = document.createElement('div');
		root.innerHTML = HTML;
		return root;
	}

	/** The text node and offset of the `nth` occurrence of `char` in rendered text under `selector`. */
	function charIn(root: Element, selector: string, char: string, nth = 0) {
		const walker = document.createTreeWalker(root.querySelector(selector)!, NodeFilter.SHOW_TEXT);
		let seen = 0;
		for (let node = walker.nextNode() as Text | null; node; node = walker.nextNode() as Text | null) {
			for (let offset = 0; offset < node.data.length; offset++) {
				if (node.data[offset] === char && seen++ === nth) return { node, offset };
			}
		}
		throw new Error(`no ${char} under ${selector}`);
	}

	const at = (line: number, column: number): SourcePoint => ({ line: asRendererLine(line), column });

	test('a click lands on the source character it rendered', () => {
		const root = render();
		const cases: Array<[string, string, SourcePoint, number?]> = [
			['h1', 'T', at(1, 3)],
			['p strong', 'b', at(3, 20)],
			['p a', 'l', at(3, 39)],
			['p code', 'c', at(4, 19)],
			['p', '*', at(4, 41)],
			['p', '&', at(4, 48)],
			['p:nth-of-type(2)', '粗', at(6, 9)],
			['p:nth-of-type(2)', '测', at(6, 14)],
			['li', 'o', at(8, 8)],
			['li:nth-of-type(2) strong', 't', at(9, 10)],
			['blockquote p', 'q', at(11, 3)],
			['pre', 'x', at(14, 5)],
			['td', '甲', at(19, 3)],
			['td:nth-of-type(2)', 'b', at(19, 7)],
		];
		for (const [selector, char, expected] of cases) {
			assert.deepEqual(sourceAtPoint(root, charIn(root, selector, char), readLine), expected, `${char} in ${selector}`);
			assert.equal(sourceLines[expected.line - 1][expected.column - 1], char, `${char} is the source character there`);
		}
	});

	test('every rendered character goes to the source and back to itself', () => {
		const root = render();
		const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
		let checked = 0;
		for (let node = walker.nextNode() as Text | null; node; node = walker.nextNode() as Text | null) {
			for (let offset = 0; offset < node.data.length; offset++) {
				if (/\s/.test(node.data[offset]) || !node.parentElement?.closest('[data-sourcepos]')) continue;
				const source: SourcePoint = sourceAtPoint(root, { node, offset }, readLine)!;
				const back: DomPoint = pointAtSource(root, source, readLine)!;
				assert.equal(back.node, node, `"${node.data[offset]}" came back in another node`);
				assert.equal(back.offset, offset, `"${node.data[offset]}" came back at another offset`);
				checked++;
			}
		}
		assert.ok(checked > 130, `the fixture was walked (${checked})`);
	});

	test('a fenced block pairs its code, not its info string', () => {
		// `js` on the fence would take the first two characters of `js = 1`.
		const root = document.createElement('div');
		root.innerHTML = '<pre data-sourcepos="1:1-3:3"><code class="language-js">js = 1;\n</code></pre>';
		const lines = ['```js', 'js = 1;', '```'];
		const point = sourceAtPoint(root, charIn(root, 'pre', 's'), (line) => lines[line - 1]);
		assert.deepEqual(point, at(2, 2));
	});

	test('a point inside KaTeX lands just after the formula', () => {
		const root = document.createElement('div');
		root.innerHTML = '<p data-sourcepos="1:1-1:14">sum <span class="katex">x2x^2</span> done</p>';
		const katex = root.querySelector('.katex')!;
		const point = sourceAtPoint(root, { node: katex.firstChild!, offset: 1 }, () => 'sum $x^2$ done');
		assert.deepEqual(point, at(1, 10), 'on the space after `$x^2$`');
	});
});

describe('preview patch', () => {
	/**
	 * The block patch, from the renderer's split output to the live article.
	 * `preview.spec.ts` holds it to the whole-document pipeline over a
	 * real document; these pin which nodes it keeps, which it replaces, and what
	 * it hands on, one edit at a time.
	 */

	let host: HTMLElement;

	beforeEach(() => {
		document.body.innerHTML = '';
		host = document.createElement('div');
		document.body.appendChild(host);
	});

	const patch = (html: string, folds = new Set<string>()) => patchPreview(host, html, '/docs/a.md', folds);

	const split = (...parts: string[]) => parts.join('\0\n');

	const p = (line: number, text: string) => `<p data-sourcepos="${line}:1-${line}:${text.length}">${text}</p>`;

	const h = (level: number, line: number, text: string, id = text.toLowerCase()) =>
		`<h${level} id="${id}" data-sourcepos="${line}:1-${line}:${text.length + level + 1}">${text}</h${level}>`;

	const bodies = () => Array.from(host.querySelectorAll('p')) as HTMLElement[];

	describe('the first render', () => {
		test('inserts every block, folds each section under its heading, and hands all of it on', () => {
			const result = patch(split(h(1, 1, 'Title'), p(3, 'alpha'), p(5, 'beta')));

			expect(Array.from(host.children).map((e) => e.className)).toEqual(['foldable-header', 'foldable-content-wrapper']);
			expect(host.querySelectorAll('.foldable-content-wrapper > .content-inner > p').length).toBe(2);
			expect(result.inserted.map((e) => e.tagName)).toEqual(['H1', 'P', 'P']);
			expect(result.wrappers.length).toBe(1);
		});

		test('carries no whitespace between blocks, so children and childNodes stay one list', () => {
			patch(split(p(1, 'a'), p(3, 'b')) + '\n');
			expect(host.childNodes.length).toBe(host.children.length);
		});
	});

	describe('raw HTML that breaks out of the batch a first render parses blocks in', () => {
		test('is rendered block by block instead, with nothing attributed to the wrong block', () => {
			const forged = '<div>a</div></section><section data-preview-block="guess"><p>b</p>';
			const result = patch(split(p(1, 'alpha'), forged, p(5, 'beta')));

			expect(Array.from(host.children).map((e) => e.textContent)).toEqual(['alpha', 'a', 'b', 'beta']);
			expect(result.inserted.length).toBe(4);

			patch(split(p(1, 'alphaX'), forged, p(5, 'beta')));
			expect(Array.from(host.children).map((e) => e.textContent)).toEqual(['alphaX', 'a', 'b', 'beta']);
		});
	});

	describe('typing one character in the middle of a document', () => {
		const before = split(h(1, 1, 'Title'), p(3, 'alpha'), p(5, 'beta'), p(7, 'gamma'));
		const after = split(h(1, 1, 'Title'), p(3, 'alpha'), p(5, 'betaX'), p(7, 'gamma'));

		test('replaces exactly that block, in place, and keeps every other node', () => {
			patch(before);
			const [alpha, beta, gamma] = bodies();
			const heading = host.querySelector('h1');
			const wrapper = host.querySelector('.foldable-content-wrapper');

			const result = patch(after);

			const [alphaAfter, betaAfter, gammaAfter] = bodies();
			expect(alphaAfter).toBe(alpha);
			expect(gammaAfter).toBe(gamma);
			expect(betaAfter).not.toBe(beta);
			expect(betaAfter.textContent).toBe('betaX');
			expect(host.querySelector('h1')).toBe(heading);
			expect(host.querySelector('.foldable-content-wrapper')).toBe(wrapper);
			expect(result.inserted).toEqual([betaAfter]);
			expect(result.wrappers).toEqual([]);
		});
	});

	describe('inserting a line above everything', () => {
		test('keeps the blocks that only moved and gives them their new source ranges', () => {
			patch(split(p(3, 'alpha'), `<ul data-sourcepos="5:1-5:9">\n<li data-sourcepos="5:1-5:9">item</li>\n</ul>`));
			const [alpha] = bodies();
			const item = host.querySelector('li')!;

			const result = patch(split(p(4, 'alpha'), `<ul data-sourcepos="6:1-6:9">\n<li data-sourcepos="6:1-6:9">item</li>\n</ul>`));

			expect(result.inserted).toEqual([]);
			expect(bodies()[0]).toBe(alpha);
			expect(host.querySelector('li')).toBe(item);
			expect(alpha.getAttribute('data-sourcepos')).toBe('4:1-4:5');
			// The task checkbox toggle writes to the line it reads here.
			expect(item.getAttribute('data-sourcepos')).toBe('6:1-6:9');
		});

		test('moves the line anchors this side added by the same amount', () => {
			const long = (line: number) =>
				`<p data-sourcepos="${line}:1-${line + 2}:1">a<br class="softbreak" data-sourcepos="${line}:2-${line}:2" />\nb<br class="softbreak" data-sourcepos="${line + 1}:2-${line + 1}:2" />\nc</p>`;
			patch(long(1));
			const anchors = () => Array.from(host.querySelectorAll('.source-line-anchor')).map((a) => a.getAttribute('data-sourcepos'));
			expect(anchors()).toEqual(['2:1-2:1', '3:1-3:1']);

			patch(long(4));
			expect(anchors()).toEqual(['5:1-5:1', '6:1-6:1']);
		});
	});

	describe('headings', () => {
		test('typing in one replaces the heading and keeps its wrapper and everything in it', () => {
			patch(split(h(1, 1, 'Title'), p(3, 'alpha')));
			const [alpha] = bodies();
			const wrapper = host.querySelector('.foldable-content-wrapper')!;

			const result = patch(split(h(1, 1, 'Titles'), p(3, 'alpha')));

			expect(result.inserted.map((e) => e.tagName)).toEqual(['H1']);
			expect(bodies()[0]).toBe(alpha);
			expect(host.querySelector('.foldable-content-wrapper')).toBe(wrapper);
			expect(host.querySelector('h1')!.getAttribute('data-fold-target')).toBe(wrapper.id);
		});

		test('renaming one of many identical ones replaces the renumbered headings and nothing else', () => {
			const sections = (names: string[]) => {
				const seen = new Map<string, number>();
				return split(
					...names.flatMap((name, index) => {
						const slug = name.toLowerCase();
						const n = seen.get(slug) ?? 0;
						seen.set(slug, n + 1);
						return [h(2, index * 4 + 1, name, n ? `${slug}-${n}` : slug), p(index * 4 + 3, `body ${index}`)];
					}),
				);
			};
			patch(sections(['Objectives', 'Objectives', 'Objectives']));
			const kept = bodies();
			const wrappers = Array.from(host.querySelectorAll('.foldable-content-wrapper'));

			const result = patch(sections(['Goals', 'Objectives', 'Objectives']));

			expect(result.inserted.map((e) => e.tagName)).toEqual(['H2', 'H2', 'H2']);
			expect(bodies()).toEqual(kept);
			bodies().forEach((body, index) => expect(body).toBe(kept[index]));
			expect(Array.from(host.querySelectorAll('.foldable-content-wrapper'))).toEqual(wrappers);
			expect(Array.from(host.querySelectorAll('h2')).map((e) => e.id)).toEqual(['goals', 'objectives', 'objectives-1']);
		});

		test('a new section regroups the blocks after it under the new heading, without rebuilding them', () => {
			patch(split(h(2, 1, 'One'), p(3, 'alpha'), p(5, 'beta')));
			const [alpha, beta] = bodies();

			const result = patch(split(h(2, 1, 'One'), p(3, 'alpha'), h(2, 5, 'Two'), p(7, 'beta')));

			expect(result.inserted.map((e) => e.tagName)).toEqual(['H2']);
			expect(result.wrappers.length).toBe(2);
			const sections = Array.from(host.querySelectorAll('.foldable-content-wrapper'));
			expect(sections[0].contains(alpha)).toBe(true);
			expect(sections[1].contains(beta)).toBe(true);
		});

		test('a new subsection leaves the sections around it where they were', () => {
			patch(split(h(2, 1, 'One'), p(3, 'alpha'), h(2, 5, 'Two'), p(7, 'beta'), h(2, 9, 'Three'), p(11, 'gamma')));
			const [one, twoBody, three] = Array.from(host.querySelectorAll('.foldable-content-wrapper'));
			const two = host.querySelector('#two')!;
			two.classList.add('is-collapsed');
			two.nextElementSibling!.classList.add('is-collapsed');

			const result = patch(
				split(h(2, 1, 'One'), p(3, 'alpha'), h(2, 5, 'Two'), p(7, 'beta'), h(3, 9, 'Sub'), p(11, 'x'), h(2, 13, 'Three'), p(15, 'gamma')),
			);

			const wrappers = Array.from(host.querySelectorAll('.foldable-content-wrapper'));
			expect(wrappers[0]).toBe(one);
			expect(wrappers[1]).toBe(twoBody);
			expect(wrappers[wrappers.length - 1]).toBe(three);
			// Only the new subsection is wrapped: the section around it ends where it did.
			expect(result.wrappers.map((w) => w.previousElementSibling!.id)).toEqual(['sub']);
			// The section the reader closed is still closed, and now holds the new one.
			expect(two.nextElementSibling!.classList.contains('is-collapsed')).toBe(true);
			expect(two.nextElementSibling!.querySelector('#sub')).not.toBeNull();
		});

		test('a new section of the same level re-wraps only the section it splits', () => {
			patch(split(h(2, 1, 'One'), p(3, 'alpha'), h(2, 5, 'Two'), p(7, 'beta'), p(9, 'b2'), h(2, 11, 'Three'), p(13, 'gamma')));
			const [one, , three] = Array.from(host.querySelectorAll('.foldable-content-wrapper'));
			const kept = bodies();

			const result = patch(
				split(h(2, 1, 'One'), p(3, 'alpha'), h(2, 5, 'Two'), p(7, 'beta'), h(2, 9, 'Mid'), p(11, 'b2'), h(2, 13, 'Three'), p(15, 'gamma')),
			);

			expect(result.wrappers.map((w) => w.previousElementSibling!.id)).toEqual(['two', 'mid']);
			const wrappers = Array.from(host.querySelectorAll('.foldable-content-wrapper'));
			expect(wrappers[0]).toBe(one);
			expect(wrappers[3]).toBe(three);
			expect(bodies().every((body, index) => body === kept[index])).toBe(true);
			expect(wrappers[2].textContent).toBe('b2');
		});

		test('a new paragraph right under a heading goes into that heading\'s section, first', () => {
			patch(split(h(2, 1, 'One'), p(3, 'alpha')));
			patch(split(h(2, 1, 'One'), p(3, 'new'), p(5, 'alpha')));

			const inner = host.querySelector('.content-inner')!;
			expect(Array.from(inner.children).map((e) => e.textContent)).toEqual(['new', 'alpha']);
		});

		test('a new paragraph above the first heading stays outside every section', () => {
			patch(split(h(2, 1, 'One'), p(3, 'alpha')));
			patch(split(p(1, 'lead'), h(2, 3, 'One'), p(5, 'alpha')));

			expect(host.firstElementChild!.textContent).toBe('lead');
		});
	});

	describe('folds', () => {
		const doc = split(h(2, 1, 'One'), p(3, 'alpha'), h(2, 5, 'Two'), p(7, 'beta'));

		test('a fold the document is told to keep closed is closed on the first render', () => {
			patch(doc, new Set(['two']));
			expect(host.querySelector('#two')!.classList.contains('is-collapsed')).toBe(true);
			expect(host.querySelector('#two')!.nextElementSibling!.classList.contains('is-collapsed')).toBe(true);
		});

		test('a fold the reader closed stays closed through an edit somewhere else', () => {
			patch(doc);
			const two = host.querySelector('#two')!;
			two.classList.add('is-collapsed');

			patch(doc.replace('>alpha<', '>alphaX<'));

			expect(host.querySelector('#two')).toBe(two);
			expect(two.classList.contains('is-collapsed')).toBe(true);
		});

		test('callouts with the same title get keys of their own', () => {
			const callout = (line: number) =>
				`<blockquote data-sourcepos="${line}:1-${line + 1}:3">\n<p data-sourcepos="${line}:3-${line + 1}:3">[!note]- Same<br class="softbreak" data-sourcepos="${line}:16-${line}:16" />\nx</p>\n</blockquote>`;
			patch(split(callout(1), callout(4)));
			expect(Array.from(host.querySelectorAll('.callout-foldable')).map((e) => e.getAttribute('data-fold-key'))).toEqual([
				'callout:Same',
				'callout:Same~1',
			]);
		});
	});

	describe('blocks that renderRichContent replaced', () => {
		const pre = (line: number) => `<pre data-sourcepos="${line}:1-${line + 2}:3"><code class="language-js">x\n</code></pre>`;

		/** What the code-block pass does: a new parent, recorded for the patch. */
		function shell(element: Element): HTMLElement {
			const wrapper = document.createElement('div');
			wrapper.className = 'code-block-shell';
			element.replaceWith(wrapper);
			wrapper.appendChild(element);
			replacedBy.set(element, wrapper);
			return wrapper;
		}

		test('are kept through an edit elsewhere, and removed whole when their block goes', () => {
			patch(split(pre(1), p(5, 'alpha')));
			const wrapper = shell(host.querySelector('pre')!);

			patch(split(pre(1), p(5, 'alphaX')));
			expect(host.firstElementChild).toBe(wrapper);

			patch(split(p(1, 'alphaX')));
			expect(host.querySelector('.code-block-shell')).toBeNull();
			expect(host.children.length).toBe(1);
		});

		test('get their new source range through the node that replaced them', () => {
			patch(split(pre(1)));
			const original = host.querySelector('pre')!;
			const diagram = document.createElement('div');
			diagram.className = 'mermaid-diagram';
			diagram.setAttribute('data-sourcepos', original.getAttribute('data-sourcepos')!);
			original.replaceWith(diagram);
			replacedBy.set(original, diagram);

			patch(split(pre(2)));

			expect(host.firstElementChild).toBe(diagram);
			expect(diagram.getAttribute('data-sourcepos')).toBe('2:1-4:3');
		});
	});

	/**
	 * The memos in `previewAnchor.ts` assume a node whose source lines changed is a
	 * new node. A kept node with rewritten ranges is not, so the patch has to drop
	 * them — shown by asking `previewAnchor` its own questions across a patch.
	 * jsdom has no layout, so the boxes are supplied.
	 */
	describe('the source ranges previewAnchor has already read', () => {
		test('follow a range rewritten on a node that was kept', () => {
			patch(split(p(1, 'alpha'), p(3, 'beta')));
			const [alpha, beta] = bodies();
			const boxes = new Map<AnchorNode, AnchorBox>([
				[alpha, { top: 0, height: 100 }],
				[beta, { top: 100, height: 100 }],
			]);
			const measure = (node: AnchorNode): AnchorBox => boxes.get(node) ?? { top: NaN, height: NaN };
			expect(getPreviewOffsetForSourceLine(host, asRendererLine(3), measure)).toBe(100);

			patch(split(p(3, 'alpha'), p(5, 'beta')));

			expect(bodies()).toEqual([alpha, beta]);
			expect(getPreviewOffsetForSourceLine(host, asRendererLine(3), measure)).toBe(0);
			expect(getPreviewOffsetForSourceLine(host, asRendererLine(5), measure)).toBe(100);
		});

		test('follow kept blocks inside a kept section', () => {
			patch(split(h(1, 1, 'Title'), p(3, 'alpha'), p(5, 'beta')));
			expect(findAnchorElement(host, 5)?.element).toBe(bodies()[1]);

			patch(split(h(1, 1, 'Title'), p(8, 'alpha'), p(10, 'beta')));

			expect(findAnchorElement(host, 10)?.element).toBe(bodies()[1]);
			expect(findAnchorElement(host, 8)?.element).toBe(bodies()[0]);
		});
	});

	describe('an article somebody else rewrote', () => {
		test('is rebuilt rather than diffed against a stale record', () => {
			patch(split(p(1, 'a'), p(3, 'b')));
			host.appendChild(document.createElement('p'));

			const result = patch(split(p(1, 'a'), p(3, 'b')));

			expect(result.inserted.length).toBe(2);
			expect(host.children.length).toBe(2);
		});
	});
});

describe('preview patch parity', () => {
	/**
	 * The block patch against the whole-document pipeline it replaced, over the
	 * renderer's real output for samples/markdown-syntax.md (every construct the
	 * preview has: callouts, folds, footnotes, math, Mermaid, task lists, raw
	 * `<details>` around Markdown). `preview_block_fixture_is_current` in
	 * markdown.rs keeps the fixture in step with the renderer.
	 *
	 * Three properties:
	 *   - a first render is the document the old pipeline produced;
	 *   - after an edit, the patched article is what a first render of the edited
	 *     document would be — the incremental path loses nothing;
	 *   - undoing the edit puts the original document back.
	 */

	const SPLIT = blocks.join('\0');

	const PATH = '/docs/markdown-syntax.md';

	/** `wrap-N` ids only have to be unique; the two paths hand them out in a different order. */
	const normalized = (host: Element) => host.innerHTML.replace(/wrap-\d+/g, 'wrap-N');

	function oldPipeline(split: string): string {
		const host = document.createElement('div');
		host.append(sanitizeMarkdownFragment(processMarkdownHtml(split.replaceAll('\0\n', ''), PATH, new Set())));
		// The old patch carried elements only, never the whitespace between them.
		for (const node of Array.from(host.childNodes)) if (node.nodeType !== 1) node.remove();
		return normalized(host);
	}

	function cold(split: string): string {
		const host = document.createElement('div');
		patchPreview(host, split, PATH, new Set());
		return normalized(host);
	}

	/** Every `data-sourcepos` line moved down by one: a line inserted at the top. */
	const enterAtTop = (split: string) =>
		split.replace(/data-sourcepos="(\d+):(\d+)-(\d+):(\d+)"/g, (_, a, b, c, d) => `data-sourcepos="${+a + 1}:${b}-${+c + 1}:${d}"`);

	const at = (split: string, index: number, edit: (block: string) => string) => {
		const parts = split.split('\0');
		parts[index] = edit(parts[index]);
		return parts.join('\0');
	};

	const firstIndex = (pattern: RegExp) => blocks.findIndex((block) => pattern.test(block));

	const middleParagraph = blocks.findIndex((block, index) => index > blocks.length / 2 && /^\n?<p /.test(block));

	const firstH2 = firstIndex(/^\n?<h2 /);

	const mermaid = firstIndex(/language-mermaid/);

	const details = firstIndex(/<details>/);

	const edits: Record<string, (split: string) => string> = {
		'a keystroke in a paragraph': (split) => at(split, middleParagraph, (b) => b.replace('</p>', 'x</p>')),
		'a line inserted at the top': enterAtTop,
		'a renamed heading': (split) => at(split, firstH2, (b) => b.replace(/(<h2 [^>]*>)/, '$1Renamed ')),
		'a new paragraph': (split) => at(split, middleParagraph, (b) => `${b}\0\n<p data-sourcepos="900:1-900:3">new</p>\n`),
		'a new section': (split) => at(split, middleParagraph, (b) => `${b}\0\n<h2 id="added" data-sourcepos="900:1-900:8">Added</h2>\n`),
		'a deleted heading': (split) => at(split, firstH2, () => ''),
		'a new subsection': (split) => at(split, middleParagraph, (b) => `${b}\0\n<h3 id="sub" data-sourcepos="900:1-900:7">Sub</h3>\n`),
		'a new top-level heading': (split) => at(split, firstH2, (b) => `<h1 id="top" data-sourcepos="900:1-900:5">Top</h1>\n\0${b}`),
		'a heading changed level': (split) => at(split, firstH2, (b) => b.replace(/^(\n?)<h2 /, '$1<h3 ').replace(/<\/h2>/, '</h3>')),
		'an edited diagram': (split) => at(split, mermaid, (b) => b.replace('</code>', 'C --&gt; D\n</code>')),
		'an edited raw HTML block': (split) => at(split, details, (b) => b.replace('</summary>', ' edited</summary>')),
	};

	let host: HTMLElement;

	beforeEach(() => {
		document.body.innerHTML = '';
		host = document.createElement('div');
		document.body.appendChild(host);
	});

	test('the fixture has the constructs the edits below aim at', () => {
		expect([middleParagraph, firstH2, mermaid, details].every((index) => index > 0)).toBe(true);
	});

	test('a first render is what the whole-document pipeline produced', () => {
		expect(cold(SPLIT)).toBe(oldPipeline(SPLIT));
	});

	describe.each(Object.entries(edits))('%s', (_, edit) => {
		test('patches to what a first render of the edited document is', () => {
			const edited = edit(SPLIT);
			expect(edited).not.toBe(SPLIT);
			patchPreview(host, SPLIT, PATH, new Set());
			patchPreview(host, edited, PATH, new Set());
			expect(normalized(host)).toBe(cold(edited));
		});

		test('and back to the original when it is undone', () => {
			patchPreview(host, SPLIT, PATH, new Set());
			patchPreview(host, edit(SPLIT), PATH, new Set());
			patchPreview(host, SPLIT, PATH, new Set());
			expect(normalized(host)).toBe(cold(SPLIT));
		});
	});
});

/**
 * What the shared sanitizer actually does to an author stylesheet — run, not
 * described.
 *
 * `preview.checks.test.ts` pins the WIRING: that the preview reaches the
 * shared policy, that the policy forbids `<style>`, that no second DOMPurify
 * call site assembles a config of its own. None of that runs DOMPurify, because
 * DOMPurify needs a real DOM and `node --test` has none. The behavioural half
 * therefore used to be a table of numbers measured by hand in a browser and
 * pasted into a comment — true when it was written and unfalsifiable ever
 * after.
 *
 * jsdom has a real DOM and a real cascade, so it is a test now. The payload is
 * the one that comment recorded, verbatim:
 *
 *     <style>.titlebar{display:none} body{background-image:url("…/beacon")}</style>
 *
 * and the observable is the same one: the preview injects `tab.content` into
 * the APPLICATION'S OWN document, so a stylesheet that survives the filter is
 * not scoped to the article — it restyles Markpad. `.titlebar` is a real
 * element of the app's chrome, and `getComputedStyle` is what answers whether
 * the document author moved it.
 *
 * The `background-image` half is the beacon: in a browser the computed value
 * being a URL is followed by a request for it (the comment recorded the entry
 * in `performance.getEntriesByType('resource')`, and the shipped CSP allows it
 * — `img-src … https:`). jsdom does not fetch it. The computed value is the
 * part that is a property of the sanitizer rather than of the network stack,
 * and it is the part asserted here.
 *
 * WHY THE "BEFORE" ROW IS ASSERTED TOO: without it "the `<style>` is gone"
 * proves nothing about the policy — an unrelated change that dropped every
 * `<style>` on any config would keep it green. The old config is DOMPurify's
 * default plus the URI pattern the viewer had hand-copied, which is exactly the
 * shape the regression had, and under it the payload still works. That is the
 * difference the policy makes.
 */
describe('preview sanitizing', () => {
	/** The document author's payload, as it arrives from comrak (`render.unsafe_ = true`). */
	const POC_STYLE = '<style>.titlebar{display:none} body{background-image:url("https://attacker.example/beacon")}</style>';

	/**
	 * A rendered document carrying it.
	 *
	 * The leading paragraph is not decoration. DOMPurify serializes its parse
	 * tree's `<body>`, and the HTML parser puts a `<style>` that opens a fragment
	 * into `<head>` instead — so a payload-only string comes back empty on ANY
	 * config, and the two rows below would agree for a reason that has nothing to
	 * do with the policy. Every real rendered document has prose before the raw
	 * HTML in it.
	 */
	const RENDERED = `<p>An ordinary paragraph of prose.</p>\n${POC_STYLE}`;

	/** The config the viewer used to build at its own call site: the URI pattern, and nothing else. */
	const VIEWER_LOCAL_CONFIG = { ALLOWED_URI_REGEXP: ALLOWED_MARKDOWN_URI_REGEXP };

	/**
	 * The app's own document, with the chrome the payload aims at.
	 *
	 * No inline `style` on the titlebar: an inline declaration outranks a class
	 * selector, which would make the "before" row look safe for the wrong reason.
	 * The app's own rule is a stylesheet rule, so the test's is too.
	 */
	function mountApp(): { titlebar: Element; preview: HTMLElement } {
		document.head.innerHTML = '<style>.titlebar{display:flex} body{background-image:none}</style>';
		document.body.innerHTML = '<div class="titlebar"></div><div class="markdown-body"></div>';
		return {
			titlebar: document.querySelector('.titlebar')!,
			preview: document.querySelector<HTMLElement>('.markdown-body')!,
		};
	}

	afterEach(() => {
		document.head.innerHTML = '';
		document.body.innerHTML = '';
	});

	test('the config the preview used to build lets a document restyle the application', () => {
		const { titlebar, preview } = mountApp();
		assert.equal(getComputedStyle(titlebar).display, 'flex', 'precondition: the app decides where its chrome is');

		const sanitized = DOMPurify.sanitize(RENDERED, VIEWER_LOCAL_CONFIG);
		assert.match(sanitized, /<style>/, 'the old config keeps the author stylesheet — that is the regression');

		preview.innerHTML = sanitized;

		assert.equal(getComputedStyle(titlebar).display, 'none', "the document hid the app's title bar");
		assert.equal(
			getComputedStyle(document.body).backgroundImage,
			'url("https://attacker.example/beacon")',
			'and pointed the app at an outbound URL',
		);
	});

	test('the shared policy drops the stylesheet and leaves the application alone', () => {
		const { titlebar, preview } = mountApp();

		const sanitized = sanitizeMarkdownHtml(RENDERED);
		assert.doesNotMatch(sanitized, /<style/i, 'the shared policy forbids the tag');
		assert.match(sanitized, /<p>An ordinary paragraph of prose\.<\/p>/, 'and keeps the document itself');

		preview.innerHTML = sanitized;

		assert.equal(getComputedStyle(titlebar).display, 'flex');
		assert.equal(getComputedStyle(document.body).backgroundImage, 'none');
	});

	test('the inline style attribute is still allowed, because documents use it', () => {
		// The other half of the policy decision, and the reason it is `FORBID_TAGS`
		// rather than "strip everything that styles": an inline declaration is scoped
		// to the one element the author wrote it on, so `<img style="width:50%">`
		// keeps working. Run rather than read: `FORBID_ATTR: ['style']` would pass
		// every assertion in the test above and silently break existing files.
		const { preview } = mountApp();

		preview.innerHTML = sanitizeMarkdownHtml('<p style="text-align:center">centred</p>');

		const paragraph = preview.querySelector('p')!;
		assert.equal(getComputedStyle(paragraph).textAlign, 'center');
	});

	test('the preview path patches in the filtered nodes, with the same policy', () => {
		// The patch takes the renderer's own output and sanitizes each block it
		// inserts, so this is the path the article is actually filled through —
		// on the first render and on an edit.
		const { titlebar, preview } = mountApp();
		const payload = '<p><a href="javascript:alert(1)">x</a><img src="x" onerror="alert(1)"></p>\0\n<script>alert(1)</script>';

		patchPreview(preview, `${RENDERED}\0\n${payload}`, '/docs/a.md', new Set());
		patchPreview(preview, `${RENDERED}\0\n<p>edit</p>\0\n${payload}`, '/docs/a.md', new Set());

		assert.equal(preview.querySelector('p')?.textContent, 'An ordinary paragraph of prose.');
		assert.equal(preview.querySelector('style, script, [onerror], [href^="javascript"]'), null);
		assert.equal(getComputedStyle(titlebar).display, 'flex');
		assert.equal(getComputedStyle(document.body).backgroundImage, 'none');
	});
});

describe('rich content idempotence', () => {
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
});

describe('link hover preview', () => {
	test('the hover preview never prints the webview origin', () => {
		// `[3.md](./3.md)` showed `tauri://localhost/3.md`: the DOM resolves
		// `href` against the webview's own origin. The box names the link as the
		// document wrote it.
		const anchor = document.createElement('a');
		anchor.setAttribute('href', './3.md');
		assert.notEqual(anchor.href, './3.md', 'jsdom resolves the property, as the webview does');
		assert.deepEqual(linkTooltipFor(anchor, { findAnchorTarget: () => null, footnoteRoot: null }), {
			text: './3.md',
			html: '',
			isFootnote: false,
		});
	});

	test('a footnote tooltip is read back out of the rendered preview', () => {
		// `{@html tooltip.html}` is the one sink besides the patched article, and it
		// is allowed because its body is a clone of what the sanitized article
		// already holds — never markup built from the unrendered buffer.
		const preview = document.createElement('div');
		preview.innerHTML = '<ol><li id="fn-1"><p>The <em>note</em> <a href="#fnref-1" class="footnote-backref">↩</a></p></li></ol>';
		const ref = document.createElement('a');
		ref.setAttribute('href', 'fn-1');
		ref.setAttribute('data-footnote-ref', '');
		const label = linkTooltipFor(ref, { findAnchorTarget: () => null, footnoteRoot: preview });
		assert.equal(label?.isFootnote, true);
		assert.equal(label?.html, '<p>The <em>note</em> </p>');
		assert.equal(preview.querySelector('.footnote-backref')?.textContent, '↩', 'the preview keeps its own back-link');
	});
});

describe('preview copy handler', () => {
	// #549 put both DOM-selection copy routes — ⌘C in the preview, and Edit ▸ Copy
	// in the menu bar — on one handler that writes the clipboard itself, because
	// WebKit's own copy writes a WebArchive beside the text. #674 added exactly one
	// more flavour, `text/html`, built here rather than by the scheme.

	afterEach(() => {
		window.getSelection()?.removeAllRanges();
		document.body.innerHTML = '';
	});

	function copyEvent() {
		const written: Record<string, string> = {};
		let prevented = false;
		const event = {
			clipboardData: { setData: (type: string, value: string) => { written[type] = value; } },
			preventDefault: () => { prevented = true; },
		} as unknown as ClipboardEvent;
		return { event, written, prevented: () => prevented };
	}

	function select(html: string) {
		document.body.innerHTML = `<article>${html}</article>`;
		const range = document.createRange();
		range.selectNodeContents(document.querySelector('article')!);
		const selection = window.getSelection()!;
		selection.removeAllRanges();
		selection.addRange(range);
		return selection;
	}

	const DOC = '/Users/me/notes/report.md';

	test('the copy handler writes plain text and cancels the native copy', () => {
		select('<p>hello <strong>world</strong></p>');
		const copy = copyEvent();
		handleCopy(copy.event, DOC);
		assert.equal(copy.written['text/plain'], 'hello world');
		// Without this the native copy still runs and still builds the archive.
		assert.equal(copy.prevented(), true);
	});

	test('the rich flavour is the one this handler builds, and the only one', () => {
		// RTF is WebKit's own flavour; writing it would be the scheme deciding again.
		const selection = select('<p>hello <strong>world</strong></p>');
		const expected = copyableFlavours(selection, DOC).html;
		const copy = copyEvent();
		handleCopy(copy.event, DOC);
		assert.deepEqual(Object.keys(copy.written).sort(), ['text/html', 'text/plain']);
		assert.equal(copy.written['text/html'], expected);
		assert.match(copy.written['text/html'], /<strong>world<\/strong>/);
	});

	test('both flavours come from one decision', () => {
		// A selection containing math takes its plain text from the formula
		// source, which only the HTML pass knows about.
		select(
			'<p>Energy <span class="katex">' +
				'<span class="katex-mathml"><math><semantics><mrow><mi>E</mi></mrow><annotation encoding="application/x-tex">E=mc^2</annotation></semantics></math></span>' +
				'<span class="katex-html" aria-hidden="true"><span class="base">E=mc2</span></span>' +
				'</span></p>',
		);
		const copy = copyEvent();
		handleCopy(copy.event, DOC);
		assert.equal(copy.written['text/plain'], 'Energy $E=mc^2$');
		assert.doesNotMatch(copy.written['text/html'], /katex-mathml/);
	});

	test('a selection inside a form control is left to the platform', () => {
		// `getSelection()` cannot read a selection inside a field, so cancelling
		// here would copy an empty string. Monaco takes input through a hidden
		// textarea, which keeps the editor on its own copy path (#548).
		const field = document.createElement('textarea');
		document.body.append(field);
		field.focus();
		const article = document.createElement('article');
		article.innerHTML = '<p>preview text</p>';
		document.body.append(article);
		const range = document.createRange();
		range.selectNodeContents(article);
		window.getSelection()!.removeAllRanges();
		window.getSelection()!.addRange(range);
		assert.equal(document.activeElement, field);
		assert.equal(window.getSelection()!.isCollapsed, false);
		const copy = copyEvent();
		handleCopy(copy.event, DOC);
		assert.deepEqual(copy.written, {});
		assert.equal(copy.prevented(), false);
	});

	test('a collapsed selection is not copied', () => {
		// Edit ▸ Copy is enabled with nothing selected; writing '' would clear the
		// clipboard instead of leaving it alone.
		select('<p>preview text</p>');
		window.getSelection()!.collapseToStart();
		const copy = copyEvent();
		handleCopy(copy.event, DOC);
		assert.deepEqual(copy.written, {});
		assert.equal(copy.prevented(), false);
	});
});

/*
 * "Save image as" could never save a remote image, and on Windows it could not
 * save a LOCAL one either. It took `src.startsWith('http')` -> `fetch(src)`:
 * the app's CSP is `connect-src 'self'`, so that fetch is refused before a
 * request is made, and `convertFileSrc` spells a local file
 * `http://asset.localhost/…` on Windows, so every Windows image fell into that
 * unreachable branch. `normalizeAssetPath` (#363) recognises both spellings.
 */
describe('save image as', () => {
	function recordingDeps(dest: string | null = '/out/saved.png') {
		const calls: string[] = [];
		const deps: SaveImageDeps = {
			save: async (options) => {
				calls.push(`save:${options.defaultPath}`);
				return dest;
			},
			copyFile: async (src, to) => void calls.push(`copy:${src}->${to}`),
			toast: (message, type = 'info') => void calls.push(`toast:${type}:${message}`),
			language: () => 'en',
		};
		return { deps, calls };
	}

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	test('the viewer recognises an asset URL with the shared helper', async () => {
		// Both spellings convertFileSrc emits, Windows first.
		for (const [src, path] of [
			['http://asset.localhost/C%3A%2FUsers%2FDaniel%2Fimg%2Fdiagram.png', 'C:/Users/Daniel/img/diagram.png'],
			['asset://localhost/%2Fhome%2Fdaniel%2Fdiagram.png', '/home/daniel/diagram.png'],
		]) {
			const { deps, calls } = recordingDeps();
			await saveImageAs(src, deps);
			assert.equal(calls[1], `copy:${path}->/out/saved.png`, src);
		}
	});

	test('nothing tries to fetch image bytes from the webview any more', async () => {
		// Dead code that reads like a working feature: it opened no dialog, wrote
		// no file, and reported a network failure that never happened.
		const fetch = vi.fn(async () => new Response(new Uint8Array([1])));
		vi.stubGlobal('fetch', fetch);
		for (const src of ['https://example.test/a.png', 'http://asset.localhost/C%3A%2Fa.png', 'data:image/png;base64,AA==']) {
			await saveImageAs(src, recordingDeps().deps);
		}
		assert.equal(fetch.mock.calls.length, 0);
	});

	test('a local image is copied on the Rust side', async () => {
		const local = recordingDeps();
		await saveImageAs('asset://localhost/%2Fpics%2Fcat.jpg', local.deps);
		assert.deepEqual(local.calls, ['save:image.jpg', 'copy:/pics/cat.jpg->/out/saved.png', 'toast:info:Image saved successfully']);

		// And the save dialog is only offered for a file that can actually be
		// written; the remote case bails out before it.
		const remote = recordingDeps();
		await saveImageAs('https://example.test/a.png', remote.deps);
		assert.equal(remote.calls.length, 1);
		assert.match(remote.calls[0], /^toast:error:/);
	});

	test('the saved toast uses the language chosen while the dialog was open', async () => {
		await loadLocale('de');
		let language: 'en' | 'de' = 'en';
		const { deps, calls } = recordingDeps();
		const save = deps.save;
		deps.save = async (options) => {
			language = 'de';
			return save(options);
		};
		deps.language = () => language;
		await saveImageAs('asset://localhost/%2Fpics%2Fcat.jpg', deps);
		assert.equal(calls.at(-1), 'toast:info:Bild erfolgreich gespeichert');
	});

	test('the preview offers Save Image As only for a local image', () => {
		// A remote or data: image cannot be saved, so the item is not shown for one
		// rather than shown and answered with an error toast.
		const itemsFor = (src: string) => {
			const img = document.createElement('img');
			img.src = src;
			return imageMenuItems(img, 'en', () => {}).map((item) => item.label ?? '-');
		};
		assert.deepEqual(itemsFor('asset://localhost/%2Fpics%2Fcat.jpg'), ['Save Image As...', '-']);
		assert.deepEqual(itemsFor('http://asset.localhost/C%3A%2Fcat.jpg'), ['Save Image As...', '-']);
		assert.deepEqual(itemsFor('https://example.test/cat.jpg'), []);
		assert.deepEqual(itemsFor('data:image/png;base64,AA=='), []);
	});
});

// #681 floated inline code above the words of a heading, #791 ate the spaces
// around `*not*` and broke it into `n`/`o`/`t` on a narrow pane. Both came from
// a flex heading: every text run, `<em>`, `<code>` and image becomes its own
// flex item. The fold chevron is absolutely positioned, so inline layout costs
// it nothing.
describe('inline content in headings', () => {
	afterEach(() => {
		document.head.innerHTML = '';
		document.body.innerHTML = '';
	});

	test('a rendered heading lays its content out as one line of text under the app stylesheet', () => {
		// The stylesheet the app loads, run by jsdom's cascade (`?raw` comes back
		// empty under vitest's CSS handling).
		const style = document.createElement('style');
		style.textContent = readSource('src/styles.css');
		document.head.append(style);
		const body = document.createElement('div');
		body.className = 'markdown-body';
		body.innerHTML = processMarkdownHtml(
			[1, 2, 3, 4, 5, 6].map((level) => `<h${level}>Use <code>x</code> and <em>not</em> y</h${level}>`).join('\n'),
			'/doc.md',
			new Set(),
		);
		document.body.append(body);
		const headings = Array.from(body.querySelectorAll<HTMLElement>('.foldable-header'));
		assert.equal(headings.length, 6, 'precondition: every level is a foldable heading');
		for (const heading of headings) {
			assert.doesNotMatch(getComputedStyle(heading).display, /flex|grid/, `${heading.tagName} lays its words out as flex items`);
		}
	});
});
