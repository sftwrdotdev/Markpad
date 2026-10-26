import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';

import { parse } from 'yaml';

import {
	SANITIZER_FILES,
	type SourceFile,
	filesMatching,
	readDictionarySource,
	readRustBackend,
	readSource,
	readSourceFiles,
	rustSourceFiles,
	sliceBetween,
	sliceFrom,
} from './sourceTree.js';

describe('the release workflow', () => {
	const workflow = readSource('.github/workflows/build.yml');
	const publishWorkflow = readSource('.github/workflows/publish-packages.yml');
	const testWorkflow = readSource('.github/workflows/test.yml');
	const testBuildWorkflow = readSource('.github/workflows/test_build.yml');
	const releasing = readSource('RELEASING.md');
	const snapcraft = readSource('snapcraft.yaml');
	const stripAppImage = readSource('scripts/strip-appimage.sh');
	const checkAppImageLibraries = readSource('scripts/check-appimage-libraries.sh');
	const smokeAppImage = readSource('scripts/smoke-appimage.sh');
	const readme = readSource('README.md');
	const cargoToml = readSource('src-tauri/Cargo.toml');
	const packageJson = JSON.parse(readSource('package.json')) as {
		scripts: Record<string, string>;
		devDependencies: Record<string, string>;
		version: string;
	};
	const tauriConf = JSON.parse(readSource('src-tauri/tauri.conf.json')) as {
		plugins: { updater: { endpoints: string[]; pubkey: string } };
	};

	/** Every `node-version:` value in a workflow, in file order. */
	function nodeVersions(source: string): string[] {
		return [...source.matchAll(/^\s*node-version:\s*'?([^'\s]+)'?\s*$/gm)].map((m) => m[1]);
	}

	/**
	 * Every versioned Ubuntu runner a workflow names, ignoring comments — naming a
	 * superseded runner is what a comment is for. `ubuntu-latest` is not versioned
	 * and not part of the fact.
	 */
	function ubuntuRunners(source: string): string[] {
		return source
			.split('\n')
			.filter((line) => !/^\s*#/.test(line))
			.flatMap((line) => [...line.matchAll(/\bubuntu-\d+\.\d+\b/g)].map((m) => m[0]));
	}

	test('release builds install the locked dependency graph', () => {
		assert.match(workflow, /name: Install Frontend Dependencies\s+run: npm ci/);
		assert.doesNotMatch(workflow, /npm install/);
	});

	test('the snap ships the binary the release shipped, not a second build of it', () => {
		// This used to assert `npm ci` in snapcraft.yaml, because the snap resolved
		// its own dependency graph and compiled its own binary. RELEASING.md promises
		// every channel resolves the committed lockfile, and two compilations of one
		// source satisfy that while still producing two different binaries: a snap
		// user and a .deb user of the same version did not have the same file.
		//
		// Packaging the release's .deb makes the promise structural instead. It also
		// takes rust and node out of a file that had no other reason to hold them.
		assert.match(snapcraft, /^\s*source-type: deb$/m);
		for (const builder of [/npm ci/, /npm install/, /tauri build/, /rustup/, /cargo/]) {
			assert.doesNotMatch(snapcraft, builder, `snapcraft.yaml is building, not packaging: ${builder}`);
		}
	});

	test('the .deb the snap packages is the one from the release being published', () => {
		// The whole guarantee is that the Snap Store serves what the release page
		// serves. It rests on where this file comes from, so the download is pinned
		// to the tag and to the exact name build.yml uploads — not `latest`, and not
		// a pattern that could match a different architecture.
		const snapJob = sliceFrom(publishWorkflow, '\n  snap:');
		assert.match(snapJob, /gh release download "\$TAG"/);
		assert.match(snapJob, /--pattern "Markpad_\$\{VERSION\}_amd64\.deb"/);
		assert.match(snapJob, /--output markpad\.deb/);
	});

	test('the runtime version and the frontend version cannot drift apart', () => {
		// Tauri reads the runtime version from Cargo.toml while the Tauri config and
		// the frontend read package.json. A mismatch makes tauri-plugin-updater
		// compare the wrong version and either skip or replay an update.
		const cargoVersion = /^\s*\[package\][\s\S]*?^\s*version\s*=\s*"([^"]+)"/m.exec(cargoToml)?.[1];
		assert.equal(cargoVersion, packageJson.version);
	});

	test('portable executables are not mislabeled as installers', () => {
		assert.doesNotMatch(workflow, /MarkpadInstaller_/);
		assert.match(workflow, /bundle\/nsis.*-setup\.exe/);
	});

	test('the test bundle command uses an isolated builder', () => {
		assert.equal(packageJson.scripts['build:test-bundle'], 'node scripts/build-test-bundle.mjs');
	});

	test('the shipped app is built on the Node the tests ran on', () => {
		// build.yml pinned '20' in both of its jobs while test.yml and
		// test_build.yml used lts/*, so the binary users install was produced by a
		// runtime nothing had exercised. Node 20 went end-of-life in April 2026 and
		// left the runner toolcache in May: the v2.7.0 run downloaded 20.20.2 fresh
		// in all five jobs ("Attempting to download 20... Acquiring 20.20.2"), while
		// lts/* is a cache hit.
		//
		// The three files are one fact, so they are asserted against each other
		// rather than against a literal — pinning a specific version here would
		// re-create the drift one level up.
		const expected = [...new Set([...nodeVersions(testWorkflow), ...nodeVersions(testBuildWorkflow)])];
		assert.deepEqual(expected.length, 1, `the test workflows disagree on Node: ${expected.join(', ')}`);
		assert.deepEqual(
			[...new Set(nodeVersions(workflow))],
			expected,
			'build.yml must request the same Node as the workflows that test the code it ships',
		);
	});

	test('every workflow that compiles compiles on the same Ubuntu', () => {
		// The same drift as the Node assertion above, one axis over, and it outlived
		// it. test.yml ran on ubuntu-22.04 and test_build.yml's Linux entry said
		// ubuntu-22.04 -- both from the commits that created them, neither revisited
		// -- while build.yml moved to 24.04 and stayed maintained there through
		// #463's WebKitGTK unpin and #499's AppImage strip. All three run `cargo`
		// against the distribution's WebKitGTK headers, so two Ubuntus meant "the
		// pull request compiled" did not mean "the release will", and the AppImage a
		// pull request produced bundled libraries from a release nothing ships --
		// the class of defect #463 and #498 both were.
		//
		// Compared against each other rather than against a literal, for the reason
		// the Node one is: a version named here becomes another place to update.
		const named = new Set([
			...ubuntuRunners(testWorkflow),
			...ubuntuRunners(testBuildWorkflow),
			...ubuntuRunners(workflow),
		]);
		assert.ok(named.size > 0, 'no versioned Ubuntu runner found in any workflow');
		assert.equal(named.size, 1, `the workflows disagree on Ubuntu: ${[...named].sort().join(', ')}`);
	});

	test('a step asks which matrix entry it is, not which runner it landed on', () => {
		// `install dependencies (ubuntu only)` in test_build.yml asked for
		// `matrix.platform == 'ubuntu-22.04'`. Moving the matrix to 24.04 therefore
		// skipped it in silence, and `cargo test` failed on a missing
		// libwebkit2gtk-4.1-dev instead of on anything to do with the change --
		// run 31486273066, on the pull request that made it.
		//
		// Every matrix here already carries a stable name for the entry (`os` in
		// build.yml, `os-name` in test_build.yml) that does not change when the
		// runner does. Conditions use that; the runner is named once, where the
		// matrix declares it.
		for (const [name, source] of [
			['build.yml', workflow],
			['test_build.yml', testBuildWorkflow],
		] as const) {
			const repeats = source
				.split('\n')
				.filter((line) => !/^\s*#/.test(line))
				.filter((line) => /matrix\.platform\s*==/.test(line));
			assert.deepEqual(repeats, [], `${name} branches on the runner name; branch on the matrix entry instead`);
		}
	});

	/** The packages an `apt-get install -y` line asks for, sorted. */
	function aptPackages(source: string): string[] {
		const line = /apt-get install -y((?:[^\n]*\\\n)*[^\n]*)/.exec(source)?.[1] ?? '';
		return line
			.split(/[\s\\]+/)
			.filter(Boolean)
			.sort();
	}

	test('a release installs the dependencies a pull request proved it can build with', () => {
		// build.yml only runs on workflow_dispatch, so its apt list is the one part
		// of the Linux build no pull request exercises -- it asked for sixteen
		// packages against test_build.yml's six, and nothing said which was right.
		// Six of the ten extras apt installs anyway as dependencies of
		// libwebkit2gtk-4.1-dev; the four libxcb *-dev packages and xdg-utils are in
		// no Tauri v2 prerequisite list. Run 31487547674 built the .deb, the .rpm and
		// the AppImage on ubuntu-24.04 with six.
		//
		// One list rather than a shorter one is the point. Both workflows compile and
		// bundle, so a difference between them is a release depending on something
		// nothing tested — which is what this was.
		assert.deepEqual(
			aptPackages(sliceFrom(workflow, 'Install Linux dependencies')),
			aptPackages(sliceFrom(testBuildWorkflow, 'install dependencies (ubuntu only)')),
			'the release build and the pull request build install different Linux packages',
		);

		// test.yml compiles but never bundles, so it needs everything above except
		// the bundlers. Asserted as a subset rather than as its own list, so adding a
		// dependency in one place cannot leave it behind.
		const bundlers = new Set(['rpm']);
		assert.deepEqual(
			aptPackages(sliceFrom(testWorkflow, 'install dependencies (ubuntu only)')),
			aptPackages(sliceFrom(testBuildWorkflow, 'install dependencies (ubuntu only)')).filter(
				(p) => !bundlers.has(p),
			),
			'test.yml has drifted from the list the builds use',
		);
	});

	test('a cargo cache cannot outlive the runner image that filled it', () => {
		// rust-cache's key ends `-Linux-x64`: `runner.os`, not the image. Measured on
		// two runs of the same job, one per Ubuntu, the key was identical --
		// `v0-rust-linux-build-test-Linux-x64-e8b3ee54-a2c94f3a` -- so moving the
		// runner would have restored a jammy-built target/ into a noble build as a
		// full match. Cargo fingerprints do not track system libraries: the
		// webkit2gtk-sys build script's probe of the wrong distribution's headers
		// would have been reused with nothing to notice.
		//
		// `$ImageOS` comes from the runner, so this also covers the image changing
		// under `macos-latest` and `windows-latest`, which happens without a commit.
		for (const [name, source] of [
			['test.yml', testWorkflow],
			['test_build.yml', testBuildWorkflow],
		] as const) {
			const cacheStep = sliceFrom(source, 'uses: Swatinem/rust-cache@v2');
			const key = /^\s*key:\s*(.+)$/m.exec(cacheStep)?.[1];
			assert.ok(key, `${name} caches cargo without a key naming the runner image`);
			assert.match(key, /env\.IMAGE_OS/, `${name}'s cache key does not change when the runner image does`);
			assert.match(source, /IMAGE_OS=\$ImageOS/, `${name} never reads $ImageOS into the environment`);
		}
	});

	test('the updater feed publishes the keys an installed Markpad can ask for', () => {
		// tauri-plugin-updater tries `{os}-{arch}-{installer}` and then `{os}-{arch}`,
		// and only tries the first when the binary knows its own bundle type. Ours
		// does not on Windows or Linux — the `__TAURI_BUNDLE_TYPE` patch fails there,
		// three times in the v2.7.0 build. Those clients therefore look up the plain
		// key and nothing else, so a per-installer key added here would be invisible
		// to them, and one added *instead* would strand them on TargetsNotFound.
		const platforms = sliceBetween(workflow, 'platforms: ({', '} | with_entries');
		const keys = [...platforms.matchAll(/"([a-z0-9_-]+)":/g)].map((m) => m[1]);
		assert.ok(keys.length >= 5, `expected the five platform keys, found ${keys.length}`);
		for (const key of keys) {
			assert.match(
				key,
				/^(darwin|windows|linux)-[a-z0-9_]+$/,
				`latest.json key "${key}" carries an installer suffix; Windows and Linux clients ` +
					'cannot ask for one until the missing bundle type is fixed',
			);
		}
	});

	test('a release build cannot write into a version that is already published', () => {
		// The release is composed for `v<version from package.json>`, and
		// softprops/action-gh-release updates an existing release for that tag rather
		// than refusing it. So a dispatch from an unbumped master rewrites the
		// release users are downloading, and every gate this pipeline has -- the
		// draft, the asset check, clicking Publish -- is downstream of that write.
		const step = sliceBetween(workflow, 'This version has not already been released', 'endpoint old installs');
		assert.match(step, /gh release view "\$TAG"/);
		assert.match(step, /isDraft/);
		// Fails closed: an unusable answer stops the run instead of assuming there is
		// no release. Two exits, one for published and one for cannot-tell.
		assert.equal((step.match(/exit 1/g) ?? []).length, 2);
		// And it has to come before the step that does the writing.
		assert.ok(
			workflow.indexOf('This version has not already been released') < workflow.indexOf('- name: Create Release'),
			'the guard runs after the release it guards has been created',
		);
	});

	test('the updater endpoint names the repository RELEASING.md documents', () => {
		// The endpoint is compiled into every installed copy, so getting it wrong is
		// only discoverable by a user who stops being offered updates. It was left
		// on `alecdotdev/Markpad` after the transfer and survived on a GitHub
		// redirect, which RELEASING.md now explains must never be broken. Config and
		// runbook are one fact; if the repository moves again, both move.
		//
		// Matched against the one sentence that states it, not against the document.
		// Measured: "RELEASING.md mentions this repo somewhere" passed with the
		// endpoint reverted to `alecdotdev/Markpad`, because the section warning
		// against recreating that repository necessarily names it.
		const endpoints = tauriConf.plugins.updater.endpoints;
		assert.equal(endpoints.length, 1, 'expected exactly one updater endpoint');
		const repo = /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/releases\//.exec(endpoints[0])?.[1];
		assert.ok(repo, `updater endpoint is not a GitHub releases URL: ${endpoints[0]}`);
		const documented = /The updater endpoint in `src-tauri\/tauri\.conf\.json` points at \*\*`([\w.-]+\/[\w.-]+)`\*\*/.exec(
			releasing,
		);
		assert.ok(documented, 'RELEASING.md must state which repository the updater endpoint names');
		assert.equal(
			repo,
			documented[1],
			`tauri.conf.json points the updater at ${repo} while RELEASING.md documents ${documented[1]}`,
		);
	});

	test('a package manager is not published from inside the platform matrix', () => {
		// `choco push` and `snapcraft push` used to run in the Windows and Linux
		// build jobs, which put an irreversible side effect before the thing that
		// decides whether a release happens at all. Chocolatey's markpad-app 2.7.2
		// was published by run 31192564528, which then failed on Linux and produced
		// no release; the release users got came out of a different run three hours
		// later. Nothing can un-push a Chocolatey version.
		//
		// Matched on the push commands rather than on step names, because the
		// property is "the build matrix has no irreversible external effect", and a
		// renamed step would still have one.
		//
		// `snapcraft upload` was `snapcraft push` here until snapcraft 8 removed
		// that name. Worth being honest about what this assertion is: it pins the
		// string the workflow uses, so it went on passing for the whole time the
		// command it named did not exist. Nothing runnable from `npm test` can
		// check the other half -- the tool is installed by the job, from the store,
		// at release time. See publish-packages.yml.
		assert.doesNotMatch(workflow, /snapcraft (pack|push|upload)/);
		assert.doesNotMatch(workflow, /choco push/);
		assert.match(publishWorkflow, /choco push/);
		assert.match(publishWorkflow, /snapcraft upload/);
		assert.doesNotMatch(publishWorkflow, /snapcraft push/);
	});

	test('package managers are published from a release a human published', () => {
		// `release: published` fires when a maintainer clicks Publish on the draft,
		// which RELEASING.md's per-release step 6 describes as the gate after
		// checking the assets.
		// Anything earlier — `created`, a tag push, the end of the build — publishes
		// on a release nobody has looked at.
		const on = sliceBetween(publishWorkflow, '\non:', '\npermissions:');
		assert.match(on, /release:\s*\n\s*types:\s*\[published\]/);
		assert.doesNotMatch(on, /\bpush:/);
	});

	test('a publishing step cannot report success while failing', () => {
		// The steps this workflow replaces both carried `continue-on-error: true`.
		// The snap build failed under it from v2.6.11 onward — `'rustup' not found`,
		// see snapcraft.yaml — for three months and six versions, while the job
		// reported success and every release still told people to
		// `sudo snap install markpad`. The Snap Store served 2.6.11 throughout.
		assert.doesNotMatch(publishWorkflow, /continue-on-error/);
		assert.doesNotMatch(workflow, /continue-on-error/);
	});

	test('the AppImage strip is a script, and its excludelist has one home', () => {
		// This step failed in two of the three v2.7.2 release attempts. As a heredoc
		// inside build.yml it could only be exercised by cutting a release; as a
		// script it can be run against any downloaded AppImage.
		assert.match(workflow, /bash scripts\/strip-appimage\.sh/);
		assert.match(stripAppImage, /libwayland-client\.so\.0/);
		// The libraries are named in the script or nowhere. A second copy in the
		// workflow is a second copy to keep current.
		assert.doesNotMatch(workflow, /libwayland/);
	});

	test('the excludelist is checked against what is actually bundled', () => {
		// The strip proving its six are gone says nothing about whether six is still
		// the right number, and what decides that is not in this repository:
		// `tauri build` fetches linuxdeploy-plugin-gtk from the tip of someone else's
		// branch on every run, so the libraries copied into the AppDir can change
		// with no commit here.
		//
		// On the pull request build, deliberately. That AppImage is the un-stripped
		// one, which for this question is the right artifact rather than a worse one
		// — and it only became comparable when this job moved to the release's
		// Ubuntu, since before that it bundled jammy's libraries.
		assert.match(testBuildWorkflow, /bash scripts\/check-appimage-libraries\.sh/);
		assert.doesNotMatch(workflow, /check-appimage-libraries\.sh/);
		// It reads the strip list rather than restating it, so the two cannot drift.
		// Comments are exempt, as in the Ubuntu assertion above: naming a library
		// while explaining what was measured is not a second copy of the list.
		assert.match(checkAppImageLibraries, /strip-appimage\.sh/);
		const restated = checkAppImageLibraries
			.split('\n')
			.filter((line) => !/^\s*#/.test(line))
			.filter((line) => /\blib[A-Za-z0-9_.+-]*\.so\.[0-9]/.test(line));
		assert.deepEqual(restated, [], 'the library list has a second copy in check-appimage-libraries.sh');
	});

	test('the AppImage is started before it can be downloaded', () => {
		// The only check that runs Markpad rather than reading it, and the only one
		// that could have caught #463 or #498 before a user did. It has to be on the
		// release build: the file it starts is the repacked, re-signed one, which is
		// the one latest.json points at and the one no pull request produces.
		//
		// Order is the whole safety argument. After the re-sign, so it starts the
		// bytes that ship; before the upload, so a failure leaves the draft without
		// a Linux artifact and generate-update-feed — which requires `build` to have
		// succeeded — never runs.
		const linuxSteps = sliceBetween(workflow, 'Re-sign the repacked AppImage', 'MacOS Build');
		const smoke = linuxSteps.indexOf('scripts/smoke-appimage.sh');
		const upload = linuxSteps.indexOf('Upload Linux Artifacts');
		assert.ok(smoke > 0, 'the release build never starts the AppImage it is about to publish');
		assert.ok(upload > 0, 'the Linux upload step moved; this assertion no longer means anything');
		assert.ok(smoke < upload, 'the AppImage is uploaded before anything checks that it starts');

		// Liveness alone would have passed both defects: #499 records that the GTK
		// shell survives while WebKit's WebProcess aborts behind a blank window. The
		// abort line is the actual signal.
		assert.match(smokeAppImage, /EGL_BAD_PARAMETER/);
		assert.match(smokeAppImage, /docker run/);

		// And it runs on pull requests too, after a strip, because otherwise both
		// scripts would reach the release path having never run anywhere: the strip
		// failed in two of the three v2.7.2 release attempts, and a smoke test that
		// only a release can exercise is the problem it exists to solve.
		const prLinux = sliceFrom(testBuildWorkflow, 'The AppImage bundles nothing');
		const prStrip = prLinux.indexOf('scripts/strip-appimage.sh');
		const prSmoke = prLinux.indexOf('scripts/smoke-appimage.sh');
		assert.ok(prStrip > 0 && prSmoke > 0, 'a pull request never runs the strip or the smoke test');
		assert.ok(
			prStrip < prSmoke,
			'the pull request smokes the AppImage before stripping it, which reproduces #498 rather than testing for it',
		);
	});

	test('the strip proves itself against the artifact that ships', () => {
		// A CI smoke test cannot catch this defect: the runner's Mesa is the one the
		// libraries were copied from, so nothing mismatches there and the AppImage
		// starts fine. #498 was found by a user on Arch. That leaves "these
		// libraries are absent" as the only property checkable before release, and
		// it has to be checked on the repacked file rather than on the AppDir —
		// appimagetool packing the wrong directory would pass the weaker check.
		const verification = sliceFrom(stripAppImage, '--runtime-file');
		assert.match(verification, /--appimage-extract/);
		assert.match(verification, /is still bundled after the strip/);
	});

	test('signing uses the environment variables the pinned CLI reads', () => {
		// `tauri signer sign` did not read the TAURI_SIGNING_* names until CLI
		// 2.10.0, so the strip step had to spell the same secret the deprecated way
		// (TAURI_PRIVATE_KEY) while `tauri build` used the current one. Those names
		// are documented as going away, and `signer sign` without a key does not
		// fail loudly — only the `.sig` existence check turns it into an error.
		// 2.11.4 also fixes the AppImage bundler writing absolute symlinks for
		// `.desktop` and `.DirIcon`, in the same artifact this workflow repacks.
		// See #497.
		const floor = packageJson.devDependencies['@tauri-apps/cli'];
		const [, major, minor, patch] = /^\^(\d+)\.(\d+)\.(\d+)$/.exec(floor) ?? [];
		assert.ok(major, `@tauri-apps/cli must floor at an exact version, found ${floor}`);
		assert.ok(
			Number(major) > 2 || (Number(major) === 2 && (Number(minor) > 11 || (Number(minor) === 11 && Number(patch) >= 4))),
			`@tauri-apps/cli must be floored at ^2.11.4 or later, found ${floor}`,
		);
		assert.doesNotMatch(workflow, /TAURI_PRIVATE_KEY/);
		assert.match(workflow, /TAURI_SIGNING_PRIVATE_KEY_PASSWORD/);
	});

	test('a macOS release without the signing secrets still builds', () => {
		// #294 was closed because a workflow that *requires* signing credentials
		// blocks every release until someone configures them. This identity is
		// optional by construction: the step exits before it touches a keychain when
		// MACOS_CERTIFICATE is empty, and `tauri build` signs only when
		// APPLE_SIGNING_IDENTITY is exported -- the name the pinned CLI reads, and
		// the reason this step has to run before the build rather than beside it.
		const step = sliceBetween(workflow, 'Import macOS signing certificate', 'Build MacOS (Universal)');
		assert.match(step, /if \[ -z "\$\{MACOS_CERTIFICATE:-\}" \]; then[\s\S]*?exit 0/);
		assert.match(step, /echo "APPLE_SIGNING_IDENTITY=[^"]*" >> "\$GITHUB_ENV"/);
	});

	test('a signing identity that is only half configured stops the release', () => {
		// The early exit above is for a repository that has never set up signing at
		// all. It reads one of the three secrets, so a set certificate and an empty
		// identity walks straight past it and exports an empty
		// APPLE_SIGNING_IDENTITY -- and a green build that shipped unsigned is the
		// exact outcome this step exists to prevent, since it reaches users as
		// folder access being asked for all over again.
		const step = sliceBetween(workflow, 'Import macOS signing certificate', 'Build MacOS (Universal)');
		assert.match(step, /if \[ -z "\$\{MACOS_SIGNING_IDENTITY:-\}" \]; then[\s\S]*?exit 1/);
	});

	test('RELEASING.md names the signing secrets the workflow reads', () => {
		// Whoever configures the secrets works from the runbook and never opens the
		// workflow, so a rename on either side sends them to create a secret nothing
		// reads. The failure is the quiet one this step is built to allow: the import
		// exits 0, the build stays green, and the bundle ships unsigned -- which
		// reaches users as folder access being asked for all over again.
		const step = sliceBetween(workflow, 'Import macOS signing certificate', 'Build MacOS (Universal)');
		const secrets = [...new Set(step.match(/secrets\.[A-Z_0-9]+/g) ?? [])];
		assert.ok(secrets.length > 0, 'the signing step reads no secrets at all');
		for (const secret of secrets) {
			const name = secret.slice('secrets.'.length);
			assert.ok(releasing.includes(`\`${name}\``), `RELEASING.md never tells anyone to create ${name}`);
		}
	});

	test('the package managers we recommend are the ones we publish to', () => {
		// Three places tell people a package manager can install Markpad: the README,
		// the download table written into every release body, and the workflow that
		// actually pushes. They drifted once already and nobody noticed for three
		// months — the snap build was dead from v2.6.11 while both documents went on
		// recommending `sudo snap install markpad` and the Snap Store served 2.6.11.
		//
		// That drift is about to be possible again in the other direction: #562 asks
		// whether to retire the snap, and retiring it means deleting the job below.
		// Doing that without touching the two documents leaves the same failure with
		// the arrow reversed — a recommendation for a channel that no longer gets
		// anything. This holds the three together so the deletion cannot be partial.
		const releaseBody = sliceBetween(workflow, "echo '## Download'", 'RELEASE_BODY');
		for (const [name, install, push] of [
			['Chocolatey', /choco install markpad-app/, /choco push/],
			['Snap', /snap install markpad/, /snapcraft upload/],
		] as const) {
			const publishes = push.test(publishWorkflow);
			assert.equal(
				install.test(readme),
				publishes,
				`README ${install.test(readme) ? 'recommends' : 'does not recommend'} ${name}, but the pipeline ` +
					`${publishes ? 'does' : 'does not'} publish to it`,
			);
			assert.equal(
				install.test(releaseBody),
				publishes,
				`the release body ${install.test(releaseBody) ? 'recommends' : 'does not recommend'} ${name}, but the ` +
					`pipeline ${publishes ? 'does' : 'does not'} publish to it`,
			);
		}
	});

	test('the Chocolatey job skips a version that is already on the feed', () => {
		// Chocolatey accepts a version once. On the `release: published` path a
		// duplicate is a real problem; on the `workflow_dispatch` path it is the
		// normal case, because the only possible use of that path is a tag that is
		// already published — recovering after the snap job failed, or exercising
		// this workflow without cutting a release. Without the skip, that escape
		// hatch always reports a Chocolatey failure that means nothing.
		//
		// The guard must gate the push, not merely exist.
		assert.match(publishWorkflow, /id: already/);
		const pack = sliceFrom(publishWorkflow, '- name: Pack and publish');
		assert.match(pack, /if: steps\.already\.outputs\.published != 'true'/);
	});

	test('one release build runs at a time, and none of its runners drift', () => {
		// Dispatching twice gave two runs writing to the same draft release.
		// publish-packages.yml records what that cost: markpad-app 2.7.2 reached
		// Chocolatey at 15:37 UTC on 2026-08-07 from a run that then failed on Linux
		// and produced no release, while the release users got came from a different
		// run three hours later. #561 took the package pushes out of the build
		// matrix, which fixed the irreversible half of that. This is the other half.
		//
		// `cancel-in-progress: false` is the part worth asserting rather than the
		// group: cancelling the first run mid-flight leaves a draft holding some
		// platforms' assets and not others, which is indistinguishable from a build
		// that has not finished.
		const concurrency = sliceBetween(workflow, '\nconcurrency:', '\njobs:');
		assert.match(concurrency, /group:/, 'the release build can be dispatched twice into the same draft');
		assert.match(concurrency, /cancel-in-progress:\s*false/);

		// And every runner it names is a version, not a moving label. `ubuntu-latest`
		// on generate-update-feed was the last one that could change without a commit.
		const drifting = workflow
			.split('\n')
			.filter((line) => !/^\s*#/.test(line))
			.filter((line) => /runs-on:\s*(ubuntu|macos|windows)-latest/.test(line))
			.filter((line) => !/matrix\./.test(line));
		assert.deepEqual(drifting, [], 'a release job runs on a moving runner label');
	});


	const posixOnly = process.platform === 'win32' ? 'spawns /bin/bash with a POSIX PATH' : false;

	test('official macOS signing refuses partial credentials before touching the keychain', { skip: posixOnly }, () => {
		const step = parse(workflow).jobs.build.steps.find((step: { name: string }) => step.name === 'Import macOS signing certificate');
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

	test('official macOS artifacts are verified before upload and Tauri receives notarization credentials', () => {
		const steps = parse(workflow).jobs.build.steps;
		const build = steps.find((step: { name: string }) => step.name === 'Build MacOS (Universal)');
		assert.match(build.env.APPLE_PASSWORD ?? '', /secrets.APPLE_APP_SPECIFIC_PASSWORD/);
		assert.match(build.run, /unset APPLE_ID APPLE_PASSWORD APPLE_TEAM_ID/);
		const verifyIndex = steps.findIndex((step: { name: string }) => step.name === 'Verify notarized macOS artifacts');
		const uploadIndex = steps.findIndex((step: { name: string }) => step.name === 'Upload MacOS Artifacts');
		assert.ok(verifyIndex >= 0 && verifyIndex < uploadIndex);
		const verify = steps[verifyIndex];
		assert.match(verify.if, /MACOS_DEVELOPER_ID/);
		assert.match(verify.run, /stapler validate/);
		assert.match(verify.run, /spctl.*-a/);
		assert.match(verify.run, /certificate leaf = H/);
		assert.match(verify.run, /tar -xzf/);
		assert.match(verify.run, /hdiutil attach.*-readonly/);
	});
});

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

describe('one version across the manifests', () => {
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

		// That it writes all three is run in release.test.ts.

		// And the runbook points at the command rather than at the two files.
		assert.match(readSource('RELEASING.md'), /npm run release X\.Y\.Z/);
		assert.match(readSource('AGENTS.md'), /npm run release X\.Y\.Z/);
	});
});

describe('pull-request audit', () => {
	const workflow = readSource('.github/workflows/test.yml');

	test('pull-request checks reject vulnerabilities anywhere in the resolved lockfile', () => {
		assert.match(workflow, /name: audit complete dependency lockfile[\s\S]*run: npm audit(?:\s|$)/);
		assert.doesNotMatch(workflow, /npm audit --omit=dev/);
	});
});

describe('the Actions cache budget', () => {
	const workflows = ['build.yml', 'test.yml', 'test_build.yml', 'publish-packages.yml'].map(
		(name) => ({ name, text: readSource(`.github/workflows/${name}`) }),
	);

	// GitHub gives a repository 10 GB of Actions cache and evicts
	// least-recently-used over it. Both assertions below exist because that budget
	// was measured being exceeded — 13.22 GB across 117 entries — and because the
	// entries that overflow it are evicted in the order that hurts most: the
	// largest first, which is exactly the cargo caches the budget is being spent
	// on. Neither of these is a law of nature; both are trades with numbers behind
	// them, recorded in the workflow comments. Change them by re-doing the
	// measurement, not by deleting the assertion.

	test('a cargo cache is written on master and nowhere else', () => {
		// Without `save-if` every pull request writes its own copy, and a copy is
		// 1.0-1.2 GB per platform: one run of #572 wrote 4.45 GB. Two pull requests
		// in flight overflow the budget on their own, and what gets evicted is the
		// cargo caches — so the cache becomes a slower way of not caching.
		//
		// This is also why test_build.yml runs on push to master. The two are one
		// decision: `save-if` makes master the only writer, so master has to run.
		for (const { name, text } of workflows) {
			const uses = [...text.matchAll(/uses: Swatinem\/rust-cache@v2\n([\s\S]{0,400}?)(?=\n\s*- name:|\n\n)/g)];
			for (const [, block] of uses) {
				assert.match(
					block,
					/save-if: \$\{\{ github\.ref == 'refs\/heads\/master' \}\}/,
					`${name} caches cargo output without restricting the save to master`,
				);
			}
		}
	});

	test('setup-node does not cache npm', () => {
		// It was the largest consumer of the same budget: 113 entries, 8.76 GB,
		// across 50 refs, most of them pull requests closed weeks earlier. Caches
		// are scoped by ref, so one is written per branch per platform and nothing
		// can bound it the way `save-if` bounds the cargo caches.
		//
		// What it bought, on runs that hit it: `npm ci` in 6s on Linux, 9s on
		// macOS, 15-17s on Windows. It caches `~/.npm`, not `node_modules`, so
		// `npm ci` still runs and still links every package — the saving is the
		// registry fetch alone.
		for (const { name, text } of workflows) {
			assert.doesNotMatch(
				text,
				/^\s*cache: '?npm'?\s*$/m,
				`${name} re-enables the npm cache; re-read the budget note in test.yml first`,
			);
		}
	});
});

describe('NSIS installer hooks', () => {
	// `bundle.windows.nsis.installerHooks` is a file the NSIS bundler `!include`s
	// into its own installer script, and the four call sites in that script are all
	// guarded by `!ifmacrodef`:
	//
	//   !ifmacrodef NSIS_HOOK_POSTINSTALL
	//     !insertmacro NSIS_HOOK_POSTINSTALL
	//   !endif
	//
	// `!ifmacrodef` is a compile-time conditional, so a hook whose macro name is
	// spelled any other way is skipped with no error and no warning. The installer
	// still builds, still installs, and simply never runs the hook — which is how
	// `hooks.nsi` sat inert from 2026-01-12 to 2026-08-05 defining
	// `NSIS_HOOK_POST_INSTALL` (an underscore the bundler does not use).
	//
	// Nothing else in the build can catch that: the bundler does not validate the
	// file, and NSIS itself is only reachable on a Windows runner. So the spelling
	// is pinned here.
	//
	// Source: crates/tauri-bundler/src/bundle/windows/nsis/installer.nsi in
	// tauri-apps/tauri, unchanged in this set since tauri-cli-v2.0.0. This repo
	// pins @tauri-apps/cli 2.9.6 in package-lock.json.
	const BUNDLER_HOOK_MACROS = [
		'NSIS_HOOK_PREINSTALL',
		'NSIS_HOOK_POSTINSTALL',
		'NSIS_HOOK_PREUNINSTALL',
		'NSIS_HOOK_POSTUNINSTALL'
	];

	const config = JSON.parse(readSource('src-tauri/tauri.conf.json')) as {
		bundle: { windows?: { nsis?: { installMode?: string; installerHooks?: string } } };
	};

	const installerHooks = config.bundle.windows?.nsis?.installerHooks;

	test('a configured installer hook file exists', () => {
		if (installerHooks === undefined) return;
		// The path is resolved relative to the config file, not to the repo root.
		assert.doesNotThrow(
			() => readSource(`src-tauri/${installerHooks}`),
			`bundle.windows.nsis.installerHooks points at src-tauri/${installerHooks}, which is not in the repo`
		);
	});

	test('installer hook macros are spelled the way the bundler checks for them', () => {
		if (installerHooks === undefined) return;
		const hooks = readSource(`src-tauri/${installerHooks}`);
		const defined = [...hooks.matchAll(/^[ \t]*!macro[ \t]+(\S+)/gm)].map((match) => match[1]);

		// Only the entry points are pinned; a hook file is free to define private
		// helper macros under any name it likes.
		const entryPoints = defined.filter((name) => /^NSIS_HOOK/i.test(name));

		for (const name of entryPoints) {
			assert.ok(
				BUNDLER_HOOK_MACROS.includes(name),
				`${installerHooks} defines !macro ${name}, which no !ifmacrodef in the bundler template matches, ` +
					`so it is never inserted. Expected one of: ${BUNDLER_HOOK_MACROS.join(', ')}`
			);
		}

		// A hook file that defines no entry point at all is the same dead weight by
		// a different route: the config names it, the bundler includes it, nothing
		// in it ever runs.
		assert.notEqual(
			entryPoints.length,
			0,
			`${installerHooks} defines no NSIS_HOOK_* macro, so including it has no effect. ` +
				'Drop bundle.windows.nsis.installerHooks instead.'
		);
	});

	test('installer hooks write through the install-mode hive, not a hardcoded one', () => {
		if (installerHooks === undefined) return;
		const hooks = readSource(`src-tauri/${installerHooks}`);
		const installMode = config.bundle.windows?.nsis?.installMode ?? 'currentUser';
		if (installMode === 'currentUser') return;

		// With installMode "both" the user picks per-user or all-users at install
		// time, and the bundler template writes every registry key through SHCTX so
		// it follows that choice. A hook that names a hive outright disagrees with
		// the rest of the installer: an all-users install would leave per-user keys
		// that the all-users uninstall cannot see.
		const hardcoded = [
			...hooks.matchAll(
				/^[ \t]*(?:Write|Delete|Read)Reg\w*[ \t]+(HKCU|HKLM|HKCR|HKEY_CURRENT_USER|HKEY_LOCAL_MACHINE|HKEY_CLASSES_ROOT)\b/gm
			)
		].map((match) => match[1]);

		assert.deepEqual(
			hardcoded,
			[],
			`installMode is ${JSON.stringify(installMode)}, so ${installerHooks} must address the registry ` +
				'through SHCTX (or SHELL_CONTEXT) like the bundler template does, not through ' +
				`${[...new Set(hardcoded)].join('/')}.`
		);
	});

	// `.md`'s default value is not what decides which app opens a Markdown file:
	// since Windows 8 an existing `.md\UserChoice` outranks it, and no installer is
	// allowed to write UserChoice. When that happens the user's only way back is
	// Explorer's Open With dialog, which reads `OpenWithProgids` on the extension
	// and `Software\Classes\Applications\<exe>\SupportedTypes` -- neither of which
	// APP_ASSOCIATE writes. #756 is what that looks like from the outside: Markpad
	// is not the default and cannot be picked as one either.
	//
	// The hook fills that gap, and it has to name both the ProgID and the
	// extensions as literals, because the bundler exports neither as a define. This
	// pins them to the config the template actually expands.
	test('the hook offers every associated extension to the Open With dialog', () => {
		if (installerHooks === undefined) return;
		// A `;` comment quoting a key would satisfy any of the assertions below.
		const hooks = readSource(`src-tauri/${installerHooks}`)
			.replace(/^[ \t]*[;#].*$/gm, '')
			.replace(/[ \t];.*$/gm, '');

		const associations = (
			config as unknown as { bundle: { fileAssociations?: Array<{ ext: string[]; name?: string }> } }
		).bundle.fileAssociations;
		if (associations === undefined) return;

		for (const association of associations) {
			// The template expands `{{or association.name ext}}` into the
			// APP_ASSOCIATE FILECLASS argument, so this is the ProgID it creates.
			const progId = association.name ?? association.ext[0];
			assert.match(
				hooks,
				new RegExp(`!define\\s+MARKPAD_PROGID\\s+"${progId}"`),
				`hooks.nsi must define MARKPAD_PROGID as ${JSON.stringify(progId)}, the ProgID the bundler ` +
					'template derives from bundle.fileAssociations[].name. A mismatch registers an Open With ' +
					'entry pointing at a ProgID that does not exist.'
			);

			for (const ext of association.ext) {
				assert.match(
					hooks,
					new RegExp(
						`WriteRegStr\\s+SHCTX\\s+"Software\\\\Classes\\\\\\.${ext}\\\\OpenWithProgids"\\s+"\\$\\{MARKPAD_PROGID\\}"`
					),
					`.${ext} is in bundle.fileAssociations but hooks.nsi never adds it to OpenWithProgids, ` +
						'so Markpad stays out of the Open With dialog for it.'
				);
				assert.match(
					hooks,
					new RegExp(`SupportedTypes"\\s+"\\.${ext}"`),
					`.${ext} is in bundle.fileAssociations but is missing from the Applications SupportedTypes ` +
						'entry, which is what filters Markpad into the dialog for a given extension.'
				);
				assert.match(
					hooks,
					new RegExp(
						`DeleteRegValue\\s+SHCTX\\s+"Software\\\\Classes\\\\\\.${ext}\\\\OpenWithProgids"\\s+"\\$\\{MARKPAD_PROGID\\}"`
					),
					`hooks.nsi adds .${ext} to OpenWithProgids on install but never removes it on uninstall.`
				);
			}
		}
	});

	// `File` fails the installer build when its source is missing, and NSIS only
	// runs on the Windows release runner. This catches a renamed icon before that.
	test('the Markdown file icon the hook installs is in the repo', () => {
		if (installerHooks === undefined) return;
		const hooks = readSource(`src-tauri/${installerHooks}`);
		for (const match of hooks.matchAll(/\$\{__FILEDIR__\}\\([^"]+)"/g)) {
			const path = match[1].replaceAll('\\', '/');
			assert.doesNotThrow(
				() => readSource(`src-tauri/${path}`),
				`hooks.nsi installs src-tauri/${path}, which is not in the repo`
			);
		}
	});
});

// A `.deb`, `.rpm` or snap install cannot replace its own binary, but it used
// to be offered an update anyway: the check succeeds, because latest.json
// publishes `linux-x86_64` and every Linux build asks for exactly that key, and
// the install then fails against `/usr/bin/Markpad` or a read-only squashfs.
// See #570. These assertions hold the shape of the fix, which is an ordering
// property more than a code property.

describe('a package-managed install is not offered an update', () => {
	const store = readSource('src/lib/stores/update.svelte.ts');
	const dialog = readSource('src/lib/components/UpdateDialog.svelte');
	const rust = readRustBackend();
	const i18n = readDictionarySource();

	test('the command exists on the Rust side and is reachable', () => {
		// A Tauri command is addressed by a string, so nothing in the type system
		// connects the two halves: an unregistered command fails at runtime, and
		// this flow's runtime is a Linux package nobody on this project runs daily.
		assert.match(rust, /fn self_update_supported\(app: AppHandle\) -> bool/);
		const handler = sliceBetween(rust, 'tauri::generate_handler![', '])');
		assert.match(handler, /self_update_supported/);
	});

	test('the AppImage is detected through tauri\'s Env, not a raw variable', () => {
		// Which platforms are gated is `only_linux_gates_self_update` in
		// commands.rs. What stays here is the convention that the AppImage is
		// read through tauri's Env, which also verifies the executable is under
		// $TMPDIR/.mount_. `std::env::var("APPIMAGE")` alone is settable by hand.
		const command = sliceBetween(rust, 'fn self_update_supported', '\npub fn get_os_type');
		assert.match(command, /appimage\.is_some\(\)/);
		assert.doesNotMatch(command, /env::var/);
	});

	test('the dialog can render the phase, and can be dismissed from it', () => {
		// A phase the store can enter but the dialog cannot draw is a blank modal
		// with no way out — the footer branch matters as much as the body one.
		assert.match(dialog, /packageManagedHeader/);
		assert.match(dialog, /packageManagedBody/);
		const footer = sliceBetween(dialog, '<div class="update-footer">', '</div>\n\t\t</div>');
		assert.match(footer, /phase === 'package-managed'/);
	});

	test('the new strings are translated wherever the rest of this dialog is', () => {
		// The update dialog is only translated into four of the app's 26 languages;
		// the other 22 fall back to English for all of it. Matching that set exactly
		// is the point: fewer would leave a hole, and more would put two localised
		// lines in a dialog that is otherwise English.
		const dialogKey = 'upToDateHeader';
		const languages = i18n.split('\n').filter((l) => l.includes(`${dialogKey}:`)).length;
		for (const key of ['packageManagedHeader', 'packageManagedBody']) {
			assert.equal(
				i18n.split('\n').filter((l) => l.includes(`${key}:`)).length,
				languages,
				`${key} must be defined in the same languages as ${dialogKey}`,
			);
		}
	});
});

describe('the update dialog', () => {
	const dialog = readSource('src/lib/components/UpdateDialog.svelte');
	const globalStyles = readSource('src/styles.css');

	test('release notes can be selected even though the app disables selection', () => {
		// The app root sets `user-select: none` on purpose. Anything that holds text
		// a user has to copy out has to say so for itself — nothing else in this
		// component does, so a rule that quietly went missing here would look like
		// no rule at all, which is what #532 reported.
		assert.match(globalStyles, /user-select: none/);

		const notesRule = /\.notes pre \{[^}]*\}/.exec(dialog)?.[0];
		assert.ok(notesRule, 'the release-notes block must still have its own style rule');
		assert.match(notesRule, /user-select: text/);
		assert.match(notesRule, /-webkit-user-select: text/);
	});

	test('the dialog promises reopened tabs only when restore is on', () => {
		// With "Restore windows on launch" off nothing writes the snapshot, so the
		// relaunched app opens empty and must not have been told otherwise.
		assert.match(dialog, /\{#if settings\.restoreStateOnReopen\}<p>\{tk\('reopensTabs'\)\}<\/p>\{\/if\}/);
	});
});

describe('the asset protocol scope', () => {
	// `![](.res/pic.jpg)` rendered blank on Linux and macOS (#981). Tauri's fs
	// scope defaults `requireLiteralLeadingDot` to true on Unix, so `**` does not
	// match a path segment that starts with a dot and the `asset:` handler answers
	// 403. Windows defaults to false, which is why it only showed up off Windows.
	test('asset scope lets `**` match dot-directories on every platform', () => {
		const conf = JSON.parse(readSource('src-tauri/tauri.conf.json'));
		assert.deepEqual(conf.app.security.assetProtocol.scope, {
			allow: ['**'],
			requireLiteralLeadingDot: false,
		});
	});
});

describe('Tauri command registration', () => {
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
		// renderer that `render_markdown` calls. The
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
});

// Tauri runs a sync `#[tauri::command]` on the main thread, so its work freezes
// every window until it returns. These do enough of it to be seen.
describe('heavy commands run off the main thread', () => {
	const rust = readRustBackend();

	for (const name of ['clipboard_read_image', 'save_window_state']) {
		test(`${name} runs off the main thread`, () => {
			assert.match(rust, new RegExp(`#\\[tauri::command\\]\\n(?:pub )?async fn ${name}\\(`));
		});
	}
});

// A fixed behavior must have exactly one implementation.
//
// The bug class this catches: a behavior gets fixed in file A while a stale
// pre-fix copy of the same logic survives in file B. Nothing type-checks the
// copy, nothing imports it, and it looks like a reusable shared helper — so the
// next person to "reuse" or "sync" it silently reverts a merged fix.
//
// The existing behavior tests cannot see this. preview.test.ts
// and export.test.ts read hard-coded files, so a second copy living anywhere else is
// invisible to them. Every rule below therefore scans the whole `src` tree and
// pins *which files* are allowed to contain the marker.
//
// A marker is only allowed to be something the compiler cannot see for itself:
// an exported symbol or type name, a magic string handed to another language or
// library (a Tauri command, a Monaco language id, a CSS custom property), or the
// literal shape of a defect that must never come back. A marker must never be a
// private identifier — a parameter name, a local variable, a helper that nothing
// outside its own file can reach. `every rule keeps at least one live
// implementation` below turns every marker into something a rename can break, so
// pinning a private name would promote it to a public contract and make ordinary
// local refactoring fail this suite for no behavioural reason.
//
// To add a behavior: append a row. `allowed` is the complete set of src-relative
// paths permitted to match `marker`; anything else is a duplicate implementation.

describe('single implementations', () => {
	type Rule = {
		name: string;
		// What breaks if a second copy of this appears.
		why: string;
		marker: RegExp;
		allowed: string[];
		// The tree to scan, repo-relative. `src` unless the rule is about the suite.
		dir?: string;
		// Optional: every allowed file that matches `marker` must also match this.
		requires?: { pattern: RegExp; message: string };
	};

	const RULES: Rule[] = [
		{
			name: 'mermaid rendering remembers the diagram source',
			why: 'PDF/HTML export re-renders Mermaid in the light theme from data-mermaid-source; a render path without rememberDiagramSource exports blank or dark-themed diagrams (#359).',
			marker: /mermaid\.render\(/g,
			allowed: ['src/lib/utils/mermaidPrint.ts', 'src/lib/utils/richContent.ts'],
			requires: {
				pattern: /rememberDiagramSource/,
				message: 'a Mermaid render site must record the source via rememberDiagramSource',
			},
		},
		{
			name: 'Mermaid theme resolution has one implementation',
			why: 'resolveMermaidTheme in mermaidPrint.ts is shared by the on-screen render and the print restore so the two cannot drift; a second site deciding the theme is that drift.',
			// Pins the exported helper, not the `'dark' : 'neutral'` ternary inside it:
			// the ternary is one of many spellings of the same decision (an if/else or
			// double quotes slipped straight past), while what actually has to stay
			// single is the function both paths call. What the function *returns* for
			// each appearance setting is checked for real — by calling it — in
			// export.test.ts.
			marker: /resolveMermaidTheme\s*\(/g,
			allowed: ['src/lib/MarkdownViewer.svelte', 'src/lib/utils/mermaidPrint.ts'],
		},
		{
			name: 'editor scroll-sync max is measured from content height',
			why: 'Split-view scroll sync must not count the editor bottom padding; the pre-fix form subtracted the viewport height from getScrollHeight() (#316).',
			marker: /getScrollHeight\(\)\s*-\s*[^;\n)]*height/gi,
			allowed: [],
		},
		{
			name: 'a fold height is measured from layout, not from the scrollable extent',
			why:
				'KaTeX stacks a display formula with negative margins and vertical-align, so its glyphs reach past the box that lays them out and `scrollHeight` reports several pixels more than `height: auto` resolves to. Writing that number into `--fold-content-height` made the wrapper taller than its content, and `{@html}` rebuilds the wrapper without the property on every keystroke — so the section paints at `auto` and then jumps. Measured on katex-stress.md at devicePixelRatio 2: prose -0.188px, a `\\mathrm` row -0.227px, grown delimiters +5.539px, nested fractions +7.133px. `getBoundingClientRect().height` takes every one of them to +0.000px.',
			marker: /\.scrollHeight/g,
			allowed: [],
			dir: 'src/lib/utils',
		},
		{
			name: 'the markdown extension list has one implementation in src',
			why:
				'There were five copies of `md | markdown | mdown | mkd | txt` in the frontend. #611 collapsed four of them into markdownLinks.ts; the fifth was an inline array in TitleBar.svelte deciding whether the outline and full-width buttons belong on the toolbar, which is exactly the kind of copy that goes stale when an extension is added. The Rust renderer keeps its own, pinned against this one by editing.test.ts, because no import crosses that boundary.',
			// `mdown` rather than `md`: it is distinctive enough that prose and other
			// identifiers cannot match it by accident.
			//
			// The editor's language table holds no copy: it derives its Markdown
			// entries from this list (utils/editorLanguage.ts).
			marker: /['"]mdown['"]/g,
			allowed: ['src/lib/utils/markdownLinks.ts'],
		},
		{
			name: 'the list-marker grammar has one implementation in src',
			why:
				"\"What a list item's marker looks like\" had three spellings: the Rust renderer's TASK_SOURCE_RE, the preview's checkbox rewrite in documentSession.svelte.ts, and the toolbar's line-marker toggles. The first two agreed; the toolbar's copy accepted neither an indented item nor the `1)` delimiter, so a click on a nested bullet answered `-     - sub` and a click on `1) item` answered `- 1) item` — issue #451 verbatim, one delimiter over. utils/listSyntax.ts holds the vocabulary now. What each site wraps around it — the anchors, the separator, and whether the leading indentation is consumed or preserved — stays at the call site on purpose: the renderer throws that prefix away, the toolbar has to put it back, and sharing *that* would flatten every nested list item on the first click. The Rust copy is pinned against this one by taskToggleLineEndings.test.ts, because no import crosses that boundary.",
			// The two fragments distinctive enough that prose cannot match them: the
			// task box's character class and the ordered delimiter pair.
			marker: /\[ xX\]|\\d\+\[\.\)\]/g,
			allowed: ['src/lib/utils/listSyntax.ts'],
		},
		{
			name: 'YouTube links never become embedded frames',
			why: 'The app dropped frame-src from its CSP and renders YouTube as a thumbnail anchor that opens the browser; an iframe path is the pre-fix version and cannot load.',
			marker: /createElement\((['"])iframe\1\)/g,
			// Allowed nowhere. The entry that used to sit here covered
			// `replaceWithYoutubeEmbed` in MarkdownViewer.svelte, an uncalled
			// pre-fix leftover, and said to delete the two together — #388 deleted
			// the copy, so the entry goes with it and the rule now guards the
			// whole tree.
			allowed: [],
		},
		{
			name: 'DOMPurify is configured in one place',
			why: 'The sanitize contract lives in utils/sanitize.ts; an inline DOMPurify config elsewhere is a second, unreviewed sanitizer.',
			// Import sites, so an aliased `import purify from "dompurify"` cannot slip
			// past the `DOMPurify.sanitize(` call-site scan in preview.checks.test.ts.
			// Both scans read the same allowlist so a new sanitizer is one decision.
			marker: /from\s+["']dompurify["']/g,
			allowed: SANITIZER_FILES,
		},
		{
			name: 'the raw render_markdown command has one set of call sites',
			why: 'Every preview render must go through renderMarkdownPreview, which strips YAML front matter before invoking the Rust renderer; a raw invoke elsewhere renders the front matter as body text. The command name is a string, so the compiler cannot see the call at all.',
			// The viewer half — that its one occurrence sits inside
			// renderMarkdownPreview rather than merely in the same file — is pinned by
			// preview.checks.test.ts.
			marker: /invoke\(\s*'render_markdown'/g,
			allowed: ['src/lib/MarkdownViewer.svelte', 'src/lib/utils/export.ts'],
		},
		{
			name: 'rich-content rendering has one implementation',
			why: 'utils/richContent.ts owns the render pipeline (highlight.js + KaTeX + Mermaid) for both the preview and the HTML export; a second renderRichContent is a fork that drifts from it — which is exactly how the export ended up shipping raw LaTeX and unhighlighted code.',
			// The viewer keeps a same-named wrapper that supplies the live element and
			// the copy-button behaviour, so the marker has to separate the two. It does
			// that on the exported options *type* — a real contract the export imports
			// — rather than on the parameter being spelled `options`, which is private
			// to the implementation and free to be renamed.
			marker: /function\s+renderRichContent\s*\([^)]*\bRenderRichContentOptions\b/g,
			allowed: ['src/lib/utils/richContent.ts'],
		},
		{
			name: 'editor language mapping has one implementation',
			why: 'A second extension-to-language table drifts from the one the editor actually uses, and the editor then opens a file under the wrong Monaco grammar.',
			// Pins the Monaco language id the table falls back to, not the
			// `editorLanguageFor` helper that happens to hold it today: 'plaintext' is a
			// magic string Monaco defines and TypeScript cannot check, and any second
			// extension table has to name it too.
			marker: /return '(?:plaintext)'/g,
			allowed: ['src/lib/utils/editorLanguage.ts'],
		},
		{
			name: 'the home tab sentinel is spelled in one place',
			why: "The home screen lives in a tab whose `path` is a sentinel rather than a file. Every reader of that field has to know the sentinel, and the one that did not — the render gate, which identified the home tab as `path === '' && title === 'Recents'` — went stale the day the sentinel was introduced and rendered the home tab as a blank page for six months (#392). A literal only some readers know about is a literal that can fall out of step in silence.",
			// The string itself, not the `isHomePath` helper: a second site would
			// spell the sentinel again rather than call the helper, so the helper's
			// name is exactly what such a site does NOT contain. Comments say
			// `HOME_TAB_PATH`, which is a symbol a rename can carry.
			marker: /(['"])HOME\1/g,
			allowed: ['src/lib/utils/homeTab.ts'],
		},
		{
			name: 'highlight color palette has one definition',
			why: 'A second palette drifts from the one bound to the --highlight-color custom property, so find highlights and the settings preview disagree.',
			// Pins the custom property the palette feeds — the actual contract with
			// styles.css and FindBar.svelte, and a string no type system reads —
			// instead of the private `highlightColorMap` binding that produces it.
			marker: /--highlight-color:/g,
			allowed: ['src/lib/MarkdownViewer.svelte'],
		},
		{
			name: 'the supported-language catalogue has one definition',
			why: 'settings.svelte.ts carried a second { code, name, nativeName } table beside getSupportedLanguages(). Only its `code` column was read — SUPPORTED_LANGUAGE_CODES mapped it and nothing else touched it — so the display columns were dead data that nothing compared against the live catalogue, and they drifted: `pt` was "Portuguese" in the table the language <select> renders and "Portuguese (European)" in the dead one. A drift no user can see is a drift no bug report can find.',
			// Pins `nativeName`, the column a catalogue exists to carry and the one
			// the <select> renders, rather than `getSupportedLanguages` — a second
			// table is by construction a site that does NOT call the accessor. The
			// property is public: Settings.svelte reads `lang.nativeName` off the
			// returned objects, so this is a cross-module field name, not a local.
			// The read site spells it `lang.nativeName`, which the `:` excludes.
			marker: /nativeName\s*:/g,
			allowed: ['src/lib/utils/i18n.ts'],
		},
		{
			name: 'the LanguageCode union has one definition',
			why: 'The union was declared identically in i18n.ts and settings.svelte.ts. Two unions over the same 26 codes type-check against each other only while they agree; adding a language to one leaves the other rejecting it, and the compiler reports that as an unrelated assignability error far from either declaration.',
			// The declaration, not a mention: `export type { LanguageCode }` (the
			// re-export settings.svelte.ts keeps so its importers are unaffected) has
			// a brace between the keyword and the name and is deliberately not matched.
			marker: /export type LanguageCode\s*=/g,
			allowed: ['src/lib/utils/i18n.ts'],
		},
		{
			name: 'the TOC width bounds have one definition',
			why: 'MarkdownViewer.svelte re-declared `const TOC_MIN_WIDTH = 180` / `TOC_MAX_WIDTH = 420` next to TOC_WIDTH_RANGE, the object NumericSettingRange documents as the single source of truth and the object settings.setTocWidth already clamps against. Bounds the drag handle enforces but persistence does not (or the reverse) are a width the user can set and not keep.',
			// The defect shape, spelled as it was spelled. Allowed nowhere: the drag
			// clamp, the Home/End jumps and the aria-valuemin/max on the separator all
			// read TOC_WIDTH_RANGE now, so any reappearance of a locally named TOC
			// bound is the second definition. `TOC_RESIZE_STEP` is *not* covered and
			// must not be: it is the 16px arrow-key increment, not TOC_WIDTH_RANGE.step.
			marker: /TOC_(?:MIN|MAX)_WIDTH/g,
			allowed: [],
		},
		{
			name: 'a resize separator advertises its settings range',
			why: 'aria-valuemin/max is the bound assistive tech reports; a literal there goes stale silently because no visual check can see it. This is the half of the TOC rule above that a differently-named copy would escape.',
			marker: /aria-valuemin=/g,
			// Sidebar.svelte's separators advertise TAB_COLUMN_WIDTH_RANGE and SIDEBAR_SPLIT_RANGE, their own settings' ranges (#884).
			allowed: ['src/lib/MarkdownViewer.svelte', 'src/lib/components/Sidebar.svelte'],
			requires: {
				pattern: /aria-valuemin=\{([A-Z_]+_RANGE)\.min\}\s*\n\s*aria-valuemax=\{\1\.max\}/,
				message: 'the resize separator must advertise its setting\'s *_RANGE.min/.max, not numbers of its own',
			},
		},
		{
			name: 'a fold is named in one place',
			why: "The expression that names a fold was written out three times — in the renderer, in the preview's click handler and in the outline — and two of them disagreed: the outline strips a trailing `^block-id` off the heading text before keying by it and the renderer does not, so for those headings the outline's fold button and the preview's chevron addressed different folds. Nothing type-checks a string built the same way in three files. `assignFoldKey` computes it once, while the markup is built, and leaves it on the element for `foldKeyOf` to read back.",
			// The shape of the defect, not the helper's name: a second site is by
			// construction one that does NOT call `assignFoldKey`, and what it would
			// contain instead is this — the id-then-text fallback, spelled out.
			marker: /id \|\| [A-Za-z.]*textContent/g,
			allowed: ['src/lib/utils/foldState.ts'],
		},
		{
			name: 'localStorage is written through one function',
			why: "Every window is a separate webview over one shared localStorage, so a persisted value needs compare-and-set on write and a `storage` listener to fold in what the other windows did — `writeStoredSetting` and `installPersistedSettings` in settings.svelte.ts are both. Three values were written with a bare `setItem` outside that: `theme` (changed in one window's settings panel, ignored by every other window until restart, while every switch beside it in the same panel synced live), `zoomLevel` (read back with a bare `parseInt`, so a corrupt key rendered `zoom: NaN` and `Math.min(NaN + 10, 500)` left the wheel and the chords unable to recover it), and `preview.fullWidth`. A bare `setItem` IS the defect: it is the write that no listener answers and no range validates.",
			// The call, so the `typeof localStorage.setItem === 'function'` guards do
			// not match. `utils/recentFiles.ts` is deliberately absent rather than
			// allowed: it keeps its own read-modify-write and its own `storage`
			// listener — correct, because the recent list is a collection every window
			// appends to rather than a scalar preference — but its write already goes
			// through `writeStoredSetting`, so it does not match this marker at all.
			marker: /localStorage\.setItem\s*\(/g,
			allowed: ['src/lib/stores/settings.svelte.ts'],
		},
		{
			name: 'the app writes an image embed in one place',
			why: "Pasting a screenshot and dropping a file are two commands (`save_image`, `copy_file_to_img`) returning the same kind of relative path, and Editor.svelte built the link for each with its own inline copy of the same four expressions, 300 lines apart. Both copies escaped the space and nothing else, so a file named `note#1.png` was written as `![alt](img/note#1.png)` and read back — by the preview and by the export resolver — as `img/note`. A third caller copying either one reintroduces it. `imageEmbed` in src/lib/utils/imageEmbed.ts is the single writer; scripts/editor.test.ts runs the round trip through the real readers.",
			// The emitted Markdown itself: a magic string handed to another parser,
			// which is what makes it a legal marker.
			marker: /!\[alt\]\(/g,
			allowed: ['src/lib/utils/imageEmbed.ts'],
		},
		{
			name: 'the frontend asks the browser what platform this is in one place',
			why: "The app had two independent answers to \"what platform is this?\". Everything read `settings.osType`, filled in by the Rust `get_os_type` command; TitleBar.svelte read `navigator.userAgent.includes('Macintosh')` and decided for itself. Two sources can disagree, and at startup they did — `settings.osType` is `'unknown'` until an `await invoke(…)` in the SettingsStore constructor returns, so on a Mac the title bar already drew Mac chrome while the tab tooltips beside it printed the Ctrl chords. `platformOf` in utils/platform.ts is the single answer: `settings.osType` when it is resolved, the synchronous browser hint only in the window before that, which is what keeps the title bar from flashing Windows chrome on a Mac.",
			// Both spellings, because they are interchangeable for this question and a
			// second source would reach for either. `navigator.language` (settings
			// store) and `navigator.clipboard` (Editor.svelte) are deliberately not
			// matched: neither is a platform test.
			marker: /navigator\.(?:userAgent|platform)\b/g,
			allowed: ['src/lib/utils/platform.ts'],
		},
		{
			name: 'the Cmd-or-Ctrl decision has one implementation',
			why: "`modifierFor()` was exported by #629 so that `settings.osType === 'macos' ? 'Cmd' : 'Ctrl'` would be written once, and four sites never joined it: two in MarkdownViewer.svelte (the document context menu's chords and the editor toolbar's `modifier` prop), one in TitleBar.svelte, and Settings.svelte's `? 'macos' : 'windows'` feeding the shortcut panel. A hand-written copy is not merely redundant — it is a site that cannot pick up what the helper learns. TitleBar's copy branched on the user agent rather than on the os type at all, and Settings' copy answered `'windows'` for a Mac whose os type had not resolved yet, so the shortcut panel opened on the Ctrl chords.",
			// The shape of the defect rather than the helpers' names: a site that
			// copies this decision is by construction one that calls neither
			// `modifierFor` nor `platformOf`, and what it contains instead is a
			// `=== 'macos'` test used as a ternary condition — which covers the
			// `'Cmd' : 'Ctrl'` spelling and the `'macos' : 'windows'` one together.
			// A bare `=== 'macos'` guarding an `{#if}` or an `&&` is NOT matched and
			// must not be: asking whether this is a Mac is fine, deciding again what
			// follows from it is the duplicate.
			//
			// The second alternative catches the same decision made off a local that
			// already holds the verdict — TitleBar's copy was `isMac ? 'Cmd' : 'Ctrl'`
			// and reaches the `=== 'macos'` test through no literal at all. The
			// declared union `'Ctrl' | 'Cmd'` in editorToolbar.ts is a type, has the
			// two words in the other order and separated by a pipe, and is not matched.
			marker: /===\s*(['"])macos\1\s*\?|(['"])Cmd\2\s*:\s*(['"])Ctrl\3/g,
			allowed: ['src/lib/utils/shortcuts.ts', 'src/lib/utils/platform.ts'],
		},
		{
			name: 'the translation dictionary is one literal',
			why:
				"`translations` was a 6,700-line literal *plus* a second table, `interactiveLabelTranslations`, that a module-level loop merged in with Object.assign — so the object the app read was never the object the source declares. That gap is not cosmetic. 259 keys existed only after the merge, and four were declared twice with different values, where whichever table happened to run last silently won: zh-TW `settings.toolbarOnBar` ('列' lost to '工具列'), and ko `settings.toolbarPlacement`, `settings.toolbarOnBar` and `settings.resetToolbar` (all three lost their original wording). Two rows of source claiming the same key, one of them dead, is invisible in review across 26 locales — and a reader who greps the literal for the losing value finds it, believes it, and is wrong. #196 appended the table rather than editing 26 places in the literal; folding it back made a duplicate key a *duplicate key*, which the reader and the compiler can both see. Add new keys to `translations` itself.",
			// `Object.assign(` unqualified rather than a pattern naming the
			// dictionary, because the merge reached it through a local alias —
			// `const currentSection = translations[language][section]` and then
			// `Object.assign(currentSection, values)`. A marker spelling
			// `translations` cannot see that, which is exactly how the mutation
			// would come back. `src` held no other Object.assign when this rule was
			// written, so the blanket ban costs nothing; a genuine unrelated use
			// joins `allowed` with its reason, like any other row here.
			//
			// The second alternative catches the direct `translations[l][s] = …`
			// spelling — the same loop's else-branch, which is how 20 locales got a
			// `toc` section they did not previously have.
			marker: /Object\.assign\(|\btranslations\b(?:\s*\[[^\]]*\])+\s*=(?!=)/g,
			allowed: [],
		},
		{
			name: 'this suite reads a file through one function',
			why: "A test that reads source with its own readFileSync gets the bytes Git checked out, and on Windows `core.autocrlf` makes those CRLF. Every `\\n` in a pattern then matches nothing and every anchor containing one is 'not found' — fifteen files were red on the maintainer's Windows checkout while cutting v2.7.0 and were hand-patched assertion by assertion (#452). `readSource` in sourceTree.ts decides the line ending once, on read, so the assertions stay written against `\\n` and a new test cannot re-open the hole by accident. Read the file with `readSource(path)` from './sourceTree.js' — it takes a cwd-relative string or a `new URL(…, import.meta.url)` — and write the assertion against `\\n`.",
			// The call, not the import: `import { readFileSync }` on its own reads
			// nothing, and a file may legitimately keep the import for another member.
			marker: /readFileSync\s*\(/g,
			allowed: ['scripts/sourceTree.ts'],
			dir: 'scripts',
		},
		{
			name: 'this suite walks a directory through one function',
			why: "The other half of the same story. A private directory walk misses the `\\\\`→`/` normalization `walkSourceFiles` does, so on Windows every path it reports is spelled with backslashes and every allowlist compared against it is a list of strings that cannot match. settings.checks.test.ts carried exactly that copy and needed the identical hand-patch in #452; editor.checks.test.ts carried a second one that happened to be spelled with a template literal and so escaped by luck rather than by design. Use `walkSourceFiles(dir)` for the paths or `readSourceFiles(dir)` for paths plus text, both from './sourceTree.js'.",
			marker: /readdirSync\s*\(/g,
			allowed: ['scripts/sourceTree.ts'],
			dir: 'scripts',
		},
	];

	// One walk per tree, shared by the rules that name it. `scripts` is a tree here
	// too: the last two rules are about the suite reading `src`, not about `src`.
	const TREES = new Map<string, SourceFile[]>();

	function sourcesIn(dir: string): SourceFile[] {
		const cached = TREES.get(dir);
		if (cached) return cached;
		const sources = readSourceFiles(dir);
		TREES.set(dir, sources);
		return sources;
	}

	for (const rule of RULES) {
		test(`single implementation: ${rule.name}`, () => {
			const sources = sourcesIn(rule.dir ?? 'src');
			const matched = filesMatching(sources, rule.marker);

			const unexpected = matched.filter((path) => !rule.allowed.includes(path));
			assert.deepEqual(
				unexpected,
				[],
				`second implementation found — ${rule.why}\nReuse the existing one instead of copying it. If this really is a new legitimate site, add it to \`allowed\` with a reason.`,
			);

			if (rule.requires) {
				for (const path of matched) {
					const text = sources.find((source) => source.path === path)!.text;
					assert.match(text, rule.requires.pattern, `${path}: ${rule.requires.message}`);
				}
			}
		});
	}

	test('every rule keeps at least one live implementation', () => {
		// Guards the rules themselves: a marker that matches nothing has gone stale
		// (renamed symbol, deleted feature) and is silently no longer guarding.
		for (const rule of RULES) {
			if (rule.allowed.length === 0) continue;
			assert.ok(
				filesMatching(sourcesIn(rule.dir ?? 'src'), rule.marker).length > 0,
				`rule "${rule.name}" matches nothing in ${rule.dir ?? 'src'} — update its marker or drop the rule`,
			);
		}
	});
});
