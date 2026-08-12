import assert from 'node:assert/strict';

import { test } from 'vitest';

import { parse } from 'svelte/compiler';
import ts from 'typescript';

import { asRendererLine } from '../src/lib/utils/lineCoordinates.js';
import { readSource } from './sourceTree.js';

/*
 * The Home menu decided whether to offer "Export as HTML" / "Export as PDF" by
 * looking at `tab.content`, which is not the document. A `Tab` carries three
 * same-shaped strings:
 *
 *   rawContent      the live Markdown — what the editor edits and what the
 *                   exports read
 *   originalContent that buffer as it last came off / went onto disk; read
 *                   only by the isDirty comparison
 *   content         the RENDERED preview HTML, injected via {@html}
 *
 * `content` is a cache of a render, and MarkdownViewer only refreshes it while
 * the preview is on screen — split view, or the editor with the TOC open. In
 * plain edit mode with the TOC closed it is whatever was last rendered, which
 * for a buffer that has never been rendered is the empty string. So an
 * untitled, unsaved, actively-edited document had `content === ''` while
 * `rawContent` held the user's text, and the menu hid two commands that would
 * have run. `exportAsHtml` itself gates on `ctx.rawContent`, so the menu was
 * strictly stricter than the operation it fronts.
 *
 * That state became reachable when #421 let the preview and the exports work
 * on an unsaved buffer; before it, an untitled tab had nothing to export
 * either way. `showToc` and `newFileDefaultMode` both default such that
 * Ctrl+T -> type is exactly this state.
 *
 * These tests do not assert how the gate is spelled. They lift three real
 * expressions out of the shipping source and evaluate them against the real
 * TabManager:
 *
 *   1. the `{#if}` in TitleBar.svelte that wraps the two export buttons,
 *   2. the `$effect` condition in MarkdownViewer.svelte that decides whether
 *      `tab.content` is refreshed at all — so the repro's `content === ''` is
 *      derived from the shipping rule rather than assumed by the test,
 *   3. the early return in `exportAsHtml` — so "the export would have worked"
 *      is checked against the export's own precondition.
 *
 * The last section covers the other direction of the same confusion: `addTab`
 * seeding `content` from a Markdown-shaped argument.
 *
 * What this does not establish: anything about the PDF path's own rendering
 * (`syncPreviewForPrint` re-renders before printing, which is why Export PDF
 * is correct to be enabled here too), or that the buttons are visible given
 * CSS. It establishes which branch the menu takes.
 */

// ---------------------------------------------------------------- environment
// Svelte runes and the Tauri bridge, faked as homeTabRender.test.ts does, so
// `tabs.svelte.ts` and `settings.svelte.ts` import under plain node.

// The runes are the compiler's, not ours: vitest builds `.svelte.ts` through the
// Svelte plugin, so the store and the session run under real reactivity, and jsdom
// supplies `window` and `localStorage`. Only the Tauri backend is stubbed.
(window as any).__TAURI_INTERNALS__ = {
	metadata: { currentWindow: { label: 'main' }, currentWebview: { windowLabel: 'main', label: 'main' } },
	invoke: (cmd: string) => Promise.resolve(cmd === 'get_os_type' ? 'macos' : null),
};

const { tabManager } = await import('../src/lib/stores/tabs.svelte.js');
const { settings } = await import('../src/lib/stores/settings.svelte.js');

// ------------------------------------------------------------------ AST walk

type Node = Record<string, any>;

function collect(node: unknown, hit: (node: Node) => void): void {
	if (!node || typeof node !== 'object') return;
	if (Array.isArray(node)) {
		for (const child of node) collect(child, hit);
		return;
	}
	hit(node as Node);
	for (const key of Object.keys(node as Node)) {
		if (key === 'parent') continue;
		collect((node as Node)[key], hit);
	}
}

/** Free identifiers of an expression — property names and object keys excluded. */
function freeIdentifiers(expression: Node): string[] {
	const skip = new Set<unknown>();
	collect(expression, (node) => {
		if (node.type === 'MemberExpression' && !node.computed) skip.add(node.property);
		if (node.type === 'Property' && !node.computed) skip.add(node.key);
	});
	const names = new Set<string>();
	collect(expression, (node) => {
		if (node.type === 'Identifier' && !skip.has(node)) names.add(node.name);
	});
	return [...names].sort();
}

