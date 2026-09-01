import { afterEach, beforeAll, describe, expect, test } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';

import Toc from '../src/lib/components/Toc.svelte';
import { runeProps } from './runeProps.svelte.js';

/**
 * What the outline costs per render, and that the cheaper scan still reads the
 * document the same way.
 *
 * `<Toc>` is handed the whole `sanitizedHtml` string, which changes on every
 * keystroke, and it does not parse it — it uses it as the signal that the
 * preview has been rendered and then reads the live DOM. So the cost is not a
 * second parse of the document. It is `querySelectorAll` over the whole
 * article, and it used to be three of those per render (headings, block
 * anchors, and `[id]` — every element in the document that has one) plus a
 * sort, and SIX whenever the outline actually changed, because the effect read
 * the `items` it writes and so scheduled itself again.
 *
 * A render is a keystroke, and #632 brought the rest of the render down to
 * one changed block. Counting the walks is the only way to keep this from
 * quietly growing back, so the count is the assertion.
 */

/**
 * Svelte's `slide` transition drives the Web Animations API, which jsdom does
 * not implement. Nothing here is about the animation, so it is given something
 * that finishes immediately.
 */
beforeAll(() => {
	(Element.prototype as any).animate = () => ({
		cancel() {},
		pause() {},
		play() {},
		finish() {},
		onfinish: null,
		oncancel: null,
		currentTime: 0,
		startTime: 0,
		playbackRate: 1,
		playState: 'finished',
		finished: Promise.resolve(),
		effect: { getComputedTiming: () => ({ delay: 0, duration: 0, endTime: 0 }) },
	});
});

interface Harness {
	body: HTMLElement;
	props: { markdownBody: HTMLElement; previewRevision: number };
	/** Selectors the outline ran over the whole article since the last reset. */
	passes: string[];
	render(html: string): void;
	entries(): string[];
	stop(): void;
}

let running: Harness | null = null;

afterEach(() => {
	running?.stop();
	running = null;
});

function harness(html: string): Harness {
	const body = document.createElement('div');
	body.innerHTML = html;
	const target = document.createElement('div');
	document.body.replaceChildren(body, target);

	const passes: string[] = [];
	const queryAll = body.querySelectorAll.bind(body);
	(body as any).querySelectorAll = (selector: string) => {
		passes.push(selector);
		return queryAll(selector);
	};

	const props = runeProps({ markdownBody: body, contentRoot: body, previewRevision: 1 });
	const component = mount(Toc, { target, props });
	flushSync();

	const instance: Harness = {
		body,
		props,
		passes,
		render(next: string) {
			// The order the app does it in: the patch writes the DOM, and only
			// then does the revision say so. Bumping first would model the bug
			// this signal replaced.
			body.innerHTML = next;
			props.previewRevision += 1;
			passes.length = 0;
			flushSync();
		},
		entries: () => Array.from(target.querySelectorAll('.toc-link')).map((el) => el.textContent!.trim()),
		stop: () => unmount(component),
	};
	running = instance;
	return instance;
}

const heading = (level: number, id: string, text: string, line: number) =>
	`<h${level} id="${id}" data-fold-key="${id}" data-sourcepos="${line}:1-${line}:9">${text}</h${level}>`;

const anchor = (id: string, line: number) =>
	`<a id="${id}" class="block-id-anchor" data-label="${id}" data-sourcepos="${line}:1-${line}:9"></a>`;

/** A paragraph carrying an id, which is what made the `[id]` walk expensive. */
const para = (id: string, text: string) => `<p id="${id}">${text}</p>`;

describe('what one render costs the outline', () => {
	test('walks the article once when nothing about the outline changed', () => {
		const toc = harness(heading(1, 'a', 'Alpha', 1) + para('p1', 'x'));

		toc.render(heading(1, 'a', 'Alpha', 1) + para('p1', 'xy'));

		expect(toc.passes).toEqual(['h1, h2, h3, h4, h5, h6, a[id].block-id-anchor, span[id].block-id-anchor']);
	});

	test('walks it once when the outline DID change, not twice', () => {
		const toc = harness(heading(1, 'a', 'Alpha', 1) + para('p1', 'x'));

		// Renaming a heading is the edit that changes the outline, and it is also
		// the edit that changes the most blocks — the one render that could least
		// afford to scan the document a second time is the one that did.
		toc.render(heading(1, 'a', 'Alphas', 1) + para('p1', 'x'));

		expect(toc.passes.length).toBe(1);
		expect(toc.entries()).toEqual(['Alphas']);
	});
});

describe('the entries that one walk produces', () => {
	test('interleaves headings and block anchors in document order', () => {
		const toc = harness(
			heading(1, 'title', 'Title', 1) +
				para('p1', 'intro') +
				anchor('note', 3) +
				heading(2, 'first', 'First', 5) +
				anchor('mark', 7) +
				heading(2, 'second', 'Second', 9),
		);

		expect(toc.entries()).toEqual(['Title', 'note', 'First', 'mark', 'Second']);
	});

	test('keeps an anchor that sits inside a heading after the heading', () => {
		const toc = harness(
			`<h2 id="section" data-fold-key="section" data-sourcepos="1:1-1:9">Section${anchor('inline', 1)}</h2>`,
		);

		expect(toc.entries()).toEqual(['Section', 'inline']);
	});

	test('drops a heading the renderer gave no id, and empties out with the document', () => {
		const toc = harness('<h2 data-sourcepos="1:1-1:9">Nameless</h2>' + heading(2, 'named', 'Named', 3));
		expect(toc.entries()).toEqual(['Named']);

		toc.render('<p>no headings at all</p>');
		expect(toc.entries()).toEqual([]);
	});
});
