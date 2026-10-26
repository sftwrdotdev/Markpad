import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
	canGoBackInHistory,
	canGoForwardInHistory,
	createFileHistory,
	goBackInHistory,
	goForwardInHistory,
	navigateFileHistory,
	replaceCurrentHistoryEntry,
} from '../src/lib/utils/tabHistory.js';
import { getMarkdownLinkTarget, isOpenInNewTabMarkdownTarget, resolveMarkdownTargetPath } from '../src/lib/utils/markdownLinks.js';
import { jumpScrollBehavior } from '../src/lib/utils/motion.js';

describe('file history and markdown link targets', () => {
	test('new file tabs start history with their path', () => {
		assert.deepEqual(createFileHistory('/notes/a.md'), {
			history: ['/notes/a.md'],
			historyIndex: 0,
		});
	});

	// Entries exist to be re-opened, and an untitled buffer cannot be. See the
	// behaviour this protects in scripts/tabNavigationHistory.spec.ts.
	test('an untitled tab starts with no history entry at all', () => {
		assert.deepEqual(createFileHistory(''), {
			history: [],
			historyIndex: 0,
		});
	});

	test('navigating out of an untitled tab leaves nothing to go back to', () => {
		// Both shapes an untitled tab can arrive in: no entry, and — for a tab
		// transferred from an older window — the `''` its source seeded.
		for (const history of [[], ['']]) {
			assert.deepEqual(
				navigateFileHistory({
					currentPath: '',
					targetPath: '/notes/a.md',
					history,
					historyIndex: 0,
				}),
				{ history: ['/notes/a.md'], historyIndex: 0 }
			);
		}
	});

	// `goBackInHistory`/`goForwardInHistory` move an index inside the array they
	// were handed; they never rewrite it. Returning it made both store callers
	// assign `tab.history` back over itself before assigning the index that
	// actually moved.
	test('moving through history returns only the index and the path', () => {
		assert.deepEqual(Object.keys(goBackInHistory({ history: ['/a.md', '/b.md'], historyIndex: 1 })).sort(), [
			'historyIndex',
			'path',
		]);
		assert.deepEqual(Object.keys(goForwardInHistory({ history: ['/a.md', '/b.md'], historyIndex: 1 })).sort(), [
			'historyIndex',
			'path',
		]);
	});

	test('navigating appends paths and truncates forward entries', () => {
		const history = ['/notes/a.md', '/notes/b.md', '/notes/c.md'];
		const afterBack = goBackInHistory({ history, historyIndex: 1 });

		assert.equal(afterBack.path, '/notes/a.md');
		assert.equal(afterBack.historyIndex, 0);

		const afterNavigate = navigateFileHistory({
			currentPath: afterBack.path!,
			targetPath: '/notes/d.md',
			history,
			historyIndex: afterBack.historyIndex,
		});

		assert.deepEqual(afterNavigate.history, ['/notes/a.md', '/notes/d.md']);
		assert.equal(afterNavigate.historyIndex, 1);
		assert.equal(canGoBackInHistory(afterNavigate), true);
		assert.equal(canGoForwardInHistory(afterNavigate), false);
	});

	test('back and forward stay inside history bounds', () => {
		const initial = {
			history: ['/notes/a.md', '/notes/b.md'],
			historyIndex: 0,
		};

		assert.equal(canGoBackInHistory(initial), false);
		assert.equal(goBackInHistory(initial).path, null);

		const forward = goForwardInHistory(initial);
		assert.equal(forward.path, '/notes/b.md');
		assert.equal(forward.historyIndex, 1);
		assert.equal(canGoForwardInHistory({ history: initial.history, historyIndex: forward.historyIndex }), false);
	});

	test('replacing current history entry keeps file history path-based', () => {
		assert.deepEqual(
			replaceCurrentHistoryEntry({
				targetPath: '/notes/saved.md',
				history: [],
				historyIndex: 0,
			}),
			{
				history: ['/notes/saved.md'],
				historyIndex: 0,
			}
		);
	});

	test('markdown link target detection accepts local markdown and rejects external links', () => {
		assert.deepEqual(getMarkdownLinkTarget('../docs/Guide%20One.md#intro'), {
			path: '../docs/Guide One.md',
			hash: 'intro',
		});
		assert.equal(getMarkdownLinkTarget('https://example.com/docs/readme.md'), null);
		assert.equal(getMarkdownLinkTarget('//example.com/readme.md'), null);
		assert.equal(getMarkdownLinkTarget('#local-anchor'), null);
		assert.equal(getMarkdownLinkTarget('../docs/image.png'), null);
	});

	test('open-in-new-tab target requires a resolvable local markdown link', () => {
		assert.equal(isOpenInNewTabMarkdownTarget('../docs/guide.md', '/vault/current.md'), true);
		assert.equal(isOpenInNewTabMarkdownTarget('../docs/guide.md', ''), false);
		assert.equal(isOpenInNewTabMarkdownTarget('/vault/guide.md', ''), true);
		assert.equal(isOpenInNewTabMarkdownTarget('https://example.com/guide.md', '/vault/current.md'), false);
	});

	test('relative markdown target resolves against the source file directory', () => {
		const target = getMarkdownLinkTarget('../docs/guide.md#usage');
		assert.ok(target);
		assert.equal(resolveMarkdownTargetPath('/vault/notes/current.md', target), '/vault/docs/guide.md');
	});
});

