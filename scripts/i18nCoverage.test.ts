import assert from 'node:assert/strict';
import test from 'node:test';

import { parse } from 'svelte/compiler';

import {
	getSupportedLanguages,
	t,
	translations,
	type LanguageCode,
	type Translation,
} from '../src/lib/utils/i18n.js';
import { readSource, walkSourceFiles } from './sourceTree.js';

// WHAT THIS FILE COVERS, AND WHY IT EXISTS
//
// `t(key: string)` takes a free-form string. Nothing — not tsc, not
// `svelte-check`, not the rest of this suite — notices when that string names a
// key no dictionary has, or when a translator files a key one level away from
// where the code reads it. Both failure modes are silent: `t()` returns the key
// itself, or falls back to English, and the app ships looking fine to whoever
// wrote the code in English.
//
// Two real bugs motivated this file:
//   * TitleBar's window-tag editor called `t('common.save')`. No language
//     defines `common.save`, so the button read literally "common.save" —
//     in English too.
//   * 21 languages filed the tag colours under `settings.colors.*` while
//     Settings.svelte reads `colors.*`. ~190 finished translations sat in the
//     file and never reached a user.
//
// So: (1) every key the source asks for must exist in English, and (2) no
// language may define a key English does not have. (2) is what catches
// misfiled translations, because a misfiled key is by construction one English
// never had.
//
// Per-locale completeness is REPORTED, never asserted. 19 locales are missing
// >100 keys each; failing on that would mean nobody could add an English key
// without translating it 25 times first.

const SOURCE_ROOT = 'src';
const DICTIONARY = 'src/lib/utils/i18n.ts';

const languages = getSupportedLanguages().map((l) => l.code) as LanguageCode[];

// ---------------------------------------------------------------- dictionary

function flatten(node: Translation, prefix = ''): Map<string, string> {
	const out = new Map<string, string>();
	for (const [key, value] of Object.entries(node)) {
		const path = prefix ? `${prefix}.${key}` : key;
		if (typeof value === 'string') out.set(path, value);
		else for (const [k, v] of flatten(value, path)) out.set(k, v);
	}
	return out;
}

const dictionaries = new Map<LanguageCode, Map<string, string>>(
	languages.map((lang) => [lang, flatten(translations[lang])]),
);
const english = dictionaries.get('en')!;

// ------------------------------------------------------------------- source

// Prose in a doc comment can mention `t('foo')`. Drop whole comment lines
// rather than trying to parse comments out of the middle of code — this only
// ever removes candidates, and no real call site starts a line with `*` or `//`.
function stripCommentLines(source: string): string {
	return source
		.split('\n')
		.map((line) => {
			const trimmed = line.trimStart();
			const isComment =
				trimmed.startsWith('*') ||
				trimmed.startsWith('//') ||
				trimmed.startsWith('/*') ||
				trimmed.startsWith('<!--');
			return isComment ? '' : line;
		})
		.join('\n');
}

/** Index just past the template literal that starts at `i`. */
function endOfTemplate(src: string, i: number): number {
	i++;
	while (i < src.length) {
		if (src[i] === '\\') i += 2;
		else if (src[i] === '`') return i + 1;
		else if (src[i] === '$' && src[i + 1] === '{') i = endOfInterpolation(src, i + 2);
		else i++;
	}
	return i;
}

/** Index just past the `${ … }` whose body starts at `i`. */
function endOfInterpolation(src: string, i: number): number {
	let depth = 1;
	while (i < src.length && depth > 0) {
		const c = src[i];
		if (c === '{') depth++;
		else if (c === '}') depth--;
		else if (c === '`') { i = endOfTemplate(src, i); continue; }
		else if (c === "'" || c === '"') { i = endOfString(src, i); continue; }
		i++;
	}
	return i;
}

