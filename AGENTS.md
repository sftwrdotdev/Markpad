# AGENTS.md - Coding Guidelines for Markpad

This file contains guidelines for AI agents working on the Markpad codebase.

## Project Overview

Markpad is a Tauri v2 application with:
- **Frontend**: Svelte 5 + TypeScript + Vite
- **Backend**: Rust (Tauri commands)
- **Purpose**: Markdown viewer and text editor

## Build Commands

### Frontend (TypeScript/Svelte)
```bash
# Development
npm run dev              # Start Vite dev server
npm run dev:installer    # Run in installer mode

# Building
npm run build            # Build frontend for production
npm run preview          # Preview production build

# Type Checking
npm run check            # Run svelte-check (type checking)
npm run check:watch      # Watch mode type checking
```

### Backend (Rust)
```bash
cd src-tauri

cargo build              # Build Rust code
cargo build --release    # Release build

# Testing
cargo test               # Run all Rust tests
cargo test <test_name>   # Run specific test

# Linting/Formatting
cargo check              # Check for errors
cargo clippy             # Run clippy linter
cargo fmt                # Format code
```

### Tauri Commands
```bash
npm run tauri dev        # Run Tauri in dev mode
npm run tauri build      # Build Tauri application
```

## Code Style Guidelines

### TypeScript/Svelte

- **Indentation**: Use tabs (not spaces)
- **Quotes**: Single quotes for strings
- **Semicolons**: Optional but be consistent
- **Strict Mode**: Enabled - always define types explicitly

#### Imports
- Group imports: external libs first, then internal modules
- Use `.js` extension for relative imports (SvelteKit convention)
- Example:
```typescript
import { onMount } from 'svelte';
import { tabManager } from '../stores/tabs.svelte.js';
```

#### Svelte 5 Runes
Always use Svelte 5 runes for reactivity:
- `$state()` for reactive state
- `$derived()` for computed values
- `$effect()` for side effects
- `$props()` for component props with explicit types
- `$bindable()` for two-way binding

#### Naming Conventions
- Components: PascalCase (e.g., `Editor.svelte`)
- Stores: camelCase with `.svelte.ts` extension (e.g., `tabs.svelte.ts`)
- Functions/Variables: camelCase
- Types/Interfaces: PascalCase
- Event handlers: Prefix with `on` (e.g., `onsave`, `onnew`)

#### Props Pattern
Always type props explicitly using `$props()`:
```typescript
let {
    value = $bindable(),
    onsave,
    theme = 'system',
} = $props<{
    value: string;
    onsave?: () => void;
    theme?: 'system' | 'light' | 'dark';
}>();
```

### Rust

- **Indentation**: 4 spaces
- **Error Handling**: Use `Result<T, String>` for Tauri commands, propagate with `?`
- **Naming**: snake_case for functions/variables, PascalCase for types

#### Tauri Commands
Always mark with `#[tauri::command]` and return `Result<T, String>`:
```rust
#[tauri::command]
fn read_file_content(path: String) -> Result<String, String> {
    fs::read_to_string(path).map_err(|e| e.to_string())
}
```

#### Platform-Specific Code
Use conditional compilation for platform-specific features:
```rust
#[cfg(target_os = "windows")]
// Windows-specific code

#[cfg(not(target_os = "windows"))]
// Fallback for other platforms
```

## Project Structure

```
src/
  lib/
    components/          # Svelte components
    stores/              # Svelte 5 stores (.svelte.ts)
  routes/                # SvelteKit routes
src-tauri/
  src/
    main.rs             # Entry point
    lib.rs              # Main library with Tauri commands
    setup.rs            # Installation/setup logic
```

## Key Patterns

### State Management
- Use Svelte 5 runes-based stores in `src/lib/stores/`
- Export singleton instances (e.g., `export const tabManager = new TabManager()`)

### Tauri Invoke
Use `invoke()` from `@tauri-apps/api/core` for Rust commands:
```typescript
import { invoke } from '@tauri-apps/api/core';
const result = await invoke<string>('command_name', { arg: value });
```

### File Operations
All file operations go through Rust commands - never use Node.js fs APIs.

## Testing

- **Rust**: `cargo test` in `src-tauri/` directory
- **Frontend**: two runners, split by glob so a file belongs to exactly one.
  - `npm test` runs `scripts/*.test.ts` (`node --test --import tsx`).
  - `npm run test:vitest` runs `scripts/*.spec.ts` (vitest, jsdom, Svelte plugin).
- **CI**: Runs `npm audit`, `npm run check`, `npm test`, `npm run test:vitest` and
  `cargo test` on PRs

Tests run the real code and assert what it does. A test does not read source as text —
no regex over a file, no slicing a function body, no cutting code out of a component and
evaluating it: such a test guards a spelling, goes red on a rename and stays green on a
regression. When the logic sits in a component where a test cannot call it, move it into a
`.ts` or `.svelte.ts` module the component calls, and test the module.

The `*.checks.*` files are the one exception, and are meant to shrink: they hold contract
checks (a Tauri command or event name, a config key, an i18n key — the spelling that joins
Rust and TypeScript) and convention checks ("one implementation of this behavior"), until
those move to generated bindings and lint rules.

### Where a test goes

Tests are grouped by feature, not by the fix that added them:

- `scripts/<feature>.test.ts` and `scripts/<feature>.spec.ts` hold behavior tests (the
  runner rules below decide which of the two).
- `scripts/<feature>.checks.test.ts` / `.checks.spec.ts` hold the cases that read source as
  text, kept apart from the behavior tests.
- `scripts/<feature>.<area>.test.ts` / `.spec.ts` is for a part of a feature that must run
  in its own process (module mocks, a process-wide shim such as `installShimDom()`) or would
  make the main file unreadable.

