import { semanticTokenRules } from './editorTheme.js';

// Values taken from an imported VS Code theme end up concatenated into a global
// `<style>` block. Anything that is not a colour literal could close the rule and
// open a new one (`#fff; } * { display:none; background-image:url(https://evil) } :root {`),
// which repaints or hides the whole UI on every launch because the theme name is
// persisted. Validate before the value is ever interpolated.
const hexColorPattern = /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
const numericComponent = String.raw`(?:\d{1,3}(?:\.\d+)?%?)`;
const alphaComponent = String.raw`(?:\d{1,3}(?:\.\d+)?%?|\.\d+)`;
const rgbColorPattern = new RegExp(
	`^rgba?\\(\\s*${numericComponent}\\s*(?:,\\s*${numericComponent}\\s*){2}(?:,\\s*${alphaComponent}\\s*)?\\)$`,
	'i',
);
const rgbSpaceColorPattern = new RegExp(
	`^rgba?\\(\\s*${numericComponent}\\s+${numericComponent}\\s+${numericComponent}\\s*(?:\\/\\s*${alphaComponent}\\s*)?\\)$`,
	'i',
);

const namedColors = new Set([
	'transparent',
	'currentcolor',
	'black',
	'silver',
	'gray',
	'grey',
	'white',
	'maroon',
	'red',
	'purple',
	'fuchsia',
	'green',
	'lime',
	'olive',
	'yellow',
	'navy',
	'blue',
	'teal',
	'aqua',
	'cyan',
	'magenta',
	'orange',
]);

export function isSafeCssColor(value: unknown): value is string {
	if (typeof value !== 'string') return false;
	const trimmed = value.trim();
	if (!trimmed || trimmed.length > 64) return false;
	if (hexColorPattern.test(trimmed)) return true;
	if (rgbColorPattern.test(trimmed) || rgbSpaceColorPattern.test(trimmed)) return true;
	return namedColors.has(trimmed.toLowerCase());
}

export function isHexColor(value: unknown): value is string {
	return typeof value === 'string' && hexColorPattern.test(value.trim());
}

/**
 * Drop every entry whose value is not a colour literal. Callers then fall through
 * to their own defaults, exactly as they would for a missing key.
 */
export function sanitizeThemeColors(colors: unknown): Record<string, string> {
	const safe: Record<string, string> = {};
	if (!colors || typeof colors !== 'object') return safe;

	for (const [key, value] of Object.entries(colors as Record<string, unknown>)) {
		if (isSafeCssColor(value)) safe[key] = value.trim();
	}

	return safe;
}

export type MonacoTokenRule = { token: string; foreground?: string; fontStyle?: string };

/**
 * Every rule an imported theme's editor gets, semantic layer included.
 *
 * The app's own semantic rules go first and the theme's on top, because Monaco
 * merges same-named rules in array order and the theme has to win wherever it
 * has an opinion. First is not a default in the ordinary sense, though — it is
 * what keeps the layer from erasing the theme. A semantic token whose type the
 * theme does not name resolves to the theme's *root* rule, whose foreground is
 * a real colour id rather than "none", and `sparseTokensStore` then masks the
 * grammar's colour out and paints the plain default over it
 * (`semanticTokensProviderStyling.js`, the `if (tokenStyle.foreground)` branch).
 * Before this, an imported theme lost its heading, link, quote and inline-code
 * colours to that path the moment the semantic layer shipped.
 */
export function importedThemeRules(tokenColors: unknown, isDark: boolean): MonacoTokenRule[] {
	return [...semanticTokenRules(isDark ? 'dark' : 'light'), ...monacoTokenRules(tokenColors)];
}

/**
 * The Monaco token names a TextMate scope has to be renamed to before it can
 * colour anything in the editor.
 *
 * A VS Code theme colours scopes — `markup.bold`, `markup.italic` — and
 * Monaco's markdown tokenizer emits names of its own: `strong`, `emphasis`,
 * `variable` for inline code, `string.link`. Nothing maps the two together, so
 * every emphasis rule an imported theme ships has been landing on a token that
 * does not exist (#676). Headings, lists and tables took colour anyway because
 * they tokenize as `keyword`, which themes also define under that exact name —
 * which is why the reporter saw *some* of their theme arrive and concluded the
 * rest was unstyleable.
 *
 * There are now two sets of names to reach, not one. The grammar's are still
 * here, and beside them the construct names the semantic layer answers under
 * (`utils/semanticTokens.ts`) — which is how a scope reaches `~~strikethrough~~`
 * at last: Monaco's tokenizer never leaves `linecontent` for it, but the
 * renderer's parse sees it, and a theme rule on `strike` styles what the parse
 * reports. The two spellings rarely coincide: the grammar calls italics
 * `emphasis` and the parse calls it `emph`, one letter apart and no match
 * between them.
 *
 * A construct with no `markup.*` scope of its own — a task checkbox, a table,
 * a wikilink, maths — is not listed and does not need to be: `importedThemeRules`
 * gives every legend entry a rule before these are applied, so an unlisted one
 * takes the app's own colour rather than the theme's default foreground.
 */