/** Index just past the quoted string that starts at `i`. */
function endOfString(src: string, i: number): number {
	const quote = src[i++];
	while (i < src.length && src[i] !== quote) i += src[i] === '\\' ? 2 : 1;
	return i + 1;
}

/** The text of the first argument of the call whose `(` sits at `open`. */
function firstArgument(src: string, open: number): string {
	const start = open + 1;
	let i = start;
	let depth = 0;
	while (i < src.length) {
		const c = src[i];
		if (c === "'" || c === '"') { i = endOfString(src, i); continue; }
		if (c === '`') { i = endOfTemplate(src, i); continue; }
		if (c === '(' || c === '[' || c === '{') { depth++; i++; continue; }
		if (c === ')' && depth === 0) return src.slice(start, i);
		if (c === ')' || c === ']' || c === '}') { depth--; i++; continue; }
		if (c === ',' && depth === 0) return src.slice(start, i);
		i++;
	}
	return src.slice(start);
}

type Reference = { key: string; file: string };

const staticKeys: Reference[] = [];
/** `t(`colors.${…}`)` → prefix `colors.`, which no scanner can resolve alone. */
const dynamicPrefixes = new Map<string, Set<string>>();
/** `t(someVariable, lang)` — the key is computed elsewhere. */
const indirectCalls = new Set<string>();
/** The first argument of every `addToast(…)` call, whitespace-normalised. */
const toastMessages: { arg: string; file: string }[] = [];

