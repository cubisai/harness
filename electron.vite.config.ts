import { resolve } from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig, externalizeDepsPlugin } from "electron-vite";

export default defineConfig({
  main: {
    // The Agent SDK spawns its bundled Claude Code binary from node_modules,
    // so every dependency stays external rather than bundled.
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: { output: { format: "es" } },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      // Sandboxed preload scripts must be CommonJS.
      rollupOptions: { output: { format: "cjs", entryFileNames: "[name].cjs" } },
    },
  },
  renderer: {
    root: resolve("src/renderer"),
    plugins: [react()],
  },
});
