import { beforeEach, expect, test } from 'vitest';

import { patchPreviewBlocks } from '../src/lib/utils/blockPatch.js';

/**
 * Switching tabs must not rebuild the document being switched to.
 *
 * The preview used to have ONE `.markdown-blocks` host for every tab, so a
 * switch handed that host the other document's markup. Two documents share no
 * block keys, so the diff replaced essentially every node: `renderRichContent`
 * ran over the whole document again, the folds re-measured, and the reading
 * position was restored against a layout that was still settling. That is one
 * cause with three symptoms — a visible reload, motion, and a position that
 * moved after it had been restored.
 *
 * There is a host per tab now, and this is the property that makes the switch
 * free. It is a property of `patchPreviewBlocks` plus the per-host memo it
 * keeps (`renderedKeys`, a `WeakMap` keyed on the container), not of any new
 * module: re-patching a host that already holds that document matches every key
 * and changes nothing.
 *
 * What this cannot check is the wiring in `MarkdownViewer.svelte` that gives
 * each tab its own host — that component cannot be mounted outside Tauri. What
 * it does check is the mechanism the wiring depends on, and it is the half that
 * would fail silently: a keying change in `blockPatch.ts` would still look
 * correct on screen and quietly put the whole cost back.
 */

function doc(title: string, paragraphs: string[]): string {
	const blocks = paragraphs
		.map((text, i) => `<p data-sourcepos="${i + 3}:1-${i + 3}:${text.length}">${text}</p>`)
		.join('');
	return (
		`<h1 data-sourcepos="1:1-1:${title.length}" id="${title}">${title}</h1>` +
		`<div class="foldable-content-wrapper"><div class="content-inner">${blocks}</div></div>`
	);
}

const A = doc('alpha', ['one', 'two', 'three']);
const B = doc('beta', ['four', 'five']);

let hostA: HTMLElement;
let hostB: HTMLElement;

beforeEach(() => {
	document.body.innerHTML = '';
	hostA = document.createElement('div');
	hostB = document.createElement('div');
	document.body.append(hostA, hostB);
});

test('re-showing a tab replaces no nodes and asks for no enrichment', () => {
	patchPreviewBlocks(hostA, A);
	patchPreviewBlocks(hostB, B);

	const backToA = patchPreviewBlocks(hostA, A);

	expect(backToA.replaced).toBe(0);
	expect(backToA.inserted).toEqual([]);
});

test('the nodes the reader was looking at are the same objects afterwards', () => {
	patchPreviewBlocks(hostA, A);
	const before = [...hostA.querySelectorAll('.content-inner > p')];

	patchPreviewBlocks(hostB, B);
	patchPreviewBlocks(hostA, A);

	const after = [...hostA.querySelectorAll('.content-inner > p')];
	expect(after).toEqual(before);
	// Identity, not equality: a rebuilt tree passes `toEqual` on the markup and
	// is still a different set of boxes with different layout.
	after.forEach((node, i) => expect(node).toBe(before[i]));
});

test('each host remembers its own document, so neither switch disturbs the other', () => {
	patchPreviewBlocks(hostA, A);
	patchPreviewBlocks(hostB, B);
	patchPreviewBlocks(hostA, A);
	patchPreviewBlocks(hostB, B);

	expect(hostA.querySelector('h1')!.textContent).toBe('alpha');
	expect(hostB.querySelector('h1')!.textContent).toBe('beta');
});

test('a document that changed while its tab was hidden is patched, not rebuilt, on the way back', () => {
	patchPreviewBlocks(hostA, A);
	const wrapper = hostA.querySelector('.foldable-content-wrapper')!;

	// What a background render does: the tab's `content` is rewritten while the
	// host is off screen. The host is untouched until the tab is shown again.
	const edited = doc('alpha', ['one', 'two EDITED', 'three']);
	const patch = patchPreviewBlocks(hostA, edited);

	expect(patch.inserted.length).toBe(1);
	expect(hostA.querySelector('.foldable-content-wrapper')).toBe(wrapper);
	expect(hostA.textContent).toContain('two EDITED');
});

test('the same host given a different document does replace everything — the case being avoided', () => {
	patchPreviewBlocks(hostA, A);
	const patch = patchPreviewBlocks(hostA, B);

	expect(patch.replaced).toBeGreaterThan(0);
	// Without this the three tests above would pass against a patch function
	// that never replaces anything at all.
});
