import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  esbuild: { jsx: "automatic" },
  test: {
    include: ["test/**/*.test.{ts,tsx}"],
    // Specs that need a real third-party account (Antigravity) live in manual/
    // and never run in the default suite or CI.
    exclude: [...configDefaults.exclude, "manual/**"],
    environment: "node",
  },
});
