import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
	DEFAULT_EDITOR_TOOLBAR_ORDER,
	INLINE_WRAP_TOOL_IDS,
	LINE_MARKER_TOOL_IDS,
	getEditorToolbarAdjacentMove,
	getEditorToolbarReorderMove,
	getEditorToolbarTools,
	getVisibleEditorToolbarTools,
	normalizeEditorToolbarHidden,
	normalizeEditorToolbarOrder,
	toggleInlineWrap,
	toggleLineMarker,
	type InlineWrapToolId,
	type LineMarkerToolId,
} from '../src/lib/utils/editorToolbar.js';

/**
 * `DEFAULT_EDITOR_TOOLBAR_ORDER` is `EDITOR_TOOLBAR_TOOLS.map((tool) => tool.id)`,
 * so an expected value written in terms of it says nothing about what is in the
 * catalogue: deleting the Underline tool outright left every assertion in this
 * file green. The two tests below are the ones that hold the catalogue still —
 * the same job `titlebarToolbar.test.ts` does with its literal id lists — and
 * the derived expectations above are then free to describe the *reordering*,
 * which is what they are actually about.
 */
test('the default order is the whole tool catalogue, in the order the toolbar renders it', () => {
	assert.deepEqual(DEFAULT_EDITOR_TOOLBAR_ORDER, [
		'fmt-bold',
		'fmt-italic',
		'fmt-underline',
		'fmt-strikethrough',
		'fmt-inline-code',
		'fmt-code-block',
		'fmt-quote',
		'fmt-heading-1',
		'fmt-heading-2',
		'fmt-heading-3',
		'fmt-bullet-list',
		'fmt-numbered-list',
		'fmt-checklist',
		'fmt-link',
		'insert-table-simple',
	]);
});

test('each tool carries the label, name and shortcut the toolbar renders', () => {
	const byId = new Map(getEditorToolbarTools(null).map((tool) => [tool.id, tool]));

	assert.deepEqual(
		getEditorToolbarTools(null)
			.filter((tool) => tool.group === 'inline')
			.map((tool) => tool.id),
		['fmt-bold', 'fmt-italic', 'fmt-underline', 'fmt-strikethrough', 'fmt-inline-code'],
	);

	// The inline tools whose accelerator the editor also binds; a tool that
	// loses its shortcut still renders, so nothing else would notice.
	assert.equal(byId.get('fmt-bold')?.shortcut?.('Ctrl'), 'Ctrl+B');
	assert.equal(byId.get('fmt-italic')?.shortcut?.('Cmd'), 'Cmd+I');
	assert.equal(byId.get('fmt-underline')?.shortcut?.('Ctrl'), 'Ctrl+U');
	assert.equal(byId.get('fmt-underline')?.label, 'U');
	assert.equal(byId.get('fmt-underline')?.name, 'Underline');
	assert.equal(byId.get('fmt-strikethrough')?.shortcut?.('Cmd'), 'Cmd+Shift+X');
	assert.equal(byId.get('fmt-strikethrough')?.label, 'S');
	assert.equal(byId.get('fmt-strikethrough')?.name, 'Strikethrough');
	assert.equal(byId.get('insert-table-simple')?.shortcut?.('Cmd'), 'Cmd+Opt+T');

	// The four buttons that gained a hint when the keymap was reworked. Three list
	// buttons had actions and no key at all, and Link — the chord four independent
	// editors agree on — had none either, so the tooltip had nothing to print.
	assert.equal(byId.get('fmt-link')?.shortcut?.('Cmd'), 'Cmd+K');
	assert.equal(byId.get('fmt-numbered-list')?.shortcut?.('Ctrl'), 'Ctrl+Shift+7');
	assert.equal(byId.get('fmt-bullet-list')?.shortcut?.('Ctrl'), 'Ctrl+Shift+8');
	assert.equal(byId.get('fmt-checklist')?.shortcut?.('Cmd'), 'Cmd+Shift+9');
});

test('normalizeEditorToolbarOrder drops unknown ids, deduplicates, and appends new defaults', () => {
	assert.deepEqual(
		normalizeEditorToolbarOrder([
			'fmt-heading-1',
			'unknown-tool',
			'fmt-bold',
			'fmt-heading-1',
		]),
		[
			'fmt-heading-1',
			'fmt-bold',
			...DEFAULT_EDITOR_TOOLBAR_ORDER.filter((id) => id !== 'fmt-heading-1' && id !== 'fmt-bold'),
		],
	);
});

test('normalizeEditorToolbarHidden keeps only known toolbar ids', () => {
	assert.deepEqual(
		normalizeEditorToolbarHidden(['fmt-bold', 'unknown-tool', 'fmt-italic']),
		['fmt-bold', 'fmt-italic'],
	);
});

