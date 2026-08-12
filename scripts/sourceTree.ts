import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { parse } from 'svelte/compiler';

// Shared plumbing for the few tests that have to read `src/` as text.
//
// They exist because some contracts are invisible to the compiler: a Tauri
// command name is a string, `.svelte` files cannot be imported by the Node test
// runner, and "this behaviour has exactly one implementation" is not a type.
// Everything else belongs in a test that imports the real function and runs it.
//
// Three copies of `walk()` used to live in singleImplementationConvention,
// renderPipelineConvention and previewSanitize; the DOMPurify allowlist was
// maintained twice. One copy each, here.
//
// The same argument is why `readSource` exists rather than a `readFileSync` per
// call site: reading a file as text is a decision about line endings and path
// separators, and a decision made 135 times is a decision made differently.
// `singleImplementationConvention.test.ts` holds both to one copy.

export type SourceFile = { path: string; text: string };

/**
 * A repo file as text, with CRLF collapsed to LF.
 *
 * Every assertion below that matches source against a pattern containing `\n`,
 * and every anchor handed to `sliceFrom` / `sliceBetween` that spells a line
 * break, is a claim about bytes Git checked out. On Windows `core.autocrlf`
 * defaults to true, so the whole working tree arrives CRLF, none of those
 * patterns match, and `sliceBetween` throws `expected to find "…"` for an anchor
 * that is sitting right there in the file.
 *
 * Not hypothetical: fifteen test files were red on the maintainer's Windows
 * checkout while cutting v2.7.0, and were hand-patched one assertion at a time
 * in #452 — `[^\r\n]` here, `source.includes('\r\n') ? … : …` there. Those
 * patches are correct and they do not scale. 60 files in this suite read a repo
 * file as text across 135 call sites, every new one re-rolls the same dice on a
 * Unix machine, and the loss is only discovered by a maintainer running the
 * suite on Windows.
 *
 * So the line ending is decided once, here, and every assertion downstream is
 * written against `\n` — the form the files have in the repository.
 *
 * This does not make CRLF untestable, because no test that cares about CRLF
 * reads it off the disk. `frontMatter.test.ts`, `frontMatterProseBlock.test.ts`
 * and `pasteUrlContext.test.ts` all assert on the parser's handling of a CRLF
 * *document*, and each spells the document as a literal in the test — which is
 * the right way round: a fixture whose bytes matter should not be at the mercy
 * of what Git decided to check out.
 *
 * `path` is `string | URL` because both spellings are already in use: a
 * cwd-relative string (`npm test` runs from the repo root) and
 * `new URL('../src/…', import.meta.url)`, which resolves against the test file
 * rather than the cwd. `readFileSync` takes either, so no call site has to
 * change shape to get normalized.
 *
 * The `import.meta.url` spelling only works under `node --test`. Vitest serves
 * test files through Vite, so `import.meta.url` is an `http://` URL there and
 * `readFileSync` rejects it with "The URL must be of scheme file". A `*.spec.ts`
 * file must use the cwd-relative string form.
 */
export function readSource(path: string | URL): string {
	return readFileSync(path, 'utf8').replace(/\r\n/g, '\n');
}

/**
 * `source` from the first occurrence of `start` onwards.
 *
 * The assertion is the whole point. `source.slice(source.indexOf(marker))` with
 * an absent marker slices from -1, which yields the last *character* of the file
 * rather than nothing — so an `assert.doesNotMatch` against the result can never
 * fail, and an `assert.match` fails while blaming the wrong thing.
 *
 * Both instances found in this suite so far were silent for their whole life:
 * scrollSyncInput.test.ts (the anchor drifted when the code around it changed)
 * and issue261EditorPdf.test.ts (the subject was deleted in the same commit that
 * added the assertion). Neither was noticed by a test run, because neither
 * failed.
 */
export function sliceFrom(source: string, start: string): string {
	const from = source.indexOf(start);
	assert.notEqual(from, -1, `expected to find ${JSON.stringify(start)}`);
	return source.slice(from);
}

/**
 * `source` from the first `start` to the first `end` that follows it.
 *
 * Searching `end` from the end of `start` rather than from 0 is deliberate: an
 * `end` that happens to occur earlier in the file produces an empty string, and
 * an empty subject is degenerate for the same reason -1 is.
 */
