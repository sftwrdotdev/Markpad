import assert from 'node:assert/strict';

import { test } from 'vitest';

import { parse } from 'svelte/compiler';

import { readSource } from './sourceTree.js';

/*
 * Issue #392, second half (reported by @PathGao): "the Home tab it opens
 * renders blank".
 *
 * MarkdownViewer.svelte draws the whole application body from one `{#if}`:
 * the consequent is the markdown container (editor + preview), the alternate
 * is `<HomePage>`. The home screen therefore appears only when that condition
 * is FALSE, and the condition was
 *
 *     activeTab && (activeTab.path !== '' || activeTab.title !== 'Recents') && !showHome
 *
 * which is a description of a tab that no longer exists. When the gate was
 * written (0694991, 24 Jan) the home tab really was `{ path: '', title:
 * 'Recents' }`, so both halves went false and the alternate ran. A week later
 * edfb555 changed it to `{ path: 'HOME', title: 'Home' }` — a commit about
 * scroll position, which happened to pass through the tab store — and the two
 * halves became permanently true. From then on the home tab fell into the
 * markdown container and rendered an empty document. The later i18n pass
 * turned the title into `t('tabs.home', lang)`, which merely made the dead
 * half unrecoverable in 26 languages instead of one.
 *
 * Nothing could see that coupling: a template string compared against a
 * localised title is invisible to the compiler, to `npm run check`, and to
 * every test that imports the store rather than reading the component.
 *
 * So this file reads the REAL gate. It parses the component, finds the `{#if}`
 * whose `{:else}` renders `<HomePage>`, and evaluates that exact expression
 * against the REAL `TabManager`. It asserts nothing about how the condition is
 * spelled — rewrite it any way that keeps the home tab out of the document
 * container and these tests stay green.
 *
 * What this does not establish: that `<HomePage>` itself renders anything
 * useful, or anything about CSS. It establishes which branch the app takes.
 */

// ---------------------------------------------------------------- environment
// Svelte runes and the Tauri bridge, faked exactly as homeSentinelSnapshot.ts
// does, so `tabs.svelte.ts` and `settings.svelte.ts` import under plain node.

// The runes are the compiler's, not ours: vitest builds `.svelte.ts` through the
// Svelte plugin, so the store and the session run under real reactivity, and jsdom
// supplies `window` and `localStorage`. Only the Tauri backend is stubbed.
(window as any).__TAURI_INTERNALS__ = {
	metadata: { currentWindow: { label: 'main' }, currentWebview: { windowLabel: 'main', label: 'main' } },
	invoke: (cmd: string) => Promise.resolve(cmd === 'get_os_type' ? 'macos' : null),
};

const { tabManager } = await import('../src/lib/stores/tabs.svelte.js');
const { HOME_TAB_PATH, isHomePath } = await import('../src/lib/utils/homeTab.js');
const { hasRealFilePath } = await import('../src/lib/utils/tabFileActions.js');
const { getSupportedLanguages, t } = await import('../src/lib/utils/i18n.js');

// ------------------------------------------------------- the gate, as written

const VIEWER = 'src/lib/MarkdownViewer.svelte';
const source = readSource(VIEWER);

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

/**
 * Every `{#if}` whose `{:else}` branch renders `<HomePage>`, and which is not
 * merely an ancestor of one that does.
 *
 * The whole component body sits inside the `mode === 'loading' / 'installer' /
 * 'uninstall'` chain, so those outer blocks contain `<HomePage>` too. Only the
 * innermost one is the gate — the one that actually decides between the home
 * screen and a document.
 */
function homeScreenGates(): Node[] {
	const ast = parse(source, { modern: true, filename: VIEWER });
	const rendersHomePage = (node: Node) => {
		let found = false;
		collect(node, (inner) => {
			if (inner.type === 'Component' && inner.name === 'HomePage') found = true;
		});
		return found;
	};

	const candidates: Node[] = [];
	collect(ast.fragment, (node) => {
		if (node.type === 'IfBlock' && node.alternate && rendersHomePage(node.alternate)) candidates.push(node);
	});

	return candidates.filter((gate) => {
		let nested = false;
		collect(gate.alternate, (inner) => {
			if (inner !== gate && candidates.includes(inner)) nested = true;
		});
		return !nested;
	});
}

const gateNode = (() => {
	const gates = homeScreenGates();
	assert.equal(
		gates.length,
		1,
		`expected exactly one {#if} in ${VIEWER} whose {:else} renders <HomePage>, found ${gates.length} — ` +
			'if the home screen moved out of this branch, move these tests with it',
	);
	return gates[0];
})();

const gateSource = source.slice(gateNode.test.start, gateNode.test.end);

/**
 * The gate as a callable, over whatever it happens to reference today.
 *
 * Free identifiers are read off the parsed expression rather than hard-coded,
 * so a rewrite that uses a different helper fails with "the gate references X"
 * instead of a bare ReferenceError from inside `new Function`.
 */
