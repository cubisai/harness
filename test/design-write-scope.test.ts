import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { acpEditTargets, decidePluginAsk } from "../src/main/agents/acp/driver";
import { claudeWriteTargets } from "../src/main/agents/claude";
import { designWriteAllowed, insideDesignFolder } from "../src/main/design/write-scope";
import { editTargets } from "../src/main/harness/driver";
import type { PermissionMode } from "../src/shared/types";
import { tempDir } from "./helpers";

const DESIGN = "designs/abcd1234";

/** A thread folder with its design folder made, plus a sibling folder outside it. */
function threadFolder(): string {
  const cwd = tempDir();
  mkdirSync(join(cwd, DESIGN), { recursive: true });
  mkdirSync(join(cwd, "src"), { recursive: true });
  return cwd;
}

describe("insideDesignFolder", () => {
  it("accepts relative and absolute paths inside the design folder, existing or not", () => {
    const cwd = threadFolder();
    expect(insideDesignFolder(cwd, DESIGN, [`${DESIGN}/index.html`])).toBe(true);
    expect(insideDesignFolder(cwd, DESIGN, [join(cwd, DESIGN, "new/dir/page.html")])).toBe(true);
    expect(insideDesignFolder(cwd, DESIGN, [`${DESIGN}/a.css`, `${DESIGN}/b.js`])).toBe(true);
  });

  it("rejects paths outside it, traversal, and a mix with one outside", () => {
    const cwd = threadFolder();
    expect(insideDesignFolder(cwd, DESIGN, ["src/app.ts"])).toBe(false);
    expect(insideDesignFolder(cwd, DESIGN, [`${DESIGN}/../../src/app.ts`])).toBe(false);
    expect(insideDesignFolder(cwd, DESIGN, ["designs/abcd12345/index.html"])).toBe(false);
    expect(insideDesignFolder(cwd, DESIGN, [`${DESIGN}/index.html`, "src/app.ts"])).toBe(false);
    expect(insideDesignFolder(cwd, DESIGN, ["/etc/passwd"])).toBe(false);
  });

  it("follows symlinks: a link inside the folder that points outside is outside", () => {
    const cwd = threadFolder();
    const outside = tempDir();
    writeFileSync(join(outside, "secret.txt"), "x");
    symlinkSync(outside, join(cwd, DESIGN, "escape"), "dir");
    expect(insideDesignFolder(cwd, DESIGN, [`${DESIGN}/escape/secret.txt`])).toBe(false);
    expect(insideDesignFolder(cwd, DESIGN, [`${DESIGN}/escape/new.txt`])).toBe(false);
  });

  it("is false without a design folder, without paths, or for blank paths", () => {
    const cwd = threadFolder();
    expect(insideDesignFolder(cwd, undefined, [`${DESIGN}/index.html`])).toBe(false);
    expect(insideDesignFolder(cwd, DESIGN, [])).toBe(false);
    expect(insideDesignFolder(cwd, DESIGN, ["  "])).toBe(false);
  });

  it("works before the design folder exists", () => {
    const cwd = tempDir();
    expect(insideDesignFolder(cwd, DESIGN, [`${DESIGN}/index.html`])).toBe(true);
    expect(insideDesignFolder(cwd, DESIGN, ["index.html"])).toBe(false);
  });
});

describe("designWriteAllowed", () => {
  it("widens only Ask and Auto-edit; Plan stays read-only and Full is unaffected", () => {
    const cwd = threadFolder();
    const inside = [`${DESIGN}/index.html`];
    const verdicts = (["ask", "auto-edit", "plan", "full"] as PermissionMode[]).map((m) => designWriteAllowed(m, cwd, DESIGN, inside));
    expect(verdicts).toEqual([true, true, false, false]);
    expect(designWriteAllowed("ask", cwd, DESIGN, ["src/app.ts"])).toBe(false);
  });
});

describe("write targets per driver", () => {
  it("native loop: path, or every file and move target in a patch", () => {
    expect(editTargets("write", { path: "a.html" })).toEqual(["a.html"]);
    expect(editTargets("edit", { path: "b.css" })).toEqual(["b.css"]);
    const patch = ["*** Begin Patch", "*** Add File: x/new.html", "+hi", "*** Update File: y.css", "*** Move to: z.css", "@@", "-a", "+b", "*** End Patch"].join("\n");
    expect(editTargets("apply_patch", { patch })).toEqual(["x/new.html", "y.css", "z.css"]);
    expect(editTargets("apply_patch", { patch: "garbage" })).toEqual([]);
  });

  it("Claude: Write/Edit/MultiEdit/NotebookEdit paths only", () => {
    expect(claudeWriteTargets("Write", { file_path: "/a/b.html" })).toEqual(["/a/b.html"]);
    expect(claudeWriteTargets("MultiEdit", { file_path: "c.css" })).toEqual(["c.css"]);
    expect(claudeWriteTargets("NotebookEdit", { notebook_path: "n.ipynb" })).toEqual(["n.ipynb"]);
    expect(claudeWriteTargets("Bash", { command: "echo > designs/x/a.html" })).toEqual([]);
  });

  it("ACP: locations first, then the raw input's path", () => {
    expect(acpEditTargets({ locations: [{ path: "/p/a.html" }, { path: "/p/b.css" }] })).toEqual(["/p/a.html", "/p/b.css"]);
    expect(acpEditTargets({ locations: [], rawInput: { filePath: "/p/c.html" } })).toEqual(["/p/c.html"]);
    expect(acpEditTargets({ rawInput: {} })).toEqual([]);
  });
});

describe("decidePluginAsk in a design thread", () => {
  it("allows an Ask-mode edit inside the design folder without asking, and still asks outside it", async () => {
    const cwd = threadFolder();
    let asked = 0;
    const input = { permissionMode: "ask" as const, cwd, design: DESIGN, requestPermission: async () => (asked++, "deny" as const) };
    expect(await decidePluginAsk(input, { tool: "write", kind: "edit", summary: join(cwd, DESIGN, "index.html") })).toBe("allow-once");
    expect(asked).toBe(0);
    expect(await decidePluginAsk(input, { tool: "write", kind: "edit", summary: join(cwd, "src/app.ts") })).toBe("deny");
    expect(asked).toBe(1);
    expect(await decidePluginAsk(input, { tool: "bash", kind: "execute", summary: `echo > ${DESIGN}/a.html` })).toBe("deny");
    expect(asked).toBe(2);
  });
});
