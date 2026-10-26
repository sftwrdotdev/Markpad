// Markpad's code conventions, as lint rules (`npm run lint`).
//
// This config turns on no style preset. Every rule below is a convention the
// app depends on that no type can express: a second copy of a fixed behaviour,
// a call that must go through one wrapper, a defect shape that must not come
// back. Each message says why.
//
// The rules are `no-restricted-syntax` selectors, but not the built-in rule. In
// a flat config a later block REPLACES an earlier block's options for the same
// rule, so two conventions covering MarkdownViewer.svelte would silently drop
// one of them. `convention()` builds one rule per convention instead, so each
// keeps its own files, its own exceptions and its own name in the report.
// Selectors run on the TypeScript AST and, in `.svelte` files, on the template
// AST of svelte-eslint-parser (`SvelteMustacheTag`, `SvelteLiteral`, ...), so
// comments and prose never match.
import svelte from 'eslint-plugin-svelte';
import tseslint from 'typescript-eslint';

/**
 * @typedef {object} Convention
 * @property {string[]} [files] globs, default every source file under src/
 * @property {string[]} [ignores] files the convention allows
 * @property {Record<string, string>} [ban] selector -> message, reported on every match
 * @property {Record<string, [number, string]>} [atMost] selector -> [n, message], reported past the nth match in a file
 * @property {{ call: string, earlier: string, message: string }} [requireEarlier]
 *   every call of `call` needs a call of `earlier` before it in the same function
 *   (callbacks passed as arguments count as part of the function around them)
 * @property {import('eslint').Rule.RuleModule} [custom] a rule of its own, for what a selector cannot say
 */

/**
 * @param {Convention} c
 * @returns {import('eslint').Rule.RuleModule}
 */
function convention(c) {
	return {
		meta: { type: 'problem', schema: [] },
		create(context) {
			/** @type {Record<string, (node: any) => void>} */
			const visitors = {};
			for (const [selector, message] of Object.entries(c.ban ?? {})) {
				visitors[selector] = (node) => context.report({ node, message });
			}
			for (const [selector, [n, message]] of Object.entries(c.atMost ?? {})) {
				let seen = 0;
				visitors[selector] = (node) => {
					if (++seen > n) context.report({ node, message });
				};
			}
			if (c.requireEarlier) {
				const { call, earlier, message } = c.requireEarlier;
				/** @type {(node: any, name: string) => boolean} */
				const named = (node, name) => node.callee.name === name || node.callee.property?.name === name;
				/** @type {(node: any) => boolean} */
				const isFunction = (node) => /Function/.test(node.type) && node.parent.type !== 'CallExpression';
				/** @type {number[]} */
				const earlierStarts = [];
				visitors.CallExpression = (/** @type {any} */ node) => {
					if (named(node, earlier)) earlierStarts.push(node.range[0]);
					if (!named(node, call)) return;
					const fn = context.sourceCode.getAncestors(node).findLast(isFunction);
					const from = fn?.range?.[0] ?? 0;
					if (!earlierStarts.some((start) => start >= from && start < node.range[0])) {
						context.report({ node, message });
					}
				};
			}
			return visitors;
		},
	};
}

/** `aria-valuemin={X_RANGE.min}` next to `aria-valuemax={X_RANGE.max}`, the same X_RANGE. */
/** @type {import('eslint').Rule.RuleModule} */
const ariaRange = {
	meta: { type: 'problem', schema: [] },
	create(context) {
		/** @type {(attr: any, end: string) => string | null} */
		const range = (attr, end) => {
			const [value] = attr?.value ?? [];
			const e = attr?.value.length === 1 && value.type === 'SvelteMustacheTag' ? value.expression : null;
			return e?.type === 'MemberExpression' && e.property.name === end && /_RANGE$/.test(e.object.name ?? '')
				? e.object.name
				: null;
		};
		return {
			/** @param {any} node */
			SvelteStartTag(node) {
				/** @type {(name: string) => any} */
				const attr = (name) => node.attributes.find((/** @type {any} */ a) => a.type === 'SvelteAttribute' && a.key.name === name);
				const min = attr('aria-valuemin');
				const max = attr('aria-valuemax');
				if (!min && !max) return;
				const name = range(min, 'min');
				if (!name || range(max, 'max') !== name) {
					context.report({
						node,
						message:
							"aria-valuemin/max is the bound assistive tech reports; advertise the setting's own *_RANGE.min/.max " +
							'(the one the store clamps against), not numbers of its own, so the two cannot drift.',
					});
				}
			},
		};
	},
};

