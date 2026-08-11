import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import test from 'node:test';

import { callbackBodies, readSource, walkSourceFiles } from './sourceTree.js';

// Monaco is ~86% of Markpad's startup JavaScript (measured: a 4.4 MB chunk out
// of 4.7 MB on first paint, ~360ms of parse+eval, paid once per window because
// every window is its own webview) and a reader who only ever views Markdown
// never touches it. It is therefore loaded with `await import()` from
// Editor.svelte's `onMount`, not with a top-level `import`.
//
// WHAT THIS FILE PROVES: walking only *static* imports from the app's entry
// module (`src/routes/+page.svelte`), no reachable module names `monaco-editor`
// or `monaco-vim` as a static import. That is the property a bundler turns into
// "not in the startup chunk", and it is the property a careless edit destroys —
// re-adding `import * as monaco from 'monaco-editor'` anywhere in the reachable
// graph, in Editor.svelte or in any util it pulls in, fails this test.
//
// WHAT IT DOES NOT PROVE: that Rollup actually emitted a separate chunk. Chunk
// splitting is the bundler's decision, and `vite.config.js` could still be
// changed to inline everything (e.g. a `manualChunks` that merges it, or
// `inlineDynamicImports`). Verifying that needs a real build; the numbers from
// one are recorded in the PR description instead. Source-level reachability is
// the half that can run in CI without a 45-second build, so it is the half
// that is locked here.
//
// Type-only imports (`import type ...`) are deliberately ignored: TypeScript
// erases them, so they cost nothing at runtime and Editor.svelte relies on one.

const ENTRY = 'src/routes/+page.svelte';
const FORBIDDEN = ['monaco-editor', 'monaco-vim'];

