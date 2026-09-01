import assert from 'node:assert/strict';
import test from 'node:test';

import { readSource } from './sourceTree.js';

import {
	findRestorableDiagrams,
	readDiagramSource,
	rememberDiagramSource,
	renderDiagramsForPrint,
	resolveMermaidTheme,
} from '../src/lib/utils/mermaidPrint.js';

const viewer = readSource(new URL('../src/lib/MarkdownViewer.svelte', import.meta.url));
const richContent = readSource(new URL('../src/lib/utils/richContent.ts', import.meta.url));

/**
 * Minimal stand-ins for the DOM pieces the helper touches. Enough to drive
 * the real implementation without a browser, which is how the rest of
 * scripts/ tests DOM-adjacent logic.
 */
class FakeElement {
	attributes = new Map<string, string>();
	innerHTML = '';
	constructor(public className = '') {}
	setAttribute(name: string, value: string) {
		this.attributes.set(name, value);
	}
	getAttribute(name: string) {
		return this.attributes.has(name) ? this.attributes.get(name)! : null;
	}
}

class FakeRoot {
	constructor(private elements: FakeElement[]) {}
	querySelectorAll(selector: string) {
		assert.match(selector, /\.mermaid-diagram\[data-mermaid-source\]/);
		return this.elements.filter(
			(element) => element.className.includes('mermaid-diagram') && element.getAttribute('data-mermaid-source') !== null,
		);
	}
}

function makeMermaid(behaviour: (source: string) => string) {
	const themes: string[] = [];
	return {
		themes,
		initialize(config: { startOnLoad: boolean; theme: string }) {
			themes.push(config.theme);
		},
		async render(_id: string, source: string) {
			return { svg: behaviour(source) };
		},
	};
}

/** The fake seen as the `Element` the helper's signature asks for. */
const asElement = (element: FakeElement) => element as unknown as Element;

function diagram(source: string | null, html: string) {
	const element = new FakeElement('mermaid-diagram');
	if (source !== null) rememberDiagramSource(asElement(element), source, 'dark');
	element.innerHTML = html;
	return element;
}

test('the diagram theme follows the app appearance', () => {
	assert.equal(resolveMermaidTheme({ theme: 'dark', systemPrefersDark: false }), 'dark');
	assert.equal(resolveMermaidTheme({ theme: 'light', systemPrefersDark: true }), 'neutral');
	assert.equal(resolveMermaidTheme({ theme: 'system', systemPrefersDark: true }), 'dark');
	assert.equal(resolveMermaidTheme({ theme: 'system', systemPrefersDark: false }), 'neutral');
	// A VS Code theme reports its polarity through the dataset instead.
	assert.equal(
		resolveMermaidTheme({ theme: 'vscode:whatever', datasetThemeType: 'dark', systemPrefersDark: false }),
		'dark',
	);
});

test('the source is kept on the container so the diagram can be rebuilt', () => {
	const element = diagram('flowchart TD\n A --> B', '<svg>screen</svg>');
	assert.equal(readDiagramSource(asElement(element)), 'flowchart TD\n A --> B');
	assert.equal(findRestorableDiagrams(new FakeRoot([element]) as unknown as ParentNode).length, 1);
	// A diagram rendered before this change carries no source and is skipped
	// rather than blanked.
	assert.equal(findRestorableDiagrams(new FakeRoot([diagram(null, '<svg/>')]) as unknown as ParentNode).length, 0);
});

test('exporting re-renders with the print theme and then restores the screen rendering', async () => {
	const first = diagram('sequenceDiagram\n A->>B: hi', '<svg>dark-1</svg>');
	const second = diagram('flowchart TD\n A --> B', '<svg>dark-2</svg>');
	const mermaid = makeMermaid((source) => `<svg>light:${source.split('\n')[0]}</svg>`);

	const restore = await renderDiagramsForPrint({
		root: new FakeRoot([first, second]) as unknown as ParentNode,
		mermaid,
		sanitizeSvg: (svg) => svg,
		screenTheme: 'dark',
		idFactory: (index) => `id-${index}`,
	});

	assert.equal(first.innerHTML, '<svg>light:sequenceDiagram</svg>');
	assert.equal(second.innerHTML, '<svg>light:flowchart TD</svg>');
	// Spelled out rather than compared against the constant the implementation
	// reads. `[MERMAID_PRINT_THEME]` is satisfied by whatever that constant
	// happens to say, so retheming the whole print path dark passes it — which
	// is the one thing this file exists to prevent. The literal is the claim:
	// paper gets the light theme.
	assert.deepEqual(mermaid.themes, ['neutral']);

	restore();
	assert.equal(first.innerHTML, '<svg>dark-1</svg>');
	assert.equal(second.innerHTML, '<svg>dark-2</svg>');
	assert.deepEqual(mermaid.themes, ['neutral', 'dark']);

	// Restoring twice must not re-run initialize or clobber a later render.
	first.innerHTML = '<svg>re-rendered later</svg>';
	restore();
	assert.equal(first.innerHTML, '<svg>re-rendered later</svg>');
	assert.deepEqual(mermaid.themes, ['neutral', 'dark']);
});

