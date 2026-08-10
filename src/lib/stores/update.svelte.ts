import { check, type Update } from '@tauri-apps/plugin-updater';
import { relaunch } from '@tauri-apps/plugin-process';
import { getVersion } from '@tauri-apps/api/app';
import { invoke } from '@tauri-apps/api/core';

type UpdatePhase =
	| 'idle'
	| 'checking'
	| 'up-to-date'
	| 'available'
	| 'package-managed'
	| 'downloading'
	| 'error';

type ErrorSource = 'check' | 'download' | 'install';

// Match only messages that genuinely indicate the updater plugin lacks an
// endpoint / pubkey configuration. We deliberately do NOT match the bare
// word "endpoint" — real network errors (e.g. "request to endpoint failed:
// connection refused") would otherwise be silently rebranded as
// "not configured" and hide actual connectivity failures.
function looksLikeNotConfigured(msg: string): boolean {
	const lower = msg.toLowerCase();
	return (
		lower.includes('not configured') ||
		lower.includes('updater plugin') ||
		lower.includes('plugins.updater') ||
		lower.includes('no updater') ||
		lower.includes('missing pubkey') ||
		/no.*endpoint|endpoint.*not.*set/.test(lower)
	);
}

class UpdateStore {
	phase = $state<UpdatePhase>('idle');
	show = $state(false);
	current = $state('');
	latest = $state('');
	downloaded = $state(0);
	total = $state(0);
	errorMsg = $state('');
	errorSource = $state<ErrorSource>('check');
	// Set when the underlying updater error indicates the plugin has no
	// endpoint / pubkey configured (i.e. PR-1 ships before signing infra).
	// The dialog renders a localised hint instead of the raw plugin message
	// when this is true.
	errorIsNotConfigured = $state(false);
	notes = $state('');
	#pending: Update | null = null;
	#checkToken = 0;

	async openDialog() {
		if (this.show) return;
		this.show = true;
		await this.runCheck();
	}

	close() {
		if (this.phase === 'downloading') return;
		this.#checkToken++;
		this.show = false;
		this.phase = 'idle';
		this.errorMsg = '';
		this.errorSource = 'check';
		this.errorIsNotConfigured = false;
		this.notes = '';
		this.latest = '';
		this.downloaded = 0;
		this.total = 0;
		this.#pending = null;
	}

	async runCheck() {
		if (this.phase === 'checking' || this.phase === 'downloading') return;

		const token = ++this.#checkToken;
		this.phase = 'checking';
		this.errorMsg = '';
		this.errorSource = 'check';
		this.errorIsNotConfigured = false;
		this.notes = '';
		this.latest = '';
		this.downloaded = 0;
		this.total = 0;
		this.#pending = null;

		try {
			// Ask whether this install can update itself BEFORE checking, not
			// after. A `.deb`, `.rpm` or snap install passes the check happily —
			// latest.json publishes `linux-x86_64` and every Linux build asks for
			// exactly that key — and then fails at install time, because the
			// updater's only Linux strategy is renaming a file over the running
			// binary. Being offered an update that cannot be installed is worse
			// than not being offered one, so the question is asked first and the
			// dialog says where updates actually come from. See #570.
			if (!(await invoke<boolean>('self_update_supported'))) {
				if (token !== this.#checkToken) return;
				this.phase = 'package-managed';
				return;
			}
			if (token !== this.#checkToken) return;

			// Cache the running app's version after the first successful fetch.
			// Tauri reads it from the bundle once at startup so subsequent calls
			// only return the cached value, but keeping it stable across
			// retries makes intent clearer.
			if (!this.current) {
				const v = await getVersion();
				if (token !== this.#checkToken) return;
				this.current = v;
			}

			const u = await check();
			if (token !== this.#checkToken) return;
			if (u) {
				this.#pending = u;
				this.latest = u.version;
				this.notes = u.body ?? '';
				this.phase = 'available';
			} else {
				this.phase = 'up-to-date';
			}
		} catch (e) {
			if (token !== this.#checkToken) return;
			const raw = e instanceof Error ? e.message : String(e);
			this.errorIsNotConfigured = looksLikeNotConfigured(raw);
			// Surface the raw message only when the error is not the
			// "not configured" case — the dialog shows a localised hint
			// instead in that case.
			this.errorMsg = this.errorIsNotConfigured ? '' : raw;
			// errorSource was already set to 'check' at the top of runCheck();
			// no reassignment needed here.
			this.phase = 'error';
		}
	}

	async startDownload() {
		if (this.phase !== 'available' || !this.#pending) return;

		const update = this.#pending;
		this.#checkToken++;
		this.phase = 'downloading';
		this.downloaded = 0;
		this.total = 0;

		// Two separate try blocks so the error attribution is precise:
		// downloadAndInstall failures map to errorSource='download' (the
		// download or signature-verify failed), while a relaunch() failure
		// maps to errorSource='install' (the new binary is on disk but the
		// OS refused to restart — user just needs to quit and reopen).
		try {
			await update.downloadAndInstall((event) => {
				if (event.event === 'Started') {
					this.total = event.data.contentLength ?? 0;
				} else if (event.event === 'Progress') {
					this.downloaded += event.data.chunkLength;
				}
			});
		} catch (e) {
			this.errorMsg = e instanceof Error ? e.message : String(e);
			this.errorSource = 'download';
			this.errorIsNotConfigured = false;
			this.phase = 'error';
			return;
		}

		try {
			await relaunch();
		} catch (e) {
			this.errorMsg = e instanceof Error ? e.message : String(e);
			this.errorSource = 'install';
			this.errorIsNotConfigured = false;
			this.phase = 'error';
		}
	}
}

export const updateStore = new UpdateStore();
