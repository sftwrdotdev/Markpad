import assert from 'node:assert/strict';
import test from 'node:test';

import { readSource } from './sourceTree.js';

// `package.json` and `src-tauri/Cargo.toml` are the two files AGENTS.md tells
// you to bump. `src-tauri/Cargo.lock` is the third, and it is the one that gets
// forgotten: nothing in the editing loop reads it, so a bump lands green and
// stays wrong until someone runs `cargo build` — which rewrites the one line to
// match `Cargo.toml` and hands them a dirty working tree they did not ask for.
// That is how the 2.7.2/2.7.3 skew was found, one release after it shipped.
//
// The fix is `cargo update -p Markpad --precise <version>` (or any `cargo
// check` in `src-tauri`, which does it as a side effect), then commit the
// one-line diff.

test('package.json, Cargo.toml and Cargo.lock declare the same version', () => {
	const pkg = JSON.parse(readSource('package.json')).version;

	const toml = /^version = "([^"]+)"/m.exec(readSource('src-tauri/Cargo.toml'))?.[1];
	assert.ok(toml, 'no top-level version key in src-tauri/Cargo.toml');

	// Anchored on the package entry, not on the first `version` in the file:
	// the lock has 661 of them and Markpad's is not the first.
	const lock = /\[\[package\]\]\nname = "Markpad"\nversion = "([^"]+)"/.exec(
		readSource('src-tauri/Cargo.lock'),
	)?.[1];
	assert.ok(lock, 'no Markpad package entry in src-tauri/Cargo.lock');

	assert.equal(toml, pkg, 'src-tauri/Cargo.toml is out of step with package.json');
	assert.equal(
		lock,
		pkg,
		'src-tauri/Cargo.lock is out of step with package.json; run `cargo update -p Markpad --precise ' +
			`${pkg}\` in src-tauri and commit the change`,
	);
});
