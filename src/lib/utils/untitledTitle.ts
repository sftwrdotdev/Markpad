/**
 * Numbered titles for untitled tabs ("Untitled 1", "Untitled 2", …).
 *
 * Distinct titles let any UI that names a tab — the tab strip, and especially
 * the per-tab unsaved-changes dialog at window close — tell the user which tab
 * it is talking about.
 * The smallest free number is reused, matching common editor behavior.
 */
export function nextUntitledTitle(existingTitles: readonly string[], base: string): string {
	const used = new Set<number>();
	for (const title of existingTitles) {
		if (title === base) {
			// A legacy unnumbered tab occupies slot 1.
			used.add(1);
			continue;
		}
		if (!title.startsWith(base + ' ')) continue;
		const suffix = title.slice(base.length + 1);
		if (/^[1-9][0-9]*$/.test(suffix)) used.add(Number(suffix));
	}
	let n = 1;
	while (used.has(n)) n++;
	return `${base} ${n}`;
}