A new case goes into the existing file for its feature, as a `test` inside the `describe`
it belongs to or a new `describe`. A new file is for a new feature or one of the reasons
above, not for a new fix. Name a test by the behavior it claims; put the issue number and
the bug history in a comment above it.

### Which runner a test belongs to

**Write it as `*.spec.ts` (vitest) when the subject is a `.svelte.ts` runes module, or when
it needs a real DOM.** `node --test` cannot load either. A runes module reached from
`node --test` only runs because the test installs `$state`/`$derived`/`$effect` onto
`globalThis` itself, and a hand-written rune is not the compiler's: it misses `$derived`'s
laziness, `$state`'s deep proxying, the private-field backing the compiler generates for
each `$state`, and — the expensive one — `$effect` never re-runs, so an assertion about
what an effect writes cannot fail. Under vitest the module is compiled for real and
`flushSync()` from `svelte` runs the pending effects.

**Leave it as `*.test.ts` (`node --test`) otherwise.** Plain TypeScript modules run fine
there, the runner is already configured, and moving a passing file buys nothing.

**Mount a component only for its markup wiring, and only one that does not need Monaco,
mermaid or KaTeX.** The suite mounts `Toc`, `HomePage`, `Settings`, `TitleBar`, `Tab`,
`UpdateDialog` and `ContextMenu` this way (vitest, jsdom; stub `Element.prototype.animate`
for transitions). `MarkdownViewer.svelte` and `Editor.svelte` are not mounted: their logic is
tested through the modules they call.

### Migrating a file

Rename `*.test.ts` to `*.spec.ts`, change `import test from 'node:test'` to
`import { test } from 'vitest'`, and delete the rune shim. `node:assert/strict` works
unchanged. Two things bite:

- `resolve.conditions: ['browser']` in `vitest.config.ts` is load-bearing. Without it Svelte
  resolves to its SSR build and `$effect` never flushes — the runes go quietly back to
  behaving like the shims.
- `readSource(new URL('…', import.meta.url))` throws under vitest, which serves test files
  over `http://`. Use the cwd-relative string form. (`sourceTree.ts`'s own helpers already
  do; `rustSourceFiles` had the same bug in `readdirSync` and was fixed the same way.)
- Stub `get_os_type`. Importing `tabs.svelte.ts` pulls in the `settings` singleton, which
  boots for real under the compiler; `initOSType` catches a rejection but not a `null`
  answer, so a bare `invoke: () => Promise.resolve(null)` leaves `osType` null and the
  font defaults it indexes undefined.

A test that shims runes is worth reading before it is worth moving: the split may be per
test rather than per file. A harness that calls `installShimDom()` assigns
`globalThis.document`, which under vitest replaces jsdom's; such a harness is rewritten onto
the real DOM rather than carried over.

### A real DOM is not a layout

jsdom implements the DOM, not CSS layout: `offsetTop`, `offsetHeight` and every
`getBoundingClientRect()` are 0. So migrating a file buys real answers about structure,
attributes, traversal and parsing, and buys nothing at all about geometry. A test whose
subject is a position on screen has to construct the boxes either way —
`layout.scrollSync.test.ts` lays a document out with collapsed folds in it, and
`navigation.spec.ts` builds elements whose rects carry a zoom factor while their
`offsetWidth` does not. Neither is worse for being under `node --test` or better for being
under vitest; the geometry is the fixture.

### Anything a test constructs inside an effect root must be torn down

A runes module that calls `$effect.root()` gets a disposer back, and a store that keeps
its effects for the life of the process is right in the app and wrong in the suite: every
spec file shares one jsdom, so a store nobody disposed answers a later `flushSync()` with
its own values and a later `storage` event by mutating fields that test still reads.
`SettingsStore.dispose()` exists for exactly this; construct through a helper that pairs
it with vitest's `onTestFinished` rather than remembering per test. Disposing the root
also runs the effects' teardowns, so listeners registered inside one (`window`'s
`storage` handler, say) come off with it — a listener added *outside* the root would not,
and would need its own seam.

## Notes

- No ESLint or Prettier configured - rely on TypeScript strict mode
- The app runs as SPA (ssr: false in +layout.ts)
- Uses Monaco Editor for text editing
- Supports Windows, macOS, and Linux

## Versioning

When bumping the app version, run `npm run release X.Y.Z` — it writes all
three and checks they agree. By hand, all three go in the same commit:

- `package.json` `version`
- `src-tauri/Cargo.toml` `version`
- `src-tauri/Cargo.lock` — not by hand: run `cargo update -p Markpad --precise
  <version>` in `src-tauri` (or any `cargo check` there, which rewrites it as a
  side effect) and commit the one-line diff.

Tauri runtime reads `app.package_info().version` from `Cargo.toml`, while the
Tauri config and the frontend rely on `package.json`. Keeping them in sync is
mandatory for `tauri-plugin-updater` to compare versions correctly.

The lock file is the one that gets forgotten, because nothing in the editing
loop reads it — a bump without it lands green and stays wrong until the next
person's `cargo build` rewrites the line and leaves them a dirty working tree.
`scripts/release.checks.test.ts` asserts the three agree.

## Releasing

See [RELEASING.md](RELEASING.md) for the maintainer-facing release runbook
(keypair generation, GitHub Secrets setup, per-release workflow, troubleshooting).

For agents: never modify `plugins.updater.pubkey` in `src-tauri/tauri.conf.json`.
That value is set once by the maintainer and shipping a different one breaks
auto-update for all existing users — they have to manually re-install Markpad.
The placeholder string in PR-2 is replaced exactly once, by the maintainer,
right before the first auto-update-capable release.
