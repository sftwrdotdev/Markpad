/**
 * Where a dropped file goes, per pane.
 *
 * The app answers a drop in three ways, and the branch for the editor pane
 * knew only one of them: it looked for an image extension and **silently
 * discarded everything else**. So dragging a `.md` onto the editor did
 * nothing at all — no tab, no toast, no clue — while the identical drop two
 * inches to the right opened it. #175 asked for "drag multiple files, for each
 * file open a new tab" and got it, as long as the pointer stayed off the
 * editor.
 *
 * The decision now lives in `routeDroppedFile`, away from the window event
 * this suite cannot emit, which is what makes the table below a test rather
 * than a reading of the source. It was written the other way first: source
 * assertions that still passed with the markdown branch disabled by a
 * `false &&`. A check that cannot fail is worse than none, because it is
 * counted.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { readSource, sliceBetween } from './sourceTree.js';

import {
	DROPPABLE_IMAGE_EXTENSIONS,
	routeDroppedFile,
	type DropAction,
	type DropPane,
} from '../src/lib/utils/fileDrop.js';

const viewerSource = readSource(new URL('../src/lib/MarkdownViewer.svelte', import.meta.url));

/** file, pane, what must happen. */
const ROUTES: ReadonlyArray<[path: string, pane: DropPane, action: DropAction]> = [
	// The report: a document opens, whichever pane is under the pointer.
	['/notes/spec.md', 'editor', 'open'],
	['/notes/spec.md', 'preview', 'open'],
	['/notes/spec.markdown', 'editor', 'open'],
	['/notes/spec.txt', 'editor', 'open'],
	['C:\\notes\\spec.MD', 'editor', 'open'],

	// An image goes into the text, and only where there is text.
	['/notes/img/figure.png', 'editor', 'insert'],
	['/notes/img/figure.SVG', 'editor', 'insert'],
	['/notes/img/figure.png', 'preview', 'unsupported'],

	// Everything else is reported rather than dropped on the floor.
	['/notes/archive.zip', 'editor', 'unsupported'],
	['/notes/archive.zip', 'preview', 'unsupported'],
	['/notes/report.pdf', 'editor', 'unsupported'],
	['/notes/no-extension', 'editor', 'unsupported'],
];

test('every file has an answer on both panes', () => {
	for (const [path, pane, action] of ROUTES) {
		assert.equal(routeDroppedFile(path, pane), action, `${path} on the ${pane}`);
	}
});

test('nothing routes to silence', () => {
	// The defect in one sentence: a path that matched no branch produced no
	// action at all. There is no fourth answer to return now, and this is the
	// assertion that says so.
	const answers: DropAction[] = ['insert', 'open', 'unsupported'];
	for (const pane of ['editor', 'preview'] as DropPane[]) {
		for (const path of ['/a.md', '/a.png', '/a.zip', '/a', '/a.md.zip', '']) {
			assert.ok(answers.includes(routeDroppedFile(path, pane)), `${path} on the ${pane}`);
		}
	}
});

test('the image list and the document list cannot overlap', () => {
	// They are asked in order, so an extension in both would take whichever
	// branch runs first rather than the one that suits it.
	for (const extension of DROPPABLE_IMAGE_EXTENSIONS) {
		assert.equal(routeDroppedFile(`/notes/figure.${extension}`, 'editor'), 'insert', extension);
	}
});

test('the viewer routes both panes through it, and acts on all three answers', () => {
	const dropHandler = sliceBetween(
		viewerSource,
		"} else if (event.payload.type === 'drop') {",
		'isDragging = false;',
	);

	assert.match(dropHandler, /switch \(routeDroppedFile\(path, pane\)\)/);
	assert.match(dropHandler, /case 'insert':[\s\S]{0,120}?handleDroppedFile\(path, x, y\)/);
	assert.match(dropHandler, /case 'open':[\s\S]{0,80}?loadMarkdown\(path\)/);
	assert.match(dropHandler, /case 'unsupported':[\s\S]{0,80}?reportUnsupportedDrop\(path\)/);
	// One toast helper for both panes: the message used to be built inline in
	// the preview branch, which is part of why the editor branch had nothing
	// to say.
	assert.match(
		viewerSource,
		/function reportUnsupportedDrop\(path: string\)[\s\S]{0,300}?t\('toast\.unsupportedFile', uiLanguage\)/,
	);
});
