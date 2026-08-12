import assert from 'node:assert/strict';
import test from 'node:test';

import { compile } from 'svelte/compiler';

import { offsetOf, readSource, sliceBetween, sliceFrom } from './sourceTree.js';

/*
 * Export PDF from plain edit mode produced a blank page, for two independent
 * reasons. This file covers both.
 *
 * 1. THE PANE. Printing works by hiding the editor and letting the viewer pane
 *    fill the sheet. Edit mode collapses that pane to `width: 0` /
 *    `opacity: 0` from MarkdownViewer.svelte, and the print sheet's
 *    `.pane.viewer-pane` could not outrank it: two `!important` declarations
 *    are decided by specificity, and Svelte's scoped selector carries five
 *    classes against two.
 *
 *    This half is a cascade question, so it is answered by resolving the
 *    cascade — over the REAL compiled component CSS, not a copy of it, so the
 *    scoping Svelte actually emits is what gets measured. What this proves:
 *    for the element chain a PDF is rendered from, `width`/`flex`/`opacity`/
 *    `display` resolve to visible values with the print sheet live, and to the
 *    collapsed ones without it. What it does not prove: that the printed page
 *    is legible, or anything about elements not in the modelled chain.
 *
 * 2. THE CONTENT. `tab.content` is only kept in step with the buffer while the
 *    preview is on screen. In plain edit mode with the TOC closed it is not,
 *    so revealing the pane alone would have printed the document as it was
 *    before the editing session — a failure that looks like a success. That
 *    half lives inside the component and is asserted against its source; see
 *    the note on those tests for what that does and does not establish.
 */

const styles = readSource('src/styles.css');
const viewer = readSource('src/lib/MarkdownViewer.svelte');

const componentCss = (() => {
	const compiled = compile(viewer, { filename: 'MarkdownViewer.svelte', css: 'external' });
	assert.ok(compiled.css?.code, 'the component must emit scoped CSS');
	return compiled.css.code;
})();

// --- a small cascade resolver ------------------------------------------------

type Declaration = { property: string; value: string; important: boolean };
type Rule = { selector: string; declarations: Declaration[]; order: number; print: boolean };
type Element = { tag: string; id?: string; classes: string[]; inline?: Record<string, string> };

const SCOPE_CLASS = /^svelte-[a-z0-9]+$/;

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

function parseRules(css: string, startOrder: number): Rule[] {
	const rules: Rule[] = [];
	let order = startOrder;

	const walk = (source: string, print: boolean) => {
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
				if (/^@(media|supports|layer|container)\b/.test(prelude)) {
					walk(body, print || /@media[^{]*\bprint\b/.test(prelude));
				}
			} else {
				const declarations = parseDeclarations(body);
				for (const selector of prelude.split(',')) {
					const trimmed = selector.trim();
					if (trimmed) rules.push({ selector: trimmed, declarations, order: order++, print });
				}
			}
			index = close + 1;
		}
	};

	walk(css, false);
	return rules;
}

