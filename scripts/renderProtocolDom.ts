/**
 * A minimal DOM used only by `renderProtocol.test.ts`, so that the render
 * contract can be exercised by *running* `processMarkdownHtml` instead of
 * grepping its source. Node has no `DOMParser`, and the project intentionally
 * has no test-only DOM dependency, so the fixture carries its own.
 *
 * Scope is deliberately narrow: exactly the surface `processMarkdownHtml`
 * touches, over the HTML shapes comrak actually emits (well nested, explicit
 * close tags, `<input>`/`<br>`/`<img>` as the only void elements). It is not a
 * general HTML parser and must not grow into one — `renderProtocol.test.ts`
 * round-trips every fixture through it as a self-check so a shim bug shows up
 * as a shim failure rather than as a silent pass.
 */

const VOID_TAGS = new Set([
	'area',
	'base',
	'br',
	'col',
	'embed',
	'hr',
	'img',
	'input',
	'link',
	'meta',
	'param',
	'source',
	'track',
	'wbr',
]);

const ENTITIES: Record<string, string> = {
	amp: '&',
	lt: '<',
	gt: '>',
	quot: '"',
	apos: "'",
	nbsp: ' ',
};

function decodeEntities(value: string): string {
	return value.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (match, body: string) => {
		if (body[0] === '#') {
			const code =
				body[1] === 'x' || body[1] === 'X'
					? parseInt(body.slice(2), 16)
					: parseInt(body.slice(1), 10);
			return Number.isFinite(code) ? String.fromCodePoint(code) : match;
		}
		return ENTITIES[body.toLowerCase()] ?? match;
	});
}

