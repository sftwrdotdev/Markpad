import { installVimClipboardRegisters } from './vimClipboardRegisters.js';
import { installVimScrollCommands } from './vimScrollCommands.js';
import { commands } from '../bindings.js';

/**
 * Attach Vim mode from the `monaco-vim` module just imported, or return null
 * when the effect that asked for it was `disposed()` meanwhile.
 *
 * The commands go on before the adapter is attached, and unconditionally: they
 * patch monaco-vim's own module-level command tables, which outlive this
 * effect, and they are idempotent. See vimScrollCommands.ts for what 0.4.4
 * does to `zz`, `zt`, `zb`, `z.`, `z-` and `z<CR>` (#104), and
 * vimClipboardRegisters.ts for `"+` and `"*` (#775).
 */
export function attachVimMode<Editor, Node, Adapter>(
	{ initVimMode, VimMode }: { initVimMode: (editor: Editor, statusNode: Node) => Adapter; VimMode: unknown },
	editor: Editor,
	statusNode: Node,
	disposed: () => boolean,
): Adapter | null {
	installVimScrollCommands(VimMode);
	installVimClipboardRegisters(VimMode, (text) => {
		commands.clipboardWriteText(text).catch(console.error);
	});
	if (disposed()) return null;
	return initVimMode(editor, statusNode);
}
