import DOMPurify from 'dompurify';

import { MARKDOWN_LINK_EXTENSIONS } from './markdownLinks.js';

// The Rust renderer runs comrak with `render.unsafe_ = true`, so whatever raw
// HTML a document author wrote survives into the rendered output verbatim. A
// `.md` file is untrusted input — it can arrive by download, by shared folder,
// or as an email attachment — so every consumer of that output has to run it
// through the same filter. Keeping the policy in one module is what makes
// "every consumer" checkable: the preview and the HTML export must not be able
// to drift apart, because a payload that is invisible on screen but live in an
// exported file is worse than one the user can see.

// The extension set `hasMarkdownLinkExtension` accepts, spliced into a URI
// pattern rather than called as a predicate — DOMPurify takes a regexp, not a
// function. Re-exported because MarkdownViewer.svelte reads the same list for
// the Open dialog's file filter and imports it from the sanitizer; the list
// itself is defined once, in ./markdownLinks.ts.
export { MARKDOWN_LINK_EXTENSIONS };

const markdownLinkExtensionPattern = MARKDOWN_LINK_EXTENSIONS
	.map((ext) => ext.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
	.join('|');

// Widens DOMPurify's default URI allowlist in exactly two directions and no
// others:
//   - Windows drive paths that point at another markdown document
//     (`C:\notes\other.md`), which the viewer opens as an internal navigation
//     and the export rewrites to `.html`;
//   - the `asset:` and `tauri:` schemes, which `convertFileSrc` produces for
//     local images.
// Everything else falls back to DOMPurify's own shape: a relative path, a
// fragment, or one of the listed network/communication schemes. `javascript:`,
// `data:`, `vbscript:` and friends match none of the alternatives and are
// dropped along with the attribute that carried them.
export const ALLOWED_MARKDOWN_URI_REGEXP = new RegExp(
	`^(?:(?:[a-z]:[^?#]*\\.(?:${markdownLinkExtensionPattern})(?:[?#].*)?$)|(?:(?:f|ht)tps?|mailto|tel|callto|sms|cid|xmpp|asset|tauri):|[^a-z]|[a-z+.\\-]+(?:[^a-z+.\\-:]|$))`,
	'i',
);

// `<style>` is on DOMPurify's default allowlist, and DOMPurify does not filter
// the CSS inside it. In the preview the sanitized HTML is injected into the
// app's own document, so a document author's stylesheet is not scoped to the
// article: it can hide the title bar (`.titlebar { display: none }`) or turn
// any selector into an outbound beacon (`background: url(https://attacker/…)`).
// Markdown itself has no `<style>` construct and nothing in Markpad emits one
// into rendered content — the app's stylesheets, KaTeX and highlight.js are all
// loaded as real stylesheets, and Mermaid's inline `<style>` goes through the
// separate diagram sanitizer — so forbidding the tag costs no existing feature.
// Inline `style` attributes stay allowed: they are scoped to one element and
// documents do use them (`<img style="width:50%">`, centered `<div>`s), so
// removing them would visibly break existing files.
export const MARKDOWN_SANITIZE_CONFIG = {
	ALLOWED_URI_REGEXP: ALLOWED_MARKDOWN_URI_REGEXP,
	FORBID_TAGS: ['style'],
};

/**
 * Runs untrusted rendered-markdown HTML through the single shared policy.
 *
 * Call this on the output of the `render_markdown` command, before any
 * Markpad-owned transformation of that HTML.
 */
export function sanitizeMarkdownHtml(html: string): string {
	return DOMPurify.sanitize(html, MARKDOWN_SANITIZE_CONFIG);
}
