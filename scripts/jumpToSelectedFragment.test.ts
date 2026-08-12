/**
 * #90: "Edit" in the preview's context menu opens the editor ON the fragment
 * that was right-clicked, and highlights it.
 *
 * The mapping this needs already exists. comrak runs with
 * `options.render.sourcepos = true` (`markdown_options` in
 * src-tauri/src/lib.rs), so every rendered element carries the source range it
 * came from, and `previewAnchor.ts` is the module that reads those ranges for
 * the tab's reading position and for split-view scroll sync. This feature is a
 * third consumer of the same attribute, not a third mapping: it resolves an
 * element to a `LineRange` with the parser those two already use, and hands it
 * to the one line-to-editor jump in `Editor.svelte` — the one the outline
 * already calls through `revealHeader`.
 *
 * Two facts about `data-sourcepos` that the tests below pin, because getting
 * either wrong is silent:
 *
 *   - INLINE nodes carry a range, not just blocks. Recorded from
 *     `convert_markdown` at comrak 0.54:
 *
 *       <p data-sourcepos="3:1-3:67">A paragraph with
 *         <strong data-sourcepos="3:18-3:30">bold text</strong> and an
 *         <img data-sourcepos="3:39-3:53" src="img.png" alt="alt" />
 *         inline image.</p>
 *
 *     which is what makes "jump to the selected image" land on the image's own
 *     line rather than on the whole paragraph.
 *
 *   - Only the LINE numbers are meaningful against the buffer the user edits.
 *     comrak parses the output of `convert_markdown`'s preprocessing, and that
 *     pipeline is line-preserving, not column-preserving. Recorded from the
 *     same renderer, for the raw line `Math $a+b$ then ![alt](img.png) here.`:
 *
 *       <p data-sourcepos="3:1-3:44">…<img data-sourcepos="3:24-3:38" …
 *
 *     The image really starts at raw column 18; the math mask substitutes a
 *     token longer than `$a+b$` and every column after it on the line is off
 *     by the difference. So the jump selects whole lines, and nothing here
 *     ever reads a column.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
	installShimDom,
	NODE_TEXT,
	parseHtml,
	type ShimElement,
	type ShimNode,
} from './renderProtocolDom.ts';
import { functionSource, readSource, sliceFrom } from './sourceTree.js';

installShimDom();

// `processMarkdownHtml` resolves every local image through Tauri's
// `convertFileSrc`, which reads `window.__TAURI_INTERNALS__`. Without it the
// resolution throws, the app catches it, and the `<img>` is left alone — which
// is exactly the branch the "does the range survive the rewrite" test must NOT
// be allowed to take.
(globalThis as unknown as Record<string, unknown>).window = {
	__TAURI_INTERNALS__: {
		convertFileSrc: (path: string, protocol: string) => `${protocol}://localhost/${path}`,
	},
};

const { processMarkdownHtml } = await import('../src/lib/utils/markdown.ts');
const { findSourceLineRange, mergeSourceLineRanges } = await import(
	'../src/lib/utils/previewAnchor.ts'
);

const editorSource = readSource(new URL('../src/lib/components/Editor.svelte', import.meta.url));
const viewerSource = readSource(new URL('../src/lib/MarkdownViewer.svelte', import.meta.url));

const FILE_PATH = '/documents/notes.md';

/**
 * comrak-shaped output for
 *
 *   1  # Notes
 *   2
 *   3  A paragraph with **bold text** and an ![alt](img.png) inline image.
 *   4
 *   5  ![standalone](pic.png)
 *   6
 *   7  Trailing prose
 *   8  over two lines.
 *
 * taken from `convert_markdown`, hardbreaks and heading anchor included, then
 * put through the app's own `processMarkdownHtml` — which is where the fold
 * wrapper that carries no source range of its own appears.
 */
const RENDERED = processMarkdownHtml(
	'<h1 id="notes" data-sourcepos="1:1-1:7">Notes<a href="#notes" aria-label="Link to heading \'Notes\'" data-heading-content="Notes" class="anchor"></a></h1>\n' +
		'<p data-sourcepos="3:1-3:67">A paragraph with <strong data-sourcepos="3:18-3:30">bold text</strong> and an <img data-sourcepos="3:39-3:53" src="img.png" alt="alt" /> inline image.</p>\n' +
		'<p data-sourcepos="5:1-5:22"><img data-sourcepos="5:1-5:22" src="pic.png" alt="standalone" /></p>\n' +
		'<p data-sourcepos="7:1-8:15">Trailing prose<br data-sourcepos="7:15-7:15" />\nover two lines.</p>\n',
	FILE_PATH,
	new Set<string>(),
);

