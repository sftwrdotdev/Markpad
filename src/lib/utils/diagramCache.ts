/**
 * A memo for rendered Mermaid diagrams, keyed by the only two inputs that
 * decide what Mermaid draws: the diagram source and the theme.
 *
 * Why this exists: `mermaid.render` is by far the slowest part of a preview
 * render (on a 44-diagram document, ~2.3s against ~30ms for everything else),
 * and the same source and theme come back often: a theme toggled back, a block
 * the patch re-inserts, a tab reopened.
 *
 * ## The one hard part: the svg id is baked into the output
 *
 * Mermaid's renderer, given an id and a source, does not return an
 * id-independent string. (This module never calls it — `richContent.ts` is the
 * one render site, and `singleImplementationConvention.test.ts` keeps it that
 * way.) The id it is given prefixes the diagram's `<style>` selectors (`#id
 * .node rect{…}`),
 * every arrow marker's `id`, and every `url(#id_flowchart-v2-pointEnd)` that
 * points at one. Handing the same bytes back for a second diagram would put a
 * duplicate id in the document; handing back a *stale* id would be fine on its
 * own but is indistinguishable, from the DOM's point of view, from the first
 * case once the same document holds two copies of one diagram.
 *
 * So the cache does not store a rendered diagram. It stores a *template*: the
 * rendered string with the render id lifted out into a slot. Each use fills the
 * slot with the fresh id the caller's `idFactory` produced, so the reused SVG is
 * as uniquely identified as a freshly rendered one, and — for every diagram type
 * whose ids Mermaid already prefixes with the svg id — byte-identical to one.
 *
 * ## Ids Mermaid does *not* prefix
 *
 * Sequence diagrams are the exception: their actor groups get ids from a module
 * counter (`actor44`, `root-44`), not from the svg id. Those are declarations
 * that nothing in the SVG points at, so the template renames them into the slot
 * too (`<slot>-actor44`) and they stay unique per copy. If a future Mermaid
 * starts *referencing* one of them, `templateDiagramSvg` sees the reference and
 * refuses to build a template at all: that diagram then renders fresh every
 * time, which is exactly the behaviour this module replaced. Slower, never
 * wrong.
 */

/**
 * The placeholder the render id is lifted into. The only way this could collide
 * with real content is a diagram whose own text spells it out, and
 * `templateDiagramSvg` refuses to build a template in exactly that case — so a
 * filled slot can never be mistaken for content.
 */
const ID_SLOT = '{{markpad-diagram-id}}';

const DECLARED_ID = /\sid="([^"]*)"/g;

function escapeForRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Turns one rendered SVG into a reusable template, or returns `null` if it
 * cannot be proven safe to reuse.
 *
 * `renderId` is the id the SVG was rendered with. Everything derived from it is
 * replaced by the slot; every other declared id is moved under the slot so two
 * copies of the same diagram cannot collide.
 */
export function templateDiagramSvg(svg: string, renderId: string): string | null {
	if (!renderId || svg.includes(ID_SLOT)) return null;
	// Not the shape this module knows how to re-id. Better to render again than
	// to guess.
	if (!svg.includes(`id="${renderId}"`)) return null;

	let template = svg.split(renderId).join(ID_SLOT);

	const declared = new Set<string>();
	for (const match of svg.matchAll(DECLARED_ID)) declared.add(match[1]);

	for (const id of declared) {
		if (!id || id.includes(renderId)) continue;
		// This one is not namespaced by the render id. Renaming a declaration is
		// safe; rewriting references is not something this module tries to do, so
		// a referenced stray id means "do not cache".
		if (new RegExp(`#${escapeForRegExp(id)}(?![\\w-])`).test(svg)) return null;
		template = template.split(` id="${id}"`).join(` id="${ID_SLOT}-${id}"`);
	}

	return template;
}

/** Fills a template's slots with `svgId`. */
export function fillDiagramTemplate(template: string, svgId: string): string {
	return template.split(ID_SLOT).join(svgId);
}

/**
 * Upper bounds. The cache outlives a document and a tab — the preview keeps
 * rendering into the same window as the user switches files — so it needs a
 * ceiling that does not depend on anyone remembering to clear it.
 *
 * 2M characters is roughly 4MB of UTF-16. Measured against the document that
 * motivated this — 44 diagrams of assorted types — the whole document's
 * templates come to 1.02M characters, so the budget holds about two such
 * documents at once: the open tab, and the one before it. Toggling the theme on
 * a document that large can evict the other theme, which costs one slow render
 * and is what happened on every keystroke before this existed.
 *
 * The entry count is the second bound, for documents full of tiny diagrams.
 */
const MAX_ENTRIES = 128;
const MAX_CHARS = 2_000_000;

/**
 * Insertion order is the eviction order, and a hit re-inserts, which makes this
 * an LRU without a second data structure.
 */
const templates = new Map<string, string>();
let cachedChars = 0;

/**
 * Injective in both parts, so a theme name that happens to be a prefix of a
 * diagram source cannot collide with one that is not.
 *
 * Nothing else belongs in the key. `renderRichContent` configures Mermaid with
 * `{ startOnLoad: false, theme }` and nothing more, and the Mermaid module
 * itself is loaded once per window — a version change means a new build means a
 * new window, and this Map is per module instance.
 */
function cacheKey(source: string, theme: string): string {
	return `${theme.length}:${theme}${source}`;
}

export function lookupDiagramTemplate(source: string, theme: string): string | null {
	const key = cacheKey(source, theme);
	const template = templates.get(key);
	if (template === undefined) return null;
	templates.delete(key);
	templates.set(key, template);
	return template;
}

export function storeDiagramTemplate(source: string, theme: string, template: string): void {
	// A single diagram that would evict everything else is not worth caching.
	if (template.length > MAX_CHARS / 4) return;

	const key = cacheKey(source, theme);
	const existing = templates.get(key);
	if (existing !== undefined) {
		templates.delete(key);
		cachedChars -= existing.length;
	}
	templates.set(key, template);
	cachedChars += template.length;

	for (const [oldest, value] of templates) {
		if (templates.size <= MAX_ENTRIES && cachedChars <= MAX_CHARS) break;
		if (oldest === key) break; // never evict what was just asked for
		templates.delete(oldest);
		cachedChars -= value.length;
	}
}

/**
 * Test seam, in the spirit of `idFactory`: the cache is module-level and
 * therefore process-wide, while a test wants to start from empty.
 */
export function resetDiagramCache(): void {
	templates.clear();
	cachedChars = 0;
}
