import { parseDocument } from 'yaml';

type FrontMatterValueKind = 'string' | 'number' | 'boolean' | 'list' | 'object' | 'null';

export type FrontMatterField = {
	key: string;
	value: unknown;
	kind: FrontMatterValueKind;
	displayValue: string;
	editable: boolean;
};

export type FrontMatterParseResult = {
	exists: boolean;
	valid: boolean;
	raw: string;
	body: string;
	fields: FrontMatterField[];
	data: Record<string, unknown>;
	error?: string;
	lineEnding: '\n' | '\r\n';
};

type FrontMatterRange = {
	raw: string;
	body: string;
};

function detectLineEnding(content: string): '\n' | '\r\n' {
	return content.includes('\r\n') ? '\r\n' : '\n';
}

function findFrontMatterRange(content: string): FrontMatterRange | null {
	const firstLineMatch = content.match(/^(?:\uFEFF)?---[ \t]*(?:\r?\n|$)/);
	if (!firstLineMatch) return null;

	let cursor = firstLineMatch[0].length;
	while (cursor <= content.length) {
		const nextNewline = content.indexOf('\n', cursor);
		const lineEnd = nextNewline === -1 ? content.length : nextNewline + 1;
		const line = content.slice(cursor, lineEnd).replace(/\r?\n$/, '');
		if (line.trim() === '---') {
			const raw = content.slice(firstLineMatch[0].length, cursor);
			let bodyStart = lineEnd;
			if (content.startsWith('\r\n', bodyStart)) {
				bodyStart += 2;
			} else if (content.startsWith('\n', bodyStart)) {
				bodyStart += 1;
			}

			return {
				raw,
				body: content.slice(bodyStart),
			};
		}

		if (nextNewline === -1) break;
		cursor = lineEnd;
	}

	return null;
}

function getValueKind(value: unknown): FrontMatterValueKind {
	if (value === null || value === undefined) return 'null';
	if (Array.isArray(value)) return 'list';
	if (typeof value === 'boolean') return 'boolean';
	if (typeof value === 'number') return 'number';
	if (typeof value === 'string') return 'string';
	return 'object';
}

function stringifyDisplayValue(value: unknown): string {
	if (Array.isArray(value)) {
		return value.map((item) => stringifyDisplayValue(item)).join(', ');
	}
	if (value === null || value === undefined) return '';
	if (value instanceof Date) return value.toISOString();
	if (typeof value === 'object') return JSON.stringify(value);
	return String(value);
}

// Front matter is metadata, so the block has to parse as a YAML mapping. Jekyll
// rejects anything else outright (`validate_data!` raises unless the parsed
// value `is_a?(Hash)`) and Hugo fails to unmarshal it into its map type; when a
// leading `---` block is not key/value pairs, no static-site generator or
// editor treats it as metadata. An empty block (`---\n---`) is still legal and
// empty metadata, so only a parsed scalar or sequence disqualifies it.
function isFrontMatterMapping(value: unknown): boolean {
	if (value === null || value === undefined) return true;
	return typeof value === 'object' && !Array.isArray(value) && !(value instanceof Date);
}

function toField([key, value]: [string, unknown]): FrontMatterField {
	const kind = getValueKind(value);
	return {
		key,
		value,
		kind,
		displayValue: stringifyDisplayValue(value),
		editable: kind !== 'object',
	};
}

export function parseFrontMatter(content: string): FrontMatterParseResult {
	const lineEnding = detectLineEnding(content);
	const range = findFrontMatterRange(content);
	const notFrontMatter: FrontMatterParseResult = {
		exists: false,
		valid: true,
		raw: '',
		body: content,
		fields: [],
		data: {},
		lineEnding,
	};
	if (!range) return notFrontMatter;

	const malformed = (error: string): FrontMatterParseResult => ({
		exists: true,
		valid: false,
		raw: range.raw,
		body: range.body,
		fields: [],
		data: {},
		error,
		lineEnding,
	});
	const doc = parseDocument(range.raw, { prettyErrors: false });
	if (doc.errors.length > 0) return malformed(doc.errors.map((error) => error.message).join('\n'));

	// An alias with no anchor (`**bold**` reads as one) parses without errors
	// and throws only here, out of the preview's render and every editor
	// analysis that asks where the front matter ends. It is malformed front
	// matter, not an exception.
	let parsed: unknown;
	try {
		parsed = doc.toJSON();
	} catch (error) {
		return malformed(error instanceof Error ? error.message : String(error));
	}

	// A document whose first line is `---` but whose block is prose, not a
	// mapping, is ordinary markdown: the opening `---` is a thematic break and
	// the closing one underlines a setext heading. Stripping it would delete
	// visible text from the rendered body without showing it as metadata
	// anywhere, so hand the whole document back as body.
	if (!isFrontMatterMapping(parsed)) return notFrontMatter;

	const data = (parsed ?? {}) as Record<string, unknown>;
	return {
		exists: true,
		valid: true,
		raw: range.raw,
		body: range.body,
		fields: Object.entries(data).map(toField),
		data,
		lineEnding,
	};
}

