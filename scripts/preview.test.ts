import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { anchorIdCandidates, getMarkdownLinkTarget, resolveMarkdownTargetPath } from '../src/lib/utils/markdownLinks.js';
import { asBufferLine, asRendererLine, type BufferLine, lineCoordinates } from '../src/lib/utils/lineCoordinates.ts';
import { opensInNewTab } from '../src/lib/utils/shortcuts.js';
import { resolveLocalFileLinkPath } from '../src/lib/utils/localFileLinks.js';
import { type KeyContext, viewerCommandFor } from '../src/lib/utils/viewerKeymap.js';
import { viewerCommandTable } from './keymapHarness.js';
import { adjustPreviewMaxWidth, DEFAULT_PREVIEW_MAX_WIDTH, getPreviewContentWidth, getStoredPreviewFullWidth, MAX_PREVIEW_MAX_WIDTH, MIN_PREVIEW_MAX_WIDTH, normalizePreviewMaxWidth } from '../src/lib/utils/previewWidth.js';
import { normalizeAssetPath } from '../src/lib/utils/exportHtml.js';
import { processMarkdownHtml } from '../src/lib/utils/markdown.ts';
import { parseHtml, type ShimElement } from './renderProtocolDom.ts';
import { useShimDom } from './preview.domShim.ts';

describe('footnote and heading anchor ids', () => {
	/*
	 * comrak writes the two kinds of same-document target differently. A heading
	 * id is the text as-is (`id="概述"`) and the link to it is percent-encoded
	 * (`href="#%E6%A6%82%E8%BF%B0"`), so the fragment has to be decoded to find
	 * it. A footnote id is percent-encoded in the id itself
	 * (`id="fn-%E6%B3%A8%E9%87%8A"`), so decoding the href loses it. The viewer's
	 * jump and hover tooltip look up every candidate this returns.
	 */

	test('a CJK heading link is found by its decoded id', () => {
		assert.ok(anchorIdCandidates('%E6%A6%82%E8%BF%B0').includes('概述'));
	});

	test('a CJK footnote and its back-link are found by the id as written', () => {
		for (const fragment of ['fn-%E6%B3%A8%E9%87%8A', 'fnref-%E6%B3%A8%E9%87%8A']) {
			assert.ok(anchorIdCandidates(fragment).includes(fragment), fragment);
		}
	});

	test('a block reference drops its caret and a malformed escape is kept', () => {
		assert.deepEqual(anchorIdCandidates('^abc'), ['abc']);
		assert.deepEqual(anchorIdCandidates('50%off'), ['50%off']);
	});
});

/**
 * The shift between the editor's line numbers and the preview's.
 *
 * `renderMarkdownPreview` hands comrak the body with the front matter stripped
 * off, so every `data-sourcepos` — and the outline, the tab's reading position
 * and both halves of scroll sync with it — counts from the first line of the
 * BODY, while the editor holds the whole file. The difference is exactly the
 * number of buffer lines the front matter occupies, and it is ZERO in a
 * document that has none.
 *
 * That zero is why this file exists. Every fixture in the suite this module was
 * extracted from was a document without front matter, so both numberings agreed
 * and a crossing that forgot to convert passed everything. The tests here are
 * the ones that only say something when the offset is not zero: the round trip
 * through both directions, the range, and — the half no arithmetic test can
 * reach — the trip out to a pixel in the preview and back.
 */
