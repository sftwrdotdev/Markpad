import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';

import { parse } from 'yaml';

import {
	SANITIZER_FILES,
	type SourceFile,
	filesMatching,
	readRustBackend,
	readSource,
	readSourceFiles,
	rustSourceFiles,
	sliceBetween,
	sliceFrom,
} from './sourceTree.js';

describe('the release workflow', () => {
	const workflow = readSource('.github/workflows/build.yml');
	const stripAppImage = readSource('scripts/strip-appimage.sh');
	const cargoToml = readSource('src-tauri/Cargo.toml');
	const packageJson = JSON.parse(readSource('package.json')) as {
		scripts: Record<string, string>;
		devDependencies: Record<string, string>;
		version: string;
	};

	test('the runtime version and the frontend version cannot drift apart', () => {
		// Tauri reads the runtime version from Cargo.toml while the Tauri config and
		// the frontend read package.json. A mismatch makes tauri-plugin-updater
		// compare the wrong version and either skip or replay an update.
		const cargoVersion = /^\s*\[package\][\s\S]*?^\s*version\s*=\s*"([^"]+)"/m.exec(cargoToml)?.[1];
		assert.equal(cargoVersion, packageJson.version);
	});

	test('a release build cannot write into a version that is already published', () => {
		// The release is composed for `v<version from package.json>`, and
		// softprops/action-gh-release updates an existing release for that tag rather
		// than refusing it. So a dispatch from an unbumped master rewrites the
		// release users are downloading, and every gate this pipeline has -- the
		// draft, the asset check, clicking Publish -- is downstream of that write.
		const step = sliceBetween(workflow, 'This version has not already been released', 'endpoint old installs');
		assert.match(step, /gh release view "\$TAG"/);
		assert.match(step, /isDraft/);
		// Fails closed: an unusable answer stops the run instead of assuming there is
		// no release. Two exits, one for published and one for cannot-tell.
		assert.equal((step.match(/exit 1/g) ?? []).length, 2);
		// And it has to come before the step that does the writing.
		assert.ok(
			workflow.indexOf('This version has not already been released') < workflow.indexOf('- name: Create Release'),
			'the guard runs after the release it guards has been created',
		);
	});

	test('the strip proves itself against the artifact that ships', () => {
		// A CI smoke test cannot catch this defect: the runner's Mesa is the one the
		// libraries were copied from, so nothing mismatches there and the AppImage
		// starts fine. #498 was found by a user on Arch. That leaves "these
		// libraries are absent" as the only property checkable before release, and
		// it has to be checked on the repacked file rather than on the AppDir —
		// appimagetool packing the wrong directory would pass the weaker check.
		const verification = sliceFrom(stripAppImage, '--runtime-file');
		assert.match(verification, /--appimage-extract/);
		assert.match(verification, /is still bundled after the strip/);
	});

	test('a macOS release without the signing secrets still builds', () => {
		// #294 was closed because a workflow that *requires* signing credentials
		// blocks every release until someone configures them. This identity is
		// optional by construction: the step exits before it touches a keychain when
		// MACOS_CERTIFICATE is empty, and `tauri build` signs only when
		// APPLE_SIGNING_IDENTITY is exported -- the name the pinned CLI reads, and
		// the reason this step has to run before the build rather than beside it.
		const step = sliceBetween(workflow, 'Import macOS signing certificate', 'Build MacOS (Universal)');
		assert.match(step, /if \[ -z "\$\{MACOS_CERTIFICATE:-\}" \]; then[\s\S]*?exit 0/);
		assert.match(step, /echo "APPLE_SIGNING_IDENTITY=[^"]*" >> "\$GITHUB_ENV"/);
	});

	test('a signing identity that is only half configured stops the release', () => {
		// The early exit above is for a repository that has never set up signing at
		// all. It reads one of the three secrets, so a set certificate and an empty
		// identity walks straight past it and exports an empty
		// APPLE_SIGNING_IDENTITY -- and a green build that shipped unsigned is the
		// exact outcome this step exists to prevent, since it reaches users as
		// folder access being asked for all over again.
		const step = sliceBetween(workflow, 'Import macOS signing certificate', 'Build MacOS (Universal)');
		assert.match(step, /if \[ -z "\$\{MACOS_SIGNING_IDENTITY:-\}" \]; then[\s\S]*?exit 1/);
	});

	const posixOnly = process.platform === 'win32' ? 'spawns /bin/bash with a POSIX PATH' : false;

	test('official macOS signing refuses partial credentials before touching the keychain', { skip: posixOnly }, () => {
		const step = parse(workflow).jobs.build.steps.find((step: { name: string }) => step.name === 'Import macOS signing certificate');
		const names = ['APPLE_DEVELOPER_ID_P12', 'APPLE_DEVELOPER_ID_PASSWORD', 'APPLE_DEVELOPER_ID_SHA1', 'APPLE_ID', 'APPLE_APP_SPECIFIC_PASSWORD', 'APPLE_TEAM_ID'];
		const complete: Record<string, string> = Object.fromEntries(names.map(name => [name, 'fixture']));
		complete.APPLE_DEVELOPER_ID_P12 = 'Zml4dHVyZQ==';
		complete.APPLE_DEVELOPER_ID_SHA1 = 'A'.repeat(40);
		complete.APPLE_TEAM_ID = 'ABCDEFGHIJ';
		const dir = mkdtempSync(join(tmpdir(), 'markpad-signing-test-'));
		try {
			// A mock command prevents any real keychain access even if a guard regresses.
			writeFileSync(join(dir, 'security'), '#!/bin/sh\necho keychain-touched >&2\nexit 97\n', { mode: 0o755 });
			for (const missing of names) {
				const env = { PATH: `${dir}:/usr/bin:/bin`, RUNNER_TEMP: dir, GITHUB_ENV: join(dir, 'env'), ...complete, [missing]: '' };
				const result = spawnSync('/bin/bash', ['-c', step.run], { env, encoding: 'utf8' });
				assert.notEqual(result.status, 0, `${missing} was silently accepted`);
				assert.doesNotMatch(result.stderr, /keychain-touched/, `${missing} was not checked before import`);
			}
			writeFileSync(join(dir, 'security'), `#!/bin/sh
if [ "$1" = find-identity ]; then
  echo '1) ${complete.APPLE_DEVELOPER_ID_SHA1} "Developer ID Application: Test (ABCDEFGHIJ)"'
fi
`, { mode: 0o755 });
			const envFile = join(dir, 'env');
			const configured = spawnSync('/bin/bash', ['-c', step.run], {
				env: { PATH: `${dir}:/usr/bin:/bin`, RUNNER_TEMP: dir, GITHUB_ENV: envFile, ...complete,
					MACOS_CERTIFICATE: 'Zml4dHVyZQ==', MACOS_CERTIFICATE_PASSWORD: 'legacy', MACOS_SIGNING_IDENTITY: 'legacy' },
				encoding: 'utf8',
			});
			assert.equal(configured.status, 0, configured.stderr);
			assert.equal(readSource(envFile), `MACOS_DEVELOPER_ID=true\nAPPLE_SIGNING_IDENTITY=${complete.APPLE_DEVELOPER_ID_SHA1}\n`);
			const wrongIdentity = spawnSync('/bin/bash', ['-c', step.run], {
				env: { PATH: `${dir}:/usr/bin:/bin`, RUNNER_TEMP: dir, GITHUB_ENV: envFile, ...complete, APPLE_DEVELOPER_ID_SHA1: 'B'.repeat(40) },
				encoding: 'utf8',
			});
			assert.notEqual(wrongIdentity.status, 0, 'a different imported identity must not be accepted');
			writeFileSync(envFile, '');
			const legacy = spawnSync('/bin/bash', ['-c', step.run], {
				env: { PATH: `${dir}:/usr/bin:/bin`, RUNNER_TEMP: dir, GITHUB_ENV: envFile,
					MACOS_CERTIFICATE: 'Zml4dHVyZQ==', MACOS_CERTIFICATE_PASSWORD: 'legacy', MACOS_SIGNING_IDENTITY: 'legacy' },
				encoding: 'utf8',
			});
			assert.equal(legacy.status, 0, legacy.stderr);
			assert.equal(readSource(envFile), 'APPLE_SIGNING_IDENTITY=legacy\n');

			const absent = spawnSync('/bin/bash', ['-c', step.run], { env: { PATH: `${dir}:/usr/bin:/bin` }, encoding: 'utf8' });
			assert.equal(absent.status, 0, absent.stderr);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

});

describe('a package-managed install is not offered an update', () => {
	const store = readSource('src/lib/stores/update.svelte.ts');
	const rust = readRustBackend();

	test('the command exists on the Rust side and is reachable', () => {
		// A Tauri command is addressed by a string, so nothing in the type system
		// connects the two halves: an unregistered command fails at runtime, and
		// this flow's runtime is a Linux package nobody on this project runs daily.
		assert.match(rust, /fn self_update_supported\(app: AppHandle\) -> bool/);
		const handler = sliceBetween(rust, 'tauri::generate_handler![', '])');
		assert.match(handler, /self_update_supported/);
	});

	test('the AppImage is detected through tauri\'s Env, not a raw variable', () => {
		// Which platforms are gated is `only_linux_gates_self_update` in
		// commands.rs. What stays here is the convention that the AppImage is
		// read through tauri's Env, which also verifies the executable is under
		// $TMPDIR/.mount_. `std::env::var("APPIMAGE")` alone is settable by hand.
		const command = sliceBetween(rust, 'fn self_update_supported', '\npub fn get_os_type');
		assert.match(command, /appimage\.is_some\(\)/);
		assert.doesNotMatch(command, /env::var/);
	});
});

describe('Tauri command registration', () => {
	/** Every `#[tauri::command]` function name in the Rust sources. */
	function declaredCommands(): { name: string; file: string }[] {
		const out: { name: string; file: string }[] = [];
		for (const file of rustSourceFiles()) {
			const text = readSource(file);
			// The attribute, any further attributes stacked under it, then the fn.
			for (const m of text.matchAll(
				/#\[tauri::command\][^\n]*\n(?:\s*#\[[^\]]*\]\s*\n)*\s*(?:pub\s+)?(?:async\s+)?fn\s+(\w+)/g,
			)) {
				out.push({ name: m[1], file });
			}
		}
		return out;
	}

	/** Every name inside `generate_handler![…]`, module path stripped. */
	function registeredCommands(): Set<string> {
		// `sliceBetween` keeps its start anchor, so the first comma-separated entry
		// would otherwise be `generate_handler![\n  clipboard_write_text`.
		const handler = sliceBetween(readSource('src-tauri/src/app.rs'), 'generate_handler![', '])').replace(
			'generate_handler![',
			'',
		);
		return new Set(
			handler
				.split(',')
				.map((entry) => entry.trim().split('::').pop() ?? '')
				.filter(Boolean),
		);
	}

	test('every #[tauri::command] is reachable from the frontend', () => {
		// A Tauri command is addressed by a string. Nothing in either type system
		// connects `invoke('render_markdown')` to the Rust function, and nothing
		// connects the function to `generate_handler!` either — so an attribute can
		// sit on a function the app can never call, and the compiler is content.
		//
		// `convert_markdown` carried one for as long as it existed. It was never
		// registered, so no `invoke` could ever have reached it; it is the internal
		// renderer that `render_markdown` calls. The
		// attribute claimed an exposure the app did not have, and the only reason
		// that was ever discovered was someone reading the two lists side by side.
		const registered = registeredCommands();
		const unreachable = declaredCommands().filter(({ name }) => !registered.has(name));
		assert.deepEqual(
			unreachable,
			[],
			`these functions are marked #[tauri::command] but are not in generate_handler!, so no invoke() can reach them: ${unreachable
				.map(({ name, file }) => `${name} (${file})`)
				.join(', ')}`,
		);
	});

	test('generate_handler! names nothing that does not exist', () => {
		// The other direction fails at compile time rather than silently, so this
		// is a cheaper assertion than the one above — but it also catches a
		// registration left behind after its function was renamed, which reads as a
		// working command right up until the build.
		const declared = new Set(declaredCommands().map(({ name }) => name));
		const orphaned = [...registeredCommands()].filter((name) => !declared.has(name));
		assert.deepEqual(orphaned, [], `registered but not declared as a command: ${orphaned.join(', ')}`);
	});
});

// Tauri runs a sync `#[tauri::command]` on the main thread, so its work freezes
// every window until it returns. These do enough of it to be seen.
describe('heavy commands run off the main thread', () => {
	const rust = readRustBackend();

	for (const name of ['clipboard_read_image', 'save_window_state']) {
		test(`${name} runs off the main thread`, () => {
			assert.match(rust, new RegExp(`#\\[tauri::command\\]\\n(?:pub )?async fn ${name}\\(`));
		});
	}
});

// A fixed behavior must have exactly one implementation.
//
// The bug class this catches: a behavior gets fixed in file A while a stale
// pre-fix copy of the same logic survives in file B. Nothing type-checks the
// copy, nothing imports it, and it looks like a reusable shared helper — so the
// next person to "reuse" or "sync" it silently reverts a merged fix.
//
// The existing behavior tests cannot see this. preview.test.ts
// and export.test.ts read hard-coded files, so a second copy living anywhere else is
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

describe('single implementations', () => {
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
			// export.test.ts.
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
			name: 'a fold height is measured from layout, not from the scrollable extent',
			why:
				'KaTeX stacks a display formula with negative margins and vertical-align, so its glyphs reach past the box that lays them out and `scrollHeight` reports several pixels more than `height: auto` resolves to. Writing that number into `--fold-content-height` made the wrapper taller than its content, and `{@html}` rebuilds the wrapper without the property on every keystroke — so the section paints at `auto` and then jumps. Measured on katex-stress.md at devicePixelRatio 2: prose -0.188px, a `\\mathrm` row -0.227px, grown delimiters +5.539px, nested fractions +7.133px. `getBoundingClientRect().height` takes every one of them to +0.000px.',
			marker: /\.scrollHeight/g,
			allowed: [],
			dir: 'src/lib/utils',
		},
		{
			name: 'the markdown extension list has one implementation in src',
			why:
				'There were five copies of `md | markdown | mdown | mkd | txt` in the frontend. #611 collapsed four of them into markdownLinks.ts; the fifth was an inline array in TitleBar.svelte deciding whether the outline and full-width buttons belong on the toolbar, which is exactly the kind of copy that goes stale when an extension is added. The Rust renderer keeps its own, pinned against this one by editing.test.ts, because no import crosses that boundary.',
			// `mdown` rather than `md`: it is distinctive enough that prose and other
			// identifiers cannot match it by accident.
			//
			// The editor's language table holds no copy: it derives its Markdown
			// entries from this list (utils/editorLanguage.ts).
			marker: /['"]mdown['"]/g,
			allowed: ['src/lib/utils/markdownLinks.ts'],
		},
		{
			name: 'the list-marker grammar has one implementation in src',
			why:
				"\"What a list item's marker looks like\" had three spellings: the Rust renderer's TASK_SOURCE_RE, the preview's checkbox rewrite in documentSession.svelte.ts, and the toolbar's line-marker toggles. The first two agreed; the toolbar's copy accepted neither an indented item nor the `1)` delimiter, so a click on a nested bullet answered `-     - sub` and a click on `1) item` answered `- 1) item` — issue #451 verbatim, one delimiter over. utils/listSyntax.ts holds the vocabulary now. What each site wraps around it — the anchors, the separator, and whether the leading indentation is consumed or preserved — stays at the call site on purpose: the renderer throws that prefix away, the toolbar has to put it back, and sharing *that* would flatten every nested list item on the first click. The Rust copy is pinned against this one by documents.checks.test.ts \"task toggle line endings\", because no import crosses that boundary.",
			// The two fragments distinctive enough that prose cannot match them: the
			// task box's character class and the ordered delimiter pair.
			marker: /\[ xX\]|\\d\+\[\.\)\]/g,
			allowed: ['src/lib/utils/listSyntax.ts'],
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
			// past the `DOMPurify.sanitize(` call-site scan in preview.checks.test.ts.
			// Both scans read the same allowlist so a new sanitizer is one decision.
			marker: /from\s+["']dompurify["']/g,
			allowed: SANITIZER_FILES,
		},
		{
			name: 'the raw render_markdown command has one set of call sites',
			why: 'Every preview render must go through renderMarkdownPreview, which strips YAML front matter before invoking the Rust renderer; a raw invoke elsewhere renders the front matter as body text. The command name is a string, so the compiler cannot see the call at all.',
			// The viewer half — that its one occurrence sits inside
			// renderMarkdownPreview rather than merely in the same file — is pinned by
			// preview.checks.test.ts.
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
			// Pins the Monaco language id the table falls back to, not the
			// `editorLanguageFor` helper that happens to hold it today: 'plaintext' is a
			// magic string Monaco defines and TypeScript cannot check, and any second
			// extension table has to name it too.
			marker: /return '(?:plaintext)'/g,
			allowed: ['src/lib/utils/editorLanguage.ts'],
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
			name: 'a resize separator advertises its settings range',
			why: 'aria-valuemin/max is the bound assistive tech reports; a literal there goes stale silently because no visual check can see it. This is the half of the TOC rule above that a differently-named copy would escape.',
			marker: /aria-valuemin=/g,
			// Sidebar.svelte's separators advertise TAB_COLUMN_WIDTH_RANGE and SIDEBAR_SPLIT_RANGE, their own settings' ranges (#884).
			allowed: ['src/lib/MarkdownViewer.svelte', 'src/lib/components/Sidebar.svelte'],
			requires: {
				pattern: /aria-valuemin=\{([A-Z_]+_RANGE)\.min\}\s*\n\s*aria-valuemax=\{\1\.max\}/,
				message: 'the resize separator must advertise its setting\'s *_RANGE.min/.max, not numbers of its own',
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
			name: 'localStorage is written through one function',
			why: "Every window is a separate webview over one shared localStorage, so a persisted value needs compare-and-set on write and a `storage` listener to fold in what the other windows did — `writeStoredSetting` and `installPersistedSettings` in settings.svelte.ts are both. Three values were written with a bare `setItem` outside that: `theme` (changed in one window's settings panel, ignored by every other window until restart, while every switch beside it in the same panel synced live), `zoomLevel` (read back with a bare `parseInt`, so a corrupt key rendered `zoom: NaN` and `Math.min(NaN + 10, 500)` left the wheel and the chords unable to recover it), and `preview.fullWidth`. A bare `setItem` IS the defect: it is the write that no listener answers and no range validates.",
			// The call, so the `typeof localStorage.setItem === 'function'` guards do
			// not match. `utils/recentFiles.ts` is deliberately absent rather than
			// allowed: it keeps its own read-modify-write and its own `storage`
			// listener — correct, because the recent list is a collection every window
			// appends to rather than a scalar preference — but its write already goes
			// through `writeStoredSetting`, so it does not match this marker at all.
			marker: /localStorage\.setItem\s*\(/g,
			allowed: ['src/lib/stores/settings.svelte.ts'],
		},
		{
			name: 'the app writes an image embed in one place',
			why: "Pasting a screenshot and dropping a file are two commands (`save_image`, `copy_file_to_img`) returning the same kind of relative path, and Editor.svelte built the link for each with its own inline copy of the same four expressions, 300 lines apart. Both copies escaped the space and nothing else, so a file named `note#1.png` was written as `![alt](img/note#1.png)` and read back — by the preview and by the export resolver — as `img/note`. A third caller copying either one reintroduces it. `imageEmbed` in src/lib/utils/imageEmbed.ts is the single writer; scripts/editor.test.ts runs the round trip through the real readers.",
			// The emitted Markdown itself: a magic string handed to another parser,
			// which is what makes it a legal marker.
			marker: /!\[alt\]\(/g,
			allowed: ['src/lib/utils/imageEmbed.ts'],
		},
		{
			name: 'the frontend asks the browser what platform this is in one place',
			why: "The app had two independent answers to \"what platform is this?\". Everything read `settings.osType`, filled in by the Rust `get_os_type` command; TitleBar.svelte read `navigator.userAgent.includes('Macintosh')` and decided for itself. Two sources can disagree, and at startup they did — `settings.osType` is `'unknown'` until an `await invoke(…)` in the SettingsStore constructor returns, so on a Mac the title bar already drew Mac chrome while the tab tooltips beside it printed the Ctrl chords. `platformOf` in utils/platform.ts is the single answer: `settings.osType` when it is resolved, the synchronous browser hint only in the window before that, which is what keeps the title bar from flashing Windows chrome on a Mac.",
			// Both spellings, because they are interchangeable for this question and a
			// second source would reach for either. `navigator.language` (settings
			// store) and `navigator.clipboard` (Editor.svelte) are deliberately not
			// matched: neither is a platform test.
			marker: /navigator\.(?:userAgent|platform)\b/g,
			allowed: ['src/lib/utils/platform.ts'],
		},
		{
			name: 'the Cmd-or-Ctrl decision has one implementation',
			why: "`modifierFor()` was exported by #629 so that `settings.osType === 'macos' ? 'Cmd' : 'Ctrl'` would be written once, and four sites never joined it: two in MarkdownViewer.svelte (the document context menu's chords and the editor toolbar's `modifier` prop), one in TitleBar.svelte, and Settings.svelte's `? 'macos' : 'windows'` feeding the shortcut panel. A hand-written copy is not merely redundant — it is a site that cannot pick up what the helper learns. TitleBar's copy branched on the user agent rather than on the os type at all, and Settings' copy answered `'windows'` for a Mac whose os type had not resolved yet, so the shortcut panel opened on the Ctrl chords.",
			// The shape of the defect rather than the helpers' names: a site that
			// copies this decision is by construction one that calls neither
			// `modifierFor` nor `platformOf`, and what it contains instead is a
			// `=== 'macos'` test used as a ternary condition — which covers the
			// `'Cmd' : 'Ctrl'` spelling and the `'macos' : 'windows'` one together.
			// A bare `=== 'macos'` guarding an `{#if}` or an `&&` is NOT matched and
			// must not be: asking whether this is a Mac is fine, deciding again what
			// follows from it is the duplicate.
			//
			// The second alternative catches the same decision made off a local that
			// already holds the verdict — TitleBar's copy was `isMac ? 'Cmd' : 'Ctrl'`
			// and reaches the `=== 'macos'` test through no literal at all. The
			// declared union `'Ctrl' | 'Cmd'` in editorToolbar.ts is a type, has the
			// two words in the other order and separated by a pipe, and is not matched.
			marker: /===\s*(['"])macos\1\s*\?|(['"])Cmd\2\s*:\s*(['"])Ctrl\3/g,
			allowed: ['src/lib/utils/shortcuts.ts', 'src/lib/utils/platform.ts'],
		},
		{
			name: 'the translation dictionary is one literal',
			why:
				"`translations` was a 6,700-line literal *plus* a second table, `interactiveLabelTranslations`, that a module-level loop merged in with Object.assign — so the object the app read was never the object the source declares. That gap is not cosmetic. 259 keys existed only after the merge, and four were declared twice with different values, where whichever table happened to run last silently won: zh-TW `settings.toolbarOnBar` ('列' lost to '工具列'), and ko `settings.toolbarPlacement`, `settings.toolbarOnBar` and `settings.resetToolbar` (all three lost their original wording). Two rows of source claiming the same key, one of them dead, is invisible in review across 26 locales — and a reader who greps the literal for the losing value finds it, believes it, and is wrong. #196 appended the table rather than editing 26 places in the literal; folding it back made a duplicate key a *duplicate key*, which the reader and the compiler can both see. Add new keys to `translations` itself.",
			// `Object.assign(` unqualified rather than a pattern naming the
			// dictionary, because the merge reached it through a local alias —
			// `const currentSection = translations[language][section]` and then
			// `Object.assign(currentSection, values)`. A marker spelling
			// `translations` cannot see that, which is exactly how the mutation
			// would come back. `src` held no other Object.assign when this rule was
			// written, so the blanket ban costs nothing; a genuine unrelated use
			// joins `allowed` with its reason, like any other row here.
			//
			// The second alternative catches the direct `translations[l][s] = …`
			// spelling — the same loop's else-branch, which is how 20 locales got a
			// `toc` section they did not previously have.
			marker: /Object\.assign\(|\btranslations\b(?:\s*\[[^\]]*\])+\s*=(?!=)/g,
			allowed: [],
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
			why: "The other half of the same story. A private directory walk misses the `\\\\`→`/` normalization `walkSourceFiles` does, so on Windows every path it reports is spelled with backslashes and every allowlist compared against it is a list of strings that cannot match. settings.checks.test.ts carried exactly that copy and needed the identical hand-patch in #452; editor.checks.test.ts carried a second one that happened to be spelled with a template literal and so escaped by luck rather than by design. Use `walkSourceFiles(dir)` for the paths or `readSourceFiles(dir)` for paths plus text, both from './sourceTree.js'.",
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
});
