import { getFrontMatterListItems, type FrontMatterParseResult } from './frontMatter.js';
import { resolvePath } from './markdown.js';
import { MARKDOWN_LINK_EXTENSION_PATTERN } from './markdownLinks.js';

const windowsDrivePathPattern = /^[a-zA-Z]:[\\/]/;

export function escapeHtml(value: string): string {
	return value
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&#39;');
}

function hasNonFileScheme(value: string): boolean {
	return /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(value) && !windowsDrivePathPattern.test(value);
}

function splitUrlSuffix(value: string): { base: string; suffix: string } {
	const queryIndex = value.indexOf('?');
	const hashIndex = value.indexOf('#');
	const indexes = [queryIndex, hashIndex].filter((index) => index >= 0);
	const splitIndex = indexes.length > 0 ? Math.min(...indexes) : -1;

	if (splitIndex === -1) return { base: value, suffix: '' };
	return {
		base: value.slice(0, splitIndex),
		suffix: value.slice(splitIndex),
	};
}

function decodePath(value: string): string {
	try {
		return decodeURIComponent(value);
	} catch {
		return value;
	}
}

function normalizeUrlPathname(pathname: string): string {
	let path = decodePath(pathname);

	if (/^\/[a-zA-Z]:\//.test(path)) {
		path = path.slice(1);
	} else if (path.startsWith('/\\\\')) {
		path = path.slice(1);
	} else if (path.startsWith('//')) {
		path = path.slice(1);
	}

	return path;
}

// `convertFileSrc` does not produce the same shape everywhere: Windows (and
// Android) get `http://asset.localhost/<encoded path>`, every other platform
// gets `asset://localhost/<encoded path>`. The app's own CSP lists both. Missing
// the `asset.localhost` form meant no local image was ever inlined on Windows.
const assetHostPattern = /^https?:\/\/asset\.localhost(?:\/|$)/i;
const assetSchemePattern = /^asset:/i;

export function isAssetUrl(src: string): boolean {
	return assetSchemePattern.test(src) || assetHostPattern.test(src);
}

export function normalizeAssetPath(src: string): string | null {
	if (!isAssetUrl(src)) return null;

	try {
		const url = new URL(src);
		return normalizeUrlPathname(url.pathname);
	} catch {
		const path = src
			.replace(/^asset:\/\/localhost\/?/i, '')
			.replace(/^https?:\/\/asset\.localhost\/?/i, '');
		return normalizeUrlPathname('/' + path);
	}
}

export function resolveExportImagePath(src: string, tabPath: string): string | null {
	const trimmed = src.trim();
	if (!trimmed) return null;
	// Must run before the remote-scheme bail-out: the Windows asset URL *is* an
	// `http:` URL, and bailing out early skipped both the inlining and the
	// `missingImages` counter, so the export silently shipped dead links.
	const assetPath = normalizeAssetPath(trimmed);
	if (assetPath) return assetPath;

	if (/^(?:https?:|data:|blob:)/i.test(trimmed)) return null;

	if (/^file:/i.test(trimmed)) {
		try {
			return normalizeUrlPathname(new URL(trimmed).pathname);
		} catch {
			return null;
		}
	}

	if (hasNonFileScheme(trimmed)) return null;

	const { base } = splitUrlSuffix(trimmed);
	const decoded = decodePath(base);
	if (windowsDrivePathPattern.test(decoded) || decoded.startsWith('\\\\') || decoded.startsWith('/')) {
		return decoded.replace(/\\/g, '/');
	}

	return resolvePath(tabPath, decoded);
}

export function rewriteMarkdownHrefForExport(href: string): string {
	const trimmed = href.trim();
	if (!trimmed || hasNonFileScheme(trimmed)) return href;

	const { base, suffix } = splitUrlSuffix(trimmed);
	if (!MARKDOWN_LINK_EXTENSION_PATTERN.test(base)) return href;

	return base.replace(MARKDOWN_LINK_EXTENSION_PATTERN, '.html') + suffix;
}

export function renderStaticFrontMatterPanel(frontMatter: FrontMatterParseResult): string {
	if (!frontMatter.exists) return '';

	const count = frontMatter.valid ? frontMatter.fields.length : 0;
	const rows = frontMatter.valid
		? frontMatter.fields
			.map((field) => {
				const key = escapeHtml(field.key);
				const value = field.kind === 'list'
					? `<div class="frontmatter-tags">${getFrontMatterListItems(field)
						.map((item) => `<span class="frontmatter-tag">${escapeHtml(item)}</span>`)
						.join('')}</div>`
					: `<span class="frontmatter-static-value">${escapeHtml(field.displayValue)}</span>`;

				return `<div class="frontmatter-key">${key}</div><div class="frontmatter-value">${value}</div>`;
			})
			.join('')
		: `<div class="frontmatter-error">${escapeHtml(frontMatter.error || 'Invalid frontmatter')}</div>`;

	return `<details class="frontmatter-panel export-frontmatter-panel">
<summary class="frontmatter-summary">
<span class="frontmatter-chevron" aria-hidden="true">›</span>
<span class="frontmatter-title">Properties</span>
<span class="frontmatter-count">${count}</span>
</summary>
<div class="frontmatter-grid">${rows}</div>
</details>`;
}
