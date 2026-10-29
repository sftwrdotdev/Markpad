import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { describe, test } from 'node:test';

import { parse } from 'yaml';

import { translations } from './allTranslations.js';
import { readSource } from './sourceTree.js';

// The release pipeline, its CI and its packaging config are data: YAML
// workflows, JSON config, a snapcraft.yaml. These tests parse them and assert
// fields. Shell inside a `run:` stays a string, so a claim about a command is
// matched inside the one step that runs it, never against the whole file.

type Step = {
	id?: string;
	name?: string;
	uses?: string;
	run?: string;
	if?: string;
	with?: Record<string, unknown>;
	env?: Record<string, string>;
	'continue-on-error'?: unknown;
};
type Job = {
	'runs-on': string;
	if?: string;
	steps: Step[];
	strategy?: { matrix?: { include?: Array<Record<string, string>> } };
	'continue-on-error'?: unknown;
};
type Workflow = {
	on: Record<string, unknown>;
	concurrency?: { group?: string; 'cancel-in-progress'?: unknown };
	jobs: Record<string, Job>;
};

const workflow = (name: string) => parse(readSource(`.github/workflows/${name}`)) as Workflow;
const build = workflow('build.yml');
const publish = workflow('publish-packages.yml');
const testWf = workflow('test.yml');
const testBuild = workflow('test_build.yml');
const ALL = { 'build.yml': build, 'publish-packages.yml': publish, 'test.yml': testWf, 'test_build.yml': testBuild };

const steps = (wf: Workflow) => Object.values(wf.jobs).flatMap((job) => job.steps);
const runs = (wf: Workflow) => steps(wf).map((step) => step.run ?? '');

function step(steps: Step[], name: string): Step {
	const found = steps.find((s) => s.name === name);
	assert.ok(found, `no step named "${name}"`);
	return found;
}
function stepIndex(steps: Step[], predicate: (s: Step) => boolean, what: string): number {
	const index = steps.findIndex(predicate);
	assert.ok(index >= 0, `no step ${what}`);
	return index;
}
const usesAction = (prefix: string) => (s: Step) => s.uses?.startsWith(prefix) ?? false;

const packageJson = JSON.parse(readSource('package.json')) as {
	version: string;
	scripts: Record<string, string>;
	devDependencies: Record<string, string>;
};
const tauriConf = JSON.parse(readSource('src-tauri/tauri.conf.json'));