const body = parseHtml(RENDERED).body;

/** The first descendant of `root` the shim's `querySelector` can name. */
function pick(selector: string): ShimElement {
	const found = body.querySelector(selector);
	assert.ok(found, `expected the rendered preview to contain ${selector}`);
	return found;
}

/**
 * The first text node under `node` — where the end of a browser selection, and
 * a `MouseEvent.target` inside prose, actually lands. Text nodes have no
 * `closest` of their own, which is the case the lookup has to climb out of.
 */
function firstText(node: ShimNode): ShimNode {
	if (node.nodeType === NODE_TEXT) return node;
	for (const child of node.childNodes) {
		const found = firstText(child);
		if (found.nodeType === NODE_TEXT) return found;
	}
	return node;
}

/* ------------------------------------------------------------------ */
/* what a click resolves to                                            */
/* ------------------------------------------------------------------ */

test('an image inside a paragraph resolves to the image, not to the paragraph', () => {
	// The whole point of #90 for the "or an image" half of the report. The
	// enclosing <p> spans line 3 too here, but the narrowest match is what
	// keeps a multi-line paragraph from selecting all of itself.
	assert.deepEqual(findSourceLineRange(pick('img[alt="alt"]')), {
		startLine: 3,
		endLine: 3,
	});
});

test('a caret inside a block resolves to the whole block', () => {
	// Text nodes have no `closest`; the lookup has to climb to the element.
	// A paragraph is the finest granularity available for plain prose, and it
	// is the right one: the reader asked to edit this paragraph.
	const paragraph = pick('p[data-sourcepos="7:1-8:15"]');
	assert.deepEqual(findSourceLineRange(firstText(paragraph)), { startLine: 7, endLine: 8 });
});

test('an inline node with its own range beats the block around it', () => {
	assert.deepEqual(findSourceLineRange(firstText(pick('strong'))), { startLine: 3, endLine: 3 });
});

test('the fold wrapper processMarkdownHtml inserts does not hide the range', () => {
	// `processMarkdownHtml` re-parents everything after a heading into a
	// `.foldable-content-wrapper` it creates, and that wrapper carries no
	// `data-sourcepos`. The climb has to pass straight through it — this is
	// the same shape of defect #420 fixed for the restore path.
	assert.ok(body.querySelector('.foldable-content-wrapper'), 'expected a fold wrapper');
	assert.deepEqual(findSourceLineRange(pick('img[alt="standalone"]')), {
		startLine: 5,
		endLine: 5,
	});
});

test('anything the app renders around the document resolves to nothing', () => {
	// The front matter panel, the outline, the window chrome. The context menu
	// leaves its "Edit" entry alone rather than jumping somewhere arbitrary.
	assert.equal(findSourceLineRange(null), null);
	assert.equal(findSourceLineRange(parseHtml('<div class="front-matter">x</div>').body), null);
});

/* ------------------------------------------------------------------ */
/* what a selection resolves to                                        */
/* ------------------------------------------------------------------ */

test('a selection spanning several blocks covers all of them', () => {
	const first = findSourceLineRange(firstText(pick('h1')));
	const last = findSourceLineRange(firstText(pick('p[data-sourcepos="7:1-8:15"]')));

	assert.deepEqual(mergeSourceLineRanges(first, last), { startLine: 1, endLine: 8 });
});

test('a backwards selection covers the same lines as a forwards one', () => {
	const a = { startLine: 3, endLine: 3 };
	const b = { startLine: 7, endLine: 8 };

	assert.deepEqual(mergeSourceLineRanges(a, b), mergeSourceLineRanges(b, a));
	assert.deepEqual(mergeSourceLineRanges(b, a), { startLine: 3, endLine: 8 });
});

test('an end that resolves to nothing leaves the other end in charge', () => {
	// Dragging out of the document — into the front matter panel, past the
	// last block — must not throw the whole jump away.
	assert.deepEqual(mergeSourceLineRanges({ startLine: 4, endLine: 6 }, null), {
		startLine: 4,
		endLine: 6,
	});
	assert.deepEqual(mergeSourceLineRanges(null, { startLine: 4, endLine: 6 }), {
		startLine: 4,
		endLine: 6,
	});
	assert.equal(mergeSourceLineRanges(null, null), null);
});

