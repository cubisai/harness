import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createMemoryApi } from "../src/main/memory/api";
import { claudeProjectKey } from "../src/main/memory/import";
import { MemoryStore, serializeFact } from "../src/main/memory/store";
import type { Settings } from "../src/shared/types";
import { tempDir } from "./helpers";

/** A Settings holder whose update() merges the memory object, like SettingsStore. */
function fakeSettings(initial: Partial<Settings> = {}) {
  let value = {
    theme: "system",
    defaultAgent: null,
    defaultPermissionMode: "ask",
    autoUpdate: true,
    editor: null,
    providerInjection: {},
    ...initial,
  } as Settings;
  return {
    get: (): Settings => value,
    update: (patch: Partial<Settings>): Settings => {
      value = { ...value, ...patch };
      if (patch.memory) value = { ...value, memory: { ...(value.memory ?? { enabled: true, disabledProjects: [] }), ...patch.memory } };
      return value;
    },
  };
}

function setup(projectPath = "/proj") {
  const store = new MemoryStore(tempDir());
  const ensured: string[] = [];
  const memory = {
    store,
    ensure: (projectId: string, path: string): string => {
      ensured.push(`${projectId}:${path}`);
      return store.dir(projectId);
    },
  };
  const settings = fakeSettings();
  const home = tempDir();
  const api = createMemoryApi({ memory, settings, projectPath: () => projectPath, home });
  return { store, api, settings, ensured, home };
}

describe("memory api", () => {
  it("builds the overview and ensures the project folder", () => {
    const { api, ensured, store } = setup();
    expect(api.overview("p1")).toEqual({
      enabled: true,
      projectOn: true,
      dir: store.dir("p1"),
      index: { lines: 0, tokens: 0 },
      notes: [],
    });
    expect(ensured).toEqual(["p1:/proj"]);
  });

  it("writes, reads and lists a trimmed note; an unknown type becomes project", () => {
    const { api } = setup();
    const file = api.write("p1", { name: "  Commit Style ", description: "  Max 150  ", type: "feedback", body: "Keep it short." });
    expect(file).toBe("commit-style.md");
    expect(api.read("p1", file)).toEqual({ file, name: "Commit Style", description: "Max 150", type: "feedback", body: "Keep it short." });
    expect(api.overview("p1").notes).toEqual([{ file, name: "Commit Style", description: "Max 150", type: "feedback" }]);
    expect(api.write("p1", { name: "Mystery", description: "", type: "bogus" as never, body: "" })).toBe("mystery.md");
    expect(api.read("p1", "mystery.md")?.type).toBe("project");
    expect(() => api.write("p1", { name: "   ", description: "", type: "project", body: "" })).toThrow();
  });

  it("removes a note", () => {
    const { api } = setup();
    const file = api.write("p1", { name: "Gone", description: "", type: "project", body: "" });
    expect(api.remove("p1", file)).toBe(true);
    expect(api.remove("p1", file)).toBe(false);
    expect(api.overview("p1").notes).toEqual([]);
  });

  it("toggles memory globally and per project", () => {
    const { api } = setup();
    expect(api.setEnabled(null, false)).toBeNull();
    expect(api.overview("p1").enabled).toBe(false);
    expect(api.setEnabled("p1", false)?.projectOn).toBe(false);
    expect(api.overview("p1").projectOn).toBe(false);
    expect(api.overview("p2").projectOn).toBe(true);
    expect(api.setEnabled("p1", true)?.projectOn).toBe(true);
    expect(api.overview("p1").projectOn).toBe(true);
  });

  it("re-imports native memory on demand, without duplicating", () => {
    const { api, home } = setup();
    const src = join(home, ".claude", "projects", claudeProjectKey("/proj"), "memory");
    mkdirSync(src, { recursive: true });
    writeFileSync(join(src, "one.md"), serializeFact({ name: "One", description: "first", type: "project", body: "1" }));
    expect(api.reimport("p1")).toBe(1);
    writeFileSync(join(src, "two.md"), serializeFact({ name: "Two", description: "second", type: "project", body: "2" }));
    expect(api.reimport("p1")).toBe(1);
    expect(api.reimport("p1")).toBe(0);
    expect(api.overview("p1").notes.map((n) => n.name).sort()).toEqual(["One", "Two"]);
  });
});
