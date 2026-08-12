import assert from 'node:assert/strict';
import test from 'node:test';

import { installShimDom, parseHtml, type ShimElement } from './renderProtocolDom.ts';

installShimDom();

const { processMarkdownHtml } = await import('../src/lib/utils/markdown.ts');
const { foldKeyOf } = await import('../src/lib/utils/foldState.ts');

// Fold state is keyed by `h.id || textContent`. comrak emits the deduplicated
// heading id ("setup", "setup-1", …) on an empty inner <a class="anchor">, not
// on the heading element, so without promotion every consumer falls back to
// heading text: two sections both called "Setup" share one fold state, and the
// ToC's id-based keys never match the preview's text-based ones.
//
// This used to be asserted by matching `/h\.id = \w+\.id/` against
// markdown.ts. That pins a spelling rather than the behaviour — it goes red on
// a rename that breaks nothing, and stays green if the promotion runs but the
// ids collide. The document below has the collision in it, so the check is now
// what the feature exists for: does collapsing the first "Setup" leave the
// second one open.

/** The shape comrak emits for two sections that share a title. */
const DUPLICATE_TITLES = [
	'<h2><a href="#setup" aria-hidden="true" class="anchor" id="setup"></a>Setup</h2>',
	'<p>first body</p>',
	'<h2><a href="#setup-1" aria-hidden="true" class="anchor" id="setup-1"></a>Setup</h2>',
	'<p>second body</p>',
].join('\n');

function headings(html: string): ShimElement[] {
	return parseHtml(html).querySelectorAll('h2') as unknown as ShimElement[];
}

/** The fold wrapper `heading` opens and closes, found by its `data-fold-target`. */
function wrapperFor(root: ReturnType<typeof parseHtml>, heading: ShimElement): ShimElement {
	const id = heading.getAttribute('data-fold-target');
	assert.ok(id, 'every foldable header points at its wrapper');
	const wrapper = root.querySelector(`#${id}`) as unknown as ShimElement | null;
	assert.ok(wrapper, `wrapper ${id} exists`);
	return wrapper;
}

test('the comrak anchor id is promoted onto the heading, and left nowhere else', () => {
	const [first, second] = headings(processMarkdownHtml(DUPLICATE_TITLES, '/doc.md', new Set()));

	assert.equal(first.getAttribute('id'), 'setup');
	assert.equal(second.getAttribute('id'), 'setup-1');

	// Not merely "an id is set": the ids must still be unique afterwards, which
	// is why the anchor gives its own up rather than sharing it.
	for (const heading of [first, second]) {
		const anchor = heading.querySelector('a.anchor') as unknown as ShimElement | null;
		assert.ok(anchor, 'the comrak anchor survives');
		assert.equal(anchor.getAttribute('id'), null, 'the anchor no longer carries the id');
	}
});

test('collapsing one of two sections that share a title leaves the other open', () => {
	// The defect this file exists for. Keyed by text, `new Set(['setup'])` would
	// match both headings and collapse the whole document.
	const root = parseHtml(processMarkdownHtml(DUPLICATE_TITLES, '/doc.md', new Set(['setup'])));
	const [first, second] = root.querySelectorAll('h2') as unknown as ShimElement[];

	assert.ok(first.classList.contains('is-collapsed'), 'the collapsed heading is the one in the set');
	assert.ok(wrapperFor(root, first).classList.contains('is-collapsed'), 'its content is hidden');

	assert.ok(!second.classList.contains('is-collapsed'), 'the same-titled sibling stays open');
	assert.ok(!wrapperFor(root, second).classList.contains('is-collapsed'), 'its content stays visible');
});

test('a heading that already carries an id keeps it', () => {
	// The promotion is guarded by `!h.id`. Raw HTML in the document can set one,
	// and overwriting it would break the anchor links pointing at it.
	const html = processMarkdownHtml(
		'<h2 id="hand-written"><a href="#auto" aria-hidden="true" class="anchor" id="auto"></a>Title</h2>',
		'/doc.md',
		new Set(),
	);
	const [heading] = headings(html);
	assert.equal(heading.getAttribute('id'), 'hand-written');
});

// This used to be a source-shape assertion — the preview and the outline were
// each grepped for their own copy of `id || textContent`, because the two
// consumers live in Svelte components this runner cannot import. That is the
// wrong shape of check for a rule about agreement: three spellings of one
// expression pass it happily, right up until one of them is edited.
//
// There is one spelling now. `assignFoldKey` computes the key while the markup
// is built and leaves it on the element, so every consumer reads the answer
// instead of recomputing it, and this file can check the producer by running it.

test('the key a fold is stored under is written onto the markup', () => {
	const root = parseHtml(processMarkdownHtml(DUPLICATE_TITLES, '/doc.md', new Set()));
	const [first, second] = root.querySelectorAll('h2') as unknown as ShimElement[];

	assert.equal(foldKeyOf(first as unknown as Element), 'setup');
	assert.equal(foldKeyOf(second as unknown as Element), 'setup-1', 'the deduplicated id, not the shared text');
});

test('a foldable callout is named too, and two with the same title fold apart', () => {
	// Callouts have no id and no slug, so before they were keyed at all their
	// fold state had nowhere to live — the title toggled two classes and the
	// next render put them back. Keyed by title, in a namespace of their own.
	const html = processMarkdownHtml(
		[
			'<blockquote><p>[!note]- Details<br>first body</p></blockquote>',
			'<blockquote><p>[!note]- Details<br>second body</p></blockquote>',
		].join('\n'),
		'/doc.md',
		new Set(['callout:Details']),
	);
	const root = parseHtml(html);
	const [first, second] = root.querySelectorAll('.callout-foldable') as unknown as ShimElement[];

	assert.equal(foldKeyOf(first as unknown as Element), 'callout:Details');
	assert.equal(foldKeyOf(second as unknown as Element), 'callout:Details~1');

	// `[!note]-` opens folded, and the set holds the folds the reader flipped —
	// so the first callout, whose key is in the set, is the OPEN one.
	assert.equal(first.classList.contains('is-collapsed'), false, 'the flipped callout is open');
	assert.equal(second.classList.contains('is-collapsed'), true, 'its same-titled sibling keeps the source default');
});

test('a callout key cannot collide with a heading that reads the same', () => {
	const root = parseHtml(
		processMarkdownHtml(
			'<h2>Details</h2>\n<blockquote><p>[!note]+ Details<br>body</p></blockquote>',
			'/doc.md',
			new Set(),
		),
	);
	const heading = root.querySelector('h2') as unknown as ShimElement;
	const callout = root.querySelector('.callout-foldable') as unknown as ShimElement;

	assert.equal(foldKeyOf(heading as unknown as Element), 'Details');
	assert.equal(foldKeyOf(callout as unknown as Element), 'callout:Details');
});