export function sliceBetween(source: string, start: string, end: string): string {
	const from = source.indexOf(start);
	assert.notEqual(from, -1, `expected to find ${JSON.stringify(start)}`);
	const to = source.indexOf(end, from + start.length);
	assert.notEqual(to, -1, `expected to find ${JSON.stringify(end)} after ${JSON.stringify(start)}`);
	return source.slice(from, to);
}

/**
 * The offset of `marker` in `source`, which must be present.
 *
 * The third shape, for the assertions that compare two offsets rather than
 * slice with them: `assert.ok(a < b)` reads as "a comes first" but is also
 * satisfied by `a === -1`, so a marker that stopped existing turns the
 * ordering claim into a claim about nothing — the same failure `sliceFrom`
 * exists for, one operator away. `from` mirrors `String#indexOf`'s second
 * argument for the "…after this point" cases.
 */
export function offsetOf(source: string, marker: string, from = 0): number {
	const at = source.indexOf(marker, from);
	assert.notEqual(at, -1, `expected to find ${JSON.stringify(marker)}`);
	return at;
}

/** Every compilable source file under `dir`, with forward-slash paths. */
export function walkSourceFiles(dir: string): string[] {
	const out: string[] = [];
	for (const name of readdirSync(dir)) {
		const path = join(dir, name);
		if (statSync(path).isDirectory()) out.push(...walkSourceFiles(path));
		else if (/\.(ts|svelte|js)$/.test(name)) out.push(path.replace(/\\/g, '/'));
	}
	return out;
}

export function readSourceFiles(dir: string): SourceFile[] {
	return walkSourceFiles(dir).map((path) => ({ path, text: readSource(path) }));
}

/**
 * Every `.rs` file of the backend, repo-relative and sorted.
 *
 * Named rather than listed because the list changes: `lib.rs` was one 5,500
 * line file until it was split into `fs_safety`/`markdown`/`commands`/`app`,
 * and every test that had spelled `src-tauri/src/lib.rs` went red on a change
 * that moved no code. A test asking "does the backend do X" is asking about
 * the crate, not about which file the author last put X in.
 */
export function rustSourceFiles(): string[] {
	const dir = new URL('../src-tauri/src/', import.meta.url);
	return readdirSync(dir)
		.filter((name) => name.endsWith('.rs'))
		.sort()
		.map((name) => `src-tauri/src/${name}`);
}

/**
 * The whole Rust backend as one text, in filename order.
 *
 * For the assertions that are about the crate rather than about a file. An
 * anchor pair handed to `sliceBetween` still has to be unique across the
 * concatenation, which is the same requirement it had within one file.
 */
export function readRustBackend(): string {
	return rustSourceFiles()
		.map((path) => readSource(new URL(`../${path}`, import.meta.url)))
		.join('\n');
}

/** src-relative paths of the files that contain `marker`, sorted. */
export function filesMatching(sources: SourceFile[], marker: RegExp): string[] {
	return sources
		.filter(({ text }) => new RegExp(marker.source, marker.flags.replace('g', '')).test(text))
		.map(({ path }) => path)
		.sort();
}

/**
 * The only files allowed to hand DOMPurify a configuration.
 *
 * `sanitize.ts` owns the document policy; `richContent.ts` sanitizes Mermaid's
 * own SVG output, which needs `foreignObject` and the inline `<style>` the
 * document policy forbids — a different input under a deliberately different
 * config. Both `previewSanitize.test.ts` (call sites) and
 * `singleImplementationConvention.test.ts` (imports) key off this one list, so
 * adding a sanitizer is one edit and one decision instead of two.
 */
export const SANITIZER_FILES = ['src/lib/utils/richContent.ts', 'src/lib/utils/sanitize.ts'];

// ------------------------------------------------------------ syntax, parsed
//
// The three helpers below answer questions about *scope* — "which function is
// this offset inside", "what is the body of this callback". Those were regexes
// until they were shown to be answerable by writing the code differently:
//
//   const renderRawBypass = async (raw: string) => {
//       return (await invoke('render_markdown', { content: raw })) as string;
//   };
//
// dropped into MarkdownViewer.svelte left the whole suite green, because
// `enclosingFunctionName` matched `\n\t…function NAME(` and nothing else, so the
// call was attributed to whichever `function` happened to precede it — which was
// the wrapper the convention test demands. Fixing that by adding arrow functions
// to the pattern fixes one spelling. The forms actually in `src/` are 451 classic
// declarations, 74 `const f = (…) =>` / `const f = async (…) =>`, the class
// methods in `stores/`, and object-literal shorthand (`acceptNode(node) {`) — and
// the next contributor is free to invent a 5th.
//
// So the scope questions are answered from the real AST instead. `svelte/compiler`
// is already a dependency and `homeTabRender.test.ts` already parses a component
// with it; a function node is a function node whatever the spelling, and there is
// no pattern left to write around. The cost is ~170ms for the largest component,
// paid once per file thanks to the cache below.

