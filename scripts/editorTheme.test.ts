import assert from 'node:assert/strict';
import test from 'node:test';

import { markdownTokenRules } from '../src/lib/utils/editorTheme.js';
import { readSource } from './sourceTree.js';

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

test('both themes get rules, and every rule is a real token', () => {
	for (const appearance of ['light', 'dark'] as const) {
		const rules = markdownTokenRules(appearance);
		assert.ok(rules.length > 0, `${appearance} must not fall back to Monaco's source-code colours`);

		for (const rule of rules) {
			// `keyword.table` is the prefix Monaco's trie matches every
			// `keyword.table.*` against; the grammar spells out the leaves.
			const emitted = emittedTokens.has(rule.token)
				|| [...emittedTokens].some((token) => token.startsWith(`${rule.token}.`));
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
		assert.equal(byToken.get('keyword'), paletteColor(appearance, expected.accent));
		assert.equal(byToken.get('string'), paletteColor(appearance, expected.code));
		assert.equal(byToken.get('variable'), paletteColor(appearance, expected.code));
		assert.equal(byToken.get('strong'), paletteColor(appearance, expected.emphasis));
		assert.equal(byToken.get('emphasis'), paletteColor(appearance, expected.emphasis));
		assert.equal(byToken.get('string.link'), paletteColor(appearance, expected.link));
		assert.equal(byToken.get('comment'), paletteColor(appearance, expected.muted));
		assert.equal(byToken.get('keyword.table'), paletteColor(appearance, expected.muted));
		assert.equal(byToken.get('variable.source'), paletteColor(appearance, expected.text));
		assert.equal(byToken.get('keyword.table.header'), paletteColor(appearance, expected.text));
	}
});

test('the two inheritance overrides are present, or a table and a code block are miscoloured', () => {
	// Monaco resolves a token against a trie, so a rule on `keyword` also paints
	// `keyword.table.header`, and one on `variable` also paints
	// `variable.source`. Drop either override and every table header reads as a
	// heading, every fenced block as inline code.
	for (const appearance of ['light', 'dark'] as const) {
		const byToken = new Map(markdownTokenRules(appearance).map((rule) => [rule.token, rule.foreground]));
		assert.notEqual(byToken.get('keyword.table.header'), byToken.get('keyword'));
		assert.notEqual(byToken.get('variable.source'), byToken.get('variable'));
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
