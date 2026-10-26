import type * as Monaco from 'monaco-editor';

import { frontMatterFenceLines } from './frontMatter.js';
import { headingLinkContext, headingQueryStart, type HeadingAnchor } from './headingCompletion.js';
import { resolveImageDirectory } from './imageEmbed.js';

type Invoke = (command: string, args?: Record<string, unknown>) => Promise<unknown>;
type OutlineModel = Pick<Monaco.editor.ITextModel, 'getVersionId' | 'getValue'>;

/**
 * This document's headings, from the Rust side that renders them.
 *
 * Cached on the model's version, which changes on every edit: a completion
 * fires per keystroke once the dropdown is open, and re-parsing a
 * 3,000-line document for each of them would be paid for nothing — the
 * headings cannot have moved between two keystrokes of the same edit.
 *
 * Asked of Rust rather than derived here: the ids come out of comrak's
 * anchorizer, and a second implementation in TypeScript would drift from
 * it silently, producing links that look right and land nowhere.
 *
 * Keyed on the model as well: each tab has its own, and version ids are
 * counted per model, so two tabs can stand at the same one.
 *
 * The block folds come with them, from the same parse: the folding provider
 * wants both for every version. The promise is what is cached, so the
 * folding and symbol providers asking at once share one call.
 */
export type Outline = { anchors: HeadingAnchor[]; folds: Monaco.languages.FoldingRange[] };
export function createDocumentOutline(invoke: Invoke) {
	let outlineCache: { model: OutlineModel; version: number; outline: Promise<Outline> } | null = null;

	function documentOutline(model: OutlineModel): Promise<Outline> {
		const version = model.getVersionId();
		if (outlineCache?.model === model && outlineCache.version === version) return outlineCache.outline;

		const markdown = model.getValue();
		const outline = (
			invoke("markdown_outline", {
				markdown,
				frontMatterLines: frontMatterFenceLines(markdown),
			}) as Promise<Outline>
		).catch(() => ({ anchors: [], folds: [] }));
		outlineCache = { model, version, outline };
		return outline;
	}

	async function headingAnchors(model: OutlineModel): Promise<HeadingAnchor[]> {
		return (await documentOutline(model)).anchors;
	}

	return { documentOutline, headingAnchors };
}

/** The characters that open the editor's link-target completion; `#` asks for headings. */
export const MARKDOWN_COMPLETION_TRIGGERS = ["(", "/", "\\", '"', "#"];

export type MarkdownCompletionDeps = {
	monaco: Pick<typeof Monaco, 'Range'> & { languages: Pick<typeof Monaco.languages, 'CompletionItemKind'> };
	headingAnchors: (model: Monaco.editor.ITextModel) => Promise<HeadingAnchor[]>;
	invoke: Invoke;
	/** The active tab's path, if it has one. */
	activeTabPath: () => string | null | undefined;
	/** The image-directory setting. */
	imageDirectory: () => string;
};

/**
 * The Markdown completion provider: this document's headings after `](#` or
 * `[[#`, else file paths after a link, image or `src=` opener.
 */
export async function provideMarkdownCompletionItems(
	model: Monaco.editor.ITextModel,
	position: Monaco.Position,
	deps: MarkdownCompletionDeps,
): Promise<Monaco.languages.CompletionList> {
	const lineContent = model.getLineContent(position.lineNumber);
	const prefix = lineContent.substring(0, position.column - 1);

	// #200: this document's headings, as link targets. Asked
	// first because `](#` is also the tail of the embed context
	// below — once a `#` is typed the answer is headings, not
	// files.
	const headingContext = headingLinkContext(prefix);
	if (headingContext) {
		const anchors = await deps.headingAnchors(model);
		const range = new deps.monaco.Range(
			position.lineNumber,
			headingQueryStart(prefix) + 1,
			position.lineNumber,
			position.column,
		);

		return {
			suggestions: anchors.map((anchor, index) => ({
				// Labelled by what it reads as, inserted as
				// whatever that context needs. Monaco filters on
				// the label, so typing "mermaid" finds
				// "11. Mermaid Diagrams" and writes the slug.
				label: anchor.text,
				detail: `#${anchor.slug}`,
				kind: deps.monaco.languages.CompletionItemKind.Reference,
				insertText:
					headingContext === "slug" ? anchor.slug : anchor.text,
				// Document order, not alphabetical: a heading's
				// neighbours are what the writer is thinking in.
				sortText: String(index).padStart(5, "0"),
				range,
			})),
		};
	}

	const isEmbedContext = /(!?\[.*\]\(|<img.*src=["']|src=["'])$/.test(
		prefix,
	);
	if (!isEmbedContext) return { suggestions: [] };

	const path = deps.activeTabPath();
	if (!path) return { suggestions: [] };

	const lastSlash = Math.max(
		path.lastIndexOf("\\"),
		path.lastIndexOf("/"),
	);
	const parentDir = path.substring(0, lastSlash);
	const imgDirName = resolveImageDirectory(
		deps.imageDirectory(),
		path,
	);

	try {
		const [currentEntries, imgEntries] = await Promise.all([
			deps.invoke("list_directory_contents", { path: parentDir })
				.then((r) => r as string[])
				.catch(() => []),
			deps.invoke("list_directory_contents", { path: `${parentDir}/${imgDirName}` })
				.then((r) => r as string[])
				.catch(() => []),
		]);

		const word = model.getWordUntilPosition(position);
		const range = new deps.monaco.Range(
			position.lineNumber,
			word.startColumn,
			position.lineNumber,
			word.endColumn,
		);

		const suggestions: Monaco.languages.CompletionItem[] = [
			...currentEntries.map((e) => ({
				label: e,
				kind: e.endsWith("/")
					? deps.monaco.languages.CompletionItemKind.Folder
					: deps.monaco.languages.CompletionItemKind.File,
				insertText: e,
				range,
			})),
			...imgEntries.map((e) => ({
				label: `${imgDirName}/${e}`,
				kind: e.endsWith("/")
					? deps.monaco.languages.CompletionItemKind.Folder
					: deps.monaco.languages.CompletionItemKind.File,
				insertText: `${imgDirName}/${e}`,
				range,
			})),
		];

		return { suggestions };
	} catch (err) {
		return { suggestions: [] };
	}
}
