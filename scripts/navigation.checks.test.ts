import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { readSource, functionSource } from './sourceTree.js';
import { viewerCommandFor } from '../src/lib/utils/viewerKeymap.js';
import { viewerCommandTable } from './keymapHarness.js';

const { frontMatterLineOffset } = await import('../src/lib/utils/frontMatter.js');

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
	 * The cold start's second restore runs in navigation.viewMode.spec.ts against
	 * `sessions/coldEnrichmentRestore`. What is left is an `$effect` in the
	 * component, which only mounting would observe.
	 */
	test('the theme effect does not re-enrich when the libraries arrive', async () => {
		const viewer = readSource('src/lib/MarkdownViewer.svelte');

		// The accident that used to stand in for the second restore must not
		// come back. The theme effect's `renderRichContent()` reads reactive state before its
		// first await, so without `untrack` that effect re-runs on unrelated
		// changes — re-enriching every open tab's host on top of the pass above.
		//
		// Matched on the `untrack`, not on the guard beside it: the guard was
		// `markdownBody && !isEditing` when this was written and is `markdownBody`
		// alone now (scripts/diagramThemeRefresh.spec.ts owns that question). What
		// this test is for is the tracking.
		assert.match(
			readSource('src/lib/utils/themeEffect.svelte.ts'),
			/untrack\(\(\) => deps\.recolourDiagrams\(\)\)/,
			'the theme effect must depend on the theme, not on the libraries arriving',
		);
	});
});

describe('jump to the selected fragment wiring', () => {
	const viewerSource = readSource(new URL('../src/lib/MarkdownViewer.svelte', import.meta.url));

	/* ------------------------------------------------------------------ */
	/* the context menu wiring                                             */
	/* ------------------------------------------------------------------ */

	test('the real stress document shifts by its front matter', () => {
		// The fixture the reporter of the offset was reading: 10 lines of front
		// matter plus the blank line after it, heading on buffer line 12.
		const raw = readSource(new URL('../samples/stress-test.md', import.meta.url));
		assert.equal(frontMatterLineOffset(raw), 11);
		assert.equal(raw.split('\n')[11], '# Markdown Reader Stress Test');
	});

	test('every renderer line reaching the editor goes through the shift', () => {
		// The context menu and ⌘E shift through `editSourceRange`: see
		// navigation.viewMode.spec.ts. The outline is wired inline in the markup
		// rather than in a function, so only mounting would observe it.
		assert.match(
			viewerSource,
			/editorPane\.revealHeader\(\s*sourceLine === null \? null : lineCoords\.toBufferLine\(/,
			'the outline shifts',
		);
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
		// The editor entry point hands Monaco's ⌘E to the same switch. The title
		// bar's Edit button runs in navigation.viewMode.spec.ts.
		assert.match(viewerSource, /oncommand=\{runViewerCommand\}/, 'the editor entry point');
	});

});
