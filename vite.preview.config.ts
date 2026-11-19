import { readFileSync } from "node:fs";
import { join, normalize } from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";
import { appBridgeScript } from "./src/shared/apps";

/**
 * Demo Creator apps for the fake backend: /__app/<name>/<file> serves resources/creator/templates/<name> with the
 * bridge injected, as cubiq-app:// does in the app (a data: frame would inherit this page's CSP and run no scripts).
 */
function previewApps(): Plugin {
  const root = join(__dirname, "resources/creator/templates");
  return {
    name: "preview-apps",
    transformIndexHtml: (html) => html.replace("frame-src ", "frame-src 'self' "),
    configureServer(server) {
      server.middlewares.use("/__app/", (req, res, next) => {
        const rel = normalize(decodeURIComponent((req.url ?? "").split("?")[0]!)).replace(/^[/\\]+/, "");
        if (rel.startsWith("..")) return next();
        try {
          const body = readFileSync(join(root, rel));
          const html = rel.endsWith(".html");
          res.setHeader("Content-Type", html ? "text/html; charset=utf-8" : rel.endsWith(".js") ? "text/javascript" : "application/octet-stream");
          res.end(html ? body.toString("utf-8").replace("<head>", () => `<head><script>${appBridgeScript()}</script>`) : body);
        } catch {
          next();
        }
      });
    },
  };
}

// The renderer alone, in a browser, against the fake backend in mock.ts.
export default defineConfig({
  root: "src/renderer",
  plugins: [react(), previewApps()],
  define: { "import.meta.env.VITE_MOCK": JSON.stringify("1") },
  server: { port: 5199, strictPort: true },
});
