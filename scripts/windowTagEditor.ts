import assert from 'node:assert/strict';

import { parse } from 'svelte/compiler';

import { callbackBodies, functionSource, readSource } from './sourceTree.js';

/*
 * A running window-tag control, lifted out of TitleBar.svelte.
 *
 * A `.svelte` file cannot be imported by the Node test runner, so — following
 * homeTabRender.test.ts — the component's own function declarations, the
 * handlers its markup is actually wired to, and the body of the `$effect` that
 * installs the window-level dismissal listeners are read out of the parsed
 * component and evaluated over one shared set of component variables and the
 * REAL `TabManager`. Everything a test below drives is the code that ships.
 *
 * This started inside windowTagDismiss.test.ts and moved here when a second and
 * third file needed the same running control: the scope line and the context
 * menu read the same `tabManager.windowTag` the popover writes, and a second
 * copy of the lifting would be free to drift from the first.
 *
 * What it does not model: focus, layout, CSS, or Svelte's scheduling. It
 * establishes what the handlers do when they run.
 */

// ---------------------------------------------------------------- environment
// Svelte runes and the Tauri bridge, faked as homeSentinelSnapshot.ts does, so
// `tabs.svelte.ts` imports under plain node.

const g = globalThis as any;
const runeEffect = (fn: () => void) => {
	void fn;
};
runeEffect.root = (fn: () => unknown) => fn();
g.$state = (value: unknown) => value;
g.$state.raw = (value: unknown) => value;
g.$state.snapshot = (value: unknown) => value;
g.$derived = (value: unknown) => value;
g.$derived.by = (fn: () => unknown) => fn();
g.$effect = runeEffect;
g.window = g.window ?? {};

const localStore = new Map<string, string>();
g.localStorage = {
	getItem: (key: string) => (localStore.has(key) ? localStore.get(key)! : null),
	setItem: (key: string, value: string) => void localStore.set(key, String(value)),
	removeItem: (key: string) => void localStore.delete(key),
	clear: () => localStore.clear(),
};
g.window.__TAURI_INTERNALS__ = {
	metadata: { currentWindow: { label: 'main' }, currentWebview: { windowLabel: 'main', label: 'main' } },
	invoke: (cmd: string) => Promise.resolve(cmd === 'get_os_type' ? 'macos' : null),
};

const store = await import('../src/lib/stores/tabs.svelte.js');
const { hasRealFilePath } = await import('../src/lib/utils/tabFileActions.js');
const { t } = await import('../src/lib/utils/i18n.js');

export const tabManager = store.tabManager;

// ------------------------------------------------- the component, as written

const TITLE_BAR = 'src/lib/components/TitleBar.svelte';
export const source = readSource(TITLE_BAR);

type Node = Record<string, any>;

function collect(node: unknown, hit: (node: Node) => void): void {
	if (!node || typeof node !== 'object') return;
	if (Array.isArray(node)) {
		for (const child of node) collect(child, hit);
		return;
	}
	hit(node as Node);
	for (const key of Object.keys(node as Node)) {
		if (key === 'parent' || key === 'metadata') continue;
		collect((node as Node)[key], hit);
	}
}

const parsed = parse(source, { modern: true, filename: TITLE_BAR });
const fragment = parsed.fragment;

/**
 * The same code with its TypeScript annotations blanked out.
 *
 * `new Function` is a JavaScript parser, and the component is written in
 * TypeScript: `async function tagNameTakenElsewhere(name: string):
 * Promise<boolean>` is a syntax error in it. Blanking rather than deleting
 * keeps every remaining character at its original offset, so a stack trace out
 * of the lifted code still points where the reader expects.
 *
 * Done from the AST rather than with a pattern, for the reason `sourceTree`
 * gives for parsing in general: the annotation forms in `src/` are parameter
 * and return types today, and the next contributor is free to write `as
 * const`, a generic call or a non-null assertion. Every node the parser labels
 * `TS…` is a type; the two that also carry a value keep their expression.
 */