/** `:where()` contributes nothing; `:not()` contributes its argument. */
function specificity(selector: string): number {
	const counted = selector
		.replace(/:where\([^()]*\)/g, '')
		.replace(/:not\(([^()]*)\)/g, '$1');
	const ids = (counted.match(/#[A-Za-z0-9_-]+/g) || []).length;
	const classes = (counted.match(/[.:][A-Za-z0-9_-]+/g) || []).length;
	const tags = counted.split(/[\s>]+/).filter((part) => /^[a-z]/.test(part)).length;
	return ids * 10000 + classes * 100 + tags;
}

/** false: cannot match. 'unsupported': this matcher cannot decide. */
function compoundMatches(compound: string, element: Element): boolean | 'unsupported' {
	// The chain is modelled as it exists while printing: no pointer, no focus,
	// no siblings, no pseudo-elements. None of these can apply to it.
	if (/:(?:hover|focus|active|target|before|after|marker|selection|first-line|first-letter)\b|::/.test(compound)) return false;
	if (/\[/.test(compound)) return false;

	let rest = compound;
	let failed = false;
	rest = rest.replace(/:where\(([^()]*)\)/g, (_, inner: string) => {
		for (const part of inner.split(',')) {
			const trimmed = part.trim();
			if (!/^\.[A-Za-z0-9_-]+$/.test(trimmed)) return ':unsupported';
			const cls = trimmed.slice(1);
			// Svelte puts only its scope class in `:where()`, and every element
			// modelled here belongs to this component.
			if (!(SCOPE_CLASS.test(cls) || element.classes.includes(cls))) return ':fails';
		}
		return '';
	});
	rest = rest.replace(/:not\(([^()]*)\)/g, (_, inner: string) => {
		const trimmed = inner.trim();
		if (/^\.[A-Za-z0-9_-]+$/.test(trimmed)) return element.classes.includes(trimmed.slice(1)) ? ':fails' : '';
		if (/^[a-z][a-z0-9]*$/i.test(trimmed)) return trimmed.toLowerCase() === element.tag ? ':fails' : '';
		return ':unsupported';
	});
	if (rest.includes(':fails')) return false;
	if (rest.includes(':unsupported')) return 'unsupported';
	if (rest.includes(':')) return 'unsupported';

	if (!/^\*?(?:[a-z][a-z0-9]*)?(?:#[A-Za-z0-9_-]+)?(?:\.[A-Za-z0-9_-]+)*$/i.test(rest)) return 'unsupported';

	const id = rest.match(/#([A-Za-z0-9_-]+)/)?.[1];
	if (id && id !== element.id) return false;
	const classes = [...rest.matchAll(/\.([A-Za-z0-9_-]+)/g)].map((m) => m[1]);
	const tag = rest.replace(/[.#*].*$/, '').toLowerCase();
	if (tag && tag !== element.tag) return false;
	return classes.every((cls) => SCOPE_CLASS.test(cls) || element.classes.includes(cls));
}

/** Right-to-left matching against an ancestor chain (root first). */
function selectorMatches(selector: string, chain: Element[]): boolean | 'unsupported' {
	const parts = selector.replace(/\s*>\s*/g, ' > ').split(/[\s]+/).filter(Boolean);

	// The subject decides first. A rule whose subject cannot match this element
	// is out of the cascade no matter what the rest of it says, so combinators
	// this matcher does not model only bite once the element itself matched.
	const subject = compoundMatches(parts[parts.length - 1].replace(/^[+~>]$/, ''), chain[chain.length - 1]);
	if (subject !== true) return subject;

	// No sibling is modelled, so a rule that survived the subject test and
	// needs one cannot be decided here.
	if (/[+~]/.test(selector)) return 'unsupported';

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

const allRules = [
	...parseRules(stripComments(styles), 0),
	// Component styles are injected separately from the app sheet and their
	// relative order is not guaranteed, so they are appended: the later
	// position is the harder case for the print rules to win.
	...parseRules(stripComments(componentCss), 100000),
];

function resolve(chain: Element[], property: string, printing: boolean): string | undefined {
	const element = chain[chain.length - 1];
	let winner: { important: boolean; specificity: number; order: number; value: string } | undefined;

	// An inline style beats every non-important stylesheet declaration.
	const inline = element.inline?.[property];
	if (inline !== undefined) {
		winner = { important: false, specificity: Number.MAX_SAFE_INTEGER, order: Number.MAX_SAFE_INTEGER, value: inline };
	}

	for (const rule of allRules) {
		if (rule.print && !printing) continue;
		if (!rule.declarations.some((declaration) => declaration.property === property)) continue;
		const match = selectorMatches(rule.selector, chain);
		assert.notEqual(
			match,
			'unsupported',
			`this test cannot resolve "${rule.selector}" against ${element.tag}.${element.classes.join('.')}; extend the matcher rather than leaving the rule unchecked`,
		);
		if (!match) continue;

		for (const declaration of rule.declarations) {
			if (declaration.property !== property) continue;
			const candidate = {
				important: declaration.important,
				specificity: specificity(rule.selector),
				order: rule.order,
				value: declaration.value,
			};
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

// --- the DOM a PDF is rendered from -----------------------------------------

const body: Element = { tag: 'body', classes: [] };
const app: Element = { tag: 'div', id: 'app', classes: [] };
const container: Element = { tag: 'div', classes: ['markdown-container'] };

/** `flex` is written inline from the split ratio / mode; see the template. */
const layout = (classes: string[]): Element => ({ tag: 'div', classes: ['layout-container', ...classes] });
const viewerPane = (inlineFlex: string): Element => ({
	tag: 'div',
	classes: ['pane', 'viewer-pane'],
	inline: { flex: inlineFlex },
});
const editorPane = (inlineFlex: string): Element => ({
	tag: 'div',
	classes: ['pane', 'editor-pane', 'active'],
	inline: { flex: inlineFlex },
});

/** Plain edit mode: not split, TOC closed. This is the reported case. */
const editingViewer = [body, app, container, layout(['editing']), viewerPane('0')];
const editingEditor = [body, app, container, layout(['editing']), editorPane('1')];
const readingViewer = [body, app, container, layout([]), viewerPane('1')];
const splitViewer = [body, app, container, layout(['split', 'editing']), viewerPane('0.5')];

const printed = (chain: Element[], property: string) => resolve(chain, property, true);
const onScreen = (chain: Element[], property: string) => resolve(chain, property, false);

test('the preview pane a PDF is rendered from is not collapsed by edit mode', () => {
	// This is the blank page. On master `width` resolved to `0` because the
	// component's scoped rule outranks `.pane.viewer-pane`, and `opacity` had
	// no print reset at all — so even a width fix alone would have printed a
	// correctly sized blank rectangle.
	assert.equal(printed(editingViewer, 'width'), '100%');
	assert.notEqual(printed(editingViewer, 'opacity'), '0');
	assert.notEqual(printed(editingViewer, 'flex'), '0');
	assert.notEqual(printed(editingViewer, 'display'), 'none');
});

test('edit mode still hides the preview on screen', () => {
	// The print rules must reveal the pane, not disable the layout: the same
	// element on screen has to stay collapsed, or edit mode grows a second pane.
	assert.equal(onScreen(editingViewer, 'width'), '0');
	assert.equal(onScreen(editingViewer, 'opacity'), '0');
	assert.equal(onScreen(editingViewer, 'flex'), '0');
});

test('the editor itself is still kept off the page', () => {
	assert.equal(printed(editingEditor, 'display'), 'none');
	assert.notEqual(onScreen(editingEditor, 'display'), 'none');
});

test('reading mode and split view print the same single full-width pane', () => {
	// The pane carries an inline flex in both, and an inline declaration beats
	// any stylesheet rule that is not `!important`.
	for (const [name, chain] of [['reading', readingViewer], ['split', splitViewer]] as const) {
		assert.equal(printed(chain, 'width'), '100%', name);
		assert.equal(printed(chain, 'flex'), 'none', name);
		assert.notEqual(printed(chain, 'opacity'), '0', name);
	}
});

test('the reveal does not depend on which sheet the browser applies last', () => {
	// Component CSS and the app sheet are injected separately and their order
	// is not guaranteed. The resolver above already places the component last,
	// which is the losing arrangement for the print rules; assert that the
	// winning declaration is `!important` so order cannot decide it either way.
	const printBlock = sliceFrom(styles, '@media print');
	const rule = sliceBetween(printBlock, '#app .pane.viewer-pane', '}');
	for (const property of ['width', 'flex', 'opacity']) {
		assert.match(rule, new RegExp(`${property}:[^;]*!important`), `${property} must be !important`);
	}
});

// --- the content half --------------------------------------------------------
//
// `syncPreviewForPrint` lives in a Svelte component, so these are assertions
// about the component's source. They establish that the export calls it, and
// that it re-renders when the buffer has moved on. They do NOT establish that
// the resulting DOM is complete — that is what the awaited `renderRichContent`
// is for, and only a real browser can confirm it.

test('the preview is only kept live while it is on screen', () => {
	// The premise of the second half. If this condition ever widens to cover
	// plain edit mode the export-time render below becomes a no-op rather than
	// a wrong answer, so this documents the gap instead of forbidding a fix.
	assert.match(viewer, /if \(tab && \(tab\.isSplit \|\| \(isEditing && settings\.showToc\)\) && tab\.rawContent !== undefined\)/);
});

test('exporting a PDF renders the buffer before the DOM is printed', () => {
	const body_ = sliceBetween(viewer, 'async function exportAsPdf', 'function handleNewFile');
	const sync = offsetOf(body_, 'await syncPreviewForPrint()');
	// Before the diagram pass, which reads the nodes that render produces, and
	// before the print itself.
	assert.ok(sync < offsetOf(body_, 'renderDiagramsForPrint'), 'refresh before re-theming the diagrams');
	assert.ok(sync < offsetOf(body_, '_exportPdf('), 'refresh before printing');
});

test('the refresh is skipped when the DOM already matches the buffer', () => {
	const body_ = sliceBetween(viewer, 'async function syncPreviewForPrint', 'async function exportAsPdf');
	// Reading mode is rendered by loadMarkdown from this same buffer, and
	// re-rendering it would discard the scroll, fold and find state on screen.
	assert.match(body_, /if \(!tab \|\| !\(tab\.isEditing \|\| tab\.isSplit\)\) return;/);
	assert.match(body_, /previewedRawContent === rawContent\) return;/);
});

test('the refresh actually lands before the print', () => {
	const body_ = sliceBetween(viewer, 'async function syncPreviewForPrint', 'async function exportAsPdf');
	// What matters here is WHAT is rendered — this tab's buffer and this tab's
	// path, not the disk — and that it is awaited before the content is
	// swapped in. The trailing arguments are deliberately not pinned: fold
	// state is one of them and it is the renderer's business, not the
	// export's.
	assert.match(body_, /await renderMarkdownPreview\(rawContent, tab\.path[,)]/);
	assert.match(body_, /tabManager\.updateTabContent\(tabId, processed\)/);
	// Mermaid, KaTeX and highlight.js all replace nodes asynchronously. The
	// on-screen path fires and forgets; the export cannot.
	assert.match(body_, /await renderRichContent\(\)/);
	assert.equal(body_.match(/await tick\(\)/g)?.length, 2, 'flush before and after the rich pass');
});

test('a failed refresh does not pass off a stale export as a fresh one', () => {
	const body_ = sliceBetween(viewer, 'async function syncPreviewForPrint', 'async function exportAsPdf');
	// The export goes ahead on a failed refresh — printing the stale DOM beats
	// not printing — so what carries the claim in this test's name is entirely
	// the *severity* of what the user is told. `/catch \(error\)/` plus
	// `/addToast\(/` is satisfied by a catch that reports success, which is the
	// inverse of the contract: swapping the warning for
	// `addToast('Export refreshed', 'success')` left both regexes matching.
	const failure = sliceFrom(body_, 'catch (error)');
	const severities = [...failure.matchAll(/addToast\([^;]*?,\s*'([a-z]+)'\)/g)].map((match) => match[1]);
	assert.deepEqual(severities, ['warning'], 'the failed refresh must warn, not report a fresh export');
});
