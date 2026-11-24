import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AppCalls } from "../src/main/apps/calls";
import { prepareAppEdit } from "../src/main/apps/manage";
import { AppRegistry, appEditDraftsDir } from "../src/main/apps/registry";
import { serveApp } from "../src/main/apps/serve";

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

function setup() {
  const root = mkdtempSync(join(tmpdir(), "apps-management-"));
  dirs.push(root);
  const dir = join(root, "apps", "sales");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "app.json"), JSON.stringify({ name: "sales", title: "Sales", description: "Daily sales", grants: [{ server: "shop", tools: ["summary", "refund"] }] }));
  writeFileSync(join(dir, "index.html"), "<h1>Original app</h1>");
  const drafts = join(root, "thread", ".cubiq", "app-drafts");
  const deps = { globalDir: join(root, "apps"), stateFile: join(root, "app-state.json"), projectPath: () => null, draftsDir: (tid: string) => tid === "creator" ? drafts : null };
  const registry = new AppRegistry(deps);
  return { root, dir, drafts, deps, registry };
}

describe("app management", () => {
  it("persists disabled apps in Library but refuses to serve or call them", async () => {
    const e = setup();
    e.registry.setEnabled("g~sales", false);
    const registry = new AppRegistry(e.deps);
    expect(registry.info("g~sales")).toMatchObject({ title: "Sales", enabled: false });
    expect(registry.list(null)).toHaveLength(1);
    expect(registry.root("g~sales")).toBeNull();
    const served = serveApp(registry.info("g~sales")!.url, { appRoot: (key) => registry.root(key), bridge: "" });
    expect(served.status).toBe(404);
    const call = vi.fn();
    const calls = new AppCalls({ registry, call, dataDir: join(e.root, "data") });
    expect(await calls.call("g~sales", null, "shop", "summary", {})).toMatchObject({ ok: false, error: expect.stringContaining("disabled") });
    expect(call).not.toHaveBeenCalled();
    expect(calls.storeSet("g~sales", "x", 1).ok).toBe(false);
    registry.setEnabled("g~sales", true);
    expect(registry.root("g~sales")).toBe(e.dir);
    expect(readFileSync(join(e.dir, "index.html"), "utf8")).toContain("Original");
  });

  it("refuses draft/unknown enable keys and clears state on uninstall", () => {
    const e = setup();
    expect(() => e.registry.setEnabled("d~creator~sales", false)).toThrow(/installed/);
    expect(() => e.registry.setEnabled("g~missing", false)).toThrow(/not found/);
    e.registry.setEnabled("g~sales", false);
    e.registry.resetEnabled("g~sales");
    expect(new AppRegistry(e.deps).isEnabled("g~sales")).toBe(true);
  });

  it("persists favourites in their own file, keeps the enable-state file's array format, and clears them on uninstall", () => {
    const e = setup();
    const deps = { ...e.deps, favoritesFile: join(e.root, "app-favorites.json") };
    const registry = new AppRegistry(deps);
    expect(() => registry.setFavorite("d~creator~sales", true)).toThrow(/installed/);
    registry.setFavorite("g~sales", true, 42);
    registry.setEnabled("g~sales", false);
    expect(JSON.parse(readFileSync(e.deps.stateFile, "utf8"))).toEqual(["g~sales"]);
    expect(new AppRegistry(deps).info("g~sales")).toMatchObject({ favorite: 42, enabled: false });
    registry.setFavorite("g~sales", true, 99);
    expect(new AppRegistry(deps).info("g~sales")?.favorite).toBe(42);
    registry.resetEnabled("g~sales");
    expect(new AppRegistry(deps).info("g~sales")).not.toHaveProperty("favorite");
    expect(new AppRegistry(deps).isEnabled("g~sales")).toBe(true);
  });

  it("seeds an editable draft even while disabled, without changing installed files", () => {
    const e = setup();
    e.registry.setEnabled("g~sales", false);
    const r = prepareAppEdit(e.registry, "g~sales", "creator");
    expect(r.app).toMatchObject({ key: "d~creator~sales", scope: "draft" });
    expect(readFileSync(join(e.drafts, "sales", "index.html"), "utf8")).toBe("<h1>Original app</h1>");
    expect(r.prompt).toContain("creator_app_check");
    expect(r.prompt).toContain("Update");
    expect(r.prompt).toContain("What would you like to change?");
    writeFileSync(join(e.drafts, "sales", "index.html"), "User draft");
    expect(() => prepareAppEdit(e.registry, "g~sales", "creator")).toThrow(/already exists/);
    expect(readFileSync(join(e.drafts, "sales", "index.html"), "utf8")).toBe("User draft");
    expect(readFileSync(join(e.dir, "index.html"), "utf8")).toContain("Original");
  });

  it("refuses non-Creator targets, draft sources, invalid apps and symlink copies", () => {
    const e = setup();
    expect(() => prepareAppEdit(e.registry, "g~sales", "ordinary")).toThrow(/Creator/);
    expect(() => prepareAppEdit(e.registry, "d~creator~sales", "creator")).toThrow(/installed/);
    symlinkSync(join(e.dir, "index.html"), join(e.dir, "link.html"));
    expect(() => prepareAppEdit(e.registry, "g~sales", "creator")).toThrow(/symlink/);
    expect(existsSync(join(e.drafts, "sales"))).toBe(false);
    rmSync(join(e.dir, "link.html"));
    writeFileSync(join(e.dir, "app.json"), "{}");
    e.registry.forget(e.dir);
    expect(() => prepareAppEdit(e.registry, "g~sales", "creator")).toThrow();
  });

  it("gives separate edit threads independent drafts and preserves the original build draft", () => {
    const e = setup();
    const cwd = join(e.root, "project");
    const original = join(cwd, ".cubiq", "app-drafts", "sales");
    mkdirSync(original, { recursive: true });
    writeFileSync(join(original, "index.html"), "Original draft");
    const registry = new AppRegistry({ ...e.deps, draftsDir: (id) => appEditDraftsDir(cwd, id) });
    const one = prepareAppEdit(registry, "g~sales", "one", cwd);
    const two = prepareAppEdit(registry, "g~sales", "two", cwd);
    expect(one.app.path).not.toBe(two.app.path);
    expect(readFileSync(join(original, "index.html"), "utf8")).toBe("Original draft");
  });

  it("invalidates cached reads and pending approval tokens without dropping app data", async () => {
    const e = setup();
    const manifest = JSON.parse(readFileSync(join(e.dir, "app.json"), "utf8"));
    writeFileSync(join(e.dir, "app.json"), JSON.stringify({ ...manifest, cacheSec: 60 }));
    let runs = 0;
    const calls = new AppCalls({ registry: e.registry, dataDir: join(e.root, "data"), call: async (_p, _s, tool, _a, before) => {
      const error = await before({ name: tool, description: "", inputSchema: {}, ...(tool === "summary" ? { readOnly: true as const } : {}) });
      if (error) return { text: error, isError: true };
      return { text: String(++runs), isError: false };
    } });
    calls.storeSet("g~sales", "saved", 42);
    await calls.call("g~sales", null, "shop", "summary", {});
    await calls.call("g~sales", null, "shop", "summary", {});
    expect(runs).toBe(1);
    const pending = await calls.call("g~sales", null, "shop", "refund", {});
    if (pending.ok || !("approval" in pending)) throw new Error("Expected approval");
    calls.invalidate("g~sales");
    await calls.call("g~sales", null, "shop", "summary", {});
    expect(runs).toBe(2);
    const retried = await calls.call("g~sales", null, "shop", "refund", {}, { token: pending.approval.token });
    expect(retried).toHaveProperty("approval");
    expect(runs).toBe(2);
    expect(calls.storeGet("g~sales", "saved")).toBe(42);
  });

  it("does not let an in-flight old read refill the cache after an update", async () => {
    const e = setup();
    let release!: () => void;
    const calls = new AppCalls({ registry: e.registry, dataDir: join(e.root, "data"), call: async (_p, _s, tool, _a, before) => {
      await before({ name: tool, description: "", inputSchema: {}, readOnly: true });
      await new Promise<void>((r) => { release = r; });
      return { text: "old data", isError: false };
    } });
    const pending = calls.call("g~sales", null, "shop", "summary", {});
    await Promise.resolve();
    calls.invalidate("g~sales");
    release();
    expect(await pending).toMatchObject({ ok: false, error: expect.stringContaining("changed") });
  });
});
