import assert from 'node:assert/strict';
import test from 'node:test';

import { readRustBackend, readSource } from './sourceTree.js';

import {
	MARKDOWN_LINK_EXTENSIONS,
	getMarkdownLinkTarget,
	hasMarkdownLinkExtension,
	resolveMarkdownTargetPath,
} from '../src/lib/utils/markdownLinks.js';

// `[[Notes#Setup]]` — the exact string the "Copy Reference" context-menu item
// writes to the clipboard — used to render as literal text: the Rust
// preprocessor only understood the same-document form `[[#Setup]]`. It now
// emits a plain markdown link, and these tests pin the *shape* of the href it
// emits against the frontend that has to claim it. The Rust side owns the
// other half of this contract in src-tauri/src/lib.rs (`copy_reference_output_
// becomes_a_real_link` and friends); if either half moves, the other fails.
//
// Scope: only the heading-bearing forms (`[[#h]]`, `[[file#h]]`, and their
// `|alias` variants) are rewritten. Obsidian's bare note link `[[Notes]]` is
// a separate feature, not this defect, and is left literal.
//
// Not covered here: whether the file exists, and the actual tab-opening (that
// runs inside MarkdownViewer.svelte and needs a live webview). These tests
// only prove the href is recognized as a local markdown target and decodes
// back to the path and anchor the document asked for.

const rustSource = readRustBackend();
const viewerSource = readSource(new URL('../src/lib/MarkdownViewer.svelte', import.meta.url));
const referenceSource = readSource(new URL('../src/lib/utils/headingReference.ts', import.meta.url));

// href values as produced by process_wikilinks() in src-tauri/src/lib.rs.
// Only the heading-bearing forms appear: a wikilink with no `#` is
// deliberately left as literal text and never reaches the frontend at all.
const cases: { wikilink: string; href: string; path: string; hash: string }[] = [
	{ wikilink: '[[Notes#Setup]]', href: 'Notes.md#setup', path: 'Notes.md', hash: 'setup' },
	{ wikilink: '[[docs/Guide#Setup]]', href: 'docs/Guide.md#setup', path: 'docs/Guide.md', hash: 'setup' },
	{ wikilink: '[[docs/Guide#1. 概述|Overview]]', href: 'docs/Guide.md#1-概述', path: 'docs/Guide.md', hash: '1-概述' },
	{ wikilink: '[[My Notes (v2)#Setup]]', href: 'My%20Notes%20%28v2%29.md#setup', path: 'My Notes (v2).md', hash: 'setup' },
	{ wikilink: '[[Notes#^abc123]]', href: 'Notes.md#abc123', path: 'Notes.md', hash: 'abc123' },
	{ wikilink: '[[log.txt#Errors]]', href: 'log.txt#errors', path: 'log.txt', hash: 'errors' },
];

test('every href the wikilink rewriter emits is claimed as a local markdown target', () => {
	for (const { wikilink, href, path, hash } of cases) {
		const target = getMarkdownLinkTarget(href);
		assert.notEqual(target, null, `${wikilink} -> ${href} was not claimed as a markdown link`);
		assert.equal(target?.path, path, `${wikilink} resolved to the wrong path`);
		assert.equal(target?.hash, hash, `${wikilink} resolved to the wrong anchor`);
	}
});

test('a bare note name without the appended extension would not be claimed', () => {
	// This is why the rewriter appends ".md": Obsidian omits the extension,
	// but getMarkdownLinkTarget() keys entirely off it, and an unclaimed href
	// falls through to the external-URL opener instead of opening a tab.
	assert.equal(hasMarkdownLinkExtension('Notes'), false);
	assert.equal(getMarkdownLinkTarget('Notes#setup'), null);
});

test('wikilink targets resolve relative to the document that contains them', () => {
	const target = getMarkdownLinkTarget('docs/Guide.md#1-概述');
	assert.notEqual(target, null);
	assert.equal(resolveMarkdownTargetPath('/vault/index.md', target!), '/vault/docs/Guide.md');
});

test('non-markdown wikilink targets are left literal rather than emitted as links', () => {
	// The rewriter declines these (`wikilinks_to_files_the_viewer_cannot_open_
	// stay_literal`); this asserts the reason — the frontend would not claim
	// them either.
	assert.equal(getMarkdownLinkTarget('report.pdf#Intro'), null);
	assert.equal(getMarkdownLinkTarget('diagram.svg#part'), null);
});

test('the extension list the rewriter mirrors still matches markdownLinks.ts', () => {
	// The last cross-language copy of this list. Every TypeScript reader — the
	// sanitizer's URI pattern, the export's `.md` -> `.html` rewrite, the Open
	// dialog filter — now imports MARKDOWN_LINK_EXTENSIONS from markdownLinks.ts,
	// so a drift between two of them is no longer expressible. Rust cannot
	// import it, so the drift is caught here instead, by reading the array back
	// out of the source and comparing the two *sets*: a third-party extension
	// added to either side alone fails, in whichever direction it was added.
	const declared = rustSource.match(/const MARKDOWN_LINK_EXTENSIONS: \[&str; \d+\] = \[([^\]]*)\]/);
	assert.notEqual(declared, null, 'MARKDOWN_LINK_EXTENSIONS disappeared from the Rust backend');
	const extensions = [...declared![1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
	assert.deepEqual(
		[...extensions].sort(),
		[...MARKDOWN_LINK_EXTENSIONS].sort(),
		'the Rust and TypeScript extension lists disagree — add the extension to both',
	);
	for (const extension of extensions) {
		assert.equal(hasMarkdownLinkExtension(`file.${extension}`), true, extension);
	}
});

test('every wikilink Copy Reference builds carries the heading the rewriter needs', () => {
	// The rewriter only rewrites heading-bearing forms; a bare `[[Notes]]` stays
	// literal text (see the scope note above). So the contract is that *every*
	// `[[...]]` the viewer writes to the clipboard contains a `#`.
	//
	// Asserted that way round rather than as "three call sites match
	// `[[${fn}#${...}]]`". That form hard-coded the local variable names holding
	// the basename — renaming `fn` broke it — and the count, so adding a fourth
	// correct Copy Reference entry failed while replacing one of the three with a
	// broken bare form still left three matches and passed.
	// The string moved: all three entries build it through `headingReference`,
	// which picks the spelling the document is already written in (see
	// `copyReferenceStyle.test.ts`). The contract this test exists for is
	// unchanged — a wikilink Copy Reference writes always carries a `#`,
	// because the rewriter leaves a bare `[[Notes]]` as literal text — so it
	// is asserted where the string is now built.
	// Code lines only: the doc comment above the function spells `[[…]]` out
	// in prose, and prose is not something Copy Reference writes.
	const code = referenceSource
		.split('\n')
		.filter((line) => !/^\s*(\*|\/\/)/.test(line))
		.join('\n');
	const emitted = [...code.matchAll(/`\[\[[^`]*\]\]`/g)].map((match) => match[0]);
	assert.ok(emitted.length > 0, 'Copy Reference no longer builds a wikilink — has the format moved?');
	for (const wikilink of emitted) {
		assert.match(
			wikilink,
			/#/,
			`${wikilink}: a wikilink without a heading is left as literal text by process_wikilinks()`,
		);
	}
});
