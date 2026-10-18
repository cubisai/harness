import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { SkillEntry } from "../src/shared/types";
import { SKILL_INDEX_THRESHOLD, skillTool } from "../src/main/skills/tool";
import { makeSkills } from "../scripts/mock-extensions-lib.mjs";
import { tempDir } from "./helpers";

function entry(name: string, description: string, dir?: string): SkillEntry {
  return { name, description, invocation: "model", calls: [], files: [], sha256: name, dir };
}

/** The full pre-index listing, for the size comparison. */
function legacyListing(skills: SkillEntry[]): string {
  const clipped = (s: SkillEntry): string => (s.description.length > 160 ? `${s.description.slice(0, 160)}…` : s.description);
  const lines = [...skills].sort((a, b) => a.name.localeCompare(b.name)).map((s) => `- ${s.name}: ${clipped(s)}`);
  return `Load a skill: returns its instructions and its folder (relative links resolve against it). Use it when the task matches one of these skills:\n${lines.join("\n")}`;
}

describe("skillTool below the index threshold", () => {
  const skills = [entry("gamma", "Gamma does a third"), entry("alpha", "Alpha does a thing"), entry("beta", "Beta does another")];

  it("keeps the exact legacy description and the name-only input", () => {
    const tool = skillTool(() => skills);
    expect(tool.description).toBe(
      "Load a skill: returns its instructions and its folder (relative links resolve against it). Use it when the task matches one of these skills:\n" +
        "- alpha: Alpha does a thing\n- beta: Beta does another\n- gamma: Gamma does a third",
    );
    expect(Object.keys(tool.input)).toEqual(["name"]);
  });

  it("loads from its snapshot after the live list drops a skill", async () => {
    const live = [...skills];
    const tool = skillTool(() => live);
    live.length = 0;
    const out = await tool.run({ name: "alpha" });
    expect(out.isError).toBeUndefined();
    expect(tool.description).toContain("- alpha: Alpha does a thing");
  });
});

describe("skillTool in index mode", () => {
  const mock = makeSkills(200, 23);
  const skills = mock.map((s) => entry(s.name, s.description));
  const loadName = "backup-vitest-testing";
  const loadable = skills.find((s) => s.name === loadName)!;
  const tool = skillTool(() => skills);

  it("uses the thresholds it exports", () => {
    expect(SKILL_INDEX_THRESHOLD).toEqual({ skills: 40, chars: 6000 });
    expect(skills.length).toBeGreaterThan(SKILL_INDEX_THRESHOLD.skills);
  });

  it("lists names only, well under a quarter of the legacy listing", () => {
    expect(tool.description.length).toBeLessThan(legacyListing(skills).length * 0.25);
    expect(tool.description).toContain("200 skills");
    for (const s of skills) expect(tool.description).toContain(s.name);
  });

  it("takes name and query", () => {
    expect(Object.keys(tool.input).sort()).toEqual(["name", "query"]);
  });

  it("ranks the right skill for a task query", async () => {
    const out = await tool.run({ query: "safety copy of the vitest test setup" });
    expect(out.isError).toBeUndefined();
    expect(out.text.split("\n").slice(0, 3).join("\n")).toContain(loadName);
    expect(out.text).toContain("Load one with name.");
  });

  it("loads a skill by exact name from its snapshot", async () => {
    const dir = tempDir();
    loadable.dir = dir;
    writeFileSync(join(dir, "SKILL.md"), `---\nname: ${loadName}\n---\nSkill body for the test.`);
    const out = await tool.run({ name: loadName });
    expect(out.isError).toBeUndefined();
    expect(out.text).toContain("Skill body for the test.");
    expect(out.text).toContain(`base="${dir}"`);
  });

  it("points an unknown name at query", async () => {
    const out = await tool.run({ name: "definitely-not-a-skill" });
    expect(out.isError).toBe(true);
    expect(out.text).toContain("Try query to search.");
  });

  it("asks for one of the two arguments", async () => {
    const out = await tool.run({});
    expect(out.isError).toBe(true);
    expect(out.text).toBe("Pass name or query.");
  });

  it("loads a skill added after the snapshot, but still searches the snapshot", async () => {
    const live = [...skills];
    const t = skillTool(() => live);
    live.push(entry("added-later", "Added after the tool was built"));
    expect((await t.run({ name: "added-later" })).isError).toBeUndefined();
    expect((await t.run({ query: "added later" })).text).not.toContain("Added after the tool was built");
  });
});