export function getMarkdownBodyWithoutFrontMatter(content: string): string {
	return parseFrontMatter(content).body;
}

/**
 * How many buffer lines sit above the body — the number to add to any line
 * number that came out of the renderer to get back to the buffer.
 *
 * The preview renders `getMarkdownBodyWithoutFrontMatter(raw)`, so every
 * `data-sourcepos` comrak emits counts from the first line of the BODY. The
 * editor holds the whole file. Nothing in the attribute says which of the two
 * it means, and the difference is invisible in any document without front
 * matter — which is most documents, and was every test fixture.
 *
 * `parseFrontMatter` returns the body as a suffix of the content, so the
 * offset is the newline count of everything before it. Counting `\n` alone is
 * correct for CRLF too, since `\r\n` contains one.
 */
export function frontMatterLineOffset(content: string): number {
	const { body } = parseFrontMatter(content);
	if (body.length === content.length) return 0;
	return content.slice(0, content.length - body.length).split('\n').length - 1;
}

/**
 * How many lines the front matter spans, opening fence through closing fence,
 * or 0 when the document has none — the lines the editor's Rust analyses
 * (headings, folds, colours) blank before they parse the buffer, so the
 * closing `---` does not underline the YAML into a setext heading.
 *
 * Rust is told rather than left to find them because this is the rule the
 * preview strips by: a leading `---` block counts only when its YAML is a
 * mapping (or empty, or malformed). A copy of that rule without a YAML parser
 * blanked a thematic break and the prose under it.
 *
 * Not `frontMatterLineOffset`: that also counts the blank line after the
 * closing fence, and misses the fence itself when no newline follows it.
 * `raw` is every line between the fences, each with its line ending.
 */
export function frontMatterFenceLines(content: string): number {
	const { exists, raw } = parseFrontMatter(content);
	return exists ? raw.split('\n').length + 1 : 0;
}

export function parseFrontMatterEditableValue(field: FrontMatterField, value: string): unknown {
	const trimmed = value.trim();
	switch (field.kind) {
		case 'boolean':
			return trimmed.toLowerCase() === 'true';
		case 'number': {
			const parsed = Number(trimmed);
			return Number.isFinite(parsed) ? parsed : value;
		}
		case 'list':
			return parseFrontMatterTagInput(value);
		case 'null':
			return trimmed === '' ? null : value;
		case 'string':
		default:
			return value;
	}
}

export function updateFrontMatterField(content: string, key: string, value: unknown): string {
	const parsed = parseFrontMatter(content);
	if (!parsed.exists) return content;
	if (!parsed.valid) throw new Error(parsed.error || 'Invalid front matter');

	const doc = parseDocument(parsed.raw, { prettyErrors: false });
	if (doc.errors.length > 0) throw new Error(doc.errors.map((error) => error.message).join('\n'));

	doc.set(key, value);
	let serialized = doc.toString({ lineWidth: 0 }).trimEnd();
	if (parsed.lineEnding === '\r\n') serialized = serialized.replace(/\n/g, '\r\n');

	return `---${parsed.lineEnding}${serialized}${parsed.lineEnding}---${parsed.lineEnding}${parsed.lineEnding}${parsed.body}`;
}

function parseFrontMatterTagInput(value: string): string[] {
	return value
		.split(',')
		.map((item) => item.trim())
		.filter(Boolean);
}

export function getFrontMatterListItems(field: FrontMatterField): string[] {
	if (!Array.isArray(field.value)) return [];
	return field.value
		.map((item) => stringifyDisplayValue(item).trim())
		.filter(Boolean);
}

export function addFrontMatterListItems(items: string[], values: string[]): string[] {
	return [...new Set([...items, ...values.flatMap(parseFrontMatterTagInput)])];
}

export function removeFrontMatterListItem(items: string[], index: number): string[] {
	if (index < 0 || index >= items.length) return items;
	return items.filter((_, itemIndex) => itemIndex !== index);
}

export function updateFrontMatterListItem(items: string[], index: number, value: string): string[] {
	if (index < 0 || index >= items.length) return items;

	const trimmed = value.trim();
	if (!trimmed || items.some((item, itemIndex) => itemIndex !== index && item === trimmed)) return items;

	const next = [...items];
	next[index] = trimmed;
	return next;
}