function stripTypes(snippet: string): string {
	const prefix = '<script lang="ts">\n';
	const suffix = '\n</script>';
	const wrapped = `${prefix}${snippet}${suffix}`;
	const blanks: Array<[number, number]> = [];
	collect(parse(wrapped, { modern: true }).instance, (node) => {
		if (typeof node.type !== 'string' || !node.type.startsWith('TS')) return;
		if (typeof node.start !== 'number' || typeof node.end !== 'number') return;
		// `x as T`, `x!`: the expression is a value and has to survive.
		if (node.expression && typeof node.expression.start === 'number') {
			blanks.push([node.start, node.expression.start], [node.expression.end, node.end]);
			return;
		}
		blanks.push([node.start, node.end]);
	});
	const characters = [...wrapped];
	for (const [start, end] of blanks) {
		for (let i = start; i < end; i++) if (characters[i] !== '\n') characters[i] = ' ';
	}
	return characters.join('').slice(prefix.length, wrapped.length - suffix.length);
}

/**
 * The one function bound to `name`, ready for `new Function` — or a stub, if
 * the component has no such function.
 *
 * Same reasoning as `handlerSourceIn` below: a function that is not there does
 * nothing when it is called, and a stub models exactly that. Asserting instead
 * would turn one deleted function into an identical structural failure in every
 * test in the file, including the fences whose whole job is to stay green, and
 * none of them would then be evidence about behaviour.
 */
function runnable(name: string): string {
	try {
		return stripTypes(functionSource(source, name));
	} catch {
		return `function ${name}() {}`;
	}
}

/** The one element in `text` carrying exactly `class="<name>"`. */
function elementIn(text: string, root: unknown, className: string): Node {
	const found: Node[] = [];
	collect(root, (node) => {
		if (node.type !== 'RegularElement') return;
		const attribute = node.attributes?.find((a: Node) => a.type === 'Attribute' && a.name === 'class');
		const value = attribute?.value;
		if (!Array.isArray(value) || value.length !== 1 || value[0].type !== 'Text') return;
		if (value[0].data === className) found.push(node);
	});
	assert.equal(found.length, 1, `expected exactly one <… class="${className}"> element, found ${found.length}`);
	return found[0];
}

export function element(className: string): Node {
	return elementIn(source, fragment, className);
}

/**
 * The single `{…}` behind an attribute or directive value, if there is one.
 *
 * Svelte spells that value two ways depending on the node — a bare
 * `ExpressionTag` for `onclick={…}`, a one-element array of parts for
 * `style:--x={…}` — and both mean the same thing here.
 */
function soleExpression(text: string, value: unknown): string | null {
	const parts = Array.isArray(value) ? value : [value];
	if (parts.length !== 1) return null;
	const part = parts[0] as Node | null;
	if (!part || part.type !== 'ExpressionTag') return null;
	return stripTypes(text.slice(part.expression.start, part.expression.end));
}

/**
 * The source of a DOM handler on that element, e.g. `onkeydown`.
 *
 * An absent handler is a no-op rather than an assertion failure, deliberately.
 * Asserting here builds the whole harness on the presence of an attribute, so
 * deleting one turns every test in the file red with the same structural
 * message — including the fences, whose entire job is to stay green — and none
 * of them would then be evidence about behaviour. A handler that is not there
 * does nothing when the user's event arrives, which is exactly what a no-op
 * models, and each test fails on its own claim: "Escape left the popover open".
 */
function handlerSourceIn(text: string, node: Node, name: string): string {
	const attribute = node.attributes?.find((a: Node) => a.type === 'Attribute' && a.name === name);
	return soleExpression(text, attribute?.value) ?? '(() => {})';
}

function handlerSource(node: Node, name: string): string {
	return handlerSourceIn(source, node, name);
}

/**
 * The expression of a `class:`/`style:` directive, or a literal that stands for
 * "the directive is not there" — `false` for a class, `undefined` for a style.
 *
 * Same reasoning as `handlerSource`: an absent directive is modelled as the
 * value the element would really have without it, so the test that cares fails
 * on its own claim ("the strip carried no scope line while a tag was set")
 * rather than on a missing attribute name.
 */
