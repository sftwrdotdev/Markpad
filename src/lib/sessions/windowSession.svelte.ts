import { invoke } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { tabManager } from '../stores/tabs.svelte.js';
import { hasRealFilePath } from '../utils/tabFileActions.js';
import { validateTransferPayload, type TransferableTab } from '../utils/tabTransfer.js';

type RestoredTab = {
	id: string;
	path: string;
};

/**
 * The breadcrumb a restore pass leaves behind so the next launch knows what
 * happened to the last one. It exists because a restore that never returns —
 * the renderer dies on one pathological document — otherwise repeats forever.
 *
 * It names the document being restored, not just the fact that a restore was
 * running: blaming the whole session for one file is what made an interrupted
 * restore delete every tab the user had open.
 */
type RestoreProgress = {
	/** Set while a pass is running. Still set at startup means it never finished. */
	running: boolean;
	/** The document the pass was on. The suspect if the pass never finished. */
	pending: string | null;
	/** Documents blamed for an earlier interruption; not read at startup. */
	deferred: string[];
	/** Consecutive interrupted launches; reset by a pass that finishes. */
	interruptions: number;
};

/**
 * What an interrupted launch has to tell the user.
 *
 * Not a sentence: this module has no language, and Markpad ships 26 locales.
 * It reports what happened and the UI decides how to say it — the same event
 * also goes to `onWarning`, which stays detailed and English because its
 * destination is a developer console.
 */
export type RestoreInterruption = {
	/** The document the dead launch was reading, if it got far enough to name one. */
	deferredPath: string | null;
};

/** Enough to keep the suspects, few enough to stay a breadcrumb. */
const MAX_DEFERRED = 8;

/**
 * After this many launches interrupted in a row, startup stops reading
 * documents altogether and restores the tabs alone. Skipping one more document
 * per launch does terminate, but it spends one crash per document to get there;
 * three is enough to tell "this file is poison" from "the user quit during
 * startup", and a session that opens without reading anything still hands back
 * every tab, each one re-readable on demand.
 */
const MAX_INTERRUPTIONS = 3;

type WindowSessionOptions = {
	isMainWindow: boolean;
	windowStateKey: string;
	legacyStateKey: string;
	restoreInProgressKey: string;
	serializeState: () => string;
	shouldRestoreState: () => boolean;
	isDisposed: () => boolean;
	restoreState: (json: string) => void;
	restoredTabs: () => RestoredTab[];
	applyRestoredContent: (tabId: string, raw: string) => Promise<void>;
	dropRestoredTab: (tabId: string) => void;
	canTransfer: (tabId: string) => boolean;
	canDetach: (tabId: string) => boolean;
	transferPayload: (tabId: string) => string;
	onTransferClaimed: (tabId: string) => void;
	acceptTransferredTab: (tab: TransferableTab) => Promise<boolean>;
	onError: (message: string, error: unknown) => void;
	onWarning: (message: string, error?: unknown) => void;
	/**
	 * Called once, at startup, when the previous launch did not finish. This is
	 * the mechanism's own diagnosis of "why did Markpad come back without my
	 * documents"; routing it anywhere the user cannot see leaves the answer
	 * written where nobody can read it.
	 */
	onInterrupted: (interruption: RestoreInterruption) => void;
};