describe('buffer and renderer line coordinates', () => {
	/** Six buffer lines of YAML, so the body starts on buffer line 7. */
	const WITH_FRONT_MATTER = ['---', 'title: "T"', 'tags:', '  - a', '---', '', '# Title'].join('\n') + '\n';

	const FRONT_MATTER_LINES = 6;

	test('the offset is the number of buffer lines above the body', () => {
		assert.equal(lineCoordinates(WITH_FRONT_MATTER).frontMatterLines, FRONT_MATTER_LINES);
		assert.equal(lineCoordinates('# Title\n\nbody\n').frontMatterLines, 0);
		// `\r\n` contains a `\n`, so the count is the same one.
		assert.equal(lineCoordinates(['---', 'title: "T"', '---', '', '# Title'].join('\r\n') + '\r\n').frontMatterLines, 4);
	});

	test('the two directions are inverses, with front matter in the way', () => {
		const coords = lineCoordinates(WITH_FRONT_MATTER);

		// The heading is line 1 of the body and line 7 of the buffer.
		assert.equal(coords.toBufferLine(asRendererLine(1)), 7);
		assert.equal(coords.toRendererLine(asBufferLine(7)), 1);

		// And the round trip closes from either end. This is the assertion the old
		// suite could not have failed: with `frontMatterEnd = 0` everywhere, both
		// conversions were the identity and so was the composition of two wrong
		// ones.
		for (const line of [1, 2, 3, 40, 1_000, 13_419]) {
			assert.equal(coords.toBufferLine(coords.toRendererLine(asBufferLine(line))), line, `buffer line ${line}`);
			assert.equal(coords.toRendererLine(coords.toBufferLine(asRendererLine(line))), line, `renderer line ${line}`);
		}

		// A fractional line — scroll sync sends one on every event — shifts the same
		// way, because the offset is a whole number of lines whatever the fraction.
		assert.equal(coords.toBufferLine(asRendererLine(12.25)), 18.25);
		assert.equal(coords.toRendererLine(asBufferLine(18.25)), 12.25);
	});

	test('a document without front matter is left exactly where it is', () => {
		const coords = lineCoordinates('# Title\n\nbody\n');
		for (const line of [1, 17, 900]) {
			assert.equal(coords.toBufferLine(asRendererLine(line)), line);
			assert.equal(coords.toRendererLine(asBufferLine(line)), line);
		}
	});

	test('a range shifts at both ends, so it still covers the same text', () => {
		const coords = lineCoordinates(WITH_FRONT_MATTER);
		assert.deepEqual(coords.toBufferRange({ startLine: 1, endLine: 4 }), { startLine: 7, endLine: 10 });
		// Same width in, same width out: a range that grew or slid would open the
		// editor on the wrong lines even when its start happened to be right.
		assert.deepEqual(coords.toBufferRange({ startLine: 9, endLine: 9 }), { startLine: 15, endLine: 15 });
	});

	/* ------------------------------------------------------------------ */
	/* out to a pixel and back                                             */
	/* ------------------------------------------------------------------ */
	//
	// The other half of the module: the preview's own line <-> pixel mapping with
	// the shift applied around it, which is what the viewer calls on every scroll
	// event. A fake tree is enough here — `scrollSyncBlockMapping.test.ts` drives
	// the same pair over real `processMarkdownHtml` output — because what is under
	// test is the composition, not the descent.

	type FakeBlock = {
		nodeType: number;
		tagName: string;
		childNodes: FakeBlock[];
		getAttribute(name: string): string | null;
		top: number;
		height: number;
	};

	function block(line: number, top: number, height: number): FakeBlock {
		return {
			nodeType: 1,
			tagName: 'P',
			childNodes: [],
			getAttribute: (name) => (name === 'data-sourcepos' ? `${line}:1-${line}:10` : null),
			top,
			height,
		};
	}

	/**
	 * Three rendered blocks, on BODY lines 1, 5 and 9. They start 200px down
	 * because the front matter renders as a panel above them — which is the point:
	 * neither the pixels nor the `data-sourcepos` lines know anything about the six
	 * buffer lines of YAML the editor is holding.
	 */
	const BLOCKS = [block(1, 200, 40), block(5, 300, 40), block(9, 500, 60)];

	const ROOT: FakeBlock = {
		nodeType: 1,
		tagName: 'DIV',
		childNodes: BLOCKS,
		getAttribute: () => null,
		top: 0,
		height: 600,
	};

	const measure = (node: unknown) => ({ top: (node as FakeBlock).top, height: (node as FakeBlock).height });

	test('a preview offset answers in buffer lines, and takes them back', () => {
		const coords = lineCoordinates(WITH_FRONT_MATTER);

		// The first block is body line 1, which is buffer line 7.
		assert.equal(coords.bufferLineAtPreviewOffset(ROOT, 200, measure), 7);
		assert.equal(coords.previewOffsetForBufferLine(ROOT, asBufferLine(7), measure), 200);

		// Halfway between the first two samples in lines is halfway in pixels.
		assert.equal(coords.bufferLineAtPreviewOffset(ROOT, 250, measure), 9);
		assert.equal(coords.previewOffsetForBufferLine(ROOT, asBufferLine(9), measure), 250);

		// Every sample, both ways round.
		for (const line of [7, 9, 11, 13, 15] as BufferLine[]) {
			const offset = coords.previewOffsetForBufferLine(ROOT, line, measure);
			assert.ok(offset !== null, `no offset for buffer line ${line}`);
			assert.equal(coords.bufferLineAtPreviewOffset(ROOT, offset, measure), line, `buffer line ${line}`);
		}
	});

	test('the same preview, read without the shift, is six lines out', () => {
		// The control, and the defect this module exists to make unrepresentable: a
		// caller that treats the preview's own numbering as the editor's is off by
		// the height of the front matter everywhere, uniformly, however good the
		// block mapping underneath it is.
		const plain = lineCoordinates('# Title\n');
		assert.equal(plain.bufferLineAtPreviewOffset(ROOT, 200, measure), 1);
		assert.equal(
			lineCoordinates(WITH_FRONT_MATTER).bufferLineAtPreviewOffset(ROOT, 200, measure)! -
				plain.bufferLineAtPreviewOffset(ROOT, 200, measure)!,
			FRONT_MATTER_LINES,
		);
	});

	test('a preview with nothing annotated in it answers nothing, not line zero', () => {
		// The caller falls back to the proportional mapping on `null`. A `0` would
		// be a buffer line, and would send the pane to the top of the document.
		const coords = lineCoordinates(WITH_FRONT_MATTER);
		const empty: FakeBlock = { nodeType: 1, tagName: 'DIV', childNodes: [], getAttribute: () => null, top: 0, height: 0 };

		assert.equal(coords.bufferLineAtPreviewOffset(empty, 400, measure), null);
		assert.equal(coords.previewOffsetForBufferLine(empty, asBufferLine(12), measure), null);
	});
});

