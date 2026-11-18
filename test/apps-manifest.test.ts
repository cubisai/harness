import { describe, expect, it } from "vitest";
import { APP_MAX_FILE_BYTES, granted, validateApp } from "../src/main/apps/manifest";

const manifest = (extra: Record<string, unknown> = {}) =>
  JSON.stringify({ name: "sales", title: "Sales", description: "Revenue by day.", entry: "index.html", grants: [{ server: "posara", tools: ["list_orders", "get_revenue"] }], ...extra });
const files = (m = manifest(), more: { path: string; content: string }[] = []) => [
  { path: "app.json", content: m },
  { path: "index.html", content: "<!doctype html><script src=app.js></script>" },
  { path: "app.js", content: "cubiq.call('posara','list_orders',{})" },
  ...more,
];

describe("validateApp", () => {
  it("accepts a plain app and normalizes grants and file order", () => {
    const r = validateApp("sales", files());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.manifest).toEqual({ name: "sales", title: "Sales", description: "Revenue by day.", entry: "index.html", grants: [{ server: "posara", tools: ["get_revenue", "list_orders"] }] });
    expect(r.files.map((f) => f.path)).toEqual(["app.js", "app.json", "index.html"]);
    expect(granted(r.manifest, "posara", "list_orders")).toBe(true);
    expect(granted(r.manifest, "posara", "delete_order")).toBe(false);
    expect(granted(r.manifest, "other", "list_orders")).toBe(false);
  });

  it("defaults entry to index.html and allows no grants", () => {
    const r = validateApp("sales", files(JSON.stringify({ name: "sales", title: "Sales", description: "x" })));
    expect(r.ok && r.manifest.entry).toBe("index.html");
    expect(r.ok && r.manifest.grants).toEqual([]);
  });

  it("refuses bad manifests with reasons the model can act on", () => {
    const errs = (m: Record<string, unknown>) => {
      const r = validateApp("sales", files(manifest(m)));
      return r.ok ? [] : r.errors.join("\n");
    };
    expect(errs({ name: "other" })).toContain('but the app is named "sales"');
    expect(errs({ entry: "missing.html" })).toContain('"entry"');
    expect(errs({ grants: [{ server: "posara", tools: ["*"] }] })).toContain("no wildcards");
    expect(errs({ grants: [{ server: "posara", tools: ["a"] }, { server: "posara", tools: ["b"] }] })).toContain("listed twice");
    expect(errs({ cacheSec: 99999 })).toContain("cacheSec");
    expect(errs({ script: "x" })).toContain('Unknown app.json field "script"');
    const bad = validateApp("sales", [{ path: "app.json", content: "{" }]);
    expect(!bad.ok && bad.errors[0]).toContain("not valid JSON");
  });

  it("refuses unsafe or oversized files", () => {
    for (const path of ["../x.js", "/abs.js", "a\\b.js", ".env.js", "lib/.hidden/x.js", "run.sh", "img.png"]) {
      const r = validateApp("sales", files(undefined, [{ path, content: "x" }]));
      expect(r.ok, path).toBe(false);
    }
    const big = validateApp("sales", files(undefined, [{ path: "big.js", content: "x".repeat(APP_MAX_FILE_BYTES + 1) }]));
    expect(!big.ok && big.errors.join()).toContain("big.js");
    expect(validateApp("sales", files().slice(1)).ok).toBe(false);
  });
});

describe("the dashboard template", () => {
  it("is a valid app as shipped", async () => {
    const { readdirSync, readFileSync } = await import("node:fs");
    const dir = "resources/creator/templates/dashboard";
    const tpl = readdirSync(dir).map((path) => ({ path, content: readFileSync(`${dir}/${path}`, "utf-8") }));
    const r = validateApp("sales-dashboard", tpl);
    expect(r.ok ? r.manifest.grants : r.errors).toEqual([{ server: "shop", tools: ["sales_summary"] }]);
  });
});
