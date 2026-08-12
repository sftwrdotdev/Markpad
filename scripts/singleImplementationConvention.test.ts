import assert from 'node:assert/strict';
import test from 'node:test';

import { SANITIZER_FILES, type SourceFile, filesMatching, readSourceFiles } from './sourceTree.js';

// A fixed behavior must have exactly one implementation.
//
// The bug class this catches: a behavior gets fixed in file A while a stale
// pre-fix copy of the same logic survives in file B. Nothing type-checks the
// copy, nothing imports it, and it looks like a reusable shared helper — so the
// next person to "reuse" or "sync" it silently reverts a merged fix.
//
// The existing behavior tests cannot see this. youtubeExternalFallback.test.ts,
// taskToggleMemory.test.ts, mermaidPrintTheme.test.ts and previewScrollSync.ts
// each read one hard-coded file, so a second copy living anywhere else is
// invisible to them. Every rule below therefore scans the whole `src` tree and
// pins *which files* are allowed to contain the marker.
//
// A marker is only allowed to be something the compiler cannot see for itself:
// an exported symbol or type name, a magic string handed to another language or
// library (a Tauri command, a Monaco language id, a CSS custom property), or the
// literal shape of a defect that must never come back. A marker must never be a
// private identifier — a parameter name, a local variable, a helper that nothing
// outside its own file can reach. `every rule keeps at least one live
// implementation` below turns every marker into something a rename can break, so
// pinning a private name would promote it to a public contract and make ordinary
// local refactoring fail this suite for no behavioural reason.
//
// To add a behavior: append a row. `allowed` is the complete set of src-relative
// paths permitted to match `marker`; anything else is a duplicate implementation.

type Rule = {
	name: string;
	// What breaks if a second copy of this appears.
	why: string;
	marker: RegExp;
	allowed: string[];
	// The tree to scan, repo-relative. `src` unless the rule is about the suite.
	dir?: string;
	// Optional: every allowed file that matches `marker` must also match this.
	requires?: { pattern: RegExp; message: string };
};

