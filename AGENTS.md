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
- **Frontend**: `npm test` runs `scripts/*.test.ts` (`node --test --import tsx`). Two kinds
  live there: behavior tests, which import and run the real modules, and source-shape
  assertions, which match the source text for a contract the compiler cannot check — a Tauri
  command name, an i18n key, a second copy of a fixed behavior. A green run is not a claim
  that every behavior is covered; a source-shape assertion passes as long as the line it
  matches is still spelled that way.
- **CI**: Runs `npm audit`, `npm run check`, `npm test` and `cargo test` on PRs

## Notes

- No ESLint or Prettier configured - rely on TypeScript strict mode
- The app runs as SPA (ssr: false in +layout.ts)
- Uses Monaco Editor for text editing
- Supports Windows, macOS, and Linux

## Versioning

When bumping the app version, update both files in the same commit:

- `package.json` `version`
- `src-tauri/Cargo.toml` `version`

Tauri runtime reads `app.package_info().version` from `Cargo.toml`, while the
Tauri config and the frontend rely on `package.json`. Keeping them in sync is
mandatory for `tauri-plugin-updater` to compare versions correctly.

## Releasing

See [RELEASING.md](RELEASING.md) for the maintainer-facing release runbook
(keypair generation, GitHub Secrets setup, per-release workflow, troubleshooting).

For agents: never modify `plugins.updater.pubkey` in `src-tauri/tauri.conf.json`.
That value is set once by the maintainer and shipping a different one breaks
auto-update for all existing users — they have to manually re-install Markpad.
The placeholder string in PR-2 is replaced exactly once, by the maintainer,
right before the first auto-update-capable release.
