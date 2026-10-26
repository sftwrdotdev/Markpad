import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { buildExportDocument, exportThemeAttribute } from '../src/lib/utils/export.ts';
import { DEFAULT_PREVIEW_MAX_WIDTH, MIN_PREVIEW_MAX_WIDTH } from '../src/lib/utils/previewWidth.js';
import { plainAppearance } from './exportFixtures.ts';
import { functionSource, offsetOf, readRustBackend, readSource, sliceBetween, sliceFrom } from './sourceTree.js';
import { collectUsedKatexFamilies, katexFontUrlsToEmbed } from '../src/lib/utils/exportFonts.ts';
import { ALLOWED_MARKDOWN_URI_REGEXP, MARKDOWN_SANITIZE_CONFIG } from '../src/lib/utils/sanitize.js';
import { useShimDom } from './preview.domShim.ts';

/**
 * #467: "Is there a way how to change the width of exported HTML?" — there was
 * not. The exporter wrote `max-width: 900px` into every file it produced, which
 * is neither the user's Preview → Max width (#346–#349, renamed in #456) nor
 * even the app's own default of 880.
 *
 * Everything below resolves the stylesheet the export actually emits, rather
 * than matching on the source of the template that emits it. A test that
 * grepped `export.ts` for a width would stay green with the value going
 * nowhere: the declaration only means something once it is inside the `<style>`
 * block of a built document, attached to a selector the exported `<article
 * class="markdown-body">` matches, and last in the cascade. The last two tests
 * run the real `exportAsHtml` end to end and read the bytes it hands to
 * `save_file_content`, on the harness `export.test.ts` established.
 */
