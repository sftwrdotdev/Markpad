import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, test } from 'node:test';

import { callbackBodies, enclosingFunctionName, functionSource, offsetOf, readSource, sliceBetween, sliceFrom } from './sourceTree.js';

// scripts/sourceTree.ts is the plumbing four convention tests state their claims
// through, so a hole in it is a hole in all of them at once, and it is invisible
// from those files: they keep passing. Both holes below were real.
//
//  - `enclosingFunctionName` matched `\n\t…function NAME(` and nothing else. A
//    raw `invoke('render_markdown')` inside `const f = async () => {}` was
//    therefore attributed to the classic `function` above it, which in
//    MarkdownViewer.svelte is the wrapper renderPipelineConvention.test.ts
//    demands. Measured: the bypass planted, the whole suite green.
//  - The `$effect` bodies monacoStartupGraph.test.ts checks were sliced with
//    `/\$effect\(\(\) => \{([\s\S]*?)\n\t\}\);/`, which needs a tab-indented
//    closing brace. Measured: a one-line effect merged into its successor and
//    the ungated `editor` read inside it went unreported.
//
// So the forms are pinned here, on the helpers, where a regression is one
// failure with a name rather than four tests quietly asserting nothing. These
// run against string literals, not against `src/` — refactoring the app cannot
// make them fail, and changing the helper is the only thing that can.

