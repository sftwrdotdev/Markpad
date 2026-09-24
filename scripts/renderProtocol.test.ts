/**
 * Render protocol contract: Markdown → `convert_markdown` HTML →
 * `processMarkdownHtml` DOM.
 *
 * Every assertion here runs the real `processMarkdownHtml` over real
 * `convert_markdown` output (see `renderProtocolFixtures.ts` for provenance)
 * and inspects the resulting DOM. Nothing in this file asserts on the *text*
 * of an implementation file, which is the point: renaming a helper or moving a
 * statement must not turn these red, and changing what the preview actually
 * produces must.
 *
 * The five protocols covered are the ones that have already regressed:
 *   1. task-list markers and source positions (checkbox click → source line)
 *   2. `$$…$$` underscore protection (issue #174)
 *   3. heading ids and fold anchors (#371)
 *   4. raw HTML checkboxes are not markdown tasks (#319)
 *   5. media substitutions keep the source range of the markup they replaced
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { installShimDom, parseHtml, type ShimElement } from './renderProtocolDom.ts';
import { offsetOf } from './sourceTree.js';

installShimDom();

const { processMarkdownHtml } = await import('../src/lib/utils/markdown.ts');
const { renderFixtures } = await import('./renderProtocolFixtures.ts');

type FixtureName = keyof typeof renderFixtures;

const FILE_PATH = '/documents/notes.md';

function render(name: FixtureName, collapsedHeaders: Set<string> = new Set()) {
	const html = processMarkdownHtml(renderFixtures[name].html, FILE_PATH, collapsedHeaders);
	return parseHtml(html).body;
}

/**
 * `src-tauri`'s `TASK_SOURCE_RE`, restated over the fixture's own Markdown so
 * the expected line numbers are derived from the source document rather than
 * copied out of the HTML they are supposed to validate.
 */
const TASK_SOURCE_RE = /^\s*(?:>\s*)*(?:[-+*]|\d+[.)])\s+\[[ xX]\](?:\s|$)/;
const TASK_PREFIX_RE = /^\s*(?:>\s*)*(?:[-+*]|\d+[.)])\s+\[[ xX]\]\s*/;

type SourceTask = { line: number; checked: boolean; text: string };

/** Rust's `str::lines()`: split on `\n`, drop one trailing `\r`. */
function sourceTasks(markdown: string): SourceTask[] {
	return markdown
		.split('\n')
		.map((line) => line.replace(/\r$/, ''))
		.flatMap((line, index) =>
			TASK_SOURCE_RE.test(line)
				? [
						{
							line: index + 1,
							checked: /\[[xX]\]/.test(line),
							text: line.replace(TASK_PREFIX_RE, ''),
						},
					]
				: [],
		);
}

/**
 * The rule `MarkdownViewer.toggleTaskCheckbox` applies to decide which source
 * line a click rewrites: first number of the enclosing `li`'s `data-sourcepos`.
 */
function clickedSourceLine(checkbox: ShimElement): number {
	const sourcePosition = checkbox.closest('li')?.getAttribute('data-sourcepos');
	return Number(sourcePosition?.match(/^(\d+):/)?.[1]);
}

function interactiveCheckboxes(root: ShimElement): ShimElement[] {
	return root.querySelectorAll('li input[data-task-checkbox]');
}

const TASK_FIXTURES = [
	'taskSimple',
	'taskNested',
	'taskQuoted',
	'taskOrdered',
	'taskSurrounded',
	'taskCrlf',
	'taskLoose',
	'taskContinuation',
	'taskParenOrdered',
	'taskStarPlus',
	'taskTextAfterBlock',
] as const satisfies readonly FixtureName[];

// --- protocol 1: task markers and source positions -----------------------

