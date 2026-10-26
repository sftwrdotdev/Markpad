import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import assert from 'node:assert/strict';
import { readSource } from './sourceTree.js';
import { parse } from 'svelte/compiler';
import ts from 'typescript';
import { hasExportableDocument } from '../src/lib/utils/tabFileActions.js';

describe('rendered HTML field', () => {
	// ---------------------------------------------------------------- environment
	// The runes are the compiler's, not ours: vitest builds `.svelte.ts` through the
	// Svelte plugin, so the store and the session run under real reactivity, and jsdom
	// supplies `window` and `localStorage`. Only the Tauri backend is stubbed, and it
	// has to be in place before the stores are imported, so both happen in beforeAll.
	let tabManager: (typeof import('../src/lib/stores/tabs.svelte.js'))['tabManager'];
	let settings: (typeof import('../src/lib/stores/settings.svelte.js'))['settings'];

	beforeAll(async () => {
		(window as any).__TAURI_INTERNALS__ = {
			metadata: { currentWindow: { label: 'main' }, currentWebview: { windowLabel: 'main', label: 'main' } },
			invoke: (cmd: string) => Promise.resolve(cmd === 'get_os_type' ? 'macos' : null),
		};
		({ tabManager } = await import('../src/lib/stores/tabs.svelte.js'));
		({ settings } = await import('../src/lib/stores/settings.svelte.js'));
	});

	afterAll(() => {
		delete (window as any).__TAURI_INTERNALS__;
	});

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
			// The gate moved into a helper when the Export as PDF chord needed the
			// same condition (#673). Supplied as the real function, so what these
			// tests evaluate is still the shipped decision rather than a stand-in.
			hasExportableDocument: () => hasExportableDocument,
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
		const bails = new Function('ctx', 'hasExportableDocument', `return Boolean(${text});`) as (
			ctx: unknown,
			gate: typeof hasExportableDocument,
		) => boolean;
		// The context MarkdownViewer.svelte builds for the active tab.
		return () => {
			const tab = tabManager.activeTab;
			if (!tab) return false;
			return !bails({ rawContent: tab.rawContent, tabPath: tab.path, tabTitle: tab.title }, hasExportableDocument);
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
		// STRICTER is the defect this test is for; being looser is pinned by the
		// saved-empty-file test below.
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

	test('a saved file with an empty buffer is offered nothing to export', () => {
		// A saved empty file, or a tab whose read has not landed yet: a path and an
		// empty buffer. The menu used to list the exports on the path alone, so
		// Export as HTML then did nothing and Export as PDF printed a blank page.
		// The menu, the PDF chord and the HTML export now ask one predicate.
		reset();
		tabManager.addTab('/notes/a.md');

		assert.equal(tabManager.activeTab!.rawContent, '', 'precondition: the buffer is empty');
		assert.equal(exportWouldRun(), false, 'precondition: exportAsHtml returns null for an empty buffer');
		assert.equal(exportsOffered.run(), false, 'so the menu must not offer it either');
		assert.equal(hasExportableDocument(tabManager.activeTab!.rawContent), false, 'nor the PDF chord');
	});
});
