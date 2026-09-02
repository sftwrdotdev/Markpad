/**
 * KaTeX publishes every contrib file twice: `contrib/*.mjs` behind the
 * `import` condition, `contrib/*.js` (CommonJS, `require("katex")`) behind
 * `require`. Only the `.mjs` shares the preview's KaTeX instance; the `.js`
 * gets the bundler's CommonJS copy, and a macro mhchem registers there never
 * reaches `renderToString` (#745). vitest and node both dedupe the two, so the
 * only runtime that shows the split is a production build — which is why this
 * is asserted on the source: the loader may not name the CommonJS flavour.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { readSource } from './sourceTree.ts';

test('the rich-content loader imports KaTeX contribs through the exports map', () => {
	const source = readSource('src/lib/utils/richContent.ts');
	assert.doesNotMatch(source, /import\('katex\/dist\/contrib\//);
	assert.match(source, /import\('katex\/contrib\/mhchem'\)/);
});