const evaluateGate = (() => {
	const names = new Set<string>();
	const skip = new Set<unknown>();
	collect(gateNode.test, (node) => {
		if (node.type === 'MemberExpression' && !node.computed) skip.add(node.property);
		if (node.type === 'Property' && !node.computed) skip.add(node.key);
	});
	collect(gateNode.test, (node) => {
		if (node.type === 'Identifier' && !skip.has(node)) names.add(node.name);
	});

	const available: Record<string, unknown> = { tabManager, isHomePath, hasRealFilePath };
	const ordered = [...names].sort();
	for (const name of ordered) {
		if (name === 'showHome') continue;
		assert.ok(
			name in available,
			`the home-screen gate references \`${name}\`, which these tests cannot supply — ` +
				`add it to \`available\` in ${'scripts/homeTabRender.test.ts'} so the gate can still be evaluated`,
		);
	}

	const params = ordered.filter((name) => name !== 'showHome');
	const body = `return Boolean(${gateSource});`;
	const fn = new Function('showHome', ...params, body) as (showHome: boolean, ...rest: unknown[]) => boolean;
	return (showHome: boolean) => fn(showHome, ...params.map((name) => available[name]));
})();

/** True when the app draws the document container; false when it draws HomePage. */
const showsDocumentContainer = (showHome = false) => evaluateGate(showHome);

function reset() {
	tabManager.closeAll();
	localStorage.clear();
}

// --------------------------------------------------------------- the regression

test('the home tab renders the home screen, not an empty document', () => {
	reset();
	tabManager.addHomeTab();

	assert.equal(tabManager.activeTab?.path, HOME_TAB_PATH, 'precondition: the home tab is active');
	assert.equal(
		showsDocumentContainer(),
		false,
		'the active home tab fell into the markdown container instead of the {:else} branch that ' +
			`renders <HomePage> — the user sees a blank page. Gate: ${gateSource}`,
	);
});

test('a home tab opened next to files still renders the home screen', () => {
	// Ctrl+T from a window that already has documents open — the reported path.
	reset();
	tabManager.addTab('/notes/a.md');
	tabManager.addTab('/notes/b.md');
	tabManager.addHomeTab();

	assert.equal(showsDocumentContainer(), false, `blank home tab alongside open files. Gate: ${gateSource}`);
});

test('the home screen is reached by tab kind, never by the tab title', () => {
	// The dead half of the old gate. `title` is user-facing text: localised,
	// and for a file tab it is just a filename, so a document called
	// `Recents` used to be enough to hide the editor. Nothing about which
	// branch runs may depend on it.
	reset();
	tabManager.addHomeTab();
	const home = tabManager.activeTab!;

	for (const { code } of getSupportedLanguages()) {
		home.title = t('tabs.home', code);
		assert.equal(showsDocumentContainer(), false, `the home screen disappears in locale ${code}`);
	}

	home.title = 'Recents';
	assert.equal(showsDocumentContainer(), false, 'the pre-i18n English title must not be what makes this work');

	reset();
	tabManager.addTab('/notes/Recents');
	assert.equal(showsDocumentContainer(), true, 'a document named Recents is a document');
});

// ---------------------------------------------------------------- the neighbours
//
// The three states that already worked. They are the fence: a gate that simply
// always chose HomePage would pass the tests above and fail every one of these.

test('a saved file renders the document container', () => {
	reset();
	tabManager.addTab('/notes/a.md');

	assert.equal(showsDocumentContainer(), true);
});

test('an untitled buffer renders the document container', () => {
	// The distinction the fix rests on: an untitled tab has no file either, so
	// `hasRealFilePath` is false for both — but it IS a document, and gating on
	// that predicate would have hidden the editor for every new file.
	reset();
	tabManager.addNewTab();

	assert.equal(tabManager.activeTab?.path, '', 'precondition: an untitled tab has no path');
	assert.equal(hasRealFilePath(''), false, 'precondition: and no real file either');
	assert.equal(isHomePath(''), false, 'but it is not the home tab');
	assert.equal(showsDocumentContainer(), true, 'a new file must still get an editor');
});

test('an empty window renders the home screen', () => {
	reset();

	assert.equal(tabManager.activeTab, undefined);
	assert.equal(showsDocumentContainer(), false);
});

test('the Home toolbar button still overlays the home screen on any tab', () => {
	// `showHome` is the other, older route to the same screen: a transient flag
	// set by the toolbar/menu item, independent of any tab. It must keep
	// winning over whatever tab is active.
	reset();
	tabManager.addTab('/notes/a.md');
	assert.equal(showsDocumentContainer(true), false, 'a file tab with showHome set');

	tabManager.addNewTab();
	assert.equal(showsDocumentContainer(true), false, 'an untitled tab with showHome set');

	tabManager.addHomeTab();
	assert.equal(showsDocumentContainer(true), false, 'the home tab with showHome set');
});

test('switching from the home tab back to a file returns to the document', () => {
	reset();
	tabManager.addTab('/notes/a.md');
	const file = tabManager.activeTab!.id;
	tabManager.addHomeTab();
	assert.equal(showsDocumentContainer(), false);

	tabManager.setActive(file);

	assert.equal(showsDocumentContainer(), true, 'the document container must come back');
});
