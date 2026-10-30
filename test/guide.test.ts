import { existsSync, mkdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { createGuide, designNote, ISSUES_NOTE, projectGuidePath, UI_BLOCKS_NOTE, userGuidePath } from "../src/main/guide";
import { estimateTokens } from "../src/main/handoff";
import { UI_NAMES } from "../src/renderer/src/genui/types";
import { tempDir } from "./helpers";

function write(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}

describe("createGuide", () => {
  it("joins the bundled, global, and project guides in that order", () => {
    const root = tempDir();
    const bundled = join(root, "app", "CUBIQ.md");
    const global = join(root, "userData", "CUBIQ.md");
    const cwd = join(root, "project");
    write(bundled, "  bundled  ");
    write(global, "global");
    write(join(cwd, ".cubiq", "CUBIQ.md"), "project");
    const guide = createGuide({ bundled, global });
    expect(guide.forCwd(cwd)).toBe("bundled\n\nglobal\n\nproject");
  });

  it("ends a design thread's guide with the design note naming its folder, the same every turn", () => {
    const root = tempDir();
    const bundled = join(root, "app", "CUBIQ.md");
    write(bundled, "bundled");
    const guide = createGuide({ bundled, global: join(root, "none.md") });
    const text = guide.forCwd(join(root, "project"), "designs/abcd1234");
    expect(text).toBe(`bundled\n\n${designNote("designs/abcd1234")}`);
    expect(text).toContain("`designs/abcd1234/index.html`");
    expect(guide.forCwd(join(root, "project"), "designs/abcd1234")).toBe(text);
    expect(guide.forCwd(join(root, "project"))).toBe("bundled");
  });

  it("skips missing files and returns empty when there are none", () => {
    const root = tempDir();
    const guide = createGuide({ bundled: join(root, "missing-app.md"), global: join(root, "missing-user.md") });
    expect(guide.forCwd(join(root, "project"))).toBe("");
  });

  it("keeps only the guides that exist", () => {
    const root = tempDir();
    const global = join(root, "userData", "CUBIQ.md");
    write(global, "global");
    const guide = createGuide({ bundled: join(root, "missing.md"), global });
    expect(guide.forCwd(join(root, "project"))).toBe("global");
  });

  it("re-reads a file once its mtime changes", () => {
    const root = tempDir();
    const bundled = join(root, "CUBIQ.md");
    write(bundled, "one");
    const guide = createGuide({ bundled, global: join(root, "none.md") });
    expect(guide.forCwd(join(root, "project"))).toBe("one");
    write(bundled, "two");
    const bumped = new Date(Date.now() + 10_000);
    utimesSync(bundled, bumped, bumped);
    expect(guide.forCwd(join(root, "project"))).toBe("two");
  });

  it("normalizes CRLF to LF", () => {
    const root = tempDir();
    const bundled = join(root, "CUBIQ.md");
    write(bundled, "# Guide\r\n\r\n- one\r\n- two\r\n");
    const guide = createGuide({ bundled, global: join(root, "none.md") });
    expect(guide.forCwd(join(root, "project"))).toBe("# Guide\n\n- one\n- two");
  });

  it("sends the UI block catalog only when Interactive answers is on, right after the app's guide", () => {
    const root = tempDir();
    const bundled = join(root, "CUBIQ.md");
    const global = join(root, "user.md");
    write(bundled, "# App");
    write(global, "# Mine");
    let on = false;
    const guide = createGuide({ bundled, global, uiBlocks: () => on });
    expect(guide.forCwd(join(root, "p"))).toBe("# App\n\n# Mine");
    on = true;
    expect(guide.forCwd(join(root, "p"))).toBe(`# App\n\n${UI_BLOCKS_NOTE}\n\n# Mine`);
    expect(guide.partsForCwd(join(root, "p")).map((p) => p.path)).toEqual([bundled, "ui-blocks", global]);
    // One line, so the opt-in stays cheap.
    expect(UI_BLOCKS_NOTE).not.toContain("\n");
    // Nine widgets in about the v1 note's real size (this estimate is bytes / 3, so it runs high).
    expect(estimateTokens(UI_BLOCKS_NOTE)).toBeLessThanOrEqual(150);
    // Every widget's line form is named, so an agent can find it.
    for (const name of UI_NAMES) expect(UI_BLOCKS_NOTE).toMatch(new RegExp(`\\b${name}\\b`));
  });

  it("tells the agent about the issue tracker only in a project that has one, after the app's guide", () => {
    const root = tempDir();
    const bundled = join(root, "CUBIQ.md");
    const global = join(root, "user.md");
    write(bundled, "# App");
    write(global, "# Mine");
    const guide = createGuide({ bundled, global, issues: (cwd) => cwd.endsWith("tracked") });
    expect(guide.forCwd(join(root, "plain"))).toBe("# App\n\n# Mine");
    expect(guide.forCwd(join(root, "tracked"))).toBe(`# App\n\n${ISSUES_NOTE}\n\n# Mine`);
    expect(guide.partsForCwd(join(root, "tracked")).map((p) => p.path)).toEqual([bundled, "issues", global]);
    expect(ISSUES_NOTE).not.toContain("\n");
    expect(ISSUES_NOTE).toContain("issue_create");
    expect(estimateTokens(ISSUES_NOTE)).toBeLessThanOrEqual(120);
  });

  it("keeps the bundled guide within its 600-token budget", () => {
    const text = readFileSync(join(__dirname, "..", "resources", "CUBIQ.md"), "utf8").replace(/\r\n?/g, "\n").trim();
    expect(estimateTokens(text)).toBeLessThanOrEqual(600);
  });

  it("asks every agent for evidence, honest tests and real packages", () => {
    const text = readFileSync(join(__dirname, "..", "resources", "CUBIQ.md"), "utf8");
    for (const line of ["read a file before describing or changing it", "fix the code, not the tests", "check that a package exists", "claim only checks you ran", "mark a step done the moment it finishes"]) {
      expect(text).toContain(line);
    }
  });

  it("serves the cached text while the mtime is unchanged", () => {
    const root = tempDir();
    const bundled = join(root, "CUBIQ.md");
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

describe("createGuide.partsForCwd", () => {
  it("returns the sources in order, trimming text and skipping missing files", () => {
    const root = tempDir();
    const bundled = join(root, "app", "CUBIQ.md");
    const global = join(root, "userData", "CUBIQ.md");
    const cwd = join(root, "project");
    write(bundled, "  bundled  ");
    write(global, "global");
    const guide = createGuide({ bundled, global });
    // No project file: only the two present ones, in source order.
    expect(guide.partsForCwd(cwd)).toEqual([
      { source: "bundled", path: bundled, text: "bundled" },
      { source: "user", path: global, text: "global" },
    ]);
  });

  it("labels the project guide and uses the .cubiq/CUBIQ.md path", () => {
    const root = tempDir();
    const cwd = join(root, "project");
    const project = join(cwd, ".cubiq", "CUBIQ.md");
    write(project, "project");
    const guide = createGuide({ bundled: join(root, "none.md"), global: join(root, "none-user.md") });
    expect(guide.partsForCwd(cwd)).toEqual([{ source: "project", path: project, text: "project" }]);
  });

  it("forCwd is the parts joined by a blank line", () => {
    const root = tempDir();
    const bundled = join(root, "app", "CUBIQ.md");
    const global = join(root, "userData", "CUBIQ.md");
    const cwd = join(root, "project");
    write(bundled, "bundled");
    write(global, "global");
    write(join(cwd, ".cubiq", "CUBIQ.md"), "project");
    const guide = createGuide({ bundled, global });
    expect(guide.forCwd(cwd)).toBe(guide.partsForCwd(cwd).map((p) => p.text).join("\n\n"));
  });
});

describe("guide paths", () => {
  it("falls back to .agents/HARNESS.md only when .cubiq/CUBIQ.md is missing", () => {
    const cwd = join(tempDir(), "project");
    const own = join(cwd, ".cubiq", "CUBIQ.md");
    const legacy = join(cwd, ".agents", "HARNESS.md");
    expect(projectGuidePath(cwd)).toBe(own);
    write(legacy, "old");
    expect(projectGuidePath(cwd)).toBe(legacy);
    expect(createGuide({ bundled: join(cwd, "none.md"), global: join(cwd, "none-user.md") }).forCwd(cwd)).toBe("old");
    // Both present: only CUBIQ.md is read, so nothing reaches the prompt twice.
    write(own, "new");
    expect(projectGuidePath(cwd)).toBe(own);
    expect(createGuide({ bundled: join(cwd, "none.md"), global: join(cwd, "none-user.md") }).forCwd(cwd)).toBe("new");
  });

  it("moves the user's old HARNESS.md to CUBIQ.md once, never over an existing one", () => {
    const data = tempDir();
    write(join(data, "HARNESS.md"), "mine");
    expect(userGuidePath(data)).toBe(join(data, "CUBIQ.md"));
    expect(readFileSync(join(data, "CUBIQ.md"), "utf8")).toBe("mine");
    expect(existsSync(join(data, "HARNESS.md"))).toBe(false);
    write(join(data, "HARNESS.md"), "stale");
    userGuidePath(data);
    expect(readFileSync(join(data, "CUBIQ.md"), "utf8")).toBe("mine");
  });
});
