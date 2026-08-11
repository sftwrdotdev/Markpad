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

test('one command writes the version, and the runbook names it', () => {
	// The assertion above catches the three files disagreeing. This is the other
	// half: something that makes them hard to disagree in the first place.
	// RELEASING.md used to name two of the three, so the third was skipped by
	// following the instructions correctly.
	const pkg = JSON.parse(readSource('package.json'));
	assert.equal(pkg.scripts.release, 'node scripts/release.mjs');

	// It has to touch all three, or it is a bump that reintroduces the skew.
	const script = readSource('scripts/release.mjs');
	for (const file of ['package.json', 'src-tauri/Cargo.toml', 'Cargo.lock']) {
		assert.ok(script.includes(file), `scripts/release.mjs never mentions ${file}`);
	}
	// The lock is cargo's format; a hand-rolled rewrite of it is the bug, not the
	// fix.
	assert.match(script, /cargo['"],\s*\['update'/);

	// And the runbook points at the command rather than at the two files.
	assert.match(readSource('RELEASING.md'), /npm run release X\.Y\.Z/);
	assert.match(readSource('AGENTS.md'), /npm run release X\.Y\.Z/);
});