test('getVisibleEditorToolbarTools applies saved order and hidden ids', () => {
	const tools = getVisibleEditorToolbarTools(['fmt-italic', 'fmt-bold'], ['fmt-bold']);

	assert.equal(tools[0]?.id, 'fmt-italic');
	assert.equal(tools.some((tool) => tool.id === 'fmt-bold'), false);
	// 15 tools in the catalogue, one hidden. Counted rather than derived from
	// the default order: `DEFAULT_EDITOR_TOOLBAR_ORDER.length - 1` shrinks with
	// the catalogue and stays true.
	assert.equal(tools.length, 14);
});

test('toolbar reorder helpers resolve drag and keyboard moves', () => {
	const order = ['fmt-bold', 'fmt-italic', 'fmt-link'];

	assert.deepEqual(getEditorToolbarReorderMove(order, 'fmt-link', 'fmt-bold'), { fromIndex: 2, toIndex: 0 });
	assert.deepEqual(getEditorToolbarAdjacentMove(order, 'fmt-italic', 'down'), { fromIndex: 1, toIndex: 2 });
	assert.equal(getEditorToolbarReorderMove(order, 'fmt-bold', 'fmt-bold'), null);
	assert.equal(getEditorToolbarAdjacentMove(order, 'fmt-bold', 'up'), null);
});

test('every tool with a line marker is a tool the toolbar renders', () => {
	assert.deepEqual(LINE_MARKER_TOOL_IDS, [
		'fmt-quote',
		'fmt-bullet-list',
		'fmt-numbered-list',
		'fmt-checklist',
		'fmt-heading-1',
		'fmt-heading-2',
		'fmt-heading-3',
	]);

	for (const id of LINE_MARKER_TOOL_IDS) {
		assert.ok(
			DEFAULT_EDITOR_TOOLBAR_ORDER.includes(id),
			`${id} has a line marker but is not a toolbar tool`,
		);
	}
});

/**
 * One row per (tool, starting line) pair, written as the exact text the
 * transform has to produce. Issue #451 was a *string* — bullet on `1. foo`
 * yielded `- 1. foo` — so nothing short of running the transform and comparing
 * output can fail on it; an assertion about how `Editor.svelte` reads would
 * have stayed green through the whole bug.
 *
 * The three list markers compete for one slot, so each of them replaces the
 * other two (and the task box travels with the checklist marker, or the line
 * keeps an orphan `[ ]` no tool recognises). Quote is deliberately not in that
 * set: `> - foo` is a quoted list item, which is what a user asking for a quote
 * around a list item wants.
 */