describe('the sourceTree helpers', () => {
	/** `enclosingFunctionName` over one `<script>`, at the offset of `needle`. */
	function scopeOf(script: string, needle = 'HERE'): string | null {
		const source = `<script lang="ts">\n${script}\n</script>\n`;
		return enclosingFunctionName(source, offsetOf(source, needle));
	}

	test('every declaration form in src/ names its enclosing function', () => {
		// The four shapes `src/` actually uses: 451 classic declarations, 74
		// `const f = (…) =>` / `const f = async (…) =>`, the class methods in
		// stores/, and object-literal shorthand (MarkdownViewer's `acceptNode`).
		assert.equal(scopeOf('function classic() {\n\tHERE;\n}'), 'classic');
		assert.equal(scopeOf('export async function exported() {\n\tHERE;\n}'), 'exported');
		assert.equal(scopeOf('const arrow = () => {\n\tHERE;\n};'), 'arrow');
		assert.equal(scopeOf('const asyncArrow = async (raw: string) => {\n\tHERE;\n};'), 'asyncArrow');
		assert.equal(scopeOf('const typed: () => void = () => {\n\tHERE;\n};'), 'typed');
		assert.equal(scopeOf('const expression = function () {\n\tHERE;\n};'), 'expression');
		assert.equal(scopeOf('const named = function inner() {\n\tHERE;\n};'), 'inner');
		assert.equal(scopeOf('const obj = {\n\tshorthand() {\n\t\tHERE;\n\t},\n};'), 'shorthand');
		assert.equal(scopeOf('const obj = {\n\tprop: () => {\n\t\tHERE;\n\t},\n};'), 'prop');
		assert.equal(scopeOf('class C {\n\tmethod() {\n\t\tHERE;\n\t}\n}'), 'method');
		assert.equal(scopeOf('class C {\n\tfield = () => {\n\t\tHERE;\n\t};\n}'), 'field');
		assert.equal(scopeOf('obj.assigned = () => {\n\tHERE;\n};'), 'assigned');

		// The regression that motivated the rewrite: an arrow function declared
		// after a classic one used to inherit the classic one's name.
		assert.equal(
			scopeOf('function wrapper() {\n\treturn 1;\n}\n\nconst bypass = async () => {\n\tHERE;\n};'),
			'bypass',
		);
	});

	test('an offset outside every named function has no enclosing name', () => {
		assert.equal(scopeOf('const x = HERE;'), null);
		assert.equal(scopeOf('function f() {\n\treturn 1;\n}\nconst x = HERE;'), null);

		// An inline handler in the markup is not inside any named function either,
		// so a caller comparing against a wrapper name fails on it rather than
		// silently inheriting the last function declared above.
		const markup = '<script lang="ts">\n\tfunction f() {}\n</script>\n\n<button onclick={() => HERE}>x</button>\n';
		assert.equal(enclosingFunctionName(markup, offsetOf(markup, 'HERE')), null);
	});

	test('the innermost named function wins, and anonymous ones are transparent', () => {
		assert.equal(scopeOf('function outer() {\n\tfunction inner() {\n\t\tHERE;\n\t}\n}'), 'inner');
		assert.equal(scopeOf('function outer() {\n\tconst inner = () => {\n\t\tHERE;\n\t};\n}'), 'inner');

		// Lexically still inside `outer`, which is what the callers ask about.
		assert.equal(scopeOf('function outer() {\n\tqueue.then(() => {\n\t\tHERE;\n\t});\n}'), 'outer');
	});

	test('a callback body is its own body, whatever the closing brace looks like', () => {
		// The exact hole: with no `\n\t});` of its own, the one-line effect used to
		// merge into the next one — and the merged text carried the `editorReady`
		// the first effect was missing.
		const source = [
			'<script lang="ts">',
			'\t$effect(() => { if (editor) editor.layout(); });',
			'\t$effect(() => {',
			'\t\tif (editorReady) sync();',
			'\t});',
			'\t$effect.pre(() => {\n\t\tpre();\n\t});',
			'</script>',
		].join('\n');

		assert.deepEqual(callbackBodies(source, '$effect'), [
			'{ if (editor) editor.layout(); }',
			'{\n\t\tif (editorReady) sync();\n\t}',
		]);
		assert.deepEqual(callbackBodies(source, '$effect.pre'), ['{\n\t\tpre();\n\t}']);
		assert.deepEqual(callbackBodies(source, 'onMount'), []);
	});

	test('a function is extracted as a function, not as "up to the next declaration"', () => {
		// The hole this closes: an anchor pair that names the *neighbour* stops
		// bounding the subject as soon as anything is declared between them, and a
		// neighbour carrying the same guard then satisfies the assertion. Here the
		// two functions are deliberately near-identical, which is the case in
		// MarkdownViewer.svelte (`canTransfer`/`canDetach`,
		// `handleDetach`/`moveTabToWindow`) that went undetected.
		const source = [
			'<script lang="ts">',
			'\tasync function subject(id: string) {',
			'\t\treturn guard(id);',
			'\t}',
			'',
			'\tasync function neighbour(id: string) {',
			'\t\treturn guard(id);',
			'\t}',
			'',
			'\tconst options = {',
			'\t\tpredicate: (id: string) => guard(id),',
			'\t};',
			'</script>',
		].join('\n');

		assert.equal(functionSource(source, 'subject'), 'async function subject(id: string) {\n\t\treturn guard(id);\n\t}');
		assert.equal(functionSource(source, 'predicate'), '(id: string) => guard(id)');

		// The neighbour is not part of the subject, which is the whole point.
		assert.doesNotMatch(functionSource(source, 'subject'), /neighbour/);

		// A renamed or duplicated subject is a failure with a name, not a wider slice.
		assert.throws(() => functionSource(source, 'gone'), /exactly one function named "gone", found 0/);
		// Two functions of the same name is the case a "first match wins" helper
		// would silently pick one of — a wrapper and the method it delegates to, say.
		assert.throws(
			() => functionSource(source.replace('predicate:', 'subject:'), 'subject'),
			/exactly one function named "subject", found 2/,
		);
	});

	test('the parsers read .ts files as well as components', () => {
		const module = 'export function fromModule() {\n\tHERE;\n}\n';
		assert.equal(enclosingFunctionName(module, offsetOf(module, 'HERE')), 'fromModule');
		assert.deepEqual(callbackBodies('queueMicrotask(() => {\n\trun();\n});\n', 'queueMicrotask'), ['{\n\trun();\n}']);
	});

	test('a missing anchor fails loudly instead of slicing from -1', () => {
		// `'abc'.slice(-1)` is `'c'`, not `''` — which is why an unguarded
		// `slice(indexOf(...))` produces a one-character subject that no
		// `doesNotMatch` can fail against.
		assert.equal('abc'.slice('abc'.indexOf('zzz')), 'c');

		assert.throws(() => sliceFrom('abc', 'zzz'), /expected to find "zzz"/);
		assert.throws(() => sliceBetween('abc', 'zzz', 'b'), /expected to find "zzz"/);
		assert.throws(() => sliceBetween('abc', 'a', 'zzz'), /expected to find "zzz" after "a"/);
		assert.throws(() => offsetOf('abc', 'zzz'), /expected to find "zzz"/);
		assert.throws(() => offsetOf('abcb', 'b', 4), /expected to find "b"/);

		assert.equal(sliceFrom('abc', 'b'), 'bc');
		assert.equal(sliceBetween('abcd', 'b', 'd'), 'bc');
		assert.equal(offsetOf('abcb', 'b', 2), 3);

		// `end` is searched from the end of `start`, so an earlier occurrence of
		// `end` is a failure rather than an empty subject.
		assert.throws(() => sliceBetween('xabc', 'b', 'x'), /expected to find "x" after "b"/);
	});
});

