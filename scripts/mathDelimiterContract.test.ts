/**
 * The cross-language math-delimiter contract — frontend half.
 *
 * Correctness of the math pipeline rests on one invariant that lives in two
 * languages at once:
 *
 *     the spans `src-tauri/src/markdown.rs` hides from comrak
 *   ≡ the spans `src/lib/utils/markdown.ts` renders with KaTeX
 *
 *   backend ⊂ frontend → comrak rewrites the formula before KaTeX ever sees
 *                        it. That is issues #174, #177 and #197.
 *   backend ⊃ frontend → the text is withheld from Markdown and then rendered
 *                        by nobody; the reader gets dead text that is neither
 *                        prose nor a formula.
 *
 * Neither side is the reference. Both are asserted against one hand-authored
 * table, `mathDelimiterCorpus.json`; the Rust half is
 * `the_backend_recognises_exactly_the_math_the_contract_lists`. Loosen a
 * condition in `findInlineMathEnd` — say, drop "a closer may not be followed
 * by a digit" — and this file goes red on its own, without anyone remembering
 * that a second implementation exists.
 *
 * Nothing here re-implements the delimiter rule. The frontend's decision is
 * read back only from artefacts the frontend itself produces: `\(…\)` and
 * `\[…\]`, which only `convertInlineMathDelimiters` emits, and
 * `data-math-source`, which only `processDisplayMathBlocks` sets. An extractor
 * that parsed `$…$` on its own could agree with a broken implementation, which
 * would defeat the point.
 *
 * Reading artefacts is only equal to reading what the *reader* sees while those
 * three are the whole of it. They were not: KaTeX's auto-renderer was also
 * given `$$` and so rendered same-line `$$…$$` straight out of comrak's output,
 * a fourth channel this extractor could not see and the corpus documented as a
 * KNOWN GAP. `\$\$x\$\$` — an escape, i.e. the reader saying "not a formula" —
 * went through it and was typeset. The last test in this file is what keeps
 * that channel closed.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
	installShimDom,
	parseHtml,
	NODE_ELEMENT,
	NODE_TEXT,
	type ShimElement,
	type ShimNode,
	type ShimText,
} from './renderProtocolDom.ts';
import { readSource } from './sourceTree.js';

installShimDom();
(globalThis as any).window = globalThis;

const { processMarkdownHtml } = await import('../src/lib/utils/markdown.ts');
const { MATH_DELIMITERS } = await import('../src/lib/utils/richContent.ts');

type ContractSpan = { kind: 'inline' | 'display'; source: string };
type ContractCase = {
	name: string;
	markdown: string;
	/** Real `convert_markdown` output; kept live by the Rust half. */
	html: string;
	math: ContractSpan[];
};

const corpus: { cases: ContractCase[] } = JSON.parse(
	readSource(new URL('./mathDelimiterCorpus.json', import.meta.url)),
);

const FILE_PATH = '/documents/notes.md';

/**
 * Only `convertInlineMathDelimiters` ever writes `\(`…`\)` or `\[`…`\]` into a
 * text node; CommonMark resolves a user-typed one away long before here.
 */
const MATH_ARTEFACT_RE = /\\\(([\s\S]*?)\\\)|\\\[([\s\S]*?)\\\]/g;

/** What the frontend decided, in document order, in the corpus's vocabulary. */
function recognisedMath(body: ShimElement): ContractSpan[] {
	const found: ContractSpan[] = [];

	const visit = (node: ShimNode): void => {
		if (node.nodeType === NODE_ELEMENT) {
			const element = node as ShimElement;
			if (element.getAttribute('data-math') === 'display') {
				found.push({ kind: 'display', source: element.getAttribute('data-math-source') ?? '' });
				return;
			}
			for (const child of [...element.childNodes]) visit(child);
			return;
		}
		if (node.nodeType === NODE_TEXT) {
			const text = (node as ShimText).nodeValue ?? '';
			MATH_ARTEFACT_RE.lastIndex = 0;
			let match: RegExpExecArray | null;
			while ((match = MATH_ARTEFACT_RE.exec(text)) !== null) {
				found.push(
					match[1] !== undefined
						? { kind: 'inline', source: match[1] }
						: { kind: 'display', source: match[2] },
				);
			}
		}
	};

	for (const child of [...body.childNodes]) visit(child);
	return found;
}

test('the frontend renders exactly the math the contract lists', () => {
	for (const testCase of corpus.cases) {
		const body = parseHtml(processMarkdownHtml(testCase.html, FILE_PATH, new Set())).body;
		assert.deepEqual(
			recognisedMath(body),
			testCase.math,
			`${testCase.name}: the frontend and the contract disagree about what is math\n` +
				`  input: ${JSON.stringify(testCase.markdown)}`,
		);
	}
});

test('the corpus covers both directions of the invariant', () => {
	// A corpus of nothing but negatives would stay green under an
	// implementation that recognises no math at all, and a corpus of nothing
	// but positives would stay green under one that recognises everything.
	const negatives = corpus.cases.filter((one) => one.math.length === 0);
	const positives = corpus.cases.filter((one) => one.math.length > 0);
	assert.ok(negatives.length >= 10, `only ${negatives.length} must-not-be-math cases`);
	assert.ok(positives.length >= 10, `only ${positives.length} must-be-math cases`);
	assert.ok(
		positives.some((one) => one.math.some((span) => span.kind === 'display')),
		'no display-math case',
	);
	assert.ok(
		positives.some((one) => one.math.some((span) => span.kind === 'inline')),
		'no inline-math case',
	);
});

test('KaTeX is given no delimiter that Markdown itself can spell', () => {
	// The test above reads the frontend's decision off the artefacts
	// `processMarkdownHtml` mints. That is only the same thing as "what the
	// reader sees" while KaTeX's auto-renderer looks for nothing else. Give it
	// `$$` back and same-line `$$…$$` is rendered straight out of comrak's
	// output — including the `$$` that comrak produced *by resolving the
	// reader's `\$\$`* — through a channel the extractor cannot see and the
	// contract therefore cannot police.
	assert.ok(MATH_DELIMITERS.length > 0, 'no delimiters at all');
	for (const delimiter of MATH_DELIMITERS) {
		for (const side of [delimiter.left, delimiter.right]) {
			assert.ok(
				side.startsWith('\\'),
				`KaTeX may only be given delimiters processMarkdownHtml mints, not ${JSON.stringify(side)}`,
			);
		}
	}
});
