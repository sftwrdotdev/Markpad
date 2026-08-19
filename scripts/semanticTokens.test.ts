import assert from 'node:assert/strict';
import test from 'node:test';

import { TokenTheme, parseTokenTheme } from 'monaco-editor/esm/vs/editor/common/languages/supports/tokenization.js';

import { semanticTokenRules } from '../src/lib/utils/editorTheme.js';
import { importedThemeRules } from '../src/lib/utils/theme.js';
import { TOKEN_MODIFIERS, TOKEN_TYPES, encodeSemanticTokens } from '../src/lib/utils/semanticTokens.js';
import { readRustBackend, readSource } from './sourceTree.js';

// The layer that colours from the renderer's answer instead of the grammar's
// guess. Three seams, each invisible to the compiler: the kinds Rust emits
// against the legend the encoder indexes, the legend against the theme rules
// that style it, and the delta encoding Monaco decodes.

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

test('the legend and the theme agree on what can be styled', () => {
	// A rule for a type the legend lacks styles nothing; a type with no rule
	// paints whatever the grammar left, which for a construct the grammar has
	// never heard of means no colour at all.
	const styled = new Set(semanticTokenRules('light').map((rule) => rule.token.split('.')[0]));
	for (const type of TOKEN_TYPES) {
		assert.ok(styled.has(type), `no theme rule styles \`${type}\``);
	}
	for (const rule of semanticTokenRules('light')) {
		const [type, modifier] = rule.token.split('.');
		assert.ok((TOKEN_TYPES as readonly string[]).includes(type), `rule \`${rule.token}\` names no legend type`);
		if (modifier) {
			assert.ok(
				(TOKEN_MODIFIERS as readonly string[]).includes(modifier),
				`rule \`${rule.token}\` names no legend modifier`,
			);
		}
	}
});

test('a semantic rule spells out every font style it wants', () => {
	// `getTokenStyleMetadata` reports bold and italic as booleans rather than
	// "not set", so a semantic token claims those bits whatever the rule says.
	// A rule that stays silent about bold therefore switches it OFF for the
	// range it covers — the opposite of the grammar rules, where silence means
	// "leave it alone".
	const byToken = new Map(semanticTokenRules('light').map((rule) => [rule.token, rule.fontStyle]));
	assert.equal(byToken.get('strong.marker'), 'bold');
	assert.equal(byToken.get('emph.marker'), 'italic');
	assert.equal(byToken.get('heading'), 'bold');
	assert.equal(byToken.get('strike'), 'strikethrough');
	assert.equal(byToken.get('strong'), 'bold');
	assert.equal(byToken.get('emph'), 'italic');
	assert.equal(byToken.get('math'), 'italic');
});

test('the encoder writes deltas Monaco can decode', () => {
	const data = encodeSemanticTokens([
		{ kind: 'heading.marker', line: 0, start: 0, len: 3 },
		{ kind: 'heading', line: 0, start: 3, len: 5 },
		{ kind: 'strong.marker', line: 2, start: 4, len: 2 },
	]);

	assert.deepEqual(
		[...data],
		[
			// deltaLine, deltaStart, length, type, modifiers
			0, 0, 3, TOKEN_TYPES.indexOf('heading'), 1,
			0, 3, 5, TOKEN_TYPES.indexOf('heading'), 0,
			2, 4, 2, TOKEN_TYPES.indexOf('strong'), 1,
		],
	);
});

test('an unknown kind is dropped rather than mapped to another construct', () => {
	// Index arithmetic on an unknown name would paint some other construct's
	// colour, which is worse than leaving the grammar's.
	const data = encodeSemanticTokens([
		{ kind: 'nonesuch', line: 0, start: 0, len: 2 },
		{ kind: 'code', line: 0, start: 4, len: 6 },
	]);
	assert.equal(data.length, 5);
	assert.equal(data[1], 4, 'the surviving token still measures from the start of the line');
});

test('the editor turns the layer on, because the default is off', () => {
	// `StandaloneTheme.semanticHighlighting` is hard-coded false, so
	// `'configuredByTheme'` cannot reach it and the provider is never asked.
	const editor = readSource('src/lib/components/Editor.svelte');
	assert.match(editor, /'semanticHighlighting\.enabled': true/);
	assert.match(editor, /registerDocumentSemanticTokensProvider\(/);
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
