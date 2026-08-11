import type { Tab } from '../stores/tabs.svelte.js';
import { nextUntitledTitle } from './untitledTitle.js';

/**
 * Cross-window tab transfer: a tab is snapshotted in the source window,
 * carried through the Rust broker as JSON, and rebuilt in the destination.
 *
 * This snapshot is deliberately INDEPENDENT of TabManager.serializeState()
 * (localStorage `savedTabsDataV2`), which persists window shape only and
 * never carries content. A transferred tab, by contrast, MUST carry its
 * unsaved buffer — rawContent/originalContent/isDirty travel with it, so a
 * dirty tab arrives dirty and nothing is lost or silently "cleaned".
 *
 * Excluded on purpose:
 * - `content` (rendered HTML): regenerated at the destination.
 * - `editorViewState`: a live Monaco object, not serializable.
 * - `collapsedHeaders`: the destination re-renders the document from source,
 *   and it re-renders it with everything open. Before fold state was per tab
 *   the arriving document inherited whatever the DESTINATION window happened
 *   to have folded, which is the bleed this field exists to stop; starting
 *   open is the honest version of "this was rendered fresh here". Carrying it
 *   would mean a new required entry in the strict validator below, which is a
 *   change to make on its own terms.
 */
export interface TransferableTab {
	path: string;
	title: string;
	rawContent: string;
	originalContent: string;
	/**
	 * Redundant with the two buffers above, and kept anyway: it is the wire
	 * format, the strict validator on the receiving side requires it, and the
	 * window on the other end of the broker can be running an older build that
	 * still reads it. `buildTransferredTab` derives its own answer.
	 */
	isDirty: boolean;
	isEditing: boolean;
	isSplit: boolean;
	isScrollSynced: boolean;
	/**
	 * Travels with the buffer because the guard it feeds is about the buffer,
	 * not about the window: a tab whose text was decoded with U+FFFD
	 * substitutions must keep refusing to overwrite its source file after it
	 * moves. Dropping it here would hand the destination window a buffer that
	 * looks safe to save. See `Tab.hasReplacementChars`.
	 */
	hasReplacementChars: boolean;
	/**
	 * Travels for the same reason and with the same consequence: the buffer is
	 * a decode of a file in this encoding, and a destination window that
	 * defaulted to UTF-8 would rewrite the user's GBK document the first time
	 * it auto-saved after the move.
	 */
	encoding: string;
	splitRatio: number;
	scrollTop: number;
	scrollPercentage: number;
	anchorLine: number;
	historyIndex: number;
	history: string[];
}

const STRING_FIELDS = ['path', 'title', 'rawContent', 'originalContent', 'encoding'] as const;
const BOOLEAN_FIELDS = [
	'isDirty',
	'isEditing',
	'isSplit',
	'isScrollSynced',
	'hasReplacementChars',
] as const;
const NUMBER_FIELDS = [
	'splitRatio',
	'scrollTop',
	'scrollPercentage',
	'anchorLine',
	'historyIndex',
] as const;

/** Copy the transferable fields of a tab. Never mutates the source. */
export function snapshotTab(tab: Tab): TransferableTab {
	return {
		path: tab.path,
		title: tab.title,
		rawContent: tab.rawContent,
		originalContent: tab.originalContent,
		isDirty: tab.isDirty,
		isEditing: tab.isEditing,
		isSplit: tab.isSplit,
		isScrollSynced: tab.isScrollSynced,
		hasReplacementChars: tab.hasReplacementChars,
		encoding: tab.encoding,
		splitRatio: tab.splitRatio,
		scrollTop: tab.scrollTop,
		scrollPercentage: tab.scrollPercentage,
		anchorLine: tab.anchorLine,
		historyIndex: tab.historyIndex,
		history: [...tab.history],
	};
}

/**
 * Parse and STRICTLY validate a transfer payload. Every field must have
 * exactly the declared type — no coercion, no defaults. A payload that is
 * even slightly off is rejected (null) rather than patched up: a past bug
 * built tabs whose rawContent was undefined, the editor attributed a stale
 * buffer to them, and auto-save then destroyed real files.
 */
