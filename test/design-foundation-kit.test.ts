import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseKitManifest, validateKitDir } from "../src/main/design/kit-schema";
import { listKitSystems } from "../src/main/design/systems";

const ROOT = process.cwd();
const FOUNDATION = join(ROOT, "resources", "design-kits", "foundation");
const read = (name: string) => readFileSync(join(FOUNDATION, name), "utf8");

describe("the bundled Foundation kit", () => {
  it("passes the kit validator", () => {
    const result = validateKitDir(FOUNDATION, "foundation");
    expect(result.ok ? [] : result.errors).toEqual([]);
  });

  it("uses only tokens its own tokens.css defines, the names a design reference is adapted into", () => {
    const own = new Set([...read("tokens.css").matchAll(/(--[a-z0-9-]+)\s*:/g)].map((m) => m[1] ?? ""));
    const used = [...read("ui.css").matchAll(/var\(\s*(--[a-z0-9-]+)/g)].map((m) => m[1] ?? "");
    expect(used.length).toBeGreaterThan(50);
    expect([...new Set(used)].filter((name) => !own.has(name))).toEqual([]);
  });

  it("hard-codes no colour, font or size in its parts", () => {
    const lines = read("ui.css")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .split("\n");
    const literal = /#[0-9a-f]{3,8}\b|\brgba?\(|\bhsla?\(|font-family:(?!\s*var\()/i;
    expect(lines.filter((line) => literal.test(line))).toEqual([]);
  });

  it("has real stack and grid parts with the layout props the panel needs", () => {
    const parsed = parseKitManifest(read("components.json"));
    if (!parsed.ok) throw new Error(parsed.errors.join("\n"));
    const props = (ui: string) => parsed.manifest.components.find((c) => c.ui === ui)?.props.map((p) => p.name) ?? [];
    expect(props("stack")).toEqual(expect.arrayContaining(["direction", "gap", "align"]));
    expect(props("grid")).toEqual(expect.arrayContaining(["columns", "gap", "align"]));
    const css = read("ui.css");
    expect(css).toMatch(/\[data-ui="stack"\][^{]*\{[^}]*display:\s*flex/);
    expect(css).toMatch(/\[data-ui="grid"\][^{]*\{[^}]*display:\s*grid/);
  });

  it("offers only itself as a system: design references are adapted onto it, not listed as themes", () => {
    expect(listKitSystems(FOUNDATION).map((s) => s.id)).toEqual(["kit:foundation"]);
  });

  it("composes its blocks only from parts it declares", () => {
    const parsed = parseKitManifest(read("components.json"));
    if (!parsed.ok) throw new Error(parsed.errors.join("\n"));
    const known = new Set(parsed.manifest.components.map((c) => c.ui));
    for (const block of readdirSync(join(FOUNDATION, "blocks"))) {
      const html = read(join("blocks", block));
      const used = [...html.matchAll(/data-ui="([^"]+)"/g)].map((m) => m[1] ?? "");
      expect(used.filter((ui) => !known.has(ui)), block).toEqual([]);
      expect(html, block).not.toMatch(/\sstyle=|\sclass=/);
    }
  });

  it("keeps ui.js small and self-contained", () => {
    const js = read("ui.js");
    expect(js.length).toBeLessThan(3072);
    expect(js).not.toMatch(/\beval\(|new Function|fetch\(|XMLHttpRequest|window\.parent|postMessage|import\s/);
  });
});