const RULES: Rule[] = [
	{
		name: 'mermaid rendering remembers the diagram source',
		why: 'PDF/HTML export re-renders Mermaid in the light theme from data-mermaid-source; a render path without rememberDiagramSource exports blank or dark-themed diagrams (#359).',
		marker: /mermaid\.render\(/g,
		allowed: ['src/lib/utils/mermaidPrint.ts', 'src/lib/utils/richContent.ts'],
		requires: {
			pattern: /rememberDiagramSource/,
			message: 'a Mermaid render site must record the source via rememberDiagramSource',
		},
	},
	{
		name: 'Mermaid theme resolution has one implementation',
		why: 'resolveMermaidTheme in mermaidPrint.ts is shared by the on-screen render and the print restore so the two cannot drift; a second site deciding the theme is that drift.',
		// Pins the exported helper, not the `'dark' : 'neutral'` ternary inside it:
		// the ternary is one of many spellings of the same decision (an if/else or
		// double quotes slipped straight past), while what actually has to stay
		// single is the function both paths call. What the function *returns* for
		// each appearance setting is checked for real — by calling it — in
		// mermaidPrintTheme.test.ts.
		marker: /resolveMermaidTheme\s*\(/g,
		allowed: ['src/lib/MarkdownViewer.svelte', 'src/lib/utils/mermaidPrint.ts'],
	},
	{
		name: 'editor scroll-sync max is measured from content height',
		why: 'Split-view scroll sync must not count the editor bottom padding; the pre-fix form subtracted the viewport height from getScrollHeight() (#316).',
		marker: /getScrollHeight\(\)\s*-\s*[^;\n)]*height/gi,
		allowed: [],
	},
	{
		name: 'YouTube links never become embedded frames',
		why: 'The app dropped frame-src from its CSP and renders YouTube as a thumbnail anchor that opens the browser; an iframe path is the pre-fix version and cannot load.',
		marker: /createElement\((['"])iframe\1\)/g,
		// Allowed nowhere. The entry that used to sit here covered
		// `replaceWithYoutubeEmbed` in MarkdownViewer.svelte, an uncalled
		// pre-fix leftover, and said to delete the two together — #388 deleted
		// the copy, so the entry goes with it and the rule now guards the
		// whole tree.
		allowed: [],
	},
	{
		name: 'DOMPurify is configured in one place',
		why: 'The sanitize contract lives in utils/sanitize.ts; an inline DOMPurify config elsewhere is a second, unreviewed sanitizer.',
		// Import sites, so an aliased `import purify from "dompurify"` cannot slip
		// past the `DOMPurify.sanitize(` call-site scan in previewSanitize.test.ts.
		// Both scans read the same allowlist so a new sanitizer is one decision.
		marker: /from\s+["']dompurify["']/g,
		allowed: SANITIZER_FILES,
	},
	{
		name: 'the raw render_markdown command has one set of call sites',
		why: 'Every preview render must go through renderMarkdownPreview, which strips YAML front matter before invoking the Rust renderer; a raw invoke elsewhere renders the front matter as body text. The command name is a string, so the compiler cannot see the call at all.',
		// The viewer half — that its one occurrence sits inside
		// renderMarkdownPreview rather than merely in the same file — is pinned by
		// renderPipelineConvention.test.ts.
		marker: /invoke\(\s*'render_markdown'/g,
		allowed: ['src/lib/MarkdownViewer.svelte', 'src/lib/utils/export.ts'],
	},
	{
		name: 'rich-content rendering has one implementation',
		why: 'utils/richContent.ts owns the render pipeline (highlight.js + KaTeX + Mermaid) for both the preview and the HTML export; a second renderRichContent is a fork that drifts from it — which is exactly how the export ended up shipping raw LaTeX and unhighlighted code.',
		// The viewer keeps a same-named wrapper that supplies the live element and
		// the copy-button behaviour, so the marker has to separate the two. It does
		// that on the exported options *type* — a real contract the export imports
		// — rather than on the parameter being spelled `options`, which is private
		// to the implementation and free to be renamed.
		marker: /function\s+renderRichContent\s*\([^)]*\bRenderRichContentOptions\b/g,
		allowed: ['src/lib/utils/richContent.ts'],
	},
	{
		name: 'editor language mapping has one implementation',
		why: 'A second extension-to-language table drifts from the one the editor actually uses, and the editor then opens a file under the wrong Monaco grammar.',
		// Pins the Monaco language id the table falls back to, not the private
		// `getLanguage` helper that happens to hold it today: 'plaintext' is a
		// magic string Monaco defines and TypeScript cannot check, and any second
		// extension table has to name it too.
		marker: /return '(?:plaintext)'/g,
		allowed: ['src/lib/MarkdownViewer.svelte'],
	},
	{
		name: 'the home tab sentinel is spelled in one place',
		why: "The home screen lives in a tab whose `path` is a sentinel rather than a file. Every reader of that field has to know the sentinel, and the one that did not — the render gate, which identified the home tab as `path === '' && title === 'Recents'` — went stale the day the sentinel was introduced and rendered the home tab as a blank page for six months (#392). A literal only some readers know about is a literal that can fall out of step in silence.",
		// The string itself, not the `isHomePath` helper: a second site would
		// spell the sentinel again rather than call the helper, so the helper's
		// name is exactly what such a site does NOT contain. Comments say
		// `HOME_TAB_PATH`, which is a symbol a rename can carry.
		marker: /(['"])HOME\1/g,
		allowed: ['src/lib/utils/homeTab.ts'],
	},
	{
		name: 'highlight color palette has one definition',
		why: 'A second palette drifts from the one bound to the --highlight-color custom property, so find highlights and the settings preview disagree.',
		// Pins the custom property the palette feeds — the actual contract with
		// styles.css and FindBar.svelte, and a string no type system reads —
		// instead of the private `highlightColorMap` binding that produces it.
		marker: /--highlight-color:/g,
		allowed: ['src/lib/MarkdownViewer.svelte'],
	},
	{
		name: 'the supported-language catalogue has one definition',
		why: 'settings.svelte.ts carried a second { code, name, nativeName } table beside getSupportedLanguages(). Only its `code` column was read — SUPPORTED_LANGUAGE_CODES mapped it and nothing else touched it — so the display columns were dead data that nothing compared against the live catalogue, and they drifted: `pt` was "Portuguese" in the table the language <select> renders and "Portuguese (European)" in the dead one. A drift no user can see is a drift no bug report can find.',
		// Pins `nativeName`, the column a catalogue exists to carry and the one
		// the <select> renders, rather than `getSupportedLanguages` — a second
		// table is by construction a site that does NOT call the accessor. The
		// property is public: Settings.svelte reads `lang.nativeName` off the
		// returned objects, so this is a cross-module field name, not a local.
		// The read site spells it `lang.nativeName`, which the `:` excludes.
		marker: /nativeName\s*:/g,
		allowed: ['src/lib/utils/i18n.ts'],
	},
	{
		name: 'the LanguageCode union has one definition',
		why: 'The union was declared identically in i18n.ts and settings.svelte.ts. Two unions over the same 26 codes type-check against each other only while they agree; adding a language to one leaves the other rejecting it, and the compiler reports that as an unrelated assignability error far from either declaration.',
		// The declaration, not a mention: `export type { LanguageCode }` (the
		// re-export settings.svelte.ts keeps so its importers are unaffected) has
		// a brace between the keyword and the name and is deliberately not matched.
		marker: /export type LanguageCode\s*=/g,
		allowed: ['src/lib/utils/i18n.ts'],
	},
	{
		name: 'the TOC width bounds have one definition',
		why: 'MarkdownViewer.svelte re-declared `const TOC_MIN_WIDTH = 180` / `TOC_MAX_WIDTH = 420` next to TOC_WIDTH_RANGE, the object NumericSettingRange documents as the single source of truth and the object settings.setTocWidth already clamps against. Bounds the drag handle enforces but persistence does not (or the reverse) are a width the user can set and not keep.',
		// The defect shape, spelled as it was spelled. Allowed nowhere: the drag
		// clamp, the Home/End jumps and the aria-valuemin/max on the separator all
		// read TOC_WIDTH_RANGE now, so any reappearance of a locally named TOC
		// bound is the second definition. `TOC_RESIZE_STEP` is *not* covered and
		// must not be: it is the 16px arrow-key increment, not TOC_WIDTH_RANGE.step.
		marker: /TOC_(?:MIN|MAX)_WIDTH/g,
		allowed: [],
	},
	{
		name: 'the TOC separator advertises the settings range',
		why: 'aria-valuemin/max is the bound assistive tech reports; a literal there goes stale silently because no visual check can see it. This is the half of the TOC rule above that a differently-named copy would escape.',
		marker: /aria-valuemin=/g,
		allowed: ['src/lib/MarkdownViewer.svelte'],
		requires: {
			pattern: /aria-valuemin=\{TOC_WIDTH_RANGE\.min\}\s*\n\s*aria-valuemax=\{TOC_WIDTH_RANGE\.max\}/,
			message: 'the resize separator must advertise TOC_WIDTH_RANGE.min/.max, not numbers of its own',
		},
	},
	{
		name: 'a fold is named in one place',
		why: "The expression that names a fold was written out three times — in the renderer, in the preview's click handler and in the outline — and two of them disagreed: the outline strips a trailing `^block-id` off the heading text before keying by it and the renderer does not, so for those headings the outline's fold button and the preview's chevron addressed different folds. Nothing type-checks a string built the same way in three files. `assignFoldKey` computes it once, while the markup is built, and leaves it on the element for `foldKeyOf` to read back.",
		// The shape of the defect, not the helper's name: a second site is by
		// construction one that does NOT call `assignFoldKey`, and what it would
		// contain instead is this — the id-then-text fallback, spelled out.
		marker: /id \|\| [A-Za-z.]*textContent/g,
		allowed: ['src/lib/utils/foldState.ts'],
	},
	{
		name: 'this suite reads a file through one function',
		why: "A test that reads source with its own readFileSync gets the bytes Git checked out, and on Windows `core.autocrlf` makes those CRLF. Every `\\n` in a pattern then matches nothing and every anchor containing one is 'not found' — fifteen files were red on the maintainer's Windows checkout while cutting v2.7.0 and were hand-patched assertion by assertion (#452). `readSource` in sourceTree.ts decides the line ending once, on read, so the assertions stay written against `\\n` and a new test cannot re-open the hole by accident. Read the file with `readSource(path)` from './sourceTree.js' — it takes a cwd-relative string or a `new URL(…, import.meta.url)` — and write the assertion against `\\n`.",
		// The call, not the import: `import { readFileSync }` on its own reads
		// nothing, and a file may legitimately keep the import for another member.
		marker: /readFileSync\s*\(/g,
		allowed: ['scripts/sourceTree.ts'],
		dir: 'scripts',
	},
	{
		name: 'this suite walks a directory through one function',
		why: "The other half of the same story. A private directory walk misses the `\\\\`→`/` normalization `walkSourceFiles` does, so on Windows every path it reports is spelled with backslashes and every allowlist compared against it is a list of strings that cannot match. i18nCoverage.test.ts carried exactly that copy and needed the identical hand-patch in #452; monacoStartupGraph.test.ts carried a second one that happened to be spelled with a template literal and so escaped by luck rather than by design. Use `walkSourceFiles(dir)` for the paths or `readSourceFiles(dir)` for paths plus text, both from './sourceTree.js'.",
		marker: /readdirSync\s*\(/g,
		allowed: ['scripts/sourceTree.ts'],
		dir: 'scripts',
	},
];

// One walk per tree, shared by the rules that name it. `scripts` is a tree here
// too: the last two rules are about the suite reading `src`, not about `src`.
const TREES = new Map<string, SourceFile[]>();

function sourcesIn(dir: string): SourceFile[] {
	const cached = TREES.get(dir);
	if (cached) return cached;
	const sources = readSourceFiles(dir);
	TREES.set(dir, sources);
	return sources;
}

for (const rule of RULES) {
	test(`single implementation: ${rule.name}`, () => {
		const sources = sourcesIn(rule.dir ?? 'src');
		const matched = filesMatching(sources, rule.marker);

		const unexpected = matched.filter((path) => !rule.allowed.includes(path));
		assert.deepEqual(
			unexpected,
			[],
			`second implementation found — ${rule.why}\nReuse the existing one instead of copying it. If this really is a new legitimate site, add it to \`allowed\` with a reason.`,
		);

		if (rule.requires) {
			for (const path of matched) {
				const text = sources.find((source) => source.path === path)!.text;
				assert.match(text, rule.requires.pattern, `${path}: ${rule.requires.message}`);
			}
		}
	});
}

test('every rule keeps at least one live implementation', () => {
	// Guards the rules themselves: a marker that matches nothing has gone stale
	// (renamed symbol, deleted feature) and is silently no longer guarding.
	for (const rule of RULES) {
		if (rule.allowed.length === 0) continue;
		assert.ok(
			filesMatching(sourcesIn(rule.dir ?? 'src'), rule.marker).length > 0,
			`rule "${rule.name}" matches nothing in ${rule.dir ?? 'src'} — update its marker or drop the rule`,
		);
	}
});
