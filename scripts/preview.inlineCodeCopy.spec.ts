import { afterEach, describe, expect, test, vi } from 'vitest';
import {
	flashInlineCodeCopied,
	handleInlineCodeCopyClick,
	INLINE_CODE_COPIED_CLASS,
	inlineCodeCopyTarget,
} from '../src/lib/utils/inlineCodeCopy.js';

/**
 * Inline code's copy badge is a pseudo-element, so a click on it arrives as a
 * click on the `<code>`; where it landed is what decides. jsdom lays nothing
 * out, so each code span is given the box a browser would: one line at
 * y 100–120, x 50–150. The badge sits against its right edge, past x 150.
 */
function codeIn(html: string, selector = 'code'): HTMLElement {
	const article = document.createElement('article');
	article.innerHTML = html;
	document.body.replaceChildren(article);
	const code = article.querySelector(selector) as HTMLElement;
	const box = { top: 100, bottom: 120, left: 50, right: 150, width: 100, height: 20, x: 50, y: 100 };
	const rect = { ...box, toJSON: () => box } as DOMRect;
	code.getBoundingClientRect = () => rect;
	code.getClientRects = () => [rect] as unknown as DOMRectList;
	return code;
}

const BADGE = { x: 165, y: 110 };
const TEXT = { x: 100, y: 110 };

describe('inline code copy badge hit test', () => {
	test('a click to the right of the code, on its own line, is the badge', () => {
		const code = codeIn('<p>run <code>npm test</code> first</p>');
		expect(inlineCodeCopyTarget(code, BADGE.x, BADGE.y)).toBe(code);
	});

	test('a click on the code\'s own text is not', () => {
		const code = codeIn('<p>run <code>npm test</code> first</p>');
		expect(inlineCodeCopyTarget(code, TEXT.x, TEXT.y)).toBeNull();
	});

	test('a click on the code\'s very edge is still the text, not the badge', () => {
		const code = codeIn('<p>run <code>npm test</code> first</p>');
		expect(inlineCodeCopyTarget(code, 150, 110)).toBeNull();
	});

	test('wrapped code: a click on its second line is text, past either line is the badge', () => {
		const code = codeIn('<p>run <code>a very long command</code> first</p>');
		const line = (top: number, left: number, right: number) =>
			({ top, bottom: top + 20, left, right, width: right - left, height: 20, x: left, y: top }) as DOMRect;
		code.getClientRects = () => [line(100, 300, 400), line(124, 0, 80)] as unknown as DOMRectList;
		expect(inlineCodeCopyTarget(code, 40, 130)).toBeNull();
		expect(inlineCodeCopyTarget(code, 95, 130)).toBe(code);
	});

	test('code in a fenced block is left to its own copy label', () => {
		const code = codeIn('<pre><code>npm test</code></pre>');
		expect(inlineCodeCopyTarget(code, BADGE.x, BADGE.y)).toBeNull();
	});

	test('code inside a link is left to the link', () => {
		const code = codeIn('<p><a href="#x"><code>npm test</code></a></p>');
		expect(inlineCodeCopyTarget(code, BADGE.x, BADGE.y)).toBeNull();
	});

	test('a click on something that is not code is not', () => {
		codeIn('<p>run <code>npm test</code> first</p>');
		expect(inlineCodeCopyTarget(document.querySelector('p'), BADGE.x, BADGE.y)).toBeNull();
	});
});

describe('inline code copy click', () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	function click(target: Element, at: { x: number; y: number }): MouseEvent {
		const event = new MouseEvent('click', { bubbles: true, cancelable: true, clientX: at.x, clientY: at.y });
		Object.defineProperty(event, 'target', { value: target });
		return event;
	}

	test('a badge click copies the code\'s text and claims the click', async () => {
		const code = codeIn('<p>run <code>npm test</code> first</p>');
		const copied: string[] = [];
		const event = click(code, BADGE);
		expect(handleInlineCodeCopyClick(event, async (text) => copied.push(text))).toBe(true);
		expect(event.defaultPrevented).toBe(true);
		await Promise.resolve();
		expect(copied).toEqual(['npm test']);
	});

	test('a click on the text copies nothing and leaves the click alone', () => {
		const code = codeIn('<p>run <code>npm test</code> first</p>');
		const copy = vi.fn(async () => {});
		const event = click(code, TEXT);
		expect(handleInlineCodeCopyClick(event, copy)).toBe(false);
		expect(event.defaultPrevented).toBe(false);
		expect(copy).not.toHaveBeenCalled();
	});

	test('the badge reads "Copied!" for 1.5 s, restarted by a second copy', () => {
		vi.useFakeTimers();
		const code = codeIn('<p><code>npm test</code></p>');

		flashInlineCodeCopied(code);
		expect(code.classList.contains(INLINE_CODE_COPIED_CLASS)).toBe(true);
		vi.advanceTimersByTime(1000);
		flashInlineCodeCopied(code);
		vi.advanceTimersByTime(1000);
		expect(code.classList.contains(INLINE_CODE_COPIED_CLASS)).toBe(true);
		vi.advanceTimersByTime(500);
		expect(code.classList.contains(INLINE_CODE_COPIED_CLASS)).toBe(false);
	});
});