/** `import ... from 'x'`, `export ... from 'x'`, and bare `import 'x'`. */
const STATIC_IMPORT = /(?:^|[\s;}])(?:import|export)\s+(?!type\s)(?:[^'"();]*?\sfrom\s*)?['"]([^'"]+)['"]/g;
/** `import type ... from 'x'` / `export type ... from 'x'` — erased at compile time. */
const TYPE_IMPORT = /\b(?:import|export)\s+type\s[^'"();]*?from\s*['"][^'"]+['"]/g;

/**
 * The part of `file` that can carry an import, read through `readSource`.
 *
 * A filter on top of the shared reader rather than a reader of its own — it was
 * spelled `readSource` here first, with its own `readFileSync` inside, which is
 * how this file ended up with a private copy of the line-ending decision.
 */
function importableSource(file: string): string {
	const raw = readSource(file);
	if (!file.endsWith('.svelte')) return raw;
	// Only the <script> blocks can import; the markup and <style> cannot.
	return [...raw.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]).join('\n');
}

/**
 * Specifiers of the statements that survive to runtime.
 *
 * Type-only statements are deleted from the text before matching rather than
 * subtracted from the result set afterwards. Subtracting by specifier string is
 * what a first draft of this file did, and it had a hole big enough to drive the
 * regression through: Editor.svelte imports `monaco-editor` for its types, so a
 * `import * as monaco from "monaco-editor"` added next to it would have been
 * cancelled out by its own type import and reported clean.
 */
function staticSpecifiers(source: string): string[] {
	const runtimeOnly = source.replace(TYPE_IMPORT, '');
	return [...runtimeOnly.matchAll(STATIC_IMPORT)].map((m) => m[1]);
}

/**
 * Resolve a specifier to a file on disk, or `null` for a bare package name.
 * SvelteKit sources use the `.js` extension for relative TypeScript imports, so
 * `./x.js` has to be probed as `./x.ts` too.
 */
function resolveLocal(specifier: string, fromFile: string): string | null {
	let target: string;
	if (specifier.startsWith('.')) target = resolve(dirname(fromFile), specifier);
	else if (specifier.startsWith('$lib/')) target = resolve('src/lib', specifier.slice('$lib/'.length));
	else if (specifier.startsWith('$app/') || !specifier.startsWith('/')) return null;
	else return null;

	const candidates = [
		target,
		target.replace(/\.js$/, '.ts'),
		target.replace(/\.js$/, '.svelte.ts'),
		`${target}.ts`,
		`${target}.js`,
		`${target}.svelte`,
	];
	return candidates.find((c) => existsSync(c) && !c.endsWith('/')) ?? null;
}

function walkStaticGraph(entry: string): Map<string, string[]> {
	const reached = new Map<string, string[]>();
	const queue = [resolve(entry)];

	while (queue.length > 0) {
		const file = queue.pop()!;
		if (reached.has(file)) continue;

		const specifiers = staticSpecifiers(importableSource(file));
		reached.set(file, specifiers);

		for (const specifier of specifiers) {
			const local = resolveLocal(specifier, file);
			if (local) queue.push(local);
		}
	}

	return reached;
}

test('the parser sees the imports it is supposed to see', () => {
	// A graph walk that silently resolves nothing would pass this file forever.
	const graph = walkStaticGraph(ENTRY);
	const files = [...graph.keys()].map((f) => relative(process.cwd(), f).replace(/\\/g, '/'));

	assert.ok(files.includes('src/lib/MarkdownViewer.svelte'), 'reached the viewer from the entry');
	assert.ok(files.includes('src/lib/components/Editor.svelte'), 'reached Editor.svelte, which is still statically imported');
	assert.ok(files.includes('src/lib/stores/settings.svelte.ts'), 'followed a $lib specifier with a .js extension');
	assert.ok(files.length > 30, `walked a real graph, not a stub (got ${files.length} files)`);

	// The negative check below is only meaningful if a static Monaco import
	// would in fact be seen. Plant the exact regressions this file exists to
	// catch and prove the matcher reports each one.
	assert.deepEqual(
		staticSpecifiers('import * as monaco from "monaco-editor";'),
		['monaco-editor'],
		'a static Monaco import is detected when present',
	);
	assert.deepEqual(
		staticSpecifiers('import type * as Monaco from "monaco-editor";'),
		[],
		'a type-only import is erased at compile time and does not count',
	);
	assert.deepEqual(
		// The shape Editor.svelte actually has: the type import stays, and a
		// value import of the same module is added beside it.
		staticSpecifiers(
			'import type * as Monaco from "monaco-editor";\nimport * as monaco from "monaco-editor";',
		),
		['monaco-editor'],
		'a value import is not masked by a type import of the same module',
	);
	assert.deepEqual(
		staticSpecifiers('const monaco = await import("monaco-editor");'),
		[],
		'a dynamic import is not a static one',
	);
});

test('Monaco is not reachable by static import from the app entry', () => {
	const graph = walkStaticGraph(ENTRY);

	const offenders: string[] = [];
	for (const [file, specifiers] of graph) {
		for (const specifier of specifiers) {
			if (FORBIDDEN.some((pkg) => specifier === pkg || specifier.startsWith(`${pkg}/`))) {
				// Vite's `?worker` imports compile to a URL plus a `new Worker(url)`
				// wrapper and emit the worker bundle as its own file, so they are
				// already lazy — verified against a production build: zero worker
				// requests on first paint.
				if (specifier.endsWith('?worker')) continue;
				offenders.push(`${relative(process.cwd(), file)} -> ${specifier}`);
			}
		}
	}

	assert.deepEqual(
		offenders,
		[],
		'Monaco must be reached with await import(), never a static import, or it lands back in the startup chunk',
	);
});

test('Editor.svelte loads Monaco with a dynamic import', () => {
	const editor = readSource('src/lib/components/Editor.svelte');

	assert.match(
		editor,
		/monaco = await import\("monaco-editor"\)/,
		'the module is fetched on mount',
	);
	assert.match(
		editor,
		/import type \* as Monaco from "monaco-editor"/,
		'types come from a type-only import, which is erased',
	);

	// `onMount` must stay synchronous: Svelte only accepts a synchronously
	// returned function as the unmount cleanup, so an `async` callback would
	// hand it a promise and leak the editor and its listeners.
	assert.doesNotMatch(editor, /onMount\(async/, 'onMount is not async');
	assert.match(editor, /cancelled = true;/, 'an in-flight import is cancellable on unmount');
});

test('every effect that drives the editor waits for editorReady', () => {
	// `editor` is a plain `let`, assigned after an await. An effect gated on it
	// alone runs once against nothing and is never re-triggered, which silently
	// drops scroll sync, the zoom-aware font size, the theme and Vim mode.
	const editor = readSource('src/lib/components/Editor.svelte');

	// The bodies come from the parsed component, not from
	// `/\$effect\(\(\) => \{([\s\S]*?)\n\t\}\);/`. That pattern needed a
	// tab-indented `});` to end a body, so an effect written on one line had no
	// terminator of its own and the lazy match ran on to the *next* effect's —
	// returning the two as a single body whose text contains the `editorReady`
	// the first half was missing. Measured, by planting
	// `$effect(() => { if (editor) editor.layout(); });` in Editor.svelte: the
	// ungated read passed, and `effects.length >= 5` did not notice because the
	// merge kept the count at six. scripts/sourceTree.test.ts pins that form.
	const effects = callbackBodies(editor, '$effect');

	// Vacuity guard, restated so it cannot be satisfied by a body going missing:
	// the parse must account for every `$effect` the file spells.
	const spelled = (editor.match(/\$effect\s*\(/g) ?? []).length;
	assert.equal(effects.length, spelled, `every $effect(…) yielded a body (spelled ${spelled})`);
	assert.ok(effects.length >= 5, `found the effects (got ${effects.length})`);

	for (const body of effects) {
		if (!/\beditor\b/.test(body)) continue;
		assert.match(
			body,
			/editorReady/,
			`an effect touching the editor is not gated on editorReady:\n${body.slice(0, 160)}`,
		);
	}
});

test('no source file outside Editor.svelte reintroduces a static Monaco import', () => {
	// Belt and braces for modules the graph walk cannot reach statically (a file
	// only pulled in through a dynamic import elsewhere): grep the whole tree.
	const offenders: string[] = [];

	for (const path of walkSourceFiles('src')) {
		for (const specifier of staticSpecifiers(importableSource(path))) {
			if (specifier.endsWith('?worker')) continue;
			if (FORBIDDEN.some((pkg) => specifier === pkg || specifier.startsWith(`${pkg}/`))) {
				offenders.push(`${path} -> ${specifier}`);
			}
		}
	}

	assert.deepEqual(offenders, []);
});

test("monaco-vim's one import into monaco still resolves", () => {
	// monaco-vim 0.4.4 is the latest release and is unmaintained. It imports
	// exactly one monaco module, and without an extension:
	//
	//   monaco-editor/esm/vs/editor/editor.api
	//
	// monaco-editor 0.55 maps `"./*": "./*"` -- an identity -- so a bundler adds
	// `.js` on the filesystem and finds it. 0.56 changed it to
	// `"./*": "./esm/vs/*.js"`, which prepends a prefix the specifier already
	// carries: the path doubles to `esm/vs/esm/vs/…` and nothing is there. Once a
	// package declares `exports`, a resolver may not fall back to the filesystem
	// path it would otherwise have used, so there is no recovery.
	//
	// The 0.56 bump built clean, passed 976 tests on three platforms, and shipped
	// vim mode dead. Nothing here loads monaco-vim, and no build step resolved it
	// strictly enough to notice. So this applies the map by hand and asks whether
	// the file is there -- which is the whole of what went wrong.
	const monacoPkg = JSON.parse(readSource('node_modules/monaco-editor/package.json'));
	const patterns = Object.entries((monacoPkg.exports ?? {}) as Record<string, unknown>).filter(
		([key]) => key.includes('*'),
	);

	// One build of the package rather than a walk of its dist: the .mjs, .cjs and
	// .umd.js are the same source through three bundlers and name the same import.
	const specifiers = new Set<string>();
	for (const match of readSource('node_modules/monaco-vim/dist/index.mjs').matchAll(
		/['"](monaco-editor\/[^'"]+)['"]/g,
	)) {
		specifiers.add(match[1]);
	}
	assert.ok(specifiers.size > 0, 'found no monaco imports in monaco-vim; this check has nothing to ask about');

	const unresolvable: string[] = [];
	for (const specifier of specifiers) {
		const subpath = `.${specifier.slice('monaco-editor'.length)}`;
		let target: string | null = null;
		for (const [pattern, value] of patterns) {
			const [before, after] = pattern.split('*');
			if (!subpath.startsWith(before) || !subpath.endsWith(after)) continue;
			const star = subpath.slice(before.length, subpath.length - after.length);
			target = String(value).replace('*', star);
			break;
		}
		if (!target) continue;
		const base = `node_modules/monaco-editor/${target.slice(2)}`;
		// The extensions a bundler will try after the map has had its say.
		if (![base, `${base}.js`, `${base}.mjs`].some((candidate) => existsSync(candidate))) {
			unresolvable.push(`${specifier} → ${target}`);
		}
	}
	assert.deepEqual(
		unresolvable,
		[],
		"monaco-editor's exports map sends a monaco-vim import somewhere that does not exist; vim mode will be dead",
	);
});
