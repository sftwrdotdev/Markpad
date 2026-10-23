import { beforeEach, describe, expect, test } from 'vitest';

import { asRendererLine } from '../src/lib/utils/lineCoordinates.js';
import {
	findAnchorElement,
	getPreviewOffsetForSourceLine,
	type AnchorBox,
	type AnchorNode,
} from '../src/lib/utils/previewAnchor.js';
import { patchPreview } from '../src/lib/utils/previewPatch.js';
import { replacedBy } from '../src/lib/utils/richContent.js';

/**
 * The block patch, from the renderer's split output to the live article.
 * `previewPatchParity.spec.ts` holds it to the whole-document pipeline over a
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
