import { invoke } from '@tauri-apps/api/core';

/**
 * Keeps this window's file watcher on the file `path` returns, and gives it up
 * when that is ''. Call it while a component initialises; the effect is the
 * component's. This is the one place that asks for a watch: a load re-issuing
 * `watch_file` made the watcher follow whichever document loaded last rather
 * than the active one (#296).
 *
 * Watched whether or not Auto-Reload is on: an edit made elsewhere under
 * unsaved changes is reported when it happens, not at the next save.
 * Auto-Reload only decides whether a clean tab reloads.
 */
export function followActiveFile(path: () => string) {
	$effect(() => {
		const currentFile = path();
		if (currentFile) {
			invoke('watch_file', { path: currentFile }).catch(console.error);
		} else {
			invoke('unwatch_file').catch(console.error);
		}
	});
}
