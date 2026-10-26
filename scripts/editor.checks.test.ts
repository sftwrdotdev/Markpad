import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { describe, test } from 'node:test';

import { parseTokenTheme, TokenTheme } from 'monaco-editor/esm/vs/editor/common/languages/supports/tokenization.js';

import { callbackBodies, enclosingFunctionName, filesMatching, functionSource, readDictionarySource, readRustBackend, readSource, readSourceFiles, sliceBetween, walkSourceFiles } from './sourceTree.js';
import { markdownTokenRules } from '../src/lib/utils/editorTheme.js';
import { MONACO_IME_PATCH, MONACO_TEXTAREA_FILE, patchMonacoTextAreaForIme } from './monacoImePatch.mjs';
import { importedThemeRules, PREVIEW_KIND_VARS } from '../src/lib/utils/theme.js';
import { TOKEN_TYPES } from '../src/lib/utils/semanticTokens.js';
import { DEFAULT_IMAGE_DIRECTORY } from '../src/lib/utils/imageEmbed.js';

// Editor.svelte translates the settings store into Monaco options and
// keybindings. Every regression locked here came from that translation layer
// being wired to the wrong shape: a string option read as a boolean, a
// modifier that macOS never delivers, one key bound twice, and a native
// behaviour dropped by the action that replaced it.
describe('editor option wiring', () => {
	const editor = readSource('src/lib/components/Editor.svelte');

	function count(source: string, pattern: RegExp): number {
		return source.match(pattern)?.length ?? 0;
	}

	test('editor options are applied by a single updateOptions effect', () => {
		// Two competing effects (one nested in onMount, one top level) wrote the
		// same Monaco options with different values — notably fontSize with and
		// without the zoom factor — so the winner depended on effect ordering.
		// What that one call applies is editor.test.ts "editor options are applied by a
		// single updateOptions effect"; how many call sites there are is only in the
		// component's source.
		assert.equal(count(editor, /editor\.updateOptions\(/g), 1, 'exactly one updateOptions call site');
	});

	test('platform detection reads settings.osType and never writes it', () => {
		// `platformOf` is the app's one platform answer, including the synchronous
		// `navigator.platform` fallback that lets the keybindings register once, at
		// mount (shortcuts.spec.ts tests the fallback).
		const helper = sliceBetween(editor, 'function isMacPlatform', '\n\t}');
		assert.match(helper, /platformOf\(settings\.osType\) === 'macos'/, 'asks platformOf, not a copy of it');
		assert.doesNotMatch(editor, /navigator\.platform/, 'no second platform check in Editor.svelte');

		assert.doesNotMatch(editor, /settings\.osType\s*=[^=]/, 'Editor.svelte must not write to the settings store');
	});

	test('cut, copy and the Vim clipboard register are the only clipboard writers', () => {
		// The whole-line rule itself is editor.test.ts "custom copy keeps Monaco's
		// whole-line copy on an empty selection". This keeps it single: one writer
		// each, so cut and copy cannot drift apart, and the rule cannot be
		// implemented twice with two different answers. Vim's `"+` register (#775)
		// writes the text monaco-vim already chose, so it never derives text from a
		// selection and cannot disagree.
		// The handlers live in utils/editorClipboard.ts since the paste/drop/cut move.
		const clipboard = readSource('src/lib/utils/editorClipboard.ts');
		assert.equal(
			count(editor + clipboard, /invoke\('clipboard_write_text'/g),
			2,
			'clipboard_write_text is called from copyToClipboard and cutToClipboard, nowhere else in the editor',
		);
		assert.match(
			readSource('src/lib/utils/vimAttach.ts'),
			/installVimClipboardRegisters\(VimMode, \(text\) => \{\s*invoke\('clipboard_write_text', \{ text \}\)/,
			'the third writer is the Vim register',
		);
		assert.match(functionSource(clipboard, 'copyToClipboard'), /clipboardTextForSelection\(editor, monaco\)/);
		assert.match(functionSource(clipboard, 'cutToClipboard'), /clipboardTextForSelection\(editor, monaco\)/);
	});

});

// The editor's Markdown colours. Two things can make a rule here do nothing at
// all, and neither is visible to the compiler: a token name no grammar emits
// (#676's defect, one layer over), and a colour that has drifted from the one
// the rest of the app resolves through `--color-*`.
describe('editor theme contracts', () => {
	const styles = readSource('src/styles.css');

	/** A `--color-*` value, read out of the block that defines the given appearance. */
	function paletteColor(appearance: 'light' | 'dark', name: string): string {
		const block = appearance === 'dark'
			? styles.slice(styles.indexOf(':root[data-theme="dark"] {'))
			: styles.slice(styles.indexOf(':root {'));
		const match = block.match(new RegExp(`--color-${name}:\\s*(#[0-9a-fA-F]{6})`));
		assert.ok(match, `styles.css must define --color-${name} for ${appearance}`);
		return match[1].slice(1).toLowerCase();
	}

	test('the colours are the app palette, not a second one', () => {
		// One-way duplication: `defineTheme` takes hex strings and never sees the
		// stylesheet, so the literals in editorTheme.ts have to be checked against
		// the custom properties everything else in the app resolves.
		const expected = {
			accent: 'accent-fg',
			code: 'success-fg',
			emphasis: 'attention-fg',
			link: 'done-fg',
			muted: 'fg-muted',
			text: 'fg-default',
		};

		for (const appearance of ['light', 'dark'] as const) {
			const byToken = new Map(markdownTokenRules(appearance).map((rule) => [rule.token, rule.foreground]));
			assert.equal(byToken.get('keyword.md'), paletteColor(appearance, expected.accent));
			assert.equal(byToken.get('string.md'), paletteColor(appearance, expected.code));
			assert.equal(byToken.get('variable.md'), paletteColor(appearance, expected.code));
			assert.equal(byToken.get('strong.md'), paletteColor(appearance, expected.emphasis));
			assert.equal(byToken.get('emphasis.md'), paletteColor(appearance, expected.emphasis));
			assert.equal(byToken.get('string.link.md'), paletteColor(appearance, expected.link));
			assert.equal(byToken.get('escape.md'), paletteColor(appearance, expected.muted));
			assert.equal(byToken.get('variable.source.md'), paletteColor(appearance, expected.text));
			assert.equal(byToken.get('keyword.table.header.md'), paletteColor(appearance, expected.text));
		}
	});

	test('the editor pane and the theme importer are the only writers', () => {
		assert.deepEqual(filesMatching(readSourceFiles('src'), /\.editor\.setTheme\(/), [
			// The widget's owner: it defines `app-theme-*` and it is the only thing
			// on screen a Monaco theme can be seen on.
			'src/lib/components/Editor.svelte',
			// The same pane's mount, which follows the system colour scheme.
			'src/lib/utils/mountEditor.ts',
			// `vscode-custom` does not exist as a theme until this file has read the
			// JSON and called `defineTheme`, so the set has to happen where the
			// define does — `Editor.svelte`'s change effect abstains for `vscode:`.
			'src/lib/utils/theme.ts',
		]);
	});

});

/*
 * Every edit the app makes on the user's behalf is its own undo step.
 *
 * `editor.executeEdits` does not close the undo element that typing left open:
 * it goes straight to `model.pushEditOperations`, which appends to it. Typing
 * `hello`, pasting `world` and pressing Cmd+Z therefore took both away. That was
 * checked against the installed Monaco (0.55.1) in jsdom before this was
 * written: without a stop the second undo emptied the buffer, with one it left
 * `hello`. Monaco's own paste and cut push the stop themselves; these are the
 * app's replacements for them, and for the format tools, so they have to as
 * well. The stop goes BEFORE the edit: what is typed after it opens a new
 * element on its own, which the same probe showed.
 */
describe('editor undo stops', () => {
	const EDITOR = 'src/lib/components/Editor.svelte';

	test('no executeEdits in the editor runs without an undo stop ahead of it in its function', () => {
		// Paste, cut and the drop handler read the clipboard or the disk through
		// Tauri first, so they cannot be run here; what is pinned for them, and for
		// every site added later, is that the stop comes before the edit.
		const missing: string[] = [];
		// Paste, cut and drop moved to utils/editorClipboard.ts and keep the rule there.
		for (const file of [EDITOR, 'src/lib/utils/editorClipboard.ts']) {
			const source = readSource(file);
			let at = -1;
			while ((at = source.indexOf('editor.executeEdits(', at + 1)) !== -1) {
				const name = enclosingFunctionName(source, at);
				assert.ok(name, `an executeEdits outside any named function at offset ${at}`);
				const start = source.lastIndexOf(name, at);
				if (!source.slice(start, at).includes('editor.pushUndoStop()')) {
					missing.push(`${file}: ${name} (line ${source.slice(0, at).split('\n').length})`);
				}
			}
		}
		assert.deepEqual(missing, []);
	});
});

// The build-time patch to Monaco that stops the IME composition overlay from
// jittering (#724). See the header of monacoImePatch.mjs for the mechanism.
//
// These are text assertions against the INSTALLED Monaco, and they say so:
// the contract being pinned is that the two source lines the patch anchors on
// still exist exactly once in the file it targets. A Monaco bump that moves or
// rewrites either line — including the bump that finally carries the upstream
// fix, microsoft/vscode#333909 — turns this red, which is the signal to delete
// the patch rather than let it silently stop applying.
describe('Monaco IME patch', () => {
	// Through `readSource`, like every other test that reads a file: the anchors
	// are written against `\n`, and it is what keeps them matching on a Windows
	// checkout (see release.checks.test.ts).
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
});

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
describe('Monaco startup graph', () => {
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
		else if (specifier.startsWith('#lib/')) target = resolve('src/lib', specifier.slice('#lib/'.length));
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
		assert.ok(files.includes('src/lib/stores/settings.svelte.ts'), 'followed a #lib specifier with a .js extension');
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
		// Cancellation on unmount: editor.test.ts "unmounting while Monaco is still
		// loading creates no editor".
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
		// merge kept the count at six. scripts/release.test.ts pins that form.
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
});

// The layer that colours from the renderer's answer instead of the grammar's
// guess. Three seams, each invisible to the compiler: the kinds Rust emits
// against the legend the encoder indexes, the legend against the theme rules
// that style it, and the delta encoding Monaco decodes.
describe('semantic token contracts', () => {
	test('every kind Rust emits is in the legend', () => {
		// A kind the legend does not know is dropped by the encoder — silently, and
		// only for that construct, which is exactly the kind of gap nobody notices.
		const rust = readRustBackend();
		const emitted = new Set(
			[...rust.matchAll(/"([a-z]+)(?:\.(marker))?"\s*,?\s*out\s*\)/g)].map((match) => match[1]),
		);
		assert.ok(emitted.size > 0, 'the extractor must still name its kinds as literals');
		for (const kind of emitted) {
			assert.ok(
				(TOKEN_TYPES as readonly string[]).includes(kind),
				`semantic.rs emits \`${kind}\`, which the legend does not list`,
			);
		}
	});

	test('no kind falls through to an imported theme that has nothing to say', () => {
		// The failure this guards is silent and total. A semantic token whose type
		// the theme does not name resolves to the theme's *root* rule, whose
		// foreground is a real colour id rather than "none"
		// (`semanticTokensProviderStyling.js`, the `if (tokenStyle.foreground)`
		// branch), and `sparseTokensStore` then masks the grammar's colour out and
		// paints that plain default over it. An imported theme lost its heading,
		// link, quote and inline-code colours to this path the moment the semantic
		// layer shipped, and nothing in either file said so.
		const rust = readRustBackend();
		const emitted = [
			...new Set([...rust.matchAll(/"([a-z]+(?:\.marker)?)"\s*,?\s*out\s*\)/g)].map((match) => match[1])),
		];
		assert.ok(emitted.length > 0, 'the extractor must still name its kinds as literals');

		const rules = importedThemeRules(
			[{ scope: 'markup.bold', settings: { foreground: '#e06c75', fontStyle: 'bold' } }],
			true,
		);
		// `base: 'vs-dark'` with `inherit: true` contributes the default foreground
		// that every unmatched token resolves to.
		const theme = TokenTheme.createFromParsedTokenTheme(
			parseTokenTheme([{ token: '', foreground: '#d4d4d4', background: '#1e1e1e' }, ...rules]),
			[],
		);
		const fallthrough = theme._match('a-token-no-rule-names').metadata;

		const unstyled = emitted.filter((kind) => theme._match(kind).metadata === fallthrough);
		assert.deepEqual(unstyled, [], 'these repaint an imported theme with its own default foreground');
	});
});

// #676: an imported VS Code theme colours TextMate scopes, Monaco's markdown
// tokenizer emits names of its own, and until now nothing renamed one into the
// other — so `markup.bold` reached `defineTheme` and matched nothing.
describe('markdown token colour variables', () => {
	test('every construct colour the importer writes is read by the stylesheet', () => {
		// The two halves are joined by a variable name and nothing else: the
		// importer writes `--md-strong`, `styles.css` reads it, and no type or
		// import holds them together. Renaming one silently drops the colour.
		const styles = readSource('src/styles.css');

		for (const [kind, cssVar] of PREVIEW_KIND_VARS) {
			// The comma is the fallback. Without one, a construct the theme does not
			// name renders with no colour at all rather than with the value the rule
			// carried before the import.
			assert.ok(styles.includes(`var(${cssVar},`), `${cssVar} is written for \`${kind}\` and read by no rule with a fallback`);
		}
	});
});

/*
	The link the app writes for a pasted or dropped image has to name the file
	Rust just created — after a CommonMark parse, and after each of Markpad's
	two readers has had its way with the result.

	So every case below is checked end to end, through the real readers:

	  parse    the destination CommonMark hands the renderer, per its grammar
	  preview  `processMarkdownHtml`: decodeURIComponent, then resolve
	  export   `resolveExportImagePath`, imported here, not modelled

	The one thing modelled rather than run is comrak, which is Rust. Its
	`escape_href` (comrak 0.54, src/html.rs) is the identity on everything
	`encodeImageDestination` emits: its safe set covers the unreserved ASCII we
	pass through, it copies a `%` verbatim when two hex digits follow, and the
	two characters it does rewrite — `&` to `&amp;`, `'` to `&#x27;` — are
	undone by the HTML parser before either reader sees them. Passing the
	destination straight to the readers is therefore faithful, and
	`the escapes comrak passes through unchanged` below pins the assumption
	that matters.
*/
describe('image embed wiring', () => {
	test('Editor.svelte writes an image link through this module only', () => {
		// The two call sites — paste (`save_image`) and drop (`copy_file_to_img`) —
		// carried verbatim copies of this logic 300 lines apart, and the space-only
		// escape had to be fixed in both. release.checks.test.ts
		// keeps the embed string itself single; this keeps the pre-fix escape from
		// coming back next to it.
		// Paste and drop live in utils/editorClipboard.ts; the completion stays in the component.
		const source = readSource('src/lib/components/Editor.svelte') + readSource('src/lib/utils/editorClipboard.ts');
		assert.equal(source.includes('%20'), false, 'a hand-rolled space escape is back');
		assert.match(source, /imageEmbed\(relPath\)/);
		assert.equal(source.includes(`|| "${DEFAULT_IMAGE_DIRECTORY}"`), false);
		// Three call sites read the image directory — paste, drop, and the path
		// completion that lists the folder's contents. Expanding `${filename}` at
		// two of them and not the third would offer completions out of a folder
		// named after the literal token, which exists nowhere.
		assert.equal(
			source.includes('settings.imageDirectory ||'),
			false,
			'a call site resolves the image directory itself',
		);
	});
});

describe('X11 clipboard ownership', () => {
	// #729: on Debian XFCE, everything copied out of Markpad reached an empty
	// clipboard, while pasting into it worked. X11 has no clipboard store — the
	// copying process owns the CLIPBOARD selection and serves the bytes on
	// request — and arboard tears that ownership down when the last `Clipboard`
	// handle drops, which was the moment `clipboard_write_text` returned.
	//
	// A source-shape assertion because the proposition cannot be run: the failure
	// needs an X server and a desktop without a clipboard manager, and CI has
	// neither. It names the helper on purpose; nothing but the call connects the
	// two, and the function exists for no other reason.
	test('the copy command keeps X11 clipboard ownership past its own return', () => {
		const body = sliceBetween(
			readSource('src-tauri/src/commands.rs'),
			'pub fn clipboard_write_text',
			'\n}',
		);
		assert.match(body, /retain_clipboard_ownership\(\)/);
	});
});

describe('editor context menu (#261)', () => {
	const viewer = readSource('src/lib/MarkdownViewer.svelte');

	test('every label the editor menu asks for exists in every language', () => {
		// A missing key does not throw — `t()` falls back to English and then to
		// the key itself, so a forgotten locale ships the string
		// "menu.changeAllOccurrences" to the user.
		const i18n = readDictionarySource();
		const locales = (i18n.match(/\n\s+menu: \{/g) ?? []).length;
		assert.ok(locales >= 6, `expected at least six locales, found ${locales}`);

		const menu = functionSource(readSource('src/lib/utils/viewerContextMenu.ts'), 'editorContextMenuItems');
		for (const key of [...menu.matchAll(/t\('menu\.(\w+)', language\)/g)].map((m) => m[1])) {
			assert.equal(
				(i18n.match(new RegExp(`\\b${key}:`, 'g')) ?? []).length >= locales,
				true,
				`menu.${key} is missing from at least one language`,
			);
		}
	});
});
