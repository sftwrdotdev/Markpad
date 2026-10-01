/**
 * Runs `fn` in an effect, the way a component template reads state, and
 * returns the disposer. `$effect` is a compiler rune, so like `runeProps` it
 * has to live in a `.svelte.ts` module for a `.spec.ts` test to use it.
 */
export function runeEffect(fn: () => void): () => void {
	return $effect.root(() => {
		$effect(fn);
	});
}
