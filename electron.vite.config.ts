import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig, externalizeDepsPlugin } from "electron-vite";

// Dev runs the branded clone scripts/brand-dev-electron.mjs makes: macOS names the Dock after the bundle's file name.
if (process.platform === "darwin" && !process.env.ELECTRON_EXEC_PATH) {
  const clone = resolve("node_modules/electron/dist/CubiQ.app/Contents/MacOS/Electron");
  if (existsSync(clone)) process.env.ELECTRON_EXEC_PATH = clone;
}

/**
 * The git build stamp baked into the main bundle: the short commit, its date,
 * and the last 20 merged-away commits. Anything a git command can't answer
 * (no checkout, no git) comes back null/[], so the build never fails on it.
 */
function buildStamp(): {
  commit: string | null;
  date: string | null;
  changelog: { hash: string; date: string; subject: string }[];
} {
  const git = (args: string): string | null => {
    try {
      return execSync(`git ${args}`, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() || null;
    } catch {
      return null;
    }
  };
  const commit = git("rev-parse --short HEAD");
  const date = git("log -1 --format=%cs");
  const changelog: { hash: string; date: string; subject: string }[] = [];
  for (const line of git("log -20 --no-merges --format=%h%x09%cs%x09%s")?.split("\n") ?? []) {
    // hash <tab> date <tab> subject; a subject may itself contain tabs.
    const [hash, when, ...rest] = line.split("\t");
    if (hash && when) changelog.push({ hash, date: when, subject: rest.join("\t") });
  }
  return { commit, date, changelog };
}

export default defineConfig({
  main: {
    // Read in main/index.ts, never at import time: vitest doesn't run this define.
    define: { __CUBIQ_BUILD__: JSON.stringify(buildStamp()) },
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
