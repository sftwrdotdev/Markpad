import { afterAll, beforeAll, describe, test } from 'vitest';
import assert from 'node:assert/strict';
import { refreshesPreviewCache } from '../src/lib/utils/previewRefresh.js';

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

	/** The viewer's own refresh condition, for the active tab. */
	const previewCacheRefreshes = {
		text: 'refreshesPreviewCache(tab, isEditing, settings.showToc)',
		run: () => {
			const tab = tabManager.activeTab;
			return !!tab && refreshesPreviewCache(tab, tab.isEditing, settings.showToc);
		},
	};

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
