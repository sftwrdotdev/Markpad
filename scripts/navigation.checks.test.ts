import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { readSource } from './sourceTree.js';

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
	 * lands (see tabs.checks.test.ts). So "it resolves through the measured
	 * helpers" is now a behavior claim, made by calling the function — every test
	 * above this one, and the arrival tests in navigation.spec.ts. What is
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
});

describe('jump to the selected fragment wiring', () => {
	const viewerSource = readSource(new URL('../src/lib/MarkdownViewer.svelte', import.meta.url));

	test('the shift reads the buffer, not the rendered body', () => {
		// `lineCoordinates(rawContent)` — measuring the render would answer 0
		// forever, since the render is what the front matter was stripped out of.
		// One derivation, so there is one answer for the whole document rather than
		// a per-call-site chance to read the wrong thing.
		assert.match(viewerSource, /let lineCoords = \$derived\(lineCoordinates\(rawContent\)\)/);
		assert.equal(viewerSource.match(/lineCoordinates\(/g)?.length, 1);
	});
});
