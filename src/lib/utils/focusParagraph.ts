/**
 * Focus Mode's paragraph (#819): the run of non-blank lines around `line`,
 * the way Markdown splits paragraphs. On a blank line it is that line alone.
 */
export function paragraphAround(readLine: (line: number) => string, lineCount: number, line: number): { start: number; end: number } {
	const blank = (n: number) => readLine(n).trim() === '';
	if (blank(line)) return { start: line, end: line };
	let start = line;
	let end = line;
	while (start > 1 && !blank(start - 1)) start--;
	while (end < lineCount && !blank(end + 1)) end++;
	return { start, end };
}
