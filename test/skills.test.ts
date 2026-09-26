import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readSkillBody } from "../src/main/skills/catalog";
import { composePrompt } from "../src/main/skills/compose";
import { PLUGIN_NAME, ensurePlugin, qualifySkillCalls } from "../src/main/skills/plugin";
import { catalog, emptyCatalog, tempDir } from "./helpers";

describe("catalog", () => {
  it("defaults to a clean empty catalog", () => {
    const empty = emptyCatalog();
    expect(empty.skills).toEqual([]);
    expect(empty.modelSkills).toEqual([]);
    expect(empty.userSkills).toEqual([]);
  });

  it("splits catalog into model- and user-invoked skills", () => {
    const c = catalog();
    expect(c.modelSkills.length).toBeGreaterThan(0);
    expect(c.userSkills.length).toBeGreaterThan(0);
    expect(c.modelSkills.length + c.userSkills.length).toBe(c.skills.length);
    expect(c.byName.get("tdd")?.invocation).toBe("model");
    expect(c.byName.get("implement")?.invocation).toBe("user");
  });

  it("reads a skill body without its frontmatter", () => {
    const body = readSkillBody(catalog().root, "implement");
    expect(body.startsWith("---")).toBe(false);
    expect(body).toContain("Size the work first");
  });
});

describe("qualifySkillCalls", () => {
  const known = new Set(["tdd", "review-diff", "requirements-interview", "domain-modeling"]);

  it("qualifies skill names on Skill-tool lines only", () => {
    expect(qualifySkillCalls('Call the Skill tool with "tdd" now.', known, "skilled:")).toBe('Call the Skill tool with "skilled:tdd" now.');
    expect(qualifySkillCalls('Call the Skill tool twice, for "requirements-interview" and "domain-modeling".', known, "skilled:")).toBe(
      'Call the Skill tool twice, for "skilled:requirements-interview" and "skilled:domain-modeling".',
    );
    expect(qualifySkillCalls('He said "tdd" loudly.', known, "skilled:")).toBe('He said "tdd" loudly.');
    expect(qualifySkillCalls('Call the Skill tool with "not-a-skill".', known, "skilled:")).toBe('Call the Skill tool with "not-a-skill".');
  });
});

describe("ensurePlugin", () => {
  it("returns null when catalog has no model skills (clean default)", () => {
    const dir = join(tempDir(), "empty-plugin");
    const result = ensurePlugin(emptyCatalog(), dir);
    expect(result).toBeNull();
    expect(existsSync(dir)).toBe(false);
  });

  it("builds a plugin with only the model-invoked skills, calls qualified", () => {
    const c = catalog();
    const dir = join(tempDir(), "plugin");
    ensurePlugin(c, dir);
    const manifest = JSON.parse(readFileSync(join(dir, ".claude-plugin", "plugin.json"), "utf-8"));
    expect(manifest.name).toBe(PLUGIN_NAME);
    const names = readdirSync(join(dir, "skills")).sort();
    expect(names).toEqual(c.modelSkills.map((s) => s.name).sort());
    expect(existsSync(join(dir, "skills", "implement"))).toBe(false);
    expect(readFileSync(join(dir, "skills", "tdd", "SKILL.md"), "utf-8")).toContain("module-design");
  });

  it("does nothing when the catalog hasn't changed", () => {
    const c = catalog();
    const dir = join(tempDir(), "plugin");
    ensurePlugin(c, dir);
    const stamp = join(dir, "skills", "tdd", "SKILL.md");
    const before = readFileSync(stamp, "utf-8");
    ensurePlugin(c, dir);
    expect(readFileSync(stamp, "utf-8")).toBe(before);
  });
});

describe("composePrompt", () => {
  it("passes plain text through", () => {
    expect(composePrompt(catalog(), "hello")).toBe("hello");
  });

  it("wraps a user-invoked skill's body with its base directory and arguments", () => {
    const c = catalog();
    const prompt = composePrompt(c, "ticket 3", "implement");
    expect(prompt).toContain('<skill name="implement" base="');
    expect(prompt).toContain(join(c.root.skillsDir, "implement"));
    expect(prompt.endsWith("Arguments: ticket 3")).toBe(true);
  });

  it("refuses model-invoked and unknown skills", () => {
    expect(() => composePrompt(catalog(), "", "tdd")).toThrow(/model-invoked/);
    expect(() => composePrompt(catalog(), "", "nope")).toThrow(/unknown/);
  });

  it("qualifies calls with the delivery prefix", () => {
    const prompt = composePrompt(catalog(), "ticket 3", "implement", { mode: "plugin", prefix: "harness-skills:" });
    expect(prompt).toContain('"harness-skills:tdd"');
  });

  it("leaves calls unqualified with no delivery", () => {
    const prompt = composePrompt(catalog(), "ticket 3", "implement", { mode: "none" });
    expect(prompt).toContain('"tdd"');
    expect(prompt).not.toContain("harness-skills:");
  });

  it("still accepts a plain string prefix", () => {
    const prompt = composePrompt(catalog(), "ticket 3", "implement", "skilled:");
    expect(prompt).toContain('"skilled:tdd"');
  });
});