const LINE_MARKER_MATRIX: Array<[LineMarkerToolId, string, string]> = [
	// Bullet list.
	['fmt-bullet-list', 'foo', '- foo'],
	['fmt-bullet-list', '- foo', 'foo'],
	['fmt-bullet-list', '1. foo', '- foo'],
	['fmt-bullet-list', '- [ ] foo', '- foo'],
	['fmt-bullet-list', '- [x] foo', '- foo'],

	// Numbered list.
	['fmt-numbered-list', 'foo', '1. foo'],
	['fmt-numbered-list', '- foo', '1. foo'],
	['fmt-numbered-list', '1. foo', 'foo'],
	['fmt-numbered-list', '- [ ] foo', '1. foo'],
	['fmt-numbered-list', '1. [ ] foo', '1. foo'],

	// Checklist.
	['fmt-checklist', 'foo', '- [ ] foo'],
	['fmt-checklist', '- foo', '- [ ] foo'],
	['fmt-checklist', '1. foo', '- [ ] foo'],
	['fmt-checklist', '- [ ] foo', 'foo'],
	['fmt-checklist', '- [x] foo', 'foo'],

	// `1)` is the other ordered delimiter CommonMark defines, and the renderer
	// has always read it (`TASK_SOURCE_RE`, and the preview's own checkbox
	// rewrite). The toolbar knew only `1.`, so bullet on `1) item` produced
	// `- 1) item` — issue #451 exactly, one delimiter over — and the numbered
	// button added a second marker to a line that already was an ordered item
	// instead of taking it off.
	['fmt-bullet-list', '1) item', '- item'],
	['fmt-numbered-list', '1) item', 'item'],
	['fmt-numbered-list', '2) item', 'item'],
	['fmt-checklist', '1) item', '- [ ] item'],
	['fmt-checklist', '1) [ ] item', '- [ ] item'],

	// Indentation belongs to the line, not to the marker: it is what makes the
	// item a *nested* one, and a toggle that dropped it flattened the item to top
	// level. The button did not even see the marker — `- sub` behind four spaces
	// matched neither `own` nor `competing` — so a click on any nested bullet
	// answered with `-     - sub`.
	['fmt-bullet-list', '    - sub', '    sub'],
	['fmt-bullet-list', '    sub', '    - sub'],
	['fmt-bullet-list', '  1. sub', '  - sub'],
	['fmt-numbered-list', '\t1. sub', '\tsub'],
	['fmt-numbered-list', '\t- sub', '\t1. sub'],
	['fmt-bullet-list', '  - [ ] sub', '  - sub'],
	['fmt-checklist', '    - [x] sub', '    sub'],
	['fmt-quote', '  - sub', '  > - sub'],

	// A list item inside a block quote is a list item — the same grammar the
	// renderer reads to find a task line. The quote markers travel with the
	// indentation for the same reason: they say where the item sits, and a list
	// button that consumed them would lift the item out of the quote.
	['fmt-bullet-list', '> - item', '> item'],
	['fmt-numbered-list', '> - item', '> 1. item'],
	['fmt-checklist', '> - [ ] item', '> item'],
	['fmt-bullet-list', '> > - deep', '> > deep'],

	// Which is also why a list button on a quoted *paragraph* now writes the
	// marker inside the quote. `- > foo` — the old answer — is a list item
	// containing a quote, a different document from the quoted list item the
	// click asked for, and one that no second click could undo.
	['fmt-bullet-list', '> foo', '> - foo'],
	['fmt-numbered-list', '> foo', '> 1. foo'],
	['fmt-checklist', '> foo', '> - [ ] foo'],

	// Quote wraps, it does not displace: a quoted list item is the point.
	['fmt-quote', 'foo', '> foo'],
	['fmt-quote', '- foo', '> - foo'],
	['fmt-quote', '1. foo', '> 1. foo'],
	['fmt-quote', '- [ ] foo', '> - [ ] foo'],
	['fmt-quote', '> foo', 'foo'],

	// Headings replace headings, and nothing else — `# - foo` is a heading whose
	// text begins with a dash, and un-toggling gives the list item back.
	['fmt-heading-2', 'foo', '## foo'],
	['fmt-heading-2', '# foo', '## foo'],
	['fmt-heading-2', '## foo', 'foo'],
	['fmt-heading-1', '### foo', '# foo'],
	['fmt-heading-1', '- foo', '# - foo'],
];

for (const [id, from, to] of LINE_MARKER_MATRIX) {
	test(`${id} turns ${JSON.stringify(from)} into ${JSON.stringify(to)}`, () => {
		assert.deepEqual(toggleLineMarker(id, [from]), [to]);
	});
}

test('a selection that mixes marker types converges on the toggled one', () => {
	assert.deepEqual(
		toggleLineMarker('fmt-bullet-list', ['- alpha', '1. beta', '- [ ] gamma', 'delta']),
		['- alpha', '- beta', '- gamma', '- delta'],
	);

	// Removal needs *every* content line to already carry this tool's marker, so
	// a half-marked selection is completed rather than stripped.
	assert.deepEqual(
		toggleLineMarker('fmt-checklist', ['- [ ] alpha', '- beta']),
		['- [ ] alpha', '- [ ] beta'],
	);

	assert.deepEqual(toggleLineMarker('fmt-bullet-list', ['- alpha', '- beta']), ['alpha', 'beta']);
});

test('a nested selection keeps every line at the depth the author put it', () => {
	// The whole selection is already bulleted, so this is the removal branch —
	// the one that used to hand back `- top` / `- sub` with the indentation
	// eaten, collapsing two levels into one.
	assert.deepEqual(
		toggleLineMarker('fmt-bullet-list', ['- top', '    - sub', '\t\t- deeper']),
		['top', '    sub', '\t\tdeeper'],
	);

	assert.deepEqual(
		toggleLineMarker('fmt-numbered-list', ['    alpha', '    beta']),
		['    1. alpha', '    2. beta'],
	);
});

test('numbering counts content lines and leaves blank lines alone', () => {
	assert.deepEqual(
		toggleLineMarker('fmt-numbered-list', ['- alpha', '', 'beta', '1. gamma']),
		['1. alpha', '', '2. beta', '3. gamma'],
	);

	assert.deepEqual(toggleLineMarker('fmt-bullet-list', ['', '   ']), ['', '   ']);
});

test('quote nests around an already quoted line instead of replacing it', () => {
	assert.deepEqual(toggleLineMarker('fmt-quote', ['> alpha', 'beta']), ['> > alpha', '> beta']);
	assert.deepEqual(toggleLineMarker('fmt-quote', ['> alpha', '> beta']), ['alpha', 'beta']);
});

