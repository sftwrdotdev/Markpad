/**
 * Scopes the `renderProtocolDom.ts` shim to one `describe` of a merged
 * `node --test` file.
 *
 * `node --test` runs every file in its own process, so a file could install the
 * shim and stub `window`, `location` or `DOMPurify.sanitize` at module level and
 * never take them down. Once several of those files are one file, whatever the
 * first one installed would still be there for the next. `useShimDom` installs
 * it all in the describe's `before` and puts back what was there in its `after`.
 *
 * `installShimDom` publishes its globals once per process, so the values it
 * published are kept here and re-applied; every describe gets a fresh document.
 */

import DOMPurify from 'dompurify';
import { after, before } from 'node:test';

import { installShimDom, parseHtml } from './renderProtocolDom.ts';

/** Globals the shim or the merged files write, beyond what `globals` names. */
const TOUCHED = ['DOMParser', 'document', 'Node', 'NodeFilter', 'window', 'location', 'addEventListener', 'fetch', '__TAURI_INTERNALS__'];

let published: Record<string, unknown> | null = null;

export function useShimDom(globals: Record<string, unknown> = {}, options: { identitySanitize?: boolean } = {}) {
	const scope = globalThis as unknown as Record<string, unknown>;
	const purify = DOMPurify as unknown as { sanitize: unknown };
	const saved = new Map<string, PropertyDescriptor | undefined>();
	let sanitize: unknown;

	before(() => {
		for (const key of new Set([...TOUCHED, ...Object.keys(globals)])) saved.set(key, Object.getOwnPropertyDescriptor(scope, key));
		installShimDom();
		published ??= { DOMParser: scope.DOMParser, Node: scope.Node, NodeFilter: scope.NodeFilter };
		Object.assign(scope, published, { document: parseHtml('') }, globals);
		if (options.identitySanitize) {
			// Without a real DOM the filter is a no-op object; the files that stub it
			// test what is around it, not what it does.
			sanitize = purify.sanitize;
			purify.sanitize = (html: string) => html;
		}
	});

	after(() => {
		for (const [key, descriptor] of saved) {
			if (descriptor) Object.defineProperty(scope, key, descriptor);
			else delete scope[key];
		}
		if (options.identitySanitize) purify.sanitize = sanitize;
	});
}