describe('link click target', () => {
	/*
	 * Issue #661: with `1.md` and `2.md` both open, clicking a link in `1.md` that
	 * points at `2.md` navigated the `1.md` tab onto that file — and the `2.md` tab
	 * disappeared.
	 *
	 * The disappearance is `TabManager.claimPath` holding its one-tab-per-path
	 * invariant, which is deliberate and documented: the losing tab was clean, so
	 * it is a copy of the file the winner now holds, and it goes on the
	 * reopen-closed-tab stack. The gap is upstream of it — `addTab` already
	 * resolves an open request to the tab that has the file ("VS Code and Sublime
	 * Text both resolve an open request to the existing view"), and the relative
	 * link was the one entry point that did not go through it.
	 *
	 * `opensInNewTab` is the whole decision this change adds, so these run the real
	 * code. Which function the click handler then calls is asserted by hand against
	 * a build; there is no seam in the component for a test to reach.
	 */

	const CLICK = { metaKey: false, ctrlKey: false };

	const CMD = { metaKey: true, ctrlKey: false };

	const CTRL = { metaKey: false, ctrlKey: true };

	test('the chord is the one the platform uses everywhere else', () => {
		// ⌘ on macOS. Ctrl there is the secondary click, so reading it would answer
		// one gesture with a context menu and a new tab at once.
		assert.equal(opensInNewTab('macos', CMD, false), true);
		assert.equal(opensInNewTab('macos', CTRL, false), false);

		// Ctrl elsewhere. Meta is the Super key and belongs to the window manager.
		for (const platform of ['windows', 'linux']) {
			assert.equal(opensInNewTab(platform, CTRL, false), true);
			assert.equal(opensInNewTab(platform, CMD, false), false);
		}
	});

	test('an os type that has not resolved yet still answers', () => {
		// `settings.osType` is `'unknown'` until the Tauri call returns, and a click
		// can land in that window. `modifierFor` sends everything that is not macOS
		// down the Ctrl branch, and this follows it rather than deciding again.
		assert.equal(opensInNewTab('unknown', CTRL, false), true);
		assert.equal(opensInNewTab('unknown', CMD, false), false);
	});

	test('the chord means the other one, not new tab', () => {
		// With the preference on, a plain click opens the tab and the chord is how
		// you navigate in place — which is the only thing that writes a tab's file
		// history, so the Back and Forward buttons stay reachable either way.
		assert.equal(opensInNewTab('macos', CLICK, true), true);
		assert.equal(opensInNewTab('macos', CMD, true), false);
		assert.equal(opensInNewTab('windows', CLICK, true), true);
		assert.equal(opensInNewTab('windows', CTRL, true), false);
	});

	test('a plain click keeps navigating this tab by default', () => {
		// The default this ships with: nothing about an existing install changes
		// until someone turns the preference on.
		assert.equal(opensInNewTab('macos', CLICK, false), false);
		assert.equal(opensInNewTab('windows', CLICK, false), false);
	});
});