function directiveSource(node: Node, type: 'ClassDirective' | 'StyleDirective', name: string): string {
	const directive = node.attributes?.find((a: Node) => a.type === type && a.name === name);
	if (!directive) return type === 'ClassDirective' ? 'false' : 'undefined';
	if (type === 'ClassDirective') return stripTypes(source.slice(directive.expression.start, directive.expression.end));
	const expression = soleExpression(source, directive.value);
	if (expression) return expression;
	// A static `style:x="literal"` — the text as written, quoted.
	const parts: Node[] = Array.isArray(directive.value) ? directive.value : [directive.value];
	return JSON.stringify(parts.map((part) => part?.data ?? '').join(''));
}

/** The one `<name>` element under `root`. */
function elementByTag(root: Node, name: string): Node {
	const found: Node[] = [];
	collect(root, (node) => {
		if (node.type === 'RegularElement' && node.name === name) found.push(node);
	});
	assert.equal(found.length, 1, `expected exactly one <${name}> under the subtree, found ${found.length}`);
	return found[0];
}

/**
 * The one element under `root` whose `onclick` source contains `marker`, or an
 * empty stand-in when there is none — a control that is not rendered does
 * nothing when it is clicked and renders under no condition, which is what the
 * stand-in models. Same reasoning as `handlerSourceIn`.
 */
function elementByHandler(root: Node, marker: string): Node {
	const found: Node[] = [];
	collect(root, (node) => {
		if (node.type !== 'RegularElement' || node === root) return;
		if (handlerSource(node, 'onclick').includes(marker)) found.push(node);
	});
	assert.ok(found.length <= 1, `expected at most one element under the subtree whose onclick contains ${JSON.stringify(marker)}, found ${found.length}`);
	return found[0] ?? { type: 'RegularElement', attributes: [] };
}

/**
 * The test of the innermost `{#if}` wrapping `node` — what has to hold for the
 * element to be on screen at all — or `false` for an element that is not in the
 * markup.
 */
function enclosingIfTest(node: Node): string {
	if (typeof node.start !== 'number') return 'false';
	let innermost: Node | null = null;
	collect(fragment, (candidate) => {
		if (candidate.type !== 'IfBlock') return;
		if (candidate.start > node.start || candidate.end < node.end) return;
		if (!innermost || candidate.start > innermost.start) innermost = candidate;
	});
	const block = innermost as Node | null;
	return block ? stripTypes(source.slice(block.test.start, block.test.end)) : 'true';
}

/** The one `{…}` an element renders as its whole content, if that is all it has. */
function textExpression(node: Node): string {
	const tags = (node.fragment?.nodes ?? []).filter((child: Node) => child.type === 'ExpressionTag');
	if (tags.length !== 1) return "''";
	return stripTypes(source.slice(tags[0].expression.start, tags[0].expression.end));
}

/** The initialiser of a top-level `const`, evaluated. */
function constantValue(name: string): unknown {
	const found: Node[] = [];
	collect(parse(source, { modern: true, filename: TITLE_BAR }).instance, (node) => {
		if (node.type === 'VariableDeclarator' && node.id?.type === 'Identifier' && node.id.name === name && node.init) {
			found.push(node.init);
		}
	});
	assert.equal(found.length, 1, `expected exactly one \`${name}\` declaration in ${TITLE_BAR}`);
	return new Function(`return (${source.slice(found[0].start, found[0].end)});`)();
}

/** Every declaration of the one rule whose selector list is exactly `selector`. */
export function styleRule(file: string, selector: string): Map<string, string> {
	const text = readSource(file);
	const css = parse(text, { modern: true, filename: file }).css as Node | null;
	const rules = (css?.children ?? []).filter(
		(child: Node) => child.type === 'Rule' && text.slice(child.prelude.start, child.prelude.end).trim() === selector,
	);
	assert.ok(rules.length <= 1, `expected at most one \`${selector}\` rule in ${file}, found ${rules.length}`);
	const declarations = new Map<string, string>();
	for (const child of rules[0]?.block?.children ?? []) {
		if (child.type === 'Declaration') declarations.set(child.property, child.value);
	}
	return declarations;
}

/** The `$effect` that installs the window-level dismissal listeners. */
const dismissEffectBody = (() => {
	const bodies = callbackBodies(source, '$effect').filter((body) => body.includes('handleGlobalDismiss'));
	assert.equal(bodies.length, 1, `expected exactly one $effect wiring handleGlobalDismiss, found ${bodies.length}`);
	return bodies[0];
})();

