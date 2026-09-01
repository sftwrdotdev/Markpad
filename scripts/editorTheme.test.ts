import assert from 'node:assert/strict';
import test from 'node:test';

import { markdownTokenRules, monacoThemeName, semanticTokenRules } from '../src/lib/utils/editorTheme.js';
import { filesMatching, readSource, readSourceFiles } from './sourceTree.js';

// The editor's Markdown colours. Two things can make a rule here do nothing at
// all, and neither is visible to the compiler: a token name no grammar emits
// (#676's defect, one layer over), and a colour that has drifted from the one
// the rest of the app resolves through `--color-*`.

const grammar = readSource('node_modules/monaco-editor/esm/vs/basic-languages/markdown/markdown.js');
const styles = readSource('src/styles.css');

/** Every token name this Monaco build's Markdown tokenizer can emit. */
const emittedTokens = (() => {
	const tokenizer = grammar.slice(grammar.indexOf('tokenizer:'));
	return new Set([...tokenizer.matchAll(/"([a-z][\w.]*)"/g)].map((match) => match[1]));
})();

/** A `--color-*` value, read out of the block that defines the given appearance. */
function paletteColor(appearance: 'light' | 'dark', name: string): string {
	const block = appearance === 'dark'
		? styles.slice(styles.indexOf(':root[data-theme="dark"] {'))
		: styles.slice(styles.indexOf(':root {'));
	const match = block.match(new RegExp(`--color-${name}:\\s*(#[0-9a-fA-F]{6})`));
	assert.ok(match, `styles.css must define --color-${name} for ${appearance}`);
	return match[1].slice(1).toLowerCase();
}

test('every rule is scoped to Markdown', () => {
	// Monaco's Markdown grammar appends `.md` to every token it emits, and a
	// rule without that suffix sits at the root of the token trie — where it
	// repaints Python, Rust and JSON inside fenced code blocks as well. That is
	// not a hypothetical: the first version of this palette did exactly that.
	for (const rule of markdownTokenRules('light')) {
		assert.ok(rule.token.endsWith('.md'), `${rule.token} would leak into every other language`);
	}
});

test('both themes get rules, and every rule is a real token', () => {
	for (const appearance of ['light', 'dark'] as const) {
		const rules = markdownTokenRules(appearance);
		assert.ok(rules.length > 0, `${appearance} must not fall back to Monaco's source-code colours`);

		for (const rule of rules) {
			// The grammar spells its tokens without the postfix it later appends.
			const bare = rule.token.slice(0, -'.md'.length);
			const emitted = emittedTokens.has(bare);
			assert.ok(emitted, `no Markdown token is called \`${rule.token}\` — the rule would be inert`);
			// Monaco's own parser reads these as `#rrggbb` once it prepends the
			// hash; a `#` here, or a short form, resolves to no colour.
			assert.match(rule.foreground, /^[0-9a-f]{6}$/, `${rule.token} must be a bare six-digit hex`);
		}
	}
});

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

test('the markup all reads as markup, and the content inside it does not', () => {
	// The one line a reader actually scans by: is this the document, or the
	// syntax around it? Every structural marker takes the same colour, and the
	// two pieces of content that live inside markup take the text colour.
	for (const appearance of ['light', 'dark'] as const) {
		const byToken = new Map(markdownTokenRules(appearance).map((rule) => [rule.token, rule.foreground]));
		const structure = ['keyword.md', 'keyword.table.left.md', 'keyword.table.middle.md', 'keyword.table.right.md', 'comment.md', 'meta.separator.md'];
		for (const token of structure) {
			assert.equal(byToken.get(token), byToken.get('keyword.md'), `${token} must read as markup`);
		}
		for (const token of ['keyword.table.header.md', 'variable.source.md']) {
			assert.notEqual(byToken.get(token), byToken.get('keyword.md'), `${token} is content, not markup`);
		}
	}
});

test('the two inheritance overrides are present, or a table and a code block are miscoloured', () => {
	// Monaco resolves a token against a trie, so a rule on `keyword` also paints
	// `keyword.table.header`, and one on `variable` also paints
	// `variable.source`. Drop either override and every table header reads as a
	// heading, every fenced block as inline code.
	for (const appearance of ['light', 'dark'] as const) {
		const byToken = new Map(markdownTokenRules(appearance).map((rule) => [rule.token, rule.foreground]));
		assert.notEqual(byToken.get('keyword.table.header.md'), byToken.get('keyword.md'));
		assert.notEqual(byToken.get('variable.source.md'), byToken.get('variable.md'));
	}
});

