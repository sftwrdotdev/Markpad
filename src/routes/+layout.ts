import { settings } from '$lib/stores/settings.svelte.js';
import { loadLocale } from '$lib/utils/i18n.js';

// Tauri doesn't have a Node.js server to do proper SSR
// so we use adapter-static with a fallback to index.html to put the site in SPA mode
// See: https://svelte.dev/docs/kit/single-page-apps
// See: https://v2.tauri.app/start/frontend/sveltekit/ for more info
export const ssr = false;

// Before the first render, so a non-English window does not paint in English
// first. A failed chunk still opens the window, in English.
export async function load() {
	await loadLocale(settings.language).catch(() => {});
}
