/**
 * The two-condition fix for IME jitter in the editor (#724), applied to the
 * bundled Monaco at build time until upstream ships it.
 *
 * In a browser without `EditContext` — WKWebView, so every macOS build of this
 * app — Monaco takes input through a hidden textarea. During IME composition
 * that textarea becomes a one-row overlay on the composed line, yet it holds a
 * page of text, so Monaco scrolls it to the caret's row. WebKit scrolls it back
 * to "caret just visible" on every composition update, 3px short of the row,
 * and the next render scrolls it forward again: the composed text sinks and
 * snaps back on every keystroke. Monaco's own write path already treats
 * `accessibilitySupport: 'auto'` in a browser as "no screen reader" and skips
 * render-time writes (vscode#192278); the content path disagreed and handed the
 * same state a page. Making the two agree leaves the overlay with one short
 * line, no overflow, and nothing for the browser to scroll.
 *
 * Upstream: microsoft/monaco-editor#4796, fixed by microsoft/vscode#333909.
 * Once a Monaco release carries that change, delete this file, the plugin in
 * vite.config.js and monacoImePatch.test.ts. Until then the build fails
 * loudly the moment either anchor stops matching exactly once — which is
 * what a Monaco bump that already has the fix will do.
 */

/** The file inside monaco-editor's ESM tree that owns the textarea. */
export const MONACO_TEXTAREA_FILE = 'textAreaEditContext.js';

/**
 * Each anchor is a whole source line of the installed Monaco, indentation
 * included, so it cannot match a similar line in another function.
 */
export const MONACO_IME_PATCH = [
	{
		// getScreenReaderContent: what is written into the textarea.
		from: '                if (this._accessibilitySupport === 1 /* AccessibilitySupport.Disabled */) {\n',
		to: '                if (this._accessibilitySupport !== 2 /* AccessibilitySupport.Enabled */) {\n',
	},
	{
		// _setAccessibilityOptions: whether the textarea is sized to wrap a page.
		from: '        if (wrappingColumn !== -1 && this._accessibilitySupport !== 1 /* AccessibilitySupport.Disabled */) {\n',
		to: '        if (wrappingColumn !== -1 && this._accessibilitySupport === 2 /* AccessibilitySupport.Enabled */) {\n',
	},
];

/**
 * Apply the patch to the source of `MONACO_TEXTAREA_FILE`. Throws, rather than
 * returning the input unchanged, when an anchor does not match exactly once:
 * a patch that silently stops applying is the defect coming back with the
 * comment still promising it is fixed.
 * @param {string} code
 * @returns {string}
 */
export function patchMonacoTextAreaForIme(code) {
	for (const { from, to } of MONACO_IME_PATCH) {
		const hits = code.split(from).length - 1;
		if (hits !== 1) {
			throw new Error(
				`monaco IME patch: expected exactly one match for ${JSON.stringify(from.trim())}, found ${hits}. ` +
					'Monaco changed under the patch — check whether microsoft/vscode#333909 shipped, and delete the patch if it did.',
			);
		}
		code = code.replace(from, to);
	}
	return code;
}

/** The Vite plugin: the patch, applied to that one file and nothing else. */
export const monacoImePatch = {
	name: 'monaco-ime-patch',
	/** @param {string} code @param {string} id */
	transform(code, id) {
		if (!id.endsWith(MONACO_TEXTAREA_FILE)) return null;
		return { code: patchMonacoTextAreaForIme(code), map: null };
	},
};
