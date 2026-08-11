import assert from 'node:assert/strict';
import test from 'node:test';

import { readSource, rustSourceFiles, sliceBetween } from './sourceTree.js';

/** Every `#[tauri::command]` function name in the Rust sources. */
function declaredCommands(): { name: string; file: string }[] {
	const out: { name: string; file: string }[] = [];
	for (const file of rustSourceFiles()) {
		const text = readSource(file);
		// The attribute, any further attributes stacked under it, then the fn.
		for (const m of text.matchAll(
			/#\[tauri::command\][^\n]*\n(?:\s*#\[[^\]]*\]\s*\n)*\s*(?:pub\s+)?(?:async\s+)?fn\s+(\w+)/g,
		)) {
			out.push({ name: m[1], file });
		}
	}
	return out;
}

/** Every name inside `generate_handler![…]`, module path stripped. */
function registeredCommands(): Set<string> {
	// `sliceBetween` keeps its start anchor, so the first comma-separated entry
	// would otherwise be `generate_handler![\n  clipboard_write_text`.
	const handler = sliceBetween(readSource('src-tauri/src/app.rs'), 'generate_handler![', '])').replace(
		'generate_handler![',
		'',
	);
	return new Set(
		handler
			.split(',')
			.map((entry) => entry.trim().split('::').pop() ?? '')
			.filter(Boolean),
	);
}

test('every #[tauri::command] is reachable from the frontend', () => {
	// A Tauri command is addressed by a string. Nothing in either type system
	// connects `invoke('render_markdown')` to the Rust function, and nothing
	// connects the function to `generate_handler!` either — so an attribute can
	// sit on a function the app can never call, and the compiler is content.
	//
	// `convert_markdown` carried one for as long as it existed. It was never
	// registered, so no `invoke` could ever have reached it; it is the internal
	// renderer that `render_markdown` and `build_markdown_preview` call. The
	// attribute claimed an exposure the app did not have, and the only reason
	// that was ever discovered was someone reading the two lists side by side.
	const registered = registeredCommands();
	const unreachable = declaredCommands().filter(({ name }) => !registered.has(name));
	assert.deepEqual(
		unreachable,
		[],
		`these functions are marked #[tauri::command] but are not in generate_handler!, so no invoke() can reach them: ${unreachable
			.map(({ name, file }) => `${name} (${file})`)
			.join(', ')}`,
	);
});

test('generate_handler! names nothing that does not exist', () => {
	// The other direction fails at compile time rather than silently, so this
	// is a cheaper assertion than the one above — but it also catches a
	// registration left behind after its function was renamed, which reads as a
	// working command right up until the build.
	const declared = new Set(declaredCommands().map(({ name }) => name));
	const orphaned = [...registeredCommands()].filter((name) => !declared.has(name));
	assert.deepEqual(orphaned, [], `registered but not declared as a command: ${orphaned.join(', ')}`);
});
