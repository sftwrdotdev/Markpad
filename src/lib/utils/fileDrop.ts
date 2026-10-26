/**
 * What to do with a file dropped on a pane.
 *
 * The two panes used to decide this in two `if` chains inside the window-level
 * drag-drop callback, and only one of them was complete: the editor's looked
 * for an image extension and silently discarded everything else, so dropping a
 * `.md` there did nothing at all while the identical drop on the preview
 * opened it.
 *
 * A decision, extracted, is a decision that can be driven — the callback it
 * came from is fed by a Tauri window event this suite cannot emit, so as long
 * as the routing lived inside it, the only available check was reading the
 * source and hoping.
 */
import { hasMarkdownLinkExtension } from './markdownLinks.js';

/** The pane under the pointer, as the drag handler tracks it. */
export type DropPane = 'editor' | 'preview';

export type DropAction =
	/** Insert a reference at the caret — the editor pane's own answer. */
	| 'insert'
	/** Open it, in a tab. What a document does wherever it lands. */
	| 'open'
	/** Nothing here can hold it; say so instead of dropping it on the floor. */
	| 'unsupported';

/**
 * What `Editor.handleDroppedFile` can turn into a reference. Deliberately not
 * "anything an `<img>` can display": each of these has a Markdown spelling the
 * editor writes, and a file the editor cannot write is a file the reader
 * should be told about rather than one that vanishes.
 */
export const DROPPABLE_IMAGE_EXTENSIONS = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'];

function isDroppableImage(path: string): boolean {
	const extension = path.split('.').pop()?.toLowerCase();
	return extension !== undefined && DROPPABLE_IMAGE_EXTENSIONS.includes(extension);
}

/**
 * Which pane a drop is routed as, given the pane the pointer was tracked over.
 * Anywhere but the editor — the preview, or outside both panes (the tab strip,
 * the title bar) — answers as the preview does: a document opens, anything else
 * is reported. The same in every view mode.
 */
export function dropPaneFor(target: DropPane | null, hasEditor: boolean): DropPane {
	return target === 'editor' && hasEditor ? 'editor' : 'preview';
}

export function routeDroppedFile(path: string, pane: DropPane): DropAction {
	// An image goes INTO the text, and only where there is text to go into.
	// On the preview there is no caret, so it is reported rather than inserted.
	if (pane === 'editor' && isDroppableImage(path)) return 'insert';

	if (hasMarkdownLinkExtension(path)) return 'open';

	return 'unsupported';
}

/**
 * Which label a pane's drop zone shows while `paths` hover over the window.
 * Asked of the same routing the drop itself uses, so the zone cannot promise
 * an embed for a document the drop will open (#928).
 */
export function dropZoneLabel(paths: readonly string[], pane: DropPane): 'embed' | 'open' {
	return paths.some((path) => routeDroppedFile(path, pane) === 'insert') ? 'embed' : 'open';
}

export interface DropActions {
	insert(path: string): void;
	open(path: string): void;
	unsupported(path: string): void;
}

/**
 * Act on a drop: every path is routed through `routeDroppedFile` for the pane
 * the drop resolves to, and each of the three answers is acted on. The editor's
 * branch used to look for an image and silently discard everything else, so a
 * `.md` dropped there did nothing at all while the same drop on the preview
 * opened it.
 */
export function handleDrop(
	paths: readonly string[],
	target: DropPane | null,
	hasEditor: boolean,
	actions: DropActions,
): void {
	const pane = dropPaneFor(target, hasEditor);
	for (const path of paths) actions[routeDroppedFile(path, pane)](path);
}
