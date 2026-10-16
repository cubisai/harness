import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createExpertCatalog } from "../src/main/experts/catalog";
import { bindExpertSkills, expertBlock, skillsIndexBlock, teamAgents, type ExpertSkill } from "../src/shared/experts";
import { tempDir } from "./helpers";

const skill = (name: string, description = ""): ExpertSkill => ({ name, description, file: `/pkg/skills/${name}/SKILL.md` });

describe("skillsIndexBlock", () => {
  it("is empty when the agent has no skills", () => {
    expect(skillsIndexBlock([])).toBe("");
  });

  it("lists each skill on one line, in order, inside the block", () => {
    const block = skillsIndexBlock([skill("a", "Does A."), skill("b")]);
    expect(block).toContain("<skills>");
    expect(block).toContain("- `a` — Does A. — /pkg/skills/a/SKILL.md");
    expect(block).toContain("- `b` — /pkg/skills/b/SKILL.md");
    expect(block.indexOf("- `a`")).toBeLessThan(block.indexOf("- `b`"));
    expect(block.endsWith("</skills>")).toBe(true);
  });
});

describe("bindExpertSkills", () => {
  const pkg = [skill("a"), skill("b"), skill("c")];
  const member = (id: string, skills: string[]) => ({ id, name: id, profession: "P", description: "", prompt: "", skills });

  it("gives a single expert the whole package", () => {
    expect(bindExpertSkills({ kind: "agent", members: undefined }, pkg)).toEqual({ lead: pkg, members: {} });
  });

  it("binds each member its named skills and leaves the rest to the lead", () => {
    const def = { kind: "team" as const, members: [member("m1", ["b", "zzz"]), member("m2", [])] };
    expect(bindExpertSkills(def, pkg)).toEqual({ lead: [pkg[0]!, pkg[2]!], members: { m1: [pkg[1]!] } });
  });
});

describe("expertBlock", () => {
  const def = { name: "Ada", profession: "Writer", prompt: "You write.", kind: "agent" as const, members: undefined };

  it("is unchanged when the lead has no skills", () => {
    expect(expertBlock(def)).toBe(expertBlock(def, []));
    expect(expertBlock(def)).not.toContain("<skills>");
  });

  it("puts a team lead's index before its members", () => {
    const block = expertBlock(
      { name: "Crew", profession: "Lead", prompt: "Lead.", kind: "team", members: [{ id: "m1", name: "One", profession: "P", description: "D", prompt: "", skills: ["a"] }] },
      [skill("a", "Does A.")],
    );
    expect(block.indexOf("<skills>")).toBeGreaterThan(-1);
    expect(block.indexOf("<skills>")).toBeLessThan(block.indexOf("## Your team"));
  });
});

describe("teamAgents", () => {
  const member = (id: string, extra: Partial<{ description: string; prompt: string; skills: string[] }> = {}) => ({ id, name: `N-${id}`, profession: "Analyst", description: "Finds facts.", prompt: "Research.", skills: [], ...extra });

  it("appends each member's private index to its prompt", () => {
    const agents = teamAgents({ kind: "team", members: [member("m1", { skills: ["b"] }), member("m2")] }, { m1: [skill("b", "Does B.")] });
    expect(agents[0]!.prompt.endsWith(skillsIndexBlock([skill("b", "Does B.")]))).toBe(true);
    expect(agents[0]!.prompt).toContain("/pkg/skills/b/SKILL.md");
    expect(agents[1]!.prompt).not.toContain("<skills>");
  });
});

describe("packageSkills", () => {
  it("reads a team's package skills, sorted by folder name", () => {
    const userDir = tempDir();
    const team = join(userDir, "my-team");
    mkdirSync(join(team, "members"), { recursive: true });
    mkdirSync(join(team, "skills", "b"), { recursive: true });
    mkdirSync(join(team, "skills", "a"), { recursive: true });
    writeFileSync(join(team, "expert.md"), "---\nid: my-team\nkind: team\nname: My Team\nprofession: Lead\n---\nLead prompt.\n");
    writeFileSync(join(team, "members", "m1.md"), "---\nname: One\nprofession: P\ndescription: D\nskills: [b]\n---\nMember prompt.\n");
    writeFileSync(join(team, "skills", "a", "SKILL.md"), "---\nname: a\ndescription: Does A.\n---\nDo A.\n");
    writeFileSync(join(team, "skills", "b", "SKILL.md"), "---\nname: b\ndescription: Does B.\n---\nDo B.\n");
    const catalog = createExpertCatalog({ bundledDir: tempDir(), userDir });
    const skills = catalog.packageSkills("my-team");
    expect(skills.map((s) => s.name)).toEqual(["a", "b"]);
    expect(skills.map((s) => s.description)).toEqual(["Does A.", "Does B."]);
    for (const s of skills) expect(s.file.endsWith("SKILL.md")).toBe(true);
    expect(catalog.packageSkills("unknown")).toEqual([]);
  });

  it("keeps an expert's package skills out of its global skill chips", () => {
    const userDir = tempDir();
    const expert = join(userDir, "painter");
    mkdirSync(join(expert, "skills", "a"), { recursive: true });
    writeFileSync(join(expert, "expert.md"), "---\nname: Painter\nskills: [a, design-prototype]\n---\nPaint.\n");
    const catalog = createExpertCatalog({ bundledDir: tempDir(), userDir });
    expect(catalog.list()[0]!.skills).toEqual(["design-prototype"]);
  });
});