test('every rendered task checkbox resolves to its own Markdown task line', () => {
	for (const name of TASK_FIXTURES) {
		const body = render(name);
		const expected = sourceTasks(renderFixtures[name].markdown);
		const checkboxes = interactiveCheckboxes(body);

		assert.equal(
			checkboxes.length,
			expected.length,
			`${name}: rendered ${checkboxes.length} interactive checkboxes for ${expected.length} source tasks`,
		);

		const seen = checkboxes.map(clickedSourceLine);
		assert.deepEqual(
			[...seen].sort((a, b) => a - b),
			expected.map((task) => task.line),
			`${name}: checkbox → source line mapping drifted`,
		);
		assert.equal(new Set(seen).size, seen.length, `${name}: two checkboxes claim one source line`);

		for (const checkbox of checkboxes) {
			const line = clickedSourceLine(checkbox);
			const task = expected.find((candidate) => candidate.line === line);
			assert.ok(task, `${name}: checkbox mapped to non-task line ${line}`);
			assert.equal(
				checkbox.checked,
				task.checked,
				`${name}: line ${line} checked state disagrees with the source marker`,
			);
		}
	}
});

test('task text is lifted into span.task-text next to the checkbox', () => {
	for (const name of TASK_FIXTURES) {
		const body = render(name);
		for (const checkbox of interactiveCheckboxes(body)) {
			const li = checkbox.closest('li');
			assert.ok(li, `${name}: checkbox escaped its list item`);
			assert.equal(
				li.childNodes[0],
				checkbox,
				`${name}: the checkbox is no longer the first child of its li`,
			);

			const label = li.querySelectorAll('span.task-text')[0];
			assert.ok(label, `${name}: no span.task-text was produced`);

			const line = clickedSourceLine(checkbox);
			const task = sourceTasks(renderFixtures[name].markdown).find(
				(candidate) => candidate.line === line,
			);
			assert.ok(task);
			assert.ok(
				label.textContent.trim().startsWith(task.text.trim()),
				`${name}: task text ${JSON.stringify(label.textContent)} does not start with the source text ${JSON.stringify(task.text)}`,
			);
		}
	}
});

test('task checkboxes are made clickable and checked ones mark their item', () => {
	for (const name of TASK_FIXTURES) {
		const body = render(name);
		for (const checkbox of interactiveCheckboxes(body)) {
			assert.equal(
				checkbox.hasAttribute('disabled'),
				false,
				`${name}: a task checkbox stayed disabled and cannot be clicked`,
			);
			assert.equal(checkbox.style.cursor, 'pointer', `${name}: task checkbox lost its cursor`);

			const li = checkbox.closest('li');
			assert.ok(li);
			assert.equal(
				li.classList.contains('task-done'),
				checkbox.checked,
				`${name}: task-done disagrees with the checkbox state`,
			);
			// Fifteen rules in styles.css name this class — the bullet
			// suppression and the grid that puts the checkbox beside its text.
			// comrak writes it only on the branch where it opens the `<li>`
			// itself, which a plain task item does not take, so without this
			// the list loses its bullet and keeps the checkbox on its own line.
			assert.ok(
				li.classList.contains('task-list-item'),
				`${name}: the item class the stylesheet needs is missing`,
			);
		}
	}
});

test('a nested task keeps its own source line and stays out of the parent label', () => {
	const body = render('taskNested');
	const [parent, nested] = interactiveCheckboxes(body);

	assert.equal(clickedSourceLine(parent), 1);
	assert.equal(clickedSourceLine(nested), 2);
	assert.equal(nested.closest('li')?.closest('ul')?.closest('li'), parent.closest('li'));

	const parentLabel = parent.closest('li')?.querySelectorAll('span.task-text')[0];
	assert.equal(parentLabel?.textContent.trim(), 'parent');
	assert.equal(parentLabel?.querySelectorAll('input').length, 0);
});

test('text after a block inside a tight task item is task text, not a bare grid item', () => {
	// #832: a bare text node of the grid `<li>` is placed in the 15px checkbox
	// column, and the preview wrapped it one letter per line.
	const li = interactiveCheckboxes(render('taskTextAfterBlock'))[0].closest('li');
	assert.ok(li);

	const bare = Array.from(li.childNodes).filter(
		(n) => n.nodeType === 3 && n.textContent?.trim(),
	);
	assert.deepEqual(bare.map((n) => n.textContent), []);

	const labels = li.querySelectorAll('span.task-text');
	assert.equal(labels.length, 2);
	assert.equal(labels[0].textContent.trim(), 'task');
	assert.equal(labels[1].textContent, 'then check it');
	assert.equal(labels[1].querySelectorAll('strong').length, 1);
});

