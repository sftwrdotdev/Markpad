import { expect, test } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';

import Toc from '../src/lib/components/Toc.svelte';
import { readSource } from './sourceTree.js';
import { runeProps } from './runeProps.svelte.js';

/**
 * The outline reads the preview's DOM, so it has to be told when that DOM holds
 * the document — not when the document was rendered.
 *
 * Those are one step apart on a mount, and the step is not a race that usually
 * lands the right way round: Svelte runs a child component's effects BEFORE its
 * parent's, so `<Toc>` always scanned the article before the parent effect that
 * fills it. Keyed on the rendered string, the outline came up empty and nothing
 * changed that string again, so it stayed empty for the life of the component.
 *
 * A floating outline hid it by closing itself whenever it covered the text: the
 * next open built a new component against a DOM that was complete by then. A
 * pinned one never gets that remount, so it showed "no headings found" over a
 * document full of them until it was collapsed and expanded by hand.
 */

const DOCUMENT = '<h1 id="one">One</h1><h2 id="two">Two</h2>';

function harness() {
	const body = document.createElement('div');
	const target = document.createElement('div');
	document.body.replaceChildren(body, target);

	// Mount time: the article exists and is still empty, which is exactly what
	// the component sees in the flush the preview is first patched in.
	const props = runeProps({ markdownBody: body, previewRevision: 0 });
	const component = mount(Toc, { target, props });
	flushSync();

	return {
		props,
		entries: () => Array.from(target.querySelectorAll('.toc-link')).map((el) => el.textContent!.trim()),
		stop: () => unmount(component),
	};
}

test('a document that reaches the article after the first scan still reaches the outline', () => {
	const toc = harness();
	expect(toc.entries()).toEqual([]);

	// What the patch effect does, in its order: DOM first, then say so.
	toc.props.markdownBody!.innerHTML = DOCUMENT;
	toc.props.previewRevision = 1;
	flushSync();

	expect(toc.entries()).toEqual(['One', 'Two']);
	toc.stop();
});

test('the revision is published by the patch, not by the render', () => {
	// The guard on the fix: a signal derived from the rendered string rather
	// than from the write to the DOM is the bug, spelled differently.
	const viewer = readSource('src/lib/MarkdownViewer.svelte');

	const patchEffect = viewer.slice(viewer.indexOf('const patch = patchPreviewBlocks('));
	const bump = patchEffect.indexOf('previewRevision = ++previewPatches;');
	expect(bump).toBeGreaterThan(-1);
	expect(bump).toBeLessThan(patchEffect.indexOf('\n\t});'));

	// And the outline no longer receives the document string it never read.
	const toc = readSource('src/lib/components/Toc.svelte');
	expect(/htmlContent/.test(toc.split('It used to be')[0])).toBe(false);
});
