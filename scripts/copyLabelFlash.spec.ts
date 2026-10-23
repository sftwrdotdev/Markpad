/**
 * Clicking a code block's Copy label twice within 1.5 s left it reading
 * "Copied!" for good: the second click saved "Copied!" as the label to restore.
 */

import { afterEach, expect, test, vi } from 'vitest';

import { flashCopiedLabel } from '../src/lib/utils/richContent.js';

afterEach(() => {
	vi.useRealTimers();
});

test('a second copy inside the 1.5 s still restores the language name', () => {
	vi.useFakeTimers();
	const label = document.createElement('button');
	label.textContent = 'typescript';

	flashCopiedLabel(label);
	vi.advanceTimersByTime(500);
	flashCopiedLabel(label);
	expect(label.innerHTML).toBe('Copied!');

	vi.advanceTimersByTime(1500);
	expect(label.innerHTML).toBe('typescript');
	expect(label.classList.contains('copied')).toBe(false);

	// And the label still works after that.
	flashCopiedLabel(label);
	expect(label.innerHTML).toBe('Copied!');
	vi.advanceTimersByTime(1500);
	expect(label.innerHTML).toBe('typescript');
});
