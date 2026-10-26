import { settings } from './settings.svelte.js';
import { platformOf } from '../utils/platform.js';
import { modifierFor } from '../utils/shortcuts.js';

/**
 * The platform the title bar draws its chrome and menu chords for.
 *
 * It comes from `settings.osType` — the Rust `get_os_type` answer the rest of
 * the app already reads — rather than from the title bar's own user-agent sniff
 * for "Macintosh", which was a second source that could disagree with it.
 * `platformOf` covers the window before that command answers; see the comment
 * on it for why the title bar cannot simply read `settings.osType` directly
 * without flashing Windows chrome on a Mac.
 *
 * `$derived` rather than plain values: `osType` can change once after mount
 * (unknown → resolved). Computed once, the title bar would keep whatever the
 * fallback said and never correct itself on a machine where the two differ.
 */
export class TitleBarPlatform {
	platform = $derived(platformOf(settings.osType));
	isMac = $derived(this.platform === 'macos');
	modifier = $derived(modifierFor(this.platform));
}