test('a bracketed link at the head of a list item is not read as a task box', () => {
	assert.deepEqual(toggleLineMarker('fmt-numbered-list', ['- [label](url)']), ['1. [label](url)']);
});

// --------------------------------------------------------- inline wrap markers

test('every tool with an inline wrap is a tool the toolbar renders', () => {
	assert.deepEqual(INLINE_WRAP_TOOL_IDS, [
		'fmt-bold',
		'fmt-italic',
		'fmt-strikethrough',
		'fmt-inline-code',
	]);

	for (const id of INLINE_WRAP_TOOL_IDS) {
		assert.ok(
			DEFAULT_EDITOR_TOOLBAR_ORDER.includes(id),
			`${id} has an inline wrap but is not a toolbar tool`,
		);
	}
});

/**
 * One row per (tool, selected text) pair, as the exact text the toggle produces.
 *
 * Same shape as LINE_MARKER_MATRIX above, and for the same reason: every defect
 * this table exists for was a *string* the user was left holding.
 */
const INLINE_WRAP_MATRIX: Array<[InlineWrapToolId, string, string]> = [
	// The plain round trip, in both spellings Markdown offers. The underscore
	// halves are the gap this table closes: the toolbar knew only the asterisk
	// ones, so a click on `__bold__` wrapped a second pair around it.
	['fmt-bold', 'x', '**x**'],
	['fmt-bold', '**x**', 'x'],
	['fmt-bold', '__x__', 'x'],
	['fmt-italic', 'x', '*x*'],
	['fmt-italic', '*x*', 'x'],
	['fmt-italic', '_x_', 'x'],
	['fmt-inline-code', 'x', '`x`'],
	['fmt-inline-code', '`x`', 'x'],

	// Strikethrough writes two tildes and takes back one or two. Both are
	// strikethrough in GFM and in this app's renderer, so a document written
	// anywhere else toggles off cleanly — and the button never produces the
	// `~~~gone~~~` that answering `~gone~` with a second pair would, which is
	// three tildes and not strikethrough anywhere.
	['fmt-strikethrough', 'gone', '~~gone~~'],
	['fmt-strikethrough', '~~gone~~', 'gone'],
	['fmt-strikethrough', '~gone~', 'gone'],

	// Italic must not take an asterisk that belongs to bold — in either
	// spelling. Wrapping is the right answer here: italic on bold means both.
	['fmt-italic', '**bold**', '***bold***'],
	['fmt-italic', '__bold__', '*__bold__*'],

	// Text that really is both, though, has an italic marker to give back, and
	// giving it back leaves the bold pair whole. Both directions, so that the
	// rule above cannot be satisfied by refusing to strip anything doubled.
	['fmt-italic', '***both***', '**both**'],
	['fmt-italic', '___both___', '__both__'],
	['fmt-bold', '***both***', '*both*'],

	// The other direction needs no rule: `**` is longer than the `*` sitting
	// inside it, so bold on italic text still strips its own pair.
	['fmt-bold', '*it*', '***it***'],
	['fmt-bold', '_it_', '**_it_**'],

	// A marker of one tool is nobody else's business.
	['fmt-inline-code', '**x**', '`**x**`'],
	['fmt-bold', '`x`', '**`x`**'],
	['fmt-italic', '~~x~~', '*~~x~~*'],
	['fmt-strikethrough', '**x**', '~~**x**~~'],

	// A selection whose two ends would have to overlap to match is not a wrapped
	// span: `**` is one marker, not an empty bold one, and slicing it as if it
	// were would delete the selection.
	['fmt-bold', '**', '******'],
	['fmt-bold', '****', ''],
	['fmt-italic', '', '**'],
];

for (const [id, from, to] of INLINE_WRAP_MATRIX) {
	test(`${id} turns ${JSON.stringify(from)} into ${JSON.stringify(to)}`, () => {
		assert.equal(toggleInlineWrap(id, from), to);
	});
}

test('the strikethrough button never leaves text that is not struck through', () => {
	// The failure the two-marker strip list exists for: `~gone~` is legal
	// strikethrough, so answering it with a second pair gives `~~~gone~~~` — a
	// user who asked to un-strike struck text ends up with three tildes, which
	// GFM renders as literal characters.
	for (const struck of ['~gone~', '~~gone~~']) {
		assert.equal(toggleInlineWrap('fmt-strikethrough', struck), 'gone');
	}
});

test('the italic button never turns bold text into italic text', () => {
	// The defect this rule exists for, stated as the user saw it: select
	// `**bold**`, ask for italic, and the text stopped being bold.
	for (const bold of ['**bold**', '__bold__']) {
		const result = toggleInlineWrap('fmt-italic', bold);
		assert.ok(result.includes(bold), `italic on ${bold} produced ${result}, which no longer contains it`);
	}
});
