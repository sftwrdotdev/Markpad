import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { processMarkdownHtml } from '../src/lib/utils/markdown.ts';
import { renderFixtures } from './renderProtocolFixtures.ts';
import { NODE_ELEMENT, NODE_TEXT, parseHtml, type ShimElement, type ShimNode, type ShimText, structureOf } from './renderProtocolDom.ts';
import { offsetOf, readSource } from './sourceTree.js';
import { MATH_DELIMITERS } from '../src/lib/utils/richContent.ts';
import { useShimDom } from './preview.domShim.ts';

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
describe('render protocol', () => {
	// The asset-protocol `window` the media fixtures below need; see the note above them.
	useShimDom({ window: { __TAURI_INTERNALS__: { convertFileSrc: (path: string) => `asset://localhost/${path}` } } });

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
	 * one the preview takes. `useShimDom` at the top of this describe sets it, after
	 * DOMPurify's module init has already run without a window.
	 */

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
});

/**
 * Self-checks for the fixture harness in `renderProtocolDom.ts`.
 *
 * `renderProtocol.test.ts` trusts that shim to represent what a browser would
 * hand `processMarkdownHtml`. A shim bug would otherwise turn into a silently
 * wrong contract test, so the pieces that carry the risk — the parser, the
 * serializer, the selector engine and the tree walker — are exercised here on
 * their own. If these fail, the protocol assertions mean nothing.
 */
