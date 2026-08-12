/**
 * The one answer to "what platform is this?".
 *
 * There used to be two. Everything in the app read `settings.osType`, which the
 * Rust `get_os_type` command fills in, while `TitleBar.svelte` decided for
 * itself from `navigator.userAgent.includes('Macintosh')`. Two sources means
 * they can disagree, and they did — not in the steady state, but at startup,
 * which is the only moment the title bar is being painted for the first time.
 * `settings.osType` is `'unknown'` until an `await invoke('get_os_type')` in the
 * `SettingsStore` constructor comes back, so on a Mac the user agent already
 * said "Macintosh" while the store still said "unknown". The title bar drew Mac
 * chrome and the tab tooltips beside it printed `Ctrl+W`.
 *
 * Pointing the title bar straight at `settings.osType` would have swapped that
 * disagreement for a worse one: for the frames before the command answers, a Mac
 * would render the `windows` class, the Windows minimise/maximise/close buttons
 * and no `native-mac` chrome, and then rearrange itself. So the resolution is
 * not "pick one of the two" but "one function that consults both, in order".
 *
 * The `navigator.platform` fallback is the same one `isMacPlatform()` in
 * Editor.svelte has used since #558, and the argument for it is written out in
 * full there: the value is frozen at `"MacIntel"` on every Mac, Apple silicon
 * included, so it is permanently wrong about the CPU and permanently right about
 * the vendor — which is the only axis asked of it here. It therefore cannot
 * reach a different verdict than `settings.osType` will, which is what makes
 * consulting it *first* safe rather than merely fast. Editor.svelte keeps its
 * own copy for now: `editorOptionWiring.test.ts` pins that helper by name, in
 * that file, and folding the two together is a separate change.
 *
 * `'linux'` collapses to `'windows'` because that is the choice the app has
 * always made — Linux uses the Ctrl chords and the Windows window controls — and
 * the two callers that used to spell that collapse by hand (`Settings.svelte`'s
 * `? 'macos' : 'windows'`, `TitleBar.svelte`'s `? 'Cmd' : 'Ctrl'`) were the
 * second copies this replaces.
 */
export function platformOf(osType: string): 'macos' | 'windows' {
	if (osType !== 'unknown') return osType === 'macos' ? 'macos' : 'windows';
	const platform = typeof navigator === 'undefined' ? '' : navigator.platform || '';
	return /^(Mac|iPhone|iPad|iPod)/i.test(platform) ? 'macos' : 'windows';
}