describe('local file links', () => {
	/*
	 * `[data](./data.csv)` did nothing on macOS and Linux, and opened a dead page
	 * in the browser on Windows.
	 *
	 * The link is a path, but the click handler passed `anchor.href` — which the
	 * DOM had already resolved against the webview's own origin. That origin is
	 * `tauri://localhost` on macOS and Linux and `http://tauri.localhost` on
	 * Windows, and the opener plugin's scope allows `mailto:`, `tel:`, `http://*`
	 * and `https://*` (tauri-plugin-opener `allow-default-urls`). So the first
	 * form was rejected as ForbiddenUrl — and, because the call was not awaited
	 * inside a try/catch, the rejection went unhandled and the click was silent —
	 * while the second matched `http://*` and was genuinely handed to the browser.
	 *
	 * The resolver below is pure, so these run the real code. The wiring in the
	 * component is asserted against its source; those tests establish the order of
	 * the branches and that both OS calls are guarded, not what the OS then does.
	 */

	const CURRENT = '/notes/doc.md';

	test('a relative link resolves against the open file', () => {
		assert.equal(resolveLocalFileLinkPath('./data.csv', CURRENT), '/notes/data.csv');
		assert.equal(resolveLocalFileLinkPath('data.csv', CURRENT), '/notes/data.csv');
		assert.equal(resolveLocalFileLinkPath('../assets/report.pdf', CURRENT), '/assets/report.pdf');
		assert.equal(resolveLocalFileLinkPath('sub/dir/data.csv', CURRENT), '/notes/sub/dir/data.csv');
	});

	test('the path is decoded and stripped of URL decoration', () => {
		// The href in the document is percent-encoded markdown, not a filename.
		assert.equal(resolveLocalFileLinkPath('./my%20file.csv', CURRENT), '/notes/my file.csv');
		// A query string or fragment belongs to URLs; on disk they are part of no
		// filename, and leaving them on would look up a file that does not exist.
		assert.equal(resolveLocalFileLinkPath('./data.csv?v=2', CURRENT), '/notes/data.csv');
		assert.equal(resolveLocalFileLinkPath('./data.csv#row3', CURRENT), '/notes/data.csv');
	});

	test('absolute and Windows paths are taken as written', () => {
		assert.equal(resolveLocalFileLinkPath('/srv/shared/data.csv', CURRENT), '/srv/shared/data.csv');
		// A drive letter looks like a scheme and must not be treated as one.
		assert.equal(resolveLocalFileLinkPath('C:\\docs\\data.csv', CURRENT), 'C:/docs/data.csv');
		assert.equal(resolveLocalFileLinkPath('file:///tmp/data.csv', CURRENT), '/tmp/data.csv');
	});

	test('web addresses are left to the browser', () => {
		for (const href of [
			'https://example.com/data.csv',
			'http://example.com/data.csv',
			'mailto:someone@example.com',
			'tel:+15551234',
			'obsidian://open?vault=x',
			'data:text/csv;base64,YQ==',
			// Protocol-relative. The app already reads this as a web address for
			// markdown links, and reading it as a UNC path here would disagree.
			'//example.com/data.csv',
		]) {
			assert.equal(resolveLocalFileLinkPath(href, CURRENT), null, href);
		}
	});

	test('a UNC path is not opened from a link', () => {
		// Opening `\\host\share\x` makes Windows connect to `host` over SMB and
		// offer the user's NTLM credentials, so one click on a link in a document
		// leaks a password hash to whoever wrote it. `//host` was already refused
		// as a web address; the backslash and encoded spellings reached the same
		// UNC path through the image resolver.
		for (const href of [
			'\\\\evil.example\\share\\x.exe',
			'\\\\evil.example/share/x.exe',
			'%5C%5Cevil.example%5Cshare%5Cx.exe',
			'/\\evil.example\\share\\x.exe',
		]) {
			assert.equal(resolveLocalFileLinkPath(href, CURRENT), null, href);
		}
		// A document that itself lives on a share keeps its relative links, as
		// long as they stay on that host.
		assert.equal(
			resolveLocalFileLinkPath('./data.csv', '//server/share/doc.md'),
			'//server/share/data.csv',
		);
		assert.equal(resolveLocalFileLinkPath('../../evil/x.exe', '//server/share/doc.md'), null);
	});

	test('an in-page anchor is not a file', () => {
		assert.equal(resolveLocalFileLinkPath('#section', CURRENT), null);
		assert.equal(resolveLocalFileLinkPath('', CURRENT), null);
		assert.equal(resolveLocalFileLinkPath('   ', CURRENT), null);
	});

	test('an unsaved buffer has nothing to resolve a relative link against', () => {
		// `resolveDocumentRelativePath('', './data.csv')` yields `data.csv`, which the OS would
		// open relative to the process's working directory — some arbitrary file,
		// or none. Refusing is the only honest answer.
		assert.equal(resolveLocalFileLinkPath('./data.csv', ''), null);
		assert.equal(resolveLocalFileLinkPath('data.csv', ''), null);
		// An absolute link still names exactly one file.
		assert.equal(resolveLocalFileLinkPath('/srv/data.csv', ''), '/srv/data.csv');
		assert.equal(resolveLocalFileLinkPath('C:\\data.csv', ''), 'C:/data.csv');
	});

	test('a markdown link still resolves to a path, so branch order is what keeps it in-app', () => {
		// Opening `./other.md` in a tab is a different, older feature. This
		// resolver cannot tell the two apart and must not try to; the click handler
		// asks about markdown targets first. The next test pins that order.
		assert.equal(resolveLocalFileLinkPath('./other.md', CURRENT), '/notes/other.md');
	});

	test('an asset URL is never treated as a link to a local file', () => {
		// `resolveExportImagePath` accepts `asset://localhost/…` and
		// `http://asset.localhost/…` on purpose: that is the shape a local image's
		// `src` takes inside the webview, and the exporter has to turn it back into
		// a disk path to inline the bytes. A *link* is the opposite situation — the
		// href is the author's own text — so inheriting that clause let a document
		// write a link that reads as a remote address in the link text and the
		// status bar while resolving to a local path and going to the OS default
		// handler.
		for (const href of [
			'http://asset.localhost/etc/passwd',
			'https://asset.localhost/Users/me/.ssh/id_rsa',
			'http://asset.localhost/C:/Windows/System32/drivers/etc/hosts',
			'asset://localhost/etc/hosts',
			'ASSET://LOCALHOST/etc/hosts',
			'HTTP://ASSET.LOCALHOST/etc/passwd',
		]) {
			assert.equal(resolveLocalFileLinkPath(href, CURRENT), null, href);
		}

		// The host is matched as a whole label, so a lookalike is a plain remote
		// address and was never in scope — asserted so a future loosening of the
		// pattern cannot pass this file.
		assert.equal(resolveLocalFileLinkPath('http://asset.localhost.evil.test/etc/passwd', CURRENT), null);

		// Ordinary links keep working: this guard must not swallow them.
		assert.equal(resolveLocalFileLinkPath('./data.csv', CURRENT), '/notes/data.csv');
		assert.equal(resolveLocalFileLinkPath('https://example.com/page', CURRENT), null);
	});
});

