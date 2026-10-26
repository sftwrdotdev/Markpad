import assert from 'node:assert/strict';

import { afterEach, describe, onTestFinished, test, vi } from 'vitest';

import { asRendererLine } from '../src/lib/utils/lineCoordinates.js';
import { buildTocEntries, tocFingerprint } from '../src/lib/utils/tocEntries.js';

describe('outline follows the editor', async () => {
	(window as any).__TAURI_INTERNALS__ = { invoke: async (cmd: string) => (cmd === 'get_os_type' ? 'macos' : null) };
	const { settings } = await import('../src/lib/stores/settings.svelte.js');
	const { CLICK_LOCK_MS, TocNavigator } = await import('../src/lib/stores/tocNavigator.svelte.js');

	const DOC =
		'<h1 id="intro" data-sourcepos="1:1-1:7">Intro</h1>' +
		'<p data-sourcepos="3:1-3:4">text</p>' +
		'<span id="^note" class="block-id-anchor" data-label="note" data-sourcepos="5:1-5:4"></span>' +
		'<h2 data-sourcepos="7:1-7:8"><a class="anchor" id="details"></a>Details</h2>';

	function preview(html = DOC) {
		const markdownBody = document.createElement('article');
		markdownBody.innerHTML = html;
		markdownBody.scrollTo = vi.fn() as any;
		document.body.replaceChildren(markdownBody);
		return markdownBody;
	}

	/** The outline's own list, one button per entry, as Toc.svelte renders it. */
	function outlineList(ids: string[]) {
		const container = document.createElement('div');
		const scrolled: { id: string; options: unknown }[] = [];
		for (const id of ids) {
			const button = document.createElement('button');
			button.dataset.id = id;
			button.scrollIntoView = ((options: unknown) => scrolled.push({ id, options })) as any;
			container.append(button);
		}
		return { container, scrolled };
	}

	function setup() {
		const markdownBody = preview();
		const items = buildTocEntries(markdownBody);
		const list = outlineList(items.map((item) => item.id));
		const outline = new TocNavigator(() => list.container);
		const stop = outline.listen(markdownBody);
		onTestFinished(stop);
		const jump = (id: string) => outline.jumpTo(id, { contentRoot: markdownBody, markdownBody, items });
		return { markdownBody, items, list, outline, jump };
	}

	afterEach(() => {
		vi.useRealTimers();
	});

	test('the outline carries a source line for every entry it builds', () => {
		// Both kinds — headings and block anchors — or the mapping above is asked
		// about entries it cannot place.
		const entries = buildTocEntries(preview());
		assert.deepEqual(
			entries.map((entry) => [entry.id, entry.isBlock, entry.line]),
			[
				['intro', false, 1],
				['^note', true, 5],
				['details', false, 7],
			],
		);
		// The fingerprint decides whether a re-render replaces the items. An edit
		// that only moves a heading changes nothing else about it, so without the
		// line in there the outline would keep answering with the old positions.
		const moved = buildTocEntries(preview(DOC.replace('7:1-7:8', '9:1-9:8')));
		assert.notEqual(tocFingerprint(moved), tocFingerprint(entries));
	});

	test('a click still wins over the editor, as it does over the preview', () => {
		// `clickLock` holds the entry the user picked until the jump's smooth scroll
		// settles. Without it, clicking an entry would highlight it and then lose it
		// to the scroll the click itself caused.
		vi.useFakeTimers();
		const { items, outline, jump } = setup();
		jump('details');
		outline.follow(asRendererLine(1), () => items);
		assert.equal(outline.activeId, 'details');

		vi.advanceTimersByTime(CLICK_LOCK_MS);
		outline.follow(asRendererLine(1), () => items);
		assert.equal(outline.activeId, 'intro');
	});

	test('the outline no longer measures the preview to decide', () => {
		// The loop this replaces did a `querySelector` and a `getBoundingClientRect`
		// per visible entry on every scroll event.
		vi.useFakeTimers();
		const { markdownBody, jump } = setup();
		jump('intro');
		vi.advanceTimersByTime(CLICK_LOCK_MS);
		const target = markdownBody.querySelector('#intro')!;
		assert.ok(target.classList.contains('toc-target-active'));

		const rect = vi.spyOn(Element.prototype, 'getBoundingClientRect');
		const query = vi.spyOn(Element.prototype, 'querySelector');
		try {
			markdownBody.dispatchEvent(new Event('scroll'));
			assert.equal(rect.mock.calls.length, 0);
			assert.equal(query.mock.calls.length, 0);
		} finally {
			rect.mockRestore();
			query.mockRestore();
		}
		// What it still does: a click leaves a highlight on its target, and the
		// next scroll takes it off.
		assert.ok(!target.classList.contains('toc-target-active'));
	});

	test('the jump highlight ends on anything that means the reader moved on', () => {
		// The jump's own smooth scroll is swallowed by the lock, so scrolling alone
		// would leave it on whenever the reader does not scroll. A pointerdown in the
		// preview or a keystroke anywhere ends it, and the lock does not apply.
		vi.useFakeTimers();
		const { markdownBody, jump } = setup();
		const target = markdownBody.querySelector('#details')!;

		jump('details');
		markdownBody.dispatchEvent(new Event('scroll'));
		assert.ok(target.classList.contains('toc-target-active'), 'the jump’s own scroll keeps it');
		markdownBody.dispatchEvent(new Event('pointerdown'));
		assert.ok(!target.classList.contains('toc-target-active'), 'pointerdown clears it');

		jump('details');
		window.dispatchEvent(new KeyboardEvent('keydown', { key: 'a' }));
		assert.ok(!target.classList.contains('toc-target-active'), 'keydown clears it');
	});

	test('the current entry is centred in the outline, not merely kept on screen', () => {
		// `block: 'nearest'` scrolls the least it can: the highlight walked down to
		// the last visible row and stayed pinned there.
		const { items, list, outline } = setup();
		outline.follow(asRendererLine(7), () => items);
		assert.equal(outline.activeId, 'details');
		assert.deepEqual(list.scrolled, [{ id: 'details', options: { block: 'center', behavior: 'smooth' } }]);
	});

	test('an outline click is a jump, so it asks the same preference', () => {
		// #199: the outline was the one jump the preference never reached.
		const original = settings.animateJumpScroll;
		try {
			for (const animate of [false, true]) {
				settings.animateJumpScroll = animate;
				const { markdownBody, jump } = setup();
				jump('details');
				const [[options]] = (markdownBody.scrollTo as any).mock.calls;
				assert.equal(options.behavior, animate ? 'smooth' : 'auto');
			}
		} finally {
			settings.animateJumpScroll = original;
		}
	});
});