test('bold and italic keep the font style the base theme gives them', () => {
	// A rule with no `fontStyle` is `FontStyle.NotSet`, which Monaco merges by
	// leaving what is already there — `vs`/`vs-dark` define `strong: bold` and
	// `emphasis: italic`. Spelling `regular` here would flatten both.
	for (const rule of markdownTokenRules('light')) {
		assert.ok(!('fontStyle' in rule), `${rule.token} must not decide a font style`);
	}
});

test('light and dark are actually different themes', () => {
	const light = markdownTokenRules('light');
	const dark = markdownTokenRules('dark');
	assert.deepEqual(light.map((rule) => rule.token), dark.map((rule) => rule.token));
	for (const [index, rule] of light.entries()) {
		assert.notEqual(rule.foreground, dark[index].foreground, `${rule.token} is the same colour on both`);
	}
});

test('a formula reads as markup around content, not as one flat run', () => {
	// Both math rules used to resolve to the same colour, which made the split
	// between the delimiters and the body invisible on screen. The `$` and every
	// control sequence inside now read as markup, like every other marker; the
	// operands keep the code colour and take the italics TeX would give them.
	for (const appearance of ['light', 'dark'] as const) {
		const byToken = new Map(semanticTokenRules(appearance).map((rule) => [rule.token, rule]));
		const marker = byToken.get('math.marker');
		const body = byToken.get('math');
		assert.equal(marker?.foreground, byToken.get('heading.marker')?.foreground, 'markup colour');
		assert.notEqual(marker?.foreground, body?.foreground, 'delimiters must not vanish into the body');
		assert.equal(body?.foreground, byToken.get('code')?.foreground, 'a formula is code-coloured');
		assert.equal(body?.fontStyle, 'italic');
	}
});

// ------------------------------------------- who tells Monaco which theme it is

// `monaco.editor.setTheme` is global to the page, not scoped to an editor, so
// the last caller in a flush decides what every editor is wearing. Two callers
// disagreed: `Editor.svelte` asked for `app-theme-*` (the rules above) and
// `MarkdownViewer.svelte` asked for Monaco's stock `vs`/`vs-dark` from a second
// effect over the same `settings.theme`. Svelte 5 runs a child's effects before
// its parent's and `Editor` is the viewer's child, so the stock name won every
// theme change and the whole palette above stopped existing until the pane was
// re-created.

test('a settings value maps to one theme name', () => {
	assert.equal(monacoThemeName('dark', false), 'app-theme-dark');
	assert.equal(monacoThemeName('light', true), 'app-theme-light');
	assert.equal(monacoThemeName('system', true), 'app-theme-dark');
	assert.equal(monacoThemeName('system', false), 'app-theme-light');
	// The OS preference is only consulted for `system`.
	assert.equal(monacoThemeName('dark', true), 'app-theme-dark');
	assert.equal(monacoThemeName('light', false), 'app-theme-light');
	// An imported theme is one Monaco theme whatever its file is called, and
	// carries its own appearance rather than the desktop's.
	assert.equal(monacoThemeName('vscode:Dracula', false), 'vscode-custom');
	assert.equal(monacoThemeName('vscode:Solarized Light', true), 'vscode-custom');
});

test('the editor pane and the theme importer are the only writers', () => {
	assert.deepEqual(filesMatching(readSourceFiles('src'), /\.editor\.setTheme\(/), [
		// The widget's owner: it defines `app-theme-*` and it is the only thing
		// on screen a Monaco theme can be seen on.
		'src/lib/components/Editor.svelte',
		// `vscode-custom` does not exist as a theme until this file has read the
		// JSON and called `defineTheme`, so the set has to happen where the
		// define does — `Editor.svelte`'s change effect abstains for `vscode:`.
		'src/lib/utils/theme.ts',
	]);
});

test('every name the seam returns is a theme somebody defines', () => {
	const defined = [
		readSource('src/lib/components/Editor.svelte'),
		readSource('src/lib/utils/theme.ts'),
	]
		.flatMap((text) => [...text.matchAll(/\.editor\.defineTheme\(\s*["']([\w-]+)["']/g)])
		.map((match) => match[1]);
	const asked = ['system', 'light', 'dark', 'vscode:whatever'].map((theme) => [
		monacoThemeName(theme, false),
		monacoThemeName(theme, true),
	]);
	for (const name of new Set(asked.flat())) {
		assert.ok(defined.includes(name), `nothing defines ${name}; Monaco would fall back to vs`);
	}
});
