import { beforeEach, describe, expect, test } from 'vitest';

import { patchPreviewBlocks } from '../src/lib/utils/blockPatch.js';

/**
 * Renaming a heading, which is the edit #632 could not collapse.
 *
 * comrak deduplicates heading ids by numbering them, so a document with
 * repeated headings — `## Objectives` under every section, which is what a
 * template-driven document looks like — renumbers every later duplicate when
 * one of them is renamed. Those headings really did change: the id is in the
 * markup, it is what `#anchor` links, the outline and `data-fold-key` name the
 * heading by, and no key can call them unchanged without lying about it.
 *
 * What was NOT forced is everything BETWEEN them. The changed run at that
 * level of the document is `h2, wrapper, h2, wrapper, …`, and the wrappers
 * hold the whole body of the document; the diff descended into containers from
 * each end of the run and replaced the rest of it wholesale, so one renamed
 * heading took a third of `samples/stress-test.md` with it. A renumbering adds
 * and removes no blocks, so the two runs are the same length and line up pair
 * for pair — which is all it takes to ask each pair the question the ends were
 * already being asked.
 */

let host: HTMLElement;

beforeEach(() => {
	document.body.innerHTML = '';
	host = document.createElement('div');
	document.body.appendChild(host);
});

/**
 * Sections in the shape `processMarkdownHtml` builds them, with comrak's own
 * id numbering applied to the headings.
 */
function sections(headings: string[]): string {
	const taken = new Map<string, number>();
	return headings
		.map((heading, index) => {
			const slug = heading.toLowerCase();
			const seen = taken.get(slug) ?? 0;
			taken.set(slug, seen + 1);
			const id = seen === 0 ? slug : `${slug}-${seen}`;
			const line = index * 4 + 1;
			return (
				`<h2 id="${id}" data-fold-key="${id}" data-sourcepos="${line}:1-${line}:${heading.length + 3}">${heading}</h2>` +
				'<div class="foldable-content-wrapper"><div class="content-inner">' +
				`<p data-sourcepos="${line + 2}:1-${line + 2}:6">body ${index}</p>` +
				'</div></div>'
			);
		})
		.join('');
}

const bodies = () => Array.from(host.querySelectorAll('.content-inner > p'));

describe('renaming one of many identical headings', () => {
	const before = sections(['Objectives', 'Objectives', 'Objectives', 'Objectives', 'Objectives']);
	const after = sections(['Goals', 'Objectives', 'Objectives', 'Objectives', 'Objectives']);

	test('renumbers every later heading, which is why they cannot be kept', () => {
		expect(before).toContain('id="objectives-4"');
		// Every heading's id moved up one, so all five blocks really are different
		// markup. This is the premise, not the defect.
		expect(after).toContain('id="goals"');
		expect(after).toContain('id="objectives-3"');
		expect(after).not.toContain('id="objectives-4"');
	});

	test('replaces the headings and nothing else', () => {
		patchPreviewBlocks(host, before);
		const kept = bodies();

		const patch = patchPreviewBlocks(host, after);

		expect(patch.inserted.map((element) => element.tagName)).toEqual(['H2', 'H2', 'H2', 'H2', 'H2']);
		expect(patch.replaced).toBe(5);
		// Identity, not equality: every paragraph in this document renders to the
		// same markup, so "the same node" is the only question worth asking.
		expect(bodies().every((body, index) => body === kept[index])).toBe(true);
	});

	test('leaves the wrappers holding the document in place', () => {
		patchPreviewBlocks(host, before);
		const wrappers = Array.from(host.querySelectorAll('.foldable-content-wrapper'));

		patchPreviewBlocks(host, after);

		expect(
			Array.from(host.querySelectorAll('.foldable-content-wrapper')).every(
				(wrapper, index) => wrapper === wrappers[index],
			),
		).toBe(true);
	});

	test('gives the kept blocks the new heading ids to be anchors for', () => {
		patchPreviewBlocks(host, before);
		patchPreviewBlocks(host, after);

		expect(Array.from(host.querySelectorAll('h2')).map((h) => h.id)).toEqual([
			'goals',
			'objectives',
			'objectives-1',
			'objectives-2',
			'objectives-3',
		]);
	});
});

describe('an edit that adds a block to the changed run', () => {
	test('still replaces the run, rather than pairing blocks that do not correspond', () => {
		patchPreviewBlocks(host, sections(['Alpha', 'Beta']));

		// One section became two: the runs are different lengths, so there is no
		// pairing to be had and the diff falls back to swapping the run.
		const patch = patchPreviewBlocks(host, sections(['Alpha', 'Beta', 'Gamma']));

		expect(host.querySelectorAll('h2').length).toBe(3);
		expect(Array.from(host.querySelectorAll('h2')).map((h) => h.id)).toEqual(['alpha', 'beta', 'gamma']);
		expect(patch.inserted.length).toBeGreaterThan(0);
	});
});

describe('the one-character edit #632 exists for', () => {
	test('is still one block, with the run walk in the way', () => {
		patchPreviewBlocks(host, sections(['Alpha', 'Beta', 'Gamma']));
		const kept = bodies();

		const after = sections(['Alpha', 'Beta', 'Gamma']).replace('>body 1<', '>body 1X<');
		const patch = patchPreviewBlocks(host, after);

		expect(patch.inserted.map((element) => element.textContent)).toEqual(['body 1X']);
		expect(bodies()[0]).toBe(kept[0]);
		expect(bodies()[2]).toBe(kept[2]);
	});
});
