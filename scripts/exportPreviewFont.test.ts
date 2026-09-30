/**
 * #932: a custom Preview font reached neither export. The font and its size
 * are inline styles on the live preview's `<article>`, and both exports ship
 * the article's children, so the declaration stayed behind on screen.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { fontFamilyValue } from '../src/lib/utils/fontFamily.js';
import { installShimDom } from './renderProtocolDom.ts';

// As in `exportContentWidth.test.ts`: the shim precedes the module.
installShimDom();
(globalThis as any).window = globalThis;
(globalThis as any).location = { href: 'http://tauri.localhost/' };
(globalThis as any).addEventListener = () => {};

const DOMPurify = (await import('dompurify')).default as any;
DOMPurify.sanitize = (html: string) => html;

const { buildExportDocument, exportAsPdf } = await import('../src/lib/utils/export.ts');

const georgia = fontFamilyValue('Georgia', 'sans-serif');

function exportedDocument(fontFamily: string, styles = ''): string {
	return buildExportDocument({
		theme: 'light',
		title: 'Notes',
		styles,
		articleHtml: '<p>body</p>',
		contentWidth: null,
		fontFamily,
		fontSize: 20,
	});
}

test('an exported HTML file carries the preview font and size', () => {
	// The app's own `.markdown-body` rule travels in the copied stylesheet at
	// the same specificity, so the export's has to come after it to win.
	const appRule = '.markdown-body { font-family: -apple-system; font-size: 16px; }';
	const file = exportedDocument(georgia, appRule);
	const own = file.slice(file.indexOf(appRule) + appRule.length);
	assert.match(own, /\.markdown-body \{[^}]*font-family: "Georgia", sans-serif;/);
	assert.match(own, /\.markdown-body \{[^}]*font-size: 20px;/);
});

test('a font name cannot close the exported stylesheet', () => {
	const file = exportedDocument(fontFamilyValue('x</style><p>injected</p>', 'sans-serif'));
	assert.equal(file.split('</style>').length - 1, 1);
});

test('a PDF is printed in the preview font and size', async () => {
	const printed: string[] = [];
	(globalThis as any).window.__TAURI_INTERNALS__ = {
		invoke: async (command: string) => {
			if (command === 'render_markdown') return '<p>body</p>';
			if (command === 'print_pdf') {
				printed.push(`${printRoot.style.fontFamily} / ${printRoot.style.fontSize}`);
				return null;
			}
			throw new Error(`unexpected command ${command}`);
		},
	};
	// The element is the viewer's; only what `exportAsPdf` touches is stood in.
	const printRoot = {
		style: { setProperty() {}, fontFamily: '', fontSize: '' },
		replaceChildren() {},
		querySelectorAll: () => [],
	};

	await exportAsPdf({
		rawContent: 'body\n',
		tabTitle: 'Notes',
		tabPath: '/documents/notes.md',
		mermaidTheme: 'neutral',
		libraries: {
			hljs: { getLanguage: () => null },
			katex: { renderToString: () => '' },
			renderMathInElement() {},
			mermaid: { initialize() {}, async render() { return { svg: '' }; } },
		} as any,
		contentWidth: null,
		fontFamily: georgia,
		fontSize: 20,
		osType: 'macos',
		printRoot: printRoot as any,
	});

	assert.deepEqual(printed, ['"Georgia", sans-serif / 20px']);
});
