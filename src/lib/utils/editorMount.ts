/**
 * Mount an editor whose module has to be fetched first: `load` it, then
 * `create` the editor, and hand back the unmount cleanup *synchronously*.
 *
 * Svelte only treats a synchronously returned function as the unmount
 * cleanup, so an `async` `onMount` callback would hand it a promise and
 * silently leak the editor, its listeners and the `window.open` patch. The
 * await lives in this inner task instead, and the returned cleanup closes over
 * both the cancel flag (the component can be destroyed while the chunk is
 * still in flight — Ctrl+E then Ctrl+E again) and whatever cleanup `create`
 * produced.
 */
export function mountAfterLoad(load: () => Promise<unknown>, create: () => () => void): () => void {
	let cancelled = false;
	let teardown: (() => void) | null = null;

	void (async () => {
		await load();
		if (cancelled) return;
		teardown = create();
	})();

	return () => {
		cancelled = true;
		teardown?.();
	};
}
