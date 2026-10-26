import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, test } from 'node:test';

import { parse } from 'yaml';

import { offsetOf, readSource, sliceBetween } from './sourceTree.js';

describe('the sourceTree helpers', () => {
	test('a missing anchor fails loudly instead of slicing from -1', () => {
		// `'abc'.slice(-1)` is `'c'`, not `''` — which is why an unguarded
		// `slice(indexOf(...))` produces a one-character subject that no
		// `doesNotMatch` can fail against.
		assert.equal('abc'.slice('abc'.indexOf('zzz')), 'c');

		assert.throws(() => sliceBetween('abc', 'zzz', 'b'), /expected to find "zzz"/);
		assert.throws(() => sliceBetween('abc', 'a', 'zzz'), /expected to find "zzz" after "a"/);
		assert.throws(() => offsetOf('abc', 'zzz'), /expected to find "zzz"/);
		assert.throws(() => offsetOf('abcb', 'b', 4), /expected to find "b"/);

		assert.equal(sliceBetween('abcd', 'b', 'd'), 'bc');
		assert.equal(offsetOf('abcb', 'b', 2), 3);

		// `end` is searched from the end of `start`, so an earlier occurrence of
		// `end` is a failure rather than an empty subject.
		assert.throws(() => sliceBetween('xabc', 'b', 'x'), /expected to find "x" after "b"/);
	});
});