describe('preview width', () => {
	test('preview width defaults and clamps persisted numeric values', () => {
		assert.equal(DEFAULT_PREVIEW_MAX_WIDTH, 880);
		assert.equal(normalizePreviewMaxWidth(null), DEFAULT_PREVIEW_MAX_WIDTH);
		assert.equal(normalizePreviewMaxWidth('not-a-number'), DEFAULT_PREVIEW_MAX_WIDTH);
		assert.equal(normalizePreviewMaxWidth('639'), MIN_PREVIEW_MAX_WIDTH);
		assert.equal(normalizePreviewMaxWidth('1601'), MAX_PREVIEW_MAX_WIDTH);
		assert.equal(normalizePreviewMaxWidth('921.8'), 922);
	});

	test('preview width accepts only finite numeric values', () => {
		assert.equal(normalizePreviewMaxWidth(Number.NaN), DEFAULT_PREVIEW_MAX_WIDTH);
		assert.equal(normalizePreviewMaxWidth(Number.POSITIVE_INFINITY), DEFAULT_PREVIEW_MAX_WIDTH);
		assert.equal(normalizePreviewMaxWidth(1200), 1200);
	});

	test('full mode has no configured content-width cap', () => {
		assert.equal(getPreviewContentWidth(1200, false), 1200);
		assert.equal(getPreviewContentWidth(1200, true), null);
	});

	test('preview width shortcut adjustments retain the configured bounds', () => {
		assert.equal(adjustPreviewMaxWidth(DEFAULT_PREVIEW_MAX_WIDTH, 40), 920);
		assert.equal(adjustPreviewMaxWidth(MIN_PREVIEW_MAX_WIDTH, -40), MIN_PREVIEW_MAX_WIDTH);
		assert.equal(adjustPreviewMaxWidth(MAX_PREVIEW_MAX_WIDTH, 40), MAX_PREVIEW_MAX_WIDTH);
	});

	test('the dedicated full-width preference takes priority over its legacy key', () => {
		assert.equal(getStoredPreviewFullWidth('true', 'false'), true);
		assert.equal(getStoredPreviewFullWidth('false', 'true'), false);
		assert.equal(getStoredPreviewFullWidth(null, 'true'), true);
		assert.equal(getStoredPreviewFullWidth(null, null), false);
	});

	test('preview width keyboard shortcuts avoid editable controls and app modals', () => {
		// Six source-shape assertions until the dispatcher got its own module: two
		// about a chord condition, three about a function signature and its body,
		// one about the width arithmetic. Four of them are questions the imported
		// functions can be asked directly.
		const reading: KeyContext = {
			mode: 'app',
			osType: 'windows',
			isSplit: false,
			overlayOpen: false,
			dialogOpen: false,
			isEditing: false,
			editorHasFocus: false,
		};
		const chord = (code: string) => ({ key: code === 'BracketLeft' ? '[' : ']', code, ctrlKey: true, metaKey: false, shiftKey: false, altKey: true });

		// The chord, and which way round the two keys go — never checked before,
		// because both keys matched the same line of text.
		assert.equal(viewerCommandFor(chord('BracketLeft'), reading), 'preview-width-narrower');
		assert.equal(viewerCommandFor(chord('BracketRight'), reading), 'preview-width-wider');
		// And nothing else on that chord: no Alt, or an extra Shift, is a different
		// gesture and must not resize the preview.
		assert.equal(viewerCommandFor({ ...chord('BracketLeft'), altKey: false }, reading), null);
		assert.equal(viewerCommandFor({ ...chord('BracketLeft'), shiftKey: true }, reading), null);

		// An overlay in front, or the editor alone on screen, and the chord is not
		// the preview's to answer.
		assert.equal(viewerCommandFor(chord('BracketLeft'), { ...reading, overlayOpen: true }), null);
		assert.equal(viewerCommandFor(chord('BracketLeft'), { ...reading, isEditing: true }), null);
		// …but split view puts the preview back on screen, so it applies again.
		assert.equal(
			viewerCommandFor(chord('BracketLeft'), { ...reading, isEditing: true, isSplit: true }),
			'preview-width-narrower',
		);

		// The text-field carve-out needs a real DOM and a real selector match, so it
		// is asserted in `viewerKeymap.spec.ts` under jsdom rather than faked here.

		// What the command DOES stays in the component — the seam ends at the name.
		// See the note on `viewerCommandTable` in `keymapHarness.ts`.
		const narrower = viewerCommandTable()['preview-width-narrower'];
		assert.match(narrower, /settings\.previewFullWidth = false/);
		assert.match(
			narrower,
			/settings\.previewMaxWidth = adjustPreviewMaxWidth\(\s*settings\.previewMaxWidth,\s*command === 'preview-width-narrower' \? -40 : 40,?\s*\)/,
		);
	});
});

