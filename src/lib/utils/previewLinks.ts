import { getMarkdownLinkTarget, resolveMarkdownTargetPath, type MarkdownLinkTarget } from './markdownLinks.js';
import { resolveLocalFileLinkPath } from './localFileLinks.js';
import { isSameFilePath } from './pathIdentity.js';

export interface PreviewClickDeps {
	hideTooltip(): void;
	toggleFold(target: HTMLElement): boolean;
	scrollToAnchor(id: string): Promise<unknown>;
	opensInNewTab(e: MouseEvent): boolean;
	openInNewTab(target: MarkdownLinkTarget): Promise<void>;
	openHere(target: MarkdownLinkTarget): Promise<void>;
	zoom(data: { src?: string; html?: string }): void;
	placeCursor(e: MouseEvent): void;
}

/** The preview `<article>`'s click handler. */
export async function handlePreviewClick(e: MouseEvent, deps: PreviewClickDeps) {
	const target = e.target as HTMLElement;

	// The hover preview describes the element under the cursor, and only
	// `mouseout` takes it down. A click that replaces the document removes
	// that element while the cursor is still on it, and removing a node
	// dispatches no `mouseout` — so the box was left on screen until the
	// pointer happened to cross another link. Dropping it here, before any
	// branch, is the same thing a browser does with its own link preview:
	// the click is the moment the description stops being about anything.
	deps.hideTooltip();

	// Fold toggle: the heading's chevron, or a foldable callout's whole title
	// bar. One branch for both, because they are one feature — the callout's
	// own branch used to toggle the classes and stop there, so a folded
	// callout re-opened on the next render while a folded heading did not.
	if (deps.toggleFold(target)) {
		if (e.detail > 1) e.preventDefault(); // prevent double-click selection
		e.stopPropagation();
		return;
	}

	const a = target.closest('a');
	if (a) {
		const href = a.getAttribute('href');
		if (href?.startsWith('#') && href.length > 1) {
			e.preventDefault();
			await deps.scrollToAnchor(href.substring(1));
			return;
		}

		const relativeMarkdownTarget = href ? getMarkdownLinkTarget(href) : null;
		if (relativeMarkdownTarget) {
			e.preventDefault();
			e.stopPropagation();
			// Which of the two this is depends on the setting and the chord
			// together — the chord means "the other one". Opening a tab goes
			// through `addTab`, which already resolves a file that is open to
			// the tab holding it, so one gesture answers both halves of #661:
			// a new tab, or the one that already has the file.
			if (deps.opensInNewTab(e)) {
				await deps.openInNewTab(relativeMarkdownTarget);
			} else {
				await deps.openHere(relativeMarkdownTarget);
			}
			return;
		}

		// Every other link is opened by `handleDocumentClick` on `document`,
		// and SvelteKit's router sits in between (on
		// `document.documentElement`), claiming any same-origin href whose
		// click nobody else has: `[a](Files/a.pdf)` became a client-side
		// navigation to a route that does not exist, and its 404 page
		// replaced the app — including the title bar it draws, which on
		// Windows is the only way to close the window (#772). The router
		// bails on `event.defaultPrevented`.
		e.preventDefault();
		return;
	}

	// media zoom handling
	const img = target.closest('img');
	if (img) {
		deps.zoom({ src: img.src });
		return;
	}

	const mermaidDiv = target.closest('.mermaid-diagram');
	if (mermaidDiv) {
		const svg = mermaidDiv.querySelector('svg');
		if (svg) {
			// clone and strip fixed dimensions so viewBox governs scaling
			const clone = svg.cloneNode(true) as SVGElement;
			clone.removeAttribute('width');
			clone.removeAttribute('height');
			clone.style.width = '';
			clone.style.height = '';
			deps.zoom({ html: clone.outerHTML });
			return;
		}
	}

	deps.placeCursor(e);
}

export interface DocumentLinkDeps {
	currentFile: string;
	openHere(target: MarkdownLinkTarget): Promise<void>;
	openWithSystem(path: string): Promise<void>;
	openUrl(url: string): Promise<void>;
	/** Reports a link that could not be opened, named as the document wrote it. */
	openFailed(rawHref: string): void;
}

/** What a click on a link anywhere in the document opens, once the preview declined it. */
export async function followDocumentLink(event: MouseEvent, anchor: HTMLAnchorElement, deps: DocumentLinkDeps) {
	const rawHref = anchor.getAttribute('href');
	if (!rawHref) return;

	if (rawHref.startsWith('#')) return;

	const relativeMarkdownTarget = getMarkdownLinkTarget(rawHref);
	if (relativeMarkdownTarget) {
		event.preventDefault();
		await deps.openHere(relativeMarkdownTarget);
		return;
	}

	// A link to a local non-markdown file (`[data](./data.csv)`) is a
	// path, and `anchor.href` is not: the DOM resolved it against the
	// webview origin. Hand the OS the resolved disk path instead.
	const localFilePath = resolveLocalFileLinkPath(rawHref, deps.currentFile);
	if (localFilePath) {
		event.preventDefault();
		await deps.openWithSystem(localFilePath);
		return;
	}

	if (anchor.href) {
		event.preventDefault();
		// `openUrl` rejects anything outside the opener plugin's scope
		// (`mailto:`, `tel:`, `http://*`, `https://*`). Without this the
		// rejection was unhandled: the click did nothing, said nothing,
		// and left an uncaught promise rejection behind.
		try {
			await deps.openUrl(anchor.href);
		} catch (error) {
			console.error('Failed to open link', anchor.href, error);
			deps.openFailed(rawHref);
		}
	}
}