test('a task inside a block quote still reports the quoted source line', () => {
	const body = render('taskQuoted');
	const [checkbox] = interactiveCheckboxes(body);

	assert.ok(checkbox.closest('blockquote'), 'the quoted task left its block quote');
	assert.equal(clickedSourceLine(checkbox), 1);
});

test('CRLF documents report the same source lines as LF documents', () => {
	const crlf = interactiveCheckboxes(render('taskCrlf')).map(clickedSourceLine);
	const lf = interactiveCheckboxes(render('taskSimple')).map(clickedSourceLine);

	assert.deepEqual(crlf, [1, 2]);
	assert.deepEqual(crlf, lf);
});

test('prose before a task does not shift the reported source line', () => {
	const lines = interactiveCheckboxes(render('taskSurrounded')).map(clickedSourceLine);

	// `- [ ] after prose` is line 5 and `- [x] after blank` is line 9 of the
	// fixture Markdown; heading folding must not renumber them.
	assert.deepEqual(lines, [5, 9]);
});

// --- protocol 2: $$…$$ underscore protection (issue #174) ----------------

const DISPLAY_MATH_FIXTURES = [
	'mathBracedSubscripts',
	'mathPlainSubscripts',
	'mathBlockOwnLines',
	'mathEscapedUnderscore',
	'mathInsideListItem',
] as const satisfies readonly FixtureName[];

/** The text between the outermost `$$` pair of a fixture's Markdown. */
function displayMathSource(markdown: string): string {
	const open = offsetOf(markdown, '$$');
	const close = markdown.lastIndexOf('$$');
	assert.notEqual(close, open, 'a display-math fixture must close its $$ pair');
	return markdown.slice(open + 2, close).trim();
}

test('display math reaches KaTeX with its underscores intact', () => {
	for (const name of DISPLAY_MATH_FIXTURES) {
		const body = render(name);
		const math = body.querySelectorAll('[data-math]');

		assert.equal(math.length, 1, `${name}: expected exactly one display-math element`);
		assert.equal(math[0].getAttribute('data-math'), 'display', `${name}: wrong math mode`);

		const expected = displayMathSource(renderFixtures[name].markdown);
		assert.equal(
			math[0].getAttribute('data-math-source'),
			expected,
			`${name}: data-math-source drifted from the Markdown between the $$ delimiters`,
		);
		assert.equal(
			math[0].textContent,
			expected,
			`${name}: the rendered text no longer matches the math source`,
		);
		// The underscore count used to be compared here as well, between
		// `data-math-source` and `expected` — two strings the assertion above
		// has already established are equal. It could only pass when it ran,
		// and it only ran when the assertion that dominates it had passed.
	}
});

test('paired underscores inside display math never become emphasis', () => {
	for (const name of DISPLAY_MATH_FIXTURES) {
		const body = render(name);
		assert.equal(
			body.querySelectorAll('em').length,
			0,
			`${name}: the renderer turned math subscripts into <em>, which breaks the KaTeX source`,
		);
		assert.equal(body.querySelectorAll('strong').length, 0, `${name}: unexpected <strong>`);
	}
});

test('display math on its own lines is joined without the hard line breaks', () => {
	const body = render('mathBlockOwnLines');
	const math = body.querySelectorAll('[data-math]')[0];

	assert.equal(math.getAttribute('data-math-source'), 'a_i = b_i + c_i');
	assert.equal(math.querySelectorAll('br').length, 0, 'hard breaks leaked into the math source');
});

test('math mixed with prose becomes a same-line display span, not a math block', () => {
	// Two `$$` spans in a paragraph that also carries text: the block form does
	// not apply, but the underscores still have to survive, and each span still
	// has to reach KaTeX. It reaches it as `\[…\]` — a spelling only this
	// function mints — because the auto-renderer is deliberately given no
	// `$`-based delimiter; see MATH_DELIMITERS in src/lib/utils/richContent.ts
	// and scripts/mathDelimiterContract.test.ts.
	const mixed = render('mathTwoBlocksOneLine');
	assert.equal(mixed.querySelectorAll('[data-math]').length, 0);
	assert.equal(mixed.querySelectorAll('em').length, 0);
	assert.equal(mixed.textContent.trim(), 'before \\[a_1\\] middle \\[b_2\\] after');

	const withEmphasis = render('mathEmphasisOutsideStillWorks');
	assert.deepEqual(
		withEmphasis.querySelectorAll('em').map((element) => element.textContent),
		['emphasis', 'more'],
		'emphasis outside display math must keep working',
	);
	assert.ok(
		withEmphasis.textContent.includes('\\[p_1 + q_2\\]'),
		'underscores inside display math were emphasised away',
	);
});

