import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import JSZip from "jszip";
import { describe, expect, it } from "vitest";
import { KitStore } from "../src/main/design/kit-install";
import { validateKitDir } from "../src/main/design/kit-schema";
import { listKitSystems, materializeSystem } from "../src/main/design/systems";
import { tempDir } from "./helpers";

const ROOT = process.cwd();
const VALIDATE = join(ROOT, "design-kits", "scripts", "validate.mjs");
const FOUNDATION = join(ROOT, "resources", "design-kits", "foundation");

/** A design-kits folder holding one copy of Foundation, registered under `id`. */
function repoWithKit(id = "foundation"): { root: string; kit: string } {
  const root = tempDir();
  const kit = join(root, "kits", id);
  mkdirSync(join(root, "kits"), { recursive: true });
  cpSync(FOUNDATION, kit, { recursive: true });
  const manifest = JSON.parse(readFileSync(join(kit, "components.json"), "utf8")) as { name: string; version: string };
  writeFileSync(join(root, "registry.json"), JSON.stringify({ version: 1, kits: [{ id, name: manifest.name, version: manifest.version, themes: [], card: { bg: "#fff", text: "#111", accent: "#333", radius: "8px" } }] }));
  return { root, kit };
}

function runValidate(root: string, ...args: string[]): { status: number | null; out: string } {
  const result = spawnSync(process.execPath, [VALIDATE, "--root", root, ...args], { encoding: "utf8" });
  return { status: result.status, out: `${result.stdout}${result.stderr}` };
}

function patchManifest(kit: string, change: (m: Record<string, unknown>) => void): void {
  const path = join(kit, "components.json");
  const manifest = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  change(manifest);
  writeFileSync(path, JSON.stringify(manifest));
}

function filesIn(dir: string): string[] {
  return readdirSync(dir, { recursive: true, encoding: "utf8" }).filter((rel) => statSync(join(dir, rel)).isFile());
}

async function zipOf(dir: string): Promise<Uint8Array> {
  const zip = new JSZip();
  for (const rel of filesIn(dir)) zip.file(relative(dir, join(dir, rel)).replace(/\\/g, "/"), readFileSync(join(dir, rel)));
  return zip.generateAsync({ type: "uint8array", compression: "DEFLATE" });
}