const VIEWER = 'src/lib/MarkdownViewer.svelte';
const EDITOR = 'src/lib/components/Editor.svelte';
const BINDINGS = 'src/lib/bindings.ts';
const SANITIZER_FILES = ['src/lib/utils/richContent.ts', 'src/lib/utils/sanitize.ts'];
const callOf = (/** @type {string} */ name) => `CallExpression[callee.name='${name}'], CallExpression[callee.property.name='${name}']`;
const command = (/** @type {string} */ name) => `CallExpression[callee.object.name='commands'][callee.property.name='${name}']`;

/** @type {Record<string, Convention>} */
const CONVENTIONS = {
	// ------------------------------------------------------------ Tauri boundary
	'tauri-through-bindings': {
		ignores: [BINDINGS, 'src/lib/windowEvents.ts'],
		ban: {
			"ImportDeclaration[source.value=/^@tauri-apps\\/api\\/(core|event)$/] > ImportSpecifier[imported.name=/^(invoke|listen|once|emit|emitTo)$/]":
				'Call Rust through the generated `commands.*` and listen to Rust events through `events.*` (src/lib/bindings.ts): ' +
				'a raw invoke/listen names the command or event by a string tsc cannot check. Events between windows go through src/lib/windowEvents.ts.',
		},
	},

	// ------------------------------------------------------------------ documents
	'live-mode-toggle-does-not-reload': {
		files: [VIEWER],
		ban: {
			"FunctionDeclaration[id.name='toggleLiveMode'] CallExpression[callee.name='loadMarkdown']":
				'Turning Live Mode on is not a request to discard the buffer; reloading here skips canCloseTab.',
		},
	},
	'view-modes-do-not-touch-live-mode': {
		files: ['src/lib/sessions/viewMode.svelte.ts'],
		ban: {
			"Identifier[name=/^(liveMode|toggleLiveMode)$/]":
				'Entering split view used to turn Live Mode off behind the user (#692). The view modes are not handed Live Mode.',
		},
	},
	'open-dialog-uses-the-extension-list': {
		ignores: [BINDINGS],
		ban: {
			"Property[key.name='extensions'] > ArrayExpression:has(> Literal[value='md'])":
				'A literal extension list drifts from the one Markpad treats as documents; use MARKDOWN_OPEN_FILTERS (utils/markdownLinks.ts).',
		},
	},
	'save-content-cancels-auto-save-itself': {
		ban: {
			[`ExpressionStatement:has(> :matches(${callOf('cancelPendingAutoSave')})) + :matches(ExpressionStatement, VariableDeclaration, ReturnStatement):has(${callOf('saveContent')})`]:
				'saveContent already cancels the pending auto-save; pairing a manual cancel with it moves the duty back to the call sites, where the next one forgets it.',
		},
	},
	'only-the-revert-commands-discard-a-buffer': {
		ignores: ['src/lib/sessions/externalChange.svelte.ts'],
		ban: {
			"Property[key.name='discardUnsavedBuffer'][value.value=true]":
				'Only the two revert commands (Reload on the conflict bar, Reload from disk) may say the user chose to lose work.',
		},
	},

	// -------------------------------------------------------------------- editing
	'one-copy-reference-builder': {
		ignores: ['src/lib/utils/headingReference.ts'],
		ban: {
			"CallExpression[callee.name='referenceForTab']:not(FunctionDeclaration[id.name='copyHeadingReference'] *)":
				'Copy Reference has one builder (copyHeadingReference in MarkdownViewer.svelte); the three menu entries used to build the string inline and disagreed.',
		},
	},

	// --------------------------------------------------------------------- layout
	'outline-takes-no-document-string': {
		files: ['src/lib/components/Toc.svelte'],
		ban: {
			"Identifier[name='htmlContent']":
				'The outline follows the revision the preview patch publishes, not the rendered document string.',
		},
	},
	'split-ratio-is-clamped-by-the-store': {
		files: ['src/lib/utils/splitPanes.ts'],
		ban: {
			"MemberExpression[object.name='Math'][property.name=/^(min|max)$/]":
				'TabManager.setSplitRatio clamps; a second copy of the bounds here drifts from it.',
		},
	},
	'splitter-direction-has-one-source': {
		files: [VIEWER],
		ban: {
			"ConditionalExpression[test.right.value='left']:matches([test.left.name='splitEditorSide'], [test.left.property.name='splitEditorSide'])":
				'Both splitter routes take the direction from the same place; a third route spelling it is the drift.',
		},
	},
	'fold-layout-is-rooted-at-the-visible-host': {
		files: [VIEWER],
		ban: {
			"CallExpression[callee.name='observeFoldLayout'][arguments.0.name='markdownBody'], CallExpression[callee.name='followFoldLayout'][arguments.1.body.name='markdownBody']":
				'The article holds one host per tab, all but one display:none; measuring from it writes zero heights into every hidden tab.',
		},
	},

	// ----------------------------------------------------------------- navigation
	'one-preview-restore-cascade': {
		files: [VIEWER],
		ban: {
			"AssignmentExpression[left.property.name='scrollTop'][right.callee.name='getAnchorScrollTop'], MemberExpression[property.name='scrollPercentage'], CallExpression[callee.object.name='Array'][callee.property.name='from'][arguments.0.property.name='children']":
				'The reading position is restored through restorePreviewReadingPosition (utils/previewAnchor.ts); the cascade is an ORDER, and a second site consulting the same fields answers differently.',
		},
	},
	'line-coordinates-come-from-the-buffer': {
		files: [VIEWER],
		ban: {
			"CallExpression[callee.name='lineCoordinates']:not(VariableDeclarator[id.name='lineCoords'] > CallExpression > CallExpression[arguments.0.name='rawContent'])":
				'One derivation, `lineCoords = $derived(lineCoordinates(rawContent))`: the render is what the front matter was stripped out of, so measuring it answers 0.',
		},
	},
	'editor-derives-the-anchor-once': {
		files: [EDITOR, 'src/lib/utils/editorDocument.svelte.ts'],
		ban: {
			"Identifier[name='tabAnchorForEditorTopLine']":
				'The editor crosses from buffer to renderer numbering in editorReadingPosition (utils/editorPosition.ts) only.',
		},
		atMost: {
			[callOf('editorReadingPosition')]: [1, 'The editor derives its reading position in one place.'],
		},
	},

	// --------------------------------------------------------------------- editor
	'one-update-options-effect': {
		files: [EDITOR],
		atMost: {
			"CallExpression[callee.object.name='editor'][callee.property.name='updateOptions']": [
				1,
				'Two effects writing the same Monaco options (fontSize with and without zoom) made the winner depend on effect order.',
			],
		},
	},
	'settings-os-type-is-written-by-the-store': {
		ignores: ['src/lib/stores/settings.svelte.ts'],
		ban: {
			"AssignmentExpression[left.object.name='settings'][left.property.name='osType']":
				'settings.osType is filled in by the store from get_os_type; ask platformOf() instead of writing it.',
		},
	},
	'editor-clipboard-goes-through-editor-clipboard': {
		files: [EDITOR],
		ban: {
			[command('clipboardWriteText')]:
				'Cut and copy write the clipboard in utils/editorClipboard.ts, so they cannot drift apart and the whole-line rule is implemented once.',
		},
	},
	'one-cut-one-copy': {
		files: ['src/lib/utils/editorClipboard.ts'],
		atMost: {
			[command('clipboardWriteText')]: [
				2,
				'copyToClipboard and cutToClipboard are the editor\'s two clipboard writers; a third derives the text again.',
			],
		},
	},
	'monaco-theme-writers': {
		ignores: [EDITOR, 'src/lib/utils/mountEditor.ts', 'src/lib/utils/theme.ts'],
		ban: {
			"CallExpression[callee.object.property.name='editor'][callee.property.name='setTheme']":
				'The editor pane, its mount and the theme importer (which defines `vscode-custom`) are the only Monaco theme writers.',
		},
	},
	'an-edit-is-its-own-undo-step': {
		files: [EDITOR, 'src/lib/utils/editorClipboard.ts'],
		requireEarlier: {
			call: 'executeEdits',
			earlier: 'pushUndoStop',
			message:
				'executeEdits appends to the undo element typing left open, so Cmd+Z takes the typing too; call editor.pushUndoStop() before it.',
		},
	},
	'on-mount-is-synchronous': {
		files: [EDITOR],
		ban: {
			"CallExpression[callee.name='onMount'] > :matches(ArrowFunctionExpression, FunctionExpression)[async=true]":
				'Svelte only takes a synchronously returned function as the unmount cleanup; an async onMount leaks what it set up.',
		},
	},
	'editor-effects-wait-for-editor-ready': {
		files: [EDITOR],
		ban: {
			"CallExpression[callee.name='$effect']:has(Identifier[name='editor']):not(:has(Identifier[name='editorReady']))":
				'`editor` is a plain let assigned after an await; an effect gated on it alone runs once against nothing and never again.',
		},
	},
	'monaco-is-loaded-on-demand': {
		ban: {
			"ImportDeclaration[importKind!='type'][source.value=/^monaco-(editor|vim)($|\\/)/]:not([source.value=/[?]worker$/]), ExportNamedDeclaration[exportKind!='type'][source.value=/^monaco-(editor|vim)($|\\/)/], ExportAllDeclaration[exportKind!='type'][source.value=/^monaco-(editor|vim)($|\\/)/]":
				'Monaco is most of the startup JavaScript and only the editor needs it: load it with `await import()` (Editor.svelte), or `import type`.',
		},
	},
	'one-image-link-writer': {
		files: [EDITOR, 'src/lib/utils/editorClipboard.ts'],
		ban: {
			"Literal[value=/%20/], TemplateElement[value.raw=/%20/]":
				'A hand-rolled space escape is back; imageEmbed (utils/imageEmbed.ts) escapes the destination.',
		},
	},
	'one-image-directory-resolver': {
		ignores: ['src/lib/utils/imageEmbed.ts'],
		ban: {
			"LogicalExpression[operator='||'][left.object.name='settings'][left.property.name='imageDirectory'], LogicalExpression[operator='||'][right.name='DEFAULT_IMAGE_DIRECTORY'], LogicalExpression[operator='||'][right.value='img']":
				'Paste, drop and the path completion read the image directory through one resolver (utils/imageEmbed.ts), so `${filename}` expands at all three.',
		},
	},
	'delete-line-stays-bound': {
		files: [EDITOR],
		ban: {
			"Literal[value='-editor.action.deleteLines']":
				'Mod+Shift+K deletes a line, as in Monaco (#821); unbinding it took a key users asked for back.',
		},
	},

	// -------------------------------------------------------------------- preview
	'katex-contribs-through-the-exports-map': {
		ban: {
			"ImportExpression[source.value=/^katex\\/dist\\/contrib\\//], ImportDeclaration[source.value=/^katex\\/dist\\/contrib\\//]":
				'katex/dist/contrib/*.js is CommonJS with its own KaTeX copy, so a macro mhchem registers there never reaches renderToString (#745). Import katex/contrib/*.',
		},
	},
	'one-copy-handler': {
		ban: {
			"ImportExpression[source.value=/copy-tex/], ImportDeclaration[source.value=/copy-tex/]":
				'copy-tex rewrote the clipboard for selections with math and undid the preview copy handler (#674); its behaviour is utils/previewCopy.ts.',
			"CallExpression[callee.property.name='addEventListener'][arguments.0.value='copy']":
				'The preview copy handler writes the clipboard itself (#549, #674); a second copy listener lets the webview decide again.',
		},
	},
	'viewer-markup-sinks': {
		files: [VIEWER],
		ban: {
			"SvelteMustacheTag[kind='raw']:not([expression.object.name='tooltip'][expression.property.name='html'])":
				'The document reaches the article through patchHost (the sanitizer\'s output); the footnote tooltip re-injects a clone of that DOM. Any other {@html} is a new unsanitized sink.',
			"Identifier[name='ALLOWED_URI_REGEXP']":
				'The viewer must not carry its own copy of the URI policy (utils/sanitize.ts).',
			"CallExpression[callee.name='processMarkdownHtml']":
				'The preview processes the blocks it inserts in processAndSanitize (utils/previewPatch.ts) and nowhere else.',
		},
		atMost: {
			"CallExpression[callee.name='patchHost']": [1, 'The preview reaches the article through one patchHost call.'],
		},
	},
	'one-sanitizer-policy': {
		ignores: SANITIZER_FILES,
		ban: {
			"ImportDeclaration[source.value='dompurify'], CallExpression[callee.object.name='DOMPurify'][callee.property.name='sanitize']":
				'A DOMPurify config outside utils/sanitize.ts (documents) and utils/richContent.ts (Mermaid SVG) is a second, unreviewed sanitizer. Use sanitizeMarkdownHtml.',
		},
	},
	'diagram-sanitizer-stays-separate': {
		files: ['src/lib/utils/richContent.ts'],
		ban: {
			"ImportDeclaration[source.value=/\\/sanitize(\\.js)?$/]":
				'The diagram filter needs the <style> the document policy forbids; do not adopt the document policy here.',
		},
	},
	'preview-processes-before-it-sanitizes': {
		files: ['src/lib/utils/previewPatch.ts'],
		ban: {
			"CallExpression[callee.name='processBlockMarkup']:not(FunctionDeclaration[id.name='processAndSanitize'] *)":
				'processAndSanitize is the one place that processes the renderer output.',
		},
		requireEarlier: {
			call: 'sanitizeMarkdownFragment',
			earlier: 'processBlockMarkup',
			message:
				'The preview processes first and sanitizes at the sink, so what reaches the article is exactly the sanitizer\'s output.',
		},
	},
	'render-through-render-markdown-preview': {
		ignores: ['src/lib/utils/export.ts'],
		ban: {
			[`${command('renderMarkdown')}:not(FunctionDeclaration[id.name='renderMarkdownPreview'] *)`]:
				'renderMarkdownPreview strips YAML front matter before the Rust renderer; a raw render elsewhere renders it as body text.',
		},
	},

	// ------------------------------------------------- single implementations
	'mermaid-render-sites': {
		ignores: ['src/lib/utils/mermaidPrint.ts', 'src/lib/utils/richContent.ts'],
		ban: {
			"CallExpression[callee.object.name='mermaid'][callee.property.name='render']":
				'Export re-renders Mermaid from data-mermaid-source; a render path outside mermaidPrint.ts/richContent.ts skips rememberDiagramSource and exports blank diagrams (#359).',
		},
	},
	'one-mermaid-theme-resolver': {
		ignores: [VIEWER, 'src/lib/utils/mermaidPrint.ts'],
		ban: {
			"CallExpression[callee.name='resolveMermaidTheme']":
				'The on-screen render and the print restore share resolveMermaidTheme so they cannot drift.',
		},
	},
	'scroll-sync-max-from-content-height': {
		ban: {
			"BinaryExpression[operator='-'][left.callee.property.name='getScrollHeight'][right.property.name=/height/i], BinaryExpression[operator='-'][left.callee.property.name='getScrollHeight'][right.name=/height/i]":
				'Split-view scroll sync must not count the editor bottom padding (#316).',
		},
	},
	'fold-height-from-layout': {
		files: ['src/lib/utils/**'],
		ban: {
			"MemberExpression[property.name='scrollHeight']":
				'KaTeX glyphs reach past their box, so scrollHeight overshoots what height:auto resolves to and the fold jumps; measure getBoundingClientRect().height.',
		},
	},
	'markdown-extensions-from-bindings': {
		ignores: [BINDINGS],
		ban: {
			"Literal[value='mdown']":
				'The Markdown extension list is the Rust renderer\'s, generated into bindings.ts and re-exported by markdownLinks.ts (#611).',
		},
	},
	'list-marker-grammar-from-bindings': {
		ignores: [BINDINGS],
		ban: {
			"Literal[regex.pattern=/\\[ xX\\]|\\\\d\\+\\[\\.\\)\\]/], Literal[value=/\\[ xX\\]|\\\\d\\+\\[\\.\\)\\]/], TemplateElement[value.raw=/\\[ xX\\]|\\\\d\\+\\[\\.\\)\\]/]":
				'The list marker and task box are the Rust renderer\'s fragments (bindings.ts, re-exported by listSyntax.ts); a third spelling is #451.',
		},
	},
	'no-embedded-frames': {
		ban: {
			"CallExpression[callee.property.name='createElement'][arguments.0.value='iframe']":
				'The CSP has no frame-src: YouTube renders as a thumbnail that opens the browser.',
		},
	},
	'one-rich-content-renderer': {
		ignores: ['src/lib/utils/richContent.ts'],
		ban: {
			"FunctionDeclaration[id.name='renderRichContent']:has(TSTypeReference[typeName.name='RenderRichContentOptions'])":
				'utils/richContent.ts owns the render pipeline for the preview and the export; a second one is how the export shipped raw LaTeX.',
		},
	},
	'one-editor-language-table': {
		ignores: ['src/lib/utils/editorLanguage.ts'],
		ban: {
			"ReturnStatement > Literal[value='plaintext']":
				'A second extension-to-language table drifts from the one the editor uses (utils/editorLanguage.ts).',
		},
	},
	'home-tab-sentinel': {
		ignores: ['src/lib/utils/homeTab.ts'],
		ban: {
			"Literal[value='HOME']":
				'The home tab sentinel is spelled once (utils/homeTab.ts); the reader that did not know it rendered the home tab blank (#392). Use isHomePath / HOME_TAB_PATH.',
		},
	},
	'one-highlight-palette': {
		ignores: [VIEWER],
		ban: {
			"Literal[value=/--highlight-color:/], TemplateElement[value.raw=/--highlight-color:/], SvelteLiteral[value=/--highlight-color:/]":
				'The highlight palette is bound to --highlight-color in MarkdownViewer.svelte; a second binding drifts from it.',
		},
	},
	'one-language-catalogue': {
		ignores: ['src/lib/utils/i18n.ts'],
		ban: {
			"Property[key.name='nativeName']":
				'The language catalogue is getSupportedLanguages() in utils/i18n.ts; a second table drifted from it.',
			"TSTypeAliasDeclaration[id.name='LanguageCode']":
				'LanguageCode is declared once (utils/i18n.ts); two unions type-check against each other only while they agree.',
		},
	},
	'toc-width-bounds-from-the-range': {
		ban: {
			"Identifier[name=/^TOC_(MIN|MAX)_WIDTH$/]":
				'The TOC width bounds are TOC_WIDTH_RANGE, which the store clamps against.',
		},
	},
	'one-fold-key': {
		ignores: ['src/lib/utils/foldState.ts'],
		ban: {
			"LogicalExpression[operator='||'][right.property.name='textContent']:matches([left.name='id'], [left.property.name='id']), LogicalExpression[operator='||'][right.object.property.name='textContent']:matches([left.name='id'], [left.property.name='id'])":
				'A fold is named by assignFoldKey/foldKeyOf (utils/foldState.ts); three spellings disagreed about block ids.',
		},
	},
	'local-storage-writes-through-the-store': {
		ignores: ['src/lib/stores/settings.svelte.ts'],
		ban: {
			"CallExpression[callee.object.name='localStorage'][callee.property.name='setItem']":
				'A bare setItem is the write no other window hears and no range validates; use writeStoredSetting (stores/settings.svelte.ts).',
		},
	},
	'one-image-embed-writer': {
		ignores: ['src/lib/utils/imageEmbed.ts'],
		ban: {
			"Literal[value=/!\\[alt\\]\\(/], TemplateElement[value.raw=/!\\[alt\\]\\(/]":
				'imageEmbed (utils/imageEmbed.ts) is the single writer of an image link; the two inline copies broke on `note#1.png`.',
		},
	},
	'one-platform-probe': {
		ignores: ['src/lib/utils/platform.ts'],
		ban: {
			"MemberExpression[object.name='navigator'][property.name=/^(userAgent|platform)$/]":
				'platformOf (utils/platform.ts) is the one platform answer; a second probe disagreed with settings.osType at startup.',
		},
	},
	'one-modifier-decision': {
		ignores: ['src/lib/utils/shortcuts.ts', 'src/lib/utils/platform.ts'],
		ban: {
			"ConditionalExpression[test.operator='==='][test.right.value='macos'], ConditionalExpression[consequent.value='Cmd'][alternate.value='Ctrl']":
				'Use modifierFor() / platformOf(): a hand-written Cmd-or-Ctrl copy cannot pick up what the helper learns.',
		},
	},
	'translations-are-one-literal': {
		ignores: [BINDINGS],
		ban: {
			"CallExpression[callee.object.name='Object'][callee.property.name='assign'], AssignmentExpression > MemberExpression.left Identifier[name='translations']":
				'The dictionary is one literal; a merged second table made duplicate keys win silently. Add keys to the table itself.',
		},
	},
	'aria-range': { custom: ariaRange },

	// -------------------------------------------------------------------- settings
	'font-preferences-are-quoted': {
		files: [VIEWER, 'src/lib/utils/editorOptions.ts'],
		ban: {
			"SvelteLiteral[value=/(font-family|--code-font):\\s*$/] + SvelteMustacheTag[expression.object.name='settings']":
				'A font preference reaches CSS through fontFamilyValue (utils/fontFamily.ts), quoted.',
			"Property[key.name='fontFamily'] > MemberExpression.value[object.name='settings']":
				'A font preference reaches Monaco through fontFamilyValue (utils/fontFamily.ts), quoted.',
		},
	},
	'theme-css-is-text': {
		files: ['src/lib/utils/theme.ts'],
		ban: {
			"AssignmentExpression[left.property.name=/^(innerHTML|outerHTML)$/]":
				'Fill the theme style tag with textContent so imported CSS can never be parsed as markup.',
		},
	},
	't-requires-a-language': {
		files: ['src/lib/utils/i18n.ts'],
		ban: {
			"FunctionDeclaration[id.name='t'] > AssignmentPattern.params":
				'A default language made 9 call sites show English in all 26 languages; keep `lang` required.',
		},
	},
	'toasts-are-translated': {
		ban: {
			"CallExpression[callee.name='addToast'] > Literal:first-child, CallExpression[callee.name='addToast'] > :matches(TemplateLiteral, BinaryExpression):first-child:not(:has(CallExpression[callee.name='t']))":
				'Toast text that never goes through t() reads English in all 26 languages.',
		},
	},
	'one-startup-theme-writer': {
		ignores: [VIEWER],
		ban: {
			[command('saveTheme')]: 'save_theme has one caller (MarkdownViewer.svelte), so nothing can send it a raw theme name.',
		},
	},
	'viewer-keeps-no-theme': {
		files: [VIEWER],
		ban: {
			"VariableDeclarator[id.name='theme'][init.callee.name='$state']":
				'The viewer keeps no theme of its own beside the settings store.',
		},
		atMost: {
			[command('saveTheme')]: [1, 'save_theme has one caller, so nothing can send it a raw theme name.'],
		},
	},

	// ------------------------------------------------------------------ shortcuts
	'toolbar-chords-from-the-registry': {
		files: ['src/lib/utils/editorToolbar.ts'],
		ban: {
			"TemplateLiteral:has(> TemplateElement[value.raw=/^\\+/])":
				'A chord literal in the toolbar; it belongs in shortcuts.ts, read back with shortcutLabel().',
		},
	},
	'menu-chords-from-the-registry': {
		files: ['src/lib/components/TitleBar.svelte'],
		ban: {
			"SvelteElement[name.name='span']:has(SvelteAttribute[key.name='class'] > SvelteLiteral[value=/(^|\\s)menu-shortcut(\\s|$)/]) > :matches(SvelteText[value=/\\S/], SvelteMustacheTag:not(:has(CallExpression[callee.name=/^(shortcutLabel|t)$/])))":
				'Every menu shortcut comes from shortcutLabel(); a hand-written chord is wrong on one platform.',
		},
	},
	'no-hand-written-chords': {
		ignores: ['src/lib/utils/shortcuts.ts'],
		ban: {
			[[
				'Literal',
				'TemplateElement',
				'SvelteText',
				'SvelteLiteral',
			]
				.map((type) => `${type}[${type === 'TemplateElement' ? 'value.raw' : 'value'}=/\\b(Ctrl|Cmd|Command|Meta|Super)\\+((Shift|Alt|Option|Ctrl|Cmd)\\+)*[A-Za-z0-9\\\\\\[\\]\`.=-]/]`)
				.join(', ')]:
				'A keyboard chord written by hand; it belongs in src/lib/utils/shortcuts.ts, read back with shortcutLabel(id, modifierFor(settings.osType)) so macOS reads Cmd.',
		},
	},

	// -------------------------------------------------------------------- windows
	'windows-are-equal': {
		ban: {
			"Literal[value='main'], TemplateLiteral[expressions.length=0] > TemplateElement[value.raw='main'], Identifier[name=/^isMain(Window)?$/]":
				'Only Rust startup tells the launch window apart (LAUNCH_LABEL); a frontend branch on "main" makes a second, unequal kind of window.',
		},
	},
	'recent-files-through-the-helper': {
		ignores: ['src/lib/utils/recentFiles.ts'],
		ban: {
			"CallExpression[callee.property.name=/^(setItem|getItem)$/][arguments.0.value='recent-files']":
				'A window writing recent-files itself publishes its own snapshot over the others; use recentFileList.',
		},
	},
	'removing-a-recent-entry-keeps-the-tab': {
		files: [VIEWER],
		ban: {
			"FunctionDeclaration[id.name='removeRecentFile'] CallExpression[callee.property.name='closeTab']":
				'The × on a recent entry closed the tab with no unsaved-changes prompt.',
		},
	},

	// ---------------------------------------------------------------- test suite
	'tests-read-through-source-tree': {
		files: ['scripts/**/*.ts'],
		ignores: ['scripts/sourceTree.ts'],
		ban: {
			"CallExpression[callee.name=/^(readFileSync|readdirSync)$/], CallExpression[callee.property.name=/^(readFileSync|readdirSync)$/]":
				'Read with readSource / walkSourceFiles (scripts/sourceTree.ts): they decide the line ending and path separator once, so a Windows checkout does not go red (#452).',
		},
	},
};

const SOURCE = ['src/**/*.{ts,js,svelte}'];

export default [
	{ ignores: ['.svelte-kit/**', 'build/**', 'node_modules/**', 'src-tauri/**', 'static/**'] },
	...svelte.configs.base,
	{
		files: ['**/*.ts', '**/*.js', '**/*.mjs'],
		languageOptions: { parser: tseslint.parser },
	},
	{
		files: ['**/*.svelte', '**/*.svelte.ts'],
		languageOptions: { parserOptions: { parser: tseslint.parser } },
	},
	{
		linterOptions: { reportUnusedDisableDirectives: 'error' },
		plugins: {
			markpad: {
				rules: Object.fromEntries(
					Object.entries(CONVENTIONS).map(([name, c]) => [name, c.custom ?? convention(c)]),
				),
			},
		},
	},
	...Object.entries(CONVENTIONS).map(([name, c]) => ({
		files: c.files ?? SOURCE,
		ignores: c.ignores ?? [],
		rules: { [`markpad/${name}`]: 'error' },
	})),
];