describe('the release workflow', () => {
	test('release builds install the locked dependency graph', () => {
		assert.equal(step(build.jobs.build.steps, 'Install Frontend Dependencies').run?.trim(), 'npm ci');
		assert.ok(!runs(build).some((run) => /npm install/.test(run)), 'build.yml runs npm install');
	});

	test('the snap ships the binary the release shipped, not a second build of it', () => {
		// This used to assert `npm ci` in snapcraft.yaml, because the snap resolved
		// its own dependency graph and compiled its own binary. RELEASING.md promises
		// every channel resolves the committed lockfile, and two compilations of one
		// source satisfy that while still producing two different binaries: a snap
		// user and a .deb user of the same version did not have the same file.
		//
		// Packaging the release's .deb makes the promise structural instead.
		const snap = parse(readSource('snapcraft.yaml')) as { parts: Record<string, Record<string, unknown>> };
		const parts = Object.entries(snap.parts);
		assert.ok(parts.length > 0, 'snapcraft.yaml has no parts');
		for (const [name, part] of parts) {
			assert.equal(part['source-type'], 'deb', `snap part ${name} does not package a .deb`);
			assert.equal(part['build-packages'], undefined, `snap part ${name} installs build tools`);
			const scripts = ['override-pull', 'override-build', 'override-stage', 'override-prime']
				.map((key) => String(part[key] ?? ''))
				.join('\n');
			for (const builder of [/npm (ci|install)/, /tauri build/, /rustup/, /cargo/]) {
				assert.doesNotMatch(scripts, builder, `snap part ${name} is building, not packaging: ${builder}`);
			}
		}
	});

	test('the .deb the snap packages is the one from the release being published', () => {
		// The whole guarantee is that the Snap Store serves what the release page
		// serves. It rests on where this file comes from, so the download is pinned
		// to the tag and to the exact name build.yml uploads — not `latest`, and not
		// a pattern that could match a different architecture.
		const download = step(publish.jobs.snap.steps, 'Take the .deb from the release').run ?? '';
		assert.match(download, /gh release download "\$TAG"/);
		assert.match(download, /--pattern "Markpad_\$\{VERSION\}_amd64\.deb"/);
		assert.match(download, /--output markpad\.deb/);
	});

	test('portable executables are not mislabeled as installers', () => {
		assert.ok(!runs(build).some((run) => /MarkpadInstaller_/.test(run)));
		assert.match(step(build.jobs.build.steps, 'Upload Windows Artifacts').run ?? '', /bundle\/nsis\/\*-setup\.exe/);
	});

	test('the test bundle command uses an isolated builder', () => {
		assert.equal(packageJson.scripts['build:test-bundle'], 'node scripts/build-test-bundle.mjs');
	});

	/** The `node-version` of every setup-node step. */
	const nodeVersions = (wf: Workflow) =>
		steps(wf)
			.filter(usesAction('actions/setup-node@'))
			.map((s) => String(s.with?.['node-version']));

	test('the shipped app is built on the Node the tests ran on', () => {
		// build.yml pinned '20' in both of its jobs while test.yml and
		// test_build.yml used lts/*, so the binary users install was produced by a
		// runtime nothing had exercised. The three files are one fact, so they are
		// asserted against each other rather than against a literal.
		const expected = [...new Set([...nodeVersions(testWf), ...nodeVersions(testBuild)])];
		assert.equal(expected.length, 1, `the test workflows disagree on Node: ${expected.join(', ')}`);
		assert.deepEqual(
			[...new Set(nodeVersions(build))],
			expected,
			'build.yml must request the same Node as the workflows that test the code it ships',
		);
	});

	/** Every versioned Ubuntu a workflow runs on, from `runs-on` and matrix entries. */
	const ubuntus = (wf: Workflow) =>
		Object.values(wf.jobs)
			.flatMap((job) => [job['runs-on'], ...(job.strategy?.matrix?.include ?? []).map((entry) => entry.platform)])
			.filter((runner): runner is string => typeof runner === 'string' && /^ubuntu-\d+\.\d+$/.test(runner));

	test('every workflow that compiles compiles on the same Ubuntu', () => {
		// test.yml and test_build.yml ran on ubuntu-22.04 while build.yml moved to
		// 24.04. All three run `cargo` against the distribution's WebKitGTK headers,
		// so two Ubuntus meant "the pull request compiled" did not mean "the release
		// will" (#463, #498).
		const named = new Set([...ubuntus(testWf), ...ubuntus(testBuild), ...ubuntus(build)]);
		assert.ok(named.size > 0, 'no versioned Ubuntu runner found in any workflow');
		assert.equal(named.size, 1, `the workflows disagree on Ubuntu: ${[...named].sort().join(', ')}`);
	});

	test('a step asks which matrix entry it is, not which runner it landed on', () => {
		// `matrix.platform == 'ubuntu-22.04'` skipped the apt step in silence once the
		// matrix moved to 24.04 (run 31486273066). Conditions use the matrix entry's
		// stable name (`os`, `os-name`); the runner is named once, in the matrix.
		for (const [name, wf] of [
			['build.yml', build],
			['test_build.yml', testBuild],
		] as const) {
			const conditions = [...Object.values(wf.jobs).map((job) => job.if), ...steps(wf).map((s) => s.if)];
			const repeats = conditions.filter((condition) => /matrix\.platform\s*==/.test(condition ?? ''));
			assert.deepEqual(repeats, [], `${name} branches on the runner name; branch on the matrix entry instead`);
		}
	});

	/** The packages an `apt-get install -y` run asks for, sorted. */
	function aptPackages(run: string | undefined): string[] {
		const words = (run ?? '').split(/[\s\\]+/).filter(Boolean);
		const start = words.findIndex((word, i) => word === 'install' && words[i - 1] === 'apt-get');
		assert.ok(start >= 0, 'the step runs no apt-get install');
		return words
			.slice(start + 1)
			.filter((word) => !word.startsWith('-'))
			.sort();
	}

	test('a release installs the dependencies a pull request proved it can build with', () => {
		// build.yml only runs on workflow_dispatch, so its apt list is the one part
		// of the Linux build no pull request exercises. One list, so a release cannot
		// depend on something nothing tested.
		const pr = aptPackages(step(testBuild.jobs['build-test'].steps, 'install dependencies (ubuntu only)').run);
		assert.deepEqual(
			aptPackages(step(build.jobs.build.steps, 'Install Linux dependencies').run),
			pr,
			'the release build and the pull request build install different Linux packages',
		);
		// test.yml compiles but never bundles, so it needs everything except the
		// bundlers. Asserted as a subset so a new dependency cannot be left behind.
		const bundlers = new Set(['rpm']);
		assert.deepEqual(
			aptPackages(step(testWf.jobs.test.steps, 'install dependencies (ubuntu only)').run),
			pr.filter((p) => !bundlers.has(p)),
			'test.yml has drifted from the list the builds use',
		);
	});

	test('a cargo cache cannot outlive the runner image that filled it', () => {
		// rust-cache's key ends `-Linux-x64`: `runner.os`, not the image, so a
		// jammy-built target/ would restore into a noble build as a full match.
		// `$ImageOS` comes from the runner, so this also covers `*-latest` images
		// changing without a commit.
		for (const [name, wf] of [
			['test.yml', testWf],
			['test_build.yml', testBuild],
		] as const) {
			for (const job of Object.values(wf.jobs)) {
				const cache = job.steps.findIndex(usesAction('Swatinem/rust-cache@'));
				if (cache < 0) continue;
				assert.match(
					String(job.steps[cache].with?.key ?? ''),
					/env\.IMAGE_OS/,
					`${name}'s cache key does not change when the runner image does`,
				);
				const writer = job.steps.findIndex((s) => /IMAGE_OS=\$ImageOS/.test(s.run ?? ''));
				assert.ok(writer >= 0 && writer < cache, `${name} does not read $ImageOS into the environment before the cache`);
			}
		}
	});

	test('the updater feed publishes the keys an installed Markpad can ask for', () => {
		// tauri-plugin-updater tries `{os}-{arch}-{installer}` and then `{os}-{arch}`,
		// and only tries the first when the binary knows its own bundle type. Ours
		// does not on Windows or Linux, so those clients look up the plain key only.
		const feed = step(build.jobs['generate-update-feed'].steps, 'Generate latest.json').run ?? '';
		const platforms = /platforms: \(\{([\s\S]*?)\} \| with_entries/.exec(feed)?.[1] ?? '';
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
		// The endpoint is compiled into every installed copy. Config and runbook are
		// one fact. Matched against the one sentence that states it: "RELEASING.md
		// mentions this repo somewhere" passed with the endpoint reverted, because
		// the document necessarily names the old repository too.
		const endpoints: string[] = tauriConf.plugins.updater.endpoints;
		assert.equal(endpoints.length, 1, 'expected exactly one updater endpoint');
		const repo = /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/releases\//.exec(endpoints[0])?.[1];
		assert.ok(repo, `updater endpoint is not a GitHub releases URL: ${endpoints[0]}`);
		const documented = /The updater endpoint in `src-tauri\/tauri\.conf\.json` points at \*\*`([\w.-]+\/[\w.-]+)`\*\*/.exec(
			readSource('RELEASING.md'),
		);
		assert.ok(documented, 'RELEASING.md must state which repository the updater endpoint names');
		assert.equal(repo, documented[1], `tauri.conf.json points the updater at ${repo} while RELEASING.md documents ${documented[1]}`);
	});

	test('a package manager is not published from inside the platform matrix', () => {
		// `choco push` and `snapcraft push` used to run in the build jobs, which put
		// an irreversible side effect before the thing that decides whether a
		// release happens: markpad-app 2.7.2 reached Chocolatey from run
		// 31192564528, which then failed and produced no release.
		//
		// `snapcraft upload` was `snapcraft push` until snapcraft 8 removed that
		// name. This pins the string the workflow uses; nothing runnable from
		// `npm test` can check that the tool still has the command.
		const pushes = /snapcraft (pack|push|upload)|choco push/;
		assert.deepEqual(runs(build).filter((run) => pushes.test(run)), [], 'build.yml publishes to a package manager');
		assert.ok(publish.jobs.chocolatey.steps.some((s) => /choco push/.test(s.run ?? '')));
		assert.ok(publish.jobs.snap.steps.some((s) => /snapcraft upload/.test(s.run ?? '')));
		assert.ok(!runs(publish).some((run) => /snapcraft push/.test(run)));
	});

	test('package managers are published from a release a human published', () => {
		// `release: published` fires when a maintainer clicks Publish on the draft.
		// Anything earlier publishes on a release nobody has looked at.
		assert.deepEqual((publish.on.release as { types: string[] }).types, ['published']);
		assert.equal(publish.on.push, undefined);
	});

	test('a publishing step cannot report success while failing', () => {
		// The snap build failed under `continue-on-error: true` from v2.6.11 onward,
		// for three months and six versions, while the job reported success.
		for (const [name, wf] of [
			['publish-packages.yml', publish],
			['build.yml', build],
		] as const) {
			for (const [id, job] of Object.entries(wf.jobs)) {
				assert.equal(job['continue-on-error'], undefined, `${name} job ${id} swallows its failure`);
				for (const s of job.steps) {
					assert.equal(s['continue-on-error'], undefined, `${name} step "${s.name}" swallows its failure`);
				}
			}
		}
	});

	test('the AppImage strip is a script, and its excludelist has one home', () => {
		// As a heredoc inside build.yml the strip could only be exercised by cutting
		// a release; as a script it can be run against any downloaded AppImage.
		assert.match(
			step(build.jobs.build.steps, 'Strip host-coupled libraries from AppImage').run ?? '',
			/bash scripts\/strip-appimage\.sh/,
		);
		assert.match(readSource('scripts/strip-appimage.sh'), /libwayland-client\.so\.0/);
		// The libraries are named in the script or nowhere.
		assert.ok(!runs(build).some((run) => /libwayland/.test(run)), 'build.yml keeps a second copy of the excludelist');
	});

	test('the excludelist is checked against what is actually bundled', () => {
		// `tauri build` fetches linuxdeploy-plugin-gtk from the tip of someone
		// else's branch, so the bundled libraries can change with no commit here.
		// Checked on the pull request build, whose AppImage is the un-stripped one.
		assert.ok(runs(testBuild).some((run) => /bash scripts\/check-appimage-libraries\.sh/.test(run)));
		assert.ok(!runs(build).some((run) => /check-appimage-libraries\.sh/.test(run)));
		// It reads the strip list rather than restating it. Shell has no parser
		// here, so comment lines are filtered by hand.
		const check = readSource('scripts/check-appimage-libraries.sh');
		assert.match(check, /strip-appimage\.sh/);
		const restated = check
			.split('\n')
			.filter((line) => !/^\s*#/.test(line))
			.filter((line) => /\blib[A-Za-z0-9_.+-]*\.so\.[0-9]/.test(line));
		assert.deepEqual(restated, [], 'the library list has a second copy in check-appimage-libraries.sh');
	});

	test('the AppImage is started before it can be downloaded', () => {
		// After the re-sign, so it starts the bytes that ship. Before the upload, so
		// a failure leaves the draft without a Linux artifact and the update feed
		// never runs.
		const release = build.jobs.build.steps;
		const runsScript = (script: string) => (s: Step) => (s.run ?? '').includes(script);
		const resign = stepIndex(release, (s) => s.name === 'Re-sign the repacked AppImage', 'that re-signs the AppImage');
		const smoke = stepIndex(release, runsScript('scripts/smoke-appimage.sh'), 'that starts the AppImage');
		const upload = stepIndex(release, (s) => s.name === 'Upload Linux Artifacts', 'that uploads the Linux artifacts');
		assert.ok(resign < smoke, 'the AppImage is started before it is re-signed, so not the bytes that ship');
		assert.ok(smoke < upload, 'the AppImage is uploaded before anything checks that it starts');

		// Liveness alone would have passed both defects: the GTK shell survives
		// while WebKit's WebProcess aborts behind a blank window (#499).
		const smokeScript = readSource('scripts/smoke-appimage.sh');
		assert.match(smokeScript, /EGL_BAD_PARAMETER/);
		assert.match(smokeScript, /docker run/);

		// Pull requests strip, then smoke, so both scripts run before a release.
		const pr = testBuild.jobs['build-test'].steps;
		const prStrip = stepIndex(pr, runsScript('scripts/strip-appimage.sh'), 'that strips the AppImage');
		const prSmoke = stepIndex(pr, runsScript('scripts/smoke-appimage.sh'), 'that starts the AppImage');
		assert.ok(prStrip < prSmoke, 'the pull request smokes the AppImage before stripping it, which reproduces #498');
	});

	test('signing uses the environment variables the pinned CLI reads', () => {
		// `tauri signer sign` did not read the TAURI_SIGNING_* names until CLI
		// 2.10.0, and 2.11.4 fixes the AppImage bundler's absolute symlinks (#497).
		const floor = packageJson.devDependencies['@tauri-apps/cli'];
		const [, major, minor, patch] = /^\^(\d+)\.(\d+)\.(\d+)$/.exec(floor) ?? [];
		assert.ok(major, `@tauri-apps/cli must floor at an exact version, found ${floor}`);
		assert.ok(
			Number(major) > 2 || (Number(major) === 2 && (Number(minor) > 11 || (Number(minor) === 11 && Number(patch) >= 4))),
			`@tauri-apps/cli must be floored at ^2.11.4 or later, found ${floor}`,
		);
		const envNames = steps(build).flatMap((s) => Object.keys(s.env ?? {}));
		assert.ok(!envNames.includes('TAURI_PRIVATE_KEY'), 'a step still sets the deprecated TAURI_PRIVATE_KEY');
		assert.ok(!runs(build).some((run) => /TAURI_PRIVATE_KEY/.test(run)), 'a step still reads TAURI_PRIVATE_KEY');
		assert.ok(envNames.includes('TAURI_SIGNING_PRIVATE_KEY_PASSWORD'));
	});

	test('RELEASING.md names the signing secrets the workflow reads', () => {
		// Whoever configures the secrets works from the runbook. A rename on either
		// side sends them to create a secret nothing reads, and the bundle ships
		// unsigned with a green build.
		const env = step(build.jobs.build.steps, 'Import macOS signing certificate').env ?? {};
		const secrets = [...new Set(Object.values(env).flatMap((value) => [...value.matchAll(/secrets\.([A-Z_0-9]+)/g)].map((m) => m[1])))];
		assert.ok(secrets.length > 0, 'the signing step reads no secrets at all');
		const releasing = readSource('RELEASING.md');
		for (const name of secrets) {
			assert.ok(releasing.includes(`\`${name}\``), `RELEASING.md never tells anyone to create ${name}`);
		}
	});

	test('the package managers we recommend are the ones we publish to', () => {
		// README, the release body and the publishing workflow drifted once: the
		// snap build was dead from v2.6.11 while both documents recommended it.
		const readme = readSource('README.md');
		const releaseBody = step(build.jobs['create-release'].steps, 'Compose the download table').run ?? '';
		for (const [name, install, push] of [
			['Chocolatey', /choco install markpad-app/, /choco push/],
			['Snap', /snap install markpad/, /snapcraft upload/],
		] as const) {
			const publishes = runs(publish).some((run) => push.test(run));
			assert.equal(install.test(readme), publishes, `README and the pipeline disagree on ${name}`);
			assert.equal(install.test(releaseBody), publishes, `the release body and the pipeline disagree on ${name}`);
		}
	});

	test('the Chocolatey job skips a version that is already on the feed', () => {
		// Chocolatey accepts a version once, and on the workflow_dispatch path the
		// version is normally already there. The guard must gate the push.
		const choco = publish.jobs.chocolatey.steps;
		assert.ok(choco.some((s) => s.id === 'already'));
		assert.equal(step(choco, 'Pack and publish').if, "steps.already.outputs.published != 'true'");
	});

	test('one release build runs at a time, and none of its runners drift', () => {
		// Dispatching twice gave two runs writing to the same draft release.
		// `cancel-in-progress: false`, because cancelling mid-flight leaves a draft
		// that is indistinguishable from a build that has not finished.
		assert.ok(build.concurrency?.group, 'the release build can be dispatched twice into the same draft');
		assert.equal(build.concurrency?.['cancel-in-progress'], false);
		// Every runner a job names directly is a version, not a moving label.
		const drifting = Object.entries(build.jobs)
			.filter(([, job]) => /^(ubuntu|macos|windows)-latest$/.test(job['runs-on']))
			.map(([id]) => id);
		assert.deepEqual(drifting, [], 'a release job runs on a moving runner label');
	});

	test('official macOS artifacts are verified before upload and Tauri receives notarization credentials', () => {
		const release = build.jobs.build.steps;
		const buildStep = step(release, 'Build MacOS (Universal)');
		assert.match(buildStep.env?.APPLE_PASSWORD ?? '', /secrets.APPLE_APP_SPECIFIC_PASSWORD/);
		assert.match(buildStep.run ?? '', /unset APPLE_ID APPLE_PASSWORD APPLE_TEAM_ID/);
		const verifyIndex = release.findIndex((s) => s.name === 'Verify notarized macOS artifacts');
		const uploadIndex = release.findIndex((s) => s.name === 'Upload MacOS Artifacts');
		assert.ok(verifyIndex >= 0 && verifyIndex < uploadIndex);
		const verify = release[verifyIndex];
		assert.match(verify.if ?? '', /MACOS_DEVELOPER_ID/);
		assert.match(verify.run ?? '', /stapler validate/);
		assert.match(verify.run ?? '', /spctl.*-a/);
		assert.match(verify.run ?? '', /certificate leaf = H/);
		assert.match(verify.run ?? '', /tar -xzf/);
		assert.match(verify.run ?? '', /hdiutil attach.*-readonly/);
	});
});

describe('one version across the manifests', () => {
	// Cargo.lock is the third file, and the one that gets forgotten: a bump lands
	// green and stays wrong until someone runs `cargo build`. test.yml runs cargo
	// with `--locked`, so a lock that no longer matches Cargo.toml fails CI. The
	// fix is `cargo update -p Markpad --precise <version>` in src-tauri.
	test('package.json, Cargo.toml and Cargo.lock declare the same version', () => {
		const metadata = JSON.parse(
			execFileSync('cargo', ['metadata', '--format-version', '1', '--no-deps', '--manifest-path', 'src-tauri/Cargo.toml'], {
				encoding: 'utf8',
			}),
		) as { packages: Array<{ name: string; version: string }> };
		const markpad = metadata.packages.find((p) => p.name === 'Markpad');
		assert.ok(markpad, 'src-tauri/Cargo.toml does not define the Markpad package');
		assert.equal(markpad.version, packageJson.version, 'src-tauri/Cargo.toml is out of step with package.json');

		const cargoSteps = testWf.jobs.test.steps.filter((s) => /\bcargo (test|clippy)\b/.test(s.run ?? ''));
		assert.ok(cargoSteps.length >= 2, 'test.yml runs no cargo test and clippy');
		for (const s of cargoSteps) {
			assert.match(s.run ?? '', /--locked/, `"${s.name}" may rewrite a stale Cargo.lock instead of failing`);
		}
	});

	test('one command writes the version, and the runbook names it', () => {
		// RELEASING.md used to name two of the three files, so the third was skipped
		// by following the instructions correctly. That the command writes all
		// three is run in release.test.ts.
		assert.equal(packageJson.scripts.release, 'node scripts/release.mjs');
		assert.match(readSource('RELEASING.md'), /npm run release X\.Y\.Z/);
		assert.match(readSource('AGENTS.md'), /npm run release X\.Y\.Z/);
	});
});

describe('the Actions cache budget', () => {
	// GitHub gives a repository 10 GB of Actions cache and evicts
	// least-recently-used over it, largest first. Both claims below were measured
	// being exceeded (13.22 GB across 117 entries); the numbers are in the
	// workflow comments. Change them by redoing the measurement.

	test('a cargo cache is written on master and nowhere else', () => {
		// Without `save-if` every pull request writes its own 1.0-1.2 GB copy per
		// platform, and what gets evicted is the cargo caches.
		for (const [name, wf] of Object.entries(ALL)) {
			for (const s of steps(wf).filter(usesAction('Swatinem/rust-cache@'))) {
				assert.equal(
					s.with?.['save-if'],
					"${{ github.ref == 'refs/heads/master' }}",
					`${name} caches cargo output without restricting the save to master`,
				);
			}
		}
	});

	test('setup-node does not cache npm', () => {
		// 113 entries, 8.76 GB, for a saving of seconds per job: it caches `~/.npm`,
		// not `node_modules`, so `npm ci` still runs.
		for (const [name, wf] of Object.entries(ALL)) {
			for (const s of steps(wf).filter(usesAction('actions/setup-node@'))) {
				assert.equal(s.with?.cache, undefined, `${name} re-enables the npm cache; re-read the budget note in test.yml first`);
			}
		}
	});

	test('pull-request checks reject moderate-or-worse vulnerabilities anywhere in the resolved lockfile', () => {
		assert.equal(step(testWf.jobs.test.steps, 'audit complete dependency lockfile').run?.trim(), 'npm audit --audit-level=moderate');
	});
});

describe('the asset protocol scope', () => {
	// `![](.res/pic.jpg)` rendered blank on Linux and macOS (#981). Tauri's fs
	// scope defaults `requireLiteralLeadingDot` to true on Unix, so `**` does not
	// match a segment that starts with a dot and the `asset:` handler answers 403.
	test('asset scope lets `**` match dot-directories on every platform', () => {
		assert.deepEqual(tauriConf.app.security.assetProtocol.scope, {
			allow: ['**'],
			requireLiteralLeadingDot: false,
		});
	});
});

describe('a package-managed install is not offered an update', () => {
	test('the new strings are translated wherever the rest of this dialog is', () => {
		// The update dialog is translated into a few of the app's languages and the
		// rest fall back to English for all of it. The new strings match that set
		// exactly: fewer leaves a hole, more puts two localised lines in an
		// otherwise English dialog.
		const having = (key: string) =>
			Object.entries(translations)
				.filter(([, dictionary]) => typeof (dictionary as { update?: Record<string, unknown> }).update?.[key] === 'string')
				.map(([code]) => code)
				.sort();
		const dialog = having('upToDateHeader');
		assert.ok(dialog.length > 1, 'expected the update dialog in more than English');
		for (const key of ['packageManagedHeader', 'packageManagedBody']) {
			assert.deepEqual(having(key), dialog, `update.${key} must be defined in the same languages as update.upToDateHeader`);
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
