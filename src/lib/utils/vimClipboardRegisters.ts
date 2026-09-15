/**
 * `"+` and `"*`, Vim's names for the system clipboard. monaco-vim 0.4.4 defines
 * neither (brijeshb42/monaco-vim#125), so `"+yy` kept the text inside Vim (#775).
 *
 * Only a yank or delete named into them reaches the clipboard. Plain `y` stays
 * in the unnamed register, as in Vim without `clipboard=unnamedplus`: `x`, `dd`
 * and `c` write that register too, and mirroring it would replace whatever the
 * user copied elsewhere on every delete.
 *
 * `"+p` pastes the last `"+` yank, not the clipboard. `p` reads a register's
 * `toString()` synchronously, and the clipboard is only readable through an
 * async call into Rust.
 */

type Register = {
	setText: (this: Register, text: string, linewise?: boolean, blockwise?: boolean) => void;
	pushText: (this: Register, text: string, linewise?: boolean) => void;
	clear: () => void;
	toString: () => string;
};

/** The part of `VimMode.Vim` used here, written out for the reason given in vimScrollCommands.ts. */
type VimApi = {
	defineRegister?: (name: string, register: Register) => void;
	getRegisterController?: () =>
		| { registers: Record<string, Register | undefined>; unnamedRegister?: Register }
		| undefined;
};

/** `defineRegister` throws on a name it already has, so once per package instance. */
const installed = new WeakSet<object>();

/**
 * Define `"+` and `"*` so that writing either also calls `write`. Takes
 * monaco-vim's `VimMode` export; `false` means the API was not the expected
 * shape and nothing was changed.
 */
export function installVimClipboardRegisters(vimMode: unknown, write: (text: string) => void): boolean {
	const api: VimApi | undefined = (vimMode as { Vim?: VimApi } | null | undefined)?.Vim;
	if (!api || typeof api !== 'object') return false;
	if (installed.has(api)) return true;
	if (typeof api.defineRegister !== 'function' || typeof api.getRegisterController !== 'function') return false;
	const controller = api.getRegisterController();
	const unnamed = controller?.unnamedRegister;
	if (!controller || !unnamed) return false;

	for (const name of ['+', '*']) {
		if (controller.registers[name]) continue;
		// Built on upstream's own Register prototype: macro recording and search
		// history call methods this file does not list.
		const register: Register = Object.create(Object.getPrototypeOf(unnamed));
		register.clear();
		const { setText, pushText } = register;
		register.setText = function (text, linewise, blockwise) {
			setText.call(this, text, linewise, blockwise);
			write(this.toString());
		};
		register.pushText = function (text, linewise) {
			pushText.call(this, text, linewise);
			write(this.toString());
		};
		api.defineRegister(name, register);
	}

	installed.add(api);
	return true;
}
