import { mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { createGuide } from "../src/main/guide";
import { tempDir } from "./helpers";

function write(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}

describe("createGuide", () => {
  it("joins the bundled, global, and project guides in that order", () => {
    const root = tempDir();
    const bundled = join(root, "app", "HARNESS.md");
    const global = join(root, "userData", "HARNESS.md");
    const cwd = join(root, "project");
    write(bundled, "  bundled  ");
    write(global, "global");
    write(join(cwd, ".agents", "HARNESS.md"), "project");
    const guide = createGuide({ bundled, global });
    expect(guide.forCwd(cwd)).toBe("bundled\n\nglobal\n\nproject");
  });

  it("skips missing files and returns empty when there are none", () => {
    const root = tempDir();
    const guide = createGuide({ bundled: join(root, "missing-app.md"), global: join(root, "missing-user.md") });
    expect(guide.forCwd(join(root, "project"))).toBe("");
  });

  it("keeps only the guides that exist", () => {
    const root = tempDir();
    const global = join(root, "userData", "HARNESS.md");
    write(global, "global");
    const guide = createGuide({ bundled: join(root, "missing.md"), global });
    expect(guide.forCwd(join(root, "project"))).toBe("global");
  });

  it("re-reads a file once its mtime changes", () => {
    const root = tempDir();
    const bundled = join(root, "HARNESS.md");
    write(bundled, "one");
    const guide = createGuide({ bundled, global: join(root, "none.md") });
    expect(guide.forCwd(join(root, "project"))).toBe("one");
    write(bundled, "two");
    const bumped = new Date(Date.now() + 10_000);
    utimesSync(bundled, bumped, bumped);
    expect(guide.forCwd(join(root, "project"))).toBe("two");
  });

  it("serves the cached text while the mtime is unchanged", () => {
    const root = tempDir();
    const bundled = join(root, "HARNESS.md");
    write(bundled, "cached");
    const guide = createGuide({ bundled, global: join(root, "none.md") });
    expect(guide.forCwd(join(root, "project"))).toBe("cached");
    // Rewrite the contents but hand the file back its old mtime: the cache wins.
    const stamp = new Date(1_700_000_000_000);
    utimesSync(bundled, stamp, stamp);
    const first = guide.forCwd(join(root, "project"));
    write(bundled, "changed");
    utimesSync(bundled, stamp, stamp);
    expect(first).toBe("cached");
    expect(guide.forCwd(join(root, "project"))).toBe("cached");
  });
});
