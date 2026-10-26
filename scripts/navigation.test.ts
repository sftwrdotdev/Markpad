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
import { EditorJumps, type JumpEditor } from '../src/lib/utils/editorJumps.js';
import { asBufferLine } from '../src/lib/utils/lineCoordinates.js';

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

describe('jump to the selected fragment', () => {
	/** A Monaco editor over `lines`, recording what a jump does to it. */
	function fakeEditor(lines: string[]) {
		const log: unknown[] = [];
		const model = {
			getLineCount: () => lines.length,
			getLineMaxColumn: (line: number) => {
				// Monaco throws here too, for a line past the end of the model.
				if (line < 1 || line > lines.length) throw new Error(`Illegal value for lineNumber: ${line}`);
				return lines[line - 1].length + 1;
			},
			findNextMatch: () => null,
		};
		const editor = {
			getModel: () => model,
			revealLineNearTop: (line: number) => log.push(['top', line]),
			revealLineInCenterIfOutsideViewport: (line: number) => log.push(['center', line]),
			setSelection: (selection: unknown) => log.push(['select', selection]),
			focus: () => log.push(['focus']),
		} as unknown as JumpEditor;
		return { editor, log };
	}

	function jumps(editor: JumpEditor, state = { ready: true }) {
		return new EditorJumps({
			monaco: () => ({ editor: { ScrollType: { Smooth: 0, Immediate: 1 } } }) as never,
			editor: () => editor,
			ready: () => state.ready,
			scrollTo: () => {},
		});
	}

	const lines = ['# One', 'text', '## Two'];

	test('the outline and the context menu share one line-to-editor jump', () => {
		// `revealHeader` used to reveal and select the line itself. A second copy
		// next to #90's would scroll differently, focus differently, and only one
		// of them would clamp.
		for (const line of [3, 40]) {
			const outline = fakeEditor(lines);
			const contextMenu = fakeEditor(lines);
			jumps(outline.editor).revealHeader(asBufferLine(line), 'Two');
			jumps(contextMenu.editor).revealSourceRange(line, line, 'top');
			assert.deepEqual(outline.log, contextMenu.log, `line ${line}`);
		}
	});

	test('the jump clamps to the buffer before asking Monaco for a column', () => {
		// The preview can hand over a stale line: its HTML is the render of a
		// buffer that may have been replaced by a shorter one since.
		const { editor, log } = fakeEditor(lines);
		jumps(editor).revealSourceRange(50, 60);
		assert.deepEqual(log, [
			['center', 3],
			['select', { startLineNumber: 3, startColumn: 1, endLineNumber: 3, endColumn: 7 }],
			['focus'],
		]);
	});

	test('a jump asked for before Monaco has loaded is queued, not dropped', () => {
		// `monaco-editor` is imported dynamically, so the editor is ready several
		// frames after the component exists, and the preview calls in right after
		// flipping into edit mode.
		const { editor, log } = fakeEditor(lines);
		const state = { ready: false };
		const pane = jumps(editor, state);
		pane.revealSourceRange(2, 2);
		assert.deepEqual(log, []);

		state.ready = true;
		pane.spendPending();
		assert.deepEqual(log, [
			['center', 2],
			['select', { startLineNumber: 2, startColumn: 1, endLineNumber: 2, endColumn: 5 }],
			['focus'],
		]);

		pane.spendPending();
		assert.equal(log.length, 3, 'a queued jump is spent once');
	});
});