const MARKDOWN_SCOPE_ALIASES: Record<string, { readonly grammar: readonly string[]; readonly kind: string }> = {
	'markup.bold': { grammar: [], kind: 'strong' },
	'markup.italic': { grammar: ['emphasis'], kind: 'emph' },
	'markup.inline.raw': { grammar: ['variable'], kind: 'code' },
	'markup.raw.inline': { grammar: ['variable'], kind: 'code' },
	'markup.underline.link': { grammar: ['string.link'], kind: 'link' },
	'markup.heading': { grammar: [], kind: 'heading' },
	'entity.name.section': { grammar: [], kind: 'heading' },
	'markup.strikethrough': { grammar: [], kind: 'strike' },
	'markup.quote': { grammar: [], kind: 'quote' },
	'markup.list': { grammar: [], kind: 'list' },
	'markup.fenced_code': { grammar: [], kind: 'fence' },
	'meta.separator': { grammar: [], kind: 'rule' },
};

/**
 * Scopes are matched by prefix because themes qualify them by language —
 * `markup.bold.markdown` is the common spelling, and an exact-match table would
 * miss most of the themes it exists for. The trailing dot keeps
 * `markup.underline` from being read as `markup.underline.link`.
 */
function markdownTokensFor(scope: string): readonly string[] {
	for (const [tmScope, alias] of Object.entries(MARKDOWN_SCOPE_ALIASES)) {
		if (scope === tmScope || scope.startsWith(`${tmScope}.`)) {
			// The marker as well as the content. Not a nicety: the app's base
			// carries `strike.marker`, which is *longer* than the theme's
			// `strike` and therefore inserted after it, so without a rule of its
			// own the theme would colour a word and leave the app colouring the
			// `~~` on either side of it. One construct, two greys.
			return [...alias.grammar, alias.kind, `${alias.kind}.marker`];
		}
	}
	return [];
}

/**
 * A VS Code theme's `tokenColors` as Monaco theme rules.
 *
 * The scope keeps its own rule as well as its alias: the original is inert
 * rather than wrong, and dropping it would mean deciding here that no Monaco
 * grammar will ever emit that name.
 */
export function monacoTokenRules(tokenColors: unknown): MonacoTokenRule[] {
	if (!Array.isArray(tokenColors)) return [];
	const rules: MonacoTokenRule[] = [];

	for (const item of tokenColors) {
		if (!item?.settings || (!item.settings.foreground && !item.settings.fontStyle)) continue;
		if (item.settings.foreground && !isHexColor(item.settings.foreground)) continue;

		const scopes = Array.isArray(item.scope) ? item.scope : [item.scope];
		for (const scope of scopes) {
			if (typeof scope !== 'string' || !scope.trim()) continue;
			// A theme may write several scopes into one string. Left whole, the
			// comma is part of the token name and the entry colours nothing —
			// the same silent miss the aliases above are here to fix.
			for (const piece of scope.split(',')) {
				const trimmed = piece.trim();
				if (!trimmed) continue;
				const rule: MonacoTokenRule = {
					token: trimmed,
					foreground: item.settings.foreground?.trim().replace('#', ''),
					fontStyle: item.settings.fontStyle,
				};
				rules.push(rule);
				// `fontStyle` is carried over, and its absence is not "regular":
				// Monaco reads a missing one as NotSet and leaves the base
				// theme's `strong: bold` / `emphasis: italic` standing, so a
				// colour-only rule adds colour without flattening the text.
				for (const alias of markdownTokensFor(trimmed)) {
					rules.push({ ...rule, token: alias });
				}
			}
		}
	}

	return rules;
}

