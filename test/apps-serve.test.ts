import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { appBridgeScript } from "../src/main/apps/bridge";
import { appCsp, appUrl, parseAppUrl, serveApp } from "../src/main/apps/serve";

function app() {
  const root = mkdtempSync(join(tmpdir(), "app-"));
  const dir = join(root, "sales");
  mkdirSync(join(dir, "lib"), { recursive: true });
  writeFileSync(join(dir, "index.html"), "<!doctype html><html><head><title>S</title></head><body>hi</body></html>");
  writeFileSync(join(dir, "lib", "chart.js"), "export const x = 1;");
  writeFileSync(join(root, "secret.txt"), "nope");
  return { root, dir };
}

describe("cubiq-app:// server", () => {
  it("round-trips URLs and refuses escapes, dotfiles and bad keys", () => {
    expect(parseAppUrl(appUrl("g~sales", "lib/chart.js"))).toEqual({ key: "g~sales", rel: "lib/chart.js" });
    expect(parseAppUrl(appUrl("p~proj_1~sales"))).toEqual({ key: "p~proj_1~sales", rel: "index.html" });
    for (const bad of ["cubiq-app://a/g~sales/../x", "cubiq-app://a/g~sales/%2e%2e/x", "cubiq-app://a/g~sales/.env", "cubiq-app://b/g~sales/index.html", "cubiq-app://a/G~Sales/index.html", "cubiq-app://a/g~sales/", "cubiq-design://a/g~sales/index.html", "cubiq-app://a/g~sales/a%5Cb"]) {
      expect(parseAppUrl(bad), bad).toBeNull();
    }
  });

  it("serves pages with the bridge and a CSP scoped to this app, assets as-is, nothing outside", async () => {
    const { dir } = app();
    const deps = { appRoot: (k: string) => (k === "g~sales" ? dir : null), bridge: appBridgeScript() };
    const page = serveApp(appUrl("g~sales"), deps);
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html.indexOf("window.cubiq")).toBeGreaterThan(html.indexOf("<head>"));
    expect(html.indexOf("window.cubiq")).toBeLessThan(html.indexOf("<title>"));
    const csp = page.headers.get("Content-Security-Policy")!;
    expect(csp).toBe(appCsp("g~sales"));
    expect(csp).toContain("connect-src 'none'");
    expect(csp).toContain("script-src cubiq-app://a/g~sales/ ");
    expect(page.headers.get("Access-Control-Allow-Origin")).toBeNull();
    const js = serveApp(appUrl("g~sales", "lib/chart.js"), deps);
    expect(js.headers.get("Content-Type")).toContain("javascript");
    expect(await js.text()).toBe("export const x = 1;");
    expect(serveApp(appUrl("g~other"), deps).status).toBe(404);
    expect(serveApp(appUrl("g~sales", "missing.js"), deps).status).toBe(404);
    expect(serveApp("cubiq-app://a/g~sales/../secret.txt", deps).status).toBe(404);
  });

  it("does not follow a symlink out of the app folder", () => {
    const { root, dir } = app();
    try {
      symlinkSync(join(root, "secret.txt"), join(dir, "leak.txt"));
    } catch {
      return; // Windows without symlink rights.
    }
    expect(serveApp(appUrl("g~sales", "leak.txt"), { appRoot: () => dir, bridge: "" }).status).toBe(404);
  });

  it("the bridge script parses", () => {
    expect(() => new Function(appBridgeScript())).not.toThrow();
  });
});
