import { hasRealFilePath } from './tabFileActions.js';

/**
 * The folder suffix a tab needs in order to be told apart from another tab
 * holding a different file of the same name (#727).
 *
 * Two tabs on `…/skills/alpha/SKILL.md` and `…/skills/beta/SKILL.md` both read
 * `SKILL.md`, and the tab strip is the one surface where the path is not
 * already on screen. The suffix is the smallest amount of path that answers
 * "which one is this" — the containing folder, and only when the name is
 * actually ambiguous.
 *
 * WHY THE DEPTH GROWS. The containing folder alone is not always an answer:
 * `docs/api/README.md` and `packages/api/README.md` would both read `api`,
 * which is the original problem with a longer label. So a suffix that is still
 * shared is extended by one more folder, and only for the tabs that share it —
 * a sibling that was already unambiguous keeps its one-folder suffix rather
 * than growing in sympathy. Two paths cannot share every folder, because
 * `TabManager.claimPath` makes a file path exclusive to one tab, so the growth
 * terminates on distinct labels; the guard against a path simply running out
 * of folders is there for the file at a filesystem root.
 *
 * WHAT IT IS NOT. Not VS Code's `shorten()`, which picks the shortest
 * DISTINGUISHING segments anywhere in the path and elides the rest with `…`.
 * That reads as a path fragment; this reads as a folder name, which is what
 * the tab strip has room for and what a reader is looking for.
 */

/** Path separators, both of them, because a Windows path uses `\`. */
function splitPath(path: string): string[] {
	return path.split(/[/\\]/).filter((segment) => segment !== '');
}

/**
 * The separator to render a multi-folder suffix with — the one the path itself
 * is spelled in, so a Windows user is not shown a path shape they never see.
 */
function separatorOf(path: string): string {
	return path.includes('\\') ? '\\' : '/';
}

/**
 * Folder suffixes by tab id, holding only the tabs that need one.
 *
 * Tabs without a real file path — untitled buffers, the home tab — are not
 * considered: they are not files, several untitled tabs are normal, and
 * numbering already tells those apart.
 */
export function duplicateNameSuffixes(tabs: readonly { id: string; path: string }[]): Map<string, string> {
	const files = tabs
		.filter((tab) => hasRealFilePath(tab.path))
		.map((tab) => {
			const segments = splitPath(tab.path);
			return {
				id: tab.id,
				folders: segments.slice(0, -1),
				name: segments[segments.length - 1] ?? '',
				separator: separatorOf(tab.path),
				depth: 0,
			};
		});

	type Entry = (typeof files)[number];

	const label = (file: Entry) => file.folders.slice(file.folders.length - file.depth).join(file.separator);

	const groupBy = (entries: Entry[], key: (file: Entry) => string): Entry[][] => {
		const buckets = new Map<string, Entry[]>();
		for (const entry of entries) {
			const bucket = buckets.get(key(entry));
			if (bucket) bucket.push(entry);
			else buckets.set(key(entry), [entry]);
		}
		return [...buckets.values()];
	};

	// Same file name is what makes a tab ambiguous; everything below works
	// within one such group, one folder deeper at a time.
	const pending = groupBy(files, (file) => file.name).filter((group) => group.length > 1);
	while (pending.length > 0) {
		const group = pending.pop()!;
		const growable = group.filter((file) => file.depth < file.folders.length);
		// Nothing left to say about these paths. Reachable only for a file at a
		// filesystem root, which has no folder to name.
		if (growable.length === 0) continue;
		for (const file of growable) file.depth++;
		pending.push(...groupBy(group, label).filter((bucket) => bucket.length > 1));
	}

	return new Map(files.filter((file) => file.depth > 0).map((file) => [file.id, label(file)]));
}
