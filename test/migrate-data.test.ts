import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { migrateLegacyData } from "../src/main/migrate-data";
import { tempDir } from "./helpers";

/** A pre-rename data folder: the files worth keeping plus the caches and locks that aren't. */
function legacyFolder(appData: string, name: string): string {
  const dir = join(appData, name);
  mkdirSync(join(dir, "skills"), { recursive: true });
  writeFileSync(join(dir, "unskilled.db"), "db");
  writeFileSync(join(dir, "unskilled.db-wal"), "wal");
  writeFileSync(join(dir, "settings.json"), "{}");
  writeFileSync(join(dir, "skills", "note.txt"), "nested");
  mkdirSync(join(dir, "Cache"), { recursive: true });
  writeFileSync(join(dir, "Cache", "cached.bin"), "cache");
  writeFileSync(join(dir, "SingletonLock"), "lock");
  return dir;
}

describe("migrateLegacyData", () => {
  it("copies the newest legacy folder when the target has no database", () => {
    const appData = tempDir();
    const target = join(tempDir(), "CubiQ");
    const from = legacyFolder(appData, "AI Harness");
    legacyFolder(appData, "UnSkilled"); // an older leftover: the first name wins

    expect(migrateLegacyData({ appData, target, legacyNames: ["AI Harness", "UnSkilled"] })).toBe(from);
    expect(readFileSync(join(target, "unskilled.db"), "utf-8")).toBe("db");
    expect(readFileSync(join(target, "unskilled.db-wal"), "utf-8")).toBe("wal");
    expect(readFileSync(join(target, "settings.json"), "utf-8")).toBe("{}");
    expect(readFileSync(join(target, "skills", "note.txt"), "utf-8")).toBe("nested");
    // Chromium's cache and lock entries stay behind.
    expect(existsSync(join(target, "Cache"))).toBe(false);
    expect(existsSync(join(target, "SingletonLock"))).toBe(false);
  });

  it("falls back to an older legacy name when the first is absent", () => {
    const appData = tempDir();
    const target = join(tempDir(), "CubiQ");
    const from = legacyFolder(appData, "UnSkilled");

    expect(migrateLegacyData({ appData, target, legacyNames: ["AI Harness", "UnSkilled"] })).toBe(from);
    expect(readFileSync(join(target, "unskilled.db"), "utf-8")).toBe("db");
  });

  it("does nothing when the target already has a database", () => {
    const appData = tempDir();
    const target = join(tempDir(), "CubiQ");
    legacyFolder(appData, "AI Harness");
    mkdirSync(target, { recursive: true });
    writeFileSync(join(target, "unskilled.db"), "existing");

    expect(migrateLegacyData({ appData, target, legacyNames: ["AI Harness", "UnSkilled"] })).toBeNull();
    expect(readFileSync(join(target, "unskilled.db"), "utf-8")).toBe("existing");
    expect(existsSync(join(target, "settings.json"))).toBe(false);
  });

  it("returns null when no legacy folder has a database", () => {
    const appData = tempDir();
    mkdirSync(join(appData, "AI Harness"), { recursive: true });
    expect(migrateLegacyData({ appData, target: join(tempDir(), "CubiQ"), legacyNames: ["AI Harness", "UnSkilled"] })).toBeNull();
  });

  it("never modifies or deletes the legacy folder", () => {
    const appData = tempDir();
    const target = join(tempDir(), "CubiQ");
    const from = legacyFolder(appData, "AI Harness");

    migrateLegacyData({ appData, target, legacyNames: ["AI Harness", "UnSkilled"] });

    expect(readFileSync(join(from, "unskilled.db"), "utf-8")).toBe("db");
    expect(readFileSync(join(from, "skills", "note.txt"), "utf-8")).toBe("nested");
    expect(readFileSync(join(from, "Cache", "cached.bin"), "utf-8")).toBe("cache");
    expect(readFileSync(join(from, "SingletonLock"), "utf-8")).toBe("lock");
  });
});
