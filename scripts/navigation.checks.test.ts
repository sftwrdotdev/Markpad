import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { readSource, functionSource } from './sourceTree.js';
import { viewerCommandFor } from '../src/lib/utils/viewerKeymap.js';
import { viewerCommandTable } from './keymapHarness.js';

const { frontMatterLineOffset } = await import('../src/lib/utils/frontMatter.js');

describe('file history', () => {
	// History is a list of PATHS. `createFileHistory` used to take the tab's
	// initial content as an ignored second parameter, and all three callers passed
	// one — which is how `addNewTab` came to seed a history with a content string
	// in it. A source assertion because that is the whole of what the parameter
	// was: nothing reads it, so no behaviour can fail when it comes back, and
	// `Function.length` cannot see an optional one either.
	test('no caller hands a file history anything but a path', () => {
		const declaration = readSource('src/lib/utils/tabHistory.ts').match(/export function createFileHistory\([^)]*\)/);
		assert.ok(declaration);
		assert.equal(declaration[0], 'export function createFileHistory(path: string)');

		for (const call of readSource('src/lib/stores/tabs.svelte.ts').matchAll(/createFileHistory\([^)]*\)/g)) {
			assert.doesNotMatch(call[0], /,/, `${call[0]} passes something that is not a path`);
		}
	});
});

describe('preview anchor restore wiring', () => {
	/**
	 * The assertions below are source assertions, not behavior assertions: the
	 * restore is triggered from inside a Svelte component and that effect cannot be
	 * imported. They pin the wiring — that the component restores through the
	 * measured cascade, and that the top-level-only scan the rates above were
	 * measured against does not come back.
	 *
	 * The cascade itself moved out of the component and into
	 * `restorePreviewReadingPosition`, next to the resolvers it runs, when the
	 * arrival of a transferred tab needed to run the same one after its document
	 * lands (see tabTransferHandoff.test.ts). So "it resolves through the measured
	 * helpers" is now a behavior claim, made by calling the function — every test
	 * above this one, and the arrival tests in tabReadingPosition.spec.ts. What is
	 * left here is what a source assertion is for: that there is no second copy.
	 */
	test('the viewer restores through the measured resolver', async () => {
		const viewer = readSource('src/lib/MarkdownViewer.svelte');

		// Read out of the one import statement rather than matched across the whole
		// file: `import \{[\s\S]*restorePreviewReadingPosition[\s\S]*\} from
		// '…previewAnchor.js'` starts at the first import in the file and runs past
		// every brace in between, so forking the cascade into another module while
		// leaving the rest of the import behind satisfied it.
		const anchorImport = viewer.match(/import \{([^}]*)\} from '\.\/utils\/previewAnchor\.js'/);
		assert.ok(anchorImport, 'the viewer must import from previewAnchor.js');
		const imported = anchorImport[1].split(',').map((name) => name.trim()).filter(Boolean);
		assert.ok(
			imported.includes('restorePreviewReadingPosition'),
			'the restore must go through the shared cascade, not a fork of it',
		);
		// And the component must not grow one of its own back: the cascade is an
		// ORDER, and a second site consulting the same three fields in a different
		// one is a different answer for the same tab.
		assert.doesNotMatch(viewer, /scrollTop = getAnchorScrollTop\(/);
		assert.doesNotMatch(viewer, /tab\.scrollPercentage/);
		assert.doesNotMatch(viewer, /Array\.from\(body\.children\)/);
	});

	/**
	 * The cold start: the rich-content libraries arrive after the document is
	 * already in the preview and after the position has been restored against it.
	 *
	 * Measured in Chromium — the numbers and the method are in the patch effect's
	 * comment in `MarkdownViewer.svelte` — the anchored text moves down by up to
	 * 812px when the enrichment lands, and re-running this cascade afterwards
	 * brings it back to within 0.8px. jsdom has no layout, so that magnitude cannot
	 * be asserted here and this is a source assertion like the one above: what it
	 * pins is that the second restore is wired up at all, and that nothing has
	 * quietly gone back to the arrangement that had no owner for this case.
	 */
	test('a cold start restores again once its enrichment has landed', async () => {
		const viewer = readSource('src/lib/MarkdownViewer.svelte');

		// The patch effect is the owner: a host's first enrichment is the one that
		// imports the libraries its document needs, so it lands after the restore.
		assert.match(
			viewer,
			/const cold = patch\.inserted\.length > 0 && !enrichedHosts\.has\(host\)/,
			'the patch effect must recognise the first enrichment of a host',
		);
		assert.match(
			viewer,
			/if \(cold\) restoreAfterColdEnrichment\(/,
			'and only that run may re-restore, or every no-op patch would move the reader',
		);

		// The restore itself goes through the shared cascade, waits for the
		// enrichment, and speaks only for the tab still on screen.
		const helper = viewer.match(
			/async function restoreAfterColdEnrichment\([\s\S]*?\n\t\}/,
		)?.[0];
		assert.ok(helper, 'restoreAfterColdEnrichment must exist');
		assert.match(helper, /await enrichment;/);
		assert.match(helper, /tabManager\.activeTabId !== tabId/);
		assert.match(helper, /restorePreviewReadingPosition\(body, tab,/);

		// And the accident that used to stand in for it must not come back. The
		// theme effect's `renderRichContent()` reads reactive state before its
		// first await, so without `untrack` that effect re-runs on unrelated
		// changes — re-enriching every open tab's host on top of the pass above.
		//
		// Matched on the `untrack`, not on the guard beside it: the guard was
		// `markdownBody && !isEditing` when this was written and is `markdownBody`
		// alone now (scripts/diagramThemeRefresh.spec.ts owns that question). What
		// this test is for is the tracking.
		assert.match(
			viewer,
			/untrack\(\(\) => \{? ?if \(markdownBody\) renderRichContent\(\);/,
			'the theme effect must depend on the theme, not on the libraries arriving',
		);
	});
});

describe('jump to the selected fragment wiring', () => {
	const viewerSource = readSource(new URL('../src/lib/MarkdownViewer.svelte', import.meta.url));

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

	test('the real stress document shifts by its front matter', () => {
		// The fixture the reporter of the offset was reading: 10 lines of front
		// matter plus the blank line after it, heading on buffer line 12.
		const raw = readSource(new URL('../samples/stress-test.md', import.meta.url));
		assert.equal(frontMatterLineOffset(raw), 11);
		assert.equal(raw.split('\n')[11], '# Markdown Reader Stress Test');
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
		assert.match(fromEditor, /followToc\('editor', tabAnchorForEditorTopLine\(lineCoords, asBufferLine\(position\.line\)\)\)/);

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
		// The chord is a call now, not a pattern: the branch structure moved to
		// `viewerKeymap.ts` and #647 had already shown what the old spelling cost —
		// five assertions of this shape went red for a renamed local.
		assert.equal(
			viewerCommandFor(
				{ key: 'e', code: 'KeyE', ctrlKey: true, metaKey: false, shiftKey: false, altKey: false },
				{ mode: 'app', osType: 'windows', isSplit: false, overlayOpen: false, dialogOpen: false, isEditing: false, editorHasFocus: false },
			),
			'toggle-edit-view',
		);
		assert.match(viewerCommandTable()['toggle-edit-view'], /toggleEditView\(\)/);
		// The editor entry point hands Monaco's ⌘E to the same switch.
		assert.match(viewerSource, /oncommand=\{runViewerCommand\}/, 'the editor entry point');
		// The title bar's Edit button, now one of three mode buttons (#806).
		assert.match(functionSource(viewerSource, 'setViewMode'), /target === 'edit' \? toggleEditView\(\)/);
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
});