export async function parseAndApplyVscodeTheme(themeJsonStr: string, name: string) {
	const cleanJson = themeJsonStr.replace(/\\"|"(?:\\"|[^"])*"|(\/\/.*|\/\*[\s\S]*?\*\/)/g, (m, g) => (g ? '' : m));
	let theme;
	try {
		theme = JSON.parse(cleanJson);
	} catch (e) {
		console.error('Failed to parse theme JSON:', e);
		return;
	}

	const isDark = theme.type !== 'light';

	const colors = sanitizeThemeColors(theme.colors);

	const cssVars: Record<string, string> = {};

	cssVars['--color-canvas-default'] = colors['editor.background'] || colors['window.background'] || colors['sideBar.background'] || (isDark ? '#1e1e1e' : '#ffffff');
	cssVars['--color-canvas-subtle'] = colors['sideBar.background'] || colors['editorWidget.background'] || (isDark ? '#252526' : '#f3f3f3');
	cssVars['--color-canvas-overlay'] = colors['editorWidget.background'] || colors['dropdown.background'] || cssVars['--color-canvas-subtle'];
	cssVars['--tab-active-bg'] = colors['tab.activeBackground'] || colors['editorGroupHeader.tabsBackground'] || cssVars['--color-canvas-default'];

	cssVars['--color-fg-default'] = colors['editor.foreground'] || colors['sideBar.foreground'] || colors['foreground'] || (isDark ? '#d4d4d4' : '#333333');
	cssVars['--color-fg-muted'] = colors['descriptionForeground'] || colors['tab.inactiveForeground'] || (isDark ? '#999999' : '#666666');
	cssVars['--color-fg-subtle'] = colors['disabledForeground'] || cssVars['--color-fg-muted'];

	cssVars['--color-border-default'] = colors['activityBar.border'] || colors['editorGroup.border'] || colors['focusBorder'] || (isDark ? '#444444' : '#dddddd');
	cssVars['--color-border-muted'] = colors['sideBarSectionHeader.border'] || colors['widget.border'] || cssVars['--color-border-default'];
	cssVars['--color-window-border-top'] = colors['titleBar.activeBackground'] || cssVars['--color-border-default'];
	cssVars['--color-neutral-muted'] = colors['button.secondaryBackground'] || (isDark ? 'rgba(255, 255, 255, 0.1)' : 'rgba(0, 0, 0, 0.1)');

	cssVars['--color-accent-fg'] = colors['textLink.foreground'] || colors['button.background'] || colors['focusBorder'] || '#007acc';
	cssVars['--color-accent-emphasis'] = colors['textLink.activeForeground'] || colors['button.hoverBackground'] || cssVars['--color-accent-fg'];

	cssVars['--color-btn-fg'] = colors['button.foreground'] || (isDark ? '#ffffff' : '#000000');
	cssVars['--color-btn-hover-bg'] = colors['button.hoverBackground'] || cssVars['--color-accent-emphasis'];
	cssVars['--color-tab-active-fg'] = colors['tab.activeForeground'] || cssVars['--color-btn-fg'];

	cssVars['--color-success-fg'] = colors['terminal.ansiGreen'] || colors['gitDecoration.addedResourceForeground'] || '#89d185';
	cssVars['--color-attention-fg'] = colors['terminal.ansiYellow'] || colors['gitDecoration.modifiedResourceForeground'] || '#cca700';
	cssVars['--color-danger-fg'] = colors['terminal.ansiRed'] || colors['gitDecoration.deletedResourceForeground'] || '#f14c4c';
	cssVars['--color-done-fg'] = colors['terminal.ansiMagenta'] || '#c586c0';

	cssVars['--hljs-bg'] = cssVars['--color-canvas-subtle'];
	cssVars['--hljs-comment'] = cssVars['--color-fg-muted'];
	cssVars['--hljs-keyword'] = cssVars['--color-accent-fg'];
	cssVars['--hljs-string'] = cssVars['--color-success-fg'];
	cssVars['--hljs-title'] = cssVars['--color-attention-fg'];
	cssVars['--hljs-variable'] = cssVars['--color-fg-default'];
	cssVars['--hljs-type'] = cssVars['--color-fg-default'];

	let styleTag = document.getElementById('vscode-theme-style');
	if (!styleTag) {
		styleTag = document.createElement('style');
		styleTag.id = 'vscode-theme-style';
		document.head.appendChild(styleTag);
	}

	// Every value went through `isSafeCssColor`, so no entry can terminate the
	// declaration block. Re-check here so a future edit cannot reintroduce the hole.
	const rootStyles = Object.entries(cssVars)
		.filter(([, v]) => isSafeCssColor(v))
		.map(([k, v]) => `${k}: ${v};`)
		.join('\n');
	styleTag.textContent = `:root[data-theme="vscode"] {\n${rootStyles}\n}`;
	document.documentElement.dataset.theme = 'vscode';
	document.documentElement.dataset.themeType = isDark ? 'dark' : 'light';

	const bgHex = (cssVars['--color-canvas-default'] || '').replace('#', '');
	if (bgHex.length === 6) {
		const r = parseInt(bgHex.slice(0, 2), 16) / 255;
		const g = parseInt(bgHex.slice(2, 4), 16) / 255;
		const b = parseInt(bgHex.slice(4, 6), 16) / 255;
		const luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b;
		const wsColor = luminance > 0.5 ? 'rgba(0, 0, 0, 0.15)' : 'rgba(255, 255, 255, 0.15)';
		document.documentElement.style.setProperty('--color-whitespace', wsColor);
	}

	try {
		// Imported lazily: Monaco touches `window` at module scope, which would make
		// this module unloadable outside a browser (and it is already bundled by the
		// editor, so the dynamic import resolves from cache).
		const monaco = await import('monaco-editor');
		if (monaco) {
			const rules = importedThemeRules(theme.tokenColors, isDark);

			// Monaco only understands hex colours here; anything else makes
			// `defineTheme` throw and drops the whole editor theme.
			const monacoColors: Record<string, string> = {};
			for (const [key, value] of Object.entries(colors)) {
				if (isHexColor(value)) monacoColors[key] = value;
			}

			monaco.editor.defineTheme('vscode-custom', {
				base: isDark ? 'vs-dark' : 'vs',
				inherit: true,
				rules: rules,
				colors: monacoColors,
			});

			monaco.editor.setTheme('vscode-custom');
		}
	} catch (e) {
		console.error('Monaco theme application failed:', e);
	}
}

export function clearVscodeTheme() {
	const styleTag = document.getElementById('vscode-theme-style');
	if (styleTag) styleTag.remove();
	document.documentElement.style.removeProperty('--color-whitespace');
}
