import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import assert from 'node:assert/strict';
import { readSource } from './sourceTree.js';
import { parse } from 'svelte/compiler';

/**
 * Switching theme has to re-draw the diagrams, and until this file existed it
 * did not — in any mode, for any theme.
 *
 * Mermaid bakes fills, strokes and label colours into the SVG as attributes, so
 * a stylesheet cannot retarget them; `mermaidPrint.ts` says why at length, and
 * re-rendering is the answer it already reaches for on the way to a PDF. The
 * preview's own theme change was supposed to do the same thing through
 * `renderRichContent`, and could not: that function finds diagrams by
 * `pre code`, and a diagram that has been drawn once has no `<pre>` any more —
 * it was replaced by the `.mermaid-diagram` container holding the SVG.
 *
 * That was invisible while the preview was `{@html sanitizedHtml}`, because
 * every render put the whole document back as source. the block patch (#632)
 * keeps enriched nodes across renders instead, and from then on a theme change
 * reached no diagram at all. The `<pre>` is gone, `patch.inserted` is empty on
 * a re-render of the same document, and typing does not help either: the
 * diagram's markup is unchanged, so the patch keeps the node.
 *
 * The libraries are stood in for at the same boundary `exportRichContent` and
 * `richContentIdempotence` use. What is under test is Markpad's bookkeeping:
 * which containers it decides are stale, and what it does to them.
 */
describe('diagram theme refresh', () => {
	/**
	 * The wiring, which the tests above cannot reach: `renderRichContent` now knows
	 * how to re-draw a stale diagram, but the theme effect still has to call it, in
	 * every mode and once per theme change.
	 *
	 * A source assertion, because the caller is a Svelte effect that cannot be
	 * imported. It pins today's spelling of an internal call, so a rename breaks it
	 * without breaking anything real; what it is here for is the guard, which was
	 * `markdownBody && !isEditing`. That made the whole effect — the `dataset`
	 * writes, `monaco.editor.setTheme`, and for a `vscode:` theme an
	 * `invoke('read_vscode_theme')` and a re-parse — re-run on every mode toggle
	 * and on every tab switch that changed the mode, with nothing about the theme
	 * having moved. And it excluded from the re-colour every tab in edit mode,
	 * including a split tab entered from edit mode, whose preview is on screen.
	 */
	test('the theme effect re-colours in every mode, and does not re-run on a mode change', async () => {
		const { readSource } = await import('./sourceTree.js');
		const viewer: string = readSource('src/lib/MarkdownViewer.svelte');

		const effect = viewer.match(
			/\t\$effect\(\(\) => \{\n\t\t\/\/ Persistence and cross-window sync[\s\S]*?\n\t\}\);/,
		)?.[0];
		expect(effect, 'the theme effect must still be recognisable').toBeTruthy();

		// The mode is not a reason to re-apply a theme, and this is the only read
		// that ever made it one.
		expect(effect).not.toMatch(/isEditing/);
		expect(effect).toMatch(
			/const recolourDiagrams = \(\) => untrack\(\(\) => \{ if \(markdownBody\) renderRichContent\(\); \}\);/,
		);

		// Once per branch: the `vscode:` branch does not know its own appearance
		// until `parseAndApplyVscodeTheme` has published `dataset.themeType`, which
		// is what `currentMermaidTheme` reads.
		expect(effect!.match(/recolourDiagrams\(\);/g)).toHaveLength(2);
		expect(effect).toMatch(/loadVscodeTheme\([\s\S]*?recolourDiagrams\(\);/);
	});
});

describe('line samples cache', () => {
	test('a tab switch that skips the patch still drops the table', () => {
		// The hosts' `display` is what changed, and `isAnchorable` reads it.
		const viewer = readSource('src/lib/MarkdownViewer.svelte');
		expect(viewer).toMatch(/if \(unchanged\) invalidateAnchorMemos\(\);/);
	});
});

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
});