// --- protocol 3: heading ids and fold anchors (#371) ---------------------

const HEADING_FIXTURES = [
	'headingPunctuation',
	'headingDuplicates',
	'headingChinese',
	'headingNumericDot',
	'headingApostrophe',
	'headingUnderscore',
	'headingNesting',
	'taskSurrounded',
] as const satisfies readonly FixtureName[];

const HEADING_SELECTOR = 'h1, h2, h3, h4, h5, h6';

/**
 * The id comrak assigned to each heading, read from wherever comrak put it.
 *
 * comrak 0.18 put it on the empty inner `a.anchor`, which is why
 * `processMarkdownHtml` promotes it onto the heading at all. comrak 0.54 puts
 * it on the heading itself and leaves the anchor bare, so the promotion is now
 * a no-op — but the invariant this test exists for is unchanged and is not
 * about which element the renderer chose: the heading ends up carrying the id,
 * and the anchor does not. Reading both keeps that assertion a live capture
 * rather than a copy of one renderer's layout.
 */
function rendererHeadingIds(name: FixtureName): string[] {
	return parseHtml(renderFixtures[name].html)
		.body.querySelectorAll(HEADING_SELECTOR)
		.map((heading) => heading.id || (heading.querySelectorAll('a.anchor')[0]?.id ?? ''));
}

test("each heading adopts comrak's anchor id and leaves the anchor without one", () => {
	for (const name of HEADING_FIXTURES) {
		const body = render(name);
		const headings = body.querySelectorAll(HEADING_SELECTOR);
		const expected = rendererHeadingIds(name);

		assert.equal(headings.length, expected.length, `${name}: heading count changed`);
		assert.deepEqual(
			headings.map((heading) => heading.id),
			expected,
			`${name}: heading ids no longer match the ids comrak rendered`,
		);

		for (const heading of headings) {
			const anchor = heading.querySelectorAll('a.anchor')[0];
			assert.ok(anchor, `${name}: comrak's anchor disappeared`);
			assert.equal(
				anchor.hasAttribute('id'),
				false,
				`${name}: the id is duplicated on the heading and its anchor`,
			);
		}

		const ids = body.querySelectorAll('[id]').map((element) => element.id);
		assert.equal(new Set(ids).size, ids.length, `${name}: duplicate ids in the rendered document`);
	}
});

test('anchorized heading ids are pinned for punctuation, duplicates and Chinese', () => {
	// These values come from comrak's own `Anchorizer` (#371). They are pinned
	// here so a regenerated fixture cannot quietly change the link targets that
	// wikilinks and the table of contents resolve against.
	const expected: Partial<Record<FixtureName, string[]>> = {
		headingPunctuation: ['hello-world'],
		headingDuplicates: ['title', 'title-1', 'title-2'],
		headingChinese: ['中文标题'],
		headingNumericDot: ['1-概述'],
		headingApostrophe: ['ticks-arent-in'],
		headingUnderscore: ['under_score-here'],
	};

	for (const [name, ids] of Object.entries(expected)) {
		assert.deepEqual(
			render(name as FixtureName)
				.querySelectorAll(HEADING_SELECTOR)
				.map((heading) => heading.id),
			ids,
			`${name}: heading anchor ids drifted`,
		);
	}
});

