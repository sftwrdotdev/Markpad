import type * as Monaco from 'monaco-editor';

/**
 * One Monaco `ITextModel` per tab, and the disposal that has to go with it.
 *
 * WHY A MODEL PER TAB. A model is Monaco's document: the text, its language,
 * its decorations and — the reason this module exists — its undo stack. One
 * model shared by every tab meant a tab switch had to overwrite it with
 * `setValue`, and `setValue` is *defined* to throw the undo stack away
 * (`TextModel._setValueFromTextBuffer` → `this._commandManager.clear()`, under
 * the comment "Destroy my edit history and settings"). So every switch away
 * from a document and back cost the user their undo history (#391). Giving each
 * tab its own model and switching with `editor.setModel(...)` is Monaco's
 * intended usage and how VS Code itself works — undo then belongs to the
 * document rather than to whichever tab happens to be on screen.
 *
 * WHY THE MAP LIVES HERE AND NOT ON THE TAB. `Tab` is a plain data record in a
 * store that is imported by the whole app, and Monaco is loaded with a dynamic
 * `import()` from `Editor.svelte` precisely so it stays out of the startup
 * chunk (~86% of the startup JavaScript; test.yml checks the built chunks).
 * A model field on `Tab` would either put Monaco back in that graph or type the
 * field as `any`. This module keeps the models, imports Monaco for its TYPES
 * only — `import type` is erased, so it costs nothing at runtime and adds no
 * static edge to the module graph — and lets the two sides own what each is
 * actually responsible for: `Editor.svelte` creates models, because it is the
 * only place that has Monaco; `TabManager` reaps them, because it is the only
 * place that knows a tab is gone.
 *
 * LIFETIME. Monaco models are registered with the editor's model service and
 * are NOT garbage collected while registered: a model that is dropped without
 * `dispose()` keeps its whole text buffer, its tokenization state and its
 * worker-side copy alive for the life of the window. So the invariant this
 * module exists to hold is:
 *
 *     the set of live models is exactly the set of live tabs
 *
 * and it is held by reconciliation (`retainTabModels`), not by a matching
 * `dispose()` at each of the places a tab can disappear. Tabs are removed by
 * the close button, ⌘W, "close others", "close to the right", a clean tab
 * losing its path to another tab (`claimPath`), a tab moving to another window,
 * a failed transfer being rolled back, `closeAll`, and a session restore
 * REPLACING the whole tab array. Pairing a dispose with each of those is eight
 * chances to forget; asking "which models no longer have a tab?" after each of
 * them is one rule that a ninth route cannot silently escape.
 */

type TextModel = Monaco.editor.ITextModel;

const models = new Map<string, TextModel>();

/**
 * The URI a tab's model is registered under.
 *
 * Keyed by TAB ID, not by file path, for three reasons that each rule the path
 * out on its own:
 *
 * - a path is not stable for the life of a tab. Save As, rename, following a
 *   link and back/forward all repoint a tab at another file, and a model's URI
 *   cannot be changed after creation — so a path-keyed registry would have to
 *   dispose and rebuild the model on every one of those, throwing away the undo
 *   history this module exists to preserve on the two (Save As, rename) where
 *   the text on screen never changed at all.
 * - untitled tabs have no path, and several of them are normal.
 * - `monaco.editor.createModel` throws on a duplicate URI. A tab id is a UUID,
 *   so two tabs can never collide, whatever they hold.
 *
 * `inmemory:` rather than `file:` because these models are not the file: the
 * buffer can be dirty, truncated, or a lossy decode of bytes that are not
 * UTF-8, and nothing in Monaco should be tempted to treat the URI as something
 * it can read from or write to.
 */
export function tabModelUri(tabId: string): string {
	return `inmemory://markpad/${tabId}`;
}

/**
 * This tab's model, created on first use.
 *
 * `create` is a callback rather than a `(value, language)` pair because this
 * module has no Monaco at runtime — the caller in `Editor.svelte` holds the
 * dynamically imported namespace and builds the model with it.
 *
 * A model already in the map is re-checked with `isDisposed()`: handing back a
 * disposed model would throw on the first read (`_assertNotDisposed`), and the
 * one thing that can dispose a model out from under this map is Monaco itself,
 * which is not something a caller can be asked to keep track of.
 */
export function getTabModel(tabId: string, create: () => TextModel): TextModel {
	const existing = models.get(tabId);
	if (existing && !existing.isDisposed()) return existing;

	const model = create();
	models.set(tabId, model);
	return model;
}

/**
 * Dispose every model whose tab is gone — the whole of the lifetime scheme.
 *
 * Called with the ids of the tabs that still exist, so the answer is derived
 * from the tab list rather than from remembering which tab was just removed.
 * That is what makes it total: a route that closes a tab in some way nobody has
 * thought of yet still leaves a tab list without that id in it.
 *
 * Disposing the model the editor currently has attached is safe and does not
 * need special-casing here: `CodeEditorWidget._attachModel` registers
 * `model.onWillDispose(() => this.setModel(null))`, so the editor detaches
 * itself, and the effect in `Editor.svelte` attaches the newly active tab's
 * model in the same flush. Verified in the bundled Monaco (0.55.1).
 */
export function retainTabModels(liveTabIds: Iterable<string>): void {
	const live = new Set(liveTabIds);

	for (const [tabId, model] of [...models]) {
		if (live.has(tabId)) continue;
		models.delete(tabId);
		if (!model.isDisposed()) model.dispose();
	}
}

/**
 * The tab ids that currently hold a model.
 *
 * Exported for the lifetime test, which asserts the invariant above directly —
 * "every model created is disposed, over every path that closes a tab" — rather
 * than asserting that some particular call site spells `dispose()`. A leak is
 * invisible until it is not, so the check has to be the invariant itself.
 */
export function trackedTabModelIds(): string[] {
	return [...models.keys()];
}

/**
 * What the status bar calls this document's line ending.
 *
 * The model's own EOL, not a detector run over the text, because the model IS
 * the document once it is open and Monaco has already decided this: the buffer
 * builder counts the endings in the source and rewrites the WHOLE buffer to the
 * majority one (ties go to LF) before the model exists — verified against the
 * bundled Monaco 0.55.1 in `documents.test.ts`. So a mixed-ending file is
 * no longer mixed by the time anything can be shown about it, `getEOL()` is
 * both what the buffer contains and what a save writes out, and asking a second
 * question of `getValue()` could only ever produce a different answer by being
 * wrong.
 *
 * That also settles `detectLineEnding` in `utils/frontMatter.ts`, which is
 * first-CRLF-wins: it is not a rival to this and must not be lifted into one.
 * It answers "which ending do I emit when rewriting this string's front matter
 * block" about a string it is handed — normalized content, where any `\r\n`
 * means every ending is `\r\n`, so the two agree wherever both can see the same
 * document.
 *
 * Typed on the one method it calls rather than on `ITextModel` so the test can
 * drive it with a real Monaco text buffer, which has an EOL but is not a model.
 */
export function lineEndingLabel(model: Pick<TextModel, 'getEOL'>): 'LF' | 'CRLF' {
	return model.getEOL() === '\r\n' ? 'CRLF' : 'LF';
}
