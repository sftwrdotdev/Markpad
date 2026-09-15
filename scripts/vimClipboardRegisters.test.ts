import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import test from 'node:test';

/*
 * `"+` and `"*` against the real monaco-vim package (#775). Every yank, delete
 * and change ends in `registerController.pushText(registerName, operator, …)`,
 * so that call is driven directly and no editor is needed to reach it.
 *
 * monaco-editor is stubbed only so the package can be imported under Node; the
 * names are the ones monaco-vim imports, and none of them is used on this path.
 */

const MONACO_STUB = new URL('./monaco-editor.stub-for-vim-clipboard-tests.js', import.meta.url).href;

registerHooks({
	resolve(specifier, context, next) {
		if (specifier === 'monaco-editor' || specifier.startsWith('monaco-editor/')) {
			return { url: MONACO_STUB, shortCircuit: true };
		}
		return next(specifier, context);
	},
	load(url, context, next) {
		if (url === MONACO_STUB) {
			return {
				format: 'module',
				shortCircuit: true,
				source: `
					export const KeyCode = {};
					export const SelectionDirection = {};
					export const editor = {};
					export class Position {}
					export class Range {}
					export class Selection {}
					export class ShiftCommand {}
				`,
			};
		}
		return next(url, context);
	},
});

type Controller = {
	pushText: (name: string | null, operator: string, text: string, linewise?: boolean) => void;
	isValidRegister: (name: string) => boolean;
	unnamedRegister: { toString: () => string };
};

const MONACO_VIM = import.meta.resolve('monaco-vim');
let instances = 0;

/** A private copy of monaco-vim: `defineRegister` writes module-level tables. */
async function freshVim() {
	const { VimMode } = await import(`${MONACO_VIM}?instance=${(instances += 1)}`);
	const controller = VimMode.Vim.getRegisterController() as Controller;
	return { VimMode, controller };
}

/** A no-op when the module is gone, so a reverted fix fails on each claim rather than on the import. */
async function loadInstaller(): Promise<(vimMode: unknown, write: (text: string) => void) => boolean> {
	try {
		return (await import('../src/lib/utils/vimClipboardRegisters.js')).installVimClipboardRegisters;
	} catch {
		return () => false;
	}
}

test('unpatched monaco-vim has no clipboard register', async () => {
	// The drift guard: the day upstream defines them, this goes red and the shim can go.
	const { controller } = await freshVim();
	assert.equal(controller.isValidRegister('+'), false);
	assert.equal(controller.isValidRegister('*'), false);
});

test('a yank or delete named into + or * reaches the clipboard, and p still has it', async () => {
	for (const name of ['+', '*']) {
		const { VimMode, controller } = await freshVim();
		const written: string[] = [];
		assert.equal((await loadInstaller())(VimMode, (text) => written.push(text)), true);

		controller.pushText(name, 'yank', 'a line', true);
		controller.pushText(name, 'delete', 'word', false);

		assert.deepEqual(written, ['a line\n', 'word'], `"${name}`);
		// Vim also leaves a named yank in the unnamed register, so a plain `p` pastes it.
		assert.equal(controller.unnamedRegister.toString(), 'word', `"${name}`);
	}
});

test('a plain yank, delete or change leaves the clipboard alone', async () => {
	const { VimMode, controller } = await freshVim();
	const written: string[] = [];
	await (await loadInstaller())(VimMode, (text) => written.push(text));

	controller.pushText(null, 'yank', 'a line', true);
	controller.pushText(null, 'delete', 'x', false);
	controller.pushText(null, 'change', 'word', false);
	controller.pushText('a', 'yank', 'named', false);

	assert.deepEqual(written, []);
});

test('a second install defines nothing twice', async () => {
	const { VimMode } = await freshVim();
	const installVimClipboardRegisters = await loadInstaller();
	assert.equal(installVimClipboardRegisters(VimMode, () => {}), true);
	assert.equal(installVimClipboardRegisters(VimMode, () => {}), true);
});

test('an object that is not monaco-vim is left alone', async () => {
	const { installVimClipboardRegisters } = await import('../src/lib/utils/vimClipboardRegisters.js');
	// This runs while Vim mode is being switched on; a throw takes the editor with it.
	assert.equal(installVimClipboardRegisters(undefined, () => {}), false);
	assert.equal(installVimClipboardRegisters({}, () => {}), false);
	assert.equal(installVimClipboardRegisters({ Vim: {} }, () => {}), false);
	assert.equal(installVimClipboardRegisters({ Vim: { defineRegister() {}, getRegisterController: () => undefined } }, () => {}), false);
});