for (const file of walkSourceFiles(SOURCE_ROOT)) {
	if (file === DICTIONARY) continue;
	const src = stripCommentLines(readSource(file));

	// `t(` but not `format(`, `.at(`, `assert(` …
	for (const match of src.matchAll(/(?<![\w$.])t\(/g)) {
		const arg = firstArgument(src, match.index + 1).trim();
		if (arg === '') continue; // `t()` does not type-check; nothing to resolve.
		let i = 0;
		let resolved = false;
		while (i < arg.length) {
			const c = arg[i];
			if (c === "'" || c === '"') {
				const end = endOfString(arg, i);
				staticKeys.push({ key: arg.slice(i + 1, end - 1), file });
				resolved = true;
				i = end;
				continue;
			}
			if (c === '`') {
				const end = endOfTemplate(arg, i);
				const literal = arg.slice(i + 1, end - 1);
				const hole = literal.indexOf('${');
				if (hole === -1) staticKeys.push({ key: literal, file });
				else {
					const prefix = literal.slice(0, hole);
					dynamicPrefixes.set(prefix, (dynamicPrefixes.get(prefix) ?? new Set()).add(file));
				}
				resolved = true;
				i = end;
				continue;
			}
			i++;
		}
		if (!resolved) indirectCalls.add(`${file}: t(${arg.replace(/\s+/g, ' ')})`);
	}

	// Toolbar/menu descriptors carry their key as data and are handed to `t()`
	// through `t(action.labelKey)`. Same exposure, different spelling.
	for (const match of src.matchAll(/\blabelKey: '([^']+)'/g)) {
		staticKeys.push({ key: match[1], file });
	}

	// Toast text is the one user-facing string nothing above can see. Every rule
	// in this file is about a key that WAS asked for; a hardcoded English
	// literal handed straight to `addToast()` never asks for one, so it passes
	// every check and then shows English to all 26 locales. (`function addToast`
	// is the declaration, not a call.)
	for (const match of src.matchAll(/(?<!function\s)(?<![\w$.])addToast\(/g)) {
		const arg = firstArgument(src, match.index + 'addToast'.length)
			.trim()
			.replace(/\s+/g, ' ');
		toastMessages.push({ arg, file });
	}
}

// ------------------------------------------------ declared dynamic families
//
// A template-literal key cannot be resolved by reading the call site, so each
// family is declared here together with the source of truth that enumerates its
// members at runtime. The members are re-derived from that source on every run,
// so adding a swatch colour or an update-dialog string is checked like any
// other key — this is not an exemption list.

const DYNAMIC_FAMILIES: Record<string, { file: string; member: RegExp; why: string }> = {
	'colors.': {
		file: 'src/lib/components/Settings.svelte',
		// Settings renders one swatch per `highlightColors` entry and labels it
		// with t(`colors.${color.value}`).
		member: /\{ value: '([a-z]+)', color: /g,
		why: 'the highlight-colour swatch list',
	},
	'update.': {
		file: 'src/lib/components/UpdateDialog.svelte',
		// Every string in the dialog goes through `tk(key)`, i.e. t(`update.${key}`).
		member: /\btk\('([A-Za-z0-9]+)'/g,
		why: 'the update dialog’s tk() call sites',
	},
};

// ------------------------------------------------------- known-orphan pins
//
// Three leaves exist in 22 locales and never existed in English. Unlike the
// colour block they are not misfiled: nothing in the source reads them under
// any path, so they are dead weight rather than lost translations. Deleting
// dead keys is deliberately out of scope for the change that introduced this
// test, so they are pinned here instead of being swept under a wildcard.
//
// Pinning them is safe because the two rules interlock: should anyone ever
// point source code at one of these keys, "every referenced key exists in
// English" fails immediately. An orphan can be tolerated OR reachable, never
// both.
const KNOWN_ORPHANS = new Set(['editor.status.lines', 'tooltip.zoomIn', 'tooltip.zoomOut']);

// `t(action.labelKey, …)`: resolved by the `labelKey:` harvest above. Any new
// unexplained indirection has to be added here consciously.
//
// The two shortcut-panel entries are the same shape: the panel renders
// `t(section.labelKey)` and `t(entry.labelKey)` over `src/lib/utils/shortcuts.ts`,
// whose rows spell their key as `labelKey: '…'` — so the harvest above already
// collects every one of them and checks it exists in English like any other key.
// `scripts/shortcutRegistry.test.ts` additionally measures their per-locale
// coverage, which this file only reports.
// ------------------------------------------------- toasts that carry no t()
//
// One shape, reached from two call sites (`documentSession`'s and
// `windowSession`'s `onError`). It is a pass-through, not a message: the words
// are chosen by the caller in `src/lib/sessions/`, and those callers already
// pass `t('toast.lossySaveBlocked', …)` and `t('toast.partialSaveBlocked', …)`
// through it. The remaining raw strings ("Failed to release tab transfer
// claim") are developer detail printed next to `String(error)` for a bug
// report; translating them here is impossible anyway, because the scanner
// cannot see which caller it is looking at. Fix them where they are written.
const UNTRANSLATED_TOASTS = new Map<string, string>([
	['`${message}: ${String(error)}`', 'the two onError pass-throughs (see src/lib/sessions/)'],
]);

const KNOWN_INDIRECT_CALLS = new Set([
	'src/lib/components/Settings.svelte: t(action.labelKey)',
	'src/lib/components/Settings.svelte: t(entry.labelKey)',
	'src/lib/components/Settings.svelte: t(section.labelKey)',
	'src/lib/components/Tab.svelte: t(action.labelKey)',
]);

// ------------------------------------------------------------------- tests

test('the scanner actually found the call sites', () => {
	// Guards against the whole file silently passing because a regex stopped
	// matching. Every assertion below is vacuous if this one is wrong.
	assert.ok(staticKeys.length > 250, `found ${staticKeys.length} literal t() keys`);
	assert.ok(english.size > 300, `English defines ${english.size} keys`);
	assert.equal(languages.length, 26);
});

test('t() requires a language, so a call site cannot forget one', () => {
	// `lang: LanguageCode = 'en'` made the language optional at ~322 call sites,
	// and 9 of them omitted it — including the window-control aria-labels a
	// screen reader reads out, which said "Close" in all 26 languages. tsc is
	// the real guard now; this asserts the source form so nobody types the
	// default back in and re-opens the hole.
	const signature = /export function t\((.*?)\): string/.exec(readSource('src/lib/utils/i18n.ts'));
	assert.ok(signature, 'the exported t() signature moved; this test can no longer see it');
	assert.equal(
		signature[1],
		'key: string, lang: LanguageCode',
		't() must take the language as a required parameter, with no default',
	);
});

test('every key the source asks for exists in English', () => {
	// TitleBar called t('common.save'); en.common has close/minimize/maximize/
	// loadingFullDocument and no save, so the button rendered "common.save".
	const missing = new Map<string, Set<string>>();
	for (const { key, file } of staticKeys) {
		if (english.has(key)) continue;
		missing.set(key, (missing.get(key) ?? new Set()).add(file));
	}
	const report = [...missing]
		.map(([key, files]) => `  ${key}  <- ${[...files].join(', ')}`)
		.join('\n');
	assert.equal(
		missing.size,
		0,
		`t() references ${missing.size} key(s) English does not define; the UI shows the raw key:\n${report}`,
	);
});

test('no language defines a key English does not have', () => {
	// A translation filed one level away from where the code reads it is
	// invisible: `settings.colors.blue` can never be reached by t('colors.blue').
	// Since every reachable key must exist in English, "exists somewhere but not
	// in English" is exactly the set of unreachable translations.
	const orphans = new Map<string, string[]>();
	for (const lang of languages) {
		if (lang === 'en') continue;
		for (const key of dictionaries.get(lang)!.keys()) {
			if (english.has(key)) continue;
			orphans.set(key, [...(orphans.get(key) ?? []), lang]);
		}
	}

	const unexpected = [...orphans].filter(([key]) => !KNOWN_ORPHANS.has(key));
	assert.equal(
		unexpected.length,
		0,
		`translations that no code path can reach (present in a locale, absent in English):\n${unexpected
			.map(([key, langs]) => `  ${key}  [${langs.length}] ${langs.join(', ')}`)
			.join('\n')}`,
	);

	// The pin must not rot: a key that got cleaned up has to leave this list.
	for (const key of KNOWN_ORPHANS) {
		assert.ok(orphans.has(key), `${key} is no longer an orphan — drop it from KNOWN_ORPHANS`);
	}
});

test('pinned orphans are unreachable, so pinning them hides nothing', () => {
	for (const { key, file } of staticKeys) {
		assert.ok(!KNOWN_ORPHANS.has(key), `${file} reads pinned orphan ${key}`);
	}
	for (const prefix of dynamicPrefixes.keys()) {
		for (const key of KNOWN_ORPHANS) {
			assert.ok(!key.startsWith(prefix), `dynamic family ${prefix}* can reach pinned orphan ${key}`);
		}
	}
});

test('every template-literal key family is declared and resolvable', () => {
	assert.deepEqual(
		[...dynamicPrefixes.keys()].sort(),
		Object.keys(DYNAMIC_FAMILIES).sort(),
		'a t(`prefix.${…}`) call site is undeclared (or a declared one disappeared); ' +
			'declare it in DYNAMIC_FAMILIES together with whatever enumerates its members',
	);

	for (const [prefix, { file, member, why }] of Object.entries(DYNAMIC_FAMILIES)) {
		const source = readSource(file);
		// A member may legitimately appear at several call sites (`tk('close')`),
		// so this is a set, not a list.
		const members = new Set([...source.matchAll(member)].map((m) => m[1]));
		assert.ok(members.size > 0, `${why} in ${file} no longer matches its pattern`);

		for (const name of members) {
			assert.ok(
				english.has(`${prefix}${name}`),
				`${prefix}${name} is rendered from ${why} but English does not define it`,
			);
		}
	}
});

test('t() never echoes a key back for a reachable string', () => {
	// The end-to-end statement of both bugs, expressed through t() itself
	// rather than through the tables.
	const reachable = new Set(staticKeys.map((r) => r.key));
	for (const [prefix, { file, member }] of Object.entries(DYNAMIC_FAMILIES)) {
		const source = readSource(file);
		for (const m of source.matchAll(member)) reachable.add(`${prefix}${m[1]}`);
	}
	for (const key of reachable) {
		for (const lang of languages) {
			const value = t(key, lang);
			assert.notEqual(value, key, `t('${key}', '${lang}') renders the key itself`);
			assert.ok(value.length > 0, `t('${key}', '${lang}') is empty`);
		}
	}
});

test('the tag-colour names reach the UI in every language', () => {
	// The regression pin for the misfiled block: English fallback would keep the
	// previous test green, so require each locale to own the block outright.
	const colourNames = Object.keys(translations.en.colors as Translation);
	assert.ok(colourNames.length >= 9, 'English still defines the colour block');

	for (const lang of languages) {
		const own = dictionaries.get(lang)!;
		for (const name of colourNames) {
			assert.ok(own.has(`colors.${name}`), `${lang} defines colors.${name} at the top level`);
			assert.ok(!own.has(`settings.colors.${name}`), `${lang} no longer hides it under settings.*`);
		}
	}
});

test('the window-tag editor’s Save button is translated', () => {
	// The button that shipped reading "common.save".
	const titleBar = readSource('src/lib/components/TitleBar.svelte');
	const match = titleBar.match(/onclick=\{applyTag\}>\{t\('([^']+)', currentLanguage\)\}/);
	assert.ok(match, 'the tag editor still labels its confirm button through t()');
	assert.ok(english.has(match[1]), `${match[1]} is defined in English`);
	for (const lang of languages) {
		assert.notEqual(t(match[1], lang), match[1], `the Save button is translated in ${lang}`);
	}
});

// The two tests below moved here from `toolbarCustomizationWiring.test.ts`,
// which was deleted for asserting the spelling of `Settings.svelte` rather than
// any behaviour. These two were the exception: they import the dictionary and
// look keys up in it, and they are the only thing in the suite that fails when
// a *specific locale* silently falls back to English. The general rules above
// cannot see that — (1) only requires the key in English, and per-locale
// completeness is reported rather than enforced. These keys are the exception
// to that leniency because they label controls whose meaning is carried by the
// word alone: an untranslated "Move Up" on an icon button is unusable, not
// merely unpolished.

/** The value `lang` itself defines for `key`, ignoring the English fallback. */
function directTranslation(lang: LanguageCode, key: string): string | undefined {
	return dictionaries.get(lang)!.get(key);
}

test('interactive button labels are directly translated for every supported language', () => {
	const interactiveLabelKeys = [
		'common.close',
		'common.decrease',
		'common.increase',
		'toc.resizeTableOfContents',
		'settings.move',
		'settings.moveUp',
		'settings.moveDown',
		'settings.resetToolbar',
		'settings.toolbarOnBar',
		'settings.toolbarInMenu',
		'settings.resizeWindow',
	];

	const missing = languages.flatMap((lang) =>
		interactiveLabelKeys
			.filter((key) => directTranslation(lang, key) === undefined)
			.map((key) => `${lang}:${key}`),
	);

	assert.deepEqual(missing, []);
});

test('Simplified Chinese directly translates the window organization labels', () => {
	const keys = [
		'menu.moveToWindow', 'menu.window', 'menu.mergeAllWindows', 'menu.setWindowTag',
		'menu.windowTagPlaceholder', 'menu.windowTagClear', 'menu.pinWindowTag',
		'menu.unpinWindowTag', 'toast.noOtherWindows', 'home.pinnedTags', 'home.pinnedFileCount',
	];

	assert.deepEqual(keys.filter((key) => directTranslation('zh-CN', key) === undefined), []);
});

test('every t() call resolves to a literal, a declared family, or a known indirection', () => {
	assert.deepEqual(
		[...indirectCalls].sort(),
		[...KNOWN_INDIRECT_CALLS].sort(),
		'a t() call takes a key this scanner cannot see; either give it a literal ' +
			'or add it here after making sure the key is checked some other way',
	);
});

test('every toast message goes through t()', () => {
	// The gap this closes: `addToast('Reloaded from disk', 'info')` satisfies
	// every rule above by asking for nothing. Eleven of these shipped in
	// MarkdownViewer.svelte, two of them inside `exportAsHtml`, whose next
	// statement already read `t('modal.openExportedFileTitle', …)`.
	//
	// The rule is stated over the whole argument rather than over "is it a
	// string literal", because `` `Failed to open ${path}` `` is the same defect
	// spelled as a template. Anything that is not visibly built from t() has to
	// be justified below.
	assert.ok(toastMessages.length > 25, `found ${toastMessages.length} addToast() call sites`);

	const untranslated = toastMessages.filter(({ arg }) => !/(?<![\w$.])t\(/.test(arg));
	const unexpected = untranslated.filter(({ arg }) => !UNTRANSLATED_TOASTS.has(arg));
	assert.deepEqual(
		unexpected.map(({ arg, file }) => `${file}: addToast(${arg})`),
		[],
		'a toast shows text that never went through t(); it will read English in all 26 languages',
	);

	// The pin must not rot: a shape that got translated has to leave the list.
	for (const [arg] of UNTRANSLATED_TOASTS) {
		assert.ok(
			untranslated.some((toast) => toast.arg === arg),
			`addToast(${arg}) no longer exists — drop it from UNTRANSLATED_TOASTS`,
		);
	}
});

// ------------------------------------------- one label per control, per pane
//
// The preview pane shipped four controls under two labels. `preview-font` and
// `code-font` both read `t('settings.font')`, `preview-font-size` and
// `code-font-size` both read `t('settings.fontSize')`, so the pane rendered
//
//     Font       [ Helvetica Neue (Default) ]
//     Font Size  [− 16 +]
//     Font       [ Menlo (Default) ]
//     Font Size  [− 14 +]
//
// and nothing on screen said which pair was the prose font and which the code
// font. The `id` attributes knew; the user could not.
//
// Nothing in the suite could see it. Every rule above is about a key existing
// and resolving — two controls pointed at the SAME existing, correctly
// resolving key satisfies all of them. So this reads the controls out of the
// component and compares what a user would actually see, in each language:
// two controls in one pane may not render the same words. Spelling the check
// against `t()` output rather than against the key names is the point — a
// future locale that translates two distinct keys to one string is the same
// defect and fails here too.

const SETTINGS = 'src/lib/components/Settings.svelte';

type LabelledControl = { pane: string; id: string; key: string };

/**
 * Every `<label for="…">{t('…')}</label>` in Settings.svelte, tagged with the
 * `{#if activeCategory === '…'}` branch it renders in.
 *
 * Read from the parsed component rather than by matching text: the panes are a
 * `{:else if}` chain, so "which pane is this row in" is a question about tree
 * position that no regex over the file can answer.
 */
function labelledControls(): LabelledControl[] {
	const source = readSource(SETTINGS);
	const ast = parse(source, { modern: true, filename: SETTINGS }) as Record<string, any>;
	const found: LabelledControl[] = [];

	const visit = (node: unknown, pane: string | null): void => {
		if (Array.isArray(node)) {
			for (const child of node) visit(child, pane);
			return;
		}
		if (!node || typeof node !== 'object') return;
		const current = node as Record<string, any>;

		if (current.type === 'IfBlock' && current.test) {
			const category = source
				.slice(current.test.start, current.test.end)
				.match(/activeCategory === '([a-z]+)'/);
			if (category) {
				// The consequent is that pane; the `{:else if}` chain in the
				// alternate names its own.
				visit(current.consequent, category[1]);
				visit(current.alternate, pane);
				return;
			}
		}

		if (current.type === 'RegularElement' && current.name === 'label') {
			const forAttribute = (current.attributes ?? []).find(
				(attribute: Record<string, any>) => attribute.type === 'Attribute' && attribute.name === 'for',
			);
			const id = forAttribute?.value?.[0]?.type === 'Text' ? String(forAttribute.value[0].data) : null;
			for (const child of current.fragment?.nodes ?? []) {
				const call = child.type === 'ExpressionTag' ? child.expression : null;
				if (call?.type !== 'CallExpression' || call.callee?.name !== 't') continue;
				const key = call.arguments?.[0];
				if (key?.type !== 'Literal' || typeof key.value !== 'string') continue;
				assert.ok(id, `a t() label in ${SETTINGS} has no "for" attribute to name its control`);
				assert.ok(pane, `${id} is labelled outside any activeCategory branch`);
				found.push({ pane: pane!, id: id!, key: key.value });
			}
		}

		for (const [name, value] of Object.entries(current)) {
			if (name === 'parent' || name === 'metadata') continue;
			visit(value, pane);
		}
	};

	visit(ast.fragment, null);
	return found;
}

const settingsControls = labelledControls();

test('the settings panes were actually read', () => {
	// Every assertion below is vacuous if the walk found nothing, and the one
	// that matters is vacuous if it stopped finding the preview pane.
	const panes = new Set(settingsControls.map((control) => control.pane));
	assert.deepEqual([...panes].sort(), ['appearance', 'editor', 'files', 'preview']);
	assert.ok(settingsControls.length > 25, `found ${settingsControls.length} labelled controls`);

	const preview = settingsControls.filter((control) => control.pane === 'preview').map((c) => c.id);
	assert.deepEqual(preview.sort(), [
		'code-font',
		'code-font-size',
		'preview-font',
		'preview-font-size',
		'preview-max-width',
	]);
});

test('no two controls in one settings pane carry the same label, in any language', () => {
	const collisions: string[] = [];

	for (const pane of new Set(settingsControls.map((control) => control.pane))) {
		const controls = settingsControls.filter((control) => control.pane === pane);
		for (const lang of languages) {
			const seen = new Map<string, string>();
			for (const { id, key } of controls) {
				const label = t(key, lang);
				const owner = seen.get(label);
				if (owner) collisions.push(`${lang} ${pane}: ${owner} and ${id} both read "${label}"`);
				else seen.set(label, id);
			}
		}
	}

	assert.deepEqual(collisions, []);
});

test('per-locale completeness (reported, never enforced)', () => {
	// A worklist for translators, not a gate. Adding an English key must not
	// turn 25 locales red.
	const rows = languages
		.filter((lang) => lang !== 'en')
		.map((lang) => {
			const own = dictionaries.get(lang)!;
			const missing = [...english.keys()].filter((key) => !own.has(key));
			return { lang, missing: missing.length };
		})
		.sort((a, b) => b.missing - a.missing);

	const total = rows.reduce((sum, row) => sum + row.missing, 0);
	console.log(`\n  i18n coverage — ${english.size} English keys, 25 other locales`);
	for (const { lang, missing } of rows) {
		const pct = (((english.size - missing) / english.size) * 100).toFixed(1);
		console.log(`    ${lang.padEnd(6)} ${String(english.size - missing).padStart(3)}/${english.size}  ${pct.padStart(5)}%  ${missing} missing`);
	}
	console.log(`    ${'total'.padEnd(6)} ${total} untranslated key-slots (falling back to English)\n`);

	// No assertion, deliberately. `total` is a sum of array lengths, so the
	// `assert.ok(total >= 0)` that used to close this block was true for every
	// possible dictionary — it read as a gate while enforcing nothing. The gates
	// are the two tests above: every key the source asks for exists in English,
	// and no language defines a key English does not have. Completeness per
	// locale stays a worklist.
});
