import { MARKDOWN_LINK_EXTENSIONS } from './markdownLinks.js';

// The Markdown entries come from the document list rather than being spelled
// out again: a hand-written copy here lacked `txt`, so a `.txt` note rendered
// as Markdown in the preview while the editor showed it as plain text.
const EDITOR_LANGUAGES: Record<string, string> = {
	js: 'javascript',
	jsx: 'javascript',
	ts: 'typescript',
	tsx: 'typescript',
	html: 'html',
	css: 'css',
	json: 'json',
	...Object.fromEntries(MARKDOWN_LINK_EXTENSIONS.map((ext) => [ext, 'markdown'])),
};

/** The Monaco language for a tab's path. An untitled buffer is Markdown. */
export function editorLanguageFor(path: string): string {
	if (!path) return 'markdown';
	const ext = path.split('.').pop()?.toLowerCase() ?? '';
	if (Object.hasOwn(EDITOR_LANGUAGES, ext)) return EDITOR_LANGUAGES[ext];
	return 'plaintext';
}