test('every heading gets a fold chevron and owns the wrapper it points at', () => {
	for (const name of HEADING_FIXTURES) {
		const body = render(name);
		for (const heading of body.querySelectorAll(HEADING_SELECTOR)) {
			assert.ok(heading.classList.contains('foldable-header'), `${name}: heading is not foldable`);
			assert.equal(
				heading.childNodes[0],
				heading.querySelectorAll('span.header-fold-icon')[0],
				`${name}: the fold chevron is not the heading's first child`,
			);

			const target = heading.getAttribute('data-fold-target');
			assert.ok(target, `${name}: heading has no data-fold-target`);

			const wrapper = heading.nextElementSibling;
			assert.ok(wrapper, `${name}: heading has no following wrapper`);
			assert.ok(
				wrapper.classList.contains('foldable-content-wrapper'),
				`${name}: the sibling after the heading is not the fold wrapper`,
			);
			assert.equal(wrapper.id, target, `${name}: data-fold-target does not address the wrapper`);
			assert.ok(
				wrapper.querySelectorAll('div.content-inner')[0],
				`${name}: the fold wrapper has no content-inner`,
			);
		}
	}
});

test('a deeper heading is folded inside its parent, a sibling heading is not', () => {
	const body = render('headingNesting');
	const [a, b, c] = body.querySelectorAll(HEADING_SELECTOR);

	assert.deepEqual([a.id, b.id, c.id], ['a', 'b', 'c']);
	assert.equal(
		b.closest('div.foldable-content-wrapper')?.id,
		a.getAttribute('data-fold-target'),
		'the h2 must live inside the h1 fold wrapper',
	);
	assert.equal(
		c.closest('div.foldable-content-wrapper'),
		null,
		'a sibling h1 must not be folded into the previous section',
	);
	assert.equal(
		a.nextElementSibling?.textContent.includes('body b'),
		true,
		'the h1 wrapper must carry the nested section body',
	);
});

test('collapsed state is keyed by heading id, so duplicate titles fold apart', () => {
	// The heading id is promoted off comrak's anchor precisely so this key can
	// tell "Title", "Title" and "Title" apart. Keying by text would collapse
	// all three (or none) instead of the second one.
	const body = render('headingDuplicates', new Set(['title-1']));
	const headings = body.querySelectorAll(HEADING_SELECTOR);

	assert.deepEqual(
		headings.map((heading) => heading.classList.contains('is-collapsed')),
		[false, true, false],
		'the collapsed heading is not the one keyed by id',
	);
	assert.deepEqual(
		headings.map((heading) => heading.nextElementSibling?.classList.contains('is-collapsed')),
		[false, true, false],
		'the collapsed wrapper does not follow its heading',
	);
});

// --- protocol 4: raw HTML checkboxes (#319) ------------------------------

const RAW_CHECKBOX_FIXTURES = [
	'rawCheckboxListItem',
	'rawCheckboxDisabled',
	'rawCheckboxHtmlList',
	'rawCheckboxMixedWithTask',
	'rawCheckboxParagraph',
] as const satisfies readonly FixtureName[];

test('a hand-written checkbox is never treated as a Markdown task', () => {
	for (const name of RAW_CHECKBOX_FIXTURES) {
		const body = render(name);
		const rendererTasks = sourceTasks(renderFixtures[name].markdown).length;

		assert.equal(
			interactiveCheckboxes(body).length,
			rendererTasks,
			`${name}: raw HTML controls were promoted to clickable tasks`,
		);

		for (const checkbox of body.querySelectorAll('input[type="checkbox"]')) {
			if (checkbox.hasAttribute('data-task-checkbox')) continue;
			assert.equal(
				checkbox.closest('li') === null || checkbox.hasAttribute('disabled'),
				true,
				`${name}: a raw checkbox inside a list item stayed clickable`,
			);
			assert.equal(
				checkbox.closest('li')?.classList.contains('task-done') ?? false,
				false,
				`${name}: a raw checkbox marked its list item done`,
			);
			assert.equal(
				checkbox.closest('li')?.querySelectorAll('span.task-text').length ?? 0,
				0,
				`${name}: a raw checkbox got task-text treatment`,
			);
		}
	}
});

test('a raw checkbox indistinguishable by markup is separated by the source line', () => {
	// `- <input type="checkbox" disabled="" /> …` renders byte-identically to a
	// real `- [ ]` item apart from the marker attribute the Rust side adds only
	// when the source line really is a task.
	const body = render('rawCheckboxDisabled');
	const [checkbox] = body.querySelectorAll('input[type="checkbox"]');

	assert.equal(checkbox.hasAttribute('data-task-checkbox'), false);
	assert.equal(checkbox.hasAttribute('disabled'), true);
	assert.equal(interactiveCheckboxes(body).length, 0);
});

