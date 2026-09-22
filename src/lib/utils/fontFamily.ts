/**
 * The CSS generic families, which must stay unquoted.
 *
 * `"sans-serif"` is a request for a family named "sans-serif", which nobody
 * has — quoting a generic turns the fallback into a miss. Matching is
 * case-insensitive because CSS keywords are, which is also what keeps the
 * Linux defaults working: `defaultFontsFor('linux')` picks `Monospace` and
 * `system-ui`, and `Monospace` is the generic, spelled with a capital M.
 *
 * The list is `<generic-font-complete>` plus `<generic-font-incomplete>` from
 * CSS Fonts 4 §2.1.2, and nothing else. Two names that look like they belong
 * are deliberately absent:
 *
 * - `fangsong` and the other script-specific generics are spelled
 *   `generic(fangsong)` now, so the bare word is an ordinary family name —
 *   and a real one: macOS ships `FangSong` and `STFangsong`. Exempting it
 *   would hand a user who picked their 仿宋 face an unquoted name, which an
 *   engine that still treats the bare word as a keyword resolves to a generic
 *   instead of to their font.
 * - `emoji` is not in the grammar at all.
 *
 * The CSS-wide keywords — `inherit`, `initial`, `unset`, `revert`,
 * `revert-layer` — and `default` must never be added here. §2.1.1 requires a
 * family with one of those names to be quoted, and measurement agrees: bare,
 * the whole declaration is rejected, which is the defect this module exists to
 * fix rather than a case it should reintroduce.
 */
const GENERIC_FAMILIES = new Set([
	'serif',
	'sans-serif',
	'monospace',
	'cursive',
	'fantasy',
	'system-ui',
	'ui-serif',
	'ui-sans-serif',
	'ui-monospace',
	'ui-rounded',
	'math',
]);

/**
 * A `font-family` declaration value carrying the family the user picked in
 * settings, followed by `fallback`.
 *
 * The name used to be interpolated bare — `font-family: {settings.previewFont},
 * sans-serif` in the viewer, and the raw string handed to Monaco — which is
 * valid CSS only while the name happens to be a sequence of identifiers. A
 * family called `M+ 1c`, `04b03` or `Gill Sans (Body)` made the *whole
 * declaration* invalid, so the browser dropped it and the element kept the font
 * it inherited. The failure is silent and looks like the font not existing: the
 * family is in the settings dropdown, selecting it changes nothing, and the
 * user has no way to tell those two apart. Reported in #810 against fonts
 * activated by a third-party font manager.
 *
 * A quoted string is always a valid `<family-name>`, so quoting is the whole
 * fix; `"` and `\` inside the name are escaped, which is what makes the value
 * unable to terminate the string early and inject further declarations.
 *
 * Monaco is not a second implementation of this. It quotes a family of its own
 * accord (`BareFontInfo._wrapInQuotes`) but only when the name carries a space
 * or a `+`, so `04b03` reaches the stylesheet bare — and it skips its own
 * quoting entirely once the value contains a quote character, which is what
 * lets this one stand in front of it.
 */
export function fontFamilyValue(name: string, fallback: string): string {
	const family = name.trim();
	if (family === '') return fallback;
	if (GENERIC_FAMILIES.has(family.toLowerCase())) return `${family}, ${fallback}`;
	return `"${family.replace(/["\\]/g, '\\$&')}", ${fallback}`;
}
