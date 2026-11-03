import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { forkSystem, listDesignStyles, listDesignSystems, materializeSystem, parseSystemIndex, resolveDesignSystem, type DesignStyleInfo, type DesignSystemInfo } from "../src/main/design/systems";
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

function info(id: string, source: DesignSystemInfo["source"] = "projectFolder"): DesignSystemInfo {
  return { id, name: id, description: "", swatches: [], source, designMd: `/x/${id}/DESIGN.md` };
}

/** A project's own design-system folder root. */
function ownSystems(project: string): string {
  return join(project, ".agents", "design-systems");
}

/** A one-style library in a temp folder; returns the listed style. */
function makeStyle(folder: string, fields: string, design: string, tokens: string): DesignStyleInfo {
  const styles = tempDir();
  makeSystem(styles, folder, `---\ntype: design-style\n${fields}---\n`, design, tokens);
  return listDesignStyles(styles, tempDir())[0]!;
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
  it("lists the project's DESIGN.md, then its folders, in order", () => {
    const project = tempDir();
    writeFileSync(join(project, "DESIGN.md"), "project design");
    makeSystem(ownSystems(project), "warm", "---\ntype: design-system\nname: Warm\ndescription: Warm one\nswatches: #fff,#000\n---\n", "warm design", "warm tokens");
    makeSystem(ownSystems(project), "plain", "---\ntype: design-system\nname: Plain\n---\n", "plain design");

    const list = listDesignSystems(project);
    expect(list.map((s) => s.id)).toEqual(["project", "project:plain", "project:warm"]);

    const own = list[0]!;
    expect(own.name).toBe("Project");
    expect(own.description).toBe("This project's DESIGN.md");
    expect(own.source).toBe("project");
    expect(own.designMd).toBe(join(project, "DESIGN.md"));
    expect(own.tokensCss).toBeUndefined();

    const warm = list[2]!;
    expect(warm.name).toBe("Warm");
    expect(warm.description).toBe("Warm one");
    expect(warm.swatches).toEqual(["#fff", "#000"]);
    expect(warm.source).toBe("projectFolder");
    expect(warm.designMd).toBe(join(project, ".agents", "design-systems", "warm", "DESIGN.md"));
    expect(warm.tokensCss).toBe(join(project, ".agents", "design-systems", "warm", "tokens.css"));

    const plain = list[1]!;
    expect(plain.name).toBe("Plain");
    expect(plain.source).toBe("projectFolder");
    expect(plain.tokensCss).toBeUndefined();
  });

  it("skips folders without `type: design-system` or without a DESIGN.md", () => {
    const project = tempDir();
    makeSystem(ownSystems(project), "no-type", "---\nname: Nope\n---\n", "x");
    makeSystem(ownSystems(project), "no-design", "---\ntype: design-system\n---\n", null);
    makeSystem(ownSystems(project), "good", "---\ntype: design-system\n---\n", "x");
    expect(listDesignSystems(project).map((s) => s.id)).toEqual(["project:good"]);
  });

  it("returns nothing without a project or for a missing one", () => {
    expect(listDesignSystems(null)).toEqual([]);
    expect(listDesignSystems(join(tempDir(), "missing"))).toEqual([]);
  });
});

describe("resolveDesignSystem", () => {
  it("takes the exact id, then the project's DESIGN.md, then null (no fixed fallback palette)", () => {
    const withProject = [info("project:other"), info("project", "project"), info("style:arena", "style")];
    expect(resolveDesignSystem(withProject, "style:arena")!.id).toBe("style:arena");
    expect(resolveDesignSystem(withProject, "clean")!.id).toBe("project");
    expect(resolveDesignSystem(withProject, null)!.id).toBe("project");

    expect(resolveDesignSystem([info("project:other"), info("style:arena", "style")], "clean")).toBeNull();
    expect(resolveDesignSystem([], "x")).toBeNull();
  });
});

