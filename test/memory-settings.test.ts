import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MemoryStore } from "../src/main/memory/store";
import { createMemory, memoryOn } from "../src/main/memory";
import { SettingsStore, type SecretBox } from "../src/main/settings";
import type { Settings } from "../src/shared/types";
import { tempDir } from "./helpers";

const box: SecretBox = {
  available: true,
  encrypt: (s) => Buffer.from(s).toString("base64"),
  decrypt: (b) => Buffer.from(b, "base64").toString(),
};

const fresh = () => join(tempDir(), "settings.json");
const settingsWith = (memory?: Settings["memory"]): Settings => ({ memory }) as Settings;

describe("memory settings", () => {
  it("defaults to on with no disabled projects", () => {
    expect(new SettingsStore(fresh(), box).get().memory).toEqual({ enabled: true, disabledProjects: [] });
  });

  it("validates types and dedupes the disabled list", () => {
    const file = fresh();
    const s = new SettingsStore(file, box);
    s.update({ memory: { enabled: "nope", disabledProjects: ["a", "a", 3, "b"] } as never });
    expect(s.get().memory).toEqual({ enabled: true, disabledProjects: ["a", "b"] });
    s.update({ memory: { enabled: false, disabledProjects: ["x"] } });
    expect(new SettingsStore(file, box).get().memory).toEqual({ enabled: false, disabledProjects: ["x"] });
  });

  it("merges a stored partial memory object with the default", () => {
    const file = fresh();
    writeFileSync(file, JSON.stringify({ schemaVersion: 3, settings: { memory: { enabled: false } } }));
    expect(new SettingsStore(file, box).get().memory).toEqual({ enabled: false, disabledProjects: [] });
  });

  it("memoryOn follows the enabled flag and the disabled list", () => {
    expect(memoryOn(settingsWith(), "p1")).toBe(true);
    expect(memoryOn(settingsWith({ enabled: false, disabledProjects: [] }), "p1")).toBe(false);
    expect(memoryOn(settingsWith({ enabled: true, disabledProjects: ["p1"] }), "p1")).toBe(false);
    expect(memoryOn(settingsWith({ enabled: true, disabledProjects: ["p1"] }), "p2")).toBe(true);
  });
});

describe("createMemory", () => {
  it("creates the project folder and exposes the store", () => {
    const root = tempDir();
    const home = tempDir();
    const memory = createMemory({ root, home });
    const dir = memory.ensure("p1", "/proj");
    expect(dir).toBe(join(root, "p1"));
    expect(memory.store).toBeInstanceOf(MemoryStore);
    expect(memory.store.dir("p1")).toBe(dir);
  });
});