function escapeText(value: string): string {
	return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function escapeAttribute(value: string): string {
	return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
}

export const NODE_ELEMENT = 1;
export const NODE_TEXT = 3;
const NODE_COMMENT = 8;

export class ShimNode {
	nodeType: number;
	childNodes: ShimNode[] = [];
	parentNode: ShimNode | null = null;
	ownerDocument: ShimDocument | null = null;

	constructor(nodeType: number) {
		this.nodeType = nodeType;
	}

	get parentElement(): ShimElement | null {
		return this.parentNode && this.parentNode.nodeType === NODE_ELEMENT
			? (this.parentNode as ShimElement)
			: null;
	}

	get firstChild(): ShimNode | null {
		return this.childNodes[0] ?? null;
	}

	get lastChild(): ShimNode | null {
		return this.childNodes[this.childNodes.length - 1] ?? null;
	}

	private siblingAt(offset: number): ShimNode | null {
		const siblings = this.parentNode?.childNodes;
		if (!siblings) return null;
		return siblings[siblings.indexOf(this) + offset] ?? null;
	}

	get nextSibling(): ShimNode | null {
		return this.siblingAt(1);
	}

	get previousSibling(): ShimNode | null {
		return this.siblingAt(-1);
	}

	get nextElementSibling(): ShimElement | null {
		let candidate = this.nextSibling;
		while (candidate && candidate.nodeType !== NODE_ELEMENT) candidate = candidate.nextSibling;
		return (candidate as ShimElement) ?? null;
	}

	get previousElementSibling(): ShimElement | null {
		let candidate = this.previousSibling;
		while (candidate && candidate.nodeType !== NODE_ELEMENT) candidate = candidate.previousSibling;
		return (candidate as ShimElement) ?? null;
	}

	get textContent(): string {
		return this.childNodes.map((child) => child.textContent).join('');
	}

	set textContent(value: string) {
		const text = new ShimText(value);
		text.ownerDocument = this.ownerDocument;
		this.replaceChildren(text);
	}

	appendChild<T extends ShimNode>(node: T): T {
		node.parentNode?.removeChild(node);
		node.parentNode = this;
		this.childNodes.push(node);
		return node;
	}

	insertBefore<T extends ShimNode>(node: T, reference: ShimNode | null): T {
		if (!reference) return this.appendChild(node);
		const index = this.childNodes.indexOf(reference);
		if (index === -1) return this.appendChild(node);
		node.parentNode?.removeChild(node);
		node.parentNode = this;
		this.childNodes.splice(index, 0, node);
		return node;
	}

	removeChild<T extends ShimNode>(node: T): T {
		const index = this.childNodes.indexOf(node);
		if (index !== -1) this.childNodes.splice(index, 1);
		node.parentNode = null;
		return node;
	}

	replaceChild<T extends ShimNode>(next: ShimNode, current: T): T {
		const index = this.childNodes.indexOf(current);
		if (index === -1) return current;
		next.parentNode?.removeChild(next);
		next.parentNode = this;
		this.childNodes.splice(index, 1, next);
		current.parentNode = null;
		return current;
	}

	replaceWith(...nodes: ShimNode[]) {
		const parent = this.parentNode;
		if (!parent) return;
		let anchor: ShimNode | null = this;
		for (const node of nodes) parent.insertBefore(node, anchor);
		anchor = null;
		parent.removeChild(this);
	}

	replaceChildren(...nodes: ShimNode[]) {
		for (const child of [...this.childNodes]) this.removeChild(child);
		for (const node of nodes) this.appendChild(node);
	}

	remove() {
		this.parentNode?.removeChild(this);
	}

	/** Pre-order descendants, self excluded. */
	descendants(): ShimNode[] {
		const out: ShimNode[] = [];
		const visit = (node: ShimNode) => {
			for (const child of node.childNodes) {
				out.push(child);
				visit(child);
			}
		};
		visit(this);
		return out;
	}

	querySelectorAll(selector: string): ShimElement[] {
		const matchers = parseSelectorList(selector);
		return this.descendants().filter(
			(node): node is ShimElement =>
				node.nodeType === NODE_ELEMENT &&
				matchers.some((matcher) => matcher(node as ShimElement)),
		);
	}

	querySelector(selector: string): ShimElement | null {
		return this.querySelectorAll(selector)[0] ?? null;
	}

	/**
	 * Does this element itself match?
	 *
	 * Needed since `renderRichContent` started taking a list of roots that are
	 * blocks rather than the whole article: a root that IS a `[data-math]`
	 * element has to be typeset, and `querySelectorAll` never returns the node
	 * it was called on.
	 */
	matches(selector: string): boolean {
		return parseSelectorList(selector).some((matcher) => matcher(this as unknown as ShimElement));
	}
}

export class ShimText extends ShimNode {
	nodeValue: string;

	constructor(value: string) {
		super(NODE_TEXT);
		this.nodeValue = value;
	}

	get textContent(): string {
		return this.nodeValue;
	}

	set textContent(value: string) {
		this.nodeValue = value;
	}
}

class ShimComment extends ShimNode {
	nodeValue: string;

	constructor(value: string) {
		super(NODE_COMMENT);
		this.nodeValue = value;
	}

	get textContent(): string {
		return '';
	}
}

class ShimClassList {
	constructor(private readonly element: ShimElement) {}

	private tokens(): string[] {
		return (this.element.getAttribute('class') || '').split(/\s+/).filter(Boolean);
	}

	private write(tokens: string[]) {
		if (tokens.length === 0) this.element.removeAttribute('class');
		else this.element.setAttribute('class', tokens.join(' '));
	}

	add(...names: string[]) {
		const tokens = this.tokens();
		for (const name of names) if (!tokens.includes(name)) tokens.push(name);
		this.write(tokens);
	}

	remove(...names: string[]) {
		this.write(this.tokens().filter((token) => !names.includes(token)));
	}

	contains(name: string): boolean {
		return this.tokens().includes(name);
	}

	/**
	 * A real `DOMTokenList` is iterable, and the render pipeline reads class
	 * lists that way (`Array.from(el.classList).some(c => c.startsWith(…))`).
	 * Without this the copy silently yields `[]` and every such test passes for
	 * the wrong reason.
	 */
	[Symbol.iterator](): IterableIterator<string> {
		return this.tokens()[Symbol.iterator]();
	}

	get length(): number {
		return this.tokens().length;
	}

	/**
	 * Returns whether the token is present AFTERWARDS, like the real
	 * `DOMTokenList`. The preview's fold handler reads exactly that value to
	 * decide which way it just folded, so a `void` copy silently makes every
	 * fold look like an unfold.
	 */
	toggle(name: string, force?: boolean): boolean {
		const present = this.contains(name);
		const next = force ?? !present;
		if (next) this.add(name);
		else this.remove(name);
		return next;
	}
}

function styleProxy(element: ShimElement): Record<string, string> {
	const declarations = new Map<string, string>();
	for (const part of (element.getAttribute('style') || '').split(';')) {
		const [name, ...rest] = part.split(':');
		if (!name.trim() || rest.length === 0) continue;
		declarations.set(name.trim(), rest.join(':').trim());
	}
	const flush = () => {
		if (declarations.size === 0) element.removeAttribute('style');
		else
			element.setAttribute(
				'style',
				[...declarations].map(([name, value]) => `${name}: ${value}`).join('; '),
			);
	};
	return new Proxy({} as Record<string, string>, {
		get: (_target, property: string) =>
			declarations.get(property.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)) ?? '',
		set: (_target, property: string, value: string) => {
			const name = property.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
			if (value === '') declarations.delete(name);
			else declarations.set(name, value);
			flush();
			return true;
		},
	});
}