describe("materializeSystem", () => {
  it("writes DESIGN.md, tokens.css and .system, then reports no change", () => {
    const project = tempDir();
    makeSystem(ownSystems(project), "warm", "---\ntype: design-system\n---\n", "warm design", "warm tokens");
    const [warm] = listDesignSystems(project);
    const dest = join(tempDir(), "dest");

    expect(materializeSystem(warm!, dest)).toBe(true);
    expect(readFileSync(join(dest, "DESIGN.md"), "utf-8")).toBe("warm design");
    expect(readFileSync(join(dest, "tokens.css"), "utf-8")).toBe("warm tokens");
    expect(readFileSync(join(dest, ".system"), "utf-8")).toBe("project:warm");
    expect(materializeSystem(warm!, dest)).toBe(false);
  });

  it("a flat system materializes exactly DESIGN.md, tokens.css and .system", () => {
    const project = tempDir();
    makeSystem(ownSystems(project), "warm", "---\ntype: design-system\n---\n", "warm design", "warm tokens");
    const [warm] = listDesignSystems(project);
    const dest = join(tempDir(), "dest");

    expect(materializeSystem(warm!, dest)).toBe(true);
    expect(readdirSync(dest).sort()).toEqual([".system", "DESIGN.md", "tokens.css"]);
  });

  it("restores tokens.css when the copy in the design folder was changed", () => {
    const project = tempDir();
    makeSystem(ownSystems(project), "warm", "---\ntype: design-system\n---\n", "warm design", "warm tokens");
    const [warm] = listDesignSystems(project);
    const dest = join(tempDir(), "dest");

    expect(materializeSystem(warm!, dest)).toBe(true);
    writeFileSync(join(dest, "tokens.css"), "tampered");
    expect(materializeSystem(warm!, dest)).toBe(true);
    expect(readFileSync(join(dest, "tokens.css"), "utf-8")).toBe("warm tokens");
    expect(materializeSystem(warm!, dest)).toBe(false);
  });

  it("rewrites when the source tokens.css changes", () => {
    const project = tempDir();
    const src = makeSystem(ownSystems(project), "warm", "---\ntype: design-system\n---\n", "warm design", "warm tokens");
    const [warm] = listDesignSystems(project);
    const dest = join(tempDir(), "dest");

    expect(materializeSystem(warm!, dest)).toBe(true);
    writeFileSync(join(src, "tokens.css"), "updated tokens");
    expect(materializeSystem(warm!, dest)).toBe(true);
    expect(readFileSync(join(dest, "tokens.css"), "utf-8")).toBe("updated tokens");
    expect(materializeSystem(warm!, dest)).toBe(false);
  });

  it("deletes a stale tokens.css when the system has none", () => {
    const project = tempDir();
    makeSystem(ownSystems(project), "warm", "---\ntype: design-system\n---\n", "warm design", "warm tokens");
    makeSystem(ownSystems(project), "plain", "---\ntype: design-system\n---\n", "plain design");
    const list = listDesignSystems(project);
    const warm = list.find((s) => s.id === "project:warm")!;
    const plain = list.find((s) => s.id === "project:plain")!;
    const dest = join(tempDir(), "dest");

    expect(materializeSystem(warm, dest)).toBe(true);
    expect(existsSync(join(dest, "tokens.css"))).toBe(true);

    expect(materializeSystem(plain, dest)).toBe(true);
    expect(existsSync(join(dest, "tokens.css"))).toBe(false);
    expect(readFileSync(join(dest, ".system"), "utf-8")).toBe("project:plain");
    expect(materializeSystem(plain, dest)).toBe(false);
  });

  it("keeps the tokens.css the agent derived for a system without one, turn after turn", () => {
    const project = tempDir();
    writeFileSync(join(project, "DESIGN.md"), "project design");
    const [own] = listDesignSystems(project);
    const dest = join(tempDir(), "dest");

    expect(materializeSystem(own!, dest)).toBe(true);
    writeFileSync(join(dest, "tokens.css"), "derived tokens");
    expect(materializeSystem(own!, dest)).toBe(false);
    expect(readFileSync(join(dest, "tokens.css"), "utf-8")).toBe("derived tokens");
  });
});

describe("forkSystem", () => {
  it("copies a library style into the project and lists it as a project folder", () => {
    const warm = makeStyle("warm", "name: Warm\ndescription: Warm one\nswatches: #fff,#000\n", "warm design", "warm tokens");
    const project = tempDir();

    const forked = forkSystem(warm!, project);
    const dir = join(project, ".agents", "design-systems", "warm-custom");
    expect(forked.id).toBe("project:warm-custom");
    expect(forked.name).toBe("Warm (custom)");
    expect(forked.description).toBe("Warm one");
    expect(forked.swatches).toEqual(["#fff", "#000"]);
    expect(forked.source).toBe("projectFolder");
    expect(forked.designMd).toBe(join(dir, "DESIGN.md"));
    expect(forked.tokensCss).toBe(join(dir, "tokens.css"));

    expect(readFileSync(join(dir, "DESIGN.md"), "utf-8")).toBe("warm design");
    expect(readFileSync(join(dir, "tokens.css"), "utf-8")).toBe("warm tokens");
    expect(readFileSync(join(dir, "index.md"), "utf-8")).toBe(
      "---\ntype: design-system\nname: Warm (custom)\ndescription: Warm one\nswatches: #fff, #000\n---\n\nA copy of Warm, edited in CubiQ's System tab. Rules in `DESIGN.md`, tokens in `tokens.css`.\n",
    );

    const listed = listDesignSystems(project).find((s) => s.id === forked.id);
    expect(listed?.source).toBe("projectFolder");
    expect(listed?.name).toBe("Warm (custom)");
  });

  it("keeps a second fork's edits instead of overwriting the copy", () => {
    const warm = makeStyle("warm", "name: Warm\n", "warm design", "warm tokens");
    const project = tempDir();
    const copy = join(project, ".agents", "design-systems", "warm-custom", "tokens.css");

    const first = forkSystem(warm!, project);
    writeFileSync(copy, "edited tokens");
    const second = forkSystem(warm!, project);
    expect(second.id).toBe(first.id);
    expect(second.name).toBe("Warm (custom)");
    expect(readFileSync(copy, "utf-8")).toBe("edited tokens");
  });

  it("returns a system that isn't a library style unchanged", () => {
    const system = info("project:warm", "projectFolder");
    expect(forkSystem(system, tempDir())).toBe(system);
  });

  it("refuses a style whose id has unsafe characters", () => {
    expect(() => forkSystem(info("style:bad/id!", "style"), tempDir())).toThrow("Can't copy this design system.");
  });
});