/* ------------------------------------------------------------------ */
/* the jump itself                                                     */
/* ------------------------------------------------------------------ */

test('the outline and the context menu share one line-to-editor jump', () => {
	// `revealHeader` used to reveal and select the line itself. Leaving that
	// copy in place while #90 grew a second one is the drift
	// singleImplementationConvention.test.ts exists to catch: the two would
	// scroll differently, focus differently, and only one of them would clamp.
	const revealHeader = functionSource(editorSource, 'revealHeader');
	assert.match(revealHeader, /revealSourceRange\(lineNumber, lineNumber\)/);
	assert.doesNotMatch(revealHeader, /setSelection\(\{[\s\S]*?startColumn: 1/);
});

test('the jump clamps to the buffer before asking Monaco for a column', () => {
	// `getLineMaxColumn` throws past the end of the model, and the preview can
	// hand over a stale line: its HTML is the render of a buffer that may have
	// been replaced by a shorter one since.
	const reveal = functionSource(editorSource, 'revealSourceRange');
	assert.match(reveal, /lastLine = model\.getLineCount\(\)/);
	assert.match(reveal, /end = Math\.min\([^\n]*lastLine\)/);
	assert.doesNotMatch(reveal, /getLineMaxColumn\((?!end\))/);
});

test('a jump asked for before Monaco has loaded is queued, not dropped', () => {
	// `monaco-editor` is imported dynamically, so the editor exists several
	// frames after the component does — and the preview calls in immediately
	// after flipping into edit mode.
	const reveal = functionSource(editorSource, 'revealSourceRange');
	assert.match(reveal, /if \(!editorReady \|\| !editor\) \{\s*\n\s*pendingReveal = \{ startLine, endLine \};/);

	// Spent after the view-state / anchor-line restore, so an explicit "edit
	// this fragment" wins over the position the tab was left at.
	const afterReady = sliceFrom(editorSource, 'editorReady = true;');
	assert.ok(
		afterReady.indexOf('pendingReveal') < afterReady.indexOf('return () => {'),
		'the queued jump must be spent inside onMount, before the teardown closure',
	);
});

/* ------------------------------------------------------------------ */
/* the context menu wiring                                             */
/* ------------------------------------------------------------------ */

test('the Edit entry resolves its target while the selection still exists', () => {
	// Resolving inside the `onClick` would read the selection AFTER the reader
	// clicked a menu item, and a click is how a selection goes away.
	const handler = functionSource(viewerSource, 'handleContextMenu');
	assert.match(handler, /const editSourceTarget = getContextMenuSourceRange\(e\);/);
	assert.match(handler, /t\('menu\.edit', settings\.language\), onClick: \(\) => editSourceRange\(editSourceTarget\)/);
	assert.doesNotMatch(handler, /onClick: \(\) => toggleEdit\(\)/);
});

test('Edit with a target never leaves edit mode', () => {
	// In split view the editor is already on screen, and "edit this fragment"
	// is the one thing that cannot mean "close the editor".
	const edit = functionSource(viewerSource, 'editSourceRange');
	assert.match(edit, /if \(!isEditing\) await toggleEdit\(\)/, 'entered only when not already editing');
	// And a read that failed leaves the tab in reading mode — arming the jump
	// anyway would fire it at whatever document is edited next.
	assert.match(edit, /tabManager\.activeTab\?\.isEditing/);
});

test('the target is a source range and never a column', () => {
	// `parseSourceposLineRange` is the only reader of the attribute, and it
	// keeps line numbers only. Nothing in the preview may take the `:col` half
	// and aim Monaco with it — see the header of this file for why.
	const resolve = functionSource(viewerSource, 'getContextMenuSourceRange');
	assert.match(resolve, /findSourceLineRange\(/);
	assert.doesNotMatch(resolve, /startColumn|endColumn/);
});

// ---------------------------------------------------- the front-matter shift
//
// `renderMarkdownPreview` hands comrak `getMarkdownBodyWithoutFrontMatter(raw)`,
// so every `data-sourcepos` counts from the first line of the BODY while the
// editor holds the whole file. Nothing in the attribute says which of the two
// it means, and in a document without front matter the two are equal — which
// is every other fixture in this file, and why the shift went unseen in the
// outline for as long as both have existed.

const { frontMatterLineOffset } = await import('../src/lib/utils/frontMatter.js');

test('a document without front matter needs no shift', () => {
	assert.equal(frontMatterLineOffset('# Title\n\nbody\n'), 0);
});

test('the shift is the number of buffer lines above the body', () => {
	const raw = ['---', 'title: "T"', 'tags:', '  - a', '---', '', '# Title'].join('\n') + '\n';
	// The heading is line 7 of the buffer and line 1 of the body.
	assert.equal(frontMatterLineOffset(raw), 6);
	assert.equal(raw.split('\n')[1 + frontMatterLineOffset(raw) - 1], '# Title');
});

test('the shift counts CRLF lines the same', () => {
	const raw = ['---', 'title: "T"', '---', '', '# Title'].join('\r\n') + '\r\n';
	assert.equal(frontMatterLineOffset(raw), 4);
	assert.equal(raw.split('\r\n')[1 + frontMatterLineOffset(raw) - 1], '# Title');
});

test('a --- that is not front matter shifts nothing', () => {
	// A horizontal rule as the first line is not front matter, and treating it
	// as such would push every jump down by the width of whatever followed.
	const raw = ['---', '', 'Just a rule above some prose.'].join('\n') + '\n';
	assert.equal(frontMatterLineOffset(raw), 0);
});

test('the real stress document shifts by its front matter', () => {
	// The fixture the reporter of the offset was reading: 10 lines of front
	// matter plus the blank line after it, heading on buffer line 12.
	const raw = readSource(new URL('../samples/stress-test.md', import.meta.url));
	assert.equal(frontMatterLineOffset(raw), 11);
	assert.equal(raw.split('\n')[11], '# Markdown Reader Stress Test');
});

// ---------------------------------------- the shift, and where it is applied
//
// Two consumers read `data-sourcepos` and hand the number to the editor: the
// context menu (#90) and the outline. Both need the same shift, so both go
// through `toBufferRange`. A test that only pinned the arithmetic would pass
// with either call site still handing over a raw body line.

const { asBufferLine, asRendererLine, lineCoordinates } = await import('../src/lib/utils/lineCoordinates.js');

test('the shift is what the module applies, in both directions', () => {
	// The arithmetic itself, called rather than matched. A round trip through
	// the pair has to be the identity, or a position handed from one pane to the
	// other and back walks up the document by the height of the front matter
	// every time it crosses.
	const raw = ['---', 'title: "T"', 'tags:', '  - a', '---', '', '# Title'].join('\n') + '\n';
	const coords = lineCoordinates(raw);
	assert.equal(coords.frontMatterLines, 6);

	assert.equal(coords.toBufferLine(asRendererLine(1)), 7, 'the body starts on buffer line 7');
	assert.equal(coords.toRendererLine(asBufferLine(7)), 1);
	for (const line of [1, 2, 40, 137]) {
		assert.equal(coords.toRendererLine(coords.toBufferLine(asRendererLine(line))), line, `renderer line ${line}`);
		assert.equal(coords.toBufferLine(coords.toRendererLine(asBufferLine(line + 6))), line + 6, `buffer line ${line + 6}`);
	}

	// A range shifts by the same amount at both ends, so it still covers the
	// same text rather than growing or sliding.
	assert.deepEqual(coords.toBufferRange({ startLine: 3, endLine: 9 }), { startLine: 9, endLine: 15 });

	// And a document without front matter is left exactly where it is, which is
	// why the shift went unnoticed for as long as it did.
	const plain = lineCoordinates('# Title\n\nbody\n');
	assert.equal(plain.frontMatterLines, 0);
	assert.deepEqual(plain.toBufferRange({ startLine: 3, endLine: 9 }), { startLine: 3, endLine: 9 });
});

test('every renderer line reaching the editor goes through the shift', () => {
	// Two consumers hand a `data-sourcepos` number to the editor, and both have
	// to shift it. `toggleEditView` is not a third: it resolves the range and
	// passes it to `editSourceRange`, which is where the shift happens.
	const edit = functionSource(viewerSource, 'editSourceRange');
	assert.match(edit, /pendingEditReveal = lineCoords\.toBufferRange\(range\)/, 'the context menu and ⌘E shift');

	// The outline is wired inline in the markup rather than in a function.
	assert.match(
		viewerSource,
		/editorPane\.revealHeader\(\s*sourceLine === null \? null : lineCoords\.toBufferLine\(/,
		'the outline shifts',
	);
});

// Scroll sync crosses the same boundary in BOTH directions, and it was the
// consumer this file forgot: `ScrollSyncPosition.line` is a buffer line,
// because the editor is the only pane that can produce one, while everything
// the preview answers with counts from the body. On a document with front
// matter the panes drifted apart by exactly that many lines — a constant
// offset, unaffected by how precise the block mapping underneath got.

test('scroll sync converts in both directions', () => {
	const capture = functionSource(viewerSource, 'getPreviewScrollSyncPosition');
	assert.match(
		capture,
		/lineCoords\.bufferLineAtPreviewOffset\(/,
		'a line read off the preview is shifted before the editor sees it',
	);

	const apply = functionSource(viewerSource, 'scrollPreviewToSyncPosition');
	assert.match(
		apply,
		/lineCoords\.previewOffsetForBufferLine\(/,
		'a line coming from the editor is shifted back before the preview seeks',
	);
});

test('the outline is fed body lines from both panes', () => {
	// `tocActiveLine` has two writers. The preview's already answers in body
	// lines (`getPreviewScrollAnchor`); the editor's has to be converted, or the
	// highlighted heading changes depending on which pane you scrolled.
	const fromEditor = functionSource(viewerSource, 'handleEditorScrollSync');
	assert.match(fromEditor, /tocActiveLine = lineCoords\.toRendererLine\(position\.line\)/);

	const fromPreview = functionSource(viewerSource, 'getPreviewScrollAnchor');
	assert.doesNotMatch(fromPreview, /toBufferLine|toRendererLine/, 'already a body line');
});

test('the shift reads the buffer, not the rendered body', () => {
	// `lineCoordinates(rawContent)` — measuring the render would answer 0
	// forever, since the render is what the front matter was stripped out of.
	// One derivation, so there is one answer for the whole document rather than
	// a per-call-site chance to read the wrong thing.
	assert.match(viewerSource, /let lineCoords = \$derived\(lineCoordinates\(rawContent\)\)/);
	assert.equal(viewerSource.match(/lineCoordinates\(/g)?.length, 1);
});

// The menu is opened BY right-clicking a selection, and two of its items act
// on that selection (Copy, Edit). Anything that moves focus off the document
// stops the selection being painted, so the highlight disappears under the
// menu that exists to act on it.

test('the context menu does not take focus away from the selection', () => {
	const menuSource = readSource('src/lib/components/ContextMenu.svelte');
	assert.doesNotMatch(menuSource, /\.focus\(\)/, 'focusing the menu unpaints the selection');

	// Escape still closes it — from the window, since the menu never has focus.
	assert.match(menuSource, /window\.addEventListener\('keydown'/);
	assert.match(menuSource, /e\.key === 'Escape'/);
});

test('the selection is read before anything switches mode', () => {
	// `toggleEdit` and `editSourceRange` both flip `isEditing`, and a selection
	// read after that would answer for the editor rather than for the preview
	// the reader was looking at.
	const view = functionSource(viewerSource, 'toggleEditView');
	assert.match(view, /const selected = getSelectionSourceRange\(\);/);
	assert.ok(
		view.indexOf('const selected') < view.indexOf('toggleEdit()'),
		'resolved first, then the mode changes',
	);
});

test('one function owns what ⌘E means, and every entry point uses it', () => {
	// The hotkey, the toolbar, the title bar and Monaco's own command all route
	// here, so the chord cannot mean one thing with the caret in the editor and
	// another with it in the preview — which is what
	// `formatShortcutKeymap.test.ts` pins from the other side.
	assert.match(viewerSource, /if \(mod && key === 'e'\) \{[\s\S]{0,600}?toggleEditView\(\)/);
	assert.equal(
		(viewerSource.match(/ontoggleEdit=\{\(\) => toggleEditView\(\)\}/g) ?? []).length,
		3,
		'all three component entry points',
	);
	assert.doesNotMatch(viewerSource, /ontoggleEdit=\{\(\) => toggleEdit\(\)\}/, 'none left on the raw toggle');
});

test('split view with nothing selected is deliberately inert', () => {
	// The editor is already on screen, so the ability ⌘E asks for is already
	// granted; with no selection there is nothing to travel to either. Closing
	// the preview would be a layout change nobody asked for, and a mistyped ⌘E
	// would cost the reader the pane.
	const view = functionSource(viewerSource, 'toggleEditView');
	assert.match(view, /if \(isSplit && !selected\) \{[\s\S]*?return;/);
	assert.doesNotMatch(view, /setSplitEnabled/, 'the chord never changes the layout');
});
