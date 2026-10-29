import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { readSource, rustSourceFiles } from './sourceTree.js';

/*
 * Static checks of Rust-side conventions that neither the type system, clippy
 * (src-tauri/clippy.toml) nor a run can see. This is the only file in the suite
 * that reads source to assert on it; the frontend's conventions are lint rules
 * (eslint.config.js, `npm run lint`) and the Rust-TS boundary is generated
 * (src/lib/bindings.ts).
 *
 * Rust is read through `rustCode`, which blanks comments and string/char
 * literals so prose and messages cannot match, and the checks match Tauri's
 * and the plugins' public API (`#[tauri::command]`, `collect_commands!`,
 * `get_webview_window`, `with_state_flags`, `save_window_state`) rather than
 * the app's private names. The one exception is named where it is checked.
 */

/** `text` with comments and string/char literal contents replaced by spaces, offsets kept. */
function rustCode(text: string): string {
	const out = text.split('');
	const blank = (from: number, to: number) => {
		for (let k = from; k < to; k++) if (out[k] !== '\n') out[k] = ' ';
	};
	let i = 0;
	while (i < text.length) {
		const rest = text.slice(i, i + 3);
		if (rest.startsWith('//')) {
			const end = text.indexOf('\n', i);
			const to = end === -1 ? text.length : end;
			blank(i, to);
			i = to;
		} else if (rest.startsWith('/*')) {
			let depth = 0;
			let j = i;
			do {
				if (text.startsWith('/*', j)) (depth++, (j += 2));
				else if (text.startsWith('*/', j)) (depth--, (j += 2));
				else j++;
			} while (depth > 0 && j < text.length);
			blank(i, j);
			i = j;
		} else if (/^(b?r#*")/.test(rest) || /^br#*"/.test(text.slice(i, i + 4))) {
			const open = /^b?r(#*)"/.exec(text.slice(i))!;
			const close = `"${open[1]}`;
			const end = text.indexOf(close, i + open[0].length);
			const to = end === -1 ? text.length : end + close.length;
			blank(i + open[0].length, to - close.length);
			i = to;
		} else if (text[i] === '"') {
			let j = i + 1;
			while (j < text.length && text[j] !== '"') j += text[j] === '\\' ? 2 : 1;
			blank(i + 1, j);
			i = j + 1;
		} else if (text[i] === "'" && /^'(\\.[^']*|[^'\\])'/.test(text.slice(i))) {
			// A char literal; a lifetime (`'a`) has no closing quote right after.
			const len = /^'(\\.[^']*|[^'\\])'/.exec(text.slice(i))![0].length;
			blank(i + 1, i + len - 1);
			i += len;
		} else i++;
	}
	return out.join('');
}

/** The text between the bracket at `open` and its partner. */
function bracketBody(code: string, open: number): string {
	const pairs: Record<string, string> = { '(': ')', '[': ']', '{': '}' };
	const close = pairs[code[open]];
	let depth = 0;
	for (let i = open; i < code.length; i++) {
		if (code[i] === code[open]) depth++;
		else if (code[i] === close && --depth === 0) return code.slice(open + 1, i);
	}
	throw new Error(`unbalanced ${code[open]} at ${open}`);
}

/** The body of `fn name` in `code`. */
function fnBody(code: string, name: string): string {
	const at = new RegExp(`\\bfn\\s+${name}\\b`).exec(code);
	assert.ok(at, `fn ${name} not found`);
	return bracketBody(code, code.indexOf('{', at.index));
}

const files = rustSourceFiles().map((path) => ({ path, code: rustCode(readSource(path)) }));
const backend = files.map((file) => file.code).join('\n');

describe('Rust conventions', () => {
	test('every #[tauri::command] is registered in collect_commands!', () => {
		// A Tauri command is addressed by name from the frontend. An attribute on a
		// function that is not registered claims an exposure the app does not have:
		// `convert_markdown` carried one for as long as it existed, never
		// registered, called only by `render_markdown`. rustc's dead_code catches
		// an unregistered command nothing calls; this is the one something does.
		const declared = files.flatMap(({ path, code }) =>
			[...code.matchAll(/#\[tauri::command\][^\n]*\n(?:\s*#\[[^\]]*\]\s*\n)*\s*(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?fn\s+(\w+)/g)].map(
				(m) => `${m[1]} (${path})`,
			),
		);
		const macro = /collect_commands!\s*\[/.exec(backend);
		assert.ok(macro, 'collect_commands! not found');
		const registered = new Set(
			bracketBody(backend, macro.index + macro[0].length - 1)
				.split(',')
				.map((entry) => entry.trim().split('::').pop())
				.filter(Boolean),
		);
		assert.ok(declared.length > 30, `found ${declared.length} commands`);
		assert.deepEqual(
			declared.filter((entry) => !registered.has(entry.split(' ')[0])),
			[],
			'marked #[tauri::command] but missing from collect_commands!, so the frontend cannot reach it',
		);
	});

	test('the copy command keeps X11 clipboard ownership past its own return', () => {
		// #729: X11 has no clipboard store, and arboard drops the CLIPBOARD
		// selection with its last `Clipboard` handle, which was the moment the
		// command returned. The failure needs an X server and a desktop without a
		// clipboard manager, which CI has neither of, so this names the private
		// helper on purpose: nothing but the call connects the two.
		assert.match(fnBody(backend, 'clipboard_write_text'), /\bretain_clipboard_ownership\s*\(\s*\)/);
	});

	test('nothing looks a window back up and unwraps it', () => {
		// #318: startup built the window, threw the handle away and looked it up
		// by label, unwrapping an Option that is None on exactly the path where
		// the lookup misses. Keep the handle the builder returns.
		assert.deepEqual(
			[...backend.matchAll(/get_webview_window\s*\([^)]*\)\s*\.\s*(?:unwrap|expect)\s*\(/g)].map((m) => m[0]),
			[],
		);
	});
});