describe("the design-kits folder", () => {
  it("is self-contained: nothing in the app imports it, and it imports nothing from the app", () => {
    const script = readFileSync(VALIDATE, "utf8");
    const imports = [...script.matchAll(/from\s+["']([^"']+)["']/g)].map((m) => m[1] ?? "");
    expect(imports.filter((name) => !name.startsWith("node:"))).toEqual([]);
    for (const dir of ["src/main", "src/renderer/src", "src/shared", "src/preload"]) {
      for (const rel of readdirSync(join(ROOT, dir), { recursive: true, encoding: "utf8" })) {
        if (!/\.tsx?$/.test(rel)) continue;
        expect(readFileSync(join(ROOT, dir, rel), "utf8"), rel).not.toMatch(/from\s+["'][^"']*design-kits/);
      }
    }
  });

  it("passes on the folder as it stands", () => {
    expect(runValidate(join(ROOT, "design-kits")).status).toBe(0);
  });

  it("exits 2 on bad usage", () => {
    expect(spawnSync(process.execPath, [VALIDATE, "--root"], { encoding: "utf8" }).status).toBe(2);
  });
});

describe("the standalone validator agrees with the app's", () => {
  type Fault = [string, (kit: string) => void];
  const FAULTS: Fault[] = [
    ["a missing ui.css", (kit) => rmSync(join(kit, "ui.css"))],
    ["a file type a kit never holds", (kit) => writeFileSync(join(kit, "tool.exe"), "x")],
    ["a bad index.md type", (kit) => writeFileSync(join(kit, "index.md"), "---\ntype: other\n---\n")],
    ["tokens with no --color-bg", (kit) => writeFileSync(join(kit, "tokens.css"), ":root { --color-text: #000; }")],
    ["an oversize ui.js", (kit) => writeFileSync(join(kit, "ui.js"), "x".repeat(33 * 1024))],
    ["a remote url in ui.css", (kit) => writeFileSync(join(kit, "ui.css"), `${readFileSync(join(kit, "ui.css"), "utf8")}\nbody { background: url(https://x.io/a.png); }`)],
    ["a script in a block", (kit) => writeFileSync(join(kit, "blocks", "bad.html"), "<script>x()</script>")],
    ["a handler in a block", (kit) => writeFileSync(join(kit, "blocks", "bad.html"), '<a onclick="x()">x</a>')],
    ["a script in an svg", (kit) => writeFileSync(join(kit, "blocks", "bad.svg"), "<svg><script>x()</script></svg>")],
    ["a duplicate part", (kit) => patchManifest(kit, (m) => {
      const list = m.components as unknown[];
      list.push(list[0]);
    })],
    ["a missing selector", (kit) => patchManifest(kit, (m) => {
      (m.components as unknown[]).push({ name: "New", ui: "brand-new", snippet: '<i data-ui="brand-new"></i>' });
    })],
    ["a prop named ui", (kit) => patchManifest(kit, (m) => {
      (m.components as { props?: unknown[] }[])[0]!.props = [{ name: "ui", label: "UI", type: "text" }];
    })],
    ["a snippet missing its data-ui", (kit) => patchManifest(kit, (m) => {
      (m.components as { snippet: string }[])[0]!.snippet = "<div></div>";
    })],
    ["a theme with no folder", (kit) => patchManifest(kit, (m) => {
      m.compat = { themes: ["ghost"], migratesFrom: [] };
    })],
  ];

  it("both pass a good kit", () => {
    const { root, kit } = repoWithKit();
    expect(validateKitDir(kit, "foundation").ok).toBe(true);
    expect(runValidate(root)).toMatchObject({ status: 0 });
  });

  for (const [name, breakIt] of FAULTS) {
    it(`both refuse ${name}`, () => {
      const { root, kit } = repoWithKit();
      breakIt(kit);
      expect(validateKitDir(kit, "foundation").ok).toBe(false);
      expect(runValidate(root).status).toBe(1);
    });
  }

  it("both refuse a kit whose id isn't its folder's name", () => {
    const { root, kit } = repoWithKit("other");
    expect(validateKitDir(kit, "other").ok).toBe(false);
    expect(runValidate(root).status).toBe(1);
  });

  it("flags a kit the registry doesn't list, and a listed kit that's gone", () => {
    const { root } = repoWithKit();
    writeFileSync(join(root, "registry.json"), JSON.stringify({ version: 1, kits: [] }));
    expect(runValidate(root).status).toBe(1);
    writeFileSync(join(root, "registry.json"), JSON.stringify({ version: 1, kits: [{ id: "gone", name: "Gone", version: "1.0.0" }] }));
    expect(runValidate(root).status).toBe(1);
  });
});

describe("installing from a local fixture repo", () => {
  const response = (bytes: Uint8Array) => (async () => new Response(bytes as BodyInit, { status: 200 })) as unknown as typeof fetch;

  it("installs a release zip, offers its systems and materializes one", async () => {
    const { kit } = repoWithKit();
    const bytes = await zipOf(kit);
    const store = new KitStore(tempDir());
    const entry = {
      id: "foundation",
      name: "Foundation",
      version: "1.0.0",
      url: "https://github.com/cubiq/kits/releases/download/foundation-1.0.0/foundation.zip",
      sha256: createHash("sha256").update(bytes).digest("hex"),
    };
    const installed = await store.install(entry, { fetch: response(bytes) });
    expect(installed.reused).toBe(false);
    expect(store.activeDir("foundation")).toBe(installed.dir);

    const [system] = listKitSystems(installed.dir);
    if (!system) throw new Error("The installed kit offers no systems.");
    const dest = join(tempDir(), "system");
    expect(materializeSystem(system, dest)).toBe(true);
    expect(readFileSync(join(dest, "ui.css"))).toEqual(readFileSync(join(FOUNDATION, "ui.css")));
    expect(existsSync(join(dest, "blocks", "hero.html"))).toBe(true);
  });

  it("rejects a tampered archive and a kit that fails the rules, leaving the installed one in place", async () => {
    const { kit } = repoWithKit();
    const good = await zipOf(kit);
    const packs = tempDir();
    const store = new KitStore(packs);
    const entry = (bytes: Uint8Array, version: string) => ({
      id: "foundation",
      name: "Foundation",
      version,
      url: "https://github.com/cubiq/kits/foundation.zip",
      sha256: createHash("sha256").update(bytes).digest("hex"),
    });
    const first = await store.install(entry(good, "1.0.0"), { fetch: response(good) });
    const before = filesIn(first.dir).sort();

    const tampered = new Uint8Array(good);
    tampered[100] = (tampered[100] ?? 0) ^ 0xff;
    await expect(store.install(entry(good, "1.0.1"), { fetch: response(tampered) })).rejects.toMatchObject({ code: "hash" });

    writeFileSync(join(kit, "ui.css"), "body { background: url(https://x.io/a.png); }");
    patchManifest(kit, (m) => {
      m.version = "1.0.1";
    });
    const bad = await zipOf(kit);
    await expect(store.install(entry(bad, "1.0.1"), { fetch: response(bad) })).rejects.toMatchObject({ code: "invalid" });

    expect(store.active().foundation?.version).toBe("1.0.0");
    expect(filesIn(first.dir).sort()).toEqual(before);
    expect(readdirSync(join(packs, "staging"))).toEqual([]);
  });
});

describe("the kits in the folder", () => {
  const KITS = join(ROOT, "design-kits", "kits");
  const ids = readdirSync(KITS, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
  const registry = JSON.parse(readFileSync(join(ROOT, "design-kits", "registry.json"), "utf8")) as { kits: { id: string; themes: string[] }[] };

  it("are all listed, and the whole folder validates", () => {
    expect(registry.kits.map((k) => k.id).sort()).toEqual([...ids].sort());
    expect(runValidate(join(ROOT, "design-kits")).status).toBe(0);
  });

  describe.each(ids)("%s", (id) => {
    const dir = join(KITS, id);
    const read = (name: string) => readFileSync(join(dir, name), "utf8");
    const manifest = () => JSON.parse(read("components.json")) as { compat: { themes: string[] }; components: { ui: string; kind?: string; snippet: string }[] };

    it("passes the app's validator", () => {
      const result = validateKitDir(dir, id);
      expect(result.ok ? [] : result.errors).toEqual([]);
    });

    it("says it is unofficial", () => {
      expect(read("README.md")).toMatch(/unofficial/i);
      expect(read("README.md")).toMatch(/not affiliated/i);
    });

    it("uses only tokens its tokens.css defines, or that it sets itself", () => {
      const css = read("ui.css");
      const defined = new Set([...`${read("tokens.css")}\n${css}`.matchAll(/(--[a-z0-9-]+)\s*:/g)].map((m) => m[1]));
      const used = [...css.matchAll(/var\(\s*(--[a-z0-9-]+)/g)].map((m) => m[1] ?? "");
      expect(used.filter((name) => !defined.has(name) && name !== "--value")).toEqual([]);
    });

    it("has no literal colours in ui.css", () => {
      expect(read("ui.css").match(/#[0-9a-f]{3,8}\b|\b(?:rgb|hsl)a?\(/gi) ?? []).toEqual([]);
    });

    it("every theme defines the same tokens as the kit", () => {
      const names = (css: string) => [...new Set([...css.matchAll(/(--[a-z0-9-]+)\s*:/g)].map((m) => m[1]))].sort();
      for (const theme of manifest().compat.themes) expect(names(read(`themes/${theme}/tokens.css`)), theme).toEqual(names(read("tokens.css")));
    });

    it("has a block for every composition, rooted at its own part", () => {
      for (const c of manifest().components.filter((part) => part.kind === "composition")) {
        expect(read(`blocks/${c.ui}.html`).trimStart().startsWith(`<section data-ui="${c.ui}"`), c.ui).toBe(true);
      }
    });

    it("only uses parts its own manifest declares", () => {
      const known = new Set(manifest().components.map((c) => c.ui));
      const blocks = readdirSync(join(dir, "blocks")).map((name) => read(`blocks/${name}`));
      const html = [...manifest().components.map((c) => c.snippet), ...blocks].join("\n");
      expect([...new Set([...html.matchAll(/data-ui="([^"]+)"/g)].map((m) => m[1] ?? ""))].filter((ui) => !known.has(ui))).toEqual([]);
    });

    it("offers itself and its themes, and materializes the kit's files", () => {
      const systems = listKitSystems(dir);
      expect(systems.map((s) => s.id).sort()).toEqual([`kit:${id}`, ...manifest().compat.themes.map((t) => `kit:${id}/${t}`)].sort());
      const dest = join(tempDir(), "system");
      expect(materializeSystem(systems[0]!, dest)).toBe(true);
      for (const name of ["DESIGN.md", "tokens.css", "ui.css", "components.json", ".kit"]) expect(existsSync(join(dest, name)), name).toBe(true);
    });
  });
});
