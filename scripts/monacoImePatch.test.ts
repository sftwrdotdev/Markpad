import assert from 'node:assert/strict';
import test from 'node:test';

import { MONACO_IME_PATCH, MONACO_TEXTAREA_FILE, patchMonacoTextAreaForIme } from './monacoImePatch.mjs';
import { readSource } from './sourceTree.js';

// The build-time patch to Monaco that stops the IME composition overlay from
// jittering (#724). See the header of monacoImePatch.mjs for the mechanism.
//
// These are text assertions against the INSTALLED Monaco, and they say so:
// the contract being pinned is that the two source lines the patch anchors on
// still exist exactly once in the file it targets. A Monaco bump that moves or
// rewrites either line — including the bump that finally carries the upstream
// fix, microsoft/vscode#333909 — turns this red, which is the signal to delete
// the patch rather than let it silently stop applying.

// Through `readSource`, like every other test that reads a file: the anchors
// are written against `\n`, and it is what keeps them matching on a Windows
// checkout (see singleImplementationConvention.test.ts).
const textAreaSource = readSource(
	new URL(`../node_modules/monaco-editor/esm/vs/editor/browser/controller/editContext/textArea/${MONACO_TEXTAREA_FILE}`, import.meta.url),
);

test('both anchors match the installed Monaco exactly once', () => {
	for (const { from } of MONACO_IME_PATCH) {
		assert.equal(textAreaSource.split(from).length - 1, 1, `anchor ${JSON.stringify(from.trim())}`);
	}
});

test('the patch turns both conditions into "unless a screen reader is attached"', () => {
	const patched = patchMonacoTextAreaForIme(textAreaSource);
	for (const { from, to } of MONACO_IME_PATCH) {
		assert.equal(patched.includes(from), false, 'the original condition is gone');
		assert.equal(patched.split(to).length - 1, 1, 'the replacement is there once');
	}
	// Nothing else moved: the patch is those two lines and no more.
	assert.equal(patched.length, textAreaSource.length + MONACO_IME_PATCH.reduce((n, p) => n + p.to.length - p.from.length, 0));
});

test('a Monaco that no longer has the anchors fails the build instead of shipping unpatched', () => {
	assert.throws(
		() => patchMonacoTextAreaForIme(textAreaSource.replace(MONACO_IME_PATCH[0].from, '')),
		/expected exactly one match/,
	);
});
