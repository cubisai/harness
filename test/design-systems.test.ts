import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { listDesignSystems, materializeSystem, parseSystemIndex, resolveDesignSystem, type DesignSystemInfo } from "../src/main/design/systems";
import { tempDir } from "./helpers";

/** A design-system folder: index.md, an optional DESIGN.md (null skips it) and optional tokens.css. */
function makeSystem(root: string, folder: string, index: string, design: string | null, tokens?: string): string {
  const dir = join(root, folder);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "index.md"), index);
  if (design !== null) writeFileSync(join(dir, "DESIGN.md"), design);
  if (tokens !== undefined) writeFileSync(join(dir, "tokens.css"), tokens);
  return dir;
}

function info(id: string, source: DesignSystemInfo["source"] = "builtin"): DesignSystemInfo {
  return { id, name: id, description: "", swatches: [], source, designMd: `/x/${id}/DESIGN.md` };
}

describe("parseSystemIndex", () => {
  it("splits, trims and caps swatches at four", () => {
    const parsed = parseSystemIndex("---\ntype: design-system\nname: Warm\ndescription: Warm tones\nswatches: #fff, #000 ,  #f00,#0f0,#00f\n---\nbody");
    expect(parsed.type).toBe("design-system");
    expect(parsed.name).toBe("Warm");
    expect(parsed.description).toBe("Warm tones");
    expect(parsed.swatches).toEqual(["#fff", "#000", "#f00", "#0f0"]);
  });

  it("parses CRLF frontmatter and unquotes a quoted value", () => {
    const parsed = parseSystemIndex("---\r\ntype: design-system\r\nname: \"Cool\"\r\nswatches: a, b\r\n---\r\nbody");
    expect(parsed.type).toBe("design-system");
    expect(parsed.name).toBe("Cool");
    expect(parsed.swatches).toEqual(["a", "b"]);
  });

  it("returns just an empty swatches list without a closed frontmatter block", () => {
    expect(parseSystemIndex("# no frontmatter")).toEqual({ swatches: [] });
    expect(parseSystemIndex("---\ntype: design-system\n")).toEqual({ swatches: [] });
  });
});

describe("listDesignSystems", () => {
  it("lists the project, project folders then builtins, in order", () => {
    const project = tempDir();
    writeFileSync(join(project, "DESIGN.md"), "project design");
    makeSystem(join(project, ".agents", "design-systems"), "warm", "---\ntype: design-system\nname: Warm\ndescription: Warm one\nswatches: #fff,#000\n---\n", "warm design", "warm tokens");
    const builtin = tempDir();
    makeSystem(builtin, "clean", "---\ntype: design-system\nname: Clean\n---\n", "clean design");

    const list = listDesignSystems(project, builtin);
    expect(list.map((s) => s.id)).toEqual(["project", "project:warm", "clean"]);

    const own = list[0]!;
    expect(own.name).toBe("Project");
    expect(own.description).toBe("This project's DESIGN.md");
    expect(own.source).toBe("project");
    expect(own.designMd).toBe(join(project, "DESIGN.md"));
    expect(own.tokensCss).toBeUndefined();

    const warm = list[1]!;
    expect(warm.name).toBe("Warm");
    expect(warm.description).toBe("Warm one");
    expect(warm.swatches).toEqual(["#fff", "#000"]);
    expect(warm.source).toBe("projectFolder");
    expect(warm.designMd).toBe(join(project, ".agents", "design-systems", "warm", "DESIGN.md"));
    expect(warm.tokensCss).toBe(join(project, ".agents", "design-systems", "warm", "tokens.css"));

    const clean = list[2]!;
    expect(clean.name).toBe("Clean");
    expect(clean.source).toBe("builtin");
    expect(clean.tokensCss).toBeUndefined();
  });

  it("skips folders without `type: design-system` or without a DESIGN.md", () => {
    const builtin = tempDir();
    makeSystem(builtin, "no-type", "---\nname: Nope\n---\n", "x");
    makeSystem(builtin, "no-design", "---\ntype: design-system\n---\n", null);
    makeSystem(builtin, "good", "---\ntype: design-system\n---\n", "x");
    expect(listDesignSystems(null, builtin).map((s) => s.id)).toEqual(["good"]);
  });

  it("keeps the first entry when ids collide", () => {
    const project = tempDir();
    writeFileSync(join(project, "DESIGN.md"), "project design");
    const builtin = tempDir();
    makeSystem(builtin, "project", "---\ntype: design-system\nname: Builtin project\n---\n", "builtin design");
    const list = listDesignSystems(project, builtin);
    expect(list.map((s) => s.id)).toEqual(["project"]);
    expect(list[0]!.name).toBe("Project");
  });

  it("returns nothing for missing folders", () => {
    expect(listDesignSystems(null, join(tempDir(), "nope"))).toEqual([]);
    expect(listDesignSystems(join(tempDir(), "missing"), join(tempDir(), "nope"))).toEqual([]);
  });
});

