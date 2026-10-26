import type { TestContext } from 'node:test';

/**
 * Answers the generated `commands.*` (src/lib/bindings.ts) for one `node --test`
 * test: puts `invoke` where `@tauri-apps/api/core` looks for Tauri's runtime,
 * and takes it away when the test ends. `invoke` sees the wire-level command
 * name and argument object, exactly what Rust receives.
 */
export function stubTauriInvoke(
	t: TestContext,
	invoke: (command: string, args: Record<string, unknown>) => Promise<unknown>,
) {
	const scope = globalThis as { window?: unknown };
	const previous = Object.getOwnPropertyDescriptor(scope, 'window');
	scope.window = { ...(scope.window as object | undefined), __TAURI_INTERNALS__: { invoke } };
	t.after(() => {
		if (previous) Object.defineProperty(scope, 'window', previous);
		else delete scope.window;
	});
}