export interface SystemOpenDeps {
	isLaunchable(path: string): Promise<boolean>;
	reveal(path: string): Promise<unknown>;
	openPath(path: string): Promise<void>;
	revealed(path: string): void;
	openFailed(path: string): void;
}

/**
 * Hands a file Markpad does not edit to the OS: a document link to
 * `data.csv`, or a non-Markdown file clicked in the folder sidebar.
 */
export async function openWithSystem(path: string, deps: SystemOpenDeps) {
	try {
		// The OS default handler runs a program (`./setup.command`,
		// `Calculator.app`, `x.exe`) rather than showing it, so one
		// click on a document's link would launch it. Reveal it instead.
		if (await deps.isLaunchable(path)) {
			await deps.reveal(path);
			deps.revealed(path);
			return;
		}
		await deps.openPath(path);
	} catch (error) {
		console.error('Failed to open local file', path, error);
		deps.openFailed(path);
	}
}

export interface RelativeTargetDeps {
	currentFile: string;
	canonicalizePath(path: string): Promise<string | undefined>;
	scrollToAnchorWhenReady(anchor: string, options?: { pushHistory?: boolean }, expectedFile?: string): Promise<unknown>;
	scrollToTop(): void;
	activeTabId: string | null;
	canCloseTab(tabId: string): Promise<boolean>;
	loadMarkdown(path: string): Promise<unknown>;
}

export async function openRelativeMarkdownTarget(target: MarkdownLinkTarget, deps: RelativeTargetDeps) {
	const from = deps.currentFile;
	const resolved = resolveMarkdownTargetPath(from, target);
	if (!resolved) return;
	// The same file, not the same string: `readme.md#a` inside `Readme.md`
	// on macOS, or a link through a symlink, is a jump within this document,
	// not a reload that asks to discard its unsaved edits.
	const [resolvedKey, fromKey] = await Promise.all([deps.canonicalizePath(resolved), deps.canonicalizePath(from)]);
	if (isSameFilePath({ path: resolved, pathKey: resolvedKey }, { path: from, pathKey: fromKey })) {
		if (target.hash) {
			await deps.scrollToAnchorWhenReady(target.hash);
		} else {
			deps.scrollToTop();
		}
		return;
	}
	if (deps.activeTabId && !(await deps.canCloseTab(deps.activeTabId))) return;
	await deps.loadMarkdown(resolved);
	if (target.hash) {
		await deps.scrollToAnchorWhenReady(target.hash, { pushHistory: false }, resolved);
	}
}

export interface LinkTooltip {
	text: string;
	html: string;
	isFootnote: boolean;
}

/**
 * What the hover preview says about a link: the target heading's text, the
 * footnote's body, or the href as the document wrote it. `null` shows nothing.
 */
export function linkTooltipFor(
	anchor: HTMLAnchorElement,
	deps: { findAnchorTarget(id: string): Element | null; footnoteRoot: ParentNode | null | undefined },
): LinkTooltip | null {
	const rawHref = anchor.getAttribute('href') || '';

	// tooltip for same-page anchor links: show text of target header
	if (rawHref.startsWith('#')) {
		const el = deps.findAnchorTarget(rawHref.substring(1));
		if (el) {
			// Use data-label if it's a block anchor, otherwise use textContent
			let text = el.getAttribute('data-label') || el.textContent || '';
			text = text.replace(/↩.*$/, '').trim(); // remove backrefs if any
			if (text) return { text, html: '', isFootnote: false };
		}
		return null;
	}

	// footnote references: show footnote content instead of URL
	if (anchor.hasAttribute('data-footnote-ref') || anchor.closest('[data-footnote-ref]') || rawHref.match(/#fn-|#fnref-|#user-content-fn/)) {
		const fnId = rawHref.replace(/^#/, '');
		const fnLi = deps.footnoteRoot?.querySelector(`#${CSS.escape(fnId)}`) ||
		              deps.footnoteRoot?.querySelector(`li#${CSS.escape(fnId)}`);
		if (fnLi) {
			// clone to remove backref arrow from tooltip
			const clone = fnLi.cloneNode(true) as HTMLElement;
			const backrefs = clone.querySelectorAll('.footnote-backref, a[href^="#fnref-"]');
			backrefs.forEach(b => b.remove());

			let fnHtml = clone.innerHTML.trim();
			if (fnHtml) return { text: '', html: fnHtml, isFootnote: true };
		}
	}

	// The raw href. The DOM-resolved one starts with `tauri://localhost`.
	return rawHref ? { text: rawHref, html: '', isFootnote: false } : null;
}