type FunctionScope = { start: number; end: number; name: string | null };

/** Node kinds that introduce a function scope. */
const FUNCTION_TYPES = new Set(['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression']);

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null;
}

function offsetsOf(node: Record<string, unknown>): { start: number; end: number } | null {
	return typeof node.start === 'number' && typeof node.end === 'number'
		? { start: node.start, end: node.end }
		: null;
}

/**
 * The parsed component, plus the shift from AST offsets back to `text` offsets.
 *
 * A `.ts` file is not a component, so it is wrapped in a `<script>` before
 * parsing and the wrapper's length is subtracted from every offset afterwards.
 * Svelte's parser reads TypeScript in a `lang="ts"` block, which is what every
 * `.svelte` file in `src/` uses anyway.
 */
const parseCache = new Map<string, { root: unknown; shift: number }>();

function parsedSource(text: string): { root: unknown; shift: number } {
	const cached = parseCache.get(text);
	if (cached) return cached;

	const prefix = '<script lang="ts">\n';
	const isComponent = /<script[\s>]/.test(text);
	const parsed = {
		root: parse(isComponent ? text : `${prefix}${text}\n</script>`, { modern: true }) as unknown,
		shift: isComponent ? 0 : -prefix.length,
	};
	parseCache.set(text, parsed);
	return parsed;
}

/** Depth-first walk of every node in the tree, with the binding name in scope. */
function walkAst(
	node: unknown,
	visit: (node: Record<string, unknown>, boundName: string | null) => void,
	boundName: string | null = null,
	seen: Set<object> = new Set(),
): void {
	if (Array.isArray(node)) {
		for (const child of node) walkAst(child, visit, boundName, seen);
		return;
	}
	if (!isRecord(node) || seen.has(node)) return;
	seen.add(node);

	if (typeof node.type === 'string') visit(node, boundName);

	for (const [key, value] of Object.entries(node)) {
		if (key === 'loc' || key === 'range' || key === 'parent' || key === 'metadata') continue;
		walkAst(value, visit, nameBoundTo(node, key), seen);
	}
}

/** `foo` for `const foo = …`, `{ foo: … }`, `foo() {}`, `x.foo = …`. */
function nameBoundTo(parent: Record<string, unknown>, key: string): string | null {
	switch (parent.type) {
		case 'VariableDeclarator':
			return key === 'init' ? identifierName(parent.id) : null;
		case 'Property':
		case 'PropertyDefinition':
		case 'MethodDefinition':
			return key === 'value' ? identifierName(parent.key) : null;
		case 'AssignmentExpression':
			return key === 'right' ? identifierName(parent.left) : null;
		default:
			return null;
	}
}

function identifierName(node: unknown): string | null {
	if (!isRecord(node)) return null;
	switch (node.type) {
		case 'Identifier':
			return typeof node.name === 'string' ? node.name : null;
		case 'PrivateIdentifier':
			return typeof node.name === 'string' ? `#${node.name}` : null;
		case 'Literal':
			return typeof node.value === 'string' ? node.value : null;
		case 'MemberExpression':
			return identifierName(node.property);
		default:
			return null;
	}
}

const scopeCache = new Map<string, FunctionScope[]>();

/** Every function scope in `text`, outermost first, with the name it is bound to. */
function functionScopes(text: string): FunctionScope[] {
	const cached = scopeCache.get(text);
	if (cached) return cached;

	const { root, shift } = parsedSource(text);
	const scopes: FunctionScope[] = [];
	walkAst(root, (node, boundName) => {
		if (typeof node.type !== 'string' || !FUNCTION_TYPES.has(node.type)) return;
		const span = offsetsOf(node);
		if (!span) return;
		scopes.push({
			start: span.start + shift,
			end: span.end + shift,
			name: identifierName(node.id) ?? boundName,
		});
	});
	scopes.sort((a, b) => a.start - b.start || b.end - a.end);

	scopeCache.set(text, scopes);
	return scopes;
}

