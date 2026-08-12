import type { UserConfig } from 'vite';
import { defineConfig, mergeConfig } from 'vitest/config';

import viteConfig from './vite.config.js';

// `vite.config.js` exports an async factory (it reads TAURI_DEV_HOST), so it has
// to be called before it can be merged.
const base = (await (viteConfig as unknown as (env: unknown) => Promise<UserConfig>)({
	command: 'serve',
	mode: 'test',
})) as UserConfig;

export default mergeConfig(
	base,
	defineConfig({
		test: {
			// `*.spec.ts` here, `scripts/*.test.ts` in `npm test`. The two globs do
			// not overlap, so a file belongs to exactly one runner and moving it
			// across is a rename.
			include: ['scripts/**/*.spec.ts'],
			environment: 'jsdom',
		},
		resolve: {
			// Without this Svelte resolves to its SSR build, where `$effect` never
			// flushes and `$state` is not a proxy — runes would silently behave
			// like the hand-written shims these tests exist to delete.
			conditions: ['browser'],
		},
	}),
);
