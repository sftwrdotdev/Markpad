import { invoke } from '@tauri-apps/api/core';
import { getVersion } from '@tauri-apps/api/app';

/**
 * What the Settings dialog does each time it opens and closes: load the system
 * fonts (once) and the app version (once), run `onOpen`, take focus from
 * whatever opened it, and hand focus back on close.
 *
 * Call it during component setup: it installs its own `$effect`.
 */
export function createSettingsOpen(options: {
	isOpen: () => boolean;
	modal: () => HTMLElement | undefined;
	onOpen: () => void;
}) {
	const view = $state({ systemFonts: [] as string[], appVersion: '' });
	// Plain variables on purpose: neither is rendered, and both are read *and*
	// written by the open-effect below. As `$state` they made that effect
	// re-enter itself — `loadFonts()` reads `loaded` synchronously and sets it
	// after its await, which re-ran the effect and clobbered the saved
	// `previousActiveElement` with a control inside the dialog.
	let loaded = false;
	let previousActiveElement: HTMLElement | null = null;

	async function loadFonts() {
		if (loaded) return;
		try {
			view.systemFonts = await invoke<string[]>('get_system_fonts');
			loaded = true;
		} catch (e) {
			console.error('Failed to load system fonts:', e);
			view.systemFonts = ['Consolas', 'Courier New', 'Monaco', 'Menlo', 'Segoe UI'];
		}
	}

	// Guarded by a plain (non-reactive) flag rather than by `if (!appVersion)`.
	// The old form made the open-effect below *read* `appVersion` and the
	// resolved promise *write* it, so the whole effect re-ran once the version
	// arrived — and the re-run re-captured `previousActiveElement`, which by then
	// was a button inside the dialog. Closing settings then returned focus into
	// the dialog instead of to the control that opened it.
	let versionRequested = false;
	function ensureAppVersion() {
		if (versionRequested) return;
		versionRequested = true;
		getVersion()
			.then((v) => (view.appVersion = v))
			.catch(console.error);
	}

	$effect(() => {
		if (options.isOpen()) {
			loadFonts();
			ensureAppVersion();
			options.onOpen();
			previousActiveElement = document.activeElement as HTMLElement;
			setTimeout(() => {
				const settingsModal = options.modal();
				const firstFocusable = settingsModal?.querySelector('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])') as HTMLElement | null;
				if (firstFocusable) {
					firstFocusable.focus();
				} else {
					settingsModal?.focus();
				}
			}, 50);
		} else if (previousActiveElement) {
			previousActiveElement.focus();
		}
	});

	return {
		get systemFonts() {
			return view.systemFonts;
		},
		get appVersion() {
			return view.appVersion;
		},
	};
}