/**
 * Turn a source expression into a predicate over the names it happens to
 * reference, so a rewrite that reaches for a different helper fails with "the
 * gate references X" rather than a bare ReferenceError out of `new Function`.
 */
function compileGate(source: string, expression: Node, available: Record<string, () => unknown>, where: string) {
	const names = freeIdentifiers(expression).filter((name) => name !== 'undefined');
	for (const name of names) {
		assert.ok(
			name in available,
			`${where} references \`${name}\`, which these tests cannot supply — add it to \`available\` ` +
				'in scripts/renderedHtmlField.test.ts so the gate can still be evaluated',
		);
	}
	const text = source.slice(expression.start, expression.end);
	const fn = new Function(...names, `return Boolean(${text});`) as (...args: unknown[]) => boolean;
	return { text, run: () => fn(...names.map((name) => available[name]())) };
}

// ------------------------------------------- 1. the export gate, as written

const TITLE_BAR = 'src/lib/components/TitleBar.svelte';
const titleBarSource = readSource(TITLE_BAR);

const exportMenuGate = (() => {
	const ast = parse(titleBarSource, { modern: true, filename: TITLE_BAR });

	const candidates: Node[] = [];
	collect(ast.fragment, (node) => {
		if (node.type !== 'IfBlock') return;
		const text = titleBarSource.slice(node.start, node.end);
		if (text.includes('onexportHtml?.()') && text.includes('onexportPdf?.()')) candidates.push(node);
	});
	// Innermost only: every ancestor `{#if}` contains the buttons too.
	const innermost = candidates.filter(
		(gate) => !candidates.some((other) => other !== gate && other.start >= gate.start && other.end <= gate.end),
	);

	assert.equal(
		innermost.length,
		1,
		`expected exactly one {#if} in ${TITLE_BAR} wrapping both export buttons, found ${innermost.length} — ` +
			'if the export entries moved, move these tests with them',
	);
	return innermost[0];
})();

const exportsOffered = compileGate(
	titleBarSource,
	exportMenuGate.test,
	{
		tabManager: () => tabManager,
		// MarkdownViewer.svelte:229 — `$derived(tabManager.activeTab?.path ?? '')`.
		currentFile: () => tabManager.activeTab?.path ?? '',
	},
	'the export menu gate',
);

// ------------------------------- 2. the condition that refreshes tab.content

const VIEWER = 'src/lib/MarkdownViewer.svelte';
const viewerSource = readSource(VIEWER);

const previewCacheRefreshes = (() => {
	const ast = parse(viewerSource, { modern: true, filename: VIEWER });
	const matches: Node[] = [];
	collect(ast.instance, (node) => {
		if (node.type !== 'IfStatement') return;
		const test = viewerSource.slice(node.test.start, node.test.end);
		const body = viewerSource.slice(node.consequent.start, node.consequent.end);
		if (test.includes('settings.showToc') && body.includes('updateTabContent')) matches.push(node);
	});
	assert.equal(
		matches.length,
		1,
		`expected exactly one condition in ${VIEWER} guarding the preview-cache render, found ${matches.length}`,
	);

	return compileGate(
		viewerSource,
		matches[0].test,
		{
			tab: () => tabManager.activeTab,
			settings: () => settings,
			// MarkdownViewer.svelte passes the active tab's own flag down as
			// the `isEditing` prop.
			isEditing: () => tabManager.activeTab?.isEditing ?? false,
		},
		'the preview-cache refresh condition',
	);
})();

// ------------------------------------- 3. exportAsHtml's own precondition

const EXPORT = 'src/lib/utils/export.ts';
const exportSource = readSource(EXPORT);

