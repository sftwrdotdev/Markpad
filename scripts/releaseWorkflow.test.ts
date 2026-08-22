import assert from 'node:assert/strict';
import test from 'node:test';

import { readSource, sliceBetween, sliceFrom } from './sourceTree.js';

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
	assert.doesNotMatch(workflow, /choco push/);
	assert.doesNotMatch(workflow, /snapcraft (pack|push)/);
	assert.match(publishWorkflow, /choco push/);
	assert.match(publishWorkflow, /snapcraft push/);
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
		['Snap', /snap install markpad/, /snapcraft push/],
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
