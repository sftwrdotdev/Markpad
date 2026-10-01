import assert from 'node:assert/strict';
import { test } from 'vitest';
import { flushSync } from 'svelte';

import { loadLocale, t } from '../src/lib/utils/i18n.js';
import { runeEffect } from './runeEffect.svelte.js';

// Only English is in the startup bundle; every other language is fetched on
// first use. A component that rendered before its language arrived has to
// render again when it does, or it stays in English until something unrelated
// re-renders it.
test('t() re-runs its caller once a not-yet-loaded language arrives', async () => {
	const seen: string[] = [];
	const stop = runeEffect(() => {
		seen.push(t('settings.title', 'ja'));
	});
	flushSync();
	assert.deepEqual(seen, ['Settings'], 'before the chunk lands, English stands in');

	await loadLocale('ja');
	flushSync();
	assert.deepEqual(seen, ['Settings', '設定']);
	stop();
});