// ------------------------------------------------------------------- harness

type WindowStub = {
	listeners: Map<string, () => void>;
	addEventListener: (type: string, fn: () => void) => void;
	removeEventListener: (type: string, fn: () => void) => void;
};

type ClickHandler = (event: { stopPropagation: () => void }) => void;

type MouseEventStub = {
	preventDefault: () => void;
	stopPropagation: () => void;
};

type InvokeCall = { cmd: string; args: any };

export type TitleBar = {
	state: () => {
		tagEditorOpen: boolean;
		tagDraftName: string;
		tagDraftColor: string;
		tagError: string;
		homeMenuOpen: boolean;
	};
	setDraft: (name: string, color: string) => void;
	typeName: (name: string) => void;
	openHomeMenu: () => void;
	openTagEditor: () => void;
	applyTag: () => Promise<void>;
	chipClick: ClickHandler;
	chipContextMenu: (event: MouseEventStub) => void;
	pinClick: ClickHandler;
	pinLabel: () => unknown;
	pinRendered: () => unknown;
	removeClick: ClickHandler;
	removeRendered: () => unknown;
	closeRendered: () => unknown;
	editorClick: ClickHandler;
	editorKeydown: (event: { key: string }) => void;
	homeMenuTagItemClick: ClickHandler;
	homeMenuClick: ClickHandler;
	tabAreaTagged: () => unknown;
	tabAreaTagColor: () => unknown;
	dismissEffect: () => (() => void) | undefined;
};

function createTitleBar(windowStub: WindowStub, invoke: (cmd: string, args: any) => Promise<unknown>): TitleBar {
	const tabArea = element('tab-area');
	const editor = element('tag-editor');
	const pin = elementByHandler(editor, 'togglePinnedTag');
	const remove = elementByHandler(editor, 'clearTag');
	const close = elementByHandler(editor, 'onclosetag');
	const factory = new Function(
		'tabManager',
		'tagColors',
		'invoke',
		'window',
		'hasRealFilePath',
		't',
		'currentLanguage',
		`
		let tagEditorOpen = false;
		let tagDraftName = '';
		let tagDraftColor = tagColors[1];
		let tagError = '';
		let themeMenuOpen = false;
		let kebabMenuOpen = false;
		let homeMenuOpen = false;

		${runnable('openTagEditor')}
		${runnable('tagNameTakenElsewhere')}
		${runnable('applyTag')}
		${runnable('openTagEditorFromContextMenu')}
		${runnable('clearTag')}
		${runnable('togglePinnedTag')}
		${runnable('handleGlobalDismiss')}

		return {
			state: () => ({ tagEditorOpen, tagDraftName, tagDraftColor, tagError, homeMenuOpen }),
			setDraft: (name, color) => { tagDraftName = name; tagDraftColor = color; },
			typeName: (name) => { tagDraftName = name; (${handlerSource(elementByTag(editor, 'input'), 'oninput')})(); },
			openHomeMenu: () => { homeMenuOpen = true; },
			openTagEditor,
			applyTag,
			chipClick: ${handlerSource(element('window-tag-chip'), 'onclick')},
			chipContextMenu: ${handlerSource(element('window-tag-chip'), 'oncontextmenu')},
			pinClick: ${handlerSource(pin, 'onclick')},
			pinLabel: () => (${textExpression(pin)}),
			pinRendered: () => (${enclosingIfTest(pin)}),
			removeClick: ${handlerSource(remove, 'onclick')},
			removeRendered: () => (${enclosingIfTest(remove)}),
			closeRendered: () => (${enclosingIfTest(close)}),
			editorClick: ${handlerSource(editor, 'onclick')},
			editorKeydown: ${handlerSource(editor, 'onkeydown')},
			homeMenuTagItemClick: ${handlerSource(elementByHandler(element('home-dropdown-menu'), 'openTagEditor()'), 'onclick')},
			homeMenuClick: ${handlerSource(element('home-dropdown-menu'), 'onclick')},
			tabAreaTagged: () => (${directiveSource(tabArea, 'ClassDirective', 'tagged')}),
			tabAreaTagColor: () => (${directiveSource(tabArea, 'StyleDirective', '--tag-color')}),
			dismissEffect: () => ${dismissEffectBody},
		};
		`,
	) as (...args: unknown[]) => TitleBar;

	return factory(tabManager, constantValue('tagColors'), invoke, windowStub, hasRealFilePath, t, 'en');
}