describe('render protocol DOM shim', () => {
	useShimDom();

	test('parsing and reserializing every fixture is stable', () => {
		for (const [name, fixture] of Object.entries(renderFixtures)) {
			const once = parseHtml(fixture.html).body;
			const twice = parseHtml(once.innerHTML).body;
			assert.deepEqual(
				structureOf(twice),
				structureOf(once),
				`${name}: the shim does not round-trip the renderer's HTML`,
			);
		}
	});

	test('parsing preserves the document text exactly', () => {
		const decode = (value: string) =>
			value
				.replace(/&lt;/g, '<')
				.replace(/&gt;/g, '>')
				.replace(/&quot;/g, '"')
				.replace(/&#39;/g, "'")
				.replace(/&amp;/g, '&');

		for (const [name, fixture] of Object.entries(renderFixtures)) {
			assert.equal(
				parseHtml(fixture.html).body.textContent,
				decode(fixture.html.replace(/<[^>]*>/g, '')),
				`${name}: text was lost or invented while parsing`,
			);
		}
	});

	test('the parser keeps attributes, nesting and void elements', () => {
		const body = parseHtml(
			'<ul class="a b"><li data-sourcepos="1:1-1:9"><input type="checkbox" disabled="" /> x<br />y</li></ul>',
		).body;

		assert.deepEqual(structureOf(body), {
			tag: 'body',
			attributes: [],
			children: [
				{
					tag: 'ul',
					attributes: [['class', 'a b']],
					children: [
						{
							tag: 'li',
							attributes: [['data-sourcepos', '1:1-1:9']],
							children: [
								{
									tag: 'input',
									attributes: [
										['type', 'checkbox'],
										['disabled', ''],
									],
									children: [],
								},
								{ text: ' x' },
								{ tag: 'br', attributes: [], children: [] },
								{ text: 'y' },
							],
						},
					],
				},
			],
		});
	});

	test('the parser decodes entities in text and attributes', () => {
		const body = parseHtml('<p title="a &amp; b">1 &lt; 2 &amp;&amp; 3 &gt; 2 &#39;ok&#39;</p>').body;
		const paragraph = body.querySelectorAll('p')[0];

		assert.equal(paragraph.getAttribute('title'), 'a & b');
		assert.equal(paragraph.textContent, "1 < 2 && 3 > 2 'ok'");
		assert.equal(paragraph.innerHTML, '1 &lt; 2 &amp;&amp; 3 &gt; 2 \'ok\'');
	});

	test('the selector engine handles the shapes the render pipeline uses', () => {
		const body = parseHtml(
			'<ul><li><input type="checkbox" data-task-checkbox="" /></li></ul>' +
				'<p><input type="radio" /></p>' +
				'<h2><a class="anchor" id="x"></a>T</h2>' +
				'<div class="block-id">^one</div>',
		).body;

		assert.equal(body.querySelectorAll('li input[type="checkbox"]').length, 1);
		assert.equal(body.querySelectorAll('input[type="checkbox"]').length, 1);
		assert.equal(body.querySelectorAll('li input[data-task-checkbox]').length, 1);
		assert.equal(body.querySelectorAll('p, li').length, 2);
		assert.equal(body.querySelectorAll('h1, h2, h3, h4, h5, h6').length, 1);
		assert.equal(body.querySelectorAll('a.anchor')[0].id, 'x');
		assert.equal(body.querySelectorAll('.block-id, [data-block-id]').length, 1);

		const checkbox = body.querySelectorAll('input[type="checkbox"]')[0];
		assert.equal(checkbox.closest('li')?.tagName, 'LI');
		assert.equal(checkbox.closest('table'), null);
	});

	test('the tree walker skips rejected subtrees and yields only text', () => {
		const body = parseHtml('<p>keep<code>drop<em>drop too</em></code>tail</p>').body;
		const scope = globalThis as unknown as {
			document: {
				createTreeWalker(
					root: ShimNode,
					whatToShow: number,
					filter?: { acceptNode(node: ShimNode): number },
				): { nextNode(): ShimNode | null };
			};
			NodeFilter: { SHOW_TEXT: number; FILTER_ACCEPT: number; FILTER_REJECT: number };
		};

		const walker = scope.document.createTreeWalker(body, scope.NodeFilter.SHOW_TEXT, {
			acceptNode(node) {
				let current = node.parentElement;
				while (current && current !== body) {
					if (current.tagName === 'CODE') return scope.NodeFilter.FILTER_REJECT;
					current = current.parentElement;
				}
				return scope.NodeFilter.FILTER_ACCEPT;
			},
		});

		const seen: string[] = [];
		let node: ShimNode | null;
		while ((node = walker.nextNode())) {
			assert.equal(node.nodeType, NODE_TEXT);
			seen.push(node.textContent);
		}
		assert.deepEqual(seen, ['keep', 'tail']);
	});

	test('mutation keeps parent links and document order consistent', () => {
		const doc = parseHtml('<div><span>a</span><span>b</span><span>c</span></div>');
		const container = doc.body.querySelectorAll('div')[0];
		const [a, b, c] = container.querySelectorAll('span');

		const wrapper = doc.createElement('em');
		b.replaceWith(wrapper);
		wrapper.appendChild(b);
		assert.equal(container.innerHTML, '<span>a</span><em><span>b</span></em><span>c</span>');
		assert.equal(b.parentNode, wrapper);

		container.insertBefore(doc.createTextNode('|'), c);
		assert.equal(container.innerHTML, '<span>a</span><em><span>b</span></em>|<span>c</span>');

		a.remove();
		assert.equal(a.parentNode, null);
		assert.equal(container.childNodes.length, 3);

		container.replaceChildren(doc.createTextNode('only'));
		assert.equal(container.innerHTML, 'only');
		assert.equal(container.childNodes[0].nodeType, NODE_TEXT);

		const heading = doc.createElement('h1');
		heading.classList.add('one', 'two');
		heading.classList.remove('one');
		heading.id = 'h';
		assert.equal(heading.outerHTML, '<h1 class="two" id="h"></h1>');
		assert.equal(heading.nodeType, NODE_ELEMENT);
	});

	test('checked reflects the attribute the renderer emits', () => {
		const body = parseHtml('<input type="checkbox" checked="" /><input type="checkbox" />').body;
		const [checked, unchecked] = body.querySelectorAll('input');

		assert.equal(checked.checked, true);
		assert.equal(unchecked.checked, false);
		unchecked.checked = true;
		assert.equal(unchecked.hasAttribute('checked'), true);
	});
});

/**
 * The cross-language math-delimiter contract — frontend half.
 *
 * Correctness of the math pipeline rests on one invariant that lives in two
 * languages at once:
 *
 *     the spans `src-tauri/src/markdown.rs` hides from comrak
 *   ≡ the spans `src/lib/utils/markdown.ts` renders with KaTeX
 *
 *   backend ⊂ frontend → comrak rewrites the formula before KaTeX ever sees
 *                        it. That is issues #174, #177 and #197.
 *   backend ⊃ frontend → the text is withheld from Markdown and then rendered
 *                        by nobody; the reader gets dead text that is neither
 *                        prose nor a formula.
 *
 * Neither side is the reference. Both are asserted against one hand-authored
 * table, `mathDelimiterCorpus.json`; the Rust half is
 * `the_backend_recognises_exactly_the_math_the_contract_lists`. Loosen a
 * condition in `findInlineMathEnd` — say, drop "a closer may not be followed
 * by a digit" — and this file goes red on its own, without anyone remembering
 * that a second implementation exists.
 *
 * Nothing here re-implements the delimiter rule. The frontend's decision is
 * read back only from artefacts the frontend itself produces: `\(…\)` and
 * `\[…\]`, which only `convertInlineMathDelimiters` emits, and
 * `data-math-source`, which only `processDisplayMathBlocks` sets. An extractor
 * that parsed `$…$` on its own could agree with a broken implementation, which
 * would defeat the point.
 *
 * Reading artefacts is only equal to reading what the *reader* sees while those
 * three are the whole of it. They were not: KaTeX's auto-renderer was also
 * given `$$` and so rendered same-line `$$…$$` straight out of comrak's output,
 * a fourth channel this extractor could not see and the corpus documented as a
 * KNOWN GAP. `\$\$x\$\$` — an escape, i.e. the reader saying "not a formula" —
 * went through it and was typeset. The last test in this file is what keeps
 * that channel closed.
 */
describe('math delimiter contract', () => {
	useShimDom({ window: globalThis });

	type ContractSpan = { kind: 'inline' | 'display'; source: string };

	type ContractCase = {
		name: string;
		markdown: string;
		/** Real `convert_markdown` output; kept live by the Rust half. */
		html: string;
		math: ContractSpan[];
	};

	const corpus: { cases: ContractCase[] } = JSON.parse(
		readSource(new URL('./mathDelimiterCorpus.json', import.meta.url)),
	);

	const FILE_PATH = '/documents/notes.md';

	/**
	 * Only `convertInlineMathDelimiters` ever writes `\(`…`\)` or `\[`…`\]` into a
	 * text node; CommonMark resolves a user-typed one away long before here.
	 */
	const MATH_ARTEFACT_RE = /\\\(([\s\S]*?)\\\)|\\\[([\s\S]*?)\\\]/g;

	/** What the frontend decided, in document order, in the corpus's vocabulary. */
	function recognisedMath(body: ShimElement): ContractSpan[] {
		const found: ContractSpan[] = [];

		const visit = (node: ShimNode): void => {
			if (node.nodeType === NODE_ELEMENT) {
				const element = node as ShimElement;
				if (element.getAttribute('data-math') === 'display') {
					found.push({ kind: 'display', source: element.getAttribute('data-math-source') ?? '' });
					return;
				}
				for (const child of [...element.childNodes]) visit(child);
				return;
			}
			if (node.nodeType === NODE_TEXT) {
				const text = (node as ShimText).nodeValue ?? '';
				MATH_ARTEFACT_RE.lastIndex = 0;
				let match: RegExpExecArray | null;
				while ((match = MATH_ARTEFACT_RE.exec(text)) !== null) {
					found.push(
						match[1] !== undefined
							? { kind: 'inline', source: match[1] }
							: { kind: 'display', source: match[2] },
					);
				}
			}
		};

		for (const child of [...body.childNodes]) visit(child);
		return found;
	}

	test('the frontend renders exactly the math the contract lists', () => {
		for (const testCase of corpus.cases) {
			const body = parseHtml(processMarkdownHtml(testCase.html, FILE_PATH, new Set())).body;
			assert.deepEqual(
				recognisedMath(body),
				testCase.math,
				`${testCase.name}: the frontend and the contract disagree about what is math\n` +
					`  input: ${JSON.stringify(testCase.markdown)}`,
			);
		}
	});

	test('the corpus covers both directions of the invariant', () => {
		// A corpus of nothing but negatives would stay green under an
		// implementation that recognises no math at all, and a corpus of nothing
		// but positives would stay green under one that recognises everything.
		const negatives = corpus.cases.filter((one) => one.math.length === 0);
		const positives = corpus.cases.filter((one) => one.math.length > 0);
		assert.ok(negatives.length >= 10, `only ${negatives.length} must-not-be-math cases`);
		assert.ok(positives.length >= 10, `only ${positives.length} must-be-math cases`);
		assert.ok(
			positives.some((one) => one.math.some((span) => span.kind === 'display')),
			'no display-math case',
		);
		assert.ok(
			positives.some((one) => one.math.some((span) => span.kind === 'inline')),
			'no inline-math case',
		);
	});

	test('KaTeX is given no delimiter that Markdown itself can spell', () => {
		// The test above reads the frontend's decision off the artefacts
		// `processMarkdownHtml` mints. That is only the same thing as "what the
		// reader sees" while KaTeX's auto-renderer looks for nothing else. Give it
		// `$$` back and same-line `$$…$$` is rendered straight out of comrak's
		// output — including the `$$` that comrak produced *by resolving the
		// reader's `\$\$`* — through a channel the extractor cannot see and the
		// contract therefore cannot police.
		assert.ok(MATH_DELIMITERS.length > 0, 'no delimiters at all');
		for (const delimiter of MATH_DELIMITERS) {
			for (const side of [delimiter.left, delimiter.right]) {
				assert.ok(
					side.startsWith('\\'),
					`KaTeX may only be given delimiters processMarkdownHtml mints, not ${JSON.stringify(side)}`,
				);
			}
		}
	});

	test('a display block inside a paragraph leaves the prose around it as prose', () => {
		const testCase = corpus.cases.find((one) => one.name === 'a display block between lines of prose')!;
		const body = parseHtml(processMarkdownHtml(testCase.html, FILE_PATH, new Set())).body;
		const paragraph = body.querySelector('p')!;
		assert.equal(paragraph.querySelector('[data-math]')?.getAttribute('data-math-source'), 'x^2');
		assert.match(paragraph.textContent, /^The formula\s+x\^2\s+is nice\.$/);
	});
});
