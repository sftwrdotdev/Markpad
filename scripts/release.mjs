#!/usr/bin/env node
/**
 * Set the app version, in all three places, from one argument.
 *
 * The version is one fact and the repository writes it three times:
 * package.json, src-tauri/Cargo.toml, and the `Markpad` entry in
 * src-tauri/Cargo.lock. RELEASING.md names the first two; the lock is the one
 * that gets forgotten, because nothing in the editing loop reads it. A bump
 * without it lands green and stays wrong until the next person's `cargo build`
 * rewrites the line and hands them a dirty working tree they did not ask for --
 * which is how the 2.7.2/2.7.3 skew was found, one release after it shipped.
 *
 * scripts/versionSync.test.ts catches that skew. This is the other half: a
 * guard says the three disagree, and this makes it hard for them to.
 *
 * It deliberately stops before committing, tagging or pushing. Whether a tag
 * push should start a release build, and whether the changelog is part of this,
 * are open questions in #562 with the maintainer's name on them. The version
 * bump is not a question, so it does not wait for the answers.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

const version = process.argv[2];
if (!version || !/^\d+\.\d+\.\d+$/.test(version)) {
	console.error('usage: npm run release <X.Y.Z>');
	process.exit(2);
}

/** Replace once, and fail loudly rather than writing a file that changed nothing. */
function edit(path, pattern, replacement) {
	const before = readFileSync(path, 'utf8');
	const after = before.replace(pattern, replacement);
	if (after === before) {
		console.error(`${path}: nothing matched ${pattern}. Refusing to write it unchanged.`);
		process.exit(1);
	}
	writeFileSync(path, after);
	return path;
}

edit('package.json', /("version":\s*")[^"]+(")/, `$1${version}$2`);
// Anchored on the [package] table: Cargo.toml has a `version` under every
// dependency and the first one in the file is not necessarily ours.
edit('src-tauri/Cargo.toml', /(\[package\][\s\S]*?\nversion = ")[^"]+(")/, `$1${version}$2`);

// The lock is not edited by hand -- cargo owns its format, and it is the file
// this whole script exists for.
execFileSync('cargo', ['update', '-p', 'Markpad', '--precise', version], {
	cwd: 'src-tauri',
	stdio: 'inherit',
});

const seen = {
	'package.json': JSON.parse(readFileSync('package.json', 'utf8')).version,
	'src-tauri/Cargo.toml': /\[package\][\s\S]*?\nversion = "([^"]+)"/.exec(
		readFileSync('src-tauri/Cargo.toml', 'utf8'),
	)?.[1],
	'src-tauri/Cargo.lock': /\[\[package\]\]\nname = "Markpad"\nversion = "([^"]+)"/.exec(
		readFileSync('src-tauri/Cargo.lock', 'utf8'),
	)?.[1],
};
const wrong = Object.entries(seen).filter(([, v]) => v !== version);
if (wrong.length > 0) {
	console.error('after writing, these still disagree:');
	for (const [path, v] of wrong) console.error(`  ${path}: ${v ?? '(not found)'}`);
	process.exit(1);
}

console.log(`\nAll three files say ${version}. Still yours to do:\n`);
console.log(`  git commit -am "chore: bump version to ${version}"`);
console.log(`  git tag v${version}`);
console.log(`  git push origin master v${version}`);
console.log(`  then dispatch "Build and Release" — RELEASING.md has the rest\n`);
