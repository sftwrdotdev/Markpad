import assert from 'node:assert/strict';
import test from 'node:test';

import { buildExportDocument } from '../src/lib/utils/export.js';
import { DEFAULT_PREVIEW_MAX_WIDTH } from '../src/lib/utils/previewWidth.js';
import { readSource } from './sourceTree.js';

const styles = readSource('src/styles.css');
const exportSource = readSource('src/lib/utils/export.ts');

// Both export routes have to agree on what is in the file. The HTML route
// decides in TypeScript (it renders every fold open); the print/PDF route
// decides in CSS, because it prints the live DOM with its folds still
// collapsed. So the question "does a collapsed section survive the export" is,
// on the print side, a cascade question — and it is answered here by resolving
// the cascade rather than by grepping for a declaration, so that a later rule
// re-hiding the section fails this file no matter how it is spelled.

type Declaration = { property: string; value: string; important: boolean };
type Rule = { selector: string; declarations: Declaration[]; order: number; media: 'all' | 'print' | 'other' };
type Element = { tag: string; classes: string[] };

function stripComments(css: string): string {
	return css.replace(/\/\*[\s\S]*?\*\//g, '');
}

function parseDeclarations(body: string): Declaration[] {
	const declarations: Declaration[] = [];
	for (const piece of body.split(';')) {
		const colon = piece.indexOf(':');
		if (colon === -1) continue;
		const property = piece.slice(0, colon).trim().toLowerCase();
		let value = piece.slice(colon + 1).trim();
		if (!property || !value) continue;
		const important = /!important$/i.test(value);
		if (important) value = value.replace(/!important$/i, '').trim();
		declarations.push({ property, value, important });
	}
	return declarations;
}

/** Flattens the sheet into style rules, remembering which @media block each came from. */
function parseRules(css: string): Rule[] {
	const rules: Rule[] = [];
	let order = 0;

	const walk = (source: string, media: Rule['media']) => {
		let index = 0;
		while (index < source.length) {
			const open = source.indexOf('{', index);
			if (open === -1) return;
			const prelude = source.slice(index, open).trim();

			let depth = 0;
			let close = open;
			for (; close < source.length; close += 1) {
				if (source[close] === '{') depth += 1;
				else if (source[close] === '}') {
					depth -= 1;
					if (depth === 0) break;
				}
			}
			assert.ok(close < source.length, `unterminated block after ${prelude.slice(0, 40)}`);
			const body = source.slice(open + 1, close);

			if (prelude.startsWith('@')) {
				const nested = /^@(media|supports|layer|container)\b/.test(prelude);
				if (nested) {
					const isPrint = /@media[^{]*\bprint\b/.test(prelude);
					walk(body, isPrint ? 'print' : media === 'print' ? 'print' : 'other');
				}
			} else {
				const declarations = parseDeclarations(body);
				for (const selector of prelude.split(',')) {
					const trimmed = selector.trim();
					if (trimmed) rules.push({ selector: trimmed, declarations, order: order++, media });
				}
			}
			index = close + 1;
		}
	};

	walk(css, 'all');
	return rules;
}

// The elements below are modelled as they exist while printing a document:
// classed, attribute-free, and never hovered or focused. That is what lets a
// compound the matcher cannot fully parse still be answered definitively —
// `[open]`, `:hover` and `::selection` simply cannot apply to them.
const NEVER_IN_PRINT =
	/:(?:hover|focus|focus-visible|focus-within|active|target|before|after|marker|placeholder|selection|backdrop|first-line|first-letter)\b|::/;
const NEEDS_SIBLINGS = /[+~]/;
const STRUCTURAL = /:(?:first|last|only|nth)-[a-z-]+/;

/** false: cannot match this element. 'unsupported': the matcher cannot tell. */
function compoundMatches(compound: string, element: Element): boolean | 'unsupported' {
	if (NEVER_IN_PRINT.test(compound)) return false;
	if (/\[/.test(compound)) return false;
	// The app chrome (`#app`) is an id; the fold wrapper's own generated id
	// (`wrap-N`) is never styled. Either way an id selector cannot match here.
	if (/#/.test(compound)) return false;

	const withoutNot = compound.replace(/:not\(([^()]*)\)/g, (_, inner: string) => {
		const negated = inner.trim();
		const matchesNegated = /^\.[A-Za-z0-9_-]+$/.test(negated)
			? element.classes.includes(negated.slice(1))
			: /^[a-z][a-z0-9]*$/i.test(negated)
				? negated.toLowerCase() === element.tag
				: null;
		return matchesNegated === null ? ':unsupported' : matchesNegated ? ':fails' : '';
	});
	if (withoutNot.includes(':fails')) return false;
	if (withoutNot.includes(':unsupported')) return 'unsupported';

	const bare = withoutNot.replace(STRUCTURAL, '');
	if (!/^\*?(?:[a-z][a-z0-9]*)?(?:\.[A-Za-z0-9_-]+)*$/i.test(bare)) return 'unsupported';

	const classes = [...bare.matchAll(/\.([A-Za-z0-9_-]+)/g)].map((m) => m[1]);
	const tag = bare.replace(/[.*].*$/, '').toLowerCase();
	if (tag && tag !== element.tag) return false;
	if (!classes.every((cls) => element.classes.includes(cls))) return false;
	// Only now, with everything else matching, does the unmodelled part bite.
	return STRUCTURAL.test(withoutNot) ? 'unsupported' : true;
}

/** Right-to-left matching against an ancestor chain (root first). */
function selectorMatches(selector: string, chain: Element[]): boolean | 'unsupported' {
	const subjectCompound = selector.split(/[\s>+~]+/).filter(Boolean).pop() || '';
	const subject = compoundMatches(subjectCompound, chain[chain.length - 1]);
	if (subject !== true) return subject;

	// No sibling is modelled, so a rule that survived the subject test and
	// needs one cannot be decided here.
	if (NEEDS_SIBLINGS.test(selector)) return 'unsupported';

	const parts = selector.replace(/\s*>\s*/g, ' > ').split(/\s+/).filter(Boolean);
	let part = parts.length - 2;
	let index = chain.length - 1;

	while (part >= 0) {
		const isChild = parts[part] === '>';
		if (isChild) part -= 1;
		if (part < 0) return 'unsupported';

		let matched = false;
		while (index > 0) {
			index -= 1;
			const result = compoundMatches(parts[part], chain[index]);
			if (result === 'unsupported') return 'unsupported';
			if (result) {
				matched = true;
				break;
			}
			if (isChild) break;
		}
		if (!matched) return false;
		part -= 1;
	}
	return true;
}

function specificity(selector: string): number {
	const ids = (selector.match(/#[A-Za-z0-9_-]+/g) || []).length;
	const classes = (selector.match(/\.[A-Za-z0-9_-]+/g) || []).length;
	const tags = selector.split(/\s+/).filter((part) => /^[a-z]/.test(part)).length;
	return ids * 10000 + classes * 100 + tags;
}

const appRules = parseRules(stripComments(styles));

/**
 * The value a property resolves to for `chain`'s last element, resolved by
 * !important, then specificity, then document order — the real cascade.
 * `media` selects which blocks are live: `all` alone is the screen, `all` plus
 * `print` is the sheet a PDF is rendered from.
 */
function resolve(rules: Rule[], chain: Element[], property: string, media: Set<Rule['media']>): string | undefined {
	let winner: { important: boolean; specificity: number; order: number; value: string } | undefined;

	for (const rule of rules) {
		if (!media.has(rule.media)) continue;
		// Only rules that could change the answer are resolved — and every one
		// of those has to be resolvable, so a selector this matcher cannot
		// decide fails the test instead of quietly dropping out of the cascade.
		if (!rule.declarations.some((declaration) => declaration.property === property)) continue;
		const match = selectorMatches(rule.selector, chain);
		assert.notEqual(
			match,
			'unsupported',
			`this test cannot resolve "${rule.selector}" against .${chain[chain.length - 1].classes.join('.')}; extend the matcher rather than leaving the rule unchecked`,
		);
		if (!match) continue;

		for (const declaration of rule.declarations) {
			if (declaration.property !== property) continue;
			const candidate = { important: declaration.important, specificity: specificity(rule.selector), order: rule.order, value: declaration.value };
			if (
				!winner ||
				(candidate.important && !winner.important) ||
				(candidate.important === winner.important &&
					(candidate.specificity > winner.specificity ||
						(candidate.specificity === winner.specificity && candidate.order > winner.order)))
			) {
				winner = candidate;
			}
		}
	}

	return winner?.value;
}

const SCREEN: Set<Rule['media']> = new Set(['all']);
const PAPER: Set<Rule['media']> = new Set(['all', 'print']);

/** What a PDF of the live viewer DOM shows. */
const printedValue = (chain: Element[], property: string) => resolve(appRules, chain, property, PAPER);
/** What the app itself shows. */
const screenValue = (chain: Element[], property: string) => resolve(appRules, chain, property, SCREEN);

// The exported file is a different stylesheet: the app's sheets copied in
// verbatim, then the export's own rules appended. Resolving against that is
// what says whether the recipient can read a section — and in an exported file
// there is no toggle and no script, so anything hidden is hidden for good.
const exportedStyles = (() => {
	const document_ = buildExportDocument({
		theme: 'light',
		title: 'T',
		styles,
		articleHtml: '',
		contentWidth: DEFAULT_PREVIEW_MAX_WIDTH,
	});
	const match = document_.match(/<style>([\s\S]*)<\/style>/);
	assert.ok(match, 'the export must carry a stylesheet');
	return parseRules(stripComments(match[1]));
})();
const exportedValue = (chain: Element[], property: string) => resolve(exportedStyles, chain, property, SCREEN);

const body: Element = { tag: 'body', classes: [] };
const article: Element = { tag: 'article', classes: ['markdown-body'] };

const collapsedSection: Element[] = [body, article, { tag: 'div', classes: ['foldable-content-wrapper', 'is-collapsed'] }];
const collapsedSectionInner: Element[] = [...collapsedSection, { tag: 'div', classes: ['content-inner'] }];
const collapsedCallout: Element[] = [
	body,
	article,
	{ tag: 'div', classes: ['markdown-alert', 'is-collapsed'] },
	{ tag: 'div', classes: ['markdown-alert-content', 'is-collapsed'] },
];
const collapsedCalloutInner: Element[] = [...collapsedCallout, { tag: 'div', classes: ['content-inner'] }];
const openSection: Element[] = [body, article, { tag: 'div', classes: ['foldable-content-wrapper'] }];

test('a collapsed heading section is printed, not clipped away', () => {
	// The PDF is the copy the reader gets. Clipping a fold to zero height
	// deletes text from it that the author can still reach in two clicks, and
	// leaves no sign in the file that anything is missing.
	assert.notEqual(printedValue(collapsedSection, 'height'), '0');
	assert.equal(printedValue(collapsedSection, 'height'), 'auto');
	assert.notEqual(printedValue(collapsedSection, 'overflow'), 'hidden');
	// Height alone is not enough: the screen rule pairs it with opacity: 0.
	assert.notEqual(printedValue(collapsedSection, 'opacity'), '0');
	assert.notEqual(printedValue(collapsedSectionInner, 'overflow'), 'hidden');
});

test('a collapsed callout is printed too', () => {
	// Same defect, second mechanism: callouts collapse with a 0fr grid track
	// instead of a height, so a fix aimed only at headings leaves half the
	// document still disappearing.
	assert.notEqual(printedValue(collapsedCallout, 'grid-template-rows'), '0fr');
	assert.equal(printedValue(collapsedCallout, 'grid-template-rows'), '1fr');
	assert.notEqual(printedValue(collapsedCallout, 'opacity'), '0');
	assert.notEqual(printedValue(collapsedCalloutInner, 'overflow'), 'hidden');
});

test('folding still works on screen', () => {
	// The print rules must reveal the fold, not disable the feature: the same
	// element on screen has to stay collapsed.
	assert.equal(screenValue(collapsedSection, 'height'), '0');
	assert.equal(screenValue(collapsedSection, 'opacity'), '0');
	assert.equal(screenValue(collapsedCallout, 'grid-template-rows'), '0fr');
});

test('an expanded section is unaffected by the reveal', () => {
	assert.equal(printedValue(openSection, 'height'), 'auto');
	assert.notEqual(printedValue(openSection, 'opacity'), '0');
});

test('the fold controls do not print as misleading decoration', () => {
	// A collapsed chevron is rotated to point at content that now prints
	// expanded, and it is a control for an interaction paper does not have.
	const chevron = [body, article, { tag: 'div', classes: ['foldable-header', 'is-collapsed'] }, { tag: 'span', classes: ['header-fold-icon'] }];
	assert.equal(printedValue(chevron, 'display'), 'none');
});

test('the HTML export renders every heading fold open', () => {
	// The HTML route never sees the live DOM, it re-renders from source, and
	// the Set it passes is the fold state that render is given. An empty one is
	// what makes every section expanded.
	assert.match(exportSource, /processMarkdownHtml\(safeHtml, ctx\.tabPath, new Set\(\)\)/);
	assert.doesNotMatch(exportSource, /processMarkdownHtml\([^)]*foldOverrides/);
});

test('a callout collapsed in the source is still readable in an exported file', () => {
	// The empty Set only governs heading folds. `> [!note]-` puts `is-collapsed`
	// in the markup itself, so it survives the re-render — and an exported file
	// has no toggle to undo it and a policy that forbids the script one, so the
	// text ships present, clipped to nothing, and unreachable forever. Verified
	// in Chrome against a real exported file before the fix: the collapsed
	// callout's content box measured 0px at opacity 0.
	assert.notEqual(exportedValue(collapsedCallout, 'grid-template-rows'), '0fr');
	assert.equal(exportedValue(collapsedCallout, 'grid-template-rows'), '1fr');
	assert.notEqual(exportedValue(collapsedCallout, 'opacity'), '0');
	assert.notEqual(exportedValue(collapsedCalloutInner, 'overflow'), 'hidden');

	// The same guarantee for a heading fold, whatever fold state a future
	// caller hands the renderer.
	assert.notEqual(exportedValue(collapsedSection, 'height'), '0');
	assert.notEqual(exportedValue(collapsedSection, 'opacity'), '0');
});

test('an exported file does not offer controls it cannot honour', () => {
	const chevron = [body, article, { tag: 'div', classes: ['markdown-alert', 'is-collapsed'] }, { tag: 'svg', classes: ['callout-fold-icon'] }];
	assert.equal(exportedValue(chevron, 'display'), 'none');
});