/**
 * The name of the innermost *named* function whose body contains `index`, or
 * null if the offset sits outside every named function.
 *
 * Used instead of "the two strings appear within N characters of each other":
 * a proximity window silently stops guarding when the function grows, and it
 * cannot see a *second* call site that escaped the wrapper entirely.
 *
 * Anonymous functions are transparent rather than fatal: a call inside
 * `.then(() => …)` inside `renderMarkdownPreview` is still lexically inside
 * `renderMarkdownPreview`, which is the question the callers ask. An offset
 * inside an anonymous function with no named function above it — an inline
 * `onclick={() => …}` in the markup, say — is null, and a caller comparing
 * against a wrapper name fails loudly on it.
 */
export function enclosingFunctionName(text: string, index: number): string | null {
	let name: string | null = null;
	for (const scope of functionScopes(text)) {
		if (scope.start > index) break;
		if (index < scope.end && scope.name) name = scope.name;
	}
	return name;
}

/**
 * The source of the one function bound to `name`, whatever the spelling —
 * `function name() {}`, `const name = () => {}`, `{ name: (…) => {} }`, a class
 * method.
 *
 * For the checks that state something about *one function*, where the anchor
 * pair `sliceBetween(text, 'async function subject', 'async function
 * whatever-comes-next')` names the neighbour rather than the subject: the slice
 * is then only as tight as the declaration order happens to make it, and it
 * widens silently as the file grows. Both uses in truncatedBufferGuard.test.ts
 * had already grown past their subject — the transfer slice ran from
 * `canTransfer` through `canDetach`, the detach slice from `handleDetach`
 * through `moveTabToWindow` — and each swallowed function carries a
 * character-identical copy of the guard under test. Measured: the guard deleted
 * from the subject, the neighbour's copy satisfying the `assert.match`, the
 * whole suite green.
 *
 * A function extracted as a function cannot drift that way. `assert.equal` on
 * the count rather than "the first one" is deliberate: a rename or a second
 * definition of the same name fails here, loudly, instead of quietly changing
 * what the caller is asserting about.
 */
export function functionSource(text: string, name: string): string {
	const found = functionScopes(text).filter((scope) => scope.name === name);
	assert.equal(found.length, 1, `expected exactly one function named ${JSON.stringify(name)}, found ${found.length}`);
	return text.slice(found[0].start, found[0].end);
}

/**
 * The source text of each function argument passed to `callee(…)`, braces
 * included.
 *
 * For the checks that state something about the *body* of a callback — every
 * `$effect` in Editor.svelte reads `editorReady` before it touches `editor`.
 * Slicing those out with `/\$effect\(\(\) => \{([\s\S]*?)\n\t\}\);/` was a
 * demonstrated hole: an effect written on one line has no `\n\t});` of its own,
 * so the lazy match ran on to the *next* effect's closing brace and returned
 * both effects as one body — whose text contains the `editorReady` the first
 * half was missing. Verified: a planted
 * `$effect(() => { if (editor) editor.layout(); });` passed that check, and the
 * `effects.length >= 5` guard did not notice because the merge kept the count at
 * six.
 */
export function callbackBodies(text: string, callee: string): string[] {
	const { root, shift } = parsedSource(text);
	const bodies: string[] = [];

	walkAst(root, (node) => {
		if (node.type !== 'CallExpression' || !isRecord(node.callee)) return;
		const target = offsetsOf(node.callee);
		if (!target || text.slice(target.start + shift, target.end + shift) !== callee) return;

		for (const argument of Array.isArray(node.arguments) ? node.arguments : []) {
			if (!isRecord(argument) || typeof argument.type !== 'string') continue;
			if (!FUNCTION_TYPES.has(argument.type) || !isRecord(argument.body)) continue;
			const body = offsetsOf(argument.body);
			if (body) bodies.push(text.slice(body.start + shift, body.end + shift));
		}
	});

	return bodies;
}

/** Byte offsets of every `name(` call in `text`, skipping import statements. */
export function callSiteOffsets(text: string, name: string): number[] {
	const offsets: number[] = [];
	const pattern = new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\(`, 'g');
	for (const match of text.matchAll(pattern)) {
		const lineStart = text.lastIndexOf('\n', match.index!) + 1;
		if (/^\s*import\b/.test(text.slice(lineStart, match.index!))) continue;
		offsets.push(match.index!);
	}
	return offsets;
}
