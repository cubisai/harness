import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// The renderer alone, in a browser, against the fake backend in mock.ts.
export default defineConfig({
  root: "src/renderer",
  plugins: [react()],
  define: { "import.meta.env.VITE_MOCK": JSON.stringify("1") },
  server: { port: 5199, strictPort: true },
});