describe('jump scroll motion', () => {
	/*
	 * Issue #199: a long jump — a heading from the table of contents, the next find
	 * match — animates its scroll, and on a dark theme that reads as a flash of
	 * content. The reporter switched to a light theme to work around it.
	 */

	test('the setting alone decides whether a jump animates', () => {
		// No second argument for the system's reduce-motion preference: Markpad runs
		// on three systems that do not all have one, and a switch the user can see
		// must not be overruled by one they cannot.
		assert.equal(jumpScrollBehavior.length, 1);
		assert.equal(jumpScrollBehavior(true), 'smooth');
		assert.equal(jumpScrollBehavior(false), 'auto');
	});
});

describe('preview scroll sync across the front matter', async () => {
	const { asBufferLine, lineCoordinates } = await import('../src/lib/utils/lineCoordinates.js');
	const { getPreviewScrollAnchor, getPreviewScrollSyncPosition, getPreviewScrollTopForSyncPosition } = await import(
		'../src/lib/utils/previewScrollSync.js'
	);
	const { PREVIEW_ANCHOR_OFFSET } = await import('../src/lib/utils/previewAnchor.js');
	type PreviewScroller = import('../src/lib/utils/previewScrollSync.js').PreviewScroller;

	// Scroll sync crosses the line boundary in BOTH directions:
	// `ScrollSyncPosition.line` is a buffer line, because the editor is the only
	// pane that can produce one, while everything the preview answers with
	// counts from the body. On a document with front matter the panes drifted
	// apart by exactly that many lines.
	const FRONT_MATTER = 3;
	const coords = lineCoordinates('---\na: 1\n---\n# body\n');

	type FakeBlock = { nodeType: 1; tagName: string; childNodes: FakeBlock[]; getAttribute: (n: string) => string | null; top: number; height: number };
	const block = (line: number, top: number, height: number): FakeBlock => ({
		nodeType: 1,
		tagName: 'P',
		childNodes: [],
		getAttribute: (name) => (name === 'data-sourcepos' ? `${line}:1-${line}:10` : null),
		top,
		height,
	});
	/** Body lines 1, 5 and 9, and no front matter panel. */
	const SCROLL_MAX = 800;
	function preview(scrollTop: number) {
		return {
			nodeType: 1,
			tagName: 'DIV',
			childNodes: [block(1, 100, 40), block(5, 300, 40), block(9, 500, 60)],
			getAttribute: () => null,
			scrollTop,
			querySelector: () => null,
		} as unknown as PreviewScroller;
	}
	const measure = (node: unknown) => ({ top: (node as FakeBlock).top, height: (node as FakeBlock).height });

	test('scroll sync converts in both directions', () => {
		// The preview at body line 5 tells the editor buffer line 8.
		const captured = getPreviewScrollSyncPosition(preview(300), SCROLL_MAX, coords, measure);
		assert.equal(captured.section, 'body');
		assert.equal(captured.line, 5 + FRONT_MATTER, 'a line read off the preview is shifted before the editor sees it');

		// And the editor at buffer line 8 puts the preview on body line 5.
		const target = getPreviewScrollTopForSyncPosition(preview(0), SCROLL_MAX, { section: 'body', ratio: 0, line: asBufferLine(5 + FRONT_MATTER) }, coords, measure);
		assert.equal(target, 300, 'a line coming from the editor is shifted back before the preview seeks');
	});

	test("the preview's reading position is already a body line", () => {
		// The outline and the tab's anchor both count from the body, so the
		// preview's answer is not shifted.
		assert.equal(getPreviewScrollAnchor(preview(300 - PREVIEW_ANCHOR_OFFSET), measure), 5);
	});
});
