/**
 * The back/forward history of ONE tab, as a value: the paths it has shown and
 * where in them it is. Deliberately not part of the store — the arithmetic
 * below (truncating the forward entries, clamping an index, refusing a move
 * that would leave the bounds) is the fiddly half of back/forward, and here it
 * can be tested for what it computes rather than for what it does to a tab.
 *
 * Every function returns the next state instead of mutating one, so the store
 * assigns exactly the two fields that changed and nothing here can reach a tab.
 * Only what a caller actually reads is returned: `goBackInHistory` and
 * `goForwardInHistory` move the index within the array they were given, so they
 * hand back an index and a path and leave `history` alone — the store used to
 * assign that array back over itself.
 */
type FileHistoryState = {
	history: string[];
	historyIndex: number;
};

type FileHistoryNavigationResult = {
	historyIndex: number;
	path: string | null;
};

export function createFileHistory(path: string): FileHistoryState {
	return {
		history: [path],
		historyIndex: 0,
	};
}

/**
 * Re-point the entry the tab is standing on — Save As and rename, which change
 * the tab's path without moving it to another document.
 *
 * Takes no `currentPath`: the entry to overwrite is the one `historyIndex`
 * names, whatever it currently holds. It used to be in the signature and never
 * destructured, and both callers passed `tab.path` AFTER assigning the new path
 * to it, so even reading it would have read the target.
 */
export function replaceCurrentHistoryEntry({
	targetPath,
	history,
	historyIndex,
}: FileHistoryState & { targetPath: string }): FileHistoryState {
	const nextHistory = history.length > 0 ? [...history] : [targetPath];
	const nextIndex = Math.max(0, Math.min(historyIndex, nextHistory.length - 1));
	nextHistory[nextIndex] = targetPath;

	return {
		history: nextHistory,
		historyIndex: nextIndex,
	};
}

export function navigateFileHistory({
	currentPath,
	targetPath,
	history,
	historyIndex,
}: FileHistoryState & { currentPath: string; targetPath: string }): FileHistoryState {
	if (currentPath === targetPath) {
		return { history, historyIndex };
	}

	const baseHistory = history.length > 0 ? history : [currentPath];
	const nextHistory = baseHistory.slice(0, historyIndex + 1);
	nextHistory.push(targetPath);

	return {
		history: nextHistory,
		historyIndex: nextHistory.length - 1,
	};
}

export function canGoBackInHistory({ historyIndex }: FileHistoryState): boolean {
	return historyIndex > 0;
}

export function canGoForwardInHistory({ history, historyIndex }: FileHistoryState): boolean {
	return historyIndex < history.length - 1;
}

export function goBackInHistory(state: FileHistoryState): FileHistoryNavigationResult {
	if (!canGoBackInHistory(state)) {
		return { historyIndex: state.historyIndex, path: null };
	}

	const historyIndex = state.historyIndex - 1;
	return {
		historyIndex,
		path: state.history[historyIndex],
	};
}

export function goForwardInHistory(state: FileHistoryState): FileHistoryNavigationResult {
	if (!canGoForwardInHistory(state)) {
		return { historyIndex: state.historyIndex, path: null };
	}

	const historyIndex = state.historyIndex + 1;
	return {
		historyIndex,
		path: state.history[historyIndex],
	};
}
