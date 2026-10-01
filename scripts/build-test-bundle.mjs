import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';

const root = process.cwd();
const identifier = process.env.MARKPAD_TEST_BUNDLE_ID;

if (!identifier || !identifier.startsWith('dev.') || identifier === 'com.alecdotdev.markpad') {
	throw new Error('Set MARKPAD_TEST_BUNDLE_ID to a non-production identifier beginning with dev.');
}

// Read the version instead of hardcoding it: a stale literal here is a third
// place the app version lives, and it silently disagreed with package.json.
const { version } = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));

const config = JSON.stringify({
	identifier,
	productName: `Markpad ${version} Test`,
	bundle: { targets: ['app'], createUpdaterArtifacts: false },
});
execFileSync('npm', ['run', 'tauri', '--', 'build', '--bundles', 'app', '--config', config], {
	cwd: root,
	stdio: 'inherit',
});

const macosDir = resolve(root, 'src-tauri/target/release/bundle/macos');
const appName = readdirSync(macosDir).find((entry) => entry.endsWith('.app'));
if (!appName) throw new Error('Tauri did not produce a macOS .app bundle.');

const outputDir = resolve(root, 'dist/test-bundle');
const output = resolve(outputDir, appName);
mkdirSync(outputDir, { recursive: true });
rmSync(output, { recursive: true, force: true });
cpSync(resolve(macosDir, appName), output, { recursive: true });
if (!existsSync(output)) throw new Error(`Failed to copy test bundle to ${output}`);
console.log(`Test bundle: ${output}`);
