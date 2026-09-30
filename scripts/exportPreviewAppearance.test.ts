/**
 * #932: a custom Preview font reached neither export, and neither did the code
 * font, its size or the highlight colour. All of them are inline styles on the
 * live preview, on elements the exported article is not inside.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { fontFamilyValue } from '../src/lib/utils/fontFamily.js';
import { plainAppearance } from './exportFixtures.ts';
import { installShimDom } from './renderProtocolDom.ts';

// As in `exportContentWidth.test.ts`: the shim precedes the module.
installShimDom();
(globalThis as any).window = globalThis;
(globalThis as any).location = { href: 'http://tauri.localhost/' };
(globalThis as any).addEventListener = () => {};

const DOMPurify = (await import('dompurify')).default as any;
DOMPurify.sanitize = (html: string) => html;

const { buildExportDocument, exportAsPdf } = await import('../src/lib/utils/export.ts');

const appearance = {
	fontFamily: fontFamilyValue('Georgia', 'sans-serif'),
	fontSize: 20,
	codeFontFamily: fontFamilyValue('Menlo', 'monospace'),
	codeFontSize: 18,
	highlightColor: 'rgba(67, 138, 243, 0.4)',
};
const declared = {
	'font-family': '"Georgia", sans-serif',
	'font-size': '20px',
	'--code-font': '"Menlo", monospace',
	'--code-font-size': '18px',
	'--highlight-color': 'rgba(67, 138, 243, 0.4)',
};

function exportedDocument(appearance_: typeof appearance, styles = ''): string {
	return buildExportDocument({
		theme: 'light',
		title: 'Notes',
		styles,
		articleHtml: '<p>body</p>',
		contentWidth: null,
		appearance: appearance_,
	});
}

test('an exported HTML file carries the preview appearance', () => {
	// The app's own `.markdown-body` rule travels in the copied stylesheet at
	// the same specificity, so the export's has to come after it to win.
	const appRule = '.markdown-body { font-family: -apple-system; font-size: 16px; }';
	const file = exportedDocument(appearance, appRule);
	const own = /\.markdown-body \{([^}]*)\}/.exec(file.slice(file.indexOf(appRule) + appRule.length))?.[1] ?? '';
	for (const [property, value] of Object.entries(declared)) {
		assert.ok(own.includes(`\t${property}: ${value};`), `${property} must be ${value}`);
	}
});

test('a font name cannot close the exported stylesheet', () => {
	const file = exportedDocument({
		...plainAppearance,
		fontFamily: fontFamilyValue('x</style><p>injected</p>', 'sans-serif'),
	});
	assert.equal(file.split('</style>').length - 1, 1);
});

test('a PDF is printed in the preview appearance', async () => {
	const style = new Map<string, string>();
	let printedWith: Record<string, string> | null = null;
	(globalThis as any).window.__TAURI_INTERNALS__ = {
		invoke: async (command: string) => {
			if (command === 'render_markdown') return '<p>body</p>';
			if (command === 'print_pdf') {
				printedWith = Object.fromEntries(style);
				return null;
			}
			throw new Error(`unexpected command ${command}`);
		},
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
		appearance,
		osType: 'macos',
		// The element is the viewer's; only what `exportAsPdf` touches is stood in.
		printRoot: {
			style: { setProperty: (property: string, value: string) => style.set(property, value) },
			replaceChildren() {},
			querySelectorAll: () => [],
		} as any,
	});

	assert.deepEqual(printedWith, { '--preview-max-width': 'none', ...declared });
});