/** `if (!ctx.rawContent) return null;` — evaluated, not matched. */
const exportWouldRun = (() => {
	const file = ts.createSourceFile(EXPORT, exportSource, ts.ScriptTarget.ES2022, true);
	let guard: ts.Expression | null = null;
	const visit = (node: ts.Node) => {
		if (ts.isFunctionDeclaration(node) && node.name?.text === 'exportAsHtml' && node.body) {
			const first = node.body.statements.find(ts.isIfStatement);
			assert.ok(first, 'exportAsHtml no longer opens with a precondition');
			guard = first.expression;
			return;
		}
		ts.forEachChild(node, visit);
	};
	visit(file);
	assert.ok(guard, `expected ${EXPORT} to declare exportAsHtml`);

	const text = exportSource.slice((guard as ts.Expression).getStart(file), (guard as ts.Expression).getEnd());
	const bails = new Function('ctx', `return Boolean(${text});`) as (ctx: unknown) => boolean;
	// The context MarkdownViewer.svelte builds for the active tab.
	return () => {
		const tab = tabManager.activeTab;
		if (!tab) return false;
		return !bails({ rawContent: tab.rawContent, tabPath: tab.path, tabTitle: tab.title });
	};
})();

// ----------------------------------------------------------------- fixtures

function reset() {
	tabManager.closeAll();
	localStorage.clear();
	settings.showToc = false;
	settings.newFileDefaultMode = true;
}

/**
 * Ctrl+T, then type — an untitled buffer being edited, TOC closed, not split.
 * `content` is left at whatever `addNewTab` produced precisely because the
 * refresh condition asserted below never runs for this state.
 */
function untitledBufferBeingEdited(text = '# notes\n\nsomething worth exporting\n') {
	reset();
	tabManager.addNewTab();
	const tab = tabManager.activeTab!;
	tab.isEditing = true;
	tabManager.updateTabRawContent(tab.id, text);
	return tab;
}

// --------------------------------------------------------------- the regression

test('the preview HTML cache is not refreshed while editing with the TOC closed', () => {
	// The premise of the bug, taken from the shipping condition rather than
	// asserted by hand. Without this, the repro below would be a test fixture
	// choosing its own outcome.
	const tab = untitledBufferBeingEdited();

	assert.equal(tab.isEditing, true);
	assert.equal(tab.isSplit, false);
	assert.equal(settings.showToc, false);
	assert.equal(
		previewCacheRefreshes.run(),
		false,
		`nothing re-renders tab.content in this state. Condition: ${previewCacheRefreshes.text}`,
	);
	assert.equal(tab.content, '', 'so the rendered-HTML cache is still empty');
	assert.notEqual(tab.rawContent, '', 'while the document itself is not');
});

test('an untitled buffer being edited is offered the export commands', () => {
	untitledBufferBeingEdited();

	assert.equal(exportWouldRun(), true, 'precondition: exportAsHtml would produce a file for this buffer');
	assert.equal(
		exportsOffered.run(),
		true,
		'the Home menu hid Export as HTML / Export as PDF for a document that exports fine — ' +
			`it read the rendered-HTML cache instead of the buffer. Gate: ${exportsOffered.text}`,
	);
});

/**
 * Bring `tab.content` to what the running app would hold in this state.
 *
 * Editable panes: only the condition lifted above refreshes it. Reading mode:
 * `renderTabPreviewFromRaw` drew the pane the user is looking at, so it is
 * current by construction. This is what makes the matrix below a statement
 * about the app rather than about fixtures the test wrote by hand.
 */
function settleRenderedCache() {
	const tab = tabManager.activeTab;
	if (!tab) return;
	const editablePane = tab.isEditing || tab.isSplit;
	if (!editablePane || previewCacheRefreshes.run()) {
		tabManager.updateTabContent(tab.id, tab.rawContent ? `<h1>rendered</h1>` : '');
	}
}

test('the menu is never stricter than the export it fronts', () => {
	// The invariant behind the fix, over the states a tab can be in. Being
	// LOOSER is allowed (a saved file with an empty buffer still lists the
	// entries, and the export then no-ops), being STRICTER is the defect.
	const states: Array<[string, () => void]> = [
		['untitled, edited, TOC closed', () => void untitledBufferBeingEdited()],
		[
			'untitled, edited, TOC open',
			() => {
				untitledBufferBeingEdited();
				settings.showToc = true;
			},
		],
		[
			'untitled, split view',
			() => {
				const tab = untitledBufferBeingEdited();
				tabManager.setSplitEnabled(tab.id, true);
			},
		],
		[
			'untitled, reading mode',
			() => {
				const tab = untitledBufferBeingEdited();
				tab.isEditing = false;
			},
		],
		[
			'saved file, edited, TOC closed',
			() => {
				reset();
				tabManager.addTab('/notes/a.md');
				const tab = tabManager.activeTab!;
				tabManager.setTabRawContent(tab.id, '# a\n');
				tab.isEditing = true;
			},
		],
	];

	// Collected rather than asserted one at a time, so a failure names every
	// state the menu is wrong in instead of only the first.
	const hidden: string[] = [];
	for (const [name, arrange] of states) {
		arrange();
		settleRenderedCache();
		if (exportWouldRun() && !exportsOffered.run()) hidden.push(name);
	}

	assert.deepEqual(hidden, [], 'the export is possible in these states and the menu hides it');
});

