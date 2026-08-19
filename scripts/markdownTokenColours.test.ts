import assert from 'node:assert/strict';
import test from 'node:test';

import { monacoTokenRules } from '../src/lib/utils/theme.js';

// #676: an imported VS Code theme colours TextMate scopes, Monaco's markdown
// tokenizer emits names of its own, and until now nothing renamed one into the
// other — so `markup.bold` reached `defineTheme` and matched nothing.

const rulesFor = (tokenColors: unknown) => monacoTokenRules(tokenColors);
const tokens = (tokenColors: unknown) => rulesFor(tokenColors).map((rule) => rule.token);

test('an emphasis scope also arrives under the token Monaco emits', () => {
	const rules = rulesFor([
		{ scope: 'markup.bold', settings: { foreground: '#ff0000', fontStyle: 'bold' } },
		{ scope: 'markup.italic', settings: { foreground: '#00ff00' } },
		{ scope: ['markup.inline.raw', 'markup.underline.link'], settings: { foreground: '#0000ff' } },
	]);

	const byToken = new Map(rules.map((rule) => [rule.token, rule]));
	assert.deepEqual(byToken.get('strong'), { token: 'strong', foreground: 'ff0000', fontStyle: 'bold' });
	assert.equal(byToken.get('emphasis')?.foreground, '00ff00');
	assert.equal(byToken.get('variable')?.foreground, '0000ff');
	assert.equal(byToken.get('string.link')?.foreground, '0000ff');

	// The scope keeps its own rule too — it is inert, not wrong.
	assert.ok(byToken.has('markup.bold'));
});

test('a language-qualified scope is renamed too, and a shorter neighbour is not', () => {
	assert.ok(tokens([{ scope: 'markup.bold.markdown', settings: { foreground: '#ff0000' } }]).includes('strong'));
	assert.ok(tokens([{ scope: 'markup.italic.markdown', settings: { foreground: '#ff0000' } }]).includes('emphasis'));

	// `markup.underline` is underlined text, not a link, and must not take the
	// link colour on the strength of a shared prefix.
	assert.deepEqual(tokens([{ scope: 'markup.underline', settings: { foreground: '#ff0000' } }]), ['markup.underline']);
});

test('a colour-only rule leaves the base theme to keep bold and italic', () => {
	// Monaco reads a missing `fontStyle` as NotSet and keeps what is already on
	// the token — `vs`/`vs-dark` define `strong: bold` and `emphasis: italic`.
	// Spelling it `regular` here instead would flatten the text the theme was
	// only asked to colour.
	const rule = rulesFor([{ scope: 'markup.bold', settings: { foreground: '#ff0000' } }]).find((r) => r.token === 'strong');
	assert.ok(rule, 'the alias must exist before its fontStyle means anything');
	assert.equal(rule.fontStyle, undefined);
});

test('scopes written as one comma-separated string are split', () => {
	// Left whole, the comma is part of the token name and the entry colours
	// nothing — the same silent miss as the missing rename.
	assert.deepEqual(
		tokens([{ scope: 'comment, markup.bold', settings: { foreground: '#ff0000' } }]),
		['comment', 'markup.bold', 'strong', 'strong.marker'],
	);
});

test('an unusable entry is dropped rather than passed to defineTheme', () => {
	// A non-hex foreground makes `defineTheme` throw, which drops the whole
	// editor theme, so it cannot reach it — alias or not.
	assert.deepEqual(tokens([{ scope: 'markup.bold', settings: { foreground: 'red' } }]), []);
	assert.deepEqual(tokens([{ scope: 'markup.bold', settings: {} }]), []);
	assert.deepEqual(tokens([{ settings: { foreground: '#ff0000' } }]), []);
	assert.deepEqual(tokens(undefined), []);
});

test('an imported theme reaches the semantic names too, not only the grammar ones', () => {
	// The grammar calls italics `emphasis` and the renderer's parse calls it
	// `emph`; a scope that stopped at the first spelling would leave the second
	// unstyled. `~~strikethrough~~` has no grammar name at all, so `strike` is
	// the only way a theme can colour it — which is the half of #676 that could
	// not be answered until the parse drove the colours.
	const byToken = new Map(
		rulesFor([
			{ scope: 'markup.italic', settings: { foreground: '#00ff00' } },
			{ scope: 'markup.strikethrough', settings: { foreground: '#888888' } },
			{ scope: 'markup.heading', settings: { foreground: '#61afef' } },
			{ scope: 'markup.inline.raw', settings: { foreground: '#98c379' } },
			{ scope: 'markup.underline.link', settings: { foreground: '#56b6c2' } },
			{ scope: 'markup.quote', settings: { foreground: '#5c6370' } },
		]).map((rule) => [rule.token, rule.foreground]),
	);
	assert.equal(byToken.get('emph'), '00ff00');
	assert.equal(byToken.get('emphasis'), '00ff00');
	assert.equal(byToken.get('strike'), '888888');
	assert.equal(byToken.get('heading'), '61afef');
	assert.equal(byToken.get('code'), '98c379');
	assert.equal(byToken.get('link'), '56b6c2');
	assert.equal(byToken.get('quote'), '5c6370');
});

