import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { carriesThreadOwnTools, isCreatorTool } from "../src/main/shell-tools";
import { discoverSkills, parseSkillMd } from "../src/main/skills/discover";

const ROOT = join(__dirname, "..", "resources");

describe("Creator's own skill", () => {
  it("ships as a model-invoked, Creator-only bundled skill", () => {
    const skill = discoverSkills({ origin: "bundled", dir: join(ROOT, "skills") }).find((s) => s.name === "cubiq-creator");
    expect(skill).toBeDefined();
    expect(skill!.mode).toBe("creator");
    expect(skill!.invocation).toBe("model");
  });

  it("keeps the skill small and names every Creator step", () => {
    const text = readFileSync(join(ROOT, "skills", "cubiq-creator", "SKILL.md"), "utf8");
    expect(text.length).toBeLessThan(5000);
    const body = parseSkillMd(text).body;
    for (const tool of ["creator_inspect", "creator_connector_test", "creator_app_preview", "creator_app_check", "creator_propose"]) expect(body).toContain(tool);
  });

  it("has the Creator note point at the skill first", () => {
    expect(readFileSync(join(ROOT, "CREATOR-MODE.md"), "utf8")).toMatch(/load the `cubiq-creator` skill/);
  });
});

describe("Creator tools on the tool server", () => {
  it("recognises Creator tools by name", () => {
    expect(isCreatorTool("creator_inspect")).toBe(true);
    expect(isCreatorTool("browser_snapshot")).toBe(false);
  });

  it("asks for the thread's own tools when Creator tools are present even without shells", () => {
    expect(carriesThreadOwnTools([{ name: "creator_propose" }])).toBe(true);
    expect(carriesThreadOwnTools([{ name: "shell_start" }])).toBe(true);
    expect(carriesThreadOwnTools([{ name: "browser_snapshot" }])).toBe(false);
    expect(carriesThreadOwnTools([])).toBe(false);
  });
});
