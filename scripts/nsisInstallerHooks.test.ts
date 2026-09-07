import assert from 'node:assert/strict';
import test from 'node:test';

import { readSource } from './sourceTree.js';

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
