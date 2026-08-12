import assert from 'node:assert/strict';
import test from 'node:test';

import { readRustBackend, readSource } from './sourceTree.js';

const runtime = readSource('src-tauri/src/window_runtime.rs');
const tauriLib = readRustBackend();
const viewer = readSource('src/lib/MarkdownViewer.svelte');

test('macOS open-document events preserve every delivered file path', () => {
	assert.match(runtime, /startup_files: Mutex<Vec<String>>/);
	// Every delivered url is pushed, and the queue is drained whole: the
	// defect this guards against was consuming only `urls.first()`.
	assert.match(tauriLib, /for url in urls/);
	assert.match(tauriLib, /startup_files\)\s*\.push\(path_str\.clone\(\)\)/);
	assert.match(runtime, /startup_files\)\s*\.drain\(\.\.\)\s*\.collect\(\)/);
	assert.match(runtime, /for path in startup_files\.into_iter\(\)\.rev\(\)/);
	assert.match(viewer, /for \(const path of args\) await loadMarkdown\(path\);/);
});