describe('exported content width', () => {
	// The shim stands in for the DOM `exportAsHtml` builds into. Without a real DOM
	// DOMPurify is a no-op object; what it does and where it sits in the pipeline is
	// `export.checks.test.ts`'s subject, not this one's.
	useShimDom({ window: globalThis, location: { href: 'http://tauri.localhost/' } }, { identitySanitize: true });

	const appStyles = readSource(new URL('../src/styles.css', import.meta.url));

	const viewerSource = readSource(new URL('../src/lib/MarkdownViewer.svelte', import.meta.url));

	type Rule = { selectors: string[]; declarations: string; media: 'screen' | 'print' };

	type Declaration = { value: string; important: boolean };

	function stripComments(css: string): string {
		return css.replace(/\/\*[\s\S]*?\*\//g, '');
	}

	/**
	 * Flattens a stylesheet into rules, remembering whether each one is inside a
	 * print block. Brace-aware rather than regex-per-rule, because the sheet under
	 * test is the app's real one: `@media`, `@supports` and `@font-face` all nest.
	 */
	function parseRules(css: string, media: Rule['media'] = 'screen'): Rule[] {
		const rules: Rule[] = [];
		let index = 0;

		while (index < css.length) {
			const open = css.indexOf('{', index);
			if (open === -1) break;
			const prelude = css.slice(index, open).trim();

			let depth = 0;
			let close = open;
			for (; close < css.length; close += 1) {
				if (css[close] === '{') depth += 1;
				else if (css[close] === '}') {
					depth -= 1;
					if (depth === 0) break;
				}
			}
			if (close >= css.length) break;

			const body = css.slice(open + 1, close);
			if (prelude.startsWith('@')) {
				if (/^@(?:media|supports|layer|container)\b/.test(prelude)) {
					rules.push(...parseRules(body, /\bprint\b/.test(prelude) ? 'print' : media));
				}
			} else if (prelude) {
				rules.push({ selectors: prelude.split(',').map((s) => s.trim()), declarations: body, media });
			}

			index = close + 1;
		}

		return rules;
	}

	/** The `<style>` block of a built export, comments removed. */
	function exportedStylesheet(document_: string): string {
		const match = document_.match(/<style>([\s\S]*?)<\/style>/);
		assert.ok(match, 'the export must carry a stylesheet');
		return stripComments(match[1]);
	}

	/** Every `property` declared for a bare `.markdown-body`, in cascade order. */
	function declarationsFor(css: string, property: string, media: Rule['media']): Declaration[] {
		const found: Declaration[] = [];
		for (const rule of parseRules(css)) {
			if (rule.media !== media || !rule.selectors.includes('.markdown-body')) continue;
			for (const piece of rule.declarations.split(';')) {
				const colon = piece.indexOf(':');
				if (colon === -1) continue;
				if (piece.slice(0, colon).trim().toLowerCase() !== property) continue;
				let value = piece.slice(colon + 1).trim();
				const important = /!important$/i.test(value);
				if (important) value = value.replace(/!important$/i, '').trim();
				found.push({ value, important });
			}
		}
		return found;
	}

	/**
	 * What an exported `<article class="markdown-body">` is actually capped at.
	 *
	 * All the candidates have identical specificity (one class, no `!important`
	 * among them today), so the winner is the last one in the sheet — which is what
	 * makes this worth resolving rather than reading off the template: the export's
	 * own rules are appended *after* the app's copied stylesheet, and a future
	 * `.markdown-body { max-width: … }` added anywhere below would take the file
	 * back off the setting without touching `export.ts` at all.
	 */
	function exportedMaxWidth(contentWidth: number | null, styles = ''): string {
		const document_ = buildExportDocument({
			theme: 'light',
			title: 'Notes',
			styles,
			articleHtml: '<p>body</p>',
			contentWidth,
			appearance: plainAppearance,
		});
		const declared = declarationsFor(exportedStylesheet(document_), 'max-width', 'screen');
		assert.ok(declared.length >= 1, 'the export must cap .markdown-body');
		const important = declared.filter((d) => d.important);
		return (important.length ? important : declared).at(-1)!.value;
	}

	test('the export cap loses to the print block, so the PDF route is unchanged', () => {
		// `@media print` in styles.css already forces `.markdown-body` to
		// `max-width: 100% !important` with its own .75in padding, and that block
		// travels into the export with the rest of the sheet. Printing an exported
		// file therefore never saw the 900px and must not start seeing the setting
		// either — the two routes stay separate concerns.
		const css = exportedStylesheet(exportDocumentWithAppStyles(MIN_PREVIEW_MAX_WIDTH));
		const printed = declarationsFor(css, 'max-width', 'print');
		assert.ok(printed.length >= 1, 'the print block must still cap .markdown-body');
		assert.deepEqual(printed.at(-1), { value: '100%', important: true });
		assert.deepEqual(declarationsFor(css, 'padding', 'print').at(-1), { value: '0.75in', important: true });
	});

	test('the app stylesheet copied into an export does not out-rank the cap', () => {
		// The export appends its rules after the copied sheet, so with real styles in
		// front of them the resolved screen cap still has to be the configured one.
		// If it ever is not, the setting is dead again and this is where it shows.
		assert.equal(exportedMaxWidth(1240, appStyles), '1240px');
		assert.equal(exportedMaxWidth(null, appStyles), 'none');
	});

	function exportDocumentWithAppStyles(contentWidth: number | null): string {
		return buildExportDocument({
			theme: 'light',
			title: 'Notes',
			styles: appStyles,
			articleHtml: '<p>body</p>',
			contentWidth,
			appearance: plainAppearance,
		});
	}

	test('the exporter is handed the preview\'s own derived width', () => {
		// The one link in the chain that cannot be executed here: `exportAsHtml`
		// lives in a `.svelte` component, which the Node test runner cannot import
		// (see sourceTree.ts). So the field is checked in the source of that one
		// function — `functionSource` rather than a whole-file match, so a
		// `contentWidth:` appearing anywhere else in a 3700-line component cannot
		// satisfy it.
		const exportCall = functionSource(viewerSource, 'exportAsHtml');
		assert.match(exportCall, /contentWidth: previewContentWidth,/);

		// And `previewContentWidth` is the same derived value the live preview
		// renders with, which is what makes "one source of truth" true rather than
		// merely intended. (preview.test.ts holds the other end of this.)
		assert.match(viewerSource, /previewContentWidth = \$derived\(getPreviewContentWidth\(settings\.previewMaxWidth, settings\.previewFullWidth\)\)/);
		assert.match(viewerSource, /--preview-max-width: \{previewContentWidth === null \? '100%' : `\$\{previewContentWidth\}px`\}/);
	});
});

describe('folds in print and export', () => {
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

	// `:has()` asks about a subtree, and only the ancestor chain is modelled. It is
	// stripped rather than refused for the same reason STRUCTURAL is: the rest of
	// the compound still answers most elements outright, and a rule keyed on a
	// class this element does not carry is decided without ever consulting the
	// subtree. Only a compound that otherwise matches has to admit it cannot tell.
	const RELATIONAL = /:has\([^()]*\)/;

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

		const bare = withoutNot.replace(STRUCTURAL, '').replace(RELATIONAL, '');
		if (!/^\*?(?:[a-z][a-z0-9]*)?(?:\.[A-Za-z0-9_-]+)*$/i.test(bare)) return 'unsupported';

		const classes = [...bare.matchAll(/\.([A-Za-z0-9_-]+)/g)].map((m) => m[1]);
		const tag = bare.replace(/[.*].*$/, '').toLowerCase();
		if (tag && tag !== element.tag) return false;
		if (!classes.every((cls) => element.classes.includes(cls))) return false;
		// Only now, with everything else matching, does the unmodelled part bite.
		return STRUCTURAL.test(withoutNot) || RELATIONAL.test(withoutNot) ? 'unsupported' : true;
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
			appearance: plainAppearance,
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
		assert.notEqual(printedValue(collapsedCallout, 'grid-template-rows'), 'minmax(0, 0fr)');
		assert.equal(printedValue(collapsedCallout, 'grid-template-rows'), 'minmax(0, 1fr)');
		assert.notEqual(printedValue(collapsedCallout, 'opacity'), '0');
		assert.notEqual(printedValue(collapsedCalloutInner, 'overflow'), 'hidden');
	});

	test('folding still works on screen', () => {
		// The print rules must reveal the fold, not disable the feature: the same
		// element on screen has to stay collapsed.
		assert.equal(screenValue(collapsedSection, 'height'), '0');
		assert.equal(screenValue(collapsedSection, 'opacity'), '0');
		assert.equal(screenValue(collapsedCallout, 'grid-template-rows'), 'minmax(0, 0fr)');
	});

	test('an open callout sizes its row with minmax, not a bare fr', () => {
		// #850. WebKit keeps the height a bare `1fr` row was given at a narrower
		// width: a callout laid out in the zero-width preview pane stayed ~500px tall
		// after Ctrl+E widened the pane to 860px, where it measures 98px. Measured in
		// a WKWebView; `minmax(0, 1fr)` re-sizes it, and Chromium is right either way.
		// jsdom has no layout, so the value is what this can hold.
		const openCallout: Element[] = [body, article, { tag: 'div', classes: ['markdown-alert'] }, { tag: 'div', classes: ['markdown-alert-content'] }];
		assert.equal(screenValue(openCallout, 'grid-template-rows'), 'minmax(0, 1fr)');
		assert.equal(printedValue(openCallout, 'grid-template-rows'), 'minmax(0, 1fr)');
	});

	test('an expanded section is unaffected by the reveal', () => {
		// The reveal is scoped to `.is-collapsed` now: the printed article is built
		// from the buffer, so no fold in it was ever animated to a measured height.
		assert.notEqual(printedValue(openSection, 'height'), '0');
		assert.notEqual(printedValue(openSection, 'opacity'), '0');
	});

	test('the fold controls do not print as misleading decoration', () => {
		// A collapsed chevron is rotated to point at content that now prints
		// expanded, and it is a control for an interaction paper does not have.
		const chevron = [body, article, { tag: 'div', classes: ['foldable-header', 'is-collapsed'] }, { tag: 'span', classes: ['header-fold-icon'] }];
		assert.equal(printedValue(chevron, 'display'), 'none');
	});

	test('folding a section turns its own chevron, not the ones nested inside it', () => {
		// A heading's content wrapper holds the headings below it, and a callout's
		// content can hold another callout. `.is-collapsed .header-fold-icon` matched
		// every one of those, so they turned while the section animated shut.
		const collapsedHeading = [body, article, { tag: 'h2', classes: ['foldable-header', 'is-collapsed'] }, { tag: 'span', classes: ['header-fold-icon'] }];
		assert.equal(screenValue(collapsedHeading, 'transform'), 'rotate(-90deg)');
		const nestedHeading = [...collapsedSectionInner, { tag: 'h3', classes: ['foldable-header'] }, { tag: 'span', classes: ['header-fold-icon'] }];
		assert.equal(screenValue(nestedHeading, 'transform'), undefined);
		assert.equal(screenValue(nestedHeading, 'opacity'), '0');

		const foldedCallout = [body, article, { tag: 'div', classes: ['markdown-alert', 'callout-foldable', 'is-collapsed'] }];
		const chevron = [{ tag: 'p', classes: ['markdown-alert-title', 'callout-toggle'] }, { tag: 'svg', classes: ['callout-fold-icon'] }];
		assert.equal(screenValue([...foldedCallout, ...chevron], 'transform'), 'rotate(-90deg)');
		const nestedCallout = [
			...foldedCallout,
			{ tag: 'div', classes: ['markdown-alert-content', 'is-collapsed'] },
			{ tag: 'div', classes: ['content-inner'] },
			{ tag: 'div', classes: ['markdown-alert', 'callout-foldable'] },
			...chevron,
		];
		assert.equal(screenValue(nestedCallout, 'transform'), undefined);
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
		assert.notEqual(exportedValue(collapsedCallout, 'grid-template-rows'), 'minmax(0, 0fr)');
		assert.equal(exportedValue(collapsedCallout, 'grid-template-rows'), 'minmax(0, 1fr)');
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
});

/**
 * The HTML export has to contain rendered rich content, not the source of it.
 *
 * Before this, `exportAsHtml` ran `render_markdown → sanitize →
 * processMarkdownHtml` and stopped. `renderRichContent` — highlight.js, KaTeX,
 * Mermaid — was a function inside `MarkdownViewer.svelte` that only the preview
 * could reach. So an exported file, the artefact whose entire purpose is being
 * read by someone without Markpad, arrived with
 * `<p data-math="display" data-math-source="E = mc^2">E = mc^2</p>`,
 * `<pre><code class="language-mermaid">` and code blocks with no highlight
 * classes at all.
 *
 * These tests run the real `exportAsHtml` and assert on the bytes it hands to
 * `save_file_content`. Two things are stood in for, both at a library boundary
 * rather than at one of ours:
 *
 *   - highlight.js, KaTeX and Mermaid. All three need a real browser DOM
 *     (measured against the shim: `hljs.highlightElement` and `katex.render`
 *     both throw on it, and Mermaid needs layout to size a node). They are
 *     injected through the same `libraries` field the app fills from the
 *     preview's own instances, so what is exercised here is Markpad's pipeline
 *     — which elements get handed to which library, and where the results end
 *     up — and not the libraries' own output.
 *   - `DOMPurify.sanitize`, which is a no-op object without a real DOM. It is
 *     replaced by the identity function. What the filter does and where it sits
 *     in the pipeline is pinned by `export.checks.test.ts`; the relevant fact
 *     here is only that the diagram filter and the document filter are separate
 *     calls, which the diagram test below covers from the other side.
 */
describe('rich content in the HTML export', () => {
	// The app resolves the bundled font assets against its own origin.
	useShimDom({ window: globalThis, location: { href: 'http://tauri.localhost/' } }, { identitySanitize: true });

	test('the installed KaTeX still gives the exporter fonts it can find', async () => {
		// `KATEX_CSS` above is a slice of katex.min.css frozen at the version it was
		// written against, so it proves the logic and not the coupling. A KaTeX
		// upgrade that renamed `.katex` or the `KaTeX_` family prefix would leave it
		// green while PDF export shipped a document with no maths fonts in it — and
		// 0.18.0 renamed KaTeX's internal classes, so that upgrade is not
		// hypothetical.
		//
		// This asks the installed KaTeX to render, and the installed stylesheet what
		// that rendering needs. Nothing here is written down: rename anything and the
		// intersection empties.
		const katex = ((await import('katex')) as any).default;
		const css = readSource('node_modules/katex/dist/katex.min.css');

		const root = (globalThis as any).document.createElement('div');
		root.innerHTML = katex.renderToString('\\mathcal{L} = \\frac{1}{2}', { throwOnError: false });

		const families = collectUsedKatexFamilies(root, css);
		assert.ok(
			families.size > 0,
			'the installed KaTeX renders markup the installed stylesheet gives no font to; ' +
				'PDF export would embed nothing and the maths would fall back to a UI font',
		);
		assert.ok(
			families.has('KaTeX_Main'),
			`expected the base family among ${[...families].join(', ') || '(none)'}`,
		);
		assert.ok(
			katexFontUrlsToEmbed(css, families).length > 0,
			'families were found but no @font-face src to embed for them',
		);
	});
});

describe('export sanitizing', () => {
	const exportSource = readSource('src/lib/utils/export.ts');

	const sanitizeSource = readSource('src/lib/utils/sanitize.ts');

	// DOMPurify itself needs a real DOM, which the Node test runner does not have,
	// so these tests exercise the two halves of the policy that are checkable here:
	// the URI decision (a pure regexp, applied exactly the way DOMPurify applies it,
	// see purify.es.mjs line ~1041) and the configuration that decides what the
	// filter may keep. The behavioural half was verified against the real DOMPurify
	// build in Chrome: `sanitizeMarkdownHtml(POC)` returns `<img src="x">` — the
	// event handler, and with it the whole payload, is gone.
	const ATTR_WHITESPACE = /[\u0000-\u0020\u00A0\u1680\u180E\u2000-\u2029\u205F\u3000]/g;

	function uriIsAllowed(value: string): boolean {
		return ALLOWED_MARKDOWN_URI_REGEXP.test(value.replace(ATTR_WHITESPACE, ''));
	}

	test('the export sanitizes the rendered document before it touches it', () => {
		// The regression this pins: `render_markdown` output going into
		// `processMarkdownHtml` — and from there into the file — without passing
		// through the shared filter first. Order matters as much as presence: the
		// sanitizer has to see the untrusted document, not our own generated markup.
		const sanitizeCall = exportSource.indexOf('const safeHtml = sanitizeMarkdownHtml(rendered);');
		const processCall = exportSource.indexOf('processMarkdownHtml(safeHtml, ctx.tabPath, new Set())');

		assert.ok(sanitizeCall !== -1, 'export must sanitize the raw render_markdown output');
		assert.ok(processCall !== -1, 'export must feed the sanitized HTML into processMarkdownHtml');
		assert.ok(sanitizeCall < processCall, 'sanitization must happen before any Markpad-owned processing');

		// The raw renderer output must not reach any other consumer unfiltered.
		assert.doesNotMatch(exportSource, /processMarkdownHtml\(\s*rendered\b/);
		assert.match(exportSource, /import \{ sanitizeMarkdownHtml \} from '\.\/sanitize\.js'/);
	});

	test('the proof-of-concept payload cannot reach an exported file', () => {
		// The payload's danger is the handler, not the URI: `x` is an ordinary
		// relative path and is meant to stay allowed. So nothing about the URI
		// policy stops this one — two other things do, and both are asserted here,
		// because on the unfixed export path neither was in the way.
		//
		// (`assert.match(POC, /onerror=/)` used to sit here. POC is a template
		// literal three lines above, so the assertion restated the fixture back to
		// itself and no change to `src/` could reach it.)
		assert.equal(uriIsAllowed('x'), true);

		// 1. The renderer output carrying the payload goes through the shared
		//    filter before anything else touches it, and DOMPurify drops `on*`
		//    handlers unless the config hands them back. Nothing in the shared
		//    config does: a future `ADD_ATTR: ['onerror']`, `ALLOWED_ATTR`,
		//    `ADD_TAGS`, `ALLOW_UNKNOWN_PROTOCOLS` or `SANITIZE_DOM: false` would
		//    fail the key assertion below.
		assert.match(exportSource, /const safeHtml = sanitizeMarkdownHtml\(rendered\);/);
		assert.deepEqual(Object.keys(MARKDOWN_SANITIZE_CONFIG).sort(), ['ALLOWED_URI_REGEXP', 'FORBID_TAGS']);
		assert.deepEqual(MARKDOWN_SANITIZE_CONFIG.FORBID_TAGS, ['style']);
		assert.equal(MARKDOWN_SANITIZE_CONFIG.ALLOWED_URI_REGEXP, ALLOWED_MARKDOWN_URI_REGEXP);

		// 2. Even if the filter ever lets something through, the exported document
		//    itself refuses to run it.
		assert.match(exportSource, /<meta http-equiv="Content-Security-Policy"/);
		assert.match(exportSource, /"default-src 'none'"/);
	});

	test('exported files carry a policy that cannot run script', () => {
		// Second line of defence: verified in Chrome, an exported page with this
		// meta tag runs neither an inline `<script>` nor an `onerror` handler even
		// when the body is left unsanitized, while the copied stylesheet, inline
		// style attributes, embedded data-URI images and remote https images all
		// still work.
		assert.match(exportSource, /<meta http-equiv="Content-Security-Policy" content="\$\{EXPORT_CSP\}">/);
		assert.match(exportSource, /"default-src 'none'"/);
		assert.match(exportSource, /"style-src 'unsafe-inline'"/);
		assert.match(exportSource, /'img-src data: https: http:'/);
		assert.match(exportSource, /'media-src data: https: http:'/);
		// Script execution must never be granted back.
		assert.doesNotMatch(exportSource, /script-src/);
		assert.doesNotMatch(exportSource, /unsafe-eval/);
	});

	test('the shared policy forbids author stylesheets', () => {
		// `<style>` is on DOMPurify's default allowlist and its CSS is not filtered.
		// In the preview the sanitized HTML is injected into the app's own document,
		// so a document author's stylesheet is not scoped to the article: it can
		// hide app chrome or beacon out through `background: url(https://…)`.
		// Verified in Chrome: with the tag forbidden, an author `<style>` block no
		// longer applies, and nothing Markpad renders depends on it.
		assert.ok(MARKDOWN_SANITIZE_CONFIG.FORBID_TAGS.includes('style'));
		// Inline `style` attributes stay allowed on purpose — documents use them
		// and `processMarkdownHtml` sets one on media elements.
		assert.doesNotMatch(sanitizeSource, /FORBID_ATTR/);
	});
});

describe('exported theme', () => {
	const styles = readSource('src/styles.css');

	const exportSource = readSource('src/lib/utils/export.ts');

	/** The opening `<html …>` tag of a built export. */
	function htmlTag(document: string): string {
		const match = document.match(/<html[^>]*>/);
		assert.ok(match, 'the export must contain an <html> tag');
		return match[0];
	}

	/** Does `<html …>` satisfy a `[data-theme="…"]` attribute selector? */
	function matchesThemeSelector(document: string, theme: string): boolean {
		return new RegExp(`<html[^>]*\\sdata-theme="${theme}"`).test(htmlTag(document));
	}

	function build(theme: string | null | undefined, extra: Partial<{ styles: string; title: string; articleHtml: string }> = {}) {
		return buildExportDocument({
			theme,
			title: extra.title ?? 'Notes',
			styles: extra.styles ?? '',
			articleHtml: extra.articleHtml ?? '<p>body</p>',
			contentWidth: DEFAULT_PREVIEW_MAX_WIDTH,
			appearance: plainAppearance,
		});
	}

	test('every theme selector the stylesheet defines can be reproduced by an export', () => {
		// Pins the two halves together: a new `:root[data-theme="…"]` block in
		// styles.css must be a value the export is willing to write out, or that
		// theme silently becomes unexportable.
		const declared = [...styles.matchAll(/:root\[data-theme="([^"]+)"\]/g)].map((m) => m[1]);
		assert.ok(declared.length >= 2, 'expected styles.css to select themes by data-theme');

		for (const theme of new Set(declared)) {
			assert.equal(exportThemeAttribute(theme), ` data-theme="${theme}"`, `${theme} must survive an export`);
			assert.ok(matchesThemeSelector(build(theme), theme));
		}
	});

	test('the system theme is exported as "follow the reader", not as a frozen colour', () => {
		// `system` is the one theme that is not a colour: MarkdownViewer deletes
		// `data-theme` for it and lets `@media (prefers-color-scheme: dark)` decide.
		// An export with no attribute reproduces that same cascade wherever it is
		// opened, which is the instruction the user actually gave. Baking in the
		// exporter's momentary system colour would make the file disagree with the
		// author's own screen the next time their machine switches.
		for (const absent of [undefined, null, '']) {
			const doc = build(absent);
			assert.doesNotMatch(htmlTag(doc), /data-theme/, `system theme must not pin a colour (${String(absent)})`);
			assert.match(htmlTag(doc), /^<html lang="en">$/);
		}

		// And the mechanism it delegates to has to still be in the sheet that gets copied.
		assert.match(styles, /@media \(prefers-color-scheme: dark\)/);
	});

	test('the export reads the theme off the same element the app themes', () => {
		assert.match(exportSource, /theme: document\.documentElement\.dataset\.theme/);
	});

	test('a ticked task dims its content once, not once per nesting level', () => {
		// `opacity` composites rather than inherits, so a rule matching every
		// descendant multiplies itself down the tree. Words survive that at one or two
		// levels deep and KaTeX does not: it nests twelve spans, so a formula in a
		// ticked item rendered at 0.65^12 = 0.006 and disappeared while the text beside
		// it merely faded. samples/katex-stress.md keeps a ticked and an unticked task
		// item next to each other so the difference is visible rather than arguable.
		//
		// Scanned across the whole stylesheet rather than inside one rule, because the
		// first attempt at this fixed `:has(:checked)` -- labelled in the file as the
		// fallback for reload and initial state -- and left `.task-done`, which is the
		// class the app actually sets. Both carried it. An assertion scoped to the
		// block being edited passed, and nothing a user sees had changed.
		const styles = readSource('src/styles.css');
		const universal = styles
			.split('\n')
			.filter((line) => /(task-done|data-task-checkbox\]:checked\))\s*\*\s*[,{]/.test(line));
		assert.deepEqual(
			universal,
			[],
			'a completed task applies opacity to every descendant; deep markup compounds it away',
		);

		// And both paths still dim something -- deleting the rules would pass the
		// assertion above for the wrong reason.
		for (const marker of ['li.task-done > .task-text', ':checked) > .task-text']) {
			const block = sliceFrom(styles, marker);
			assert.match(
				block.slice(0, 600),
				/opacity:\s*0?\.\d+/,
				`the rule at "${marker}" stopped dimming anything at all`,
			);
		}
	});

	test('a ticked task strikes only its own text, not its parents or sub-tasks', () => {
		// #911. `:has(input:checked)` matched every ancestor of a ticked sub-task, and
		// `text-decoration` on the `li` propagated into nested lists, where no
		// descendant rule can take it back off.
		const styles = readSource('src/styles.css');
		assert.doesNotMatch(styles, /:has\(input\[data-task-checkbox\]:checked\)/, 'a checkbox anywhere below the item matches it');
		assert.doesNotMatch(styles, /(task-done|:checked\))\s*\{/, 'a strike on the li reaches every nested list');
		assert.doesNotMatch(styles, /(task-done|:checked\))\s+\.task-text/, 'a descendant .task-text reaches every nested task');
	});

	test('a plain item in a list that also holds tasks keeps its bullet', () => {
		// comrak puts `contains-task-list` on the whole `<ul>` once any item is a
		// task, and `list-style` inherits, so a rule on the list stripped the bullet
		// from plain items beside a task.
		const selectors = readSource('src/styles.css')
			.replace(/\/\*[\s\S]*?\*\//g, '')
			.split('{')
			.map((chunk) => chunk.split('}').pop()!);
		assert.deepEqual(selectors.filter((s) => s.includes('contains-task-list')), []);
	});

	test('the marker rules are pseudo-elements, which is what makes them apply', () => {
		// `summary:marker` sat in the stylesheet as a single colon. `:marker` is not
		// a pseudo-class, so the rule matched nothing and the disclosure triangle was
		// never hidden -- silently, for as long as it had been there. esbuild, which
		// vite 6 minifies with, passes it through; lightningcss, which vite 8 uses,
		// rejects it by name:
		//
		//   'marker' is not recognized as a valid pseudo-class.
		//   Did you mean '::marker' (pseudo-element) or is this a typo?
		//
		// A rule that matches nothing is invisible in every direction: nothing renders
		// differently, nothing errors, and the CSS reads as if it works.
		//
		// Only the pseudo-elements with no legacy spelling. `:before`, `:after`,
		// `:first-line` and `:first-letter` are CSS2 and every browser still accepts
		// one colon -- this file inherits several from github-markdown-css and they
		// work. The ones CSS3 introduced have no such form: written with one colon
		// they parse as an unknown pseudo-class and the whole rule is discarded.
		const styles = readSource('src/styles.css');
		const singleColon = styles
			.split('\n')
			.filter((line) => /[^:]:(marker|placeholder|selection|backdrop|file-selector-button)\b/.test(line));
		assert.deepEqual(
			singleColon,
			[],
			'a CSS3 pseudo-element is written with one colon here, so the rule matches nothing',
		);
	});
});

describe('native PDF printing', () => {
	test('all Markpad webviews may invoke Tauri native printing', () => {
		const capability = JSON.parse(readSource('src-tauri/capabilities/default.json')) as {
			windows: string[];
			permissions: string[];
		};

		assert.deepEqual(capability.windows, ['main', 'window-*']);
		assert.ok(
			capability.permissions.includes('core:webview:allow-print'),
			'macOS replaces window.print() with Tauri native printing, which requires this permission',
		);
	});

	// A Tauri command name is a bare string on the JS side and an identifier inside a macro on the Rust
	// side, so nothing — not tsc, not `svelte-check`, not `cargo check` — notices
	// when one moves and the other does not. The failure is silent at build time
	// and total at runtime: "Export PDF" does nothing at all.
	test('both PDF commands the exporter invokes are registered with Tauri', () => {
		const exporter = readSource('src/lib/utils/export.ts');
		const tauriLib = readRustBackend();

		const registered = new Set(
			sliceBetween(tauriLib, 'tauri::generate_handler![', ']')
				.split(',')
				.map((entry) => entry.trim().replace(/^.*::/, '')),
		);

		// Read the names off the exporter rather than restating them, so a renamed
		// command is checked at its new name instead of quietly passing.
		const invoked = [...exporter.matchAll(/invoke\('([a-z_]*pdf[a-z_]*)'/g)].map((m) => m[1]);
		assert.deepEqual(invoked.sort(), ['export_pdf_windows', 'print_pdf']);

		for (const command of invoked) {
			assert.ok(registered.has(command), `export.ts invokes '${command}', which lib.rs must register`);
			assert.match(
				tauriLib,
				new RegExp(`#\\[tauri::command\\]\\n(?:pub )?(?:async )?fn ${command}\\(`),
				`${command} must be defined as a Tauri command`,
			);
		}
	});
});

describe('mermaid print theme', () => {
	test('the PDF export draws the document with the print theme', () => {
		// Paper is white whatever the screen is wearing, and Mermaid bakes the
		// theme into the SVG it emits, so the article the print route builds is
		// rendered with the print theme rather than the app's current one.
		const exporter = readSource('src/lib/utils/export.ts');
		const pdf = sliceBetween(exporter, 'export async function exportAsPdf', '\nasync function waitForImages');
		assert.match(pdf, /mermaidTheme: MERMAID_PRINT_THEME/);
		assert.match(exporter, /import \{ MERMAID_PRINT_THEME \} from '\.\/mermaidPrint\.js';/);
		// And the HTML export keeps carrying the author's appearance instead.
		const html = sliceBetween(exporter, 'export async function exportAsHtml', 'export async function exportAsPdf');
		assert.doesNotMatch(html, /MERMAID_PRINT_THEME/);
	});
});

describe('oversized media in print', () => {
	const styles = readSource('src/styles.css');

	/** The `@media print` block only — not everything that follows it in the file. */
	function extractPrintBlock(source: string): string {
		const start = offsetOf(source, '@media print {');
		let depth = 0;
		for (let i = offsetOf(source, '{', start); i < source.length; i += 1) {
			if (source[i] === '{') depth += 1;
			else if (source[i] === '}') {
				depth -= 1;
				if (depth === 0) return source.slice(start, i + 1);
			}
		}
		throw new Error('unterminated @media print block');
	}

	const printBlock = extractPrintBlock(styles);

	// Paper geometry the cap has to satisfy. `@page { margin: 0 }` makes the page
	// box the whole sheet, and `.markdown-body` supplies 0.75in of padding top and
	// bottom, so the printable column is the sheet height minus 1.5in.
	const LETTER_PRINTABLE_IN = 11 - 1.5;

	const A4_PRINTABLE_IN = 11.69 - 1.5;

	/** Print rules whose body sets `property` (never a vendor-prefixed variant). */
	function printRulesSetting(property: string): { selector: string; body: string }[] {
		const declaration = new RegExp(`(?<![\\w-])${property}:\\s*([^;]+);`);
		const rules: { selector: string; body: string }[] = [];
		const pattern = /([^{}]+)\{([^{}]*)\}/g;
		let match: RegExpExecArray | null;
		while ((match = pattern.exec(printBlock)) !== null) {
			if (declaration.test(match[2])) rules.push({ selector: match[1].trim(), body: match[2] });
		}
		return rules;
	}

	function capInInches(body: string): number {
		const raw = body.match(/(?<![\w-])max-height:\s*([\d.]+)in/);
		assert.ok(raw, `the cap must be an absolute length in inches, not: ${body.trim()}`);
		return Number(raw[1]);
	}

	test('the print block caps media height at a size both papers can hold', () => {
		// A replaced element cannot be fragmented, so `break-inside: avoid` on its
		// own turns anything taller than the printable column into a cropped
		// image rather than a page break.
		const capped = printRulesSetting('max-height');
		assert.ok(capped.length > 0, 'nothing in the print block caps media height');

		for (const rule of capped) {
			const inches = capInInches(rule.body);
			assert.ok(inches <= LETTER_PRINTABLE_IN, `${inches}in overflows Letter (${LETTER_PRINTABLE_IN}in)`);
			assert.ok(inches <= A4_PRINTABLE_IN, `${inches}in overflows A4 (${A4_PRINTABLE_IN}in)`);
			assert.ok(inches >= 6, `${inches}in shrinks every full-page figure needlessly`);
			assert.match(rule.body, /(?<![\w-])max-height:[^;]*!important;/);
		}
	});

	test('oversized images are scaled to a page instead of being clipped', () => {
		const capped = printRulesSetting('max-height').filter((rule) => /(?<![\w-])img(?![\w-])/.test(rule.selector));
		assert.equal(capped.length, 1, 'images need exactly one print height cap');
	});

	test('oversized mermaid diagrams are scaled to a page too', () => {
		const capped = printRulesSetting('max-height').filter((rule) => /\.mermaid-diagram svg/.test(rule.selector));
		assert.equal(capped.length, 1, 'diagrams need exactly one print height cap');
	});

	test('the cap preserves aspect ratio rather than squashing', () => {
		assert.match(printBlock, /(?<![\w-])object-fit:\s*contain\s*!important;/);
		// `height: auto` from the existing rhythm rule is what lets the cap scale
		// the width down proportionally; it must stay.
		assert.match(printBlock, /\.markdown-body img\s*\{[\s\S]*?height:\s*auto\s*!important;/);
		assert.match(printBlock, /\.markdown-body img\s*\{[\s\S]*?max-width:\s*100%\s*!important;/);
	});

	test('the diagram container does not clip the capped diagram', () => {
		// `.mermaid-diagram` carries `overflow-x: auto` for the screen, which
		// computes overflow-y to `auto` as well and would crop on paper.
		assert.match(printBlock, /\.markdown-body \.mermaid-diagram\s*\{[^}]*overflow:\s*visible\s*!important;/);
	});

	test('the media caps do not undo the existing print handling', () => {
		// #359 moved diagram colours out of CSS into a light-theme re-render
		// (utils/mermaidPrint.ts); the cap must not smuggle paint rules back in.
		assert.doesNotMatch(printBlock, /\.mermaid-diagram svg[^{]*\{[^}]*fill:/);
		assert.doesNotMatch(printBlock, /\.mermaid-diagram[^{]*\{[^}]*(?<![\w-])stroke:/);

		// Now that they fit, `break-inside: avoid` can do its job and move them
		// to the next page instead of cropping them.
		assert.match(
			printBlock,
			/\.markdown-body img,\s*\n\s*\.markdown-body \.mermaid-diagram,[\s\S]*?break-inside:\s*avoid;/,
		);
	});
});

describe('PDF prints the export article', () => {
	const styles = readSource('src/styles.css');

	const viewer = readSource('src/lib/MarkdownViewer.svelte');

	const exporter = readSource('src/lib/utils/export.ts');

	/** The `@media print` block only — not everything that follows it in the file. */
	function extractPrintBlock(source: string): string {
		const start = offsetOf(source, '@media print {');
		let depth = 0;
		for (let i = offsetOf(source, '{', start); i < source.length; i += 1) {
			if (source[i] === '{') depth += 1;
			else if (source[i] === '}') {
				depth -= 1;
				if (depth === 0) return source.slice(start, i + 1);
			}
		}
		throw new Error('unterminated @media print block');
	}

	const printBlock = extractPrintBlock(styles);

	const pdfExport = sliceBetween(exporter, 'export async function exportAsPdf', '\nasync function waitForImages');

	test('a PDF is rendered from the document, not from the window', () => {
		// `window.print()` over the live window made the paper whatever was on
		// screen, and every new part of the interface had to be subtracted back out
		// in the print sheet. Fifteen issues over five months were that list missing
		// an entry (#668). The article is built the way the HTML export builds it.
		assert.match(pdfExport, /await buildExportArticle\(/);
		assert.match(pdfExport, /ctx\.printRoot\.replaceChildren\(\.\.\.Array\.from\(article\.root\.childNodes\)\)/);
	});

	test('the article is taken down when printing ends, not when the command returns', () => {
		// `print_pdf` opens the platform print sheet and returns while it is still
		// up. Clearing the article at that point races the sheet for the page it is
		// about to render, and losing that race prints nothing at all.
		assert.match(pdfExport, /addEventListener\('afterprint', \(\) => ctx\.printRoot\.replaceChildren\(\), \{ once: true \}\)/);
		assert.doesNotMatch(pdfExport, /\} finally \{/);
		// A platform that never sends the event leaves it mounted, so the next
		// export has to start from empty rather than print the last document.
		const reset = offsetOf(pdfExport, 'ctx.printRoot.replaceChildren();');
		assert.ok(reset < offsetOf(pdfExport, 'await buildExportArticle('), 'the reset happens before the new article is built');
	});

	test('the document is on the page before the print command runs', () => {
		// An image that has not decoded prints as an empty box, which is the
		// failure that looks most like a successful export.
		const wait = offsetOf(pdfExport, 'waitForImages(ctx.printRoot)');
		assert.ok(wait < offsetOf(pdfExport, "invoke('print_pdf')"), 'images decode before the native print');
		assert.ok(wait < offsetOf(pdfExport, "invoke('export_pdf_windows'"), 'and before the Windows PDF writer');
		// An unreachable image must not hold the export open for ever.
		const waitHelper = sliceBetween(exporter, 'async function waitForImages', '\n}');
		assert.match(waitHelper, /setTimeout\(resolve, IMAGE_LOAD_TIMEOUT_MS\)/);
	});

	test('the print sheet reveals the article and hides everything else', () => {
		// `#app` is `display: contents`, so the app's markup and the print article
		// are siblings. Hiding by structure rather than by name is what keeps a
		// part of the interface added tomorrow off the page.
		assert.match(printBlock, /#app > :not\(#print-root\)\s*\{[^}]*display:\s*none\s*!important;/);
		assert.match(printBlock, /body > :not\(#app\)\s*\{[^}]*display:\s*none\s*!important;/);
		assert.match(printBlock, /#print-root\s*\{[^}]*display:\s*block\s*!important;/);
		// And it is not in the way on screen.
		assert.match(styles.slice(offsetOf(styles, '\n#print-root {')), /#print-root \{\n\tdisplay: none;/);
	});

	test('the print sheet names no part of the interface', () => {
		// The regression this change exists to prevent: one selector per app part,
		// growing by one every time a part is added, and silently wrong until
		// someone finds their find-bar highlights in a PDF.
		for (const selector of [
			'.custom-title-bar',
			'.tab-area',
			'.window-controls-left',
			'.title-actions-container',
			'.pane.editor-pane',
			'.pane.viewer-pane',
			'.split-bar',
			'.find-bar',
			'.toc-overlay-wrapper',
			'.markpad-find-match',
			'.home-menu-container',
			'.theme-dropdown-container',
		]) {
			assert.doesNotMatch(
				printBlock,
				new RegExp(selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
				`${selector} is app state — the printed article cannot contain it, so the print sheet must not mention it`,
			);
		}
	});

	test('the viewer hands over an article rather than its own preview', () => {
		assert.match(viewer, /<article id="print-root" class="markdown-body" bind:this=\{printRootEl\}><\/article>/);
		const pdf = sliceBetween(viewer, 'async function exportAsPdf', '\n	}');
		assert.match(pdf, /printRoot: printRootEl/);
		// The preview's own DOM, its fold state and its theme have nothing to do
		// with what prints now, so nothing refreshes or re-themes it for an export.
		assert.doesNotMatch(viewer, /syncPreviewForPrint/);
		assert.doesNotMatch(viewer, /renderDiagramsForPrint/);
	});
});