describe('release version bump', () => {
	// The stand-in cargo is a shell script.
	const posix = { skip: process.platform === 'win32' && 'needs a POSIX shell' };

	test('one command writes the version into all three files', posix, () => {
		// RELEASING.md used to name two of the three, so the third was skipped by
		// following the instructions correctly. The script runs here against a
		// copy of the three manifests, with a stand-in `cargo` that records what
		// it was asked and rewrites the lock entry the way `cargo update` does.
		const root = realpathSync(mkdtempSync(join(tmpdir(), 'markpad-release-')));
		try {
			mkdirSync(join(root, 'src-tauri'));
			mkdirSync(join(root, 'bin'));
			writeFileSync(join(root, 'package.json'), '{\n  "name": "markpad",\n  "version": "1.0.0"\n}\n');
			writeFileSync(
				join(root, 'src-tauri/Cargo.toml'),
				// A dependency's `version` ahead of ours, as a reordered manifest has.
				'[dependencies]\nserde = { version = "1.0.0" }\n\n[package]\nname = "Markpad"\nversion = "1.0.0"\n',
			);
			writeFileSync(
				join(root, 'src-tauri/Cargo.lock'),
				'[[package]]\nname = "Markpad"\nversion = "1.0.0"\n\n[[package]]\nname = "serde"\nversion = "1.0.0"\n',
			);
			const cargo = join(root, 'bin/cargo');
			writeFileSync(
				cargo,
				[
					'#!/bin/sh',
					'echo "$PWD $*" > ../cargo-call',
					'[ "$1 $2 $3" = "update -p Markpad" ] || exit 9',
					'sed -i.bak "/^name = \\"Markpad\\"$/{n;s/^version = .*/version = \\"$5\\"/;}" Cargo.lock',
				].join('\n'),
			);
			chmodSync(cargo, 0o755);

			const run = spawnSync(process.execPath, [resolve('scripts/release.mjs'), '2.3.4'], {
				cwd: root,
				env: { ...process.env, PATH: `${join(root, 'bin')}:${process.env.PATH}` },
				encoding: 'utf8',
			});
			assert.equal(run.status, 0, run.stderr);

			assert.equal(JSON.parse(readSource(join(root, 'package.json'))).version, '2.3.4');
			const toml = readSource(join(root, 'src-tauri/Cargo.toml'));
			assert.match(toml, /\[package\]\nname = "Markpad"\nversion = "2.3.4"/);
			assert.match(toml, /serde = \{ version = "1.0.0" \}/, 'a dependency version is not ours');
			assert.match(readSource(join(root, 'src-tauri/Cargo.lock')), /name = "Markpad"\nversion = "2.3.4"/);
			// The lock is cargo's format; it is handed to cargo, not rewritten.
			assert.equal(
				readSource(join(root, 'cargo-call')).trim(),
				`${join(root, 'src-tauri')} update -p Markpad --precise 2.3.4`,
			);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});

// The shell in the release workflow's steps, run under bash with stand-ins for
// the commands that would reach GitHub or the keychain.
describe('release workflow steps', () => {
	const posix = { skip: process.platform === 'win32' && 'spawns /bin/bash with a POSIX PATH' };
	const workflow = parse(readSource('.github/workflows/build.yml')) as {
		jobs: Record<string, { steps: { name?: string; run: string; env?: Record<string, string>; if?: string }[] }>;
	};
	const stepNames = (job: string) => workflow.jobs[job].steps.map((step) => step.name);
	function buildStep(job: string, name: string) {
		const step = workflow.jobs[job].steps.find((step) => step.name === name);
		assert.ok(step, `${job} has no step named ${name}`);
		return step;
	}

	test('a release build cannot write into a version that is already published', posix, () => {
		// The release is composed for `v<version from package.json>`, and
		// softprops/action-gh-release updates an existing release for that tag rather
		// than refusing it. So a dispatch from an unbumped master rewrites the
		// release users are downloading, and every gate after it (the draft, the
		// asset check, clicking Publish) is downstream of that write.
		const names = stepNames('create-release');
		const guardName = 'This version has not already been released';
		assert.ok(names.indexOf(guardName) >= 0 && names.indexOf(guardName) < names.indexOf('Create Release'), 'the guard runs after the release it guards has been created');
		const run = buildStep('create-release', guardName).run.replaceAll('${{ steps.get_version.outputs.version }}', '9.9.9');

		const dir = mkdtempSync(join(tmpdir(), 'markpad-release-guard-'));
		try {
			// `gh release view` as GitHub answers it: FAKE_GH_OUT on stdout, FAKE_GH_ERR on
			// stderr, FAKE_GH_EXIT as the status. The call itself is recorded.
			writeFileSync(join(dir, 'gh'), `#!/bin/sh
echo "$*" > "${dir}/gh-call"
[ -n "$FAKE_GH_OUT" ] && printf '%s' "$FAKE_GH_OUT"
[ -n "$FAKE_GH_ERR" ] && printf '%s' "$FAKE_GH_ERR" >&2
exit "$FAKE_GH_EXIT"
`, { mode: 0o755 });
			const answers = [
				// Fails closed on both unusable answers: published, and cannot tell.
				{ name: 'published', out: '{"isDraft":false}', err: '', exit: 0, ok: false },
				{ name: 'an API error', out: '', err: 'HTTP 502: Bad Gateway', exit: 1, ok: false },
				{ name: 'an answer that is not JSON', out: '<html>', err: '', exit: 0, ok: false },
				// A draft is the recovery path, and no release is the normal one.
				{ name: 'a draft', out: '{"isDraft":true}', err: '', exit: 0, ok: true },
				{ name: 'no release', out: '', err: 'release not found', exit: 1, ok: true },
			];
			for (const answer of answers) {
				const result = spawnSync('/bin/bash', ['-c', run], {
					env: { PATH: `${dir}:/usr/bin:/bin`, GITHUB_REPOSITORY: 'markpad-app/Markpad', GITHUB_TOKEN: 'fixture',
						FAKE_GH_OUT: answer.out, FAKE_GH_ERR: answer.err, FAKE_GH_EXIT: String(answer.exit) },
					encoding: 'utf8',
				});
				assert.equal(result.status === 0, answer.ok, `${answer.name}: exit ${result.status}\n${result.stdout}${result.stderr}`);
				assert.equal(readSource(join(dir, 'gh-call')).trim(), 'release view v9.9.9 --repo markpad-app/Markpad --json isDraft');
			}
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test('official macOS signing refuses partial credentials before touching the keychain', posix, () => {
		const step = buildStep('build', 'Import macOS signing certificate');
		const names = ['APPLE_DEVELOPER_ID_P12', 'APPLE_DEVELOPER_ID_PASSWORD', 'APPLE_DEVELOPER_ID_SHA1', 'APPLE_ID', 'APPLE_APP_SPECIFIC_PASSWORD', 'APPLE_TEAM_ID'];
		const complete: Record<string, string> = Object.fromEntries(names.map(name => [name, 'fixture']));
		complete.APPLE_DEVELOPER_ID_P12 = 'Zml4dHVyZQ==';
		complete.APPLE_DEVELOPER_ID_SHA1 = 'A'.repeat(40);
		complete.APPLE_TEAM_ID = 'ABCDEFGHIJ';
		const dir = mkdtempSync(join(tmpdir(), 'markpad-signing-test-'));
		try {
			// A mock command prevents any real keychain access even if a guard regresses.
			writeFileSync(join(dir, 'security'), '#!/bin/sh\necho keychain-touched >&2\nexit 97\n', { mode: 0o755 });
			for (const missing of names) {
				const env = { PATH: `${dir}:/usr/bin:/bin`, RUNNER_TEMP: dir, GITHUB_ENV: join(dir, 'env'), ...complete, [missing]: '' };
				const result = spawnSync('/bin/bash', ['-c', step.run], { env, encoding: 'utf8' });
				assert.notEqual(result.status, 0, `${missing} was silently accepted`);
				assert.doesNotMatch(result.stderr, /keychain-touched/, `${missing} was not checked before import`);
			}
			// The early exit is for a repository that never set up signing, and it reads
			// only the certificate. A set certificate with an empty identity would walk
			// past it and export an empty APPLE_SIGNING_IDENTITY: a green build that
			// shipped unsigned, which reaches users as folder access being asked for all
			// over again.
			const halfLegacy = spawnSync('/bin/bash', ['-c', step.run], {
				env: { PATH: `${dir}:/usr/bin:/bin`, RUNNER_TEMP: dir, GITHUB_ENV: join(dir, 'env'),
					MACOS_CERTIFICATE: 'Zml4dHVyZQ==', MACOS_CERTIFICATE_PASSWORD: 'legacy', MACOS_SIGNING_IDENTITY: '' },
				encoding: 'utf8',
			});
			assert.notEqual(halfLegacy.status, 0, 'a certificate with no signing identity was accepted');
			assert.doesNotMatch(halfLegacy.stderr, /keychain-touched/, 'the empty identity was not checked before import');
			writeFileSync(join(dir, 'security'), `#!/bin/sh
if [ "$1" = find-identity ]; then
  echo '1) ${complete.APPLE_DEVELOPER_ID_SHA1} "Developer ID Application: Test (ABCDEFGHIJ)"'
fi
`, { mode: 0o755 });
			const envFile = join(dir, 'env');
			const configured = spawnSync('/bin/bash', ['-c', step.run], {
				env: { PATH: `${dir}:/usr/bin:/bin`, RUNNER_TEMP: dir, GITHUB_ENV: envFile, ...complete,
					MACOS_CERTIFICATE: 'Zml4dHVyZQ==', MACOS_CERTIFICATE_PASSWORD: 'legacy', MACOS_SIGNING_IDENTITY: 'legacy' },
				encoding: 'utf8',
			});
			assert.equal(configured.status, 0, configured.stderr);
			assert.equal(readSource(envFile), `MACOS_DEVELOPER_ID=true\nAPPLE_SIGNING_IDENTITY=${complete.APPLE_DEVELOPER_ID_SHA1}\n`);
			const wrongIdentity = spawnSync('/bin/bash', ['-c', step.run], {
				env: { PATH: `${dir}:/usr/bin:/bin`, RUNNER_TEMP: dir, GITHUB_ENV: envFile, ...complete, APPLE_DEVELOPER_ID_SHA1: 'B'.repeat(40) },
				encoding: 'utf8',
			});
			assert.notEqual(wrongIdentity.status, 0, 'a different imported identity must not be accepted');
			writeFileSync(envFile, '');
			const legacy = spawnSync('/bin/bash', ['-c', step.run], {
				env: { PATH: `${dir}:/usr/bin:/bin`, RUNNER_TEMP: dir, GITHUB_ENV: envFile,
					MACOS_CERTIFICATE: 'Zml4dHVyZQ==', MACOS_CERTIFICATE_PASSWORD: 'legacy', MACOS_SIGNING_IDENTITY: 'legacy' },
				encoding: 'utf8',
			});
			assert.equal(legacy.status, 0, legacy.stderr);
			assert.equal(readSource(envFile), 'APPLE_SIGNING_IDENTITY=legacy\n');

			const absent = spawnSync('/bin/bash', ['-c', step.run], { env: { PATH: `${dir}:/usr/bin:/bin` }, encoding: 'utf8' });
			assert.equal(absent.status, 0, absent.stderr);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
