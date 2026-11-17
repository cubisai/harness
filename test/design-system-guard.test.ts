import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SystemGuard } from "../src/main/design/system-guard";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A fresh temp folder, removed after the test. */
function temp(): string {
  const dir = mkdtempSync(join(tmpdir(), "cubiq-guard-"));
  dirs.push(dir);
  return dir;
}

/** Every file under `dir` by `/`-separated relative path, as text (the fixtures are small). */
function files(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const file = join(current, entry.name);
      if (entry.isDirectory()) walk(file);
      else if (entry.isFile()) out[relative(dir, file).replace(/\\/g, "/")] = readFileSync(file, "utf8");
    }
  };
  walk(dir);
  return out;
}

/** A `system/` folder with the two files a design kit always has. */
function systemDir(): string {
  const dir = join(temp(), "system");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "tokens.css"), ":root { --color-bg: #fff; }\n");
  writeFileSync(join(dir, "DESIGN.md"), "# Design\n");
  return dir;
}

describe("SystemGuard", () => {
  it("undoes added, removed and rewritten files", () => {
    const dir = systemDir();
    const before = files(dir);
    const guard = new SystemGuard();
    guard.begin(dir);
    writeFileSync(join(dir, "tokens.css"), ":root { --color-bg: #000; }\n");
    rmSync(join(dir, "DESIGN.md"));
    writeFileSync(join(dir, "extra.css"), "body {}\n");
    mkdirSync(join(dir, "sub"), { recursive: true });
    writeFileSync(join(dir, "sub", "new.css"), "p {}\n");
    expect(guard.end(dir)).toEqual(["DESIGN.md", "extra.css", "sub/new.css", "tokens.css"]);
    expect(files(dir)).toEqual(before);
  });

  it("keeps what was written before a refresh", () => {
    const dir = systemDir();
    const guard = new SystemGuard();
    guard.begin(dir);
    writeFileSync(join(dir, "tokens.css"), "kept\n");
    guard.refresh(dir);
    expect(guard.end(dir)).toEqual([]);
    expect(readFileSync(join(dir, "tokens.css"), "utf8")).toBe("kept\n");
  });

  it("does nothing without begin", () => {
    const dir = systemDir();
    const guard = new SystemGuard();
    expect(guard.end(dir)).toEqual([]);
    expect(() => guard.refresh(dir)).not.toThrow();
    writeFileSync(join(dir, "extra.css"), "x\n");
    expect(guard.end(dir)).toEqual([]);
    expect(readFileSync(join(dir, "extra.css"), "utf8")).toBe("x\n");
  });

  it("removes what was created in a missing folder", () => {
    const dir = join(temp(), "missing", "system");
    const guard = new SystemGuard();
    guard.begin(dir);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "new.css"), "x\n");
    expect(guard.end(dir)).toEqual(["new.css"]);
    expect(files(dir)).toEqual({});
  });

  it("reports nothing when the folder is unchanged", () => {
    const dir = systemDir();
    const guard = new SystemGuard();
    guard.begin(dir);
    expect(guard.end(dir)).toEqual([]);
  });

  it("undoes a shell write before CubiQ's own write, so the refresh doesn't adopt it", () => {
    const dir = systemDir();
    const guard = new SystemGuard();
    guard.begin(dir);
    // The agent writes first; then a theme switch (settle, write, refresh); then the agent again.
    writeFileSync(join(dir, "hack.css"), "x\n");
    writeFileSync(join(dir, "tokens.css"), ":root { --color-bg: red; }\n");
    guard.settle(dir);
    expect(existsSync(join(dir, "hack.css"))).toBe(false);
    writeFileSync(join(dir, "tokens.css"), ":root { --color-bg: #fafafa; }\n");
    guard.refresh(dir);
    writeFileSync(join(dir, "late.css"), "y\n");
    expect(guard.end(dir)).toEqual(["hack.css", "late.css", "tokens.css"]);
    expect(files(dir)).toEqual({ "DESIGN.md": "# Design\n", "tokens.css": ":root { --color-bg: #fafafa; }\n" });
  });

  it("settle on an unguarded folder changes nothing", () => {
    const dir = systemDir();
    const guard = new SystemGuard();
    writeFileSync(join(dir, "extra.css"), "x\n");
    guard.settle(dir);
    expect(readFileSync(join(dir, "extra.css"), "utf8")).toBe("x\n");
  });
});
