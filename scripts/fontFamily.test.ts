import assert from 'node:assert/strict';
import test from 'node:test';

import { fontFamilyValue } from '../src/lib/utils/fontFamily.js';
import { readSource } from './sourceTree.js';

const viewerSource = readSource(new URL('../src/lib/MarkdownViewer.svelte', import.meta.url));
const editorOptionsSource = readSource(new URL('../src/lib/utils/editorOptions.ts', import.meta.url));

// The names in this test are the failure, not a sample of exotic input: each
// one is a real family that the settings dropdown offered and that selecting
// did nothing at all for, because bare interpolation made the declaration
// invalid and the browser dropped it whole. Measured in a WKWebView with the
// parent element at `40px Courier`: `M+ 1c`, `04b03`, `Gill Sans (Body)` and
// `Helvetica!` each computed to `Courier` at an identical width, while
// `Helvetica` in the same shape rendered. See #810.
test('a family name is quoted, whatever characters it carries', () => {
	assert.equal(fontFamilyValue('Lato', 'sans-serif'), '"Lato", sans-serif');
	assert.equal(fontFamilyValue('M+ 1c', 'sans-serif'), '"M+ 1c", sans-serif');
	assert.equal(fontFamilyValue('04b03', 'sans-serif'), '"04b03", sans-serif');
	assert.equal(fontFamilyValue('Gill Sans (Body)', 'sans-serif'), '"Gill Sans (Body)", sans-serif');
	assert.equal(fontFamilyValue('Helvetica!', 'sans-serif'), '"Helvetica!", sans-serif');
});

test('quotes and backslashes in a name cannot end the string early', () => {
	assert.equal(fontFamilyValue('Say "Hi"', 'sans-serif'), '"Say \\"Hi\\"", sans-serif');
	assert.equal(fontFamilyValue('back\\slash', 'sans-serif'), '"back\\\\slash", sans-serif');
	// A family name reaches this from localStorage, which any window can write,
	// so the value has to be unable to close the string and open a declaration
	// of its own.
	assert.equal(fontFamilyValue('x"; color: red; font-family: "y', 'sans-serif'), '"x\\"; color: red; font-family: \\"y", sans-serif');
});

test('generic families stay unquoted, which is what keeps the Linux defaults working', () => {
	// `defaultFontsFor('linux')` picks `Monospace` and `system-ui`. Quoted, both
	// become a request for a family nobody has; CSS keywords are
	// case-insensitive, so `Monospace` is the generic.
	assert.equal(fontFamilyValue('Monospace', 'monospace'), 'Monospace, monospace');
	assert.equal(fontFamilyValue('system-ui', 'sans-serif'), 'system-ui, sans-serif');
	assert.equal(fontFamilyValue('ui-rounded', 'sans-serif'), 'ui-rounded, sans-serif');
});

test('the generics table holds the grammar and nothing that only looks like it', () => {
	// `generic(fangsong)` is how CSS Fonts 4 §2.1.2 spells the script-specific
	// generics, so the bare word is an ordinary family name — and macOS ships two
	// real ones. Exempting it would emit a user's 仿宋 face unquoted, which an
	// engine that does treat the bare word as a keyword resolves to a generic.
	assert.equal(fontFamilyValue('FangSong', 'serif'), '"FangSong", serif');
	assert.equal(fontFamilyValue('fangsong', 'serif'), '"fangsong", serif');
	assert.equal(fontFamilyValue('emoji', 'sans-serif'), '"emoji", sans-serif');
	// The other direction, and the one that must never be "fixed" by adding an
	// entry: §2.1.1 requires a family named after a CSS-wide keyword to be
	// quoted. Measured in a WKWebView, `font-family: inherit, serif` and
	// `font-family: default, serif` are rejected outright, while the quoted form
	// is accepted.
	for (const reserved of ['inherit', 'initial', 'unset', 'revert', 'revert-layer', 'default']) {
		assert.equal(fontFamilyValue(reserved, 'serif'), `"${reserved}", serif`);
	}
});

test('a blank preference is the fallback alone, not a leading comma', () => {
	// `stringSetting` applies any non-null raw value, so an empty `preview.font`
	// key lands as an empty family. Interpolated bare it produced
	// `font-family: , sans-serif` — invalid, and dropped like the rest.
	assert.equal(fontFamilyValue('', 'sans-serif'), 'sans-serif');
	assert.equal(fontFamilyValue('   ', 'monospace'), 'monospace');
	assert.equal(fontFamilyValue('  Lato  ', 'sans-serif'), '"Lato", sans-serif');
});

test('both places a chosen family reaches CSS go through the one helper', () => {
	assert.match(viewerSource, /font-family: \{fontFamilyValue\(settings\.previewFont, 'sans-serif'\)\}/);
	assert.match(editorOptionsSource, /fontFamily: fontFamilyValue\(settings\.editorFont, "monospace"\),/);
	// The absence claim is the point of this one: a second bare interpolation of
	// a font preference is the defect returning, and it cannot be observed by
	// running the helper that does exist.
	assert.doesNotMatch(viewerSource, /font-family: \{settings\./);
	assert.doesNotMatch(editorOptionsSource, /fontFamily: settings\./);
});