export const COLORS = constantValue('tagColors') as string[];

type SetupOptions = {
	/** Answers `is_window_tag_taken`; every other command resolves to null. */
	tagTakenElsewhere?: boolean | (() => boolean | Promise<boolean>);
	/** Fails every `invoke`, to drive the "backend cannot answer" path. */
	invokeFails?: boolean;
	/** Answers `rename_pinned_tag`. */
	pinRename?: 'renamed' | 'missing' | 'taken';
};

export function setup(options: SetupOptions = {}) {
	const listeners = new Map<string, () => void>();
	const windowStub: WindowStub = {
		listeners,
		addEventListener: (type, fn) => void listeners.set(type, fn),
		removeEventListener: (type, fn) => {
			if (listeners.get(type) === fn) listeners.delete(type);
		},
	};

	const invokeCalls: InvokeCall[] = [];
	const invoke = (cmd: string, args: any) => {
		invokeCalls.push({ cmd, args });
		if (options.invokeFails) return Promise.reject(new Error(`invoke failed: ${cmd}`));
		if (cmd === 'rename_pinned_tag') return Promise.resolve(options.pinRename ?? 'renamed');
		if (cmd !== 'is_window_tag_taken') return Promise.resolve(null);
		const answer = options.tagTakenElsewhere ?? false;
		return Promise.resolve(typeof answer === 'function' ? answer() : answer);
	};

	tabManager.setWindowTag(null);
	const bar = createTitleBar(windowStub, invoke);
	let cleanup: (() => void) | undefined;

	/** Re-run the effect the way Svelte does: previous teardown, then the body. */
	const flush = () => {
		cleanup?.();
		cleanup = bar.dismissEffect();
	};

	/**
	 * One click, dispatched along a bubble path: target handler first, then each
	 * ancestor's, then `window` — unless something on the way called
	 * `stopPropagation`.
	 *
	 * The path matters because the effect that installs `handleGlobalDismiss`
	 * runs before the click has finished bubbling, so the window listener sees
	 * the very click that opened the popover. That is why the chip stops
	 * propagation, and why a menu item that opens the tag editor is safe only if
	 * something above it does. Modelling the path is the only way a test can
	 * tell a working entry point from one that opens the popover and dismisses
	 * it again in the same click.
	 *
	 * The listener is re-read after `flush()` but falls back to the one already
	 * installed before the click, so both orderings — a listener present because
	 * another popover was open, and one installed by this very click — reach the
	 * same `handleGlobalDismiss`.
	 */
	const clickPath = (...handlers: ClickHandler[]) => {
		const installed = listeners.get('click');
		let stopped = false;
		for (const handler of handlers) {
			if (stopped) break;
			handler({ stopPropagation: () => void (stopped = true) });
		}
		flush();
		if (!stopped) (listeners.get('click') ?? installed)?.();
	};

	/** A click anywhere the component does not handle. */
	const clickOutside = () => {
		flush();
		listeners.get('click')?.();
	};

	/**
	 * A right-click on the chip, along the same bubble path as `clickPath`: the
	 * chip's own handler first, then the window `contextmenu` listener unless
	 * something stopped propagation. That listener is `handleGlobalDismiss`, so
	 * a right-click that reaches it opens the popover and dismisses it again in
	 * one gesture — which is what makes the path, rather than the handler
	 * alone, the thing worth running.
	 */
	const rightClick = () => {
		let stopped = false;
		let defaultPrevented = false;
		const installed = listeners.get('contextmenu');
		bar.chipContextMenu({
			preventDefault: () => void (defaultPrevented = true),
			stopPropagation: () => void (stopped = true),
		});
		flush();
		if (!stopped) (listeners.get('contextmenu') ?? installed)?.();
		return { defaultPrevented, stopped };
	};

	return { bar, listeners, invokeCalls, flush, clickPath, clickOutside, rightClick };
}

/** Let a handler's pending microtasks run before asserting on what it wrote. */
export const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