export function validateTransferPayload(json: string): TransferableTab | null {
	let data: unknown;
	try {
		data = JSON.parse(json);
	} catch {
		return null;
	}
	if (typeof data !== 'object' || data === null || Array.isArray(data)) return null;
	const obj = data as Record<string, unknown>;

	for (const field of STRING_FIELDS) {
		if (typeof obj[field] !== 'string') return null;
	}
	for (const field of BOOLEAN_FIELDS) {
		if (typeof obj[field] !== 'boolean') return null;
	}
	for (const field of NUMBER_FIELDS) {
		const value = obj[field];
		if (typeof value !== 'number' || !Number.isFinite(value)) return null;
	}
	const history = obj.history;
	if (!Array.isArray(history)) return null;
	for (const entry of history) {
		if (typeof entry !== 'string') return null;
	}

	// Rebuild explicitly so unknown extra fields are dropped.
	return {
		path: obj.path as string,
		title: obj.title as string,
		rawContent: obj.rawContent as string,
		originalContent: obj.originalContent as string,
		isDirty: obj.isDirty as boolean,
		isEditing: obj.isEditing as boolean,
		isSplit: obj.isSplit as boolean,
		isScrollSynced: obj.isScrollSynced as boolean,
		hasReplacementChars: obj.hasReplacementChars as boolean,
		encoding: obj.encoding as string,
		splitRatio: obj.splitRatio as number,
		scrollTop: obj.scrollTop as number,
		scrollPercentage: obj.scrollPercentage as number,
		anchorLine: obj.anchorLine as number,
		historyIndex: obj.historyIndex as number,
		history: [...history] as string[],
	};
}

/**
 * Title for a transferred tab in its destination window. The title is the
 * document's identity, so movement keeps it whenever possible: an untitled
 * tab (path === '') is re-numbered ONLY when the destination already has a
 * tab with that exact title — impossible for a fresh detach window, only
 * reachable by a future move-to-existing-window. Numbering exists to
 * disambiguate a window's own close dialogs; cross-window duplicate titles
 * are the status quo for file tabs (two folders' notes.md) and are fine.
 */
export function transferredTabTitle(
	snap: TransferableTab,
	existingTitles: readonly string[],
	untitledBase: string,
): string {
	if (snap.path === '' && existingTitles.includes(snap.title)) {
		return nextUntitledTitle(existingTitles, untitledBase);
	}
	return snap.title;
}

/**
 * Build a full Tab for the destination window from a validated snapshot.
 * Pure aside from crypto.randomUUID(); TabManager.insertTransferredTab is a
 * thin wrapper that pushes the result and activates it. Rendered `content`
 * starts empty (the caller re-renders) and editorViewState starts null.
 */
export function buildTransferredTab(
	snap: TransferableTab,
	existingTitles: readonly string[],
	untitledBase: string,
): Tab {
	return {
		id: crypto.randomUUID(),
		path: snap.path,
		title: transferredTabTitle(snap, existingTitles, untitledBase),
		content: '',
		rawContent: snap.rawContent,
		originalContent: snap.originalContent,
		scrollTop: snap.scrollTop,
		// Recomputed from the two buffers that just arrived, not copied from
		// `snap.isDirty`: the payload can only be believed about what it
		// carries, and the answer is a function of what it carries. The wire
		// field stays — see `TransferableTab.isDirty`.
		get isDirty() {
			return this.rawContent !== this.originalContent;
		},
		isEditing: snap.isEditing,
		history: [...snap.history],
		historyIndex: snap.historyIndex,
		editorViewState: null,
		scrollPercentage: snap.scrollPercentage,
		anchorLine: snap.anchorLine,
		isSplit: snap.isSplit,
		splitRatio: snap.splitRatio,
		isScrollSynced: snap.isScrollSynced,
		collapsedHeaders: new Set<string>(),
		hasReplacementChars: snap.hasReplacementChars,
		encoding: snap.encoding,
	};
}