describe('save image as', () => {
	test('a Windows asset URL names the same file as the asset: form', () => {
		// The property the old `startsWith('asset:')` test lacked. Running it here
		// rather than trusting the import means a future change to
		// `normalizeAssetPath` that dropped the Windows spelling would fail this
		// suite as well as the export's.
		assert.equal(
			normalizeAssetPath('http://asset.localhost/C%3A%2FDocs%2Fimg%2Fa.png'),
			'C:/Docs/img/a.png',
		);
		assert.equal(
			normalizeAssetPath('asset://localhost/C:/Docs/img/a.png'),
			'C:/Docs/img/a.png',
		);
	});

	test('a host that merely starts with asset.localhost is not a local file', () => {
		// The reason to reuse the helper instead of writing
		// `src.startsWith('http://asset.localhost')` here: that test would accept
		// this, and hand `copy_file` a path taken from a page the document links to.
		assert.equal(normalizeAssetPath('http://asset.localhost.evil.test/C:/secret.png'), null);
		assert.equal(normalizeAssetPath('https://example.com/a.png'), null);
		assert.equal(normalizeAssetPath('data:image/png;base64,AAA'), null);
	});
});

describe('UNC host guard', () => {
	// `convertFileSrc` forwards to the Tauri runtime; stand in for it with the
	// shape it produces so the test can see which paths were handed over.
	useShimDom({
		window: {
			__TAURI_INTERNALS__: {
				convertFileSrc: (path: string, protocol: string) => `${protocol}://localhost/${encodeURIComponent(path)}`,
			},
		},
	});

	function mediaSrcs(html: string, filePath: string): (string | null)[] {
		const root = parseHtml(processMarkdownHtml(html, filePath, new Set()));
		return (root.querySelectorAll('img, video, audio') as unknown as ShimElement[]).map((el) =>
			el.getAttribute('src'),
		);
	}

	test('an image on another host is not loaded', () => {
		// No click needed: rendering the document is enough to fetch it.
		for (const src of [
			'//evil.example/share/a.png',
			'%2F%2Fevil.example%2Fshare%2Fa.png',
			'/%5Cevil.example%5Cshare%5Ca.png',
		]) {
			for (const doc of ['C:\\notes\\doc.md', '/notes/doc.md', '//server/share/doc.md']) {
				const [out] = mediaSrcs(`<p><img src="${src}"></p>`, doc);
				assert.ok(!out, `${src} in ${doc} became ${out}`);
			}
		}
		// An unsaved buffer has no directory: `\\evil\…` split on `\` and joined
		// onto nothing comes out as `//evil/…`.
		const [unsaved] = mediaSrcs('<p><img src="%5C%5Cevil.example%5Cshare%5Ca.png"></p>', '');
		assert.ok(!unsaved, `unsaved buffer loaded ${unsaved}`);
	});

	test('audio and video on another host are not loaded either', () => {
		for (const src of ['//evil.example/share/a.mp4', '//evil.example/share/a.mp3']) {
			const [out] = mediaSrcs(`<p><img src="${src}"></p>`, 'C:\\notes\\doc.md');
			assert.ok(!out, `${src} became ${out}`);
		}
	});

	test('a document on a share still loads its own images', () => {
		const [relative] = mediaSrcs('<p><img src="img/a.png"></p>', '\\\\server\\share\\notes\\doc.md');
		assert.equal(relative, `asset://localhost/${encodeURIComponent('//server/share/notes/img/a.png')}`);
		const [absolute] = mediaSrcs('<p><img src="//SERVER/other/a.png"></p>', '//server/share/doc.md');
		assert.equal(absolute, `asset://localhost/${encodeURIComponent('//SERVER/other/a.png')}`);
		// And a document on a local disk still loads local images.
		const [local] = mediaSrcs('<p><img src="img/a.png"></p>', 'C:\\notes\\doc.md');
		assert.equal(local, `asset://localhost/${encodeURIComponent('C:/notes/img/a.png')}`);
		const [video] = mediaSrcs('<p><img src="clip.mp4"></p>', '//server/share/doc.md');
		assert.equal(video, `asset://localhost/${encodeURIComponent('//server/share/clip.mp4')}`);
	});

	function markdownTarget(href: string, currentFile: string): string | null {
		const target = getMarkdownLinkTarget(href);
		return target && resolveMarkdownTargetPath(currentFile, target);
	}

	test('a markdown link to a document on another host is not opened', () => {
		// comrak writes `\` in a destination as `%5C`, and `getMarkdownLinkTarget`
		// decodes it, so `//host` being refused did not cover `\\host`.
		for (const href of [
			'%5C%5Cevil.example%5Cshare%5Cx.md',
			'%2F%2Fevil.example%2Fshare%2Fx.md',
			'/%5Cevil.example%5Cshare%5Cx.md',
		]) {
			for (const doc of ['C:\\notes\\doc.md', '/notes/doc.md', '//server/share/doc.md', '']) {
				assert.equal(markdownTarget(href, doc), null, `${href} from ${doc}`);
			}
		}
	});

	test('a document on a share still opens the documents beside it', () => {
		assert.equal(markdownTarget('other.md', '\\\\server\\share\\doc.md'), '//server/share/other.md');
		assert.equal(markdownTarget('%5C%5Cserver%5Cshare%5Cx.md', '//server/share/doc.md'), '\\\\server\\share\\x.md');
		assert.equal(markdownTarget('other.md', 'C:\\notes\\doc.md'), 'C:/notes/other.md');
		assert.equal(markdownTarget('/notes/other.md', '/notes/doc.md'), '/notes/other.md');
	});

	test('a device path counts by the host it names', () => {
		// `\\?\UNC\host\…` is a UNC path on `host`; `\\?\C:\…` is a local one. Read
		// naively, both had the host `?`, so a document opened by a device path let
		// every `\\?\UNC\…` path through.
		for (const doc of ['\\\\?\\C:\\notes\\a.md', '//./C:/notes/a.md']) {
			const [out] = mediaSrcs('<p><img src="//?/UNC/evil/s/a.png"></p>', doc);
			assert.ok(!out, `device UNC image from ${doc} became ${out}`);
		}
		const [same] = mediaSrcs('<p><img src="img.png"></p>', '\\\\?\\UNC\\server\\share\\doc.md');
		assert.ok(same, 'a document on a share opened by its device path lost its own image');
	});
});

