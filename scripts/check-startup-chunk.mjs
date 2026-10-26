// Run after `vite build --sourcemap`: fails if Monaco or monaco-vim is in the
// code the app loads at startup. Monaco is megabytes and only the editor needs
// it, so it must be reached through `await import()` (Editor.svelte), never a
// static import.
//
// The startup code is every `isEntry` chunk in the Vite manifest plus the chunks
// they reach through static `imports`. `dynamicImports` are not followed: those
// load on demand. Which modules a chunk holds comes from its source map, because
// a static import does not keep Monaco in a chunk of its own: Rollup moves the
// code into a shared chunk that the manifest names only by hash.
import { existsSync, readFileSync } from 'node:fs';

const OUT = '.svelte-kit/output/client';
const LAZY = ['node_modules/monaco-editor/', 'node_modules/monaco-vim/'];

const manifest = JSON.parse(readFileSync(`${OUT}/.vite/manifest.json`, 'utf8'));

/** @type {Set<string>} */
const startup = new Set();
/** @type {string[]} */
const queue = Object.keys(manifest).filter((key) => manifest[key].isEntry);
while (queue.length > 0) {
	const key = /** @type {string} */ (queue.pop());
	if (startup.has(key)) continue;
	startup.add(key);
	queue.push(...(manifest[key].imports ?? []));
}

const errors = [];
let mapped = 0;
for (const key of startup) {
	// Chunks Vite writes itself (the preload helper, a one-line re-export) have
	// no sources and so no map.
	const map = `${OUT}/${manifest[key].file}.map`;
	if (!existsSync(map)) continue;
	mapped++;
	/** @type {string[]} */
	const sources = JSON.parse(readFileSync(map, 'utf8')).sources;
	const lazy = sources.filter((source) =>
		LAZY.some((prefix) => source.replaceAll('\\', '/').includes(prefix)),
	);
	if (lazy.length > 0) errors.push(`${manifest[key].file} holds ${lazy.length} Monaco modules, e.g. ${lazy[0]}`);
}

if (mapped === 0) errors.push('no startup chunk has a source map; build with `vite build --sourcemap`');
if (errors.length > 0) {
	console.error(`startup chunk check failed:\n  ${errors.join('\n  ')}`);
	process.exit(1);
}
console.log(`ok: ${startup.size} startup chunks (${mapped} with source maps), no Monaco module in them`);