// ------------------------------------------------------------------ the fence
//
// A gate that simply always returned true would pass everything above.

test('an empty untitled buffer is offered nothing to export', () => {
	reset();
	tabManager.addNewTab();
	tabManager.activeTab!.isEditing = true;

	assert.equal(exportWouldRun(), false, 'precondition: exportAsHtml returns null for an empty buffer');
	assert.equal(exportsOffered.run(), false, 'so the menu must not offer it either');
});

test('a window with no tab at all offers no export', () => {
	reset();

	assert.equal(exportsOffered.run(), false);
});

test('a saved file is offered the export commands', () => {
	reset();
	tabManager.addTab('/notes/a.md');
	tabManager.setTabRawContent(tabManager.activeTab!.id, '# a\n');

	assert.equal(exportsOffered.run(), true);
});

test('a tab whose file has not been read yet still lists the export commands', () => {
	// A restored tab, or one whose large-file read has not landed: it has a
	// path and an empty buffer. The entries stay — the menu must not appear
	// and disappear while a file loads — and the export then no-ops. Pins the
	// `currentFile !== ''` half of the gate, which the states above do not
	// distinguish from the buffer half.
	reset();
	tabManager.addTab('/notes/a.md');

	assert.equal(tabManager.activeTab!.rawContent, '', 'precondition: nothing has been read');
	assert.equal(exportsOffered.run(), true);
});

// ------------------------------------------------- addTab's Markdown argument
//
// The same three fields, confused in the other direction. `addTab(path,
// content = '')` assigned its argument to `content`, `rawContent` AND
// `originalContent` — coherent when they were one field, but it meant the
// signature accepted Markdown into the field that is injected via {@html}.
// Both callers in the app pass `''`, so nothing shipped broken; the ~25 test
// callers that pass real Markdown are what says the argument is the buffer.

test('addTab puts its argument in the buffer, not in the rendered-HTML field', () => {
	reset();
	const markdown = '# heading\n\n<script>alert(1)</script>\n';
	tabManager.addTab('/notes/a.md', markdown);
	const tab = tabManager.activeTab!;

	assert.equal(tab.rawContent, markdown, 'the argument is the Markdown buffer');
	assert.equal(tab.originalContent, markdown, 'and the saved baseline, so the tab opens clean');
	assert.equal(tab.isDirty, false);
	assert.equal(
		tab.content,
		'',
		'the rendered-HTML field starts empty and is filled by the first render, as at every other ' +
			'Tab construction site — seeding it here routes Markdown into the {@html} sink',
	);
});

test('every Tab construction site starts the rendered-HTML field empty', () => {
	// The invariant the fix restores. `updateTabContent` is the only writer.
	reset();
	// restoreState REPLACES the tab list, so it goes first.
	tabManager.restoreState(JSON.stringify({ tabs: [{ path: '/notes/b.md', title: 'b.md' }] }));
	tabManager.addTab('/notes/a.md', '# a\n');
	tabManager.addNewTab();
	tabManager.addHomeTab();
	tabManager.insertTransferredTab({
		path: '/notes/c.md',
		title: 'c.md',
		rawContent: '# c\n',
		originalContent: '# c\n',
		scrollTop: 0,
		isDirty: false,
		isEditing: false,
		history: ['/notes/c.md'],
		historyIndex: 0,
		scrollPercentage: 0,
		anchorLine: asRendererLine(0),
		isSplit: false,
		splitRatio: 0.5,
		isScrollSynced: false,
		hasReplacementChars: false,
		encoding: 'UTF-8',
	});

	assert.equal(tabManager.tabs.length, 5, 'precondition: every construction site produced a tab');
	for (const tab of tabManager.tabs) {
		assert.equal(tab.content, '', `${tab.path || tab.title} was constructed with a non-empty content field`);
	}
});
