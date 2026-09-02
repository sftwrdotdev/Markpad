import { defineConfig } from "vite";
import { sveltekit } from "@sveltejs/kit/vite";
import { monacoImePatch } from "./scripts/monacoImePatch.mjs";

const host = process.env.TAURI_DEV_HOST;

// https://vite.dev/config/
export default defineConfig(async () => ({
  // See scripts/monacoImePatch.mjs: a build-time patch to Monaco, to delete
  // once microsoft/vscode#333909 ships in a release.
  plugins: [monacoImePatch, sveltekit()],
  build: {
    chunkSizeWarningLimit: 6000,
  },

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
  },
}));