describe("resolveDesignSystem", () => {
  it("takes the exact id, then project, then clean, then the first, then null", () => {
    const withProject = [info("clean"), info("project"), info("other")];
    expect(resolveDesignSystem(withProject, "other")!.id).toBe("other");
    expect(resolveDesignSystem(withProject, "missing")!.id).toBe("project");
    expect(resolveDesignSystem(withProject, null)!.id).toBe("project");

    const withClean = [info("clean"), info("other")];
    expect(resolveDesignSystem(withClean, undefined)!.id).toBe("clean");

    expect(resolveDesignSystem([info("other"), info("second")], "nope")!.id).toBe("other");
    expect(resolveDesignSystem([], "x")).toBeNull();
  });
});

describe("materializeSystem", () => {
  it("writes DESIGN.md, tokens.css and .system, then reports no change", () => {
    const builtin = tempDir();
    makeSystem(builtin, "warm", "---\ntype: design-system\n---\n", "warm design", "warm tokens");
    const [warm] = listDesignSystems(null, builtin);
    const dest = join(tempDir(), "dest");

    expect(materializeSystem(warm!, dest)).toBe(true);
    expect(readFileSync(join(dest, "DESIGN.md"), "utf-8")).toBe("warm design");
    expect(readFileSync(join(dest, "tokens.css"), "utf-8")).toBe("warm tokens");
    expect(readFileSync(join(dest, ".system"), "utf-8")).toBe("warm");
    expect(materializeSystem(warm!, dest)).toBe(false);
  });

  it("rewrites when the source tokens.css changes", () => {
    const builtin = tempDir();
    const src = makeSystem(builtin, "warm", "---\ntype: design-system\n---\n", "warm design", "warm tokens");
    const [warm] = listDesignSystems(null, builtin);
    const dest = join(tempDir(), "dest");

    expect(materializeSystem(warm!, dest)).toBe(true);
    writeFileSync(join(src, "tokens.css"), "updated tokens");
    expect(materializeSystem(warm!, dest)).toBe(true);
    expect(readFileSync(join(dest, "tokens.css"), "utf-8")).toBe("updated tokens");
    expect(materializeSystem(warm!, dest)).toBe(false);
  });

  it("deletes a stale tokens.css when the system has none", () => {
    const builtin = tempDir();
    makeSystem(builtin, "warm", "---\ntype: design-system\n---\n", "warm design", "warm tokens");
    makeSystem(builtin, "clean", "---\ntype: design-system\n---\n", "clean design");
    const list = listDesignSystems(null, builtin);
    const warm = list.find((s) => s.id === "warm")!;
    const clean = list.find((s) => s.id === "clean")!;
    const dest = join(tempDir(), "dest");

    expect(materializeSystem(warm, dest)).toBe(true);
    expect(existsSync(join(dest, "tokens.css"))).toBe(true);

    expect(materializeSystem(clean, dest)).toBe(true);
    expect(existsSync(join(dest, "tokens.css"))).toBe(false);
    expect(readFileSync(join(dest, ".system"), "utf-8")).toBe("clean");
    expect(materializeSystem(clean, dest)).toBe(false);
  });
});
