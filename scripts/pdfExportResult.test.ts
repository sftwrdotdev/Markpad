/**
 * #968: a Windows PDF export ran with nothing on screen, so a reader could not
 * tell it from a finished one. `exportAsPdf` now says when the work starts and
 * which file it wrote, and the viewer turns those into a toast and the open
 * prompt the HTML export already had.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { plainAppearance } from './exportFixtures.ts';
import { installShimDom } from './renderProtocolDom.ts';

// As in `exportPreviewAppearance.test.ts`: the shim precedes the module.
installShimDom();
(globalThis as any).window = globalThis;
(globalThis as any).location = { href: 'http://tauri.localhost/' };
(globalThis as any).addEventListener = () => {};

const DOMPurify = (await import('dompurify')).default as any;
DOMPurify.sanitize = (html: string) => html;

const { exportAsPdf } = await import('../src/lib/utils/export.ts');

function exportWith(osType: 'windows' | 'macos', savePath: string | null) {
	const events: string[] = [];
	(globalThis as any).window.__TAURI_INTERNALS__ = {
		invoke: async (command: string, args: any) => {
			events.push(command);
			if (command === 'plugin:dialog|save') return savePath;
			if (command === 'render_markdown') return '<p>body</p>';
			if (command === 'export_pdf_windows') {
				assert.equal(args.path, savePath);
				return null;
			}
			if (command === 'print_pdf') return null;
			throw new Error(`unexpected command ${command}`);
		},
	};
	const result = exportAsPdf({
		rawContent: 'body\n',
		tabTitle: 'Notes',
		tabPath: 'C:/Docs/notes.md',
		mermaidTheme: 'neutral',
		libraries: {
			hljs: { getLanguage: () => null },
			katex: { renderToString: () => '' },
			renderMathInElement() {},
			mermaid: { initialize() {}, async render() { return { svg: '' }; } },
		} as any,
		contentWidth: null,
		appearance: plainAppearance,
		osType,
		printRoot: {
			style: { setProperty() {} },
			replaceChildren() {},
			querySelectorAll: () => [],
		} as any,
		onStart: () => events.push('start'),
	});
	return { result, events };
}

test('a Windows export reports its start, then the file it wrote', async () => {
	const { result, events } = exportWith('windows', 'C:/Docs/notes.pdf');
	assert.equal(await result, 'C:/Docs/notes.pdf');
	assert.deepEqual(
		events.filter((e) => e !== 'render_markdown'),
		['plugin:dialog|save', 'start', 'export_pdf_windows'],
	);
});

test('cancelling the Windows save dialog starts nothing', async () => {
	const { result, events } = exportWith('windows', null);
	assert.equal(await result, null);
	assert.deepEqual(events, ['plugin:dialog|save']);
});

test('the print sheet owns the path, so there is no file to report', async () => {
	const { result, events } = exportWith('macos', null);
	assert.equal(await result, null);
	assert.deepEqual(
		events.filter((e) => e !== 'render_markdown'),
		['start', 'print_pdf'],
	);
});