export class ShimElement extends ShimNode {
	tagName: string;
	attributes = new Map<string, string>();
	readonly classList = new ShimClassList(this);

	constructor(tagName: string) {
		super(NODE_ELEMENT);
		this.tagName = tagName.toUpperCase();
	}

	get localName(): string {
		return this.tagName.toLowerCase();
	}

	getAttribute(name: string): string | null {
		return this.attributes.has(name) ? (this.attributes.get(name) as string) : null;
	}

	setAttribute(name: string, value: string) {
		this.attributes.set(name, value);
	}

	hasAttribute(name: string): boolean {
		return this.attributes.has(name);
	}

	removeAttribute(name: string) {
		this.attributes.delete(name);
	}

	get id(): string {
		return this.getAttribute('id') || '';
	}

	set id(value: string) {
		this.setAttribute('id', value);
	}

	// A browser reflects these into the attribute, so `link.href = url` is
	// visible to `getAttribute('href')` and survives serialization. Without
	// them the assignment lands on a plain JS property, the attribute is never
	// written, and a test can see that an anchor was created but not where it
	// points — which is the whole content of a link.
	get href(): string {
		return this.getAttribute('href') || '';
	}

	set href(value: string) {
		this.setAttribute('href', value);
	}

	get src(): string {
		return this.getAttribute('src') || '';
	}

	set src(value: string) {
		this.setAttribute('src', value);
	}

	get className(): string {
		return this.getAttribute('class') || '';
	}

	set className(value: string) {
		this.setAttribute('class', value);
	}

	get style(): Record<string, string> {
		return styleProxy(this);
	}

	/** `HTMLInputElement.checked`, the only element property the pipeline reads. */
	get checked(): boolean {
		return this.hasAttribute('checked');
	}

	set checked(value: boolean) {
		if (value) this.setAttribute('checked', '');
		else this.removeAttribute('checked');
	}

	get type(): string {
		return this.getAttribute('type') || '';
	}

	get dataset(): Record<string, string | undefined> {
		const element = this;
		return new Proxy({} as Record<string, string | undefined>, {
			get: (_target, property: string) =>
				element.getAttribute(
					`data-${property.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`,
				) ?? undefined,
		});
	}

	closest(selector: string): ShimElement | null {
		const matchers = parseSelectorList(selector);
		let current: ShimNode | null = this;
		while (current) {
			if (
				current.nodeType === NODE_ELEMENT &&
				matchers.some((matcher) => matcher(current as ShimElement))
			)
				return current as ShimElement;
			current = current.parentNode;
		}
		return null;
	}

	get innerHTML(): string {
		return this.childNodes.map(serializeNode).join('');
	}

	set innerHTML(html: string) {
		const parsed = parseFragment(html, this.ownerDocument);
		this.replaceChildren(...parsed);
	}

	get outerHTML(): string {
		return serializeNode(this);
	}
}

class ShimDocument extends ShimNode {
	documentElement: ShimElement;
	body: ShimElement;

	constructor() {
		super(9);
		this.ownerDocument = this;
		this.documentElement = this.createElement('html');
		this.body = this.createElement('body');
		this.appendChild(this.documentElement);
		this.documentElement.appendChild(this.body);
	}