describe('YouTube external fallback', () => {
	useShimDom();

	// A YouTube link used to become an <iframe>, which meant the app had to allow
	// framing youtube.com and the video played inside Markpad. It is now a
	// thumbnail wrapped in an ordinary anchor, opened in the user's browser. The
	// two halves have to stay in step: rendering an iframe again with the CSP
	// closed produces a blank rectangle, and reopening the CSP for a renderer that
	// no longer frames anything just widens the attack surface for nothing.
	//
	// This was asserted by matching markdown.ts for the shape of
	// `replaceWithYoutubeLink` — its signature, each assignment inside it, and
	// `doesNotMatch(/createElement\(["']iframe["']\)/)`. All of that describes how
	// the function is written. `processMarkdownHtml` is exported and the suite has
	// a DOM shim, so what it produces can be looked at instead.

	const VIDEO = 'dQw4w9WgXcQ';

	 // 11 chars, which is what getYoutubeId requires

	function render(html: string) {
		return parseHtml(processMarkdownHtml(html, '/doc.md', new Set()));
	}

	test('a YouTube link on its own becomes a thumbnail anchor, not a frame', () => {
		const root = render(`<p><a href="https://www.youtube.com/watch?v=${VIDEO}">watch this</a></p>`);

		const link = root.querySelector('a.youtube-link') as unknown as ShimElement | null;
		assert.ok(link, 'the anchor is rewritten rather than left alone');
		assert.equal(link.getAttribute('href'), `https://www.youtube.com/watch?v=${VIDEO}`, 'it still points at YouTube');
		assert.ok(link.getAttribute('aria-label'), 'and it says where it goes, since the text is now an image');

		const thumbnail = link.querySelector('img') as unknown as ShimElement | null;
		assert.ok(thumbnail, 'the visible content is the poster frame');
		assert.equal(thumbnail.getAttribute('src'), `https://i.ytimg.com/vi/${VIDEO}/hqdefault.jpg`);

		assert.equal(root.querySelectorAll('iframe').length, 0, 'nothing is framed');
	});

	test('every recognised YouTube spelling gets the same treatment', () => {
		// `youtube.com/embed/` in particular: it is the URL people paste FROM an
		// embed snippet, and the one most likely to be handled by the old frame
		// path if the detection list ever splits in two.
		for (const href of [
			`https://www.youtube.com/watch?v=${VIDEO}`,
			`https://www.youtube.com/embed/${VIDEO}`,
			`https://www.youtube.com/v/${VIDEO}`,
			`https://youtu.be/${VIDEO}`,
		]) {
			const root = render(`<p><a href="${href}">link</a></p>`);
			const link = root.querySelector('a.youtube-link') as unknown as ShimElement | null;
			assert.ok(link, `${href} is recognised`);
			assert.equal(
				(link.querySelector('img') as unknown as ShimElement).getAttribute('src'),
				`https://i.ytimg.com/vi/${VIDEO}/hqdefault.jpg`,
			);
		}
	});

	test('a YouTube image embed becomes the same anchor', () => {
		// `![](https://youtu.be/…)` renders as an <img> whose src is a video page.
		// Left alone it is a broken image.
		const root = render(`<p><img src="https://youtu.be/${VIDEO}" alt="video"></p>`);

		const link = root.querySelector('a.youtube-link') as unknown as ShimElement | null;
		assert.ok(link, 'the image is replaced by the anchor');
		assert.equal(link.getAttribute('href'), `https://youtu.be/${VIDEO}`);
	});

	test('a YouTube link with words around it is left as a link', () => {
		// Only a paragraph that is nothing but the link becomes a poster. Swapping
		// a link inside a sentence for a 480px thumbnail would rewrite the prose.
		const root = render(`<p>see <a href="https://youtu.be/${VIDEO}">this</a> for context</p>`);

		assert.equal(root.querySelectorAll('a.youtube-link').length, 0);
		const link = root.querySelector('a') as unknown as ShimElement | null;
		assert.ok(link);
		assert.equal(link.textContent, 'this', 'the link keeps its own text');
	});

	test('a URL that only looks like YouTube is not rewritten', () => {
		// getYoutubeId requires an 11-character id; anything else stays a link
		// rather than becoming an anchor around a thumbnail that 404s.
		const root = render('<p><a href="https://youtu.be/short">link</a></p>');

		assert.equal(root.querySelectorAll('a.youtube-link').length, 0);
		assert.equal(root.querySelectorAll('img').length, 0);
	});
});
