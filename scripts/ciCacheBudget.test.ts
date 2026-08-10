import assert from 'node:assert/strict';
import test from 'node:test';

import { readSource } from './sourceTree.js';

const workflows = ['build.yml', 'test.yml', 'test_build.yml', 'publish-packages.yml'].map(
	(name) => ({ name, text: readSource(`.github/workflows/${name}`) }),
);

// GitHub gives a repository 10 GB of Actions cache and evicts
// least-recently-used over it. Both assertions below exist because that budget
// was measured being exceeded — 13.22 GB across 117 entries — and because the
// entries that overflow it are evicted in the order that hurts most: the
// largest first, which is exactly the cargo caches the budget is being spent
// on. Neither of these is a law of nature; both are trades with numbers behind
// them, recorded in the workflow comments. Change them by re-doing the
// measurement, not by deleting the assertion.

test('a cargo cache is written on master and nowhere else', () => {
	// Without `save-if` every pull request writes its own copy, and a copy is
	// 1.0-1.2 GB per platform: one run of #572 wrote 4.45 GB. Two pull requests
	// in flight overflow the budget on their own, and what gets evicted is the
	// cargo caches — so the cache becomes a slower way of not caching.
	//
	// This is also why test_build.yml runs on push to master. The two are one
	// decision: `save-if` makes master the only writer, so master has to run.
	for (const { name, text } of workflows) {
		const uses = [...text.matchAll(/uses: Swatinem\/rust-cache@v2\n([\s\S]{0,400}?)(?=\n\s*- name:|\n\n)/g)];
		for (const [, block] of uses) {
			assert.match(
				block,
				/save-if: \$\{\{ github\.ref == 'refs\/heads\/master' \}\}/,
				`${name} caches cargo output without restricting the save to master`,
			);
		}
	}
});

test('setup-node does not cache npm', () => {
	// It was the largest consumer of the same budget: 113 entries, 8.76 GB,
	// across 50 refs, most of them pull requests closed weeks earlier. Caches
	// are scoped by ref, so one is written per branch per platform and nothing
	// can bound it the way `save-if` bounds the cargo caches.
	//
	// What it bought, on runs that hit it: `npm ci` in 6s on Linux, 9s on
	// macOS, 15-17s on Windows. It caches `~/.npm`, not `node_modules`, so
	// `npm ci` still runs and still links every package — the saving is the
	// registry fetch alone.
	for (const { name, text } of workflows) {
		assert.doesNotMatch(
			text,
			/^\s*cache: '?npm'?\s*$/m,
			`${name} re-enables the npm cache; re-read the budget note in test.yml first`,
		);
	}
});
