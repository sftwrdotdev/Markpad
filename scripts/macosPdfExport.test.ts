import assert from 'node:assert/strict';
import test from 'node:test';

import { readRustBackend, readSource, sliceBetween } from './sourceTree.js';

test('all Markpad webviews may invoke Tauri native printing', () => {
	const capability = JSON.parse(readSource('src-tauri/capabilities/default.json')) as {
		windows: string[];
		permissions: string[];
	};

	assert.deepEqual(capability.windows, ['main', 'window-*']);
	assert.ok(
		capability.permissions.includes('core:webview:allow-print'),
		'macOS replaces window.print() with Tauri native printing, which requires this permission',
	);
});

// Salvaged from `windowsPdfExport.test.ts`, which was deleted for asserting the
// spelling of the Rust body (it stayed green with the `await` dropped from the
// call below). This part is the opposite kind of claim: a Tauri command name is
// a bare string on the JS side and an identifier inside a macro on the Rust
// side, so nothing — not tsc, not `svelte-check`, not `cargo check` — notices
// when one moves and the other does not. The failure is silent at build time
// and total at runtime: "Export PDF" does nothing at all.
test('both PDF commands the exporter invokes are registered with Tauri', () => {
	const exporter = readSource('src/lib/utils/export.ts');
	const tauriLib = readRustBackend();

	const registered = new Set(
		sliceBetween(tauriLib, 'tauri::generate_handler![', ']')
			.split(',')
			.map((entry) => entry.trim().replace(/^.*::/, '')),
	);

	// Read the names off the exporter rather than restating them, so a renamed
	// command is checked at its new name instead of quietly passing.
	const invoked = [...exporter.matchAll(/invoke\('([a-z_]*pdf[a-z_]*)'/g)].map((m) => m[1]);
	assert.deepEqual(invoked.sort(), ['export_pdf_windows', 'print_pdf']);

	for (const command of invoked) {
		assert.ok(registered.has(command), `export.ts invokes '${command}', which lib.rs must register`);
		assert.match(
			tauriLib,
			new RegExp(`#\\[tauri::command\\]\\n(?:pub )?(?:async )?fn ${command}\\(`),
			`${command} must be defined as a Tauri command`,
		);
	}
});