test('a diagram that fails to re-render keeps its screen rendering', async () => {
	const element = diagram('broken', '<svg>dark</svg>');
	const errors: unknown[] = [];
	const mermaid = {
		themes: [] as string[],
		initialize(config: { startOnLoad: boolean; theme: string }) {
			this.themes.push(config.theme);
		},
		async render(): Promise<{ svg: string }> {
			throw new Error('bad diagram');
		},
	};

	const restore = await renderDiagramsForPrint({
		root: new FakeRoot([element]) as unknown as ParentNode,
		mermaid,
		sanitizeSvg: (svg) => svg,
		screenTheme: 'dark',
		onError: (error) => errors.push(error),
	});

	assert.equal(element.innerHTML, '<svg>dark</svg>');
	assert.equal(errors.length, 1);
	restore();
	assert.equal(element.innerHTML, '<svg>dark</svg>');
});

test('the helper is inert when there is nothing to re-render', async () => {
	// Both early returns. `typeof restore === 'function'` used to stand in for
	// "inert" here, after the handle had already been called — so it could not
	// be the assertion that fires, and nothing observed what the handle did.
	// What has to hold is that the export's `finally` can call it without
	// re-theming Mermaid or touching the DOM.

	// No renderer: the diagram under the root must be left exactly as it is.
	const untouched = diagram('flowchart TD\n A --> B', '<svg>screen</svg>');
	const withoutRenderer = await renderDiagramsForPrint({
		root: new FakeRoot([untouched]) as unknown as ParentNode,
		mermaid: null,
		sanitizeSvg: (svg) => svg,
		screenTheme: 'dark',
	});
	withoutRenderer();
	assert.equal(untouched.innerHTML, '<svg>screen</svg>');

	// A root with no restorable diagrams: Mermaid must not be reconfigured at
	// all, in either direction. An export of a document without diagrams that
	// re-initializes Mermaid twice is a global side effect for nothing.
	const mermaid = makeMermaid((source) => `<svg>${source}</svg>`);
	const withoutDiagrams = await renderDiagramsForPrint({
		root: new FakeRoot([]) as unknown as ParentNode,
		mermaid,
		sanitizeSvg: (svg) => svg,
		screenTheme: 'dark',
	});
	assert.deepEqual(mermaid.themes, [], 'nothing to re-render must not re-theme mermaid');
	withoutDiagrams();
	assert.deepEqual(mermaid.themes, [], 'the inert restore must not re-theme mermaid either');
});

test('the PDF export wraps the print render and always restores', () => {
	// Whatever the restore handle is called, a `finally` has to call it — an
	// export that throws between the print render and the restore would otherwise
	// leave every diagram on screen stuck in the print theme.
	const handle = viewer.match(/(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*await renderDiagramsForPrint\(/);
	assert.ok(handle, 'the PDF export must take a restore handle from renderDiagramsForPrint');
	assert.match(
		viewer,
		new RegExp(`\\}\\s*finally\\s*\\{[^}]*\\b${handle![1]}\\(\\)`),
		'the restore must run from a finally block',
	);

	// The screen render must record the source, or there is nothing to rebuild.
	// It moved into the shared renderer in #4xx, when the HTML export started
	// calling the same function; the assertion follows it rather than being
	// relaxed, because "some path renders diagrams without remembering the
	// source" is exactly the drift that deleted the markdown.ts copy.
	//
	// The theme it was drawn with is recorded alongside it now. That is not for
	// this path — `renderDiagramsForPrint` swaps the print rendering in and the
	// screen one back out, and never writes the attribute — it is what lets
	// `renderRichContent` find the diagrams a theme change left behind.
	assert.match(richContent, /rememberDiagramSource\(\s*\w+\s*,\s*\w+\s*,[^)]*\)/);

	// One theme decision, shared by the screen render and the restore. Asserted
	// as "both options are fed the same expression" rather than as the literal
	// `currentMermaidTheme()`: what must not drift is that the two agree, and the
	// private helper producing the value is free to be renamed or inlined. The
	// rest of the config is free too — it moved into `mermaidConfig` so the print
	// pass could not send a different one — so the match reaches into the call
	// rather than requiring an object literal in it.
	assert.match(
		richContent,
		/mermaid\.initialize\([^)]*\w+\.mermaidTheme\b/,
		'the shared renderer must use the theme it was handed, not resolve its own',
	);
	const screenTheme = viewer.match(/\bscreenTheme:\s*([^,\n]+),/);
	assert.ok(screenTheme, 'the print render must be told the screen theme so it can restore it');

	// Every render, not "some render". The component hands `mermaidTheme` to the
	// shared renderer twice — once for the live preview, once for the HTML
	// export — and asserting that the expression appears *somewhere* in the file
	// is satisfied by either one of them. Diverting only the preview left this
	// green, which is precisely the divergence that makes the print restore put
	// back a theme the preview is no longer using.
	const renderThemes = [...viewer.matchAll(/\bmermaidTheme:\s*([^,\n]+),/g)].map((match) => match[1]);
	assert.ok(
		renderThemes.length >= 2,
		'the preview render and the HTML export both hand the shared renderer a theme',
	);
	assert.deepEqual(
		renderThemes.filter((expression) => expression !== screenTheme![1]),
		[],
		`every diagram render must resolve the theme the way the print restore does (${screenTheme![1]})`,
	);
});