describe('release version bump', () => {
	// The stand-in cargo is a shell script.
	const posix = { skip: process.platform === 'win32' && 'needs a POSIX shell' };

	test('one command writes the version into all three files', posix, () => {
		// RELEASING.md used to name two of the three, so the third was skipped by
		// following the instructions correctly. The script runs here against a
		// copy of the three manifests, with a stand-in `cargo` that records what
		// it was asked and rewrites the lock entry the way `cargo update` does.
		const root = realpathSync(mkdtempSync(join(tmpdir(), 'markpad-release-')));
		try {
			mkdirSync(join(root, 'src-tauri'));
			mkdirSync(join(root, 'bin'));
			writeFileSync(join(root, 'package.json'), '{\n  "name": "markpad",\n  "version": "1.0.0"\n}\n');
			writeFileSync(
				join(root, 'src-tauri/Cargo.toml'),
				// A dependency's `version` ahead of ours, as a reordered manifest has.
				'[dependencies]\nserde = { version = "1.0.0" }\n\n[package]\nname = "Markpad"\nversion = "1.0.0"\n',
			);
			writeFileSync(
				join(root, 'src-tauri/Cargo.lock'),
				'[[package]]\nname = "Markpad"\nversion = "1.0.0"\n\n[[package]]\nname = "serde"\nversion = "1.0.0"\n',
			);
			const cargo = join(root, 'bin/cargo');
			writeFileSync(
				cargo,
				[
					'#!/bin/sh',
					'echo "$PWD $*" > ../cargo-call',
					'[ "$1 $2 $3" = "update -p Markpad" ] || exit 9',
					'sed -i.bak "/^name = \\"Markpad\\"$/{n;s/^version = .*/version = \\"$5\\"/;}" Cargo.lock',
				].join('\n'),
			);
			chmodSync(cargo, 0o755);

			const run = spawnSync(process.execPath, [resolve('scripts/release.mjs'), '2.3.4'], {
				cwd: root,
				env: { ...process.env, PATH: `${join(root, 'bin')}:${process.env.PATH}` },
				encoding: 'utf8',
			});
			assert.equal(run.status, 0, run.stderr);

			assert.equal(JSON.parse(readSource(join(root, 'package.json'))).version, '2.3.4');
			const toml = readSource(join(root, 'src-tauri/Cargo.toml'));
			assert.match(toml, /\[package\]\nname = "Markpad"\nversion = "2.3.4"/);
			assert.match(toml, /serde = \{ version = "1.0.0" \}/, 'a dependency version is not ours');
			assert.match(readSource(join(root, 'src-tauri/Cargo.lock')), /name = "Markpad"\nversion = "2.3.4"/);
			// The lock is cargo's format; it is handed to cargo, not rewritten.
			assert.equal(
				readSource(join(root, 'cargo-call')).trim(),
				`${join(root, 'src-tauri')} update -p Markpad --precise 2.3.4`,
			);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});
