import type { Tab } from '../stores/tabs.svelte.js';
import { isHomePath } from '../utils/homeTab.js';
import { snapshotTab, validateTransferPayload, type TransferableTab } from '../utils/tabTransfer.js';

type PersistedEditor = TransferableTab & { isTruncated?: boolean };

/** Only what a close would otherwise ask about: dirty buffers and non-empty
 * untitled text. Clean files reopen from disk through the session restore.
 * Partial reads carry their guard so they never restore as complete documents. */
export function recoverySnapshot(tabs: readonly Tab[]): string {
	return JSON.stringify(tabs
		.filter((tab) => !isHomePath(tab.path) && (tab.isDirty || (tab.path === '' && tab.rawContent !== '')))
		.map((tab) => ({ ...snapshotTab(tab), ...(tab.isTruncated ? { isTruncated: true } : {}) })));
}

export function parseRecovery(json: string): PersistedEditor[] {
	const value: unknown = JSON.parse(json);
	if (!Array.isArray(value)) throw new Error('Invalid recovery snapshot');
	return value.map((entry) => {
		const tab = validateTransferPayload(JSON.stringify(entry));
		if (!tab || isHomePath(tab.path) || (entry.isTruncated !== undefined && typeof entry.isTruncated !== 'boolean')) {
			throw new Error('Invalid recovery document');
		}
		return { ...tab, ...(entry.isTruncated ? { isTruncated: true } : {}) };
	});
}

type RecoveryTarget = {
	tabs: Tab[];
	closeTab: (id: string) => void;
	insertTransferredTab: (snapshot: TransferableTab) => string;
};

/** Restore over clean session tabs only; never merge two unsaved buffers. The
 * saved baseline travels too, so a save still meets the external-change check. */
function restoreRecoveryTabs(manager: RecoveryTarget, json: string) {
	// Validate the entire record before changing any tabs.
	for (const snapshot of parseRecovery(json)) {
		const existing = snapshot.path
			? manager.tabs.find((tab) => tab.path === snapshot.path && !tab.isDirty)
			: undefined;
		if (existing) manager.closeTab(existing.id);
		// Editor-first keeps potentially pathological preview input out of startup.
		const id = manager.insertTransferredTab({ ...snapshot, isEditing: true, isSplit: false });
		const tab = manager.tabs.find((tab) => tab.id === id);
		if (tab && snapshot.isTruncated) tab.isTruncated = true;
	}
}

/** Restore the records of windows that are gone and return the other labels consumed.
 * A corrupt record of another window is reported and left on disk. A corrupt
 * record of this window throws: the caller must not overwrite it. */
export function restoreRecords(
	manager: RecoveryTarget,
	records: readonly [string, string][],
	live: ReadonlySet<string>,
	ownLabel: string,
	onError: (error: unknown) => void,
): string[] {
	const consumed: string[] = [];
	for (const [label, json] of records) {
		if (live.has(label)) continue;
		try {
			restoreRecoveryTabs(manager, json);
		} catch (error) {
			if (label === ownLabel) throw error;
			onError(error);
			continue;
		}
		// This window's own record is replaced by its next write, not removed.
		if (label !== ownLabel) consumed.push(label);
	}
	return consumed;
}

/** One writer per window. A bounded delay, not a resetting debounce: continuous
 * typing must still reach disk. Serialized writes prevent an older IPC from
 * resurrecting content after a save, discard, or setting change. */
export function createUnsavedRecovery(options: {
	write: (json: string) => Promise<void>;
	onError: (error: unknown) => void;
}) {
	let latest = '[]';
	let timer: ReturnType<typeof setTimeout> | undefined;
	let writes = Promise.resolve(true);
	let disposed = false;

	function schedule(delay: number) {
		if (timer || disposed) return;
		timer = setTimeout(() => {
			timer = undefined;
			void enqueue(latest);
		}, delay);
	}

	function enqueue(json: string): Promise<boolean> {
		writes = writes.then(async () => {
			try {
				await options.write(json);
				return true;
			} catch (error) {
				options.onError(error);
				// Retry even if the user stopped typing, including failed cleanup.
				if (json === latest) schedule(2000);
				return false;
			}
		});
		return writes;
	}

	function update(json: string) {
		if (disposed || json === latest) return;
		latest = json;
		schedule(500);
	}

	function flush(json = latest): Promise<boolean> {
		if (timer) clearTimeout(timer);
		timer = undefined;
		latest = json;
		return enqueue(json);
	}

	function dispose() {
		disposed = true;
		if (timer) clearTimeout(timer);
	}

	return { update, flush, dispose };
}