test('a raw checkbox next to a real task cannot rewrite the task line', () => {
	const body = render('rawCheckboxMixedWithTask');
	const checkboxes = body.querySelectorAll('input[type="checkbox"]');

	assert.equal(checkboxes.length, 2);
	assert.deepEqual(
		checkboxes.map((checkbox) => checkbox.hasAttribute('data-task-checkbox')),
		[true, false],
	);
	assert.equal(clickedSourceLine(checkboxes[0]), 1);
	assert.equal(checkboxes[1].hasAttribute('disabled'), true);
});

test('a raw HTML list has no source position for a click to resolve', () => {
	const body = render('rawCheckboxHtmlList');
	const [checkbox] = body.querySelectorAll('input[type="checkbox"]');

	assert.equal(checkbox.closest('li')?.hasAttribute('data-sourcepos'), false);
	assert.equal(Number.isInteger(clickedSourceLine(checkbox)), false);
});

test('a checkbox outside a list item is left alone by the task pass', () => {
	const body = render('rawCheckboxParagraph');
	const [checkbox] = body.querySelectorAll('input[type="checkbox"]');

	assert.equal(checkbox.closest('li'), null);
	assert.equal(checkbox.hasAttribute('data-task-checkbox'), false);
	assert.equal(checkbox.closest('p')?.textContent.trim(), 'A paragraph with  inline.');
});

// --- protocol 5: media substitutions keep their source range -------------

/**
 * `processMarkdownHtml` does not restyle a media `<img>`, it *replaces* it: an
 * `.mp4`/`.mp3` src becomes a freshly created `<video>`/`<audio>`, a YouTube
 * src becomes a thumbnail `<a>`. A fresh element starts with no attributes, so
 * unless the source range is carried across, the tallest thing in the preview
 * is the one element that maps to no source line — the same defect
 * `carrySourcepos` was written for on Mermaid diagrams. Both halves of scroll
 * sync then attribute the player's pixels to whichever neighbouring block is
 * nearest, and the panes disagree by its height for as long as it is on
 * screen; "edit what I right-clicked" degrades to the enclosing paragraph.
 */
/**
 * A local media src is rewritten through Tauri's asset protocol, which lives
 * on `window`. Without it the rewrite throws into `processMarkdownHtml`'s own
 * catch and these fixtures would exercise the fallback path instead of the
 * one the preview takes. Set after the imports above so DOMPurify's module
 * init still sees no window.
 */
(globalThis as unknown as Record<string, unknown>).window = {
	__TAURI_INTERNALS__: { convertFileSrc: (path: string) => `asset://localhost/${path}` },
};

const MEDIA_FIXTURES = [
	{ name: 'videoImage', selector: 'video' },
	{ name: 'audioImage', selector: 'audio' },
	{ name: 'youtubeImage', selector: 'a.youtube-link' },
	{ name: 'youtubeLink', selector: 'a.youtube-link' },
] as const satisfies readonly { name: FixtureName; selector: string }[];

/** The range comrak put on the element the substitution consumed. */
function rendererSourcepos(name: FixtureName): string {
	const source = parseHtml(renderFixtures[name].html).body.querySelector('img, p a');
	return source?.getAttribute('data-sourcepos') ?? '';
}

test('a media element inherits the source range of the markup it replaced', () => {
	for (const { name, selector } of MEDIA_FIXTURES) {
		const [media] = render(name).querySelectorAll(selector);
		assert.ok(media, `${name}: no ${selector} was produced`);

		const expected = rendererSourcepos(name);
		assert.match(expected, /^\d+:\d+-\d+:\d+$/, `${name}: fixture lost its source range`);
		assert.equal(
			media.getAttribute('data-sourcepos'),
			expected,
			`${name}: the replacement maps to no source line, so scroll sync has to guess`,
		);
	}
});

test('a replaced video reports the line it was written on, not the first one', () => {
	const [video] = render('videoImageSurrounded').querySelectorAll('video');

	assert.equal(video.getAttribute('data-sourcepos'), '3:1-3:17');
});