	createElement(tagName: string): ShimElement {
		const element = new ShimElement(tagName);
		element.ownerDocument = this;
		return element;
	}

	createTextNode(value: string): ShimText {
		const text = new ShimText(value);
		text.ownerDocument = this;
		return text;
	}

	createTreeWalker(
		root: ShimNode,
		whatToShow = 0xffffffff,
		filter?: { acceptNode(node: ShimNode): number } | null,
	) {
		const queue: ShimNode[] = [];
		const visit = (node: ShimNode) => {
			for (const child of node.childNodes) {
				const shown = (whatToShow & (1 << (child.nodeType - 1))) !== 0;
				if (!shown) {
					visit(child);
					continue;
				}
				const verdict = filter ? filter.acceptNode(child) : 1;
				if (verdict === 2) continue; // FILTER_REJECT: skip the subtree
				if (verdict === 1) queue.push(child);
				visit(child);
			}
		};
		visit(root);
		let index = 0;
		return {
			nextNode(): ShimNode | null {
				return index < queue.length ? queue[index++] : null;
			},
		};
	}
}

// --- parsing -------------------------------------------------------------

const TOKEN_RE = /<!--([\s\S]*?)-->|<\/([a-zA-Z][^\s>]*)\s*>|<([a-zA-Z][^\s/>]*)((?:[^>"']|"[^"]*"|'[^']*')*)>/g;
const ATTRIBUTE_RE = /([^\s=/][^\s=]*)(?:\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;

function parseAttributes(raw: string, element: ShimElement) {
	ATTRIBUTE_RE.lastIndex = 0;
	let match: RegExpExecArray | null;
	while ((match = ATTRIBUTE_RE.exec(raw))) {
		const name = match[1];
		if (!name || name === '/') continue;
		const value = match[3] ?? match[4] ?? match[5] ?? '';
		element.setAttribute(name, decodeEntities(value));
	}
}

function parseInto(html: string, container: ShimNode, doc: ShimDocument) {
	const stack: ShimNode[] = [container];
	const top = () => stack[stack.length - 1];
	let cursor = 0;
	TOKEN_RE.lastIndex = 0;
	let match: RegExpExecArray | null;

	const pushText = (raw: string) => {
		if (!raw) return;
		const text = new ShimText(decodeEntities(raw));
		text.ownerDocument = doc;
		top().appendChild(text);
	};

	while ((match = TOKEN_RE.exec(html))) {
		pushText(html.slice(cursor, match.index));
		cursor = TOKEN_RE.lastIndex;

		if (match[1] !== undefined) {
			const comment = new ShimComment(match[1]);
			comment.ownerDocument = doc;
			top().appendChild(comment);
			continue;
		}

		if (match[2] !== undefined) {
			const name = match[2].toUpperCase();
			for (let depth = stack.length - 1; depth >= 1; depth -= 1) {
				if ((stack[depth] as ShimElement).tagName === name) {
					stack.length = depth;
					break;
				}
			}
			continue;
		}

		const tagName = match[3];
		const element = doc.createElement(tagName);
		parseAttributes(match[4] || '', element);
		top().appendChild(element);
		const selfClosing = /\/\s*$/.test(match[4] || '');
		if (!selfClosing && !VOID_TAGS.has(tagName.toLowerCase())) stack.push(element);
	}
	pushText(html.slice(cursor));
}

function parseFragment(html: string, doc: ShimDocument | null): ShimNode[] {
	const document = doc ?? new ShimDocument();
	const holder = document.createElement('template');
	parseInto(html, holder, document);
	return [...holder.childNodes].map((child) => {
		holder.removeChild(child);
		return child;
	});
}

class ShimDOMParser {
	parseFromString(html: string, _type: string): ShimDocument {
		const doc = new ShimDocument();
		parseInto(html, doc.body, doc);
		return doc;
	}
}

// --- serialization -------------------------------------------------------

function serializeNode(node: ShimNode): string {
	if (node.nodeType === NODE_TEXT) return escapeText((node as ShimText).nodeValue);
	if (node.nodeType === NODE_COMMENT) return `<!--${(node as ShimComment).nodeValue}-->`;
	const element = node as ShimElement;
	const name = element.localName;
	const attributes = [...element.attributes]
		.map(([key, value]) => ` ${key}="${escapeAttribute(value)}"`)
		.join('');
	if (VOID_TAGS.has(name)) return `<${name}${attributes}>`;
	return `<${name}${attributes}>${element.innerHTML}</${name}>`;
}

// --- selectors -----------------------------------------------------------

type Matcher = (element: ShimElement) => boolean;

function parseCompound(source: string): Matcher {
	const checks: Matcher[] = [];
	const pattern = /^([a-zA-Z][\w-]*)|^\.([\w-]+)|^#([\w-]+)|^\[([\w-]+)(?:=("([^"]*)"|'([^']*)'|[^\]]+))?\]/;
	let rest = source.trim();
	while (rest.length > 0) {
		const match = pattern.exec(rest);
		if (!match) throw new Error(`unsupported selector fragment: ${source}`);
		if (match[1]) {
			const tag = match[1].toUpperCase();
			checks.push((element) => element.tagName === tag);
		} else if (match[2]) {
			const className = match[2];
			checks.push((element) => element.classList.contains(className));
		} else if (match[3]) {
			const id = match[3];
			checks.push((element) => element.id === id);
		} else if (match[4]) {
			const name = match[4];
			const raw = match[5];
			if (raw === undefined) checks.push((element) => element.hasAttribute(name));
			else {
				const value = match[6] ?? match[7] ?? raw;
				checks.push((element) => element.getAttribute(name) === value);
			}
		}
		rest = rest.slice(match[0].length);
	}
	if (checks.length === 0) throw new Error(`empty selector: ${source}`);
	return (element) => checks.every((check) => check(element));
}

function parseComplex(source: string): Matcher {
	const compounds = source.trim().split(/\s+/).map(parseCompound);
	const subject = compounds[compounds.length - 1];
	const ancestors = compounds.slice(0, -1).reverse();
	return (element) => {
		if (!subject(element)) return false;
		let current: ShimNode | null = element.parentNode;
		let index = 0;
		while (current && index < ancestors.length) {
			if (current.nodeType === NODE_ELEMENT && ancestors[index](current as ShimElement))
				index += 1;
			current = current.parentNode;
		}
		return index === ancestors.length;
	};
}

const selectorCache = new Map<string, Matcher[]>();

function parseSelectorList(selector: string): Matcher[] {
	const cached = selectorCache.get(selector);
	if (cached) return cached;
	const matchers = selector.split(',').map(parseComplex);
	selectorCache.set(selector, matchers);
	return matchers;
}

// --- installation --------------------------------------------------------

let installed = false;

/**
 * Publishes the globals `processMarkdownHtml` reaches for. It calls the bare
 * `document.createTreeWalker` (not `doc.createTreeWalker`) in two places, so a
 * global document has to exist even though the parsed document is separate.
 */
export function installShimDom() {
	if (installed) return;
	installed = true;
	const scope = globalThis as unknown as Record<string, unknown>;
	scope.DOMParser = ShimDOMParser;
	scope.document = new ShimDocument();
	scope.Node = { ELEMENT_NODE: NODE_ELEMENT, TEXT_NODE: NODE_TEXT, COMMENT_NODE: NODE_COMMENT };
	scope.NodeFilter = {
		SHOW_ALL: 0xffffffff,
		SHOW_ELEMENT: 1,
		SHOW_TEXT: 4,
		FILTER_ACCEPT: 1,
		FILTER_REJECT: 2,
		FILTER_SKIP: 3,
	};
}

export function parseHtml(html: string): ShimDocument {
	return new ShimDOMParser().parseFromString(html, 'text/html');
}

/** Tag / attribute / text tree, for shim round-trip self-checks. */
export function structureOf(node: ShimNode): unknown {
	if (node.nodeType === NODE_TEXT) return { text: (node as ShimText).nodeValue };
	if (node.nodeType === NODE_COMMENT) return { comment: (node as ShimComment).nodeValue };
	const element = node as ShimElement;
	return {
		tag: element.localName,
		attributes: [...element.attributes],
		children: element.childNodes.map(structureOf),
	};
}