export function createWindowSession(options: WindowSessionOptions) {
	const appWindow = getCurrentWindow();

	async function discardPersistedState() {
		localStorage.removeItem(options.windowStateKey);
		localStorage.removeItem(options.legacyStateKey);
		if (!options.isMainWindow) return;
		try {
			await invoke('clear_window_state');
		} catch (error) {
			options.onError('Failed to clear window state', error);
		}
	}

	/**
	 * The breadcrumb is written through Rust, for the reason the snapshot is
	 * (see `persistWindowState` in MarkdownViewer): `setItem` is an async
	 * message to the WebKit storage process, and the abnormal termination this
	 * record exists to survive is exactly the event that loses messages in
	 * flight. It was the one piece of state whose whole job is to outlive a
	 * kill, kept in the store this codebase had already proved does not.
	 *
	 * `restoreInProgressKey` stays as a read-once migration path: a breadcrumb
	 * an older build left behind is still honoured, and dropped as soon as a
	 * Rust write succeeds. The Rust file wins when both exist, so a downgrade
	 * and re-upgrade cannot resurrect a stale localStorage record.
	 */
	async function readProgress(): Promise<RestoreProgress | null> {
		const raw =
			((await invoke('load_restore_progress').catch(() => null)) as string | null) ??
			localStorage.getItem(options.restoreInProgressKey);
		if (!raw) return null;
		try {
			const data = JSON.parse(raw) as Partial<RestoreProgress> | null;
			if (!data || typeof data !== 'object') throw new Error('not a progress record');
			const deferred = Array.isArray(data.deferred)
				? data.deferred.filter((path): path is string => typeof path === 'string' && path !== '')
				: [];
			return {
				running: data.running === true,
				pending: typeof data.pending === 'string' && data.pending !== '' ? data.pending : null,
				deferred: deferred.slice(-MAX_DEFERRED),
				interruptions: typeof data.interruptions === 'number' && data.interruptions > 0 ? Math.floor(data.interruptions) : 0,
			};
		} catch {
			// Older builds wrote the string `'true'`. It still means the previous
			// pass never finished, it just names no suspect — so it counts as one
			// interruption and defers nothing.
			return { running: true, pending: null, deferred: [], interruptions: 0 };
		}
	}

	async function writeProgress(progress: RestoreProgress) {
		// A finished pass with nothing deferred leaves no breadcrumb at all,
		// which is what keeps the record absent in the ordinary case.
		const clearing = !progress.running && progress.deferred.length === 0;
		try {
			if (clearing) await invoke('clear_restore_progress');
			else await invoke('save_restore_progress', { json: JSON.stringify(progress) });
		} catch (error) {
			// No localStorage fallback on purpose: two copies that can disagree
			// is how a stale record gets preferred over a fresh one. A backend
			// that cannot write this cannot write the snapshot either, and that
			// failure is already reported at close.
			options.onWarning('Failed to record session restore progress', error);
			return;
		}
		// Only once the durable copy is in place, so a build that cannot reach
		// the backend keeps whatever the previous one left behind.
		localStorage.removeItem(options.restoreInProgressKey);
	}

	/**
	 * A deferred document is released as soon as Markpad has read it once — the
	 * user opened it by hand and nothing went wrong, so the file is not the
	 * problem (or is not any more). Without this the deferral is permanent and
	 * one bad startup would cost the user automatic restore of that document
	 * forever.
	 */
	async function releaseReadableDeferrals() {
		const progress = await readProgress();
		if (!progress || progress.deferred.length === 0) return;
		const readable = new Set(
			tabManager.tabs.filter((tab) => tab.isTruncated !== true && tab.rawContent !== '').map((tab) => tab.path),
		);
		const deferred = progress.deferred.filter((path) => !readable.has(path));
		if (deferred.length === progress.deferred.length) return;
		await writeProgress({ ...progress, deferred });
	}

	async function persistState() {
		if (!options.isMainWindow) return;
		await releaseReadableDeferrals();
		try {
			await invoke('save_window_state', { json: options.serializeState() });
			localStorage.removeItem(options.windowStateKey);
			localStorage.removeItem(options.legacyStateKey);
		} catch (error) {
			options.onError('Failed to save window state on close', error);
		}
	}

	async function restore() {
		if (!options.isMainWindow || options.isDisposed()) return;
		if (!options.shouldRestoreState()) {
			// Through `discardPersistedState`, because the snapshot is a file on
			// the Rust side now. This branch is what makes turning the setting off
			// end the session, and while the snapshot lived in localStorage the two
			// `removeItem` calls did exactly that. Once it moved they went on
			// clearing keys nothing writes any more, and the list of every document
			// the user had open stayed on disk — for the user who switched the
			// setting off to stop it being kept.
			await discardPersistedState();
			// Nothing will be restored, so there is nothing for a breadcrumb to
			// say about the next launch.
			await writeProgress({ running: false, pending: null, deferred: [], interruptions: 0 });
			return;
		}
		const previous = await readProgress();
		const deferred = previous ? [...previous.deferred] : [];
		let interruptions = previous?.interruptions ?? 0;
		if (previous?.running) {
			// The last pass never finished. Defer the one document it was on
			// rather than the session it was part of.
			interruptions += 1;
			if (previous.pending && !deferred.includes(previous.pending)) {
				deferred.push(previous.pending);
				while (deferred.length > MAX_DEFERRED) deferred.shift();
			}
			options.onWarning(
				previous.pending
					? `Markpad session restore was interrupted; deferring ${previous.pending}`
					: 'Markpad session restore was interrupted with no document to blame',
			);
			options.onInterrupted({ deferredPath: previous.pending });
		}
		// Nothing here is allowed to delete the snapshot: a restore that goes
		// wrong must cost the user at most the automatic reopening of a
		// document, never the record of which documents were open.
		const deferAll = interruptions >= MAX_INTERRUPTIONS;

		// Claim the launch before the snapshot is loaded, not after.
		//
		// The snapshot lives on the Rust side — `persistState` moves it there
		// and drops the localStorage copies — so reading it is an IPC round
		// trip. Claiming afterwards left that round trip, and everything before
		// it, outside the window this mechanism can see: a launch killed in
		// there leaves no trace, so the next one starts from zero and walks
		// into the same startup again, and the give-up counter that is supposed
		// to end the loop never advances.
		//
		// Claiming early can leave a breadcrumb for a launch that turns out to
		// have no snapshot at all. That costs one phantom interruption, and the
		// `else` branch below clears it on the next launch; being wrong in that
		// direction costs nothing, being wrong in the other costs a relaunch.
		const progress: RestoreProgress = { running: true, pending: null, deferred, interruptions };
		await writeProgress(progress);

		const savedData =
			localStorage.getItem(options.windowStateKey) ??
			localStorage.getItem(options.legacyStateKey) ??
			((await invoke('load_window_state').catch(() => null)) as string | null);
		if (savedData) {
			try {
				options.restoreState(savedData);
				for (const tab of options.restoredTabs()) {
					// The home screen is not a document. Snapshots from builds that
					// wrote its `HOME_TAB_PATH` sentinel must not turn into a read
					// of a file by that name — and unlike a file that merely failed
					// to read, there is nothing here to come back to later.
					if (!hasRealFilePath(tab.path)) {
						options.dropRestoredTab(tab.id);
						continue;
					}
					if (deferAll || deferred.includes(tab.path)) {
						tabManager.markTabContentUnavailable(tab.id);
						continue;
					}
					progress.pending = tab.path;
					// Awaited: the record has to be on disk before the read it
					// describes starts, or the launch this read kills is the one
					// that leaves nothing behind.
					await writeProgress(progress);
					try {
						// `_checked`, because restore fills an editable buffer, and
						// both of its answers belong to the tab: `lossy` so a file
						// nothing could decode is never written back over, and the
						// encoding so a legacy one is written back as itself.
						// Without this, reopening the app laundered them away and
						// the next auto-save destroyed or converted the document.
						const [raw, lossy, encoding] = (await invoke('read_file_content_checked', { path: tab.path })) as [string, boolean, string];
						if (options.isDisposed()) return;
						await options.applyRestoredContent(tab.id, raw);
						tabManager.setTabDecodedLossy(tab.id, lossy);
						tabManager.setTabEncoding(tab.id, encoding);
						if (options.isDisposed()) return;
					} catch (error) {
						if (options.isDisposed()) return;
						// One failed read is not a decision to close the document.
						// The file may be on a share that is down or a drive that is
						// not plugged in; dropping the tab here also dropped it from
						// the snapshot written moments later, so it never came back.
						options.onWarning('Restore: keeping tab whose file could not be read', error);
						tabManager.markTabContentUnavailable(tab.id);
					}
					progress.pending = null;
					await writeProgress(progress);
				}
				// The pass got to the end, so whatever interrupted the previous
				// launches is behind us; only the deferrals stay.
				interruptions = 0;
			} catch (error) {
				options.onError('Failed to restore Markpad session', error);
			} finally {
				await writeProgress({ running: false, pending: null, deferred, interruptions });
			}
		} else {
			// No snapshot to read: a breadcrumb left by an earlier launch has
			// nothing left to describe, and leaving it would count as another
			// interruption next time. This is also what retires the claim the
			// launch above staked before it knew whether there was anything to
			// restore, so claiming early cannot accumulate phantom strikes.
			await writeProgress({ running: false, pending: null, deferred, interruptions: 0 });
		}
		if (options.isDisposed()) return;
		if (options.restoredTabs().length > 0) await persistState();
		localStorage.removeItem(options.windowStateKey);
		localStorage.removeItem(options.legacyStateKey);
	}

	/**
	 * Hand the claim back so the source can recover its tab. A claimed
	 * transfer is deliberately immune to the source's timeout — otherwise a
	 * slow render would race it — which means the destination is the only
	 * party that can end a claim it cannot finish. Skipping this is what
	 * left the tab present in both windows.
	 */
	async function releaseClaim(token: string) {
		try {
			await invoke('cancel_detached_tab', { token });
		} catch (error) {
			options.onError('Failed to release tab transfer claim', error);
		}
	}

	async function acceptOfferedTransfer(token: string): Promise<boolean> {
		let claimed = false;
		try {
			const payload = (await invoke('claim_detached_tab', { token })) as string | null;
			// Distinguish "no such token" from a claim that succeeded: only the
			// latter leaves something to release.
			if (payload === null) {
				options.onWarning('Tab transfer claim failed; opening empty window');
				return false;
			}
			claimed = true;
			const tab = validateTransferPayload(payload);
			if (!tab) {
				options.onWarning('Tab transfer payload invalid; opening empty window');
				await releaseClaim(token);
				return false;
			}
			if (!(await options.acceptTransferredTab(tab))) {
				await releaseClaim(token);
				return false;
			}
			await invoke('complete_detached_tab', { token });
			return true;
		} catch (error) {
			options.onError('Tab transfer claim error', error);
			if (claimed) await releaseClaim(token);
			return false;
		}
	}

	async function claimTransferredTab() {
		const claimToken = appWindow.label.startsWith('window-')
			? appWindow.label.slice('window-'.length)
			: null;
		if (!claimToken) return;
		await acceptOfferedTransfer(claimToken);
	}

	// A transfer stays open until the destination claims it or the timeout
	// gives up, so the menu entry that started it is clickable again long
	// before it resolves. Starting a second transfer for the same tab stages a
	// second payload: two windows each claim one, both build the tab, and the
	// source only removes it once -- leaving the same document open twice,
	// each copy with its own auto-save timer.
	const transfersInFlight = new Set<string>();

	async function transfer(tabId: string, deliver: (token: string) => Promise<void>): Promise<boolean> {
		if (!options.canTransfer(tabId)) return false;
		if (transfersInFlight.has(tabId)) return false;
		transfersInFlight.add(tabId);
		try {
			return await stageTransfer(tabId, deliver);
		} finally {
			transfersInFlight.delete(tabId);
		}
	}

	async function stageTransfer(tabId: string, deliver: (token: string) => Promise<void>): Promise<boolean> {
		const token = (await invoke('stage_detached_tab', {
			payload: options.transferPayload(tabId),
		})) as string;
		let settled = false;
		let resolveTransfer: (moved: boolean) => void;
		const unlisten = await appWindow.listen<string>('tab-transfer-claimed', (event) => {
			if (settled || event.payload !== token) return;
			settled = true;
			unlisten();
			options.onTransferClaimed(tabId);
			resolveTransfer(true);
		});
		return new Promise<boolean>((resolve) => {
			resolveTransfer = resolve;
			// The timeout is a guess about the destination, so it asks rather
			// than assumes. `claimed` means the payload is already gone into
			// the other window and only slow to render: giving up here would
			// leave the same document open in both, and whichever auto-saves
			// last wins. Keep waiting for `tab-transfer-claimed`; the
			// destination releases the claim itself if it cannot finish.
			const cancel = async () => {
				if (settled) return;
				try {
					const outcome = (await invoke('cancel_detached_tab', { token })) as {
						cancelled: boolean;
						claimed: boolean;
					};
					if (!outcome.cancelled && outcome.claimed) return;
				} catch (error) {
					options.onError('Failed to cancel tab transfer', error);
				}
				if (settled) return;
				settled = true;
				unlisten();
				resolve(false);
			};
			setTimeout(cancel, 15_000);
			deliver(token).catch((error) => {
				options.onError('Failed to deliver tab transfer', error);
				void cancel();
			});
		});
	}

	async function detach(tabId: string) {
		if (!options.canDetach(tabId)) return false;
		return transfer(tabId, (token) => invoke('create_transfer_window', { token }));
	}

	return { discardPersistedState, persistState, restore, claimTransferredTab, acceptOfferedTransfer, detach, transfer };
}
